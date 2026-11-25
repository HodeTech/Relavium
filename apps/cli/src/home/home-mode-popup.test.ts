/**
 * The `/mode` popup in the chat the Home hosts ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6; the 2026-11-25 ruling): the session's own line handler gives the chat a `/mode` member whose "this chat" is the session's one mode
 * setter (recorded in the session, announced on the Home's own channel) and whose "new chats" hands off to the startup-default writer on the
 * HOME's native prompt (`driveHome` wires it with the same prompt flow and publication the Home's own `/mode` uses). A typed bare `/mode` opens
 * the popup over the chat through the Home's routing; nothing is written into the conversation. Real Home, controller, builders, SQLite and
 * Ink, on owned handle-free streams.
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
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';
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
    onboardingTerminalLifecycle: {
      onInput: () => () => undefined,
      isRawMode: () => false,
      setRawMode: () => undefined,
    },
    onboardingPrompter: {
      intro: () => undefined,
      outro: () => undefined,
      note: () => undefined,
      select: () => Promise.resolve(Symbol('cancel')),
      password: () => Promise.resolve(Symbol('cancel')),
      isCancel: (value): value is symbol => typeof value === 'symbol',
    },
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
   * Press `key` on the popup until it leaves `from` (a key on a frame not yet acknowledged, or inside the settle, is dropped by design). The
   * presses are a quiet gap apart (350 ms): a form's `Enter` inside the quiet gap of the key before it is a held key's repeat, which never
   * applies a form (`popup-host.ts`, "A held key never applies a form").
   */
  const pressFrom = async (from: string, key: PopupKey): Promise<void> => {
    // A guarded form (`auto`) waits out the approval's lockout after the answer that reached it, and an `Enter` refused inside it restarts it:
    // the press is a patient one, after the wait, never a retry inside it (the clock is real time here).
    if (from === 'mode:1')
      await new Promise<void>((resolve) => {
        setTimeout(resolve, APPROVAL_LOCKOUT_MS + 200);
      });
    await vi.waitFor(
      () => {
        if (popupStep() === from) mounted.popups?.input('', key);
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
  it('this chat: the popup opens from the Home’s routing, applies through the session’s setter (recorded, announced on the Home’s channel), and writes nothing into the conversation', async () => {
    const f = await fixture();
    try {
      f.command('first message');
      await f.ready();
      const before = f.transcriptNotices();
      f.command('/mode');
      await vi.waitFor(() => expect(f.popupStep()).toBe('mode:0'), WAIT);
      f.press({ end: true }); // → auto
      await f.pressFrom('mode:0', ENTER);
      expect(f.popupStep()).toBe('mode:1');
      await f.pressFrom('mode:1', ENTER);
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

  it('new chats: the popup closes and the startup-default writer asks on the Home’s native prompt, defaulting to No; declining writes nothing, the chat’s mode stays, and the Home’s channel says so', async () => {
    const f = await fixture();
    try {
      f.command('first message');
      await f.ready();
      const before = f.transcriptNotices();
      f.command('/mode');
      await vi.waitFor(() => expect(f.popupStep()).toBe('mode:0'), WAIT);
      f.press({ end: true }); // → auto
      await f.pressFrom('mode:0', ENTER);
      f.press({ downArrow: true }); // → new chats
      await f.pressFrom('mode:1', ENTER);
      expect(f.mounted.popups?.getSnapshot().open).toBe(false);
      const prompt = f.mounted.nativePrompt;
      if (prompt === undefined) throw new Error('the Home has no native prompt');
      await vi.waitFor(() => {
        const snapshot = prompt.getSnapshot();
        expect(snapshot.kind).toBe('select');
        expect(snapshot.message).toBe(
          `${MODE_EFFECT.auto.full} Save auto as the global startup default?`,
        );
        expect(snapshot.options[snapshot.selected]?.value).toBe('no');
      }, WAIT);
      prompt.input('', { ...NONE, return: true });
      await vi.waitFor(() => expect(prompt.getSnapshot().active).toBe(false), WAIT);
      expect(readFileSync(f.configPath, 'utf8')).toBe(CONFIG);
      expect(f.mode()).toBe('ask');
      expect(f.modeRecords()).toEqual([]);
      // F2: what the flow came to, in a few words on the Home's channel, and nothing of it in the conversation.
      await vi.waitFor(() => expect(f.notified).toContain('Startup default unchanged'), WAIT);
      expect(f.transcriptNotices()).toEqual(before);
    } finally {
      await f.close();
    }
    expect(f.error()).toBeUndefined();
  });
});
