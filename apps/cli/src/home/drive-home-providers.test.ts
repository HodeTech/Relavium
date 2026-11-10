import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const baseline = '# retained until actual publication\n[preferences]\ntheme = "dark"\n';
const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup(holdNotice = false, custom = false, projectModel?: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'relavium-home-provider-'));
  paths.push(cwd);
  const path = join(cwd, 'global.toml');
  writeFileSync(path, baseline);
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
  const io: CliIo = {
    nativeStdin: input,
    nativeStdout: output,
    nativeStderr: stderr,
    stdin: Readable.from([]),
    stdinIsTty: true,
    stdoutIsTty: true,
    env: { OPENAI_API_KEY: 'synthetic-env-secret-7139' },
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
  const deps: HomeDeps = {
    invocation: fixture.invocation,
    io,
    buildSession: (options) => {
      built.push({ model: options.chat.defaultModel, provider: options.chat.defaultProvider });
      return Promise.reject(new CliError('invalid_invocation', 'synthetic build stop'));
    },
    global: { cwd, configPath: path, json: false, color: false, verbosity: 'normal' },
    keychain: {
      get: () => null,
      set: () => {
        throw new Error('unexpected key write');
      },
      delete: () => false,
    },
    openSessionStore: (_home, captureClose) => {
      captureClose?.(close);
      return { store: createSessionStore(db.db), db: db.db, close };
    },
    render: (captured) => {
      props = captured;
      captured.nativePrompt?.subscribe(() =>
        frames.push(JSON.stringify(captured.nativePrompt?.getSnapshot())),
      );
      return {
        unmount: rendererExit,
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
    get notices() {
      return notices;
    },
  };
}

describe('driveHome native provider setup', () => {
  it('waits for mounted renderer and paints rewrite notice before granting a standard source and starter default', async () => {
    const f = setup(true);
    const p = await f.ready();
    expect(p.nativePrompt?.getSnapshot().active).toBe(false);
    expect(p.controller.getSnapshot().keyless).toBe(true);
    f.announce(p);
    await vi.waitFor(() =>
      expect(p.nativePrompt?.getSnapshot().message).toContain('OPENAI_API_KEY'),
    );
    p.nativePrompt?.input('\r', { ...key, return: true });
    await vi.waitFor(() => expect(f.notices).toBe(1));
    expect(p.nativePrompt?.getSnapshot().note).toContain('rewrites the global config');
    expect(readFileSync(f.path, 'utf8')).toBe(baseline);
    f.release();
    await vi.waitFor(() => expect(p.nativePrompt?.getSnapshot().active).toBe(false));
    const text = readFileSync(f.path, 'utf8');
    expect(text).toContain('OPENAI_API_KEY');
    expect(text).toContain(KNOWN_PROVIDERS.openai.testModel);
    expect(p.controller.getSnapshot().keyless).toBe(false);
    expect(
      [...f.frames, ...f.outputs, JSON.stringify(p.controller.getSnapshot())].join(' '),
    ).not.toContain('7139');
    await f.end(p);
  });
  it.each([undefined, 'project-model'] as const)(
    'reloads the persisted starter with project precedence (project %s)',
    async (project) => {
      const f = setup(false, false, project);
      const p = await f.ready();
      f.announce(p);
      await vi.waitFor(() =>
        expect(p.nativePrompt?.getSnapshot().message).toContain('OPENAI_API_KEY'),
      );
      p.nativePrompt?.input('\r', { ...key, return: true });
      await vi.waitFor(() => expect(p.nativePrompt?.getSnapshot().active).toBe(false));
      p.controller.handleKey('h', {});
      p.controller.handleKey('i', {});
      p.controller.handleKey('', { return: true });
      await vi.waitFor(() => expect(f.built).toHaveLength(1));
      expect(f.built[0]?.model).toBe(project ?? KNOWN_PROVIDERS.openai.testModel);
      await vi.waitFor(() => expect(p.controller.getSnapshot().mode).toBe('home'));
      await f.end(p);
    },
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
      if (action === 'not-now') {
        p.nativePrompt?.input('', { ...key, downArrow: true });
        p.nativePrompt?.input('', { ...key, downArrow: true });
        p.nativePrompt?.input('\r', { ...key, return: true });
      } else p.nativePrompt?.input('\x1b', { ...key, escape: true });
      await vi.waitFor(() => expect(p.nativePrompt?.getSnapshot().active).toBe(false));
      expect(readFileSync(f.path, 'utf8')).toBe(baseline);
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
    p.nativePrompt?.input('\x1b', { ...key, escape: true });
    await vi.waitFor(() => expect(p.nativePrompt?.getSnapshot().active).toBe(false));
    expect(readFileSync(f.path, 'utf8')).toBe(baseline);
    expect(p.controller.getSnapshot().keyless).toBe(true);
    await f.end(p);
  });
  it('cancellation during the painted notice prevents late publication', async () => {
    const f = setup(true);
    const p = await f.ready();
    f.announce(p);
    await vi.waitFor(() =>
      expect(p.nativePrompt?.getSnapshot().message).toContain('OPENAI_API_KEY'),
    );
    p.nativePrompt?.input('\r', { ...key, return: true });
    await vi.waitFor(() => expect(f.notices).toBe(1));
    p.nativePrompt?.input('\x1b', { ...key, escape: true });
    f.release();
    await vi.waitFor(() => expect(p.nativePrompt?.getSnapshot().active).toBe(false));
    expect(readFileSync(f.path, 'utf8')).toBe(baseline);
    expect(p.controller.getSnapshot().keyless).toBe(true);
    await f.end(p);
  });
});

it('retains the committed key fact when cancellation occurs inside keychain publication', async () => {
  const { runOnboardingWizard } = await import('../onboarding/wizard.js');
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
    const running = runOnboardingWizard({
      initialProvider: 'openai',
      io,
      native: {
        flow: channel.flow,
        signal,
        assertAdmitting: () => signal.throwIfAborted(),
        endpointContext: () => 'official',
      },
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
    });
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
  const { runOnboardingWizard } = await import('../onboarding/wizard.js');
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
    const running = runOnboardingWizard({
      initialProvider: 'openai',
      io,
      native: {
        flow: channel.flow,
        signal,
        assertAdmitting: () => signal.throwIfAborted(),
        endpointContext: () => 'official',
      },
      store: createProviderStore(db.db, { uuid: () => 'id', now: () => 1 }),
      keychain: { get: () => null, set: () => {}, delete: () => false },
      resolver: { resolveProvider: () => undefined, keyFor: () => '' },
      validate: () => Promise.resolve({ ok: true, reason: 'ok', detail: 'ok' }),
      writeDefaultModel: () => {
        channel.flow.cancel();
        return { kind: 'saved', durability: 'confirmed' };
      },
    });
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
  const { runOnboardingWizard } = await import('../onboarding/wizard.js');
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
    const running = runOnboardingWizard({
      initialProvider: 'openai',
      io,
      native: {
        flow: channel.flow,
        signal,
        assertAdmitting: () => signal.throwIfAborted(),
        endpointContext: () => 'official',
      },
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
    });
    channel.ui.paste('credential-7139');
    channel.ui.input('\r', { ...key, return: true });
    await expect(running).rejects.toThrow('Provider setup failed.');
    expect(JSON.stringify(channel.ui.getSnapshot())).not.toContain('7139');
    await channel.flow.end();
  } finally {
    db.sqlite.close();
  }
});
