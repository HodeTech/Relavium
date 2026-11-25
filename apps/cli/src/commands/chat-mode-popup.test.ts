/**
 * The `/mode` popup over the stand-alone chat's real session ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6; the 2026-11-25 ruling: two steps, this chat or new chats). End to end through `chatCommand`: the session's line handler hands an
 * interactive driver the `/mode` member of its settings port; the popup, opened over it on a popup host, applies THIS chat through the one mode
 * setter (recorded before it applies; a widening whose record is lost is refused and says so on the host's channel, a narrowing always
 * applies; the popup itself says nothing and writes nothing into the transcript), and hands NEW chats to the startup-default writer on the
 * chat's own native card (its confirmation that defaults to No, its publication through the visibly admitted frame), which never changes the
 * session's mode. A plain chat has no member and keeps its text. A new file: the pinned counts of `chat.test.ts` belong to the controls.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createSessionStore,
  runMigrations,
  type DbClient,
  type SessionStore,
} from '@relavium/db';
import type { Key } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MODE_EFFECT, MODE_NOT_RECORDED_NOTICE, modeChangedNotice } from '../chat/mode-effects.js';
import { scriptedResolver } from '../chat/test-support.js';
import { manualClock } from '../popups/doctor.test-support.js';
import { createPopupHost } from '../popups/popup-host.js';
import type { PopupKey } from '../popups/popup-reducer.js';
import { openSettingsPopup } from '../popups/settings-session.js';
import { createChordHistory } from '../render/tui/chord-guard.js';
import type { ChatStoreController } from '../render/tui/chat-store.js';
import type { KeychainStore } from '../secrets/keychain.js';
import { captureIo } from '../test-support.js';
import {
  chatCommand,
  type ChatCommandDeps,
  type ChatDriveContext,
  type ChatDriver,
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

/** No key flag set: what a native card is handed with the one that is. */
const NONE: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

let cwd: string;
let home: string;
let client: DbClient;
let store: SessionStore;
const saved = new Map<string, string | undefined>();
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-mode-popup-work-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-mode-popup-home-')));
  // Never the operator's real home: the chat reads its config, and the startup default is written, here.
  for (const key of ['HOME', 'USERPROFILE']) {
    saved.set(key, process.env[key]);
    process.env[key] = home;
  }
  mkdirSync(join(home, '.relavium'), { recursive: true });
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

const configPath = (): string => join(home, '.relavium', 'config.toml');

function deps(drive: ChatDriver, interactive = true): ChatCommandDeps {
  const { io } = captureIo();
  let id = 0;
  return {
    ...inertTerminal,
    keychain,
    io: { ...io, stdoutIsTty: interactive },
    global: { cwd, json: false, color: false, configPath: undefined, verbosity: 'normal' },
    providers: scriptedResolver([]),
    openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
    uuid: () => `mode-popup-${String(id++)}`,
    drive,
  };
}

/** The record rows of the test database, in order, as `from→to`. */
const modeRecords = (): string[] =>
  (
    client.sqlite
      .prepare(
        "SELECT record_from AS f, record_to AS t FROM session_messages WHERE record_kind = 'mode_change' ORDER BY sequence_number",
      )
      .all() as { f: string; t: string }[]
  ).map((row) => `${row.f}→${row.t}`);

const transcriptNotices = (chat: ChatStoreController): string[] =>
  chat
    .getSnapshot()
    .state.transcript.flatMap((entry) => (entry.role === 'notice' ? [entry.text] : []));

const ENTER: PopupKey = { return: true };
const DOWN: PopupKey = { downArrow: true };
const END: PopupKey = { end: true };

/**
 * The `/mode` popup opened over the session's own settings port on a popup host whose frame is on screen and settled, with the session's
 * announcements bound to a list (as a host binds them to its channel).
 */
function modePopupOver(ctx: ChatDriveContext) {
  const settings = ctx.settings;
  if (settings?.mode === undefined) throw new Error('the chat has no /mode member');
  const announced: string[] = [];
  ctx.setAnnouncer?.((text) => announced.push(text));
  const clock = manualClock();
  const host = createPopupHost({
    now: clock.now,
    schedule: clock.schedule,
    history: createChordHistory(),
    placement: 'overlay',
  });
  host.bindVisibility(() => true);
  host.bindOpenGate(() => undefined);
  host.bindPageRows(() => 17);
  host.bindInnerWidth(() => 66);
  expect(openSettingsPopup({ host, port: settings, command: 'mode', origin: 'chat' }).opened).toBe(
    true,
  );
  host.shown(host.getSnapshot());
  clock.advance(600);
  return {
    host,
    announced,
    press: (...keys: PopupKey[]): void => {
      for (const key of keys) host.input('', key);
    },
  };
}

