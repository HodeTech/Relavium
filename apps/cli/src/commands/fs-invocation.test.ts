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
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@relavium/db';

import {
  buildChatSession,
  buildResumedChatSession,
  type BuildChatSessionOptions,
  type BuildResumedChatSessionOptions,
} from '../chat/session-host.js';
import { scriptedResolver } from '../chat/test-support.js';
import { openSessionStore } from '../history/session-open.js';
import type { GlobalOptions } from '../process/options.js';
import { run } from '../run.js';
import { captureIo } from '../test-support.js';
import { chatCommand, chatResumeCommand, type ChatDriver } from './chat.js';
import { runCommand } from './run.js';
import { fsPolicyWorkspace } from '../engine/tool-host/fs-policy.js';
import { createNodeFsCapability } from '../engine/tool-host/fs.js';

const effects = vi.hoisted(() => ({ history: 0, keys: 0, builders: 0 }));
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
vi.mock('../secrets/os-keychain.js', async (original) => {
  const native = await original<typeof import('../secrets/os-keychain.js')>();
  return {
    ...native,
    createOsKeychainStore: () => {
      effects.keys += 1;
      throw new Error('synthetic composition boundary reached');
    },
  };
});
vi.mock('../chat/session-host.js', async (original) => {
  const native = await original<typeof import('../chat/session-host.js')>();
  return {
    ...native,
    buildChatSession: (...args: Parameters<typeof native.buildChatSession>) => {
      effects.builders += 1;
      return native.buildChatSession(...args);
    },
    buildResumedChatSession: (...args: Parameters<typeof native.buildResumedChatSession>) => {
      effects.builders += 1;
      return native.buildResumedChatSession(...args);
    },
  };
});

let base: string;
let home: string;
let workspace: string;
let outside: string;
const argv = (...tokens: string[]) => ['node', 'relavium', ...tokens];
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-fs-invocation-')));
  home = join(base, 'home');
  workspace = join(base, 'workspace');
  outside = join(base, 'outside');
  for (const path of [home, workspace, outside]) mkdirSync(path);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  Object.assign(effects, { history: 0, keys: 0, builders: 0 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});
function global(cwd = workspace): GlobalOptions {
  return { cwd, json: false, color: false, configPath: undefined, verbosity: 'normal' };
}
function config(cwd: string, body: string) {
  mkdirSync(join(cwd, '.relavium'), { recursive: true });
  writeFileSync(join(cwd, '.relavium', 'project.toml'), body);
}
const exitDriver: ChatDriver = async (ctx) => {
  ctx.startSession();
  await ctx.processLine('/exit');
  return { kind: ctx.stopReason() };
};
async function seed(cwd = workspace): Promise<string> {
  let id = 0;
  await chatCommand(
    { agent: undefined },
    {
      io: captureIo().io,
      global: global(cwd),
      providers: scriptedResolver([]),
      drive: exitDriver,
      uuid: () => `seed-${++id}`,
    },
  );
  Object.assign(effects, { history: 0, keys: 0, builders: 0 });
  return 'seed-1';
}

describe('real argv → Commander → dispatcher admission (synthetic key boundary)', () => {
  it.each(
    [[], ['chat'], ['chat-resume', 'session'], ['agent', 'run', 'agent.yaml']].map((surface) => ({
      surface,
    })),
  )('invalid grants refuse %j before history/keys/provider/MCP builders', async ({ surface }) => {
    const captured = captureIo();
    const io = { ...captured.io, stdinIsTty: true, stdoutIsTty: true };
    expect(
      await run(
        argv('--cwd', workspace, ...surface, '--allow-fs-root', join(base, 'missing-private-root')),
        io,
      ),
      'FS_CAUSAL_INVOCATION_ADMISSION',
    ).toBe(2);
    expect(effects, 'FS_CAUSAL_INVOCATION_ADMISSION').toEqual({ history: 0, keys: 0, builders: 0 });
    expect(captured.err()).not.toContain('missing-private-root');
    expect(existsSync(join(home, '.relavium', 'history.db'))).toBe(false);
  });

  it.each([[], ['chat'], ['agent', 'run', 'agent.yaml']].map((surface) => ({ surface })))(
    'unmatched selectors refuse %j even under sandboxed, before composition',
    async ({ surface }) => {
      config(
        workspace,
        `[chat]\nfs_scope = "sandboxed"\nextra_roots = [${JSON.stringify(outside)}]\n`,
      );
      const captured = captureIo();
      expect(
        await run(argv('--cwd', workspace, ...surface), {
          ...captured.io,
          stdinIsTty: true,
          stdoutIsTty: true,
        }),
      ).toBe(2);
      expect(effects).toEqual({ history: 0, keys: 0, builders: 0 });
      expect(captured.err()).toContain('--allow-fs-root');
    },
  );

  it.each([[], ['chat'], ['agent', 'run', 'agent.yaml']].map((surface) => ({ surface })))(
    'bounded repeated grants with no config reach the authorised %j composition boundary',
    async ({ surface }) => {
      const captured = captureIo();
      const code = await run(
        argv(
          '--allow-fs-root',
          outside,
          '--cwd',
          workspace,
          ...surface,
          `--allow-fs-root=${workspace}`,
        ),
        {
          ...captured.io,
          stdin: Readable.from(['synthetic prompt']),
          stdinIsTty: surface[0] !== 'agent',
          stdoutIsTty: surface[0] !== 'agent',
        },
      );
      // The injected key boundary deliberately throws: this certifies routing/admission, not a live provider turn.
      expect(code).toBe(1);
      expect(effects.keys, 'FS_CAUSAL_INVOCATION_FORWARD').toBe(1);
      expect(effects.history).toBe(0);
    },
  );

  it('rejects the chat-only flag on workflow run before its eager composition root', async () => {
    expect(
      await run(
        argv('run', 'workflow.yaml', '--cwd', workspace, '--allow-fs-root', outside),
        captureIo().io,
      ),
    ).toBe(2);
    expect(effects).toEqual({ history: 0, keys: 0, builders: 0 });
  });
});

