/**
 * What a chat tells the host about its mode ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §6) in the cases `chat-mode-record.test.ts` leaves open, found by the step-5 round-1 mutation sweep. Through `createChatLineHandler` over a real
 * session, store and persister, as that file's second block does: a typed `/mode` the chat refused (a turn is running) says nothing and records
 * nothing; a typed `/mode` for the mode already in force says it once and writes no row; and the line a widening whose row could not be written
 * says is the product's own wording, short enough to be read whole beside a popup's way back.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { modeChangedNotice } from '../chat/mode-effects.js';
import { createSessionPersister } from '../chat/persister.js';
import { buildChatSession } from '../chat/session-host.js';
import { scriptedResolver } from '../chat/test-support.js';
import { resolveConfig } from '../config/resolve.js';
import { createChatStore, type ChatStoreController } from '../render/tui/chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from '../render/tui/session-view-model.js';
import type { KeychainStore } from '../secrets/keychain.js';
import { captureIo } from '../test-support.js';
import { TURN_COMPLETED, TURN_STARTED } from './chat-mode-control.test-support.js';
import { createChatLineHandler, type ChatLineHandler } from './chat.js';

const keychain: KeychainStore = { get: () => null, set: () => undefined, delete: () => false };

let cwd: string;
let home: string;
let client: DbClient;
let store: SessionStore;
const saved = new Map<string, string | undefined>();
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-mode-gaps-work-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-mode-gaps-home-')));
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

/** The record rows of the session, in order, as `from→to`. */
const modeRecords = (): string[] =>
  (
    client.sqlite
      .prepare(
        "SELECT record_from AS f, record_to AS t FROM session_messages WHERE record_kind = 'mode_change' ORDER BY sequence_number",
      )
      .all() as { f: string; t: string }[]
  ).map((row) => `${row.f}→${row.t}`);

interface Rig {
  readonly handler: ChatLineHandler;
  readonly chat: ChatStoreController;
  /** What the host was told (a withdrawal, an empty text with a topic, is kept apart). */
  readonly announced: string[];
  readonly withdrawn: string[];
  readonly dispose: () => Promise<void>;
}
const rigs: Rig[] = [];
afterEach(async () => {
  for (const made of rigs.splice(0)) await made.dispose();
});

/** An interactive chat over a real session, store and persister, its announcements bound as the host binds them. */
async function made(): Promise<Rig> {
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
      io: { ...io, stdoutIsTty: true },
      global: { cwd, json: false, color: false, configPath: undefined, verbosity: 'normal' },
    },
  );
  persister.start();
  built.session.start();
  const announced: string[] = [];
  const withdrawn: string[] = [];
  handler.setAnnouncer((text, topic) => {
    if (text === '') withdrawn.push(topic ?? '');
    else announced.push(text);
  });
  const rig: Rig = {
    handler,
    chat,
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
  rigs.push(rig);
  return rig;
}

describe('a typed `/mode` while a turn runs', () => {
  it('is refused: nothing is announced (not a mode it did not enter), nothing is withdrawn, no row is written, and the mode stays', async () => {
    const r = await made();
    r.chat.apply(TURN_STARTED);
    await r.handler.processLine('/mode plan');
    expect(r.announced).toEqual([]);
    expect(r.withdrawn).toEqual([]);
    r.chat.apply(TURN_COMPLETED);
    expect(r.chat.getSnapshot().mode).toBe('ask');
    expect(modeRecords()).toEqual([]);
  });
});

describe('a typed `/mode` for the mode already in force', () => {
  it('says it once and writes no row: the change was announced the first time, the repeat is confirmed by the command alone', async () => {
    const r = await made();
    await r.handler.processLine('/mode auto');
    expect(r.announced).toEqual([modeChangedNotice('auto')]);
    r.announced.length = 0;
    const writeTurn = vi.spyOn(store, 'writeTurn');
    await r.handler.processLine('/mode auto');
    expect(r.announced).toEqual([modeChangedNotice('auto')]);
    expect(writeTurn).not.toHaveBeenCalled();
    expect(modeRecords()).toEqual(['ask→auto']);
  });
});

describe('the line a widening that could not be recorded says', () => {
  it('is the product’s own wording and fits the 54 columns a notification has beside a popup’s way back', async () => {
    const r = await made();
    vi.spyOn(store, 'writeTurn').mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    expect(r.handler.onModeChange('auto')).toBe(false);
    expect(r.announced).toEqual(['Mode not changed: the change could not be recorded.']);
    // Plain ASCII, so its width is its length.
    expect(r.announced[0]?.length).toBeLessThanOrEqual(54);
  });
});
