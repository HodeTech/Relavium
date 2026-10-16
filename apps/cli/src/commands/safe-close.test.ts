import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  createRunHistoryStore,
  createSessionStore,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import { clearCatalogRefresh } from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenedSessionStore } from '../history/session-open.js';
import * as sessionOpen from '../history/session-open.js';
import * as dbOpen from '../db/open.js';
import { loadUserPricingOverlay } from '../engine/pricing-overlay.js';
import { buildChatSession } from '../chat/session-host.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import { createCliInvocation } from '../process/invocation.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo, parseNdjson } from '../test-support.js';
import { chatExportCommand } from './chat-export.js';
import { agentRunCommand } from './agent-run.js';
import { chatListCommand } from './chat-list.js';
import { gateCommand } from './gate.js';
import { runCommand, type RunCommandDeps } from './run.js';

const YAML = `schema_version: '1.0'
workflow:
  id: safe-close
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;
const CLOSE_FAILURE = new Error(
  'SQLITE_IOERR_CLOSE /private/operator/history.db secret-token\x1b[2J',
);

describe('command teardown preserves primary outcomes (#22)', () => {
  let client: DbClient;
  let cwd: string;
  let opened: OpenedSessionStore;
  let close: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-safe-close-'));
    const home = join(cwd, 'home');
    mkdirSync(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    client = createClient(':memory:');
    runMigrations(client.db);
    close = vi.fn(() => {
      client.sqlite.close();
      throw CLOSE_FAILURE;
    });
    opened = { store: createSessionStore(client.db), db: client.db, close };
    writeFileSync(join(cwd, 'flow.yaml'), YAML);
  });

  afterEach(() => {
    clearCatalogRefresh();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (client.sqlite.open) client.sqlite.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  function global(json = false): GlobalOptions {
    return { json, color: false, cwd, configPath: undefined, verbosity: 'normal' };
  }

  function assertClosed(warning: string): void {
    expect(close).toHaveBeenCalledTimes(1);
    expect(client.sqlite.open).toBe(false);
    expect(warning).not.toContain('secret-token');
    expect(warning).not.toContain('/private/operator');
    expect(warning).not.toContain('\x1b');
  }

  async function assertWorkflowCloseUnacknowledged(
    command: Promise<unknown>,
    invocation: ReturnType<typeof createCliInvocation>,
  ): Promise<void> {
    let settled = false;
    void command.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(invocation.registry.activeOwners).toBe(1);
    expect(invocation.registry.observations.exitCode()).toBe(9);
    expect(invocation.registry.budget.deadline()).toBeTypeOf('number');
  }

  function seedSession(): void {
    opened.store.createSession({
      id: 'session-safe-close',
      agentSlug: 'chatter',
      context: { workingDir: cwd, fsScopeTier: 'sandboxed' },
      status: 'ended',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostMicrocents: 0,
      totalConservativeMicrocents: 0,
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
    });
  }

  function historyOpener(): NonNullable<RunCommandDeps['openRunStore']> {
    return (definition) => ({
      db: client.db,
      close,
      terminalOutboxPath: join(cwd, 'outbox.ndjson'),
      store: createRunHistoryStore(client.db, {
        uuid: randomUUID,
        now: Date.now,
        workflow: {
          slug: definition.workflow.id,
          name: definition.workflow.id,
          definitionJson: JSON.stringify(definition),
        },
      }),
    });
  }

  it('retains a real pricing overlay after its transient native database close throws', () => {
    const storeDeps = { uuid: randomUUID, now: Date.now };
    const provider = createProviderStore(client.db, storeDeps).upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    });
    createModelCatalogStore(client.db, storeDeps).upsert({
      providerId: provider.id,
      modelId: 'safe-close-custom',
      displayName: 'Safe close custom',
      contextWindowTokens: 32_000,
      maxOutputTokens: 4_000,
      source: 'user',
      inputCostPerMtokMicrocents: 300_000_000,
      outputCostPerMtokMicrocents: 900_000_000,
    });
    vi.spyOn(dbOpen, 'openLocalDb').mockReturnValue({ db: client.db, close });
    const { io, out, err } = captureIo();
    const overlay = loadUserPricingOverlay(join(cwd, 'home'), io);
    expect(overlay?.get('safe-close-custom')).toMatchObject({
      provider: 'openai',
      inputPerMtokMicrocents: 300_000_000,
      outputPerMtokMicrocents: 900_000_000,
    });
    expect(out()).toBe('');
    expect(err()).toBe('warning: history database teardown failed\n');
    assertClosed(err());
  });

  it.each([false, true])('chat-list retains success and clean stdout (json=%s)', (json) => {
    const { io, out, err } = captureIo();
    expect(chatListCommand({ io, global: global(json), openSessionStore: () => opened })).toBe(
      EXIT_CODES.success,
    );
    expect(out()).toBe(json ? '' : 'No agent sessions yet.\n');
    expect(err()).toBe('warning: session store teardown failed\n');
    assertClosed(err());
  });

  it.each([false, true])(
    'chat-list preserves a store failure identity even with a failed warning sink (%s)',
    (brokenSink) => {
      const primary = new Error('store read failed');
      vi.spyOn(opened.store, 'listSessions').mockImplementation(() => {
        throw primary;
      });
      const captured = captureIo();
      const io = brokenSink
        ? {
            ...captured.io,
            writeErr: () => {
              throw new Error('stderr closed');
            },
          }
        : captured.io;
      let caught: unknown;
      try {
        chatListCommand({ io, global: global(), openSessionStore: () => opened });
      } catch (failure) {
        caught = failure;
      }
      expect(caught).toBe(primary);
      expect(captured.out()).toBe('');
      assertClosed(captured.err());
    },
  );

  it.each([false, true])(
    'chat-export retains the written artifact and success (json=%s)',
    (json) => {
      seedSession();
      const { io, out, err } = captureIo();
      expect(
        chatExportCommand(
          { sessionId: 'session-safe-close', force: false },
          { io, global: global(json), openSessionStore: () => opened },
        ),
      ).toBe(EXIT_CODES.success);
      expect(readFileSync(join(cwd, 'session-safe-close.relavium.yaml'), 'utf8')).toContain(
        'schema_version:',
      );
      if (json)
        expect(parseNdjson(out())).toEqual([expect.objectContaining({ type: 'session:exported' })]);
      expect(out()).not.toContain('teardown');
      expect(err()).toContain('warning: session store teardown failed\n');
      assertClosed(err());
    },
  );

  it('chat-export preserves the original load failure identity', () => {
    const primary = new Error('session load failed');
    vi.spyOn(opened.store, 'loadFull').mockImplementation(() => {
      throw primary;
    });
    const { io, out, err } = captureIo();
    let caught: unknown;
    try {
      chatExportCommand(
        { sessionId: 'session-safe-close', force: false },
        { io, global: global(true), openSessionStore: () => opened },
      );
    } catch (failure) {
      caught = failure;
    }
    expect(caught).toBe(primary);
    expect(out()).toBe('');
    assertClosed(err());
  });

  it('run retains its durable successful result while an opaque native close fault withholds retirement', async () => {
    const { io, out, err } = captureIo();
    const invocation = createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() });
    await assertWorkflowCloseUnacknowledged(
      runCommand(
        { workflow: 'flow.yaml', input: [], allowMcpStdio: [] },
        {
          io,
          invocation,
          subscribeSignals: () => () => undefined,
          global: global(true),
          openRunStore: historyOpener(),
          sweepMedia: () => Promise.resolve(undefined),
        },
      ),
      invocation,
    );
    expect(parseNdjson(out())).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'run:completed' })]),
    );
    expect(out()).not.toContain('teardown');
    expect(err()).toContain('warning: history database teardown failed\n');
    assertClosed(err());
  });

  it('run retains the first infrastructure failure through opaque close and warning-sink faults', async () => {
    const primary = new Error('engine build failed');
    const captured = captureIo();
    const io = {
      ...captured.io,
      writeErr: () => {
        throw new Error('stderr closed');
      },
    };
    const invocation = createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() });
    await assertWorkflowCloseUnacknowledged(
      runCommand(
        { workflow: 'flow.yaml', input: [], allowMcpStdio: [] },
        {
          io,
          invocation,
          subscribeSignals: () => () => undefined,
          global: global(true),
          openRunStore: historyOpener(),
          buildEngine: () => Promise.reject(primary),
        },
      ),
      invocation,
    );
    assertClosed(captured.err());
  });

  it('gate cannot certify release from a native close throw after missing-run refusal', async () => {
    const { io, out, err } = captureIo();
    const invocation = createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() });
    await assertWorkflowCloseUnacknowledged(
      gateCommand(
        { runId: 'absent', approve: true },
        {
          io,
          invocation,
          subscribeSignals: () => () => undefined,
          global: global(true),
          openDb: () => ({ db: client.db, close }),
        },
      ),
      invocation,
    );
    expect(out()).toBe('');
    expect(err()).toBe('warning: history database teardown failed\n');
    assertClosed(err());
  });

  it('gate preserves a genuinely completed run while retaining opaque native close uncertainty', async () => {
    const first = captureIo();
    expect(
      await runCommand(
        { workflow: 'flow.yaml', input: [], allowMcpStdio: [] },
        {
          io: first.io,
          global: global(true),
          sweepMedia: () => Promise.resolve(undefined),
          openRunStore: (definition, home, root) => ({
            ...historyOpener()(definition, home, root),
            close: () => {},
          }),
        },
      ),
    ).toBe(EXIT_CODES.success);
    const started = parseNdjson<{ type: string; runId: string }>(first.out()).find(
      (event) => event.type === 'run:started',
    );
    if (started === undefined) throw new Error('expected durable run identity');
    const { io, out, err } = captureIo();
    const invocation = createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() });
    await assertWorkflowCloseUnacknowledged(
      gateCommand(
        { runId: started.runId, approve: true },
        {
          io,
          invocation,
          subscribeSignals: () => () => undefined,
          global: global(true),
          openDb: () => ({ db: client.db, close }),
        },
      ),
      invocation,
    );
    expect(out()).toBe('');
    expect(err()).toContain('warning: history database teardown failed\n');
    assertClosed(err());
  });

  it.each([false, true])(
    'agent-run joins host work before closing its journal and preserves its outcome (join verdict fails=%s)',
    async (verdictFails) => {
      const primary = new Error('final money publication failed');
      let joined = false;
      const nativeClose = close;
      close = vi.fn(() => {
        expect(joined).toBe(true);
        nativeClose();
      });
      opened = { ...opened, close };
      vi.spyOn(sessionOpen, 'openSessionStore').mockReturnValue(opened);
      writeFileSync(
        join(cwd, 'agent.yaml'),
        'id: chatter\nprovider: anthropic\nmodel: claude-sonnet-4-6\nsystem_prompt: Be concise.\n',
      );
      const { io, out, err } = captureIo();
      const command = agentRunCommand(
        { agent: 'agent.yaml', input: [], allowMcpStdio: [] },
        {
          io: { ...io, stdin: Readable.from(['hello']) },
          global: global(true),
          providers: scriptedResolver([textTurn('done')]),
          buildSession: async (options) => {
            const built = await buildChatSession(options);
            const joinHost = built.whenHostSafeToClose;
            return {
              ...built,
              whenHostSafeToClose: async () => {
                await joinHost();
                joined = true;
                if (verdictFails) throw primary;
              },
            };
          },
        },
      );
      if (verdictFails) await expect(command).rejects.toBe(primary);
      else {
        expect(await command).toBe(EXIT_CODES.success);
        expect(parseNdjson(out())).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: 'session:turn_completed' })]),
        );
      }
      expect(err()).toContain('warning: effect journal teardown failed\n');
      assertClosed(err());
    },
  );
});
