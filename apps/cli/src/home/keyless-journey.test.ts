import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KNOWN_PROVIDERS } from '../engine/providers.js';
import { CliError } from '../process/cli-error.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { CliIo } from '../process/io.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { KEY_SHAPED_DRAFT_NOTICE } from '../render/tui/home-controller.js';
import {
  CONFIG_REWRITTEN_LINE,
  SETUP_SKIP_NOT_SAVED,
  setupClosedNotice,
} from '../onboarding/setup-notes.js';
import { keychainAccount } from '../secrets/keychain.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { driveHome, type HomeDeps } from './drive-home.js';
import { FIRST_RUN_POPUP_TITLE } from './provider-setup.js';
import {
  acknowledgePopupFrames,
  choose as choosePopup,
  closeDone,
  pasteKey,
  POPUP_ANSWER_WAIT_MS,
  sleep,
} from './provider-popup.test-support.js';
import { SessionHomeLifetime } from './session-home-lifetime.js';

/**
 * THE KEYLESS JOURNEY, through the real Home wiring (MVP-11 Step 2.4 and unit 6, ADR-0146 §6, OD-19): a clean home with no key anywhere,
 * the real native setup drawn as the `/providers` POPUP (the renderer's part, acknowledging each frame, played by the mock), the real wizard
 * and the real provider setup coordinator; only the network (the key check), the OS keychain and the chat session are fakes. No network, no
 * real keychain, nothing outside a temporary directory.
 *
 *   keyless Home -> `Esc` skips the first run (remembered in the global config, behind its rewrite disclosure on a hand-made one) -> type
 *   `hello` -> `Enter` opens the popup and the draft is still `hello`, nothing started -> the popup closes -> the draft is still `hello` and
 *   unsent -> a key is stored and the Done step names it -> `Enter` starts the chat with that message; and a draft that is a key never lands
 *   in the editor or the history. Nothing the setup says is a Home notice: it is the popup's Done step or one notification.
 */

// The key check never leaves the machine: the adapter the wizard probes answers at once.
vi.mock('../engine/providers.js', async (original) => {
  const actual = await original<typeof import('../engine/providers.js')>();
  return {
    ...actual,
    createProviderResolver: (...args: Parameters<typeof actual.createProviderResolver>) => {
      const resolver = actual.createProviderResolver(...args);
      return {
        ...resolver,
        resolveProvider: (id: Parameters<typeof resolver.keyFor>[0]) => {
          const adapter = resolver.resolveProvider(id);
          return adapter === undefined
            ? undefined
            : {
                ...adapter,
                listModels: () => Promise.resolve([]),
                generate: () => Promise.resolve({}),
              };
        },
      };
    },
  };
});

/** A journey step that has to finish: the default `vi.waitFor` gives it one second, which a loaded gate run does not always leave (the siblings use 5 s). */
const WAIT_MS = 5000;
const settled = <T>(callback: () => T | Promise<T>): Promise<T> =>
  vi.waitFor(callback, { timeout: WAIT_MS });

