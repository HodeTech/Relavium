import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { createClient, createProviderStore, createSessionStore, runMigrations } from '@relavium/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../process/cli-error.js';
import { KNOWN_PROVIDERS } from '../engine/providers.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { CliIo } from '../process/io.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { driveHome, type HomeDeps } from './drive-home.js';
import { openModelsPopup, settleModelsForm } from './models-popup.test-support.js';
import {
  acknowledgePopupFrames,
  choose as choosePopup,
  closeDone,
  pasteKey,
  POPUP_ANSWER_WAIT_MS,
  sleep,
  STEP_WAIT_MS,
} from './provider-popup.test-support.js';
import { currentStep, visibleRows } from '../popups/popup-reducer.js';

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
                generate: () => Promise.reject(new Error('Offline validation fixture')),
              };
        },
      };
    },
  };
});

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
type PromptUi = NonNullable<RootAppProps['nativePrompt']>;
/**
 * The Home's setup is the `/providers` POPUP (MVP-11 unit 6): its consent opens on `Not now` and `Use it` is GUARDED (an `Enter` on it counts
 * after the lockout that runs from the select's opening), an answer waits out the popup's opening settle, and a setup that wrote ends in a Done
 * step that is closed. `choose` (the support's) highlights a row with the popup's arrows, which stop at the ends, and presses `Enter` once.
 */
const choose = (ui: PromptUi, value: string): Promise<void> => choosePopup(ui, value);
/**
 * `Esc` on the first step of the automatic first run skips it. On this hand-made config the skip is NOT remembered (a skip never rewrites a
 * config that exists, C-F3): the popup closes and the config is byte for byte as it was. Returns the config as the skip left it.
 */
