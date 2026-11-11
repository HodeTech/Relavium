import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { createClient, createProviderStore, createSessionStore, runMigrations } from '@relavium/db';
import { expect, it, vi } from 'vitest';
import { SessionChatLifetime } from '../chat/session-chat-lifetime.js';
import { loadResolvedConfig } from '../config/load.js';
import { runStandaloneProviderSetup } from '../commands/standalone-provider-setup.js';
import { createProviderResolver, validateProviderKey } from '../engine/providers.js';
import { createStandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import type { FetchLike } from '../engine/validated-fetch.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { acknowledgeWrite, type CliIo } from '../process/io.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { captureIo, OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { driveHome } from './drive-home.js';

const oldUrl = 'https://old.example:8443/private-path?secret-query=hidden';
const newUrl = 'https://new.example:9443/other-path?secret-query=hidden';
const secret = 'synthetic-key-no-display';
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
const job = {
  supported: false,
  onSuspend: () => () => {},
  onContinue: () => () => {},
  suspendSelf: () => {},
};
const signals = { onInterrupt: () => () => {}, onTerminationSignal: () => () => {} };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'relavium-endpoint-native-'));
  const dbPath = join(root, 'history.db');
  const client = createClient(dbPath);
  runMigrations(client.db);
  const store = createProviderStore(client.db, { uuid: () => 'provider', now: () => 1 });
  store.upsert({
    name: 'openai',
    displayName: 'OpenAI',
    baseUrl: oldUrl,
    kind: 'openai-compatible',
  });
  const urls: string[] = [];
  const fetch: FetchLike = (input) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'response',
          object: 'chat.completion',
          created: 1,
          model: 'fixture',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
  const env = { OPENAI_API_KEY: secret };
  const keychain = { get: () => null, set: vi.fn(), delete: () => false };
  const resolver = createProviderResolver(env, keychain, {
    providerStore: store,
    validatedFetch: fetch,
  });
  const update = () => {
    const require = createRequire(import.meta.url);
    const moduleUrl = pathToFileURL(require.resolve('@relavium/db')).href;
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { createClient, createProviderStore } from ${JSON.stringify(moduleUrl)};
       const db = createClient(process.argv[1]);
       createProviderStore(db.db, { uuid: () => 'child', now: () => 2 }).upsert({name:'openai',displayName:'OpenAI',baseUrl:process.argv[2],kind:'openai-compatible'});
       db.sqlite.close();`,
        dbPath,
        newUrl,
      ],
      { timeout: 10_000 },
    );
  };
  const fresh = () =>
    createProviderResolver(env, keychain, { providerStore: store, validatedFetch: fetch });
  const close = () => {
    client.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, client, store, urls, env, keychain, resolver, update, fresh, close };
}

it('Home discloses its pinned adapter origin before validation despite another process changing the registry', async () => {
  const f = fixture();
  const invocation = invocationFixture();
  const input = new OwnedTtyInput(),
    output = new OwnedTtyOutput(),
    stderr = new OwnedTtyOutput();
  const io: CliIo = {
    nativeStdin: input,
    nativeStdout: output,
    nativeStderr: stderr,
    stdin: Readable.from([]),
    stdinIsTty: true,
    stdoutIsTty: true,
    env: f.env,
    writeOut: () => {},
    writeErr: () => {},
    writeOutAcknowledged: async () => {},
    writeErrAcknowledged: async () => {},
  };
  let props: RootAppProps | undefined;
  let exitRenderer = () => {};
  const exited = new Promise<void>((resolve) => {
    exitRenderer = resolve;
  });
  const running = driveHome({
    invocation: invocation.invocation,
    io,
    providers: f.resolver,
    buildSession: () => Promise.reject(new Error('unexpected session')),
    global: {
      cwd: f.root,
      configPath: join(f.root, 'config.toml'),
      json: false,
      color: false,
      verbosity: 'normal',
    },
    keychain: f.keychain,
    openSessionStore: (_home, captureClose) => {
      const close = () => {};
      captureClose?.(close);
      return { store: createSessionStore(f.client.db), db: f.client.db, close };
    },
    render: (p) => {
      props = p;
      const ui = p.nativePrompt;
      ui?.bindVisibility((expected) => ui.getSnapshot() === expected);
      return {
        unmount: () => {
          ui?.bindVisibility(undefined);
          exitRenderer();
        },
        waitUntilExit: () => exited,
        waitUntilRenderFlush: async () => {},
      };
    },
    getSize: () => ({ cols: 80, rows: 24 }),
    subscribeResize: () => () => {},
    subscribeSignals: () => () => {},
    subscribeProcessExit: () => () => {},
    jobControlLifecycle: job,
    writeControl: () => {},
    exit: () => {},
  });
  try {
    await vi.waitFor(() => expect(props).toBeDefined());
    const p = props;
    if (p === undefined || p.nativePrompt === undefined) throw new Error('missing Home prompt');
    f.update();
    p.onRendererReady?.(async (publish) => {
      await publish?.();
    });
    await vi.waitFor(() => expect(p.nativePrompt?.getSnapshot().kind).toBe('password'));
    const card = JSON.stringify(p.nativePrompt.getSnapshot());
    expect(card).toContain('https://old.example:8443');
    expect(card).not.toContain('new.example');
    expect(card).not.toContain('private-path');
    expect(card).not.toContain('secret-query');
    expect(card).not.toContain(secret);
    p.nativePrompt.paste(secret);
    p.nativePrompt.input('', { ...key, return: true });
    await vi.waitFor(() => expect(f.urls.length).toBeGreaterThan(0));
    expect(new URL(f.urls[0] ?? '').origin).toBe('https://old.example:8443');
    const freshProvider = f.fresh().resolveProvider('openai');
    if (freshProvider === undefined) throw new Error('missing fresh provider');
    expect((await validateProviderKey(freshProvider, secret, 'gpt-4o-mini')).ok).toBe(true);
    expect(new URL(f.urls.at(-1) ?? '').origin).toBe('https://new.example:9443');
  } finally {
    props?.nativePrompt?.input('', { ...key, escape: true });
    props?.controller.handleKey('c', { ctrl: true });
    await running;
    f.close();
  }
}, 15_000);

it('standalone setup displays the resolver origin before its real validation fetch', async () => {
  const f = fixture();
  const global = {
    cwd: f.root,
    configPath: join(f.root, 'config.toml'),
    json: false,
    color: false,
    noAltScreen: true,
    verbosity: 'normal' as const,
  };
  const loaded = loadResolvedConfig({ cwd: f.root, configPath: global.configPath, home: f.root });
  const policy = createStandardEnvKeyPolicy(loaded.globalConfig?.preferences);
  const invocation = invocationFixture();
  const lifetime = new SessionChatLifetime(invocation.invocation, signals);
  const stdin = new OwnedTtyInput(),
    stdout = new OwnedTtyOutput(),
    stderr = new OwnedTtyOutput();
  const captured = captureIo();
  const io = {
    ...captured.io,
    env: f.env,
    stdin,
    stdoutIsTty: true,
    stdinIsTty: true,
    nativeStdin: stdin,
    nativeStdout: stdout,
    nativeStderr: stderr,
    writeOutAcknowledged: (text: string) => acknowledgeWrite(stdout, text),
  };
  f.update();
  const running = lifetime.execute(async () => {
    await runStandaloneProviderSetup({
      lifetime,
      loaded,
      global,
      io,
      resolver: f.resolver,
      policy,
      store: f.store,
      keychain: f.keychain,
      jobControlLifecycle: job,
    });
    return 0;
  });
  try {
    await vi.waitFor(() => expect(stdout.frames.join('')).toContain('API key'));
    const card = stdout.frames.join('');
    expect(card).toContain('https://old.example:8443');
    expect(card).not.toContain('new.example');
    expect(card).not.toContain('private-path');
    expect(card).not.toContain('secret-query');
    expect(card).not.toContain(secret);
    stdin.push(`${secret}\r`);
    await vi.waitFor(() => expect(f.urls.length).toBeGreaterThan(0));
    expect(new URL(f.urls[0] ?? '').origin).toBe('https://old.example:8443');
  } finally {
    stdin.push('\x1b');
    await running;
    f.close();
  }
}, 15_000);
