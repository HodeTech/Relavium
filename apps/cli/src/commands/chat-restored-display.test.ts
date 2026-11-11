import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import type { StreamChunk } from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildResumedChatSession } from '../chat/session-host.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import {
  chatCommand,
  chatResumeCommand,
  drivePlain,
  type ChatCommandDeps,
  type ChatResumeCommandDeps,
  type ChatDriver,
} from './chat.js';
const HOME_ENV_VARS = ['HOME', 'USERPROFILE'] as const;
function globalOptions(cwd: string): GlobalOptions {
  return { json: false, color: false, cwd, configPath: undefined, verbosity: 'normal' };
}
const INERT_HOIST = {
  writeControl: (): void => undefined,
  lifecycle: {
    onProcessExit: (): (() => void) => () => undefined,
    onTerminationSignal: (): (() => void) => () => undefined,
    onInterrupt: (): (() => void) => () => undefined,
    setRawMode: (): void => undefined,
    exit: (): void => undefined,
  },
  jobControlLifecycle: {
    supported: false,
    onSuspend: (): (() => void) => () => undefined,
    onContinue: (): (() => void) => () => undefined,
    suspendSelf: (): void => undefined,
  },
} as const;
function linesDriver(lines: readonly string[]): ChatDriver {
  return async (ctx) => {
    ctx.startSession();
    await ctx.onActivated?.(() => !ctx.shouldStop()); // a real driver activates after wiring its subscription
    for (const line of lines) {
      await ctx.processLine(line);
      if (ctx.shouldStop()) break;
    }
    return { kind: ctx.stopReason() }; // 'exit' for a normal /exit/EOF; 'clear' if a /clear ran (ADR-0062 §7)
  };
}
describe('MVP-2 restored display shell integration', () => {
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

  it.each([true, false])(
    'restores explicit display once on initial interactive resume (inline=%s)',
    async (inline) => {
      const store = createSessionStore(client.db);
      // Use the real plain driver: it must explicitly record its visible input.
      const plain = captureIo();
      await chatCommand(
        { agent: undefined },
        {
          ...freshDeps([], [textTurn('answer')], store),
          io: { ...plain.io, stdin: Readable.from(['visible plain prompt\n/exit\n']) },
          drive: drivePlain,
        },
      );
      const { d } = resumeDeps([], [], store);
      const out = captureIo();
      const read = vi.spyOn(store, 'loadUserDisplayTexts');
      let users: string[] = [];
      const drive: ChatDriver = async (ctx) => {
        users = ctx.store
          .getSnapshot()
          .state.transcript.filter((entry) => entry.role === 'user')
          .map((entry) => entry.text);
        ctx.startSession();
        await ctx.onActivated?.(() => !ctx.shouldStop());
        return { kind: 'exit' };
      };
      await chatResumeCommand(
        { sessionId: 'id-0' },
        {
          ...d,
          ...INERT_HOIST,
          global: { ...d.global, noAltScreen: inline },
          io: { ...out.io, stdinIsTty: true, stdoutIsTty: true },
          drive,
        },
      );
      expect(users).toEqual(['visible plain prompt']);
      expect(read).toHaveBeenCalledTimes(1);
      expect(out.out()).toContain('relavium chat resume id-0');
    },
  );

  it('machine resume ignores malformed display metadata and --continue is bounded to launch cwd', async () => {
    const store = createSessionStore(client.db);
    await chatCommand(
      { agent: undefined },
      freshDeps(['hello', '/exit'], [textTurn('answer')], store),
    );
    client.sqlite
      .prepare('UPDATE session_messages SET user_display_text = ?')
      .run(Buffer.from('private corrupt display'));
    const read = vi.spyOn(store, 'loadUserDisplayTexts');
    const page = vi.spyOn(store, 'listSessionPage');
    const { d } = resumeDeps(['/exit'], [], store);
    expect(await chatResumeCommand({ sessionId: undefined, continueLatest: true }, d)).toBe(4);
    expect(read).not.toHaveBeenCalled();
    expect(page).toHaveBeenCalledWith({ workingDir: realpathSync.native(cwd), limit: 1 });
    expect(page).toHaveBeenCalledTimes(1);
    const other = mkdtempSync(join(tmpdir(), 'relavium-empty-continue-'));
    try {
      const open = vi.fn(d.openSessionStore);
      await expect(
        chatResumeCommand(
          { sessionId: undefined, continueLatest: true },
          { ...d, global: { ...d.global, cwd: other }, openSessionStore: open },
        ),
      ).rejects.toMatchObject({ code: 'invalid_invocation' });
      expect(open).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('rejects omitted headless IDs before opening history, keys or builders', async () => {
    const store = createSessionStore(client.db);
    const { d } = resumeDeps([], [], store);
    const open = vi.fn(d.openSessionStore),
      keys = vi.fn(),
      build = vi.fn(buildResumedChatSession);
    await expect(
      chatResumeCommand(
        { sessionId: undefined },
        { ...d, openSessionStore: open, resolveKeys: keys, buildResumedSession: build },
      ),
    ).rejects.toMatchObject({ code: 'invalid_invocation' });
    expect(open).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });
});
