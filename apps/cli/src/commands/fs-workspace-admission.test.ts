import { invocationFixture } from '../process/invocation.test-support.js';
import type { CliInvocation } from '../process/invocation.js';
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
import { createClient, createSessionStore } from '@relavium/db';

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
type WorkspacePhase =
  | 'native-open-enter'
  | 'native-open-return'
  | 'seed-enter'
  | 'seed-return'
  | 'read-enter'
  | 'read-closed'
  | 'alias-retarget-enter'
  | 'alias-retarget-return'
  | 'resume-enter'
  | 'resume-return'
  | 'runner-abort';
interface PhaseEntry {
  readonly phase: WorkspacePhase;
  readonly elapsedMs: number;
}
const phaseTrace = vi.hoisted((): { active: ((phase: WorkspacePhase) => void) | undefined } => ({
  active: undefined,
}));
vi.mock('../db/open.js', async (original) => {
  const native = await original<typeof import('../db/open.js')>();
  return {
    ...native,
    openLocalDb: (...args: Parameters<typeof native.openLocalDb>) => {
      const trace = phaseTrace.active;
      effects.history += 1;
      trace?.('native-open-enter');
      try {
        return native.openLocalDb(...args);
      } finally {
        trace?.('native-open-return');
      }
    },
  };
});
vi.mock('../secrets/os-keychain.js', () => ({
  createOsKeychainStore: () => {
    effects.keys += 1;
    throw new Error('synthetic key boundary reached');
  },
}));

interface WorkspaceCase {
  readonly base: string;
  readonly home: string;
  readonly workspace: string;
  readonly sensitiveAlias: string;
  readonly signal: AbortSignal;
  readonly invocation: CliInvocation;
  readonly pending: Set<Promise<void>>;
  readonly removeAbort: () => void;
  readonly assertCurrent: () => void;
  readonly trace: (phase: WorkspacePhase) => void;
  readonly abortSnapshot: () => readonly PhaseEntry[] | undefined;
}
let currentCase: WorkspaceCase;
beforeEach((context) => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-workspace-floor-')));
  const home = join(base, 'home');
  const workspace = join(base, 'neutral-vault');
  for (const path of [home, workspace]) mkdirSync(path);
  const sensitiveAlias = join(home, '.ssh');
  symlinkSync(workspace, sensitiveAlias, 'junction');
  writeFileSync(join(workspace, 'id_ed25519'), 'synthetic key sentinel');
  const { invocation } = invocationFixture();
  const started = performance.now();
  const phases: PhaseEntry[] = [];
  let aborted: readonly PhaseEntry[] | undefined;
  const trace = (phase: WorkspacePhase): void => {
    if (phases.length < 32) phases.push({ phase, elapsedMs: performance.now() - started });
  };
  phaseTrace.active = trace;
  const onAbort = (): void => {
    trace('runner-abort');
    aborted ??= phases.map((entry) => ({ ...entry }));
    invocation.finiteExit.signal(15);
  };
  context.signal.addEventListener('abort', onAbort, { once: true });
  currentCase = {
    base,
    home,
    workspace,
    sensitiveAlias,
    invocation,
    signal: context.signal,
    pending: new Set(),
    trace,
    abortSnapshot: () => aborted,
    removeAbort: () => context.signal.removeEventListener('abort', onAbort),
    assertCurrent: () => {
      context.signal.throwIfAborted();
      invocation.registry.assertAdmitting();
    },
  };
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  Object.assign(effects, { history: 0, keys: 0 });
});
afterEach(async () => {
  const fixture = currentCase;
  const aborted = fixture.abortSnapshot();
  if (aborted !== undefined) {
    // Fixed labels/numbers only. A timeout snapshot is diagnostic, never a native-close receipt.
    console.error(JSON.stringify({ kind: 'workspace-case-abort-phases', phases: aborted }));
  }
  // Runner timeout is cancellation, not raw settlement. Preserve this case's HOME/root until the actual join.
  await Promise.allSettled([...fixture.pending]);
  if (fixture.invocation.registry.termination !== undefined)
    await fixture.invocation.registry.termination;
  fixture.removeAbort();
  phaseTrace.active = undefined;
  expect(fixture.invocation.registry.activeOwners).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(fixture.base, { recursive: true, force: true });
});
function ownCase(body: (fixture: WorkspaceCase) => Promise<void>): Promise<void> {
  const fixture = currentCase;
  const raw = Promise.resolve().then(() => {
    fixture.assertCurrent();
    return body(fixture);
  });
  fixture.pending.add(raw);
  return raw;
}
function readSession(
  fixture: WorkspaceCase,
  open: (path: string) => ReturnType<typeof createClient> = createClient,
) {
  fixture.assertCurrent();
  fixture.trace('read-enter');
  // Observe the existing real database without repeating writable migration/checkpoint maintenance.
  const client = open(join(fixture.home, '.relavium', 'history.db'));
  try {
    return createSessionStore(client.db).loadFull('workspace-floor-session');
  } finally {
    client.sqlite.close();
    fixture.trace('read-closed');
  }
}
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
async function seed(fixture: WorkspaceCase, cwd: string): Promise<void> {
  fixture.assertCurrent();
  fixture.trace('seed-enter');
  await chatCommand(
    { agent: undefined },
    {
      invocation: fixture.invocation,
      io: captureIo().io,
      global: global(cwd),
      providers: scriptedResolver([]),
      uuid: () => 'workspace-floor-session',
      drive: exitDriver,
    },
  );
  fixture.trace('seed-return');
  fixture.assertCurrent();
}