/** The chat's native card, made visible and publishable as the ink host makes it (its frame acknowledged, its flush ready). */
function nativeCard(ctx: ChatDriveContext) {
  const prompt = ctx.modePrompt;
  if (prompt === undefined) throw new Error('the chat has no native card');
  prompt.ui.bindVisibility(() => true);
  prompt.ready(async (publish) => {
    await publish?.();
  });
  const kinds: string[] = [];
  prompt.ui.subscribe(() => {
    const snapshot = prompt.ui.getSnapshot();
    kinds.push(`${snapshot.kind}:${snapshot.message}`);
  });
  return {
    ui: prompt.ui,
    kinds,
    /** The card asking `question`, once it is open. */
    asking: async (question: string) => {
      await vi.waitFor(() => {
        const snapshot = prompt.ui.getSnapshot();
        expect(snapshot.kind).toBe('select');
        expect(snapshot.message).toContain(question);
      });
      return prompt.ui.getSnapshot();
    },
    key: (key: Partial<Key>): void => {
      prompt.ui.input('', { ...NONE, ...key });
    },
  };
}

async function interactiveChat(
  body: (ctx: ChatDriveContext) => Promise<void>,
  interactive = true,
): Promise<void> {
  await chatCommand(
    { agent: undefined },
    deps(async (ctx) => {
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      await body(ctx);
      return { kind: 'exit' };
    }, interactive),
  );
}

describe('the /mode member a chat session hands its driver', () => {
  it('an interactive chat has one: the mode in force from the chat, and the session’s own setter', async () => {
    await interactiveChat(async (ctx) => {
      const mode = ctx.settings?.mode;
      if (mode === undefined) throw new Error('no /mode member');
      expect(mode.current()).toBe('ask');
      expect(mode.apply('plan')).toBe(true);
      expect(ctx.store.getSnapshot().mode).toBe('plan');
      expect(mode.current()).toBe('plan');
      await Promise.resolve();
    });
    expect(modeRecords()).toEqual(['ask→plan']);
  });

  it('a plain chat has none, and its bare /mode prints the modes as before', async () => {
    const { io, err } = captureIo();
    let member: unknown = 'unset';
    await chatCommand(
      { agent: undefined },
      {
        ...deps(async (ctx) => {
          ctx.startSession();
          member = ctx.settings?.mode;
          await ctx.processLine('/mode');
          return { kind: 'exit' };
        }, false),
        io: { ...io, stdoutIsTty: false },
      },
    );
    expect(member).toBeUndefined();
    expect(err()).toContain('mode: ask\n  ask          ');
  });

  it('a bare /mode that reaches an interactive chat’s dispatch lists the modes and opens no native card', async () => {
    await interactiveChat(async (ctx) => {
      const card = nativeCard(ctx);
      await ctx.processLine('/mode');
      expect(transcriptNotices(ctx.store).at(-1)).toMatch(/^mode: ask\n/u);
      expect(card.ui.getSnapshot().active).toBe(false);
      expect(card.kinds).toEqual([]);
    });
  });
});

