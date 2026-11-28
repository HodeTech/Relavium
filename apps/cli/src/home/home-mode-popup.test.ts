/**
 * The `/mode` popup in the chat the Home hosts ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6; MVP-11 unit 8, OD-25: one list, two actions) and on the bare Home: the session's own line handler gives the chat a `/mode` member whose
 * `Enter` is the session's one mode setter (recorded in the session, announced on the Home's own channel) and whose `[s]` hands off to the
 * startup-default writer on the HOME's native prompt, framed as the confirmation popup (`driveHome` wires it with the same prompt flow and publication
 * the Home's own `/mode` uses). On the bare Home the list is the startup default: `Enter` on the saved one says so, `Enter` on another hands it to the
 * same confirmation. A typed bare `/mode` opens the popup through the Home's routing; nothing is written into the conversation. Real Home,
 * controller, builders, SQLite and Ink, on owned handle-free streams.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import type { ChatMode } from '@relavium/shared';
import { render, type Instance, type Key } from 'ink';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { MODE_EFFECT, modeChangedNotice } from '../chat/mode-effects.js';
import { buildChatSession } from '../chat/session-host.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { PopupKey } from '../popups/popup-reducer.js';
import { acknowledgeWrite } from '../process/io.js';
import { RootApp, type RootAppProps } from '../render/tui/home-app.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { driveHome, type HomeDeps } from './drive-home.js';

const ENTER = { return: true } as const;
const WAIT = { timeout: 10_000, interval: 50 } as const;
vi.setConfig({ testTimeout: 60_000 });

/** No key flag set: what the native card is handed with the one that is. */
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

const CONFIG = '[preferences]\ndefault_mode="ask"\ndefault_mode_hint_shown=true\n';

