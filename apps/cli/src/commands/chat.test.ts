import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import type { SessionStreamHandleEvent } from '@relavium/core';
import type { StreamChunk } from '@relavium/llm';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { startMcpClient as realStartMcpClient, type McpConnection } from '@relavium/mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildChatSession, buildResumedChatSession } from '../chat/session-host.js';
import {
  scriptedResolver,
  textTurn,
  toolUseTurn,
  unresolvedResolver,
} from '../chat/test-support.js';
import type { ResolvedChatConfig } from '../config/resolve.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { selectChatDriver } from '../render/tui/chat-ink.js';
import { createChatStore } from '../render/tui/chat-store.js';
import { captureIo, parseNdjson } from '../test-support.js';
import {
  chatCommand,
  chatResumeCommand,
  driveJson,
  drivePlain,
  makePlainPrinter,
  type ChatCommandDeps,
  type ChatDriveContext,
  type ChatDriver,
  type ChatResumeCommandDeps,
} from './chat.js';

const EMPTY_CHAT: ResolvedChatConfig = {
  defaultModel: undefined,
  fsScope: undefined,
  maxTurns: undefined,
  maxMessages: undefined,
  maxCostMicrocents: undefined,
  onExceed: undefined,
};

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

/** An --agent file declaring one stdio MCP server (the injected startMcpClient never spawns `command: x`). */
const MCP_AGENT_YAML = [
  'id: mcpcoder',
  'provider: anthropic',
  'model: claude-sonnet-4-6',
  'system_prompt: You are a coder.',
  'mcp_servers:',
  '  - id: fs',
  '    transport: stdio',
  '    command: x',
].join('\n');