async function skipFirstRun(ui: PromptUi, path: string): Promise<string> {
  const before = readFileSync(path, 'utf8');
  ui.input('', { ...key, escape: true });
  await vi.waitFor(() => expect(ui.getSnapshot().active).toBe(false), { timeout: STEP_WAIT_MS });
  const text = readFileSync(path, 'utf8');
  expect(text).toBe(before);
  return text;
}
/** Past the approval's lockout that runs from the key that opened a flow (`resolveOpeningKey`), and the chord card's dwell. */
const OPENING_LOCKOUT_WAIT_MS = 2_300;
const baseline = '# retained until actual publication\n[preferences]\ntheme = "dark"\n';
const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup(
  holdNotice = false,
  custom = false,
  projectModel?: string,
  manualKeys = false,
  config: 'hand-made' | 'none' = 'hand-made',
) {
  const cwd = mkdtempSync(join(tmpdir(), 'relavium-home-provider-'));
  paths.push(cwd);
  const path = join(cwd, 'global.toml');
  if (config === 'hand-made') writeFileSync(path, baseline);
  if (projectModel !== undefined) {
    mkdirSync(join(cwd, '.relavium'));
    writeFileSync(
      join(cwd, '.relavium', 'project.toml'),
      `[chat]\ndefault_model = "${projectModel}"\n`,
    );
  }
  const db = createClient(':memory:');
  runMigrations(db.db);
  if (custom)
    createProviderStore(db.db, { uuid: () => 'custom-id', now: () => 1 }).upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://custom.example/private/path?x=secret',
      kind: 'openai-compatible',
    });
  const fixture = invocationFixture();
  const input = new OwnedTtyInput(),
    output = new OwnedTtyOutput(),
    stderr = new OwnedTtyOutput();
  const outputs: string[] = [];
  const env: Record<string, string | undefined> = { OPENAI_API_KEY: 'synthetic-env-secret-7139' };
  const io: CliIo = {
    nativeStdin: input,
    nativeStdout: output,
    nativeStderr: stderr,
    stdin: Readable.from([]),
    stdinIsTty: true,
    stdoutIsTty: true,
    env,
    writeOut: (text) => outputs.push(text),
    writeErr: (text) => outputs.push(text),
    writeOutAcknowledged: async () => {},
    writeErrAcknowledged: async () => {},
  };
  let props: RootAppProps | undefined;
  const built: Array<{ model: string | undefined; provider: string | undefined }> = [];
  let rendererExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    rendererExit = resolve;
  });
  const close = vi.fn(() => db.sqlite.close());
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let notices = 0;
  const frames: string[] = [];
  const storedKeys = new Map<string, string>();
  const deps: HomeDeps = {
    invocation: fixture.invocation,
    io,
    buildSession: (options) => {
      built.push({ model: options.chat.defaultModel, provider: options.chat.defaultProvider });
      return Promise.reject(new CliError('invalid_invocation', 'synthetic build stop'));
    },
    global: { cwd, configPath: path, json: false, color: false, verbosity: 'normal' },
    keychain: {
      get: (account) => storedKeys.get(account) ?? null,
      set: (account, value) => {
        if (!manualKeys) throw new Error('unexpected key write');
        storedKeys.set(account, value);
      },
      delete: (account) => storedKeys.delete(account),
    },
    openSessionStore: (_home, captureClose) => {
      captureClose?.(close);
      return { store: createSessionStore(db.db), db: db.db, close };
    },
    render: (captured) => {
      props = captured;
      // No Home root is mounted here, so nothing binds the popup host's gate as RootApp does (the `/models` popup opens on it).
      captured.popups?.bindOpenGate(() => undefined);
      const ui = captured.nativePrompt;
      ui?.bindVisibility((expected) => ui.getSnapshot() === expected);
      // The renderer's acknowledgement of each popup frame, which the popup's opening guard waits for.
      if (ui !== undefined) acknowledgePopupFrames(ui);
      captured.nativePrompt?.subscribe(() =>
        frames.push(JSON.stringify(captured.nativePrompt?.getSnapshot())),
      );
      return {
        unmount: () => {
          captured.nativePrompt?.bindVisibility(undefined);
          rendererExit();
        },
        waitUntilExit: () => exited,
        waitUntilRenderFlush: async () => {},
      };
    },
    getSize: () => ({ cols: 80, rows: 24 }),
    subscribeResize: () => () => {},
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
  };
  const running = driveHome(deps);
  const ready = async (): Promise<RootAppProps> => {
    await vi.waitFor(() => expect(props).toBeDefined());
    if (!props) throw new Error('missing Home mount');
    return props;
  };
  const announce = (p: RootAppProps): void =>
    p.onRendererReady?.(async (publish) => {
      await publish?.();
      notices++;
      if (holdNotice && notices === 1) await held;
    });
  const end = async (p: RootAppProps): Promise<void> => {
    p.controller.handleKey('c', { ctrl: true });
    p.controller.handleKey('c', { ctrl: true }); // two presses leave: the first arms (ADR-0115 §1)
    await running;
    expect(close).toHaveBeenCalledOnce();
  };
  return {
    path,
    running,
    ready,
    announce,
    release,
    end,
    frames,
    outputs,
    built,
    env,
    get notices() {
      return notices;
    },
  };
}