it('resumed unmatched selectors allow only existing-history recovery and ignore launch config', async () => {
  const sessionId = await seed();
  config(workspace, `[chat]\nextra_roots = [${JSON.stringify(outside)}]\n`);
  const launch = join(base, 'launch');
  mkdirSync(launch);
  config(launch, '[malformed');
  const before = openSessionStore(home);
  const original = before.store.loadFull(sessionId);
  before.close();
  Object.assign(effects, { history: 0, keys: 0, builders: 0 });
  const captured = captureIo();
  expect(
    await run(argv('chat-resume', sessionId, '--cwd', launch), captured.io),
    'FS_CAUSAL_RESUME_GRANTS',
  ).toBe(2);
  expect(effects).toEqual({ history: 1, keys: 0, builders: 0 });
  expect(captured.err()).toContain('--allow-fs-root');
  const after = openSessionStore(home);
  try {
    expect(after.store.loadFull(sessionId)).toEqual(original);
  } finally {
    after.close();
  }
});

it('resumes current config at the canonical original workspace with fresh grants and a global preference override', async () => {
  const alias = join(base, 'alias');
  symlinkSync(workspace, alias, 'junction');
  const sessionId = await seed(alias);
  const launch = join(base, 'launch');
  mkdirSync(launch);
  config(launch, '[malformed');
  rmSync(alias);
  symlinkSync(launch, alias, 'junction');
  config(workspace, '[chat]\nfs_scope="project"\nextra_roots=["../outside"]\nmax_turns=31\n');
  const override = join(base, 'global.toml');
  writeFileSync(override, '[preferences]\nreasoning_effort="low"\n');
  writeFileSync(join(outside, 'allowed.txt'), 'allowed');
  let captured: BuildResumedChatSessionOptions | undefined;
  const code = await chatResumeCommand(
    { sessionId },
    {
      io: captureIo().io,
      global: { ...global(launch), configPath: override, allowFsRoots: [outside] },
      providers: scriptedResolver([]),
      drive: exitDriver,
      buildResumedSession: async (options) => {
        captured = options;
        return buildResumedChatSession(options);
      },
    },
  );
  expect(code).toBe(4);
  expect(captured?.chat.maxTurns).toBe(31);
  expect(captured?.chat.reasoningEffort).toBe('low');
  expect(captured?.record.context.workingDir).toBe(workspace);
  const policy = captured?.fsPolicy;
  expect(policy).toBeDefined();
  const fs = createNodeFsCapability({
    tier: 'project',
    workspaceDir: workspace,
    readOnly: true,
    ...(policy === undefined ? {} : { pathPolicy: policy }),
  });
  expect((await fs.readFile('../outside/allowed.txt', {})).content).toBe('allowed');
});

