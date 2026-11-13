import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { buildChatSession, buildResumedChatSession } from '../chat/session-host.js';
import { scriptedResolver } from '../chat/test-support.js';
import { prepareGlobalPreferences } from '../config/write.js';
import { captureIo } from '../test-support.js';
import { chatCommand, chatResumeCommand, type ChatCommandDeps } from './chat.js';

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
let cwd: string, home: string, client: DbClient;
const previous = new Map<string, string | undefined>();
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-setup-mode-work-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-setup-mode-home-')));
  mkdirSync(join(home, '.relavium'));
  for (const key of ['HOME', 'USERPROFILE']) {
    previous.set(key, process.env[key]);
    process.env[key] = home;
  }
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
  client.sqlite.close();
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function globalMode(mode: 'ask' | 'auto'): void {
  writeFileSync(
    join(home, '.relavium', 'config.toml'),
    `[preferences]\ndefault_mode = "${mode}"\n`,
  );
}
function deps() {
  const { io } = captureIo();
  let id = 0;
  const store = createSessionStore(client.db);
  const fresh = vi.fn(buildChatSession);
  const resumed = vi.fn(buildResumedChatSession);
  const driver = vi.fn<NonNullable<ChatCommandDeps['drive']>>(async (ctx) => {
    ctx.startSession();
    await ctx.onActivated?.(() => !ctx.shouldStop());
    return { kind: 'exit' };
  });
  const d: ChatCommandDeps = {
    ...inertTerminal,
    io: { ...io, stdoutIsTty: true },
    global: { cwd, json: false, color: false, configPath: undefined, verbosity: 'normal' },
    providers: scriptedResolver([]),
    openSessionStore: () => ({ store, db: client.db, close: () => {} }),
    uuid: () => `setup-observation-${id++}`,
    buildSession: fresh,
    buildResumedSession: resumed,
    drive: driver,
  };
  return { d, fresh, resumed, driver };
}

it.each(['fresh', 'resume'] as const)(
  '%s setup forwards the config observer and refuses file-only auto after a real preference publication',
  async (kind) => {
    const f = deps();
    if (kind === 'resume') {
      globalMode('ask');
      await chatCommand({ agent: undefined }, f.d);
      expect(f.fresh).toHaveBeenCalledOnce();
      f.fresh.mockClear();
      f.driver.mockClear();
    }
    globalMode('auto');
    let setupCalls = 0;
    const d: ChatCommandDeps = {
      ...f.d,
      resolveKeys: () => ({
        prepareInteractiveSetup: (_lifetime, _liveDb, observer) => {
          setupCalls += 1;
          expect(observer).toBeDefined();
          globalMode('ask');
          const prepared = prepareGlobalPreferences(
            { defaultModel: 'claude-sonnet-4-6', defaultProvider: 'anthropic' },
            home,
            undefined,
            observer,
          );
          prepared.publish();
          expect(readFileSync(join(home, '.relavium', 'config.toml'), 'utf8')).toContain(
            'default_mode = "ask"',
          );
          globalMode('auto');
          return Promise.resolve({ status: 'ready', changed: true });
        },
      }),
    };
    if (kind === 'fresh')
      await expect(chatCommand({ agent: undefined }, d)).rejects.toThrow(/no longer admitted/);
    else
      await expect(chatResumeCommand({ sessionId: 'setup-observation-0' }, d)).rejects.toThrow(
        /no longer admitted/,
      );
    expect(setupCalls).toBe(1);
    expect(f.fresh).not.toHaveBeenCalled();
    expect(f.resumed).not.toHaveBeenCalled();
    expect(f.driver).not.toHaveBeenCalled();
  },
);