describe('driveHome native provider setup', () => {
  it(
    'wires Home init to the shared native core without changing operator config or building a chat',
    { timeout: 30_000 },
    async () => {
      const f = setup();
      const p = await f.ready();
      const ui = p.nativePrompt;
      if (!ui) throw new Error('Native prompt missing');
      try {
        f.announce(p);
        await vi.waitFor(() => expect(ui.getSnapshot().active).toBe(true));
        const skipped = await skipFirstRun(ui, f.path);
        for (const character of '/init') p.controller.handleKey(character, {});
        p.controller.handleKey('', { return: true });
        await vi.waitFor(() =>
          expect(ui.getSnapshot().message).toContain('Create these project directories'),
        );
        const marker = join(dirname(f.path), '.relavium');
        expect(existsSync(marker)).toBe(false);
        // The confirmation is a `Ctrl+Y` chord (ADR-0148 §3), answered after the lockout that runs from the key that opened the flow.
        expect(ui.getSnapshot().kind).toBe('chord');
        await new Promise<void>((resolve) => {
          setTimeout(resolve, OPENING_LOCKOUT_WAIT_MS);
        });
        ui.input('y', { ...key, ctrl: true });
        // A flow that wrote ends in its Done step, closed by `Esc`; nothing goes to the Home notice.
        await vi.waitFor(() => expect(ui.getSnapshot().final).toBe('ok'), {
          timeout: STEP_WAIT_MS,
        });
        await closeDone(ui, 'esc');
        await vi.waitFor(() => expect(p.controller.getSnapshot().nativeActionBusy).toBe(false));
        expect(readdirSync(marker).sort()).toEqual(['agents', 'workflows']);
        expect(readFileSync(f.path, 'utf8'), '/init writes no operator config').toBe(skipped);
        expect(p.controller.getSnapshot().notice).toBeUndefined();
        expect(f.built).toEqual([]);
      } finally {
        ui.input('', { ...key, escape: true });
        await f.end(p);
      }
    },
  );

  it('keeps the keyless Home model remedy inside the reachable provider screen', async () => {
    const f = setup();
    const p = await f.ready();
    const ui = p.nativePrompt;
    if (!ui) throw new Error('Native setup missing');
    try {
      f.announce(p);
      await choose(ui, 'defer');
      await vi.waitFor(() => expect(ui.getSnapshot().active).toBe(false));
      // The `/models` popup: the models a key would make usable are under the heading that names the Home's remedy, never a shell command.
      const popups = await openModelsPopup(p);
      const frame = popups.getSnapshot().frame;
      const content = frame?.steps[0]?.content;
      if (content?.kind !== 'list') throw new Error('the /models popup listed nothing');
      const words = content.rows.map((row) => `${row.label} ${row.reason ?? ''}`).join('\n');
      expect(words).toContain('/providers');
      expect(words).not.toContain('provider set-key');
      popups.input('', { escape: true });
    } finally {
      ui.input('', { ...key, escape: true });
      p.controller.handleKey('', { escape: true });
      p.controller.handleKey('', { escape: true });
      await f.end(p);
    }
  });

  it.each(['picker', 'setup'] as const)(
    'replaces an invocation-only model after a later successful %s save',
    async (route) => {
      const f = setup(false, false, undefined, true);
      const p = await f.ready();
      const ui = p.nativePrompt;
      if (!ui) throw new Error('Native setup missing');
      try {
        const original = f.path + '.original';
        writeFileSync(original, baseline);
        rmSync(f.path);
        symlinkSync(original, f.path);
        f.announce(p);
        const labelOf = async (value: string): Promise<string | undefined> => {
          await vi.waitFor(() =>
            expect(ui.getSnapshot().options.some((option) => option.value === value)).toBe(true),
          );
          return ui.getSnapshot().options.find((option) => option.value === value)?.label;
        };
        await choose(ui, 'use');
        // Two recovery cards in a row, each saying what it uses (round 2, B6): the source's variable, then the model. Without `Retry saving`
        // the source's is the first row a held `Enter` would answer, so it is guarded too (MVP-11 unit 6).
        expect(await labelOf('once')).toBe('Use OPENAI_API_KEY for this invocation only');
        expect(ui.getSnapshot().options.find((option) => option.value === 'once')?.guarded).toBe(
          true,
        );
        await choose(ui, 'once'); // separate source authority
        expect(await labelOf('once')).toBe(
          `Use ${KNOWN_PROVIDERS.openai.starterModel} for this invocation only`,
        );
        await choose(ui, 'once'); // separate invocation model
        // The popup's Done step says what was allowed and that nothing was saved.
        await vi.waitFor(() => expect(ui.getSnapshot().final).toBe('ok'));
        expect(ui.getSnapshot().details).toContain(
          'Allowed for this invocation only; nothing was saved.',
        );
        await closeDone(ui);
        await vi.waitFor(() => expect(ui.getSnapshot().active).toBe(false));
        rmSync(f.path);
        writeFileSync(f.path, baseline); // operator repairs the target before the next save
        let chosen: string;
        if (route === 'picker') {
          // The `/models` popup on the bare Home: another keyed OpenAI model, its form's `Enter` sets the default of new chats.
          const popups = await openModelsPopup(p);
          const listed = popups.getSnapshot().frame?.steps[0]?.content;
          if (listed?.kind !== 'list') throw new Error('the /models popup listed nothing');
          const row = listed.rows.find(
            (candidate) =>
              candidate.enabled !== false &&
              candidate.section !== true &&
              (candidate.detail ?? '').includes('OpenAI') &&
              candidate.id !== KNOWN_PROVIDERS.openai.starterModel,
          );
          if (!row) throw new Error('No alternate keyed model');
          chosen = row.id;
          for (const char of chosen) popups.input(char, {});
          const frame = popups.getSnapshot().frame;
          if (!frame) throw new Error('the popup closed');
          const { state } = currentStep(frame);
          const index = visibleRows(state).findIndex((candidate) => candidate.id === chosen);
          if (index < 0) throw new Error('Selected model not visible');
          while ((popups.getSnapshot().frame?.steps[0]?.selected ?? index) < index)
            popups.input('', { downArrow: true });
          popups.input('', { return: true });
          await settleModelsForm(popups); // the form is a frame of its own, with its own settle
          popups.input('', { return: true });
          expect(popups.getSnapshot().open).toBe(false);
          await vi.waitFor(() => expect(readFileSync(f.path, 'utf8')).toContain(chosen));
        } else {
          // The old source is gone: this is a new first-usable-source setup,
          // rather than key maintenance that must preserve the current model.
          delete f.env['OPENAI_API_KEY'];
          for (const char of '/providers') p.controller.handleKey(char, {});
          p.controller.handleKey('', { return: true });
          await choose(ui, 'anthropic');
          await pasteKey(ui, 'second-synthetic-provider-key');
          await choose(ui, 'continue'); // explicit save despite the offline validation fixture
          await closeDone(ui);
          await vi.waitFor(() => expect(ui.getSnapshot().active).toBe(false));
          chosen = KNOWN_PROVIDERS.anthropic.starterModel;
        }
        expect(readFileSync(f.path, 'utf8')).toContain(chosen);
        // The popup opens on the default in force now: the model just saved.
        const reopened = await openModelsPopup(p);
        const frame = reopened.getSnapshot().frame;
        if (!frame) throw new Error('the /models popup did not open');
        const { state } = currentStep(frame);
        expect(visibleRows(state)[state.selected]?.id).toBe(chosen);
        reopened.input('', { escape: true });
        for (const char of 'next chat') p.controller.handleKey(char, {});
        p.controller.handleKey('', { return: true });
        await vi.waitFor(() => expect(f.built).toHaveLength(1));
        expect(f.built[0]?.model).toBe(chosen);
        await vi.waitFor(() => expect(p.controller.getSnapshot().mode).toBe('home'));
      } finally {
        ui.input('', { ...key, escape: true });
        p.controller.handleKey('', { escape: true });
        p.controller.handleKey('', { escape: true });
        await f.end(p);
      }
    },
    20_000,
  );

  it('waits for mounted renderer and paints rewrite notice before granting a standard source and starter default', async () => {
    const f = setup(true);
    const p = await f.ready();
    expect(p.nativePrompt?.getSnapshot().active).toBe(false);
    expect(p.controller.getSnapshot().keyless).toBe(true);
    f.announce(p);
    await vi.waitFor(() =>
      expect(p.nativePrompt?.getSnapshot().message).toContain('OPENAI_API_KEY'),
    );
    if (p.nativePrompt === undefined) throw new Error('Native prompt missing');
    await choose(p.nativePrompt, 'use');
    await vi.waitFor(() => expect(f.notices).toBe(1));
    expect(p.nativePrompt.getSnapshot().note).toContain('rewrites the global config');
    expect(readFileSync(f.path, 'utf8')).toBe(baseline);
    f.release();
    await closeDone(p.nativePrompt);
    await vi.waitFor(() => expect(p.nativePrompt?.getSnapshot().active).toBe(false));
    const text = readFileSync(f.path, 'utf8');
    expect(text).toContain('OPENAI_API_KEY');
    expect(text).toContain(KNOWN_PROVIDERS.openai.starterModel);
    expect(p.controller.getSnapshot().keyless).toBe(false);
    expect(
      [...f.frames, ...f.outputs, JSON.stringify(p.controller.getSnapshot())].join(' '),
    ).not.toContain('7139');
    await f.end(p);
  }, 15_000);
  it.each([undefined, 'project-model'] as const)(
    'reloads the persisted starter with project precedence (project %s)',
    async (project) => {
      const f = setup(false, false, project);
      const p = await f.ready();
      f.announce(p);
      await vi.waitFor(() =>
        expect(p.nativePrompt?.getSnapshot().message).toContain('OPENAI_API_KEY'),
      );
      if (p.nativePrompt === undefined) throw new Error('Native prompt missing');
      await choose(p.nativePrompt, 'use');
      await closeDone(p.nativePrompt);
      await vi.waitFor(() => expect(p.nativePrompt?.getSnapshot().active).toBe(false));
      p.controller.handleKey('h', {});
      p.controller.handleKey('i', {});
      p.controller.handleKey('', { return: true });
      await vi.waitFor(() => expect(f.built).toHaveLength(1));
      expect(f.built[0]?.model).toBe(project ?? KNOWN_PROVIDERS.openai.starterModel);
      await vi.waitFor(() => expect(p.controller.getSnapshot().mode).toBe('home'));
      await f.end(p);
    },
    15_000,
  );
  it.each(['not-now', 'cancel'] as const)(
    '%s never grants or persists standard consent',
    async (action) => {
      const f = setup();
      const p = await f.ready();
      f.announce(p);
      await vi.waitFor(() =>
        expect(p.nativePrompt?.getSnapshot().message).toContain('OPENAI_API_KEY'),
      );
      const ui = p.nativePrompt;
      if (ui === undefined) throw new Error('Native prompt missing');
      if (action === 'not-now') {
        // The card opens on Not now, so the bare Enter IS the answer (and is the one an Enter already on its way would give).
        const open = ui.getSnapshot();
        expect(open.options[open.selected]?.value).toBe('defer');
        await sleep(POPUP_ANSWER_WAIT_MS);
        ui.input('\r', { ...key, return: true });
        await vi.waitFor(() => expect(ui.getSnapshot().active).toBe(false));
        expect(readFileSync(f.path, 'utf8'), '`Not now` is no remembered skip').toBe(baseline);
      } else {
        // `Esc` on the first step skips the first run; on this hand-made config the skip is not remembered (C-F3), and the consent is not.
        const skipped = await skipFirstRun(ui, f.path);
        expect(skipped).not.toContain('OPENAI_API_KEY');
      }
      expect(p.controller.getSnapshot().keyless).toBe(true);
      await f.end(p);
    },
  );
  it('refuses a standard key for a custom endpoint and shows the actual safe destination', async () => {
    const f = setup(false, true);
    const p = await f.ready();
    f.announce(p);
    await vi.waitFor(() => expect(p.nativePrompt?.getSnapshot().kind).toBe('password'));
    expect(p.nativePrompt?.getSnapshot().note).toContain('https://custom.example');
    expect(p.nativePrompt?.getSnapshot().note).not.toContain('/private/path');
    expect(p.nativePrompt?.getSnapshot().note).not.toContain('secret');
    if (p.nativePrompt === undefined) throw new Error('Native prompt missing');
    // `Esc` at a key step with no step before it leaves the first run, as a skip (not remembered on this hand-made config); the key was
    // never written.
    const skipped = await skipFirstRun(p.nativePrompt, f.path);
    expect(skipped).not.toContain('OPENAI_API_KEY');
    expect(p.controller.getSnapshot().keyless).toBe(true);
    await f.end(p);
  });
  it('W7 item 5: with no config, the starter default the Home writes after a granted consent paints no rewrite notice (the setup created the file a moment before)', async () => {
    const f = setup(false, false, undefined, false, 'none');
    const p = await f.ready();
    f.announce(p);
    await vi.waitFor(() =>
      expect(p.nativePrompt?.getSnapshot().message).toContain('OPENAI_API_KEY'),
    );
    if (p.nativePrompt === undefined) throw new Error('Native prompt missing');
    await choose(p.nativePrompt, 'use');
    await closeDone(p.nativePrompt);
    await vi.waitFor(() => expect(p.nativePrompt?.getSnapshot().active).toBe(false));
    const text = readFileSync(f.path, 'utf8');
    expect(text).toContain('OPENAI_API_KEY');
    expect(text).toContain(KNOWN_PROVIDERS.openai.starterModel);
    expect(f.frames.join(' ')).not.toContain('rewrites the global config');
    await f.end(p);
  }, 15_000);
  it('cancellation during the painted notice prevents late publication', async () => {
    const f = setup(true);
    const p = await f.ready();
    f.announce(p);
    await vi.waitFor(() =>
      expect(p.nativePrompt?.getSnapshot().message).toContain('OPENAI_API_KEY'),
    );
    if (p.nativePrompt === undefined) throw new Error('Native prompt missing');
    await choose(p.nativePrompt, 'use');
    await vi.waitFor(() => expect(f.notices).toBe(1));
    p.nativePrompt.input('\x1b', { ...key, escape: true });
    f.release();
    await vi.waitFor(() => expect(p.nativePrompt?.getSnapshot().active).toBe(false));
    expect(readFileSync(f.path, 'utf8')).toBe(baseline);
    expect(p.controller.getSnapshot().keyless).toBe(true);
    await f.end(p);
  }, 15_000);
});

