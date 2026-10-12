import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@relavium/db';

import { buildChatSession, buildResumedChatSession } from '../chat/session-host.js';
import { scriptedResolver } from '../chat/test-support.js';
import { loadResolvedConfig } from '../config/load.js';
import { createFsPathPolicy } from '../engine/tool-host/fs-policy.js';
import { openSessionStore } from '../history/session-open.js';
import type { GlobalOptions } from '../process/options.js';
import { run } from '../run.js';
import { captureIo } from '../test-support.js';
import { chatCommand, chatResumeCommand, type ChatDriver } from './chat.js';

const effects = vi.hoisted(() => ({ history: 0, keys: 0 }));
vi.mock('../db/open.js', async (original) => {
  const native = await original<typeof import('../db/open.js')>();
  return {
    ...native,
    openLocalDb: (...args: Parameters<typeof native.openLocalDb>) => {
      effects.history += 1;
      return native.openLocalDb(...args);
    },
  };
});
vi.mock('../secrets/os-keychain.js', () => ({
  createOsKeychainStore: () => {
    effects.keys += 1;
    throw new Error('synthetic key boundary reached');
  },
}));

let base: string;
let home: string;
let workspace: string;
let sensitiveAlias: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-workspace-floor-')));
  home = join(base, 'home');
  workspace = join(base, 'neutral-vault');
  for (const path of [home, workspace]) mkdirSync(path);
  sensitiveAlias = join(home, '.ssh');
  symlinkSync(workspace, sensitiveAlias, 'junction');
  writeFileSync(join(workspace, 'id_ed25519'), 'synthetic key sentinel');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  Object.assign(effects, { history: 0, keys: 0 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});
const global = (cwd: string): GlobalOptions => ({
  cwd,
  json: false,
  color: false,
  configPath: undefined,
  verbosity: 'normal',
});
const exitDriver: ChatDriver = async (ctx) => {
  ctx.startSession();
  await ctx.processLine('/exit');
  return { kind: ctx.stopReason() };
};
async function seed(cwd: string): Promise<void> {
  await chatCommand(
    { agent: undefined },
    {
      io: captureIo().io,
      global: global(cwd),
      providers: scriptedResolver([]),
      uuid: () => 'workspace-floor-session',
      drive: exitDriver,
    },
  );
}

