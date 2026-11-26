/**
 * The bare Home's `/mode` is a popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1,
 * §3, §6; MVP-11 Appendix A; the maintainer's observation of 2026-11-26: it opened the old native picker that replaced the whole body). Typed at
 * the landing, it opens the startup-default writer's own flow framed as the `/mode` popup over the Home: the choice, the `Ctrl+Y` confirmation
 * and the Done step that names the file. Nothing is written into the Home's notice; a declined confirmation is one notification; the status
 * line shows the new value however the popup ended. Real Home, controller, channel, config writer and Ink, on owned handle-free streams.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import type { ChatMode } from '@relavium/shared';
import { render, type Instance, type Key } from 'ink';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

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
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-home-mode-bare-')));
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
    uuid: () => `home-mode-bare-${id++}`,
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

/** What the native prompt shows now. */
function nativeOf(f: Awaited<ReturnType<typeof fixture>>) {
  const prompt = f.mounted.nativePrompt;
  if (prompt === undefined) throw new Error('the Home has no native prompt');
  return prompt;
}

/** `/mode` typed at the landing, its first step on screen. */
async function openMode(f: Awaited<ReturnType<typeof fixture>>) {
  f.mounted.controller.handlePaste('/mode');
  f.mounted.controller.handleKey('', ENTER);
  const prompt = nativeOf(f);
  await vi.waitFor(() => {
    const snapshot = prompt.getSnapshot();
    expect(snapshot.kind).toBe('select');
    expect(snapshot.popup).toMatchObject({ title: '/mode', origin: 'home', stepIndex: 0 });
  }, WAIT);
  return prompt;
}

/** Wait out a prompt's guards (the opening settle, a chord card's lockout) with no key pressed, then press `key` once. */
async function patientPress(prompt: ReturnType<typeof nativeOf>, input: string, key: Key) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, APPROVAL_LOCKOUT_MS + 400);
  });
  prompt.input(input, key);
}

describe('/mode on the bare Home', () => {
  it('opens the popup over the landing, not the old body-replacing picker; Ctrl+Y saves, the Done step names the file, and the status line shows the new value', async () => {
    const f = await fixture();
    try {
      const prompt = await openMode(f);
      expect(
        f.mounted.controller.getSnapshot().screen,
        'no screen replaces the body',
      ).toBeUndefined();
      await patientPress(prompt, '', { ...NONE, downArrow: true }); // → plan
      await patientPress(prompt, '', { ...NONE, return: true });
      await vi.waitFor(() => {
        expect(prompt.getSnapshot().kind).toBe('chord');
        expect(prompt.getSnapshot().popup).toMatchObject({ title: '/mode', stepIndex: 1 });
      }, WAIT);
      expect(prompt.getSnapshot().details).toContain('File: ~/.relavium/config.toml');
      expect(readFileSync(f.configPath, 'utf8'), 'nothing is written before the chord').toBe(
        CONFIG,
      );
      await patientPress(prompt, 'y', { ...NONE, ctrl: true });
      await vi.waitFor(() => {
        expect(prompt.getSnapshot().final).toBe('ok');
        expect(prompt.getSnapshot().popup).toMatchObject({ title: '/mode', stepIndex: 2 });
      }, WAIT);
      expect(prompt.getSnapshot().details).toEqual(['~/.relavium/config.toml']);
      expect(readFileSync(f.configPath, 'utf8')).toContain('default_mode = "plan"');
      await patientPress(prompt, '', { ...NONE, escape: true });
      await vi.waitFor(() => expect(prompt.getSnapshot().active).toBe(false), WAIT);
      await vi.waitFor(
        () => expect(f.mounted.controller.getSnapshot().status?.mode).toBe('plan'),
        WAIT,
      );
      expect(
        f.mounted.controller.getSnapshot().notice,
        'nothing in the Home’s notice',
      ).toBeUndefined();
      expect(f.notified, 'the Done step said it: no notification').toEqual([]);
    } finally {
      await f.close();
    }
    expect(f.error()).toBeUndefined();
  });

  it('a declined confirmation writes nothing, says so in one notification, and leaves the Home’s notice empty', async () => {
    const f = await fixture();
    try {
      const prompt = await openMode(f);
      await patientPress(prompt, '', { ...NONE, return: true }); // ask, the default
      await vi.waitFor(() => expect(prompt.getSnapshot().kind).toBe('chord'), WAIT);
      prompt.input('n', { ...NONE, ctrl: true });
      await vi.waitFor(() => expect(prompt.getSnapshot().active).toBe(false), WAIT);
      await vi.waitFor(() => expect(f.notified).toEqual(['Startup default unchanged']), WAIT);
      expect(readFileSync(f.configPath, 'utf8')).toBe(CONFIG);
      expect(f.mounted.controller.getSnapshot().notice).toBeUndefined();
      expect(f.mounted.controller.getSnapshot().status?.mode).toBe('ask');
    } finally {
      await f.close();
    }
    expect(f.error()).toBeUndefined();
  });

  it('a typed argument keeps its answer: no popup, the sentence that says where /mode works', async () => {
    const f = await fixture();
    try {
      f.mounted.controller.handlePaste('/mode plan');
      f.mounted.controller.handleKey('', ENTER);
      await vi.waitFor(
        () =>
          expect(f.mounted.controller.getSnapshot().notice).toBe(
            'No conversation is active. Use /mode to set the startup default.',
          ),
        WAIT,
      );
      expect(nativeOf(f).getSnapshot().active).toBe(false);
      expect(readFileSync(f.configPath, 'utf8')).toBe(CONFIG);
    } finally {
      await f.close();
    }
    expect(f.error()).toBeUndefined();
  });
});