it('retains the committed key fact when cancellation occurs inside keychain publication', async () => {
  const { runNativeSetup } = await import('../onboarding/wizard.js');
  const { createNativePromptChannel } = await import('../render/tui/native-prompt-channel.js');
  const { createProviderStore } = await import('@relavium/db');
  const db = createClient(':memory:');
  runMigrations(db.db);
  const channel = createNativePromptChannel();
  const signal = channel.flow.begin();
  const stored: string[] = [];
  const io: CliIo = {
    stdin: Readable.from([]),
    stdinIsTty: true,
    stdoutIsTty: true,
    env: {},
    writeOut: () => {},
    writeErr: () => {},
    writeOutAcknowledged: async () => {},
    writeErrAcknowledged: async () => {},
  };
  try {
    const running = runNativeSetup(
      {
        initialProvider: 'openai',
        io,
        store: createProviderStore(db.db, { uuid: () => 'id', now: () => 1 }),
        keychain: {
          get: () => null,
          set: (_account, value) => {
            stored.push(value);
            channel.flow.cancel();
          },
          delete: () => false,
        },
        resolver: { resolveProvider: () => undefined, keyFor: () => '' },
        validate: () => Promise.resolve({ ok: true, reason: 'ok', detail: 'ok' }),
        writeDefaultModel: () => {
          throw new Error('must not run');
        },
      },
      {
        flow: channel.flow,
        signal,
        assertAdmitting: () => signal.throwIfAborted(),
        endpointContext: () => 'official',
      },
    );
    channel.ui.paste('credential-7139');
    channel.ui.input('\r', { ...key, return: true });
    await running;
    expect(stored).toEqual(['credential-7139']);
    expect(db.sqlite.prepare('SELECT * FROM llm_providers').all()).toHaveLength(0);
    expect(channel.ui.getSnapshot().note).toContain('stored');
    expect(channel.ui.getSnapshot().note).not.toContain('7139');
    await channel.flow.end();
  } finally {
    db.sqlite.close();
  }
});