const key = {
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
const SKIP_NOTE = 'Setup skipped · /providers connects a provider anytime';
const SYNTHETIC_KEY = 'synthetic-journey-credential-5521';
/** A draft shaped like a key of each of the four providers (each long enough to be one). */
const KEY_SHAPED_DRAFTS = [
  ['Anthropic', 'sk-ant-api03-journeyfakefakefakefake0123456789'],
  ['OpenAI', 'sk-proj-journeyfakefakefakefake0123456789'],
  ['DeepSeek', 'sk-journeyfake0123456789abcdef01234567'],
  ['Gemini', 'AIzajourneyfakefakefakefake0123456789_-x'],
] as const;
const baseline = '# a clean home\n[preferences]\ntheme = "dark"\n';
const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * The global config a journey starts with: a hand-made one (the default), none at all, a symbolic link (which no writer follows), or one that
 * already remembers a skipped first run.
 */
type StartingConfig = 'hand-made' | 'none' | 'symlink' | 'skipped';

function journey(
  startSize: { cols: number; rows: number } = { cols: 80, rows: 24 },
  env: Record<string, string | undefined> = {},
  overrides: Partial<HomeDeps> = {},
  config: StartingConfig | { readonly reuse: string } = 'hand-made',
) {
  const cwd =
    typeof config === 'object'
      ? config.reuse
      : mkdtempSync(join(tmpdir(), 'relavium-keyless-journey-'));
  if (typeof config !== 'object') paths.push(cwd);
  const path = join(cwd, 'global.toml');
  if (config === 'hand-made') writeFileSync(path, baseline);
  if (config === 'skipped') writeFileSync(path, '[preferences]\nfirst_run_setup_skipped = true\n');
  if (config === 'symlink') {
    writeFileSync(join(cwd, 'real.toml'), baseline);
    symlinkSync(join(cwd, 'real.toml'), path);
  }
  const db = createClient(':memory:');
  runMigrations(db.db);
  const fixture = invocationFixture();
  const input = new OwnedTtyInput();
  const output = new OwnedTtyOutput();
  const stderr = new OwnedTtyOutput();
  const outputs: string[] = [];
  const io: CliIo = {
    nativeStdin: input,
    nativeStdout: output,
    nativeStderr: stderr,
    stdin: Readable.from([]),
    stdinIsTty: true,
    stdoutIsTty: true,
    env, // a clean environment by default: no key of any kind
    writeOut: (text) => outputs.push(text),
    writeErr: (text) => outputs.push(text),
    writeOutAcknowledged: async () => {},
    writeErrAcknowledged: async () => {},
  };
  let props: RootAppProps | undefined;
  let rendererExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    rendererExit = resolve;
  });
  const close = vi.fn(() => db.sqlite.close());
  const stored = new Map<string, string>();
  const frames: string[] = [];
  /** Every notification the Home's channel showed, in order (the mock mounts no root, so nothing holds the channel). */
  const notified: string[] = [];
  let size = startSize;
  const resizeListeners = new Set<() => void>();
  const built: Array<{ model: string | undefined; provider: string | undefined }> = [];
  const deps: HomeDeps = {
    invocation: fixture.invocation,
    io,
    buildSession: (options) => {
      built.push({ model: options.chat.defaultModel, provider: options.chat.defaultProvider });
      return Promise.reject(new CliError('invalid_invocation', 'synthetic build stop'));
    },
    global: { cwd, configPath: path, json: false, color: false, verbosity: 'normal' },
    keychain: {
      get: (account) => stored.get(account) ?? null,
      set: (account, value) => void stored.set(account, value),
      delete: (account) => stored.delete(account),
    },
    openSessionStore: (_home, captureClose) => {
      captureClose?.(close);
      return { store: createSessionStore(db.db), db: db.db, close };
    },
    render: (captured) => {
      props = captured;
      // No Home root is mounted here, so nothing binds the popup host's gate as RootApp does (the `/doctor` popup opens on it).
      captured.popups?.bindOpenGate(() => undefined);
      const ui = captured.nativePrompt;
      ui?.bindVisibility((expected) => ui.getSnapshot() === expected);
      ui?.subscribe(() => frames.push(JSON.stringify(ui.getSnapshot())));
      // The renderer's acknowledgement of each popup frame (measured and flushed), which the popup's opening guard waits for.
      if (ui !== undefined) acknowledgePopupFrames(ui);
      const channel = captured.notifications;
      channel?.subscribe(() => {
        const text = channel.getSnapshot().current?.text;
        if (text !== undefined && notified.at(-1) !== text) notified.push(text);
      });
      return {
        unmount: () => {
          ui?.bindVisibility(undefined);
          rendererExit();
        },
        waitUntilExit: () => exited,
        waitUntilRenderFlush: async () => {},
      };
    },
    getSize: () => size,
    subscribeResize: (onResize) => {
      resizeListeners.add(onResize);
      return () => resizeListeners.delete(onResize);
    },
    subscribeSignals: () => () => {},
    subscribeProcessExit: () => () => {},
    jobControlLifecycle: {
      supported: false,
      onSuspend: () => () => {},
      onContinue: () => () => {},
      suspendSelf: () => {},
    },
    writeControl: () => {},
    exit: () => {},
    ...overrides,
  };
  const running = driveHome(deps);
  return {
    cwd,
    path,
    running,
    notified,
    resizeListeners,
    resize(next: { cols: number; rows: number }): void {
      size = next;
      for (const listener of [...resizeListeners]) listener();
    },
    built,
    frames,
    outputs,
    stored,
    /** The Home's props once it is mounted, before its renderer has reported ready (no first-run offer was made yet). */
    async mounted(): Promise<RootAppProps> {
      await settled(() => expect(props).toBeDefined());
      if (props === undefined) throw new Error('missing Home mount');
      return props;
    },
    async ready(): Promise<RootAppProps> {
      const mounted = await this.mounted();
      // The Home is mounted and painted: the automatic first-run setup may open.
      mounted.onRendererReady?.(async (publish) => {
        await publish?.();
      });
      return mounted;
    },
    async end(p: RootAppProps): Promise<void> {
      p.controller.handleKey('c', { ctrl: true });
      p.controller.handleKey('c', { ctrl: true }); // two presses leave: the first arms (ADR-0115 §1)
      await running;
    },
  };
}

function ui(p: RootAppProps): NonNullable<RootAppProps['nativePrompt']> {
  if (p.nativePrompt === undefined) throw new Error('native prompt missing');
  return p.nativePrompt;
}
const type = (p: RootAppProps, text: string): void => {
  for (const ch of text) p.controller.handleKey(ch, {});
};
async function choose(p: RootAppProps, value: string): Promise<void> {
  await choosePopup(ui(p), value);
}
/**
 * The first-run popup is on screen: titled `Connect a provider` (O7), its top edge saying `first run` (OB-5a), on its first step, `Which
 * provider?`; that step is opened to step back, so its `Esc` is the skip and `Ctrl+C` closes.
 */
async function untilFirstRun(p: RootAppProps): Promise<void> {
  await settled(() => expect(ui(p).getSnapshot().message).toBe('Which provider?'));
  expect(ui(p).getSnapshot().popup).toMatchObject({
    title: FIRST_RUN_POPUP_TITLE,
    origin: 'first-run',
    stepIndex: 0,
    stepCount: 3,
    stepNames: ['Provider', 'Key', 'Done'],
    exitLabel: 'close',
  });
  expect(ui(p).getSnapshot().escape).toBe('back');
}
/**
 * `Esc` on the first step skips the first run. On a hand-made config (the journey's default) the skip is NOT remembered (C-F3: a skip never
 * rewrites a config that exists): the popup closes, the config is byte for byte as it was, and one notification says it opens again.
 */
