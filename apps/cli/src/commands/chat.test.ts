import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import type { SessionStreamHandleEvent } from '@relavium/core';
import type { ProviderId, StreamChunk } from '@relavium/llm';
import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  createSessionStore,
  runMigrations,
  type Db,
  type DbClient,
} from '@relavium/db';
import { startMcpClient as realStartMcpClient, type McpConnection } from '@relavium/mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DoctorProbes } from '../chat/doctor.js';
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
  chatIsInteractive,
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
  autoCompact: undefined,
  compactThreshold: undefined,
  maxCostMicrocents: undefined,
  onExceed: undefined,
  allowedCommands: undefined,
  allowedCommandGlobs: undefined,
  reasoningEffort: undefined,
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
    return { kind: ctx.stopReason() }; // 'exit' for a normal /exit/EOF; 'clear' if a /clear ran (ADR-0062 §7)
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

// Seed a model into `model_catalog` (+ its provider row for the FK) so ADR-0059 attribution can resolve the model
// STRING → the catalog row UUID. Returns that UUID (the `session_messages.model_id` FK target to assert against).
let seedCatalogN = 0;
function seedCatalogModel(db: Db, provider: ProviderId, modelId: string): string {
  const storeDeps = {
    uuid: () => `cat-${provider}-${seedCatalogN++}`,
    now: () => Date.parse('2026-06-25T00:00:00.000Z'),
  };
  const providerRow = createProviderStore(db, storeDeps).upsert({
    name: provider,
    displayName: provider,
    baseUrl: 'https://api.anthropic.com',
  });
  const catalog = createModelCatalogStore(db, storeDeps);
  catalog.upsert({
    providerId: providerRow.id,
    modelId,
    displayName: modelId,
    contextWindowTokens: 200_000,
    maxOutputTokens: 8_192,
  });
  const id = catalog.catalogIdByModelId(modelId);
  if (id === undefined) throw new Error(`catalog seed failed for ${modelId}`);
  return id;
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

  function deps(
    lines: readonly string[],
    scripts: StreamChunk[][],
    extra: Partial<ChatCommandDeps> = {},
  ) {
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
      ...extra,
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

  // A read-only or rejected slash command is reported on stderr and the session CONTINUES (the following user turn
  // still persists → 2 messages). One case per command; only that the session continued is asserted, not the content.
  it.each([
    { label: 'an unknown command', command: '/bogus', expectedErr: "unknown command '/bogus'" },
    {
      label: '/cost (read-only, $0 spend)',
      command: '/cost',
      expectedErr: 'Session cost: $0.0000',
    },
    {
      label: 'an undeclared slash argument',
      command: '/exit now',
      expectedErr: "/exit: unknown argument 'now'",
    },
  ])(
    '$label is reported on stderr without ending the session',
    async ({ command, expectedErr }) => {
      const { d, err, store, sessionId } = deps([command, 'hello', '/exit'], [textTurn('hi')]);
      await chatCommand({ agent: undefined }, d);
      expect(err()).toContain(expectedErr);
      expect(store.loadFull(sessionId)?.messages).toHaveLength(2); // read-only: the session continued
    },
  );

  // A fake fast-tier-passing probe set; `--deep` adds one ok provider + one warn MCP check (deterministic, no I/O).
  const fakeDoctorProbes: DoctorProbes = {
    keychain: () => {},
    config: () => {},
    toolHost: {},
    deepProviders: () =>
      Promise.resolve([
        { id: 'provider:anthropic', label: 'anthropic', status: 'ok', detail: 'key works' },
      ]),
    deepMcp: () =>
      Promise.resolve([
        { id: 'mcp', label: 'MCP servers', status: 'warn', detail: 'none configured' },
      ]),
  };

  it('/doctor runs the fast tier into the notice channel (stderr, non-TTY), without ending the session', async () => {
    const { d, err, store, sessionId } = deps(['/doctor', 'hello', '/exit'], [textTurn('hi')], {
      doctorProbes: fakeDoctorProbes,
    });
    await chatCommand({ agent: undefined }, d);
    const out = err();
    expect(out).toContain('doctor: all checks passed');
    expect(out).toContain('✓ OS keychain: reachable');
    expect(out).not.toContain('anthropic'); // the fast tier never ran the deep provider probe
    expect(store.loadFull(sessionId)?.messages).toHaveLength(2); // read-only: the session continued
  });

  it('/doctor --deep dispatches the deep tier (provider + MCP probes)', async () => {
    const { d, err } = deps(['/doctor --deep', '/exit'], [textTurn('hi')], {
      doctorProbes: fakeDoctorProbes,
    });
    await chatCommand({ agent: undefined }, d);
    const out = err();
    expect(out).toContain('✓ anthropic: key works'); // the deep provider probe ran
    expect(out).toContain('⚠ MCP servers: none configured'); // the deep MCP probe ran
  });

  it('rejects an unknown flag on an arg-taking command (/doctor --bogus)', async () => {
    const { d, err } = deps(['/doctor --bogus', '/exit'], [textTurn('hi')], {
      doctorProbes: fakeDoctorProbes,
    });
    await chatCommand({ agent: undefined }, d);
    expect(err()).toContain("/doctor: unknown argument '--bogus'");
  });

  it('/mode <name> switches the mode; a bare /mode shows the current mode + options (ADR-0057)', async () => {
    const { d, err, store, sessionId } = deps(
      ['/mode', '/mode auto', 'hello', '/exit'],
      [textTurn('hi')],
    );
    await chatCommand({ agent: undefined }, d);
    const out = err();
    expect(out).toContain('mode: ask'); // the bare /mode shows the default (ask) + the options
    expect(out).toContain('mode: auto'); // /mode auto applied
    // /mode is read-only: the session continued and the 'hello' turn persisted (user + assistant = 2).
    expect(store.loadFull(sessionId)?.messages).toHaveLength(2);
  });

  it('rejects an invalid /mode value at the dispatch, LISTING the valid names (a positional not in the mode set)', async () => {
    const { d, err } = deps(['/mode bogus', '/exit'], [textTurn('hi')]);
    await chatCommand({ agent: undefined }, d);
    const out = err();
    expect(out).toContain("/mode: unknown argument 'bogus'"); // the positional-value validation rejects it
    expect(out).toContain('Valid: ask, plan, accept-edits, auto.'); // …and teaches the four names
  });

  it('rejects `/mode plan accept-edits` — a single-value positional takes ONE value, not silently dropping extras', async () => {
    const { d, err } = deps(['/mode plan accept-edits', '/exit'], [textTurn('hi')]);
    await chatCommand({ agent: undefined }, d);
    expect(err()).toContain('/mode: takes a single mode value (got 2).'); // arity enforced, not silently dropped
  });

  it('/compact summarises the conversation, reports the notice, and persists a boundary marker (ADR-0062)', async () => {
    const { d, err, store, sessionId } = deps(
      ['q1', 'q2', '/compact', '/exit'],
      [textTurn('a1'), textTurn('a2'), textTurn('a concise summary')],
    );
    await chatCommand({ agent: undefined }, d);
    const out = err();
    expect(out).toContain('compacting: summarizing the conversation'); // the NON-interactive pre-notice (chat.ts, no live spinner)
    expect(out).toContain('Compacted the conversation'); // the /compact result notice
    expect(out).toContain('a concise summary'); // the summary is shown (inspectable, §7)
    // The append-only marker was persisted (role:'system', role-filtered boundary), full transcript intact.
    const marker = store.loadFull(sessionId)?.messages.find((m) => m.role === 'system');
    expect(marker?.compaction).toEqual({ droppedThroughSequence: 1 });
  });

  it('/trim takes a single FREE positional value — rejects `/trim 2 3` (ADR-0062)', async () => {
    const { d, err } = deps(['/trim 2 3', '/exit'], [textTurn('hi')]);
    await chatCommand({ agent: undefined }, d);
    expect(err()).toContain('/trim: takes a single n value (got 2).');
  });

  it('/workflows reports a project-less cwd without crashing the REPL', async () => {
    const { d, err, store, sessionId } = deps(['/workflows', 'hello', '/exit'], [textTurn('hi')]);
    await chatCommand({ agent: undefined }, d); // the test cwd is a fresh temp dir ⇒ no .relavium/ project
    expect(err()).toContain('No .relavium/ project found');
    expect(store.loadFull(sessionId)?.messages).toHaveLength(2); // the session survived the command
  });

  it('/workflows lists a discovered workflow when a project exists (the catalog → notice path)', async () => {
    mkdirSync(join(cwd, '.relavium', 'workflows'), { recursive: true });
    writeFileSync(
      join(cwd, '.relavium', 'workflows', 'deploy.relavium.yaml'),
      'schema_version: 1\nid: deploy\nname: Deploy\nnodes: []\n',
    );
    const { d, err, store, sessionId } = deps(['/workflows', 'hello', '/exit'], [textTurn('hi')]);
    await chatCommand({ agent: undefined }, d);
    expect(err()).toContain('Workflows (1):');
    expect(err()).toContain('deploy'); // the catalog entry's slug, whether the file is valid or flagged invalid
    expect(store.loadFull(sessionId)?.messages).toHaveLength(2);
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
      return { kind: ctx.stopReason() };
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
      return { kind: ctx.stopReason() };
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

  it('/clear ends the current session (persisted + resumable) and re-drives a FRESH one under a new id (ADR-0062 §7)', async () => {
    const { d, store } = deps([], [textTurn('hi there')]);
    let closeCount = 0;
    const seen: string[] = [];
    let call = 0;
    // A driver that returns 'clear' the first time (what driveInk returns after an interactive /clear) then 'exit'.
    const clearThenExit: ChatDriver = async (ctx) => {
      seen.push(ctx.handle.sessionId); // record WHICH session this invocation drove
      ctx.startSession();
      if (call++ === 0) {
        await ctx.processLine('hello'); // a real turn on the OLD session ⇒ persisted
        return { kind: 'clear' };
      }
      await ctx.processLine('/exit');
      return { kind: 'exit' };
    };
    const code = await chatCommand(
      { agent: undefined },
      {
        ...d,
        openSessionStore: () => ({ store, db: client.db, close: () => (closeCount += 1) }),
        drive: clearThenExit,
      },
    );

    expect(code).toBe(EXIT_CODES.chatEnded);
    expect(seen).toHaveLength(2); // drove the original session, THEN a fresh one after /clear
    const [oldId, freshId] = seen;
    expect(freshId).not.toBe(oldId); // a NEW sessionId — not a re-drive of the same session

    // The OLD conversation is persisted + RESUMABLE ('ended') and kept its turn — the acceptance proof.
    const oldRow = store.loadFull(oldId ?? '');
    expect(oldRow?.session.status).toBe('ended');
    expect(oldRow?.messages.length).toBeGreaterThan(0); // the 'hello' exchange survives for chat-resume

    // The FRESH session is a clean slate: a distinct row, ZERO carried cost, no messages (only /exit ran).
    const freshRow = store.loadFull(freshId ?? '');
    expect(freshRow).toBeDefined();
    expect(freshRow?.session.totalCostMicrocents).toBe(0);
    expect(freshRow?.messages ?? []).toHaveLength(0);
    // The fresh session rebinds the SAME agent (the reason `buildChatSession` gained an `agent` override) —
    // not a re-resolved / different agent.
    expect(freshRow?.session.agentSlug).toBe(oldRow?.session.agentSlug);

    expect(closeCount).toBe(1); // the SHARED db handle closed exactly ONCE across the swap (not per session)
  });

  it('/clear whose FRESH build fails surfaces the resumable prior session and ends cleanly (ADR-0062 §7)', async () => {
    const { d, err, store } = deps([], [textTurn('hi there')]);
    let builds = 0;
    // The initial session builds fine; the /clear rebuild REJECTS (e.g. a transient key/MCP fault).
    const buildSession: typeof buildChatSession = (opts) => {
      if (builds++ === 0) return buildChatSession(opts);
      return Promise.reject(new Error('no API key for the fresh session'));
    };
    const driveClear: ChatDriver = (ctx) => {
      ctx.startSession();
      return Promise.resolve({ kind: 'clear' as const }); // request the swap; the rebuild then fails (no await needed)
    };
    const code = await chatCommand({ agent: undefined }, { ...d, buildSession, drive: driveClear });

    expect(code).toBe(EXIT_CODES.chatEnded); // ends cleanly despite the failed rebuild (never hangs/loops)
    expect(err()).toContain('could not start a new session after /clear'); // actionable, swap-kind-aware hint
    expect(err()).toContain('relavium chat-resume id-0'); // names the OLD, still-resumable conversation
    expect(store.loadFull('id-0')?.session.status).toBe('ended'); // the prior session is persisted + resumable
  });

  it('/clear is REJECTED on a non-interactive surface — the session is not swapped (ADR-0049 gate)', async () => {
    // The deps() harness is non-TTY (captureIo), so chatIsInteractive is false → clearSession's gate refuses
    // /clear and NEVER sets clearRequested (a machine stream stays one session lifecycle). This drives the REAL
    // processLine('/clear') → clearSession → stopReason() path the fabricated-outcome /clear tests bypass.
    const { d, err, store, sessionId } = deps(['hello', '/clear', '/exit'], [textTurn('hi there')]);
    const code = await chatCommand({ agent: undefined }, d);
    expect(code).toBe(EXIT_CODES.chatEnded);
    expect(err()).toContain('needs an interactive terminal'); // the actionable rejection hint
    // NOT swapped: the ORIGINAL session id-0 kept its 'hello' exchange; no fresh session was built.
    const rows = store.loadFull(sessionId);
    expect(rows?.messages).toHaveLength(2); // user 'hello' + assistant 'hi there' — one session, not cleared
    expect(rows?.session.status).toBe('ended');
  });

  it('/models reseat: rebinds the model on the SAME session, carrying the transcript + per-turn attribution (ADR-0059)', async () => {
    const { d, store } = deps([], [textTurn('sonnet reply'), textTurn('opus reply')]);
    // Seed both models into the catalog so attribution resolves the model string → the FK-target UUID.
    const sonnetId = seedCatalogModel(client.db, 'anthropic', 'claude-sonnet-4-6');
    const opusId = seedCatalogModel(client.db, 'anthropic', 'claude-opus-4-8');
    // A live reseat is TTY-interactive only (like `/clear`), so `onReseat` is wired only on an interactive io.
    const interactiveIo = { ...d.io, stdoutIsTty: true };
    const seen: string[] = [];
    const intros: (string | undefined)[] = [];
    let call = 0;
    const reseatThenExit: ChatDriver = async (ctx) => {
      seen.push(ctx.handle.sessionId);
      intros.push(ctx.intro);
      ctx.startSession();
      if (call++ === 0) {
        await ctx.processLine('first'); // a turn on the sonnet-bound session ⇒ persisted (attributed to sonnet)
        ctx.onReseat?.({ modelId: 'claude-opus-4-8', provider: 'anthropic' }); // switch to opus
        return { kind: ctx.stopReason() }; // 'reseat'
      }
      await ctx.processLine('second'); // a turn on the opus-bound session ⇒ persisted (attributed to opus)
      await ctx.processLine('/exit');
      return { kind: ctx.stopReason() };
    };
    const code = await chatCommand(
      { agent: undefined },
      { ...d, io: interactiveIo, drive: reseatThenExit },
    );
    expect(code).toBe(EXIT_CODES.chatEnded);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]); // a reseat CONTINUES the same session (unlike /clear's new id)
    expect(intros[0]).toBeUndefined(); // the original session has no intro
    expect(intros[1]).toContain('Switched to claude-opus-4-8'); // the reseat disclosure intro
    expect(intros[1]).toContain('text transcript only'); // the tool-context-not-carried disclosure

    const full = store.loadFull('id-0');
    expect(full?.session.agentSnapshot?.model).toBe('claude-opus-4-8'); // rebound to the target model
    expect(full?.session.modelId).toBe(opusId); // the reseated session's coarse primary = the new model's catalog id
    // The transcript carried across the switch: turn 1 (sonnet) + turn 2 (opus) — 4 sequenced rows, one session,
    // each assistant row ATTRIBUTED to the model that produced it (its catalog UUID, ADR-0059).
    expect(full?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(full?.messages[1]?.content[0]).toEqual({ type: 'text', text: 'sonnet reply' });
    expect(full?.messages[1]?.modelId).toBe(sonnetId); // turn 1 produced by the ORIGINAL model
    expect(full?.messages[3]?.content[0]).toEqual({ type: 'text', text: 'opus reply' });
    expect(full?.messages[3]?.modelId).toBe(opusId); // turn 2 produced by the NEW model
    expect(full?.messages[0]?.modelId).toBeUndefined(); // a user row carries no producing model
    expect(full?.session.totalCostMicrocents).toBeGreaterThan(0); // both turns' cost accrued (carried, not reset)
  });

  it('/models reseat whose rebuild fails surfaces the resumable prior session and ends cleanly (ADR-0059)', async () => {
    const { d, err, store } = deps([], [textTurn('hi there')]);
    const interactiveIo = { ...d.io, stdoutIsTty: true };
    // The reseat's resumed build REJECTS (e.g. a transient MCP/key fault binding the new model).
    const buildResumedSession: typeof buildResumedChatSession = () =>
      Promise.reject(new Error('reseat build failed'));
    const reseat: ChatDriver = async (ctx) => {
      ctx.startSession();
      await ctx.processLine('hello'); // a real turn on the OLD session ⇒ persisted + resumable
      ctx.onReseat?.({ modelId: 'claude-opus-4-8', provider: 'anthropic' });
      return { kind: ctx.stopReason() };
    };
    const code = await chatCommand(
      { agent: undefined },
      { ...d, io: interactiveIo, buildResumedSession, drive: reseat },
    );
    expect(code).toBe(EXIT_CODES.chatEnded); // ends cleanly despite the failed rebuild (never hangs/loops)
    expect(err()).toContain('could not start a new session after a model switch'); // swap-kind-aware hint
    expect(err()).toContain('relavium chat-resume id-0'); // names the OLD, still-resumable conversation
    expect(store.loadFull('id-0')?.session.status).toBe('ended'); // the prior session is persisted + resumable
  });

  it('a live reseat is gated OFF on a non-interactive surface — onReseat is not wired (ADR-0049 parity)', async () => {
    // The default deps() harness io is non-TTY, so `chatIsInteractive` is false → `onReseat` is NOT wired (a
    // machine/plain stream stays one session lifecycle, exactly as `/clear` is gated off there).
    const { d, store } = deps([], [textTurn('hi there')]);
    let onReseatWired = true;
    const driver: ChatDriver = async (ctx) => {
      ctx.startSession();
      await ctx.processLine('hello');
      onReseatWired = ctx.onReseat !== undefined;
      ctx.onReseat?.({ modelId: 'claude-opus-4-8', provider: 'anthropic' }); // a no-op when unwired
      return { kind: ctx.stopReason() };
    };
    const code = await chatCommand({ agent: undefined }, { ...d, drive: driver });
    expect(code).toBe(EXIT_CODES.chatEnded);
    expect(onReseatWired).toBe(false); // no live reseat on a machine/plain stream
    // NOT reseated: id-0 kept its one 'hello' exchange, still bound to the ORIGINAL model.
    const full = store.loadFull('id-0');
    expect(full?.messages).toHaveLength(2);
    expect(full?.session.agentSnapshot?.model).toBe('claude-sonnet-4-6');
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

  it('/clear from a resumed session rebinds the SNAPSHOT agent into a fresh session (ADR-0062 §7)', async () => {
    const store = createSessionStore(client.db);
    // Seed a session so 'id-0' has a persisted agent SNAPSHOT (no on-disk agentRef) to resume + rebind on /clear.
    await chatCommand({ agent: undefined }, freshDeps(['hello', '/exit'], [textTurn('hi')], store));
    const originalAgent = store.loadFull('id-0')?.session.agentSlug;
    expect(originalAgent).toBeDefined();

    const seen: string[] = [];
    let call = 0;
    const clearThenExit: ChatDriver = async (ctx) => {
      seen.push(ctx.handle.sessionId);
      ctx.startSession(); // no-op for the resumed session; starts the fresh one
      if (call++ === 0) return { kind: 'clear' }; // the resumed session's /clear swap
      await ctx.processLine('/exit');
      return { kind: 'exit' };
    };
    const { d } = resumeDeps([], [], store);
    expect(await chatResumeCommand({ sessionId: 'id-0' }, { ...d, drive: clearThenExit })).toBe(
      EXIT_CODES.chatEnded,
    );

    expect(seen).toHaveLength(2); // drove the RESUMED session, then a fresh one after /clear
    const [resumedId, freshId] = seen;
    expect(resumedId).toBe('id-0'); // resume reuses the persisted id (no mint)
    expect(freshId).not.toBe('id-0'); // /clear started a NEW session
    // The fresh session rebinds the resumed session's SNAPSHOT agent — the whole reason the `agent` override
    // exists (a resumed agent has no on-disk `agentRef` to re-resolve).
    expect(store.loadFull(freshId ?? '')?.session.agentSlug).toBe(originalAgent);
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
      return Promise.resolve({ kind: ctx.stopReason() });
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
      return Promise.resolve({ kind: ctx.stopReason() });
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
      return Promise.resolve({ kind: ctx.stopReason() });
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
      stopReason: () => 'exit' as const,
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

describe('chatIsInteractive (the High-9 deadlock derivation — mirrors selectChatDriver`s ink-mount)', () => {
  it('is true ONLY for a TTY without --json; false when piped OR --json (a dropped `!` would break this)', () => {
    expect(chatIsInteractive({ stdoutIsTty: true }, { json: false })).toBe(true); // ink mounts → can prompt
    expect(chatIsInteractive({ stdoutIsTty: false }, { json: false })).toBe(false); // piped → reject-immediately
    expect(chatIsInteractive({ stdoutIsTty: true }, { json: true })).toBe(false); // --json → reject-immediately
    expect(chatIsInteractive({ stdoutIsTty: false }, { json: true })).toBe(false);
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
      stopReason: () => 'exit' as const,
      handle: built.handle,
      store: createChatStore(false),
      io: { ...base, stdoutIsTty, stdin },
      global: { ...globalOptions(tmpdir()), json },
    };
  }

  it('routes a non-TTY surface to the plain driver (resolves; ink would block)', async () => {
    // A driver now resolves to its outcome ({ kind: 'exit' } here — /clear is gated off-TTY, ADR-0062 §7).
    await expect(selectChatDriver(await ctxWith(false, false))).resolves.toEqual({ kind: 'exit' });
  });

  it('routes --json to the headless json driver even on a TTY (resolves; ink would block)', async () => {
    await expect(selectChatDriver(await ctxWith(true, true))).resolves.toEqual({ kind: 'exit' });
  });

  it('routes a non-TTY + --json surface to the headless json driver', async () => {
    await expect(selectChatDriver(await ctxWith(false, true))).resolves.toEqual({ kind: 'exit' });
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
      stopReason: () => 'exit' as const,
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
