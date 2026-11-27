/**
 * The `/mode` popup over the stand-alone chat's real session ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6, dated note of 2026-11-27; MVP-11 unit 8, OD-25: one list, two actions). End to end through `chatCommand`: the session's line handler
 * hands an interactive driver the `/mode` member of its settings port; the popup, opened over it on a popup host, applies THIS chat on `Enter`
 * through the one mode setter (recorded before it applies; a widening whose record is lost is refused and says so on the host's channel, a
 * narrowing always applies; the popup itself writes nothing into the transcript), keeps on the mode in force, and hands the startup default (`[s]`)
 * to the startup-default writer's flow on the chat's own native prompt, framed as the confirmation popup (its `Ctrl+Y` card that defaults to No, its
 * Done step, its publication through the visibly admitted frame), which never changes the session's mode. A plain chat has no member and keeps its
 * text. A new file: the pinned counts of `chat.test.ts` belong to the controls.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { CONFIRM_CREATES_LINE } from '../popups/mode-confirm.js';
import { scriptedResolver } from '../chat/test-support.js';
import { manualClock } from '../popups/doctor.test-support.js';
import { createPopupHost } from '../popups/popup-host.js';
import { currentStep, visibleRows, type PopupKey } from '../popups/popup-reducer.js';
import { openSettingsPopup } from '../popups/settings-session.js';
import { createChordHistory } from '../render/tui/chord-guard.js';
import type { ChatStoreController } from '../render/tui/chat-store.js';
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';
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
  skipped = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => realNow() + skipped);
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
  // What was said; a withdrawal (an empty text with a topic) is no word.
  ctx.setAnnouncer?.((text) => {
    if (text !== '') announced.push(text);
  });
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
  /** The slot acknowledges the frame drawn now and its settle passes (the opening guard's, and a form's own: `popup-host.ts`). */
  const settle = (): void => {
    host.shown(host.getSnapshot());
    // Past the opening guard's settle and the form's lockout after the answer that reached it (a held key's first repeat never applies a form).
    clock.advance(APPROVAL_LOCKOUT_MS + 100);
  };
  settle();
  return {
    host,
    announced,
    settle,
    /** Keys, or letters typed (`'s'`), one per read. */
    press: (...keys: (PopupKey | string)[]): void => {
      for (const key of keys)
        if (typeof key === 'string') host.input(key, {});
        else host.input('', key);
    },
    /** The id of the row highlighted now. */
    highlighted: (): string | undefined => {
      const frame = host.getSnapshot().frame;
      if (frame === undefined) return undefined;
      const { state } = currentStep(frame);
      return visibleRows(state)[state.selected]?.id;
    },
  };
}

/** The process's own monotonic clock, moved on by what the guards need (a chord card's lockout runs from its appearance) instead of waited for. */
const realNow = performance.now.bind(performance);
let skipped = 0;
const GUARDS_PASSED_MS = 6000;

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
    /** The card asking `question`, once it is open and its frame is acknowledged; its guards pass unless `guarded`. */
    asking: async (question: string, guarded = false) => {
      await vi.waitFor(() => {
        const snapshot = prompt.ui.getSnapshot();
        expect(snapshot.kind).toBe('chord');
        expect(snapshot.message).toContain(question);
      });
      prompt.ui.shown(prompt.ui.getSnapshot());
      if (!guarded) skipped += GUARDS_PASSED_MS;
      return prompt.ui.getSnapshot();
    },
    /** The persistent last step, once it is open and its frame is acknowledged. */
    done: async () => {
      await vi.waitFor(() => expect(prompt.ui.getSnapshot().final).toBeDefined());
      prompt.ui.shown(prompt.ui.getSnapshot());
      skipped += GUARDS_PASSED_MS;
      return prompt.ui.getSnapshot();
    },
    key: (key: Partial<Key>, input = ''): void => {
      prompt.ui.input(input, { ...NONE, ...key });
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
      if (mode?.scope !== 'chat') throw new Error('no /mode member of a chat');
      expect(mode.current()).toBe('ask');
      expect(mode.startup()).toBe('ask');
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
      popup.press(END, ENTER); // one list, one key: `auto` is applied to this chat at once
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
      popup.press(END, ENTER);
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
      const member = ctx.settings?.mode;
      if (member?.scope !== 'chat') throw new Error('no /mode member of a chat');
      expect(member.apply('auto')).toBe(true);
      const popup = modePopupOver(ctx);
      popup.announced.length = 0;
      vi.spyOn(store, 'writeTurn').mockImplementationOnce(() => {
        throw new Error('disk I/O error');
      });
      // auto (in force, opened on) → plan: ↑ three times.
      popup.press({ upArrow: true }, { upArrow: true }, ENTER);
      expect(popup.host.getSnapshot().open).toBe(false);
      expect(ctx.store.getSnapshot().mode).toBe('plan');
      announced = popup.announced;
      await Promise.resolve();
    });
    // The mode's own line, as a typed `/mode plan` says it, and not a word of the lost row.
    expect(announced).toEqual([modeChangedNotice('plan')]);
    expect(modeRecords()).toEqual(['ask→auto']);
  });
});