async function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-home-mode-popup-')));
  const home = join(root, 'operator');
  const cwd = join(root, 'workspace');
  const configPath = join(home, '.relavium', 'config.toml');
  mkdirSync(join(home, '.relavium'), { recursive: true });
  mkdirSync(cwd);
  // The startup hint already shown, so no first-chat hint flow holds the keyboard.
  writeFileSync(configPath, CONFIG);
  const client = createClient(':memory:');
  runMigrations(client.db);
  const store = createSessionStore(client.db);
  const input = new OwnedTtyInput();
  const stdout = new OwnedTtyOutput();
  const stderr = new OwnedTtyOutput();
  stdout.columns = 110;
  stdout.rows = 30;
  let props: RootAppProps | undefined;
  let instance: Instance | undefined;
  let id = 0;
  let tick = 0;
  /** Every text the Home's own notification channel was given. */
  const notified: string[] = [];
  const deps: HomeDeps = {
    homeDir: home,
    outputStoreFactory: () => Promise.resolve(undefined),
    io: {
      nativeStdin: input,
      nativeStdout: stdout,
      nativeStderr: stderr,
      stdin: input,
      env: {},
      stdoutIsTty: true,
      stdinIsTty: true,
      writeOut: (text) => {
        stdout.write(text);
      },
      writeErr: (text) => {
        stderr.write(text);
      },
      writeOutAcknowledged: (text) => acknowledgeWrite(stdout, text),
      writeErrAcknowledged: (text) => acknowledgeWrite(stderr, text),
    },
    global: {
      cwd,
      configPath,
      json: false,
      color: false,
      verbosity: 'normal',
      noAltScreen: false,
    },
    keychain: { get: () => null, set: () => undefined, delete: () => false },
    providers: scriptedResolver([textTurn('offline reply')]),
    openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
    now: () => 1_750_000_000_000 + tick++,
    uuid: () => `home-mode-popup-${id++}`,
    buildSession: (buildOptions) => buildChatSession(buildOptions),
    render: (value, renderOptions) => {
      props = value;
      const channel = value.notifications;
      if (channel !== undefined) {
        const notify = channel.notify;
        vi.spyOn(channel, 'notify').mockImplementation((text, from) => {
          notified.push(text);
          notify(text, from);
        });
      }
      instance = render(createElement(RootApp, value), {
        ...renderOptions,
        stdin: input,
        stdout,
        stderr,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: false,
      });
      return instance;
    },
    getSize: () => ({ cols: stdout.columns, rows: stdout.rows }),
    subscribeResize: () => () => undefined,
    subscribeSignals: () => () => undefined,
    subscribeProcessExit: () => () => undefined,
    jobControlLifecycle: {
      supported: false,
      onSuspend: () => () => undefined,
      onContinue: () => () => undefined,
      suspendSelf: () => undefined,
    },
    firstRunSetup: 'off',
    writeControl: () => undefined,
    exit: () => undefined,
  };
  let error: unknown;
  const outcome = driveHome(deps).catch((cause: unknown) => {
    error = cause;
  });
  await vi.waitFor(() => expect(props).toBeDefined());
  if (props === undefined) throw new Error('Home did not mount');
  const mounted = props;
  await instance?.waitUntilRenderFlush();
  const command = (text: string): void => {
    mounted.controller.handlePaste(text);
    mounted.controller.handleKey('', ENTER);
  };
  const ready = async (): Promise<void> => {
    await vi.waitFor(() => {
      const current = mounted.controller.getSnapshot();
      expect(current.mode).toBe('chat');
      expect(current.session).toBeDefined();
      expect(current.submitBusy).toBe(false);
      expect(current.session?.store.getSnapshot().state.status).toBe('idle');
    }, WAIT);
    await instance?.waitUntilRenderFlush();
  };
  const mode = (): ChatMode | undefined =>
    mounted.controller.getSnapshot().session?.store.getSnapshot().mode;
  const popupStep = (): string | undefined => {
    const frame = mounted.popups?.getSnapshot().frame;
    return frame === undefined ? undefined : `${frame.spec.id}:${String(frame.stepIndex)}`;
  };
  /**
   * Press `key` (or type the letter) on the popup until it leaves `from` (a key on a frame not yet acknowledged, or inside the settle, is dropped by
   * design). The presses are a quiet gap apart (350 ms): the clock is real time here.
   */
  const pressFrom = async (from: string, key: PopupKey | string): Promise<void> => {
    await vi.waitFor(
      () => {
        if (popupStep() === from) {
          if (typeof key === 'string') mounted.popups?.input(key, {});
          else mounted.popups?.input('', key);
        }
        expect(popupStep()).not.toBe(from);
      },
      { ...WAIT, interval: 350 },
    );
    await instance?.waitUntilRenderFlush();
  };
  const press = (key: PopupKey): void => {
    mounted.popups?.input('', key);
  };
  const transcriptNotices = (): string[] =>
    mounted.controller
      .getSnapshot()
      .session?.store.getSnapshot()
      .state.transcript.flatMap((entry) => (entry.role === 'notice' ? [entry.text] : [])) ?? [];
  const modeRecords = (): string[] =>
    (
      client.sqlite
        .prepare(
          "SELECT record_from AS f, record_to AS t FROM session_messages WHERE record_kind = 'mode_change' ORDER BY sequence_number",
        )
        .all() as { f: string; t: string }[]
    ).map((row) => `${row.f}→${row.t}`);
  const close = async (): Promise<void> => {
    try {
      if (error === undefined) {
        if (mounted.controller.getSnapshot().session !== undefined) {
          command('/exit');
          await vi.waitFor(() => expect(mounted.controller.getSnapshot().mode).toBe('home'), WAIT);
        }
        if (error === undefined) mounted.controller.handleKey('c', { ctrl: true });
        if (error === undefined) mounted.controller.handleKey('c', { ctrl: true }); // two presses leave: the first arms (ADR-0115 §1)
      }
      await outcome;
    } finally {
      instance?.cleanup();
      input.destroy();
      stdout.destroy();
      stderr.destroy();
      if (client.sqlite.open) client.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
  return {
    mounted,
    configPath,
    notified,
    command,
    ready,
    mode,
    popupStep,
    pressFrom,
    press,
    transcriptNotices,
    modeRecords,
    close,
    error: () => error,
  };
}

describe('/mode in the chat the Home hosts', () => {
  it('this chat: the popup opens from the Home’s routing, one Enter applies through the session’s setter (recorded, announced on the Home’s channel), and nothing is written into the conversation', async () => {
    const f = await fixture();
    try {
      f.command('first message');
      await f.ready();
      const before = f.transcriptNotices();
      f.command('/mode');
      await vi.waitFor(() => expect(f.popupStep()).toBe('mode:0'), WAIT);
      f.press({ end: true }); // → auto
      await f.pressFrom('mode:0', ENTER); // ONE list, ONE key: there is no second screen
      expect(f.mounted.popups?.getSnapshot().open).toBe(false);
      expect(f.mode()).toBe('auto');
      expect(f.modeRecords()).toEqual(['ask→auto']);
      expect(f.notified).toEqual([modeChangedNotice('auto')]);
      expect(f.transcriptNotices()).toEqual(before);
    } finally {
      await f.close();
    }
    expect(f.error()).toBeUndefined();
  });

  it('[s]: the popup closes and the startup-default writer asks on the Home’s native prompt (the Ctrl+Y card, defaulting to No); declining writes nothing, the chat’s mode stays, and the Home’s channel says so', async () => {
    const f = await fixture();
    try {
      f.command('first message');
      await f.ready();
      const before = f.transcriptNotices();
      f.command('/mode');
      await vi.waitFor(() => expect(f.popupStep()).toBe('mode:0'), WAIT);
      f.press({ end: true }); // → auto
      await f.pressFrom('mode:0', 's');
      expect(f.mounted.popups?.getSnapshot().open).toBe(false);
      const prompt = f.mounted.nativePrompt;
      if (prompt === undefined) throw new Error('the Home has no native prompt');
      await vi.waitFor(() => {
        const snapshot = prompt.getSnapshot();
        expect(snapshot.kind).toBe('chord');
        expect(snapshot.message).toBe(MODE_EFFECT.auto.full);
        expect(snapshot.details.slice(0, 2)).toEqual(['', 'Save auto as your startup default?']);
        expect(snapshot.popup).toMatchObject({ origin: 'chat', stepIndex: 1, stepCount: 3 });
        expect(snapshot.details).toContain('This chat stays in ask mode.');
      }, WAIT);
      prompt.input('n', { ...NONE, ctrl: true }); // Ctrl+N: the explicit No, never delayed
      await vi.waitFor(() => expect(prompt.getSnapshot().active).toBe(false), WAIT);
      expect(readFileSync(f.configPath, 'utf8')).toBe(CONFIG);
      expect(f.mode()).toBe('ask');
      expect(f.modeRecords()).toEqual([]);
      // What the flow came to, in a few words on the Home's channel, and nothing of it in the conversation.
      await vi.waitFor(() => expect(f.notified).toContain('Startup default unchanged'), WAIT);
      expect(f.transcriptNotices()).toEqual(before);
    } finally {
      await f.close();
    }
    expect(f.error()).toBeUndefined();
  });
});

describe('/mode on the bare Home', () => {
  it('Enter on the saved startup default closes with ONE notification and writes nothing: no second screen, no card', async () => {
    const f = await fixture();
    try {
      await vi.waitFor(() => expect(f.mounted.controller.getSnapshot().mode).toBe('home'), WAIT);
      f.command('/mode');
      await vi.waitFor(() => expect(f.popupStep()).toBe('mode:0'), WAIT);
      await f.pressFrom('mode:0', ENTER); // opened on the saved default (`ask`): keep
      expect(f.mounted.popups?.getSnapshot().open).toBe(false);
      expect(f.mounted.nativePrompt?.getSnapshot().active).toBe(false);
      expect(f.notified).toEqual(['Startup default is already ask']);
      expect(readFileSync(f.configPath, 'utf8')).toBe(CONFIG);
    } finally {
      await f.close();
    }
    expect(f.error()).toBeUndefined();
  });

  it('Enter on another mode hands it to the confirmation framed from Home; declining writes nothing and says so in one notification, and the composer is free again', async () => {
    const f = await fixture();
    try {
      await vi.waitFor(() => expect(f.mounted.controller.getSnapshot().mode).toBe('home'), WAIT);
      f.command('/mode');
      await vi.waitFor(() => expect(f.popupStep()).toBe('mode:0'), WAIT);
      f.press({ downArrow: true }); // → plan
      await f.pressFrom('mode:0', ENTER);
      const prompt = f.mounted.nativePrompt;
      if (prompt === undefined) throw new Error('the Home has no native prompt');
      await vi.waitFor(() => {
        const snapshot = prompt.getSnapshot();
        expect(snapshot.kind).toBe('chord');
        expect(snapshot.message).toBe('Save plan as your startup default?');
        expect(snapshot.popup).toMatchObject({ origin: 'home', stepIndex: 1, stepCount: 3 });
        expect(snapshot.details).toEqual(
          expect.not.arrayContaining(['This chat stays in ask mode.']),
        );
      }, WAIT);
      expect(f.mounted.controller.getSnapshot().submitBusy, 'the composer is busy meanwhile').toBe(
        true,
      );
      prompt.input('n', { ...NONE, ctrl: true });
      await vi.waitFor(() => expect(prompt.getSnapshot().active).toBe(false), WAIT);
      await vi.waitFor(() => expect(f.notified).toEqual(['Startup default unchanged']), WAIT);
      await vi.waitFor(
        () => expect(f.mounted.controller.getSnapshot().submitBusy).toBe(false),
        WAIT,
      );
      expect(readFileSync(f.configPath, 'utf8')).toBe(CONFIG);
    } finally {
      await f.close();
    }
    expect(f.error()).toBeUndefined();
  });

  it('Esc on the confirmation steps back to the list, opened on the saved default (not the mode asked for); Esc there closes without a word', async () => {
    const f = await fixture();
    try {
      await vi.waitFor(() => expect(f.mounted.controller.getSnapshot().mode).toBe('home'), WAIT);
      f.command('/mode');
      await vi.waitFor(() => expect(f.popupStep()).toBe('mode:0'), WAIT);
      f.press({ downArrow: true });
      await f.pressFrom('mode:0', ENTER);
      const prompt = f.mounted.nativePrompt;
      if (prompt === undefined) throw new Error('the Home has no native prompt');
      await vi.waitFor(() => expect(prompt.getSnapshot().kind).toBe('chord'), WAIT);
      // An `Esc` that arrived before the card's frame was on screen is a cancel (the opening guard's rule), so the step back waits for the frame.
      await vi.waitFor(
        () => expect(() => prompt.assertVisible(prompt.getSnapshot())).not.toThrow(),
        WAIT,
      );
      prompt.input('', { ...NONE, escape: true });
      await vi.waitFor(() => expect(f.popupStep()).toBe('mode:0'), WAIT);
      const frame = f.mounted.popups?.getSnapshot().frame;
      expect(frame?.steps[0]?.selected).toBe(1); // the intro is row 0: the saved default `ask` is row 1 (not `plan`, row 2, the mode asked for)
      await f.pressFrom('mode:0', { escape: true });
      expect(f.notified).toEqual([]);
      expect(readFileSync(f.configPath, 'utf8')).toBe(CONFIG);
    } finally {
      await f.close();
    }
    expect(f.error()).toBeUndefined();
  });
});