it('keeps one owned policy through clear and model reseating without persisting the grants', async () => {
  config(workspace, '[chat]\nfs_scope="project"\n');
  const policies: BuildChatSessionOptions['fsPolicy'][] = [];
  let round = 0;
  const drive: ChatDriver = async (ctx) => {
    ctx.startSession();
    round += 1;
    if (round === 1) {
      await ctx.processLine('/clear');
      return { kind: ctx.stopReason() };
    }
    if (round === 2) {
      ctx.onReseat?.({ modelId: 'gpt-4o-mini', provider: 'openai' });
      return { kind: ctx.stopReason() };
    }
    await ctx.processLine('/exit');
    return { kind: 'exit' };
  };
  await chatCommand(
    { agent: undefined },
    {
      io: { ...captureIo().io, stdoutIsTty: true },
      writeControl: () => undefined,
      global: { ...global(), noAltScreen: true, allowFsRoots: [outside] },
      providers: scriptedResolver([]),
      drive,
      buildSession: async (options) => {
        policies.push(options.fsPolicy);
        return buildChatSession(options);
      },
      buildResumedSession: async (options) => {
        policies.push(options.fsPolicy);
        return buildResumedChatSession(options);
      },
    },
  );
  expect(policies).toHaveLength(3);
  expect(policies[0]).toBeDefined();
  expect(policies.every((policy) => policy === policies[0])).toBe(true);
  const opened = openSessionStore(home);
  try {
    for (const row of opened.store.listSessions()) {
      const loaded = opened.store.loadFull(row.id);
      expect(loaded?.session.context).not.toHaveProperty('fsPolicy');
      expect(loaded?.session.context).not.toHaveProperty('allowFsRoots');
    }
  } finally {
    opened.close();
  }
  if (policies[0] !== undefined) expect(fsPolicyWorkspace(policies[0])).toBe(workspace);
});

it('workflow config remains isolated from chat selectors when no chat-only flag is supplied', async () => {
  config(workspace, `[chat]\nextra_roots=[${JSON.stringify(outside)}]\n`);
  const source = join(workspace, 'workflow.yaml');
  writeFileSync(
    source,
    "schema_version: '1.0'\nworkflow:\n  id: isolated\n  nodes:\n    - { id: result, type: output }\n  edges: []\n",
  );
  expect(
    await runCommand(
      { workflow: source, input: [], allowMcpStdio: [] },
      { io: captureIo().io, global: global(), providers: scriptedResolver([]) },
    ),
  ).toBe(0);
});

it.each(['relative', 'absolute-alias'] as const)(
  'refuses an ambiguous legacy %s workspace before current config or key/provider/MCP composition',
  async (kind) => {
    const sessionId = await seed();
    const alias = join(base, 'legacy-alias');
    symlinkSync(workspace, alias, 'junction');
    const opened = openSessionStore(home);
    const original = opened.store.loadFull(sessionId);
    opened.close();
    expect(original).toBeDefined();
    if (original === undefined) throw new Error('seed record missing');
    const legacy = kind === 'relative' ? 'private-legacy-workspace-sentinel' : alias;
    const db = createClient(join(home, '.relavium', 'history.db'));
    try {
      db.sqlite
        .prepare('UPDATE agent_sessions SET context_json = ?, working_dir = ? WHERE id = ?')
        .run(
          JSON.stringify({ ...original.session.context, workingDir: legacy }),
          legacy,
          sessionId,
        );
    } finally {
      db.sqlite.close();
    }
    config(workspace, '[malformed');
    Object.assign(effects, { history: 0, keys: 0, builders: 0 });
    const captured = captureIo();
    expect(await run(argv('chat-resume', sessionId, '--cwd', workspace), captured.io)).toBe(2);
    expect(effects).toEqual({ history: 1, keys: 0, builders: 0 });
    expect(captured.err()).toMatch(/original|canonical|workspace/);
    expect(captured.err()).not.toContain(legacy);
  },
);

it('revalidates a revoked policy before binding an agent or connecting MCP during a direct rebuild', async () => {
  let options: BuildChatSessionOptions | undefined;
  await chatCommand(
    { agent: undefined },
    {
      io: captureIo().io,
      global: { ...global(), allowFsRoots: [outside] },
      providers: scriptedResolver([]),
      drive: exitDriver,
      buildSession: (current) => {
        options = current;
        return buildChatSession(current);
      },
    },
  );
  if (options === undefined) throw new Error('seed builder was not reached');
  rmSync(outside, { recursive: true });
  mkdirSync(outside);
  const startMcpClient = vi
    .fn<NonNullable<BuildChatSessionOptions['startMcpClient']>>()
    .mockRejectedValue(new Error('unexpected MCP connect'));
  const uuid = vi.fn(() => 'unexpected-mint');
  await expect(
    buildChatSession({ ...options, agentRef: 'missing-agent.yaml', uuid, startMcpClient }),
  ).rejects.toThrow(/identities changed/);
  expect(uuid).not.toHaveBeenCalled();
  expect(startMcpClient).not.toHaveBeenCalled();
});

it('forwards real argv grants into a project selector before composition', async () => {
  config(workspace, `[chat]\nfs_scope="project"\nextra_roots=[${JSON.stringify(outside)}]\n`);
  const captured = captureIo();
  const code = await run(argv('chat', '--cwd', workspace, '--allow-fs-root', outside), captured.io);
  expect(code, 'FS_CAUSAL_INVOCATION_FORWARD').toBe(1);
  expect(effects.keys, 'FS_CAUSAL_INVOCATION_FORWARD').toBe(1);
  expect(effects.history).toBe(0);
});