describe('the mode in force: Enter keeps, and nothing is applied, written or asked', () => {
  it('`Enter` on the mode the popup opened on closes it with the one line it always said: no record, no second screen, no native card, no config', async () => {
    let announced: string[] = [];
    let kinds: string[] = [];
    await interactiveChat(async (ctx) => {
      const card = nativeCard(ctx);
      const popup = modePopupOver(ctx);
      popup.press(ENTER);
      expect(popup.host.getSnapshot().open).toBe(false);
      expect(ctx.store.getSnapshot().mode).toBe('ask');
      announced = popup.announced;
      kinds = card.kinds;
      await Promise.resolve();
    });
    expect(announced).toEqual([modeChangedNotice('ask')]);
    // the card never left idle: nothing was asked
    expect(kinds.filter((kind) => !kind.startsWith('idle:'))).toEqual([]);
    expect(modeRecords()).toEqual([]);
    expect(existsSync(configPath())).toBe(false);
  });
});

describe('the startup default the list marks is the one saved NOW', () => {
  it('written after the chat started, it is read when the popup opens: `plan` is marked `startup`, and `[s]` on it saves nothing (it already is the default)', async () => {
    let kinds: string[] = [];
    await interactiveChat(async (ctx) => {
      const card = nativeCard(ctx);
      writeFileSync(configPath(), '[preferences]\ndefault_mode = "plan"\n');
      const member = ctx.settings?.mode;
      if (member?.scope !== 'chat') throw new Error('no /mode member of a chat');
      expect(member.startup()).toBe('plan');
      const popup = modePopupOver(ctx);
      popup.press(DOWN); // plan: the startup default
      expect(popup.highlighted()).toBe('plan');
      popup.press('s');
      // nothing is handed off: the popup stays, and no card asks
      expect(popup.host.getSnapshot().open).toBe(true);
      kinds = card.kinds;
      await Promise.resolve();
    });
    expect(kinds.filter((kind) => !kind.startsWith('idle:'))).toEqual([]);
    expect(readFileSync(configPath(), 'utf8')).toBe('[preferences]\ndefault_mode = "plan"\n');
  });
});