describe('secret workspace admission before canonical persistence', () => {
  it.each([[], ['chat'], ['agent', 'run', 'unused-agent.yaml']].map((surface) => ({ surface })))(
    'refuses real argv surface %j before history/key/provider/MCP composition',
    async ({ surface }) => {
      const captured = captureIo();
      expect(
        await run(['node', 'relavium', '--cwd', sensitiveAlias, ...surface], {
          ...captured.io,
          stdinIsTty: true,
          stdoutIsTty: true,
        }),
        'FS_CAUSAL_WORKSPACE_ADMISSION',
      ).toBe(2);
      expect(effects, 'FS_CAUSAL_WORKSPACE_ADMISSION').toEqual({ history: 0, keys: 0 });
      expect(existsSync(join(home, '.relavium', 'history.db'))).toBe(false);
      expect(captured.err()).toContain('Choose another workspace');
      expect(captured.err()).not.toContain(home);
      expect(captured.err()).not.toContain('synthetic key sentinel');
    },
  );

  it('a fresh sensitive alias cannot create the canonical row that would erase its floor on resume', async () => {
    const providers = vi.fn();
    await expect(
      chatCommand(
        { agent: undefined },
        {
          io: captureIo().io,
          global: global(sensitiveAlias),
          resolveKeys: providers,
          drive: exitDriver,
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_invocation' });
    expect(providers).not.toHaveBeenCalled();
    expect(effects.history).toBe(0);
    expect(existsSync(join(home, '.relavium', 'history.db'))).toBe(false);
  });

  it('also refuses a neutral workspace alias whose canonical target is a credential directory', async () => {
    const secret = join(base, '.azure');
    const alias = join(base, 'ordinary-alias');
    mkdirSync(secret);
    symlinkSync(secret, alias, 'junction');
    const captured = captureIo();
    expect(await run(['node', 'relavium', '--cwd', alias, 'chat'], captured.io)).toBe(2);
    expect(effects).toEqual({ history: 0, keys: 0 });
    expect(captured.err()).toContain('Choose another workspace');
    expect(captured.err()).not.toContain(secret);
  });

  it('benign aliases still persist canonical cwd and resume at the original workspace', async () => {
    const alias = join(base, 'ordinary-alias');
    symlinkSync(workspace, alias, 'junction');
    await seed(alias);
    const opened = openSessionStore(home);
    const before = opened.store.loadFull('workspace-floor-session');
    opened.close();
    expect(before?.session.context.workingDir).toBe(workspace);
    rmSync(alias);
    symlinkSync(home, alias, 'junction');
    expect(
      await chatResumeCommand(
        { sessionId: 'workspace-floor-session' },
        {
          io: captureIo().io,
          global: global(home),
          providers: scriptedResolver([]),
          drive: exitDriver,
        },
      ),
    ).toBe(4);
  });

  it('refuses an existing sensitive canonical workspace on resume after only history recovery', async () => {
    await seed(workspace);
    // A legacy row can name a sensitive, already canonical directory. No real user history is used.
    const canonicalSecret = join(base, '.kube');
    mkdirSync(canonicalSecret);
    const client = createClient(join(home, '.relavium', 'history.db'));
    client.sqlite
      .prepare('UPDATE agent_sessions SET context_json = ?, working_dir = ? WHERE id = ?')
      .run(
        JSON.stringify({ workingDir: canonicalSecret, fsScopeTier: 'project' }),
        canonicalSecret,
        'workspace-floor-session',
      );
    client.sqlite.close();
    const beforeStore = openSessionStore(home);
    const before = beforeStore.store.loadFull('workspace-floor-session');
    beforeStore.close();
    Object.assign(effects, { history: 0, keys: 0 });
    const captured = captureIo();
    expect(
      await run(
        ['node', 'relavium', 'chat-resume', 'workspace-floor-session', '--cwd', workspace],
        captured.io,
      ),
    ).toBe(2);
    expect(effects).toEqual({ history: 1, keys: 0 });
    expect(captured.err()).toContain('Choose another workspace');
    expect(captured.err()).not.toContain(canonicalSecret);
    const afterStore = openSessionStore(home);
    expect(afterStore.store.loadFull('workspace-floor-session')).toEqual(before);
    afterStore.close();
  });

  it('fresh and resumed builders refuse owned lexical provenance even with canonical cwd', async () => {
    await seed(workspace);
    const opened = openSessionStore(home);
    const loaded = opened.store.loadFull('workspace-floor-session');
    opened.close();
    if (loaded === undefined) throw new Error('synthetic seed missing');
    const chat = loadResolvedConfig({ cwd: workspace }).config.chat;
    const policy = createFsPathPolicy({ workspaceDir: sensitiveAlias });
    const providers = scriptedResolver([]);
    const resolveProvider = vi.spyOn(providers, 'resolveProvider');
    const keyFor = vi.spyOn(providers, 'keyFor');
    const uuid = vi.fn(() => 'never-created');
    const startMcpClient = vi.fn().mockRejectedValue(new Error('unexpected MCP connect'));
    const now = () => Date.now();
    await expect(
      buildChatSession({
        chat,
        fsPolicy: policy,
        cwd: workspace,
        agentRef: undefined,
        projectConfigDir: undefined,
        now,
        uuid,
        providers,
        startMcpClient,
      }),
    ).rejects.toMatchObject({ code: 'invalid_invocation' });
    await expect(
      buildResumedChatSession({
        chat,
        fsPolicy: policy,
        record: loaded.session,
        messages: loaded.messages,
        now,
        providers,
        startMcpClient,
      }),
    ).rejects.toMatchObject({ code: 'invalid_invocation' });
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(keyFor).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
    expect(startMcpClient).not.toHaveBeenCalled();
  });
});
