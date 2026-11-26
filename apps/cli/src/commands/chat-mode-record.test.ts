/**
 * The mode choke point keeps a content-free record ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §6): every effective mode change of an interactive chat appends a `mode_change` row to the session through its persister BEFORE the mode
 * is applied, and a change whose row cannot be written is refused (one line on the host's channel; the session is not latched). The
 * initial mode and the non-interactive clamp record nothing. A change into `accept-edits` or `auto`, by the key, a typed argument or the
 * popup, is announced with its effect on the host's channel; a typed `/mode <name>` writes nothing into the transcript of an interactive
 * chat and keeps its text in a plain one.
 *
 * Two real paths: the stand-alone chat end to end (`chatCommand` → `createChatLineHandler`, the driver's `onModeChange` that `Shift+Tab`
 * calls and its `processLine` a typed line takes), and `createChatLineHandler` over a real session, store and persister for what the host
 * binds with `setAnnouncer`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createSessionStore,
  createSessionUsageStore,
  runMigrations,
  type DbClient,
  type SessionStore,
} from '@relavium/db';
import type { ChatMode } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nextMode } from '../chat/chat-mode.js';
import { MODE_NOT_RECORDED_NOTICE, modeChangedNotice } from '../chat/mode-effects.js';
import { createSessionPersister, type SessionPersister } from '../chat/persister.js';
import { buildChatSession } from '../chat/session-host.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { resolveConfig } from '../config/resolve.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { MODE_CHANGE_RUNNING_NOTICE } from '../render/tui/chat-input.js';
import { createChatStore, type ChatStoreController } from '../render/tui/chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from '../render/tui/session-view-model.js';
import type { KeychainStore } from '../secrets/keychain.js';
import { captureIo } from '../test-support.js';
import { TURN_COMPLETED, TURN_STARTED } from './chat-mode-control.test-support.js';
import {
  chatCommand,
  createChatLineHandler,
  type ChatCommandDeps,
  type ChatDriver,
  type ChatLineHandler,
} from './chat.js';

const inertTerminal = {
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
const keychain: KeychainStore = { get: () => null, set: () => undefined, delete: () => false };

let cwd: string;
let home: string;
let client: DbClient;
let store: SessionStore;
const saved = new Map<string, string | undefined>();
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-mode-record-work-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-mode-record-home-')));
  // Never the operator's real home: the chat reads its config and its history from here.
  for (const key of ['HOME', 'USERPROFILE']) {
    saved.set(key, process.env[key]);
    process.env[key] = home;
  }
  client = createClient(':memory:');
  runMigrations(client.db);
  store = createSessionStore(client.db);
});
afterEach(() => {
  client.sqlite.close();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** The record rows of every session in the test database, in order, as `from→to`. */
const modeRecords = (): string[] =>
  (
    client.sqlite
      .prepare(
        "SELECT record_from AS f, record_to AS t, role, content_parts AS c FROM session_messages WHERE record_kind = 'mode_change' ORDER BY sequence_number",
      )
      .all() as { f: string; t: string; role: string; c: string }[]
  ).map((row) => {
    expect(row.role).toBe('system');
    expect(row.c).toBe('[]');
    return `${row.f}→${row.t}`;
  });
const notices = (chat: ChatStoreController): string[] =>
  chat
    .getSnapshot()
    .state.transcript.flatMap((entry) => (entry.role === 'notice' ? [entry.text] : []));