describe('secret workspace admission before canonical persistence', () => {
  it.each([[], ['chat'], ['agent', 'run', 'unused-agent.yaml']].map((surface) => ({ surface })))(
    'refuses real argv surface %j before history/key/provider/MCP composition',
    async ({ surface }) => {
      return ownCase(async (fixture) => {
        const { home, sensitiveAlias } = fixture;
        const captured = captureIo();
        expect(
          await run(
            ['node', 'relavium', '--cwd', sensitiveAlias, ...surface],
            {
              ...captured.io,
              stdinIsTty: true,
              stdoutIsTty: true,
            },
            undefined,
            fixture.invocation,
          ),
          'FS_CAUSAL_WORKSPACE_ADMISSION',
        ).toBe(2);
        expect(effects, 'FS_CAUSAL_WORKSPACE_ADMISSION').toEqual({ history: 0, keys: 0 });
        expect(existsSync(join(home, '.relavium', 'history.db'))).toBe(false);
        expect(captured.err()).toContain('Choose another workspace');
        expect(captured.err()).not.toContain(home);
        expect(captured.err()).not.toContain('synthetic key sentinel');
      });
    },
  );

  it('a fresh sensitive alias cannot create the canonical row that would erase its floor on resume', async () => {
    return ownCase(async (fixture) => {
      const { home, sensitiveAlias } = fixture;
      const providers = vi.fn();
      await expect(
        chatCommand(
          { agent: undefined },
          {
            invocation: fixture.invocation,
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
  });

  it('also refuses a neutral workspace alias whose canonical target is a credential directory', async () => {
    return ownCase(async (fixture) => {
      const { base } = fixture;
      const secret = join(base, '.azure');
      const alias = join(base, 'ordinary-alias');
      mkdirSync(secret);
      symlinkSync(secret, alias, 'junction');
      const captured = captureIo();
      expect(
        await run(
          ['node', 'relavium', '--cwd', alias, 'chat'],
          captured.io,
          undefined,
          fixture.invocation,
        ),
      ).toBe(2);
      expect(effects).toEqual({ history: 0, keys: 0 });
      expect(captured.err()).toContain('Choose another workspace');
      expect(captured.err()).not.toContain(secret);
    });
  });

  it('benign aliases still persist canonical cwd and resume at the original workspace', async () => {
    return ownCase(async (fixture) => {
      const { base, home, workspace } = fixture;
      const alias = join(base, 'ordinary-alias');
      symlinkSync(workspace, alias, 'junction');
      await seed(fixture, alias);
      const before = readSession(fixture);
      expect(before?.session.context.workingDir).toBe(workspace);
      fixture.trace('alias-retarget-enter');
      rmSync(alias);
      symlinkSync(home, alias, 'junction');
      fixture.trace('alias-retarget-return');
      fixture.trace('resume-enter');
      expect(
        await chatResumeCommand(
          { sessionId: 'workspace-floor-session' },
          {
            invocation: fixture.invocation,
            io: captureIo().io,
            global: global(home),
            providers: scriptedResolver([]),
            drive: exitDriver,
          },
        ),
      ).toBe(4);
      fixture.trace('resume-return');
    });
  });

  it('refuses an existing sensitive canonical workspace on resume after only history recovery', async () => {
    return ownCase(async (fixture) => {
      const { base, home, workspace } = fixture;
      await seed(fixture, workspace);
      // A legacy row can name a sensitive, already canonical directory. No real user history is used.
      const canonicalSecret = join(base, '.kube');
      mkdirSync(canonicalSecret);
      const client = createClient(join(home, '.relavium', 'history.db'));
      try {
        client.sqlite
          .prepare('UPDATE agent_sessions SET context_json = ?, working_dir = ? WHERE id = ?')
          .run(
            JSON.stringify({ workingDir: canonicalSecret, fsScopeTier: 'project' }),
            canonicalSecret,
            'workspace-floor-session',
          );
      } finally {
        client.sqlite.close();
      }

      const before = readSession(fixture);
      Object.assign(effects, { history: 0, keys: 0 });
      const captured = captureIo();
      expect(
        await run(
          ['node', 'relavium', 'chat-resume', 'workspace-floor-session', '--cwd', workspace],
          captured.io,
          undefined,
          fixture.invocation,
        ),
      ).toBe(2);
      expect(effects).toEqual({ history: 1, keys: 0 });
      expect(captured.err()).toContain('Choose another workspace');
      expect(captured.err()).not.toContain(canonicalSecret);
      expect(readSession(fixture)).toEqual(before);
    });
  });

  it('fresh and resumed builders refuse owned lexical provenance even with canonical cwd', async () => {
    return ownCase(async (fixture) => {
      const { workspace, sensitiveAlias } = fixture;
      await seed(fixture, workspace);
      const loaded = readSession(fixture);
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
});

it('runner-abort ownership joins a held resumed builder before fixture removal and refuses late driver entry', () =>
  ownCase(async (fixture) => {
    await seed(fixture, fixture.workspace);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    let native: ReturnType<typeof createClient>['sqlite'] | undefined;
    let closed = false;
    const drive = vi.fn(exitDriver);
    const raw = chatResumeCommand(
      { sessionId: 'workspace-floor-session' },
      {
        invocation: fixture.invocation,
        io: captureIo().io,
        global: global(fixture.home),
        providers: scriptedResolver([]),
        drive,
        openSessionStore: (home, captureClose) => {
          const opened = openSessionStore(home, captureClose);
          native = opened.db.$client;
          return {
            ...opened,
            close: () => {
              opened.close();
              closed = true;
            },
          };
        },
        buildResumedSession: async (options) => {
          entered = true;
          await held;
          return buildResumedChatSession(options);
        },
      },
    );
    const observed = raw.then(
      (value) => ({ value }),
      (cause: unknown) => ({ cause }),
    );
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      fixture.invocation.finiteExit.signal(15);
      expect(native?.open).toBe(true);
      expect(closed).toBe(false);
      expect(existsSync(fixture.base)).toBe(true);
    } finally {
      release();
      await observed;
      await fixture.invocation.registry.termination;
    }
    expect(drive).not.toHaveBeenCalled();
    expect(native?.open).toBe(false);
    expect(fixture.invocation.registry.activeOwners).toBe(0);
    expect(existsSync(fixture.base)).toBe(true);
  }));

it('a real SQLite read failure still closes the manually acquired session store', () =>
  ownCase(async (fixture) => {
    await seed(fixture, fixture.workspace);
    let native: ReturnType<typeof createClient>['sqlite'] | undefined;
    const open = (path: string) => {
      const client = createClient(path);
      native = client.sqlite;
      try {
        native.prepare('DROP TABLE agent_sessions').run();
      } catch (cause) {
        native.close();
        throw cause;
      }
      return client;
    };
    try {
      expect(() => readSession(fixture, open)).toThrow(/no such table/);
      expect(native?.open).toBe(false);
    } finally {
      if (native?.open === true) native.close();
    }
  }));
