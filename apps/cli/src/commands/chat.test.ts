import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionStreamHandleEvent } from '@relavium/core';
import type { StreamChunk } from '@relavium/llm';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildChatSession } from '../chat/session-host.js';
import {
  scriptedResolver,
  textTurn,
  toolUseTurn,
  unresolvedResolver,
} from '../chat/test-support.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { chatCommand, makePlainPrinter, type ChatCommandDeps, type ChatDriver } from './chat.js';

const HOME_ENV_VARS = ['HOME', 'USERPROFILE'] as const;

function globalOptions(cwd: string): GlobalOptions {
  return { json: false, color: false, cwd, configPath: undefined, verbosity: 'normal' };
}

/** A headless driver that feeds a fixed line list through the command core (no TTY / ink). */
function linesDriver(lines: readonly string[]): ChatDriver {
  return async (ctx) => {
    ctx.startSession(); // open the session (a real driver does this after wiring its subscription)
    for (const line of lines) {
      await ctx.processLine(line);
      if (ctx.shouldStop()) break;
    }
  };
}

describe('chatCommand', () => {
  let cwd: string;
  let home: string;
  let client: DbClient;
  const savedHome = new Map<string, string | undefined>();

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-chat-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-chat-home-'));
    // os.homedir() reads HOME (POSIX) / USERPROFILE (Windows) — override BOTH so config load is hermetic.
    for (const v of HOME_ENV_VARS) {
      savedHome.set(v, process.env[v]);
      process.env[v] = home;
    }
    client = createClient(':memory:');
    runMigrations(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
    for (const v of HOME_ENV_VARS) {
      const prev = savedHome.get(v);
      if (prev === undefined) delete process.env[v];
      else process.env[v] = prev;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function deps(lines: readonly string[], scripts: StreamChunk[][]) {
    const { io, out, err } = captureIo();
    let tick = Date.parse('2026-06-25T00:00:00.000Z');
    let id = 0;
    const store = createSessionStore(client.db);
    const d: ChatCommandDeps = {
      io,
      global: globalOptions(cwd),
      providers: scriptedResolver(scripts),
      openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
      drive: linesDriver(lines),
      now: () => tick++,
      uuid: () => `id-${id++}`,
    };
    // The first uuid() mints the sessionId; ids advance from there for the persisted messages.
    return { d, out, err, store, sessionId: 'id-0' };
  }

  it('runs a one-turn chat, persists the exchange, and exits 4 on /exit', async () => {
    const { d, store, sessionId } = deps(['hello', '/exit'], [textTurn('hi there')]);
    const code = await chatCommand({ agent: undefined }, d);
    expect(code).toBe(EXIT_CODES.chatEnded);

    const full = store.loadFull(sessionId);
    expect(full?.session.status).toBe('ended'); // /exit cancels ⇒ the terminal marks it ended
    expect(full?.session.agentSlug).toBe('relavium-chat'); // the built-in default agent
    expect(full?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(full?.messages[1]?.content[0]).toEqual({ type: 'text', text: 'hi there' });
  });

  it('streams a multi-turn conversation that includes a tool call, persisting each turn', async () => {
    const { d, store, sessionId } = deps(
      ['use a tool', '/exit'],
      [toolUseTurn('c1', 'read_file'), textTurn('the answer')],
    );
    const code = await chatCommand({ agent: undefined }, d);
    expect(code).toBe(EXIT_CODES.chatEnded);

    const full = store.loadFull(sessionId);
    // The tool-calling turn (read_file dispatched through the fail-closed host) still completes to a reply.
    expect(full?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(full?.messages[1]?.content[0]).toEqual({ type: 'text', text: 'the answer' });
  });

  it('persists nothing but a session row when /exit is the first input', async () => {
    const { d, store, sessionId } = deps(['/exit'], [textTurn('unused')]);
    const code = await chatCommand({ agent: undefined }, d);
    expect(code).toBe(EXIT_CODES.chatEnded);
    const full = store.loadFull(sessionId);
    expect(full?.session.status).toBe('ended');
    expect(full?.messages).toHaveLength(0);
  });

  it('ends the (resumable) session on /cancel with exit 4', async () => {
    const { d, store, sessionId } = deps(['/cancel'], [textTurn('unused')]);
    const code = await chatCommand({ agent: undefined }, d);
    expect(code).toBe(EXIT_CODES.chatEnded);
    expect(store.loadFull(sessionId)?.session.status).toBe('ended');
  });

  it('reports an unknown slash command on stderr without ending the session', async () => {
    const { d, err, store, sessionId } = deps(['/bogus', 'hello', '/exit'], [textTurn('hi')]);
    await chatCommand({ agent: undefined }, d);
    expect(err()).toContain("unknown command '/bogus'");
    // the session continued after the bad command — the 'hello' turn persisted.
    expect(store.loadFull(sessionId)?.messages).toHaveLength(2);
  });

  it('ends the session and exits 4 when the input stream reaches EOF without /exit', async () => {
    const { d, store, sessionId } = deps(['hello'], [textTurn('hi')]); // no /exit — the loop just ends
    const code = await chatCommand({ agent: undefined }, d);
    expect(code).toBe(EXIT_CODES.chatEnded);
    expect(store.loadFull(sessionId)?.session.status).toBe('ended');
  });

  it('survives an error turn and keeps the REPL going (resilience)', async () => {
    // unresolvedResolver settles every turn as an `internal` error (no throw); the REPL must keep accepting
    // input and exit cleanly on /exit — both error turns roll back, so nothing persists.
    const { d, store, sessionId } = deps(['hello', 'world', '/exit'], []);
    const code = await chatCommand({ agent: undefined }, { ...d, providers: unresolvedResolver() });
    expect(code).toBe(EXIT_CODES.chatEnded);
    const full = store.loadFull(sessionId);
    expect(full?.messages).toHaveLength(0);
    expect(full?.session.status).toBe('ended');
  });

  it('binds an explicit --agent file (path) instead of the built-in default', async () => {
    const agentPath = join(cwd, 'coder.agent.yaml');
    writeFileSync(
      agentPath,
      'id: coder\nprovider: anthropic\nmodel: claude-sonnet-4-6\nsystem_prompt: You are a coder.',
    );
    const { d, store, sessionId } = deps(['hi', '/exit'], [textTurn('done')]);
    await chatCommand({ agent: agentPath }, d);
    expect(store.loadFull(sessionId)?.session.agentSlug).toBe('coder'); // bound agent, not relavium-chat
  });

  it('ignores empty and whitespace-only input lines (no turn, no persistence)', async () => {
    // Only ONE script is provided; if a blank line triggered a turn, the 2nd stream call would throw.
    const { d, store, sessionId } = deps(['', '   ', 'hello', '/exit'], [textTurn('hi')]);
    await chatCommand({ agent: undefined }, d);
    expect(store.loadFull(sessionId)?.messages).toHaveLength(2); // exactly the one 'hello' exchange
  });

  it('routes a budget warning to stderr via the onBudgetWarning seam', async () => {
    const { d, err } = deps(['/exit'], [textTurn('x')]);
    let captured:
      | ((w: { spentMicrocents: number; limitMicrocents: number; thresholdPct: number }) => void)
      | undefined;
    const withCapture: typeof buildChatSession = (opts) => {
      captured = opts.onBudgetWarning;
      return buildChatSession(opts);
    };
    await chatCommand({ agent: undefined }, { ...d, buildSession: withCapture });
    captured?.({ spentMicrocents: 900, limitMicrocents: 1000, thresholdPct: 90 });
    expect(err()).toContain('budget warning');
  });

  it('strips control bytes from an unknown-slash echo (terminal-injection guard)', async () => {
    const { d, err } = deps(['/\x1b[2Jboom', '/exit'], [textTurn('x')]);
    await chatCommand({ agent: undefined }, d);
    expect(err()).not.toContain('\x1b'); // the raw ESC never reached stderr
    expect(err()).toContain('?'); // it was replaced
  });

  it('propagates a driver rejection AND still runs teardown (the anti-hang/propagation contract)', async () => {
    // A driver that rejects models the unexpected-turn-core throw (processLine rejecting in the plain path,
    // or driveInk's rejectExit): the command must propagate it (→ exit 1) while its finally still tears down.
    const { d } = deps([], [textTurn('x')]);
    let closed = false;
    const store = createSessionStore(client.db);
    const failingDrive: ChatDriver = (ctx) => {
      ctx.startSession();
      return Promise.reject(new Error('boom'));
    };
    await expect(
      chatCommand(
        { agent: undefined },
        {
          ...d,
          openSessionStore: () => ({ store, db: client.db, close: () => (closed = true) }),
          drive: failingDrive,
        },
      ),
    ).rejects.toThrow('boom');
    expect(closed).toBe(true); // opened.close() ran in the finally despite the rejection
  });

  it('surfaces an un-inferrable default model as a clean exit-2 CliError (before any session)', async () => {
    // A [chat].default_model the provider-inference can't map ⇒ buildChatSession throws CliError (exit 2).
    const { d } = deps(['/exit'], [textTurn('x')]);
    const bad: ChatCommandDeps = {
      ...d,
      // Override the session builder to force the unknown-model path deterministically.
      buildSession: () => {
        throw Object.assign(new Error('cannot infer a provider for chat model'), {
          code: 'invalid_invocation',
        });
      },
    };
    await expect(chatCommand({ agent: undefined }, bad)).rejects.toThrow(/cannot infer a provider/);
  });
});

describe('makePlainPrinter', () => {
  const STAMP = { sessionId: 'sess-1', sequenceNumber: 0, timestamp: '2026-06-25T00:00:00.000Z' };
  const token = (text: string): SessionStreamHandleEvent => ({
    type: 'agent:token',
    ...STAMP,
    nodeId: 'a',
    token: text,
    model: 'm',
  });
  const toolCall = (toolId: string, toolInput: unknown): SessionStreamHandleEvent => ({
    type: 'agent:tool_call',
    ...STAMP,
    nodeId: 'a',
    model: 'm',
    toolId,
    toolInput,
  });

  it('streams the assistant tokens and annotates a tool call (id only — NEVER the arguments)', () => {
    const { io, out } = captureIo();
    const print = makePlainPrinter(io);
    print(token('hel'));
    print(token('lo'));
    print(toolCall('read_file', { path: '/etc/passwd', secret: 'root:x:0:0' }));
    expect(out()).toContain('hello');
    expect(out()).toContain('read_file');
    // The tool ARGUMENTS (a potential secret/PII path) never reach the screen.
    expect(out()).not.toContain('/etc/passwd');
    expect(out()).not.toContain('root:x:0:0');
  });

  it('sanitizes terminal control sequences out of the streamed model tokens', () => {
    const { io, out } = captureIo();
    makePlainPrinter(io)(token('\x1b]0;pwned\x07hi'));
    expect(out()).not.toContain('\x1b'); // the OSC title-write escape is stripped
    expect(out()).toContain('hi');
  });

  it('emits a bare newline on a successful turn completion', () => {
    const { io, out } = captureIo();
    makePlainPrinter(io)({
      type: 'session:turn_completed',
      ...STAMP,
      stopReason: 'stop',
      tokensUsed: { input: 1, output: 1 },
    });
    expect(out()).toBe('\n');
  });

  it('marks a failed turn with its error code, secret-free', () => {
    const { io, out } = captureIo();
    const print = makePlainPrinter(io);
    print({
      type: 'session:turn_completed',
      ...STAMP,
      stopReason: 'error',
      tokensUsed: { input: 0, output: 0 },
      error: { code: 'turn_limit', message: 'secret-ish detail', retryable: false },
    });
    expect(out()).toContain('turn_limit');
    expect(out()).not.toContain('secret-ish detail'); // only the code, never the message
  });
});