describe('the stand-alone chat, end to end (chatCommand → createChatLineHandler)', () => {
  function writeGlobal(mode: string): void {
    mkdirSync(join(home, '.relavium'), { recursive: true });
    writeFileSync(
      join(home, '.relavium', 'config.toml'),
      `[preferences]\ndefault_mode = "${mode}"\n`,
    );
  }
  function deps(drive: ChatDriver, interactive = true, turns = 0): ChatCommandDeps {
    const { io } = captureIo();
    let id = 0;
    return {
      ...inertTerminal,
      keychain,
      io: { ...io, stdoutIsTty: interactive },
      global: { cwd, json: false, color: false, configPath: undefined, verbosity: 'normal' },
      providers: scriptedResolver(Array.from({ length: turns }, () => textTurn('ok'))),
      openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
      uuid: () => `mode-record-${String(id++)}`,
      drive,
    };
  }

  it('Shift+Tab and a typed /mode each record the change before it applies; the starting mode records nothing', async () => {
    const modes: ChatMode[] = [];
    let transcriptNotices: string[] = [];
    await chatCommand(
      { agent: undefined },
      deps(async (ctx) => {
        ctx.startSession();
        await ctx.onActivated?.(() => !ctx.shouldStop());
        expect(modeRecords()).toEqual([]); // the session's start is not a change
        // Shift+Tab: the driver's control, called with the next mode in the cycle.
        ctx.onModeChange?.(nextMode(ctx.store.getSnapshot().mode));
        modes.push(ctx.store.getSnapshot().mode);
        await ctx.processLine('/mode auto');
        modes.push(ctx.store.getSnapshot().mode);
        await ctx.processLine('/mode auto'); // already in force: nothing changes, nothing is recorded
        await ctx.processLine('/mode ask');
        modes.push(ctx.store.getSnapshot().mode);
        transcriptNotices = notices(ctx.store);
        return { kind: 'exit' };
      }),
    );
    expect(modes).toEqual(['plan', 'auto', 'ask']);
    expect(modeRecords()).toEqual(['ask→plan', 'plan→auto', 'auto→ask']);
    // An interactive chat's typed setting leaves nothing in the transcript (the residue rule): no `mode: …` line.
    expect(transcriptNotices.filter((text) => text.startsWith('mode:'))).toEqual([]);
  });

  it('a configured starting auto is not a change: nothing is recorded until the person changes it', async () => {
    writeGlobal('auto');
    await chatCommand(
      { agent: undefined },
      deps(async (ctx) => {
        ctx.startSession();
        await ctx.onActivated?.(() => !ctx.shouldStop());
        expect(ctx.store.getSnapshot().mode).toBe('auto');
        expect(modeRecords()).toEqual([]);
        ctx.onModeChange?.('ask');
        return { kind: 'exit' };
      }),
    );
    expect(modeRecords()).toEqual(['auto→ask']);
  });

  it('a change whose record cannot be written is refused: the mode, the footer and the turn policy stay, and the session still sends', async () => {
    let afterRefusal: ChatMode | undefined;
    let sent = false;
    await chatCommand(
      { agent: undefined },
      deps(
        async (ctx) => {
          ctx.startSession();
          await ctx.onActivated?.(() => !ctx.shouldStop());
          const writeTurn = vi.spyOn(store, 'writeTurn').mockImplementationOnce(() => {
            throw new Error('SQLITE_BUSY: database is locked');
          });
          ctx.onModeChange?.('auto');
          expect(writeTurn).toHaveBeenCalledOnce();
          afterRefusal = ctx.store.getSnapshot().mode;
          // Not latched: the next message is sent and persisted as ever.
          await ctx.processLine('hello');
          sent = store.loadMessages('mode-record-0').some((row) => row.role === 'assistant');
          ctx.onModeChange?.('plan');
          return { kind: 'exit' };
        },
        true,
        1,
      ),
    );
    expect(afterRefusal).toBe('ask');
    expect(sent).toBe(true);
    expect(modeRecords()).toEqual(['ask→plan']);
    expect(store.loadMessages('mode-record-0').map((row) => row.role)).toEqual([
      'user',
      'assistant',
      'system',
    ]);
  });

  it.each(['plain', 'json'] as const)(
    'a %s chat records nothing: the clamp keeps ask, and the typed line keeps its text',
    async (surface) => {
      const { io, err } = captureIo();
      await chatCommand(
        { agent: undefined },
        {
          ...deps(async (ctx) => {
            ctx.startSession();
            ctx.onModeChange?.('auto');
            await ctx.processLine('/mode accept-edits');
            return { kind: 'exit' };
          }, false),
          io: { ...io, stdoutIsTty: false },
          global: {
            cwd,
            json: surface === 'json',
            color: false,
            configPath: undefined,
            verbosity: 'normal',
          },
        },
      );
      expect(modeRecords()).toEqual([]);
      expect(err()).toContain('mode: ask');
    },
  );

  it('/cost --release records the durable amount it cleared through the same persister (the production wiring)', async () => {
    await chatCommand(
      { agent: undefined },
      {
        ...deps(async (ctx) => {
          ctx.startSession();
          store.recordSessionConservativeCommitment({
            id: 'k',
            sessionId: 'mode-record-0',
            model: 'm',
            estimateMicrocents: 640,
            ts: 1,
          });
          await ctx.processLine('/cost --release');
          return { kind: 'exit' };
        }),
        invocation: invocationFixture().invocation,
      },
    );
    expect(
      store
        .loadMessages('mode-record-0')
        .flatMap((row) => (row.record === undefined ? [] : [row.record])),
    ).toEqual([{ kind: 'cost_release', microcents: 640 }]);
    expect(store.loadSession('mode-record-0')?.totalConservativeMicrocents).toBe(0);
  });

  describe('a plain /cost --release that fails says so in its own line (never the read-failure line, never a raw message)', () => {
    const RELEASE_FAILED =
      'could not release the held estimates: unexpected error — nothing was released';
    const READ_FAILED = 'could not read the session cost: unexpected error';
    async function plainCost(
      line: string,
      before: () => void,
    ): Promise<{ readonly err: string; readonly held: number | undefined }> {
      const { io, err } = captureIo();
      await chatCommand(
        { agent: undefined },
        {
          ...deps(async (ctx) => {
            ctx.startSession();
            store.recordSessionConservativeCommitment({
              id: 'k',
              sessionId: 'mode-record-0',
              model: 'm',
              estimateMicrocents: 640,
              ts: 1,
            });
            before();
            await ctx.processLine(line);
            return { kind: 'exit' };
          }, false),
          io: { ...io, stdoutIsTty: false },
        },
      );
      return { err: err(), held: store.loadSession('mode-record-0')?.totalConservativeMicrocents };
    }

    it('a durable half that throws: the release line, by code, with nothing released and no panel', async () => {
      const result = await plainCost('/cost --release', () => {
        vi.spyOn(store, 'releaseSessionConservativeCommitments').mockImplementationOnce(() => {
          throw new Error('SQLITE_IOERR: disk I/O error at /Users/someone/.relavium/history.db');
        });
      });
      expect(result.err).toContain(RELEASE_FAILED);
      expect(result.err).not.toContain(READ_FAILED);
      expect(result.err).not.toContain('/Users/someone');
      expect(result.err, 'no panel follows a failed release').not.toContain('Session cost:');
      expect(result.held).toBe(640);
    });

    it('a record row that cannot be inserted refuses the release with the same line, and the holds stay', async () => {
      const result = await plainCost('/cost --release', () => {
        // A row another writer put at the persister's next number: the release's record row collides and the release rolls back.
        store.appendMessage({
          id: 'foreign',
          sessionId: 'mode-record-0',
          sequenceNumber: 0,
          role: 'user',
          content: [{ type: 'text', text: 'x' }],
          timestamp: '2026-11-25T00:00:00.000Z',
        });
      });
      expect(result.err).toContain(RELEASE_FAILED);
      expect(result.held).toBe(640);
      expect(store.loadMessages('mode-record-0').filter((row) => row.record !== undefined)).toEqual(
        [],
      );
    });

    it('a read that fails keeps its own words, unchanged', async () => {
      const result = await plainCost('/cost', () => {
        vi.spyOn(store, 'loadSessionCostBreakdown').mockImplementationOnce(() => {
          throw new Error('SQLITE_IOERR: disk I/O error');
        });
      });
      expect(result.err).toContain(READ_FAILED);
      expect(result.err).not.toContain('could not release');
    });

    it('a release that succeeds still prints the panel after it', async () => {
      const result = await plainCost('/cost --release', () => undefined);
      expect(result.err).toContain('Session cost:');
      expect(result.err).not.toContain('could not');
      expect(result.held).toBe(0);
    });
  });
});