async function skipFirstRun(p: RootAppProps, notified: readonly string[]): Promise<void> {
  await untilFirstRun(p);
  ui(p).input('', { ...key, escape: true });
  await settled(() => expect(ui(p).getSnapshot().active).toBe(false));
  await settled(() => expect(notified).toEqual([SETUP_SKIP_NOT_SAVED]));
  await settled(() => expect(p.controller.getSnapshot().nativeActionBusy).toBe(false));
}

describe('the keyless journey', () => {
  it('skip, type, Enter, close, store a key, Enter: the draft survives every step and is sent only by the last Enter', async () => {
    const j = journey();
    const p = await j.ready();
    try {
      // 1. The first-run popup opens by itself; `Esc` skips. The global config is a hand-made one, so the skip is not remembered: the file is
      // left as it was, and one notification says so. Nothing is a Home notice.
      await settled(() => expect(ui(p).getSnapshot().active).toBe(true));
      expect(ui(p).getSnapshot().note).toContain('First-run setup');
      await skipFirstRun(p, j.notified);
      expect(p.controller.getSnapshot().keyless).toBe(true);
      expect(p.controller.getSnapshot().notice).toBeUndefined();
      expect(readFileSync(j.path, 'utf8')).toBe(baseline);

      // 2. Type a message and press Enter: the explicit setup opens, the draft is still in the prompt, and nothing is started.
      type(p, 'hello');
      p.controller.handleKey('', { return: true });
      await settled(() => expect(ui(p).getSnapshot().message).toBe('Which provider?'));
      expect(ui(p).getSnapshot().popup?.exitLabel, 'an explicit /providers closes').toBe('close');
      expect(p.controller.getSnapshot().nativeActionBusy).toBe(true);
      expect(p.controller.getSnapshot().input.text).toBe('hello');
      expect(p.controller.getSnapshot().historyEntries).toEqual([]);
      expect(j.built, 'no chat was built for a message nobody can send').toEqual([]);
      // The list's hints say what Enter does, by display name, and never point at the list they are in.
      expect(
        ui(p)
          .getSnapshot()
          .options.map((option) => option.hint),
      ).toEqual([
        'no key yet · Enter add one',
        'no key yet · Enter add one',
        'no key yet · Enter add one',
        'no key yet · Enter add one',
      ]);

      // 3. Close the setup (Esc): the draft is still `hello`, still unsent; a setup the person opened says nothing when it is closed (O13).
      ui(p).input('', { ...key, escape: true });
      await settled(() => expect(p.controller.getSnapshot().nativeActionBusy).toBe(false));
      expect(p.controller.getSnapshot().input.text).toBe('hello');
      expect(p.controller.getSnapshot().notice).toBeUndefined();
      await sleep(POPUP_ANSWER_WAIT_MS);
      expect(j.notified, 'no second notification').toEqual([SETUP_SKIP_NOT_SAVED]);
      expect(p.controller.getSnapshot().keyless).toBe(true);
      expect(j.built).toEqual([]);

      // 4. Enter again; this time store a key (the check is offline and passes). The key step says what happens to the key before it is
      // pasted, `Esc` there is a step back, and the Done step names the provider and the model and the next step, closed by `Enter`.
      p.controller.handleKey('', { return: true });
      await settled(() => expect(ui(p).getSnapshot().message).toBe('Which provider?'));
      await choose(p, 'anthropic');
      await settled(() => expect(ui(p).getSnapshot().kind).toBe('password'));
      expect(ui(p).getSnapshot().note).toBe(
        'Stored in your OS keychain, never on disk. Sent only to https://api.anthropic.com, once, to check it.',
      );
      expect(ui(p).getSnapshot().popup).toMatchObject({ stepIndex: 1, exitLabel: 'close' });
      expect(ui(p).getSnapshot().escape, 'Esc steps back from the key').toBe('back');
      await pasteKey(ui(p), SYNTHETIC_KEY);
      await settled(() => expect(ui(p).getSnapshot().final).toBe('ok'));
      expect(ui(p).getSnapshot().message).toBe(
        `Connected · Anthropic · ${KNOWN_PROVIDERS.anthropic.starterModel}`,
      );
      // The starter default rewrote the journey's hand-made global config: the Done step keeps that fact, once, before the next step (CO-1).
      expect(ui(p).getSnapshot().details).toEqual([
        CONFIG_REWRITTEN_LINE,
        'Type a message to start, or /init to set up this folder',
      ]);
      expect(ui(p).getSnapshot().popup?.stepIndex, 'the Done step is the rail’s last').toBe(2);
      await closeDone(ui(p), 'enter');
      await settled(() => expect(p.controller.getSnapshot().keyless).toBe(false));
      await settled(() => expect(p.controller.getSnapshot().nativeActionBusy).toBe(false));
      expect(j.stored.get(keychainAccount('anthropic'))).toBe(SYNTHETIC_KEY);
      expect(p.controller.getSnapshot().notice, 'the result is the Done step, not a notice').toBe(
        undefined,
      );
      expect(readFileSync(j.path, 'utf8')).toContain(KNOWN_PROVIDERS.anthropic.starterModel);

      // 5. The key does not send the draft; it is still there, still unsent.
      expect(p.controller.getSnapshot().input.text).toBe('hello');
      expect(j.built, 'a key is not a send').toEqual([]);

      // 6. The last Enter starts the chat with that message (the fake build refuses, so the failure shows whole and the message is back).
      p.controller.handleKey('', { return: true });
      await settled(() => expect(j.built).toHaveLength(1));
      expect(j.built[0]?.model).toBe(KNOWN_PROVIDERS.anthropic.starterModel);
      expect(j.built[0]?.provider).toBe('anthropic');
      await settled(() => expect(p.controller.getSnapshot().mode).toBe('home'));
      expect(p.controller.getSnapshot().notice?.startsWith('Couldn’t start the chat: ')).toBe(true);
      expect(
        p.controller.getSnapshot().input.text,
        'the message is back after a failed build',
      ).toBe('hello');
      expect(p.controller.getSnapshot().historyEntries, 'recorded when it was sent').toEqual([
        'hello',
      ]);

      // The key is nowhere: not in a frame of the card, not in an output line, not in the controller's state, not in a notification.
      expect(
        [...j.frames, ...j.outputs, ...j.notified, JSON.stringify(p.controller.getSnapshot())].join(
          ' ',
        ),
      ).not.toContain('5521');
    } finally {
      await j.end(p);
    }
  });

  it.each(KEY_SHAPED_DRAFTS)(
    'a %s key typed as a draft never lands in the editor or the history, and the setup that opens says why',
    async (_provider, keyShaped) => {
      const j = journey();
      const p = await j.ready();
      try {
        await settled(() => expect(ui(p).getSnapshot().active).toBe(true));
        await skipFirstRun(p, j.notified);

        p.controller.handlePaste(keyShaped);
        expect(p.controller.getSnapshot().input.text).toBe(keyShaped);
        p.controller.handleKey('', { return: true });
        await settled(() => expect(ui(p).getSnapshot().message).toBe('Which provider?'));
        const state = p.controller.getSnapshot();
        expect(state.input.text, 'cleared in the same change that opened the setup').toBe('');
        expect(state.historyEntries).toEqual([]);
        // One notification says why; nothing of it, or of the draft, is a Home notice or carried into the popup (MVP-11 unit 6).
        expect(state.notice).toBeUndefined();
        expect(ui(p).getSnapshot().note).not.toContain('API key');
        await settled(() => expect(j.notified).toContain(KEY_SHAPED_DRAFT_NOTICE));
        expect(j.built).toEqual([]);

        // Close it: nothing of the key is left to recall.
        ui(p).input('', { ...key, escape: true });
        await settled(() => expect(p.controller.getSnapshot().nativeActionBusy).toBe(false));
        p.controller.handleKey('', { upArrow: true });
        expect(p.controller.getSnapshot().input.text).toBe('');
        expect(
          [
            ...j.frames,
            ...j.outputs,
            ...j.notified,
            JSON.stringify(p.controller.getSnapshot()),
          ].join(' '),
        ).not.toContain('journeyfake');
      } finally {
        await j.end(p);
      }
    },
  );

  it('below the 80x24 floor the first-run offer waits, unspent: Esc there spends nothing, and growing the terminal opens it', async () => {
    const j = journey({ cols: 70, rows: 20 });
    const p = await j.ready();
    try {
      // The card is not opened over a message that says "Esc cancels"; the Home shows its own resize line.
      await settled(() => expect(j.resizeListeners.size).toBeGreaterThan(0));
      expect(ui(p).getSnapshot().active).toBe(false);
      // Whatever `Esc` does here, it does not spend the offer.
      p.controller.handleKey('', { escape: true });
      ui(p).input('', { ...key, escape: true });
      expect(p.controller.getSnapshot().keyless).toBe(true);
      expect(p.controller.getSnapshot().notice).toBeUndefined();
      // Still too small after a resize: it keeps waiting.
      j.resize({ cols: 79, rows: 24 });
      expect(ui(p).getSnapshot().active).toBe(false);
      // Room: the offer opens, once, and the wait is over.
      j.resize({ cols: 80, rows: 24 });
      await settled(() => expect(ui(p).getSnapshot().message).toBe('Which provider?'));
      expect(j.resizeListeners.size, 'the wait ended with the offer').toBe(0);
      j.resize({ cols: 100, rows: 30 });
      expect(ui(p).getSnapshot().message, 'not opened a second time').toBe('Which provider?');
    } finally {
      ui(p).input('', { ...key, escape: true });
      await j.end(p);
    }
  });

  describe('the offer that waited for room opens over an empty Home and nothing else (ADR-0146 §6)', () => {
    it('does not open over a draft: the terminal grows, the composer holds text, the offer stays unspent until the next resize finds it empty', async () => {
      const j = journey({ cols: 70, rows: 20 });
      const p = await j.ready();
      try {
        await settled(() => expect(j.resizeListeners.size).toBeGreaterThan(0));
        type(p, 'hello');
        j.resize({ cols: 80, rows: 24 });
        expect(ui(p).getSnapshot().active, 'a popup does not land on a draft').toBe(false);
        expect(p.controller.getSnapshot().input.text, 'the draft is untouched').toBe('hello');
        expect(j.resizeListeners.size, 'the offer is unspent: it still waits').toBeGreaterThan(0);
        for (let i = 0; i < 5; i += 1) p.controller.handleKey('', { backspace: true });
        j.resize({ cols: 81, rows: 24 });
        await settled(() => expect(ui(p).getSnapshot().message).toBe('Which provider?'));
        expect(j.resizeListeners.size, 'spent now').toBe(0);
      } finally {
        ui(p).input('', { ...key, escape: true });
        await j.end(p);
      }
    });

    it('does not open over the palette: it waits, and opens at the first resize after the palette is closed', async () => {
      const j = journey({ cols: 70, rows: 20 });
      const p = await j.ready();
      try {
        await settled(() => expect(j.resizeListeners.size).toBeGreaterThan(0));
        p.controller.handleKey('/', {});
        expect(p.controller.getSnapshot().palette, 'the palette is open').toBeDefined();
        j.resize({ cols: 80, rows: 24 });
        expect(ui(p).getSnapshot().active).toBe(false);
        expect(j.resizeListeners.size).toBeGreaterThan(0);
        p.controller.handleKey('', { escape: true });
        expect(p.controller.getSnapshot().palette).toBeUndefined();
        j.resize({ cols: 81, rows: 24 });
        await settled(() => expect(ui(p).getSnapshot().message).toBe('Which provider?'));
      } finally {
        ui(p).input('', { ...key, escape: true });
        await j.end(p);
      }
    });

    it('does not open over a screen (the help sheet), either', async () => {
      const j = journey({ cols: 70, rows: 20 });
      const p = await j.ready();
      try {
        await settled(() => expect(j.resizeListeners.size).toBeGreaterThan(0));
        type(p, '/help');
        p.controller.handleKey('', { return: true }); // the palette is open over the typed word: Enter runs its row
        expect(p.controller.getSnapshot().screen?.kind, 'the help sheet is in front').toBe('help');
        j.resize({ cols: 80, rows: 24 });
        expect(ui(p).getSnapshot().active).toBe(false);
        expect(j.resizeListeners.size, 'still waiting').toBeGreaterThan(0);
      } finally {
        p.controller.handleKey('', { escape: true }); // the screen first: Ctrl+C would close it, not leave
        await j.end(p);
      }
    });
  });

  describe('an environment key is a consent, and a reflex Enter does not grant it (ADR-0146 §6; the guarded row, MVP-11 unit 6)', () => {
    it('three Enters, each after its card was drawn, leave the source un-granted and the config as it was', async () => {
      const j = journey(
        { cols: 80, rows: 24 },
        { ANTHROPIC_API_KEY: 'synthetic-env-credential-7731' },
      );
      const p = await j.ready();
      try {
        // The first-run popup is the consent (it names the variable, the provider, the model and where it is saved); its highlighted row is
        // `Not now`, and `Use it` is the guarded first row.
        await settled(() =>
          expect(ui(p).getSnapshot().message).toBe(
            `ANTHROPIC_API_KEY is set for Anthropic. Use it, with ${KNOWN_PROVIDERS.anthropic.starterModel} as your default model? Saved to your global config; the variable stays yours.`,
          ),
        );
        const first = ui(p).getSnapshot();
        expect(first.options.map((option) => option.label)).toEqual([
          'Use it',
          'Enter a different key',
          'Not now',
        ]);
        expect(first.options[0]?.guarded).toBe(true);
        expect(first.options[first.selected]?.value, 'it opens on Not now').toBe('defer');
        await sleep(POPUP_ANSWER_WAIT_MS);
        ui(p).input('\r', { ...key, return: true }); // Enter 1
        await settled(() => expect(ui(p).getSnapshot().active).toBe(false));
        expect(readFileSync(j.path, 'utf8'), 'nothing was written').toBe(baseline);

        // A message and Enter opens the explicit list, whose first row is Anthropic with the key set.
        type(p, 'hello');
        p.controller.handleKey('', { return: true }); // Enter 2
        await settled(() => expect(ui(p).getSnapshot().message).toBe('Which provider?'));
        expect(ui(p).getSnapshot().options[0]?.value).toBe('anthropic');
        await sleep(POPUP_ANSWER_WAIT_MS);
        ui(p).input('\r', { ...key, return: true }); // Enter 3: the row, which asks for the consent again
        await settled(() =>
          expect(ui(p).getSnapshot().message).toContain('ANTHROPIC_API_KEY is set for Anthropic.'),
        );
        const again = ui(p).getSnapshot();
        expect(again.options[again.selected]?.value, 'again on Not now').toBe('defer');
        expect(readFileSync(j.path, 'utf8'), 'the config is unwritten').toBe(baseline);
        expect(p.controller.getSnapshot().keyless, 'no key became usable').toBe(true);
        expect(again.escape, 'reached from the list, Esc steps back to it').toBe('back');
        ui(p).input('', { ...key, escape: true });
        await settled(() => expect(ui(p).getSnapshot().message).toBe('Which provider?'));
        ui(p).input('', { ...key, escape: true });
        await settled(() => expect(p.controller.getSnapshot().nativeActionBusy).toBe(false));
        expect(readFileSync(j.path, 'utf8')).toBe(baseline);
        expect(j.built, 'the draft was never sent').toEqual([]);
      } finally {
        await j.end(p);
      }
    }, 15_000);
  });

  it('a Home that closes while the offer waits for room leaves no listener behind', async () => {
    const j = journey({ cols: 70, rows: 20 });
    const p = await j.ready();
    await settled(() => expect(j.resizeListeners.size).toBeGreaterThan(0));
    await j.end(p);
    expect(j.resizeListeners.size).toBe(0);
  });

  it('D03 a renderer that reports ready again while the offer already waits for room does not start a second wait: one resize listener, one offer', async () => {
    const j = journey({ cols: 70, rows: 20 });
    const p = await j.ready();
    try {
      await settled(() => expect(j.resizeListeners.size).toBe(1));
      await j.ready(); // the renderer reports ready a second time (a remount): the offer is already waiting
      expect(j.resizeListeners.size, 'still the one wait').toBe(1);
      j.resize({ cols: 80, rows: 24 });
      await settled(() => expect(ui(p).getSnapshot().message).toBe('Which provider?'));
      expect(j.resizeListeners.size, 'the wait ended with the offer').toBe(0);
    } finally {
      ui(p).input('', { ...key, escape: true });
      await j.end(p);
    }
  });

  it('D02 a renderer that first reports ready after the Home began to close offers nothing: below the floor it starts no wait, and no listener is left behind', async () => {
    const j = journey({ cols: 70, rows: 20 });
    const p = await j.mounted(); // no ready report yet: no offer was made, no wait was started
    await j.end(p);
    expect(j.resizeListeners.size, 'nothing waits').toBe(0);
    await j.ready(); // the late ready of a renderer of a Home whose input is sealed
    expect(j.resizeListeners.size, 'a closing Home starts no wait for room').toBe(0);
    expect(ui(p).getSnapshot().active, 'and no popup opens').toBe(false);
  });
});

