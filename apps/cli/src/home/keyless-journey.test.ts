import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { keychainAccount } from '../secrets/keychain.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { driveHome, type HomeDeps } from './drive-home.js';
import { SessionHomeLifetime } from './session-home-lifetime.js';

/**
 * THE KEYLESS JOURNEY, through the real Home wiring (MVP-11 Step 2.4, ADR-0146 §6, OD-19): a clean home with no key anywhere, the real
 * native setup, the real wizard and the real provider setup coordinator; only the network (the key check), the OS keychain and the chat
 * session are fakes. No network, no real keychain, nothing outside a temporary directory.
 *
 *   keyless Home -> `Esc` skips (the notice is the skip note) -> type `hello` -> `Enter` opens the setup and the draft is still `hello`,
 *   nothing started -> the setup closes -> the draft is still `hello` and unsent -> a key is stored -> `Enter` starts the chat with that
 *   message; and a draft that is a key never lands in the editor or the history.
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
const SKIP_NOTE = 'Setup skipped · /providers connects a provider any time';
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

function journey(
  startSize: { cols: number; rows: number } = { cols: 80, rows: 24 },
  env: Record<string, string | undefined> = {},
  overrides: Partial<HomeDeps> = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), 'relavium-keyless-journey-'));
  paths.push(cwd);
  const path = join(cwd, 'global.toml');
  writeFileSync(path, baseline);
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
      const ui = captured.nativePrompt;
      ui?.bindVisibility((expected) => ui.getSnapshot() === expected);
      ui?.subscribe(() => frames.push(JSON.stringify(ui.getSnapshot())));
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
    path,
    running,
    resizeListeners,
    resize(next: { cols: number; rows: number }): void {
      size = next;
      for (const listener of [...resizeListeners]) listener();
    },
    built,
    frames,
    outputs,
    stored,
    async ready(): Promise<RootAppProps> {
      await settled(() => expect(props).toBeDefined());
      if (props === undefined) throw new Error('missing Home mount');
      // The Home is mounted and painted: the automatic first-run setup may open.
      props.onRendererReady?.(async (publish) => {
        await publish?.();
      });
      return props;
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
  const card = ui(p);
  await settled(() =>
    expect(card.getSnapshot().options.some((option) => option.value === value)).toBe(true),
  );
  const snapshot = card.getSnapshot();
  const at = snapshot.options.findIndex((option) => option.value === value);
  for (
    let step = 0;
    step < (at - snapshot.selected + snapshot.options.length) % snapshot.options.length;
    step += 1
  )
    card.input('', { ...key, downArrow: true });
  card.input('\r', { ...key, return: true });
}
async function skipFirstRun(p: RootAppProps): Promise<void> {
  await settled(() => expect(ui(p).getSnapshot().message).toBe('Which provider?'));
  ui(p).input('', { ...key, escape: true });
  await settled(() => expect(ui(p).getSnapshot().active).toBe(false));
}

describe('the keyless journey', () => {
  it('skip, type, Enter, close, store a key, Enter: the draft survives every step and is sent only by the last Enter', async () => {
    const j = journey();
    const p = await j.ready();
    try {
      // 1. The first-run card opens by itself; `Esc` skips, and the notice says so (it was the first-run sentence).
      await settled(() => expect(ui(p).getSnapshot().active).toBe(true));
      expect(ui(p).getSnapshot().note).toContain('First-run setup');
      await skipFirstRun(p);
      expect(p.controller.getSnapshot().keyless).toBe(true);
      expect(p.controller.getSnapshot().notice).toBe(SKIP_NOTE);
      expect(p.controller.getSnapshot().notice).not.toContain('First-run setup');
      expect(p.controller.getSnapshot().notice).not.toContain('Provider destination');

      // 2. Type a message and press Enter: the explicit setup opens, the draft is still in the prompt, and nothing is started.
      type(p, 'hello');
      p.controller.handleKey('', { return: true });
      await settled(() => expect(ui(p).getSnapshot().message).toBe('Providers'));
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
        'no key yet · Enter to add one',
        'no key yet · Enter to add one',
        'no key yet · Enter to add one',
        'no key yet · Enter to add one',
      ]);

      // 3. Close the setup (Esc): the draft is still `hello`, still unsent.
      ui(p).input('', { ...key, escape: true });
      await settled(() => expect(p.controller.getSnapshot().nativeActionBusy).toBe(false));
      expect(p.controller.getSnapshot().input.text).toBe('hello');
      expect(p.controller.getSnapshot().notice).toBe(SKIP_NOTE);
      expect(p.controller.getSnapshot().keyless).toBe(true);
      expect(j.built).toEqual([]);

      // 4. Enter again; this time store a key (the check is offline and passes).
      p.controller.handleKey('', { return: true });
      await settled(() => expect(ui(p).getSnapshot().message).toBe('Providers'));
      await choose(p, 'anthropic');
      await settled(() => expect(ui(p).getSnapshot().kind).toBe('password'));
      expect(ui(p).getSnapshot().note, 'a first run still says what it is').toContain(
        'Provider destination',
      );
      ui(p).paste(SYNTHETIC_KEY);
      ui(p).input('\r', { ...key, return: true });
      await settled(() => expect(p.controller.getSnapshot().keyless).toBe(false));
      await settled(() => expect(p.controller.getSnapshot().nativeActionBusy).toBe(false));
      expect(j.stored.get(keychainAccount('anthropic'))).toBe(SYNTHETIC_KEY);
      expect(p.controller.getSnapshot().notice).toContain('Verified and stored your Anthropic key');
      expect(readFileSync(j.path, 'utf8')).toContain(KNOWN_PROVIDERS.anthropic.testModel);

      // 5. The key does not send the draft; it is still there, still unsent.
      expect(p.controller.getSnapshot().input.text).toBe('hello');
      expect(j.built, 'a key is not a send').toEqual([]);

      // 6. The last Enter starts the chat with that message (the fake build refuses, so the failure shows whole and the message is back).
      p.controller.handleKey('', { return: true });
      await settled(() => expect(j.built).toHaveLength(1));
      expect(j.built[0]?.model).toBe(KNOWN_PROVIDERS.anthropic.testModel);
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

      // The key is nowhere: not in a frame of the card, not in an output line, not in the controller's state.
      expect(
        [...j.frames, ...j.outputs, JSON.stringify(p.controller.getSnapshot())].join(' '),
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
        await skipFirstRun(p);

        p.controller.handlePaste(keyShaped);
        expect(p.controller.getSnapshot().input.text).toBe(keyShaped);
        p.controller.handleKey('', { return: true });
        await settled(() => expect(ui(p).getSnapshot().message).toBe('Providers'));
        const state = p.controller.getSnapshot();
        expect(state.input.text, 'cleared in the same change that opened the setup').toBe('');
        expect(state.historyEntries).toEqual([]);
        expect(state.notice).toBe(KEY_SHAPED_DRAFT_NOTICE);
        expect(ui(p).getSnapshot().note, 'the card says it where the person is looking').toBe(
          KEY_SHAPED_DRAFT_NOTICE,
        );
        expect(j.built).toEqual([]);

        // Close it: nothing of the key is left to recall.
        ui(p).input('', { ...key, escape: true });
        await settled(() => expect(p.controller.getSnapshot().nativeActionBusy).toBe(false));
        p.controller.handleKey('', { upArrow: true });
        expect(p.controller.getSnapshot().input.text).toBe('');
        expect(
          [...j.frames, ...j.outputs, JSON.stringify(p.controller.getSnapshot())].join(' '),
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

  describe('an environment key is a consent, and a reflex Enter does not grant it (ADR-0146 §6, the interim before the Step 6 guards)', () => {
    it('three Enters, each after its card was drawn, leave the source un-granted and the config as it was', async () => {
      const j = journey(
        { cols: 80, rows: 24 },
        { ANTHROPIC_API_KEY: 'synthetic-env-credential-7731' },
      );
      const p = await j.ready();
      try {
        // The first-run card is the consent; its highlighted row is `Not now`.
        await settled(() => expect(ui(p).getSnapshot().message).toContain('Allow this source?'));
        const first = ui(p).getSnapshot();
        expect(first.options[first.selected]?.value, 'it opens on Not now').toBe('defer');
        ui(p).input('\r', { ...key, return: true }); // Enter 1
        await settled(() => expect(ui(p).getSnapshot().active).toBe(false));
        expect(readFileSync(j.path, 'utf8'), 'nothing was written').toBe(baseline);

        // A message and Enter opens the explicit list, whose first row is Anthropic with the key set.
        type(p, 'hello');
        p.controller.handleKey('', { return: true }); // Enter 2
        await settled(() => expect(ui(p).getSnapshot().message).toBe('Providers'));
        expect(ui(p).getSnapshot().options[0]?.value).toBe('anthropic');
        ui(p).input('\r', { ...key, return: true }); // Enter 3: the row, which asks for the consent again
        await settled(() => expect(ui(p).getSnapshot().message).toContain('Allow this source?'));
        const again = ui(p).getSnapshot();
        expect(again.options[again.selected]?.value, 'again on Not now').toBe('defer');
        expect(readFileSync(j.path, 'utf8'), 'the config is unwritten').toBe(baseline);
        expect(p.controller.getSnapshot().keyless, 'no key became usable').toBe(true);
        ui(p).input('', { ...key, escape: true });
        await settled(() => expect(p.controller.getSnapshot().nativeActionBusy).toBe(false));
        expect(readFileSync(j.path, 'utf8')).toBe(baseline);
        expect(j.built, 'the draft was never sent').toEqual([]);
      } finally {
        await j.end(p);
      }
    });
  });

  it('a Home that closes while the offer waits for room leaves no listener behind', async () => {
    const j = journey({ cols: 70, rows: 20 });
    const p = await j.ready();
    await settled(() => expect(j.resizeListeners.size).toBeGreaterThan(0));
    await j.end(p);
    expect(j.resizeListeners.size).toBe(0);
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
      await settled(() => expect(ui(p).getSnapshot().message).toBe('Providers'));
      ui(p).input('', { ...key, escape: true });
      await settled(() => expect(p.controller.getSnapshot().nativeActionBusy).toBe(false));
      expect(p.controller.getSnapshot().notice).toBe(SKIP_NOTE);
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
      await settled(() => expect(ui(p).getSnapshot().message).toBe('Providers'));
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