describe('createChatLineHandler over a real session, store and persister: what the host is told', () => {
  interface Rig {
    readonly handler: ChatLineHandler;
    readonly chat: ChatStoreController;
    readonly persister: SessionPersister;
    readonly announced: string[];
    /** The topics withdrawn (a narrowing leaves no word of the mode it left). */
    readonly withdrawn: string[];
    readonly dispose: () => Promise<void>;
  }
  async function rig(interactive = true): Promise<Rig> {
    const built = await buildChatSession({
      chat: resolveConfig({}).chat,
      outputStoreFactory: () => Promise.resolve(undefined),
      agentRef: undefined,
      cwd,
      projectConfigDir: undefined,
      providers: scriptedResolver([]),
      now: Date.now,
      uuid: () => 'sess-rig',
    });
    let id = 0;
    const persister = createSessionPersister({
      usageStore: createSessionUsageStore(client.db),
      mode: 'fresh',
      attachUsageWriter: built.attachUsageWriter,
      governor: built.governor,
      attachDurabilityProbe: built.attachDurabilityProbe,
      attachEffectTurnAllocator: built.attachEffectTurnAllocator,
      store,
      handle: built.handle,
      sessionId: built.sessionId,
      agent: built.agent,
      context: built.context,
      now: Date.now,
      uuid: () => `rig-row-${String(id++)}`,
    });
    const chat = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const { io } = captureIo();
    const handler = createChatLineHandler(
      {
        built,
        opened: { store, db: client.db, close: () => undefined },
        store: chat,
        persister,
        doctorProbes: { keychain: () => undefined, config: () => undefined, toolHost: {} },
      },
      {
        keychain,
        io: { ...io, stdoutIsTty: interactive },
        global: { cwd, json: false, color: false, configPath: undefined, verbosity: 'normal' },
      },
    );
    persister.start();
    built.session.start();
    const announced: string[] = [];
    // A withdrawal (an empty text with a topic: a mode that narrowed leaves no word of the one it left) is kept apart from what was said.
    const withdrawn: string[] = [];
    handler.setAnnouncer((text, topic) => {
      if (text === '') withdrawn.push(topic ?? '');
      else announced.push(text);
    });
    return {
      handler,
      chat,
      persister,
      announced,
      withdrawn,
      dispose: async () => {
        persister.close();
        built.session.cancel();
        await built.whenHostSafeToClose();
        await built.closeOutputStore?.();
        await built.closeMcp?.();
      },
    };
  }
  const rigs: Rig[] = [];
  afterEach(async () => {
    for (const made of rigs.splice(0)) await made.dispose();
  });
  async function made(interactive = true): Promise<Rig> {
    const r = await rig(interactive);
    rigs.push(r);
    return r;
  }

  it('a change into accept-edits or auto is announced with its effect; a narrowing is not (the status line shows it)', async () => {
    const r = await made();
    expect(r.handler.onModeChange('plan')).toBe(true);
    expect(r.handler.onModeChange('accept-edits')).toBe(true);
    expect(r.handler.onModeChange('auto')).toBe(true);
    expect(r.handler.onModeChange('ask')).toBe(true);
    expect(r.announced).toEqual([modeChangedNotice('accept-edits'), modeChangedNotice('auto')]);
    // A narrowing says nothing, but it withdraws the word of the mode it left (`ask←plan` and `auto→ask`; a widening withdraws nothing).
    expect(r.withdrawn).toEqual(['mode', 'mode']);
    expect(modeRecords()).toEqual([
      'ask→plan',
      'plan→accept-edits',
      'accept-edits→auto',
      'auto→ask',
    ]);
    expect(notices(r.chat)).toEqual([]);
  });

  it('a mode already in force is not a change: no record, no announcement', async () => {
    const r = await made();
    expect(r.handler.onModeChange('ask')).toBe(true);
    expect(modeRecords()).toEqual([]);
    expect(r.announced).toEqual([]);
  });

  it('a refused record: the mode stays, the refusal is announced on the host’s channel (never the transcript), and nothing is latched', async () => {
    const r = await made();
    vi.spyOn(store, 'writeTurn').mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    expect(r.handler.onModeChange('auto')).toBe(false);
    expect(r.chat.getSnapshot().mode).toBe('ask');
    expect(r.announced).toEqual([MODE_NOT_RECORDED_NOTICE]);
    expect(notices(r.chat)).toEqual([]);
    expect(r.persister.durabilityFailure).toBeUndefined();
    expect(modeRecords()).toEqual([]);
  });

  describe('the amended D-4: a widening needs its row, a narrowing always applies', () => {
    /** Fail the NEXT record write only (the rows before it land). */
    const failNextRecord = (): void => {
      vi.spyOn(store, 'writeTurn').mockImplementationOnce(() => {
        throw new Error('disk I/O error');
      });
    };
    it.each([
      ['auto', 'ask'],
      ['accept-edits', 'plan'],
      ['auto', 'plan'],
      ['ask', 'plan'],
    ] as const)(
      'a narrowing %s → %s whose record fails still applies: no refusal, no announcement about the row, nothing latched',
      async (from, to) => {
        const r = await made();
        if (from !== 'ask') expect(r.handler.onModeChange(from)).toBe(true); // recorded
        const before = modeRecords();
        r.announced.length = 0;
        failNextRecord();
        expect(r.handler.onModeChange(to)).toBe(true);
        expect(r.chat.getSnapshot().mode).toBe(to);
        expect(r.announced).toEqual([]);
        expect(modeRecords(), 'the lost row stays lost').toEqual(before);
        expect(r.persister.durabilityFailure).toBeUndefined();
        expect(notices(r.chat)).toEqual([]);
      },
    );
    it.each([
      ['ask', 'auto'],
      ['plan', 'ask'],
      ['plan', 'accept-edits'],
      ['accept-edits', 'auto'],
    ] as const)(
      'a widening %s → %s whose record fails is refused: the mode stays and the refusal is announced',
      async (from, to) => {
        const r = await made();
        if (from !== 'ask') expect(r.handler.onModeChange(from)).toBe(true);
        const before = modeRecords();
        r.announced.length = 0;
        failNextRecord();
        expect(r.handler.onModeChange(to)).toBe(false);
        expect(r.chat.getSnapshot().mode).toBe(from);
        expect(r.announced).toEqual([MODE_NOT_RECORDED_NOTICE]);
        expect(modeRecords()).toEqual(before);
        expect(r.persister.durabilityFailure).toBeUndefined();
      },
    );
    it('a narrowing whose record lands is recorded like any change', async () => {
      const r = await made();
      expect(r.handler.onModeChange('auto')).toBe(true);
      expect(r.handler.onModeChange('plan')).toBe(true);
      expect(modeRecords()).toEqual(['ask→auto', 'auto→plan']);
    });
  });

  it('while a turn runs a change is refused, records nothing, and the refusal is the host’s notification and no row of the transcript (OD-1)', async () => {
    const r = await made();
    r.chat.apply(TURN_STARTED);
    expect(r.handler.onModeChange('auto')).toBe(false);
    expect(notices(r.chat), 'no transcript row').toEqual([]);
    r.chat.apply(TURN_COMPLETED);
    expect(r.chat.getSnapshot().mode).toBe('ask');
    expect(modeRecords()).toEqual([]);
    expect(r.announced).toEqual([MODE_CHANGE_RUNNING_NOTICE]);
  });

  it('a typed /mode confirms on the host’s channel only: its effect for auto, its name for a narrowing or a mode already in force', async () => {
    const r = await made();
    await r.handler.processLine('/mode auto');
    await r.handler.processLine('/mode plan');
    await r.handler.processLine('/mode plan');
    expect(r.announced).toEqual([
      modeChangedNotice('auto'),
      modeChangedNotice('plan'),
      modeChangedNotice('plan'),
    ]);
    expect(modeRecords()).toEqual(['ask→auto', 'auto→plan']);
    expect(notices(r.chat)).toEqual([]);
  });

  it('a typed /mode whose record fails says only the refusal', async () => {
    const r = await made();
    vi.spyOn(store, 'writeTurn').mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    await r.handler.processLine('/mode accept-edits');
    expect(r.announced).toEqual([MODE_NOT_RECORDED_NOTICE]);
    expect(r.chat.getSnapshot().mode).toBe('ask');
    expect(notices(r.chat)).toEqual([]);
  });

  it('nothing is announced once the host unbinds its channel', async () => {
    const r = await made();
    r.handler.setAnnouncer(undefined);
    expect(r.handler.onModeChange('auto')).toBe(true);
    expect(r.announced).toEqual([]);
    expect(modeRecords()).toEqual(['ask→auto']);
  });
});