it('retains the saved default fact when cancellation follows publication', async () => {
  const { runNativeSetup } = await import('../onboarding/wizard.js');
  const { createNativePromptChannel } = await import('../render/tui/native-prompt-channel.js');
  const { createProviderStore } = await import('@relavium/db');
  const db = createClient(':memory:');
  runMigrations(db.db);
  const channel = createNativePromptChannel();
  const signal = channel.flow.begin();
  const io: CliIo = {
    stdin: Readable.from([]),
    stdinIsTty: true,
    stdoutIsTty: true,
    env: {},
    writeOut: () => {},
    writeErr: () => {},
    writeOutAcknowledged: async () => {},
    writeErrAcknowledged: async () => {},
  };
  try {
    const running = runNativeSetup(
      {
        initialProvider: 'openai',
        io,
        store: createProviderStore(db.db, { uuid: () => 'id', now: () => 1 }),
        keychain: { get: () => null, set: () => {}, delete: () => false },
        resolver: { resolveProvider: () => undefined, keyFor: () => '' },
        validate: () => Promise.resolve({ ok: true, reason: 'ok', detail: 'ok' }),
        writeDefaultModel: () => {
          channel.flow.cancel();
          return { kind: 'saved', durability: 'confirmed' };
        },
      },
      {
        flow: channel.flow,
        signal,
        assertAdmitting: () => signal.throwIfAborted(),
        endpointContext: () => 'official',
      },
    );
    channel.ui.paste('credential-7139');
    channel.ui.input('\r', { ...key, return: true });
    await running;
    expect(channel.ui.getSnapshot().note).toContain('Your default model is');
    expect(channel.ui.getSnapshot().note).not.toContain('7139');
    await channel.flow.end();
  } finally {
    db.sqlite.close();
  }
});