describe('this chat, through the popup', () => {
  it('applies through the one setter: recorded first, the effect announced by the setter alone, nothing in the transcript', async () => {
    let announced: string[] = [];
    let notices: string[] = [];
    await interactiveChat(async (ctx) => {
      const before = transcriptNotices(ctx.store);
      const popup = modePopupOver(ctx);
      popup.press(END, ENTER, ENTER);
      expect(popup.host.getSnapshot().open).toBe(false);
      expect(ctx.store.getSnapshot().mode).toBe('auto');
      announced = popup.announced;
      notices = transcriptNotices(ctx.store).slice(before.length);
      await Promise.resolve();
    });
    expect(modeRecords()).toEqual(['ask→auto']);
    expect(announced).toEqual([modeChangedNotice('auto')]);
    expect(notices).toEqual([]);
  });

  it('a widening whose record cannot be written: the popup closes, the setter’s refusal is the one word, and the mode stays', async () => {
    let announced: string[] = [];
    await interactiveChat(async (ctx) => {
      const popup = modePopupOver(ctx);
      vi.spyOn(store, 'writeTurn').mockImplementationOnce(() => {
        throw new Error('disk I/O error');
      });
      popup.press(END, ENTER, ENTER);
      expect(popup.host.getSnapshot().open).toBe(false);
      expect(ctx.store.getSnapshot().mode).toBe('ask');
      expect(transcriptNotices(ctx.store).some((text) => /record|mode/iu.test(text))).toBe(false);
      announced = popup.announced;
      await Promise.resolve();
    });
    expect(announced).toEqual([MODE_NOT_RECORDED_NOTICE]);
    expect(modeRecords()).toEqual([]);
  });

  it('a narrowing whose record cannot be written still applies through the popup, and says nothing about the row', async () => {
    let announced: string[] = [];
    await interactiveChat(async (ctx) => {
      expect(ctx.settings?.mode?.apply('auto')).toBe(true);
      const popup = modePopupOver(ctx);
      popup.announced.length = 0;
      vi.spyOn(store, 'writeTurn').mockImplementationOnce(() => {
        throw new Error('disk I/O error');
      });
      // auto (in force, opened on) → plan: ↑ three times.
      popup.press({ upArrow: true }, { upArrow: true }, ENTER, ENTER);
      expect(popup.host.getSnapshot().open).toBe(false);
      expect(ctx.store.getSnapshot().mode).toBe('plan');
      announced = popup.announced;
      await Promise.resolve();
    });
    expect(announced).toEqual([]);
    expect(modeRecords()).toEqual(['ask→auto']);
  });
});

describe('new chats, through the popup: the hand-off to the startup-default writer', () => {
  it('auto asks its confirmation on the chat’s native card, defaulting to No; declining writes nothing and the chat’s mode stays', async () => {
    let card: ReturnType<typeof nativeCard> | undefined;
    await interactiveChat(async (ctx) => {
      card = nativeCard(ctx);
      const popup = modePopupOver(ctx);
      popup.press(END, ENTER, DOWN, ENTER);
      expect(popup.host.getSnapshot().open).toBe(false);
      const question = await card.asking('Save auto as the global startup default?');
      expect(question.message).toBe(
        `${MODE_EFFECT.auto.full} Save auto as the global startup default?`,
      );
      expect(question.options.map((option) => option.value)).toEqual(['yes', 'no']);
      expect(question.options[question.selected]?.value).toBe('no');
      expect(question.note).toBe('Effective startup: ask. Global default: ask.');
      card.key({ return: true });
      await vi.waitFor(() => expect(card?.ui.getSnapshot().active).toBe(false));
      expect(ctx.store.getSnapshot().mode).toBe('ask');
      expect(popup.announced).toEqual([]);
    });
    expect(existsSync(configPath())).toBe(false);
    expect(modeRecords()).toEqual([]);
    // The branch's own selection was never drawn: the only question the card asked was the confirmation.
    expect(card?.kinds.filter((kind) => kind.startsWith('select:'))).toEqual(
      expect.arrayContaining([expect.stringContaining('Save auto as the global startup default?')]),
    );
    expect(card?.kinds.some((kind) => kind.includes('Choose a global startup default'))).toBe(
      false,
    );
  });

  it('confirmed: published through the visibly admitted card, the config written, its words where the /mode flow said them; the chat’s mode stays', async () => {
    let notices: string[] = [];
    await interactiveChat(async (ctx) => {
      const card = nativeCard(ctx);
      const before = transcriptNotices(ctx.store);
      const popup = modePopupOver(ctx);
      popup.press(DOWN, ENTER, DOWN, ENTER); // plan, new chats
      await card.asking('Save plan as the global startup default?');
      card.key({ upArrow: true }); // No → Yes
      card.key({ return: true });
      await vi.waitFor(() => expect(card.ui.getSnapshot().active).toBe(false));
      expect(ctx.store.getSnapshot().mode).toBe('ask');
      notices = transcriptNotices(ctx.store).slice(before.length);
    });
    expect(readFileSync(configPath(), 'utf8')).toContain('default_mode = "plan"');
    expect(notices).toEqual(['Global startup default saved: plan.']);
    expect(modeRecords()).toEqual([]);
  });
});