/** A fake MCP connection whose `close` counts teardowns; `read` is allowed, `danger` is dropped (skip note). */
function mcpConn(): { conn: McpConnection; closed: () => number } {
  let n = 0;
  const conn: McpConnection = {
    listTools: () =>
      Promise.resolve([
        { name: 'read', inputSchema: { type: 'object' } },
        { name: 'danger', inputSchema: { type: 'object' } },
      ]),
    callTool: () => Promise.resolve({ content: [], isError: false }),
    close: () => {
      n += 1;
      return Promise.resolve();
    },
  };
  return { conn, closed: () => n };
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

  it('persists two distinct user turns (the 2nd a tool call) as four sequenced rows with a real cost', async () => {
    // Turn 1: a plain reply. Turn 2: a tool-calling turn (toolUseTurn → the answer streams after the loop).
    // Three scripted streams, TWO user messages ⇒ four persisted rows in sequenceNumber order.
    const { d, store, sessionId } = deps(
      ['first message', 'use a tool', '/exit'],
      [textTurn('first reply'), toolUseTurn('c1', 'read_file'), textTurn('the answer')],
    );
    const code = await chatCommand({ agent: undefined }, d);
    expect(code).toBe(EXIT_CODES.chatEnded);

    const full = store.loadFull(sessionId);
    expect(full?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(full?.messages.map((m) => m.sequenceNumber)).toEqual([0, 1, 2, 3]);
    expect(full?.messages[1]?.content[0]).toEqual({ type: 'text', text: 'first reply' });
    expect(full?.messages[3]?.content[0]).toEqual({ type: 'text', text: 'the answer' });
    expect(full?.session.totalCostMicrocents).toBeGreaterThan(0); // priced model ⇒ a real running cost
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

  it('/cost reports the session spend (no cost ⇒ $0.0000) on the non-TTY path, without ending the session', async () => {
    const { d, err, store, sessionId } = deps(['/cost', 'hello', '/exit'], [textTurn('hi')]);
    await chatCommand({ agent: undefined }, d);
    expect(err()).toContain('Session cost: $0.0000');
    // /cost is read-only: the session continued — the 'hello' turn persisted (user + assistant = 2).
    expect(store.loadFull(sessionId)?.messages).toHaveLength(2);
  });

  it('/workflows reports a project-less cwd without crashing the REPL', async () => {
    const { d, err, store, sessionId } = deps(['/workflows', 'hello', '/exit'], [textTurn('hi')]);
    await chatCommand({ agent: undefined }, d); // the test cwd is a fresh temp dir ⇒ no .relavium/ project
    expect(err()).toContain('No .relavium/ project found');
    expect(store.loadFull(sessionId)?.messages).toHaveLength(2); // the session survived the command
  });

  it('/help lists the curated commands on stderr without ending the session or persisting a turn', async () => {
    const { d, err, store, sessionId } = deps(['/help', 'hello', '/exit'], [textTurn('hi')]);
    await chatCommand({ agent: undefined }, d);
    for (const slash of ['/help', '/exit', '/cancel', '/export']) {
      expect(err(), `/help lists ${slash}`).toContain(slash); // the list derives from REPL_COMMANDS — all appear
    }
    // /help is read-only: the session continued and only the 'hello' turn persisted (user + assistant = 2).
    expect(store.loadFull(sessionId)?.messages).toHaveLength(2);
    expect(store.loadFull(sessionId)?.session.status).toBe('ended');
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

  it('exports the session-so-far to a scaffold on /export, continues, and does NOT mark the live row', async () => {
    // The filename is the session id ('id-0'). A custom drive snapshots the row status IMMEDIATELY after
    // /export (before the next turn's persist) — that is the only point that distinguishes "never marked"
    // from "marked then clobbered": if /export wrongly marked the row, the snapshot would read 'exported'.
    const { d, err, store, sessionId } = deps([], [textTurn('hi'), textTurn('more')]);
    let statusAfterExport: string | undefined;
    const probingDrive: ChatDriver = async (ctx) => {
      ctx.startSession();
      await ctx.processLine('hello'); // turn 1 ⇒ persisted, row status 'active'
      await ctx.processLine('/export'); // export the session-so-far; must NOT mark the row
      statusAfterExport = store.loadFull(sessionId)?.session.status;
      await ctx.processLine('again'); // turn 2 still runs (the REPL continued)
      await ctx.processLine('/exit');
    };
    await chatCommand({ agent: undefined }, { ...d, drive: probingDrive });

    const path = join(cwd, 'id-0.relavium.yaml');
    expect(existsSync(path)).toBe(true);
    expect(err()).toContain(`exported session to ${path}`);
    expect(statusAfterExport).toBe('active'); // /export left the live row untouched (NOT 'exported')
    expect(store.loadFull(sessionId)?.messages).toHaveLength(4); // both turns persisted — REPL continued
    expect(store.loadFull(sessionId)?.session.status).toBe('ended'); // /exit's terminal
  });

  it('re-exports on a second /export (force overwrites the session OWN scaffold)', async () => {
    // The path is keyed on the session id, so a 2nd /export targets the same file — it must overwrite, not
    // fail "already exists" (which a force:false regression would produce on the second pass).
    const { d, err } = deps([], [textTurn('hi')]);
    const twiceDrive: ChatDriver = async (ctx) => {
      ctx.startSession();
      await ctx.processLine('hello');
      await ctx.processLine('/export'); // creates id-0.relavium.yaml
      await ctx.processLine('/export'); // must overwrite it (force:true), not error
      await ctx.processLine('/exit');
    };
    await chatCommand({ agent: undefined }, { ...d, drive: twiceDrive });
    expect(existsSync(join(cwd, 'id-0.relavium.yaml'))).toBe(true);
    expect(err()).not.toContain('export failed:'); // force:false would fail the 2nd pass
  });

  it('reports a real /export failure on stderr without crashing the REPL', async () => {
    // A DIRECTORY at the target path makes writeFileSync throw EISDIR — a deterministic /export failure that
    // exercises the catch arm. The REPL must report it and still drive to /exit (status 'ended'), not crash.
    const { d, err, store, sessionId } = deps(['hello', '/export', '/exit'], [textTurn('hi')]);
    mkdirSync(join(cwd, 'id-0.relavium.yaml')); // occupy the scaffold path with a dir ⇒ write fails
    await chatCommand({ agent: undefined }, d);
    expect(err()).toContain('export failed:'); // the catch arm reported the fault
    expect(store.loadFull(sessionId)?.session.status).toBe('ended'); // the REPL survived and ended cleanly
  });

  it('chat --json drives the headless stream: stdout pure NDJSON, the unknown-slash diagnostic on stderr', async () => {
    const { io, out, err } = captureIo();
    const store = createSessionStore(client.db);
    let id = 0;
    const d: ChatCommandDeps = {
      io: { ...io, stdin: Readable.from(['hello\n/bogus\n']) },
      global: { ...globalOptions(cwd), json: true },
      providers: scriptedResolver([textTurn('hi there')]),
      openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
      drive: driveJson,
      now: () => 0,
      uuid: () => `id-${id++}`, // sessionId = id-0; message ids advance, so no PK collision
    };
    expect(await chatCommand({ agent: undefined }, d)).toBe(EXIT_CODES.chatEnded);
    // parseNdjson throws if a human line leaked onto stdout; the /bogus notice must be on stderr only.
    const types = parseNdjson<{ type: string }>(out()).map((e) => e.type);
    expect(types).toContain('session:started');
    expect(types).toContain('session:turn_completed');
    expect(types.at(-1)).toBe('session:cancelled'); // the terminal flushed via runReplLoop's finalize wiring
    expect(out()).not.toContain('unknown command'); // the diagnostic did NOT leak to stdout
    expect(err()).toContain("unknown command '/bogus'"); // it went to stderr
  });

  it('chat --json /help writes the command list to stderr, never the stdout NDJSON stream', async () => {
    const { io, out, err } = captureIo();
    const store = createSessionStore(client.db);
    let id = 0;
    const d: ChatCommandDeps = {
      io: { ...io, stdin: Readable.from(['/help\n']) },
      global: { ...globalOptions(cwd), json: true },
      providers: scriptedResolver([textTurn('unused')]),
      openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
      drive: driveJson,
      now: () => 0,
      uuid: () => `id-${id++}`,
    };
    expect(await chatCommand({ agent: undefined }, d)).toBe(EXIT_CODES.chatEnded);
    parseNdjson(out()); // throws if a human /help line leaked onto stdout
    expect(out()).not.toContain('/help'); // the list did NOT pollute the event stream
    expect(err()).toContain('/export'); // it went to stderr
  });

  it('chat --json /export emits a session:exported event on stdout (the machine path)', async () => {
    const { io, out } = captureIo();
    const store = createSessionStore(client.db);
    let id = 0;
    const d: ChatCommandDeps = {
      io: { ...io, stdin: Readable.from(['hello\n/export\n']) },
      global: { ...globalOptions(cwd), json: true },
      providers: scriptedResolver([textTurn('hi there')]),
      openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
      drive: driveJson,
      now: () => 0,
      uuid: () => `id-${id++}`, // sessionId = id-0; message ids advance, so no PK collision
    };
    expect(await chatCommand({ agent: undefined }, d)).toBe(EXIT_CODES.chatEnded);
    const exported = parseNdjson<{ type: string; workflowPath?: string }>(out()).find(
      (e) => e.type === 'session:exported',
    );
    expect(exported).toBeDefined(); // /export emits the event on the --json stream, not just a stderr line
    expect(exported?.workflowPath).toBe(join(cwd, 'id-0.relavium.yaml'));
  });

  it('strips control bytes from an unknown-slash echo (terminal-injection guard) and lists /export', async () => {
    const { d, err } = deps(['/\x1b[2Jboom', '/exit'], [textTurn('x')]);
    await chatCommand({ agent: undefined }, d);
    expect(err()).not.toContain('\x1b'); // the raw ESC never reached stderr
    expect(err()).toContain('?'); // it was replaced
    expect(err()).toContain('/export'); // the help line advertises the /export affordance
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

  /** Write an --agent file declaring one stdio MCP server (the injected startMcpClient never spawns it). */
  function writeMcpAgent(): string {
    const p = join(cwd, 'mcp.agent.yaml');
    writeFileSync(p, MCP_AGENT_YAML);
    return p;
  }

  it('an MCP-declaring chat agent: surfaces dropped tools to stderr and tears the connection down at REPL teardown (2.R)', async () => {
    // chat.ts's OWN command-level MCP wiring: surfaceMcpSkipped (→ stderr, never the stdout chrome) + the
    // closeMcp teardown in runReplLoop's finally. Drives the REAL buildChatSession over a fake connection.
    const agentPath = writeMcpAgent();
    const { conn, closed } = mcpConn();
    const { d, out, err } = deps(['/exit'], [textTurn('done')]);
    const buildSession: typeof buildChatSession = (o) =>
      buildChatSession({
        ...o,
        startMcpClient: () =>
          realStartMcpClient([
            { id: 'fs', toolsAllowlist: ['read'], open: () => Promise.resolve(conn) },
          ]),
      });
    const code = await chatCommand({ agent: agentPath }, { ...d, buildSession });
    expect(code).toBe(EXIT_CODES.chatEnded);
    expect(err()).toContain("MCP tool 'danger'"); // the allowlist-dropped tool note went to stderr
    expect(out()).not.toContain('danger'); // …never to stdout
    expect(closed()).toBe(1); // torn down exactly once at REPL teardown (runReplLoop finally)
  });

  it('tears the MCP connection down when opening the session store throws AFTER a successful build (orphan guard, 2.R)', async () => {
    // The build→loop window: the session already OWNS the live connection, but openSessionStore throws before the
    // REPL loop's steady-state finally — chat.ts's catch must close the connection (no orphaned child) and rethrow.
    const agentPath = writeMcpAgent();
    const { conn, closed } = mcpConn();
    const { d } = deps(['/exit'], [textTurn('x')]);
    const buildSession: typeof buildChatSession = (o) =>
      buildChatSession({
        ...o,
        startMcpClient: () =>
          realStartMcpClient([
            { id: 'fs', toolsAllowlist: ['read'], open: () => Promise.resolve(conn) },
          ]),
      });
    await expect(
      chatCommand(
        { agent: agentPath },
        {
          ...d,
          buildSession,
          openSessionStore: () => {
            throw new Error('db open boom');
          },
        },
      ),
    ).rejects.toThrow('db open boom');
    expect(closed()).toBe(1); // the pre-loop catch tore the live connection down before rethrowing
  });
});

describe('chatResumeCommand (2.N)', () => {
  let cwd: string;
  let home: string;
  let client: DbClient;
  const savedHome = new Map<string, string | undefined>();

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-resume-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-resume-home-'));
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

  type Store = ReturnType<typeof createSessionStore>;

  /** Fresh-session deps over a SHARED store, so a later resume reloads the SAME `history.db`. sessionId = `id-0`. */
  function freshDeps(
    lines: readonly string[],
    scripts: StreamChunk[][],
    store: Store,
  ): ChatCommandDeps {
    const { io } = captureIo();
    let tick = Date.parse('2026-06-25T00:00:00.000Z');
    let id = 0;
    return {
      io,
      global: globalOptions(cwd),
      providers: scriptedResolver(scripts),
      openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
      drive: linesDriver(lines),
      now: () => tick++,
      uuid: () => `id-${id++}`,
    };
  }

  /**
   * Resume deps over the SAME store; resume reuses the persisted sessionId (no mint), so ids only feed
   * messages. `prefix` makes message ids unique ACROSS resumes (production uses randomUUID; the deterministic
   * test uuid would otherwise collide on the message PK when one session is resumed more than once).
   */
  function resumeDeps(
    lines: readonly string[],
    scripts: StreamChunk[][],
    store: Store,
    prefix = 'r',
  ): { d: ChatResumeCommandDeps; err: () => string } {
    const { io, err } = captureIo();
    let tick = Date.parse('2026-06-25T01:00:00.000Z');
    let id = 0;
    return {
      d: {
        io,
        global: globalOptions(cwd),
        providers: scriptedResolver(scripts),
        openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
        drive: linesDriver(lines),
        now: () => tick++,
        uuid: () => `${prefix}-${id++}`,
      },
      err,
    };
  }

  it('reloads a persisted session and continues it, appending sequenced rows past the prior max', async () => {
    const store = createSessionStore(client.db);
    // Seed one fresh turn (id-0 = session; messages seq 0,1), then resume and add a second turn.
    expect(
      await chatCommand(
        { agent: undefined },
        freshDeps(['hello', '/exit'], [textTurn('hi')], store),
      ),
    ).toBe(EXIT_CODES.chatEnded);

    const { d } = resumeDeps(['again', '/exit'], [textTurn('more')], store);
    expect(await chatResumeCommand({ sessionId: 'id-0' }, d)).toBe(EXIT_CODES.chatEnded);

    const full = store.loadFull('id-0');
    expect(full?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // The continued turn's rows are seq 2,3 — past the persisted MAX (1), no UNIQUE collision.
    expect(full?.messages.map((m) => m.sequenceNumber)).toEqual([0, 1, 2, 3]);
    expect(full?.messages[2]?.content[0]).toEqual({ type: 'text', text: 'again' });
    expect(full?.messages[3]?.content[0]).toEqual({ type: 'text', text: 'more' });
    // Totals accumulate across the resume (the persister adopts + hydrates the prior row): 2 turns × {10,5}.
    expect(full?.session.totalInputTokens).toBe(20);
    expect(full?.session.totalOutputTokens).toBe(10);
    // Cost also accumulates (not reset to the new turn's delta) — the persister seeds it from the adopted row.
    expect(full?.session.totalCostMicrocents).toBeGreaterThan(0);
  });

  it('keeps sequence numbers monotonic across THREE resumes (no off-by-one)', async () => {
    const store = createSessionStore(client.db);
    await chatCommand({ agent: undefined }, freshDeps(['t1', '/exit'], [textTurn('a')], store));
    await chatResumeCommand(
      { sessionId: 'id-0' },
      resumeDeps(['t2', '/exit'], [textTurn('b')], store, 'r2').d,
    );
    await chatResumeCommand(
      { sessionId: 'id-0' },
      resumeDeps(['t3', '/exit'], [textTurn('c')], store, 'r3').d,
    );

    const full = store.loadFull('id-0');
    // Three turns × {user, assistant} = six rows, contiguously sequenced across the three processes.
    expect(full?.messages.map((m) => m.sequenceNumber)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(full?.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('ends a RESUMED session on /cancel with exit 4 (the resumable-cancel contract holds on the resume path)', async () => {
    const store = createSessionStore(client.db);
    await chatCommand({ agent: undefined }, freshDeps(['hello', '/exit'], [textTurn('hi')], store));
    const { d } = resumeDeps(['/cancel'], [], store);
    expect(await chatResumeCommand({ sessionId: 'id-0' }, d)).toBe(EXIT_CODES.chatEnded);
    expect(store.loadFull('id-0')?.session.status).toBe('ended');
  });

  it('warns up front when resuming a session already at/over the [chat].max_turns cap', async () => {
    const store = createSessionStore(client.db);
    // Seed two turns under the default (uncapped) cwd so the seeding itself is not blocked.
    await chatCommand(
      { agent: undefined },
      freshDeps(['t1', 't2', '/exit'], [textTurn('a'), textTurn('b')], store),
    );
    // A separate project whose [chat].max_turns = 1 is BELOW the session's 2 prior turns.
    const capCwd = mkdtempSync(join(tmpdir(), 'relavium-cap-'));
    mkdirSync(join(capCwd, '.relavium'), { recursive: true });
    writeFileSync(join(capCwd, '.relavium', 'project.toml'), '[chat]\nmax_turns = 1\n');
    try {
      const { d, err } = resumeDeps([], [], store);
      await chatResumeCommand(
        { sessionId: 'id-0' },
        { ...d, global: { ...globalOptions(capCwd), json: false } },
      );
      expect(err()).toContain('new turns will be refused');
    } finally {
      rmSync(capCwd, { recursive: true, force: true });
    }
  });

  it('does NOT warn when resuming a session below the (default) turn cap', async () => {
    const store = createSessionStore(client.db);
    await chatCommand({ agent: undefined }, freshDeps(['t1', '/exit'], [textTurn('a')], store));
    const { d, err } = resumeDeps([], [], store);
    await chatResumeCommand({ sessionId: 'id-0' }, d);
    expect(err()).not.toContain('new turns will be refused'); // 1 turn ≪ default cap 50
  });

  it('seeds the view header (model · cost · prior turns) and the resume intro from the reconstructed state', async () => {
    const store = createSessionStore(client.db);
    await chatCommand({ agent: undefined }, freshDeps(['hello', '/exit'], [textTurn('hi')], store));
    const seededModel = store.loadFull('id-0')?.session.agentSnapshot?.model;

    let snapshot: ReturnType<ChatDriveContext['store']['getSnapshot']> | undefined;
    let intro: string | undefined;
    const captureDrive: ChatDriver = (ctx) => {
      snapshot = ctx.store.getSnapshot();
      intro = ctx.intro;
      return Promise.resolve();
    };
    const { d } = resumeDeps([], [], store);
    await chatResumeCommand({ sessionId: 'id-0' }, { ...d, drive: captureDrive });

    expect(snapshot?.state.turnCount).toBe(1); // one prior completed turn
    expect(snapshot?.state.model).toBe(seededModel); // header model seeded (a fresh store would be undefined)
    expect(seededModel).toBeDefined();
    expect(snapshot?.state.cumulativeCostMicrocents).toBeGreaterThan(0); // carried-over cost, not zero
    expect(intro).toContain('Resuming session id-0');
    expect(intro).toContain('1 prior turn'); // singular, and not "1 prior turns"
    expect(intro).not.toContain('1 prior turns');
  });

  it('pluralizes the resume intro for a multi-turn session ("N prior turns")', async () => {
    const store = createSessionStore(client.db);
    // Seed TWO completed turns so the reconstructed turn count is 2 (plural branch of the intro).
    await chatCommand(
      { agent: undefined },
      freshDeps(['hello', 'again', '/exit'], [textTurn('hi'), textTurn('yo')], store),
    );

    let intro: string | undefined;
    const captureDrive: ChatDriver = (ctx) => {
      intro = ctx.intro;
      return Promise.resolve();
    };
    const { d } = resumeDeps([], [], store);
    await chatResumeCommand({ sessionId: 'id-0' }, { ...d, drive: captureDrive });
    expect(intro).toContain('2 prior turns');
  });

  it('sanitizes a crafted session id in the resume intro banner (no terminal escape reaches the TTY)', async () => {
    const store = createSessionStore(client.db);
    // `history.db` is shared with other surfaces whose ids are only schema-constrained to a non-empty string,
    // so a row may carry control bytes. Mint the session under an id bearing an OSC sequence + a newline; a
    // fresh run persists a real agentSnapshot under it, then the resume intro must strip the escape (exactly
    // as chat-list sanitizes its id column) — else the banner is the one chat output path that could inject.
    const craftedId = 'evil\u001b]0;x\u0007\nFAKE-ROW';
    let idc = 0;
    let tick = Date.parse('2026-06-25T00:00:00.000Z');
    const seed: ChatCommandDeps = {
      io: captureIo().io,
      global: globalOptions(cwd),
      providers: scriptedResolver([textTurn('hi')]),
      openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
      drive: linesDriver(['hello', '/exit']),
      now: () => tick++,
      uuid: () => (idc++ === 0 ? craftedId : `m-${idc}`), // first mint = the session id
    };
    expect(await chatCommand({ agent: undefined }, seed)).toBe(EXIT_CODES.chatEnded);

    let intro: string | undefined;
    const captureDrive: ChatDriver = (ctx) => {
      intro = ctx.intro;
      return Promise.resolve();
    };
    const { d } = resumeDeps([], [], store);
    await chatResumeCommand({ sessionId: craftedId }, { ...d, drive: captureDrive });
    expect(intro).toBeDefined();
    expect(intro).not.toContain('\u001b'); // no ESC control byte survives into the banner
    expect(intro).not.toContain('\u0007'); // no BEL control byte survives into the banner
    expect(intro).not.toContain('\n'); // the smuggled newline is collapsed — the row cannot be split
    expect(intro).toContain('Resuming session'); // the banner's static text is intact
  });

  it('rejects an unknown sessionId as a clean exit-2 invocation fault and closes the store', async () => {
    let closed = false;
    const store = createSessionStore(client.db);
    const { d } = resumeDeps([], [], store);
    await expect(
      chatResumeCommand(
        { sessionId: 'ghost' },
        { ...d, openSessionStore: () => ({ store, db: client.db, close: () => (closed = true) }) },
      ),
    ).rejects.toThrow(/no session found with id ghost/);
    expect(closed).toBe(true); // the opened db handle is not stranded on the not-found path
  });

  it('rejects a session with no stored agent snapshot as a clean exit-2 fault', async () => {
    const store = createSessionStore(client.db);
    store.createSession({
      id: 'no-snap',
      agentSlug: 'gone',
      context: { workingDir: cwd, fsScopeTier: 'sandboxed' },
      status: 'ended',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostMicrocents: 0,
      createdAt: '2026-06-25T00:00:00.000Z',
      updatedAt: '2026-06-25T00:00:00.000Z',
    });
    const { d } = resumeDeps([], [], store);
    await expect(chatResumeCommand({ sessionId: 'no-snap' }, d)).rejects.toThrow(
      /no stored agent snapshot/,
    );
  });

  it('re-discovers the resumed agent MCP servers and tears the connection down at teardown (2.R)', async () => {
    // The snapshot persists the author's `mcp_servers` (not the baked grant), so resume RE-connects them fresh
    // each time and OWNS the new connection — runReplLoop's finally must close it. Distinct conns/counters for
    // the seed vs the resume isolate the resume teardown.
    const store = createSessionStore(client.db);
    const agentPath = join(cwd, 'mcp.agent.yaml');
    writeFileSync(agentPath, MCP_AGENT_YAML);

    const seed = mcpConn();
    const seedBuild: typeof buildChatSession = (o) =>
      buildChatSession({
        ...o,
        startMcpClient: () =>
          realStartMcpClient([{ id: 'fs', open: () => Promise.resolve(seed.conn) }]),
      });
    expect(
      await chatCommand(
        { agent: agentPath },
        { ...freshDeps(['hello', '/exit'], [textTurn('hi')], store), buildSession: seedBuild },
      ),
    ).toBe(EXIT_CODES.chatEnded);

    const resume = mcpConn();
    const resumeBuild: typeof buildResumedChatSession = (o) =>
      buildResumedChatSession({
        ...o,
        startMcpClient: () =>
          realStartMcpClient([{ id: 'fs', open: () => Promise.resolve(resume.conn) }]),
      });
    const { d } = resumeDeps(['again', '/exit'], [textTurn('more')], store);
    expect(
      await chatResumeCommand({ sessionId: 'id-0' }, { ...d, buildResumedSession: resumeBuild }),
    ).toBe(EXIT_CODES.chatEnded);
    expect(resume.closed()).toBe(1); // the RESUMED session's connection torn down once at teardown
  });
});

describe('drivePlain', () => {
  // A minimal driver context over a REAL session handle (no turns fire — startSession is a no-op) plus a
  // recording processLine, so we exercise drivePlain's readline loop + teardown over the injected stdin (F1).
  async function plainCtx(stdin: NodeJS.ReadableStream) {
    const built = await buildChatSession({
      chat: EMPTY_CHAT,
      agentRef: undefined,
      cwd: tmpdir(),
      projectConfigDir: undefined,
      now: () => 0,
      uuid: () => 'sess-x',
      providers: scriptedResolver([]),
    });
    const { io: base } = captureIo();
    const processed: string[] = [];
    let stop = false;
    const ctx: ChatDriveContext = {
      startSession: () => undefined,
      processLine: (line) => {
        processed.push(line);
        if (line === '/exit') stop = true;
        return Promise.resolve();
      },
      shouldStop: () => stop,
      handle: built.handle,
      store: createChatStore(false),
      io: { ...base, stdin },
      global: globalOptions(tmpdir()),
    };
    return { ctx, processed };
  }

  it('reads lines from the injected stdin, dispatches each, and stops on /exit', async () => {
    const stdin = new PassThrough();
    const { ctx, processed } = await plainCtx(stdin);
    const done = drivePlain(ctx);
    stdin.write('hello\n');
    stdin.write('/exit\n');
    stdin.end();
    await done;
    expect(processed).toEqual(['hello', '/exit']);
  });

  it('a SIGINT closes the input so the loop ends and the finally removes the handler (teardown path)', async () => {
    const stdin = new PassThrough();
    const { ctx } = await plainCtx(stdin);
    // Identify drivePlain's handler by SET-DELTA (not `.at(-1)`), matching the run.test.ts pattern — robust to
    // any other SIGINT listener the runner/host registers around it. Invoke it directly (not process.emit,
    // which would also fire the runner's listeners); it calls rl.close(), ending the for-await loop.
    const before = process.listeners('SIGINT').slice();
    const done = drivePlain(ctx);
    const added = process.listeners('SIGINT').filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);
    const handler = added[0];
    if (typeof handler !== 'function') throw new TypeError('expected a registered SIGINT handler');
    handler('SIGINT'); // our onSigint ignores the arg; pass it to satisfy the SignalsListener signature
    await done;
    expect(process.listeners('SIGINT').filter((l) => !before.includes(l))).toHaveLength(0); // finally removed it
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

  it('produces NO output for agent:tool_result (its outputSummary must never reach the terminal)', () => {
    const { io, out } = captureIo();
    makePlainPrinter(io)({
      type: 'agent:tool_result',
      ...STAMP,
      nodeId: 'a',
      toolId: 'read_file',
      success: true,
      outputSummary: 'file contents: secret-data', // tool output may carry secrets/PII — never printed
    });
    expect(out()).toBe('');
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

describe('selectChatDriver', () => {
  // A ctx whose stdin is already at EOF, so the PLAIN driver resolves immediately. The ink driver would mount
  // and block on input forever, so a resolving promise PROVES the plain branch was chosen. If the routing
  // predicate regressed (e.g. && → ||), a non-TTY case would route to ink and hang this test.
  async function ctxWith(stdoutIsTty: boolean, json: boolean): Promise<ChatDriveContext> {
    const built = await buildChatSession({
      chat: EMPTY_CHAT,
      agentRef: undefined,
      cwd: tmpdir(),
      projectConfigDir: undefined,
      now: () => 0,
      uuid: () => 'sess-y',
      providers: scriptedResolver([]),
    });
    const stdin = new PassThrough();
    stdin.end(); // immediate EOF ⇒ the plain loop completes at once
    const { io: base } = captureIo();
    return {
      startSession: () => undefined,
      processLine: () => Promise.resolve(),
      shouldStop: () => true,
      handle: built.handle,
      store: createChatStore(false),
      io: { ...base, stdoutIsTty, stdin },
      global: { ...globalOptions(tmpdir()), json },
    };
  }

  it('routes a non-TTY surface to the plain driver (resolves; ink would block)', async () => {
    await expect(selectChatDriver(await ctxWith(false, false))).resolves.toBeUndefined();
  });

  it('routes --json to the headless json driver even on a TTY (resolves; ink would block)', async () => {
    await expect(selectChatDriver(await ctxWith(true, true))).resolves.toBeUndefined();
  });

  it('routes a non-TTY + --json surface to the headless json driver', async () => {
    await expect(selectChatDriver(await ctxWith(false, true))).resolves.toBeUndefined();
  });
});

describe('driveJson (2.Q)', () => {
  // A driver context over a REAL session handle + a recording processLine, so we exercise driveJson's
  // readline loop and its NDJSON serialization of the live event stream over the injected stdin.
  async function jsonCtx(
    stdin: NodeJS.ReadableStream,
    turns: StreamChunk[][] = [textTurn('hi there')],
  ) {
    const built = await buildChatSession({
      chat: EMPTY_CHAT,
      agentRef: undefined,
      cwd: tmpdir(),
      projectConfigDir: undefined,
      now: () => 0,
      uuid: () => 'sess-j',
      providers: scriptedResolver(turns),
    });
    const { io: base, out } = captureIo();
    let stop = false;
    const ctx: ChatDriveContext = {
      startSession: () => built.session.start(), // emits session:started ⇒ the first NDJSON line
      processLine: async (line) => {
        if (line === '/exit') {
          stop = true;
          return;
        }
        await built.session.sendMessage(line);
      },
      shouldStop: () => stop,
      handle: built.handle,
      store: createChatStore(false),
      io: { ...base, stdin },
      global: { ...globalOptions(tmpdir()), json: true },
      // Flush the terminal (session:cancelled) before unsubscribing, as runReplLoop wires in production.
      finalize: () => built.session.cancel(),
    };
    return { ctx, out, built };
  }

  it('emits a pure NDJSON stream (session:started → turn events → session:cancelled terminal) on EOF', async () => {
    const stdin = new PassThrough();
    const { ctx, out } = await jsonCtx(stdin);
    const done = driveJson(ctx);
    stdin.write('hello\n');
    stdin.end(); // EOF ends the loop
    await done;

    // parseNdjson runtime-rejects any non-object line, so it doubles as a stdout-purity guard.
    const events = parseNdjson<{ type: string; sessionId?: string }>(out());
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('session:started'); // the first line is the lifecycle-open event
    expect(types).toContain('session:turn_started');
    expect(types).toContain('session:turn_completed');
    expect(types.at(-1)).toBe('session:cancelled'); // the sole terminal IS in the stream (the finalize fix)
    // Every line carries the sessionId (the disjoint session namespace).
    expect(events.every((e) => e.sessionId === 'sess-j')).toBe(true);
    expect(out()).not.toContain('test-key'); // the dummy provider key never reaches the stream
  });

  it('streams two turns, each with its own session:turn_completed, before the terminal', async () => {
    const stdin = new PassThrough();
    const { ctx, out } = await jsonCtx(stdin, [textTurn('one'), textTurn('two')]);
    const done = driveJson(ctx);
    stdin.write('first\n');
    stdin.write('second\n');
    stdin.end();
    await done;

    const types = parseNdjson<{ type: string }>(out()).map((e) => e.type);
    expect(types.filter((t) => t === 'session:turn_completed')).toHaveLength(2); // both turns settled
    expect(types.at(-1)).toBe('session:cancelled');
  });

  it('a SIGINT closes the input so the loop ends and the finally removes the handler (teardown path)', async () => {
    // The parallel of the drivePlain SIGINT teardown test — driveJson registers its own SIGINT handler and must
    // remove it in the finally. Identify it by SET-DELTA (robust to any other listener the runner registers).
    const stdin = new PassThrough();
    const { ctx } = await jsonCtx(stdin);
    const before = process.listeners('SIGINT').slice();
    const done = driveJson(ctx);
    const added = process.listeners('SIGINT').filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);
    const handler = added[0];
    if (typeof handler !== 'function') throw new TypeError('expected a registered SIGINT handler');
    handler('SIGINT'); // invoke directly (not process.emit) — it closes the readline, ending the loop
    await done;
    expect(process.listeners('SIGINT').filter((l) => !before.includes(l))).toHaveLength(0); // finally removed it
  });
});