describe('the startup default, through [s]: the hand-off to the startup-default writer, framed as the confirmation popup', () => {
  it('auto asks its confirmation on the chat’s native prompt (the Ctrl+Y card, defaulting to No); declining writes nothing, the chat’s mode stays, and the host’s channel says so', async () => {
    let card: ReturnType<typeof nativeCard> | undefined;
    await interactiveChat(async (ctx) => {
      card = nativeCard(ctx);
      const popup = modePopupOver(ctx);
      popup.press(END, 's'); // auto highlighted, then the startup default
      expect(popup.host.getSnapshot().open).toBe(false);
      const question = await card.asking('Save auto as your startup default?');
      expect(question.message).toBe(`${MODE_EFFECT.auto.full} Save auto as your startup default?`);
      expect(question.options.map((option) => option.label)).toEqual(['Save it', 'Save nothing']);
      // no config file exists yet in this operator home: saving creates it, and says so (it would say it rewrites an existing one)
      expect(question.details).toContain(CONFIRM_CREATES_LINE);
      expect(question.details).toContain('This chat stays in ask mode.');
      expect(question.popup).toMatchObject({ origin: 'chat', stepIndex: 1, stepCount: 3 });
      card.key({ ctrl: true }, 'n'); // Ctrl+N: the explicit No
      await vi.waitFor(() => expect(card?.ui.getSnapshot().active).toBe(false));
      expect(ctx.store.getSnapshot().mode).toBe('ask');
      // what it came to, in a few words on the host's channel (the transcript says nothing)
      await vi.waitFor(() => expect(popup.announced).toEqual(['Startup default unchanged']));
    });
    expect(existsSync(configPath())).toBe(false);
    expect(modeRecords()).toEqual([]);
    // The writer's own selection was never drawn: the only question the card asked was the confirmation.
    expect(card?.kinds.some((kind) => kind.includes('Choose a global startup default'))).toBe(
      false,
    );
  });

  it('confirmed: published through the visibly admitted card, the config written, the Done step names the file, the chat’s mode stays, nothing in the transcript', async () => {
    let notices: string[] = [];
    let announced: string[] = [];
    await interactiveChat(async (ctx) => {
      const card = nativeCard(ctx);
      const before = transcriptNotices(ctx.store);
      const popup = modePopupOver(ctx);
      popup.press(DOWN); // plan
      popup.press('s');
      await card.asking('Save plan as your startup default?');
      card.key({ ctrl: true }, 'y');
      const done = await card.done();
      expect(done.final).toBe('ok');
      expect(done.message).toBe('Startup default: plan · applies to new chats');
      expect(done.details.at(0)).toContain('.relavium/config.toml');
      card.key({ return: true });
      await vi.waitFor(() => expect(card.ui.getSnapshot().active).toBe(false));
      expect(ctx.store.getSnapshot().mode).toBe('ask');
      announced = popup.announced;
      notices = transcriptNotices(ctx.store).slice(before.length);
    });
    expect(readFileSync(configPath(), 'utf8')).toContain('default_mode = "plan"');
    // The Done step said it: no notification repeats it, and the flow's sentence never reaches the transcript (the residue rule, ADR-0148 §6).
    expect(notices).toEqual([]);
    expect(announced).toEqual([]);
    expect(modeRecords()).toEqual([]);
  });

  it('the confirmation says the chat stays in the mode it is in NOW: a chat moved to plan first says plan, not the mode it started in', async () => {
    await interactiveChat(async (ctx) => {
      const card = nativeCard(ctx);
      const member = ctx.settings?.mode;
      if (member?.scope !== 'chat') throw new Error('no /mode member of a chat');
      expect(member.apply('plan')).toBe(true);
      const popup = modePopupOver(ctx);
      popup.press(END, 's'); // auto: the startup default
      const question = await card.asking('Save auto as your startup default?');
      expect(question.details).toContain('This chat stays in plan mode.');
      card.key({ ctrl: true }, 'n');
      await vi.waitFor(() => expect(card.ui.getSnapshot().active).toBe(false));
      expect(ctx.store.getSnapshot().mode).toBe('plan');
    });
  });

  it('`Esc` on the confirmation steps back: the list opens again on the mode chosen, nothing is written, and `Esc` there closes it', async () => {
    await interactiveChat(async (ctx) => {
      const card = nativeCard(ctx);
      const popup = modePopupOver(ctx);
      popup.press(DOWN);
      popup.press('s');
      await card.asking('Save plan as your startup default?');
      card.key({ escape: true });
      await vi.waitFor(() => expect(popup.host.getSnapshot().open).toBe(true));
      expect(popup.highlighted()).toBe('plan');
      popup.settle();
      popup.press({ escape: true });
      expect(popup.host.getSnapshot().open).toBe(false);
      expect(popup.announced).toEqual([]);
      expect(ctx.store.getSnapshot().mode).toBe('ask');
    });
    expect(existsSync(configPath())).toBe(false);
  });
});