describe('the offer that waited for room is spent by what happened meanwhile (round 2)', () => {
  it('K4: a provider setup the person opened at the small size spends it, so growing the terminal opens nothing', async () => {
    const j = journey({ cols: 70, rows: 20 });
    const p = await j.ready();
    try {
      await settled(() => expect(j.resizeListeners.size).toBeGreaterThan(0));
      // The person opens the setup by hand (the palette's `/providers`) and closes it with `Esc`: a provider run, finished.
      p.controller.handleKey('/', {});
      type(p, 'providers');
      p.controller.handleKey('', { return: true });
      await settled(() => expect(ui(p).getSnapshot().message).toBe('Which provider?'));
      ui(p).input('', { ...key, escape: true });
      await settled(() => expect(p.controller.getSnapshot().nativeActionBusy).toBe(false));
      expect(p.controller.getSnapshot().notice).toBeUndefined();
      await sleep(POPUP_ANSWER_WAIT_MS);
      expect(j.notified, 'a setup the person opened says nothing when it is closed (O13)').toEqual(
        [],
      );
      expect(
        existsSync(j.path) ? readFileSync(j.path, 'utf8') : '',
        'an explicit close is no remembered skip',
      ).not.toContain('first_run_setup_skipped');
      // Room, and the Home is clear: the first-run offer must not open over a person who has already been to the setup.
      j.resize({ cols: 80, rows: 24 });
      expect(ui(p).getSnapshot().active, 'no card opened by itself').toBe(false);
      expect(j.resizeListeners.size, 'and the wait is over: the offer is spent').toBe(0);
      j.resize({ cols: 100, rows: 30 });
      expect(ui(p).getSnapshot().active).toBe(false);
    } finally {
      await j.end(p);
    }
  });

  it('K4: the same for the explicit list opened with Enter on an empty prompt', async () => {
    const j = journey({ cols: 70, rows: 20 });
    const p = await j.ready();
    try {
      await settled(() => expect(j.resizeListeners.size).toBeGreaterThan(0));
      p.controller.handleKey('', { return: true }); // keyless: the empty Enter opens the explicit setup
      await settled(() => expect(ui(p).getSnapshot().message).toBe('Which provider?'));
      ui(p).input('', { ...key, escape: true });
      await settled(() => expect(p.controller.getSnapshot().nativeActionBusy).toBe(false));
      j.resize({ cols: 80, rows: 24 });
      expect(ui(p).getSnapshot().active).toBe(false);
      expect(j.resizeListeners.size).toBe(0);
    } finally {
      await j.end(p);
    }
  });

  it('Q3: a chat that is building in front of the Home is not a clear Home: the offer waits, unspent', async () => {
    const stored = new Map([[keychainAccount('anthropic'), 'synthetic-journey-credential-5521']]);
    let failBuild: () => void = () => undefined;
    const j = journey(
      { cols: 70, rows: 20 },
      {},
      {
        keychain: {
          get: (account) => stored.get(account) ?? null,
          set: (account, value) => void stored.set(account, value),
          delete: (account) => stored.delete(account),
        },
        // A build that has not finished: the Home is in `loading` until the test fails it, as a build can.
        buildSession: () =>
          new Promise((_resolve, reject) => {
            failBuild = () => reject(new CliError('invalid_invocation', 'synthetic build stop'));
          }),
      },
    );
    const p = await j.ready();
    try {
      await settled(() => expect(j.resizeListeners.size).toBeGreaterThan(0));
      expect(p.controller.getSnapshot().keyless, 'a keyed Home').toBe(false);
      type(p, 'hello');
      p.controller.handleKey('', { return: true });
      await settled(() => expect(p.controller.getSnapshot().mode).toBe('loading'));
      expect(p.controller.getSnapshot().input.text, 'the editor is empty while it builds').toBe('');
      j.resize({ cols: 80, rows: 24 });
      expect(ui(p).getSnapshot().active).toBe(false);
      expect(
        j.resizeListeners.size,
        'the build is in front: the offer waited, unspent',
      ).toBeGreaterThan(0);
    } finally {
      failBuild();
      await settled(() => expect(p.controller.getSnapshot().mode).toBe('home'));
      await j.end(p);
    }
  });

  it('B4: an owner that stopped admitting before the Home sealed its input is the setup failing, not an exception out of the resize', async () => {
    let work: { stop: () => void } | undefined;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Preserve the original method and restore its actual receiver with call() below.
    const execute = SessionHomeLifetime.prototype.execute;
    // The Home's own work owner is the one that refuses admission here; the Home has not sealed its input yet.
    const spy = vi.spyOn(SessionHomeLifetime.prototype, 'execute').mockImplementation(function (
      this: SessionHomeLifetime,
      body,
    ) {
      work = this.surface.work;
      return execute.call(this, body);
    });
    const j = journey({ cols: 70, rows: 20 });
    try {
      await j.ready();
      await settled(() => expect(j.resizeListeners.size).toBeGreaterThan(0));
      expect(work, 'the owner of the Home was captured').toBeDefined();
      work?.stop();
      expect(
        () => j.resize({ cols: 80, rows: 24 }),
        'no exception out of the terminal emit',
      ).not.toThrow();
      await expect(j.running, 'the Home ends, as it does when its owner stops').resolves.toBeTypeOf(
        'number',
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the first-run skip is remembered beyond the process (ADR-0146 §6, ruled 2026-11-24; MVP-11 unit 6)', () => {
  it('a person with no config: Esc skips, the file is written with no card, one notification says so, and a second Home over the same home opens nothing by itself', async () => {
    const first = journey({ cols: 80, rows: 24 }, {}, {}, 'none');
    const p = await first.ready();
    try {
      await untilFirstRun(p);
      ui(p).input('', { ...key, escape: true });
      // The automatic offer is not a native action of the controller: what closes it is the setup ending, which says so in its notification.
      await settled(() => expect(first.notified).toEqual([SKIP_NOTE]));
      expect(ui(p).getSnapshot().active, 'no Done card: there was nothing to disclose').toBe(false);
      expect(p.controller.getSnapshot().notice).toBeUndefined();
      expect(readFileSync(first.path, 'utf8')).toBe(
        '[preferences]\nfirst_run_setup_skipped = true\n',
      );
    } finally {
      await first.end(p);
    }
    // The next launch, over the same home and config: the Home is clear and keyless, and the offer does not open by itself.
    const second = journey({ cols: 80, rows: 24 }, {}, {}, { reuse: first.cwd });
    const q = await second.ready();
    try {
      await sleep(POPUP_ANSWER_WAIT_MS);
      expect(q.controller.getSnapshot().keyless).toBe(true);
      expect(ui(q).getSnapshot().active, 'the remembered skip holds the offer back').toBe(false);
      // `Enter` on the empty prompt still opens it: the skip holds back only the offer that opens by itself.
      q.controller.handleKey('', { return: true });
      await settled(() => expect(ui(q).getSnapshot().message).toBe('Which provider?'));
      ui(q).input('', { ...key, escape: true });
      await settled(() => expect(q.controller.getSnapshot().nativeActionBusy).toBe(false));
    } finally {
      await second.end(q);
    }
  });

  it('a skip whose write fails (the config is a symbolic link) is one notification, writes nothing, and the offer returns next launch', async () => {
    const first = journey({ cols: 80, rows: 24 }, {}, {}, 'symlink');
    const p = await first.ready();
    try {
      await untilFirstRun(p);
      ui(p).input('', { ...key, escape: true });
      await settled(() =>
        expect(first.notified).toEqual(['Setup skipped · not saved, it opens again next launch']),
      );
      expect(
        readFileSync(join(first.cwd, 'real.toml'), 'utf8'),
        'the link’s target is untouched',
      ).toBe(baseline);
    } finally {
      await first.end(p);
    }
    const second = journey({ cols: 80, rows: 24 }, {}, {}, { reuse: first.cwd });
    const q = await second.ready();
    try {
      await untilFirstRun(q);
    } finally {
      ui(q).input('', { ...key, escape: true });
      await settled(() => expect(q.controller.getSnapshot().nativeActionBusy).toBe(false));
      await second.end(q);
    }
  });

  it('an embedding that turns the first run off (`firstRunSetup: off`) gets no popup by itself; the keyless `Enter` still opens the setup', async () => {
    const j = journey({ cols: 80, rows: 24 }, {}, { firstRunSetup: 'off' }, 'none');
    const p = await j.ready();
    try {
      await sleep(POPUP_ANSWER_WAIT_MS);
      expect(ui(p).getSnapshot().active, 'nothing opened by itself').toBe(false);
      p.controller.handleKey('', { return: true });
      await settled(() => expect(ui(p).getSnapshot().message).toBe('Which provider?'));
      ui(p).input('', { ...key, escape: true });
      await settled(() => expect(p.controller.getSnapshot().nativeActionBusy).toBe(false));
    } finally {
      await j.end(p);
    }
  });

  it('C-F3: a hand-made config is never rewritten by a skip: it stays byte for byte, one notification says so, and the next launch offers the setup again', async () => {
    const first = journey({ cols: 80, rows: 24 }, {}, {}, 'hand-made');
    const p = await first.ready();
    try {
      await skipFirstRun(p, first.notified);
      expect(readFileSync(first.path, 'utf8')).toBe(baseline);
    } finally {
      await first.end(p);
    }
    const second = journey({ cols: 80, rows: 24 }, {}, {}, { reuse: first.cwd });
    const q = await second.ready();
    try {
      await untilFirstRun(q);
    } finally {
      ui(q).input('c', { ...key, ctrl: true });
      await settled(() => expect(ui(q).getSnapshot().active).toBe(false));
      await second.end(q);
    }
    expect(readFileSync(first.path, 'utf8'), 'and the Ctrl+C there wrote nothing either').toBe(
      baseline,
    );
  });

  it('`Ctrl+C` at the key step is a cancel, not a remembered skip; `Esc` there steps back to the provider list first', async () => {
    const j = journey({ cols: 80, rows: 24 }, {}, {}, 'none');
    const p = await j.ready();
    try {
      await untilFirstRun(p);
      await choose(p, 'openai');
      await settled(() => expect(ui(p).getSnapshot().kind).toBe('password'));
      ui(p).paste('synthetic-held-secret-8841');
      ui(p).input('', { ...key, escape: true }); // a step back: the key is cleared, the list is asked again
      await settled(() => expect(ui(p).getSnapshot().message).toBe('Which provider?'));
      expect(ui(p).getSnapshot().popup?.stepIndex, 'the rail rewound to Provider').toBe(0);
      expect(ui(p).getSnapshot().note).toContain('First-run setup');
      await choose(p, 'openai');
      await settled(() => expect(ui(p).getSnapshot().kind).toBe('password'));
      expect(ui(p).getSnapshot().display, 'nothing of the old key survived the step back').toBe('');
      ui(p).input('c', { ...key, ctrl: true });
      await settled(() => expect(j.notified).toEqual([setupClosedNotice('home')]));
      expect(existsSync(j.path), 'a cancel writes no remembered skip').toBe(false);
      expect([...j.frames, ...j.notified].join(' ')).not.toContain('8841');
    } finally {
      await j.end(p);
    }
  });

  it('the Done step after a stored key closes with `Esc` as well as `Enter`, and the draft stays unsent', async () => {
    const j = journey({ cols: 80, rows: 24 }, {}, {}, 'none');
    const p = await j.ready();
    try {
      await untilFirstRun(p);
      await choose(p, 'anthropic');
      await pasteKey(ui(p), SYNTHETIC_KEY);
      await settled(() => expect(ui(p).getSnapshot().final).toBe('ok'));
      await closeDone(ui(p), 'esc');
      await settled(() => expect(p.controller.getSnapshot().keyless).toBe(false));
      expect(ui(p).getSnapshot().active).toBe(false);
      expect(j.stored.get(keychainAccount('anthropic'))).toBe(SYNTHETIC_KEY);
      expect(readFileSync(j.path, 'utf8')).toContain('default_model = "claude-haiku-5-5"');
      expect(readFileSync(j.path, 'utf8'), 'a stored key is no skip').not.toContain(
        'first_run_setup_skipped',
      );
      expect(j.notified, 'the Done step said it').toEqual([]);
    } finally {
      await j.end(p);
    }
  });
});

describe('the doctor’s remedy hands off to /providers (maintainer, 2026-11-25; MVP-11 unit 6)', () => {
  it('Enter on the failing provider-keys row closes the doctor and opens the setup popup on the Home; Esc there returns to the Home', async () => {
    // A home that already skipped the first run: nothing opens by itself, so the doctor is what the person opens.
    const j = journey({ cols: 80, rows: 24 }, {}, {}, 'skipped');
    const p = await j.ready();
    const popups = p.popups;
    if (popups === undefined) throw new Error('the Home was rendered without a popup host');
    try {
      await sleep(POPUP_ANSWER_WAIT_MS);
      expect(ui(p).getSnapshot().active, 'the remembered skip held the offer back').toBe(false);
      popups.bindVisibility(() => true);
      popups.bindPageRows(() => 17);
      popups.bindInnerWidth(() => 66);
      const seen = async (): Promise<void> => {
        popups.shown(popups.getSnapshot());
        await sleep(POPUP_ANSWER_WAIT_MS);
      };
      p.controller.handlePaste('/doctor');
      p.controller.handleKey('', { return: true });
      await settled(() => expect(popups.getSnapshot().frame?.spec.id).toBe('doctor'));
      await settled(() =>
        expect(JSON.stringify(popups.getSnapshot().frame)).toContain('no provider has a key'),
      );
      await seen();
      popups.input('', { end: true });
      await seen();
      popups.input('', { return: true });
      await settled(() =>
        expect(JSON.stringify(popups.getSnapshot().frame)).toContain(
          'Press Enter to open /providers',
        ),
      );
      await seen();
      popups.input('', { return: true });
      // The doctor is closed, and the setup is open on the Home through its own gate: the explicit `/providers`.
      await settled(() => expect(popups.getSnapshot().open).toBe(false));
      await settled(() => expect(ui(p).getSnapshot().message).toBe('Which provider?'));
      expect(ui(p).getSnapshot().popup?.title).toBe('/providers');
      expect(ui(p).getSnapshot().popup?.exitLabel).toBe('close');
      expect(p.controller.getSnapshot().nativeActionBusy).toBe(true);
      ui(p).input('', { ...key, escape: true });
      await settled(() => expect(p.controller.getSnapshot().nativeActionBusy).toBe(false));
      expect(ui(p).getSnapshot().active).toBe(false);
      expect(popups.getSnapshot().open, 'Esc returns to the Home, not to the doctor').toBe(false);
      expect(p.controller.getSnapshot().notice).toBeUndefined();
      await sleep(POPUP_ANSWER_WAIT_MS);
      expect(j.notified, 'the hand-off says nothing when it is closed (O13)').toEqual([]);
    } finally {
      await j.end(p);
    }
  }, 20_000);
});