it('does not swallow an unrelated storage failure merely because cancellation also arrived', async () => {
  const { runNativeSetup } = await import('../onboarding/wizard.js');
  const { createNativePromptChannel } = await import('../render/tui/native-prompt-channel.js');
  const { createProviderStore } = await import('@relavium/db');
  const db = createClient(':memory:');
  runMigrations(db.db);
  const channel = createNativePromptChannel();
  const signal = channel.flow.begin();
  const io: CliIo = {
    stdin: Readable.from([]),
    stdinIsTty: true,
    stdoutIsTty: true,
    env: {},
    writeOut: () => {},
    writeErr: () => {},
    writeOutAcknowledged: async () => {},
    writeErrAcknowledged: async () => {},
  };
  try {
    const running = runNativeSetup(
      {
        initialProvider: 'openai',
        io,
        store: createProviderStore(db.db, { uuid: () => 'id', now: () => 1 }),
        keychain: {
          get: () => null,
          set: () => {
            channel.flow.cancel();
            throw new Error('credential-7139');
          },
          delete: () => false,
        },
        resolver: { resolveProvider: () => undefined, keyFor: () => '' },
        validate: () => Promise.resolve({ ok: true, reason: 'ok', detail: 'ok' }),
        writeDefaultModel: () => undefined,
      },
      {
        flow: channel.flow,
        signal,
        assertAdmitting: () => signal.throwIfAborted(),
        endpointContext: () => 'official',
      },
    );
    channel.ui.paste('credential-7139');
    channel.ui.input('\r', { ...key, return: true });
    await expect(running).rejects.toThrow('Provider setup failed.');
    expect(JSON.stringify(channel.ui.getSnapshot())).not.toContain('7139');
    await channel.flow.end();
  } finally {
    db.sqlite.close();
  }
});
