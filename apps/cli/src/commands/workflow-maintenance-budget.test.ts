import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflow, type RunHandle } from '@relavium/core';
import {
  createClient,
  createEffectJournalStore,
  createModelCatalogStore,
  createProviderStore,
  createRunHistoryStore,
  createRunLeasePort,
  FilesystemMediaStore,
  runMigrations,
} from '@relavium/db';
import type { LlmProvider, ModelPricing } from '@relavium/llm';
import { expect, it, vi } from 'vitest';

import { buildEngine, type BuildEngineOptions } from '../engine/build-engine.js';
import { createCliHost } from '../engine/host.js';
import { sweepHostMediaBestEffort } from '../engine/media-gc.js';
import { createInvocationFiniteExit } from '../process/invocation-finite-exit.js';
import { InvocationRegistry } from '../process/invocation-registry.js';
import { captureIo, CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import { budgetCommand, gateCommand } from './gate.js';
import { runCommand } from './run.js';

let home = '';
vi.mock('../config/load.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/load.js')>();
  return {
    ...actual,
    loadResolvedConfig: (options: Parameters<typeof actual.loadResolvedConfig>[0]) =>
      actual.loadResolvedConfig({ ...options, home }),
  };
});

const MODEL = 'offline-maintenance-budget';
const PRICE: ModelPricing = {
  provider: 'openai',
  nativeId: MODEL,
  displayName: MODEL,
  contextWindowTokens: 100000,
  maxOutputTokens: 1000,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 1000000,
};
const provider: LlmProvider = {
  id: 'openai',
  customEndpoint: true,
  supports: CHAT_TEXT_CAPABILITY_FLAGS,
  generate: () => Promise.reject(new Error('unexpected maintenance provider invocation')),
  stream: () => {
    throw new Error('budget rejection must not invoke provider');
  },
};
const providers = {
  resolveProvider: () => provider,
  keyFor: () => {
    throw new Error('no maintenance fixture needs a credential');
  },
  endpointKind: () => 'custom' as const,
};

/** Actual command/engine/SQLite/default CAS; only clock, exit, signal subscription and view are synthetic.
 * At expiry native terminal restoration remains owed: DB close and raw sweeps are joined separately,
 * and this test never calls a returning fake process.exit an acknowledgement of command retirement. */
it.each(['run', 'gate', 'budget'] as const)(
  '%s maintenance uses the original live/expired budget',
  async (surface) => {
    for (const expired of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), 'relavium-terminal-maintenance-'));
      let acquired: ReturnType<typeof createClient> | undefined;
      try {
        home = root;
        const client = createClient(':memory:');
        acquired = client;
        runMigrations(client.db);
        let now = 0;
        const timers = new Set<() => void>();
        const clock = {
          now: () => now,
          schedule: (_ms: number, fire: () => void) => {
            timers.add(fire);
            return () => {
              timers.delete(fire);
            };
          },
        };
        const registry = new InvocationRegistry(clock);
        const exit = vi.fn();
        const finiteExit = createInvocationFiniteExit(registry, clock, {
          exit,
          setExitCode: vi.fn(),
        });
        const invocation = { registry, finiteExit, seedFileCatalogOnce: () => Promise.resolve() };
        let onSignal: (signo: number) => void = () => undefined;
        let closeCompleted: () => void = () => undefined;
        const closed = new Promise<void>((resolve) => {
          closeCompleted = resolve;
        });
        const committedCounts: number[] = [];
        const ambiguousCounts: number[] = [];
        const journal = createEffectJournalStore(client.db, { uuid: randomUUID, now: Date.now });
        let correlation:
          | { kind: 'run'; runId: string; nodeId: string; attempt: number }
          | undefined;
        let terminalHealthReached = false;
        let finalized = false;
        let settled = false;
        const entries: Array<{ remaining: number | undefined; exits: number }> = [];
        const rawSweeps: Promise<unknown>[] = [];
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured native implementation is invoked only with its actual receiver via call below.
        const nativeSweep = FilesystemMediaStore.prototype.sweepTemporaries;
        const sweepSpy = vi
          .spyOn(FilesystemMediaStore.prototype, 'sweepTemporaries')
          .mockImplementation(function (this: FilesystemMediaStore, options) {
            const pending = nativeSweep.call(this, options);
            rawSweeps.push(pending);
            return pending;
          });
        const configPath = join(root, 'config.toml');
        writeFileSync(configPath, '');
        const yaml =
          surface === 'budget'
            ? `schema_version: '1.0'
workflow:
  id: maintenance
  budget: {max_cost_microcents: 1, on_exceed: pause_for_approval, strict_cost_cap: true}
  agents:
    - {id: worker, model: ${MODEL}, provider: openai, system_prompt: synthetic}
  nodes:
    - {id: worker, type: agent, agent_ref: worker, prompt_template: synthetic, max_tokens: 64}
    - {id: out, type: output}
  edges: [{from: worker, to: out}]
`
            : `schema_version: '1.0'
workflow:
  id: maintenance
  nodes:
    - {id: input, type: input}
${surface === 'gate' ? '    - {id: approval, type: human_gate, gate_type: approval}\n' : ''}    - {id: out, type: output}
  edges:
${surface === 'gate' ? '    - {from: input, to: approval}\n    - {from: approval, to: out}' : '    - {from: input, to: out}'}
`;
        const workflow = parseWorkflow(yaml);
        const store = createRunHistoryStore(client.db, {
          uuid: randomUUID,
          now: Date.now,
          projectRoot: root,
          workflow: {
            slug: 'maintenance',
            name: 'maintenance',
            definitionJson: JSON.stringify(workflow),
          },
        });
        const prices = new Map([[MODEL, PRICE]]);
        if (surface === 'budget') {
          const providerId = createProviderStore(client.db, {
            uuid: randomUUID,
            now: Date.now,
          }).upsert({
            name: 'openai',
            displayName: 'Offline',
            baseUrl: 'https://offline.example.invalid/v1',
          }).id;
          createModelCatalogStore(client.db, { uuid: randomUUID, now: Date.now }).upsert({
            providerId,
            modelId: MODEL,
            displayName: MODEL,
            source: 'user',
            contextWindowTokens: PRICE.contextWindowTokens,
            maxOutputTokens: PRICE.maxOutputTokens,
            inputCostPerMtokMicrocents: PRICE.inputPerMtokMicrocents,
            outputCostPerMtokMicrocents: PRICE.outputPerMtokMicrocents,
            cachedInputCostPerMtokMicrocents: PRICE.cachedInputPerMtokMicrocents,
          });
        }
        let runId = '';
        if (surface !== 'run') {
          const initial = await buildEngine({
            host: createCliHost(store, { runLeases: createRunLeasePort(store) }),
            providers,
            resolvePrice: prices,
          });
          const paused = initial.start({ workflow, inputs: {} });
          runId = paused.runId;
          let sawPause = false;
          for await (const event of paused.events) {
            if (event.type === 'run:paused') {
              sawPause = true;
              // Departure needs the intact primary; break returns its iterator afterwards.
              expect((await paused.depart()).kind).not.toBe('continue');
              break;
            }
          }
          expect(sawPause).toBe(true);
        }
        const observe = (handle: RunHandle): RunHandle => {
          runId = handle.runId;
          const read = handle.durability.bind(handle);
          let reads = 0;
          vi.spyOn(handle, 'durability').mockImplementation(() => {
            if (++reads === 2) {
              // Final command health sample, after actual primary/departure and the subscribed signal.
              expect(finalized).toBe(true);
              expect(registry.budget.deadline()).toBe(3000);
              now = expired ? 3000 : 2999;
              terminalHealthReached = true;
              correlation = { kind: 'run', runId, nodeId: 'maintenance-fixture', attempt: 1 };
              for (const [slot, state] of [
                [0, 'committed'],
                [1, 'ambiguous'],
              ] as const) {
                const identity = {
                  scope: `run:${encodeURIComponent(runId)}:maintenance-fixture`,
                  slot,
                  toolId: 'fixture',
                };
                journal.prepare(
                  identity,
                  correlation,
                  { providerAttempt: 1, toolCallId: 'fixture' },
                  3,
                  'fixture',
                );
                journal.settle(identity, state);
              }
            }
            return read();
          });
          return handle;
        };
        const build = async (options?: BuildEngineOptions) => {
          const engine = await buildEngine(options);
          const start = engine.start.bind(engine);
          vi.spyOn(engine, 'start').mockImplementation((params) => observe(start(params)));
          const resume = engine.resumeFromCheckpoint.bind(engine);
          vi.spyOn(engine, 'resumeFromCheckpoint').mockImplementation(async (...params) =>
            observe(await resume(...params)),
          );
          return engine;
        };
        const close = () => {
          if (correlation !== undefined) {
            const records = journal.recordsFor(correlation);
            committedCounts.push(records.filter((r) => r.state === 'committed').length);
            ambiguousCounts.push(records.filter((r) => r.state === 'ambiguous').length);
          }
          client.sqlite.close();
          closeCompleted();
        };
        const deps = {
          invocation,
          io: captureIo().io,
          global: {
            cwd: root,
            configPath,
            json: false,
            color: false,
            verbosity: 'normal' as const,
          },
          subscribeSignals: (consume: (signo: number) => void) => {
            onSignal = consume;
            return () => undefined;
          },
          buildEngine: build,
          selectRenderer: () => ({
            onEvent: () => undefined,
            finalize: () => {
              finalized = true;
              onSignal(15);
            },
          }),
          sweepMedia: (args: Parameters<typeof sweepHostMediaBestEffort>[0]) => {
            entries.push({
              remaining: registry.budget.remainingMs(),
              exits: exit.mock.calls.length,
            });
            return sweepHostMediaBestEffort(args);
          },
        };
        const path = join(root, 'maintenance.relavium.yaml');
        writeFileSync(path, yaml);
        const action = (
          surface === 'run'
            ? runCommand(
                { workflow: path, input: [], allowMcpStdio: [] },
                {
                  ...deps,
                  openRunStore: () => ({
                    db: client.db,
                    store,
                    terminalOutboxPath: join(root, 'outbox'),
                    close,
                  }),
                },
              )
            : surface === 'gate'
              ? gateCommand(
                  { runId, approve: true },
                  { ...deps, openDb: () => ({ db: client.db, close }) },
                )
              : budgetCommand(
                  { runId, abort: true },
                  { ...deps, openDb: () => ({ db: client.db, close }) },
                )
        ).then(
          (code) => {
            settled = true;
            return code;
          },
          (cause: unknown) => {
            settled = true;
            throw cause;
          },
        );
        // Observe rejection immediately even if a fixture assertion below fails first.
        void action.catch(() => undefined);
        try {
          await closed;
          expect(terminalHealthReached, 'ACTUAL_TERMINAL_HEALTH_PRECEDES_MAINTENANCE').toBe(true);
          expect(entries, 'WORKFLOW_TERMINAL_MEDIA_ENTRY_BUDGET').toEqual(
            expired ? [] : [{ remaining: 1, exits: 0 }],
          );
          expect(rawSweeps, 'ACTUAL_NATIVE_MEDIA_ENTRY_BUDGET').toHaveLength(expired ? 0 : 1);
          expect(committedCounts, 'WORKFLOW_TERMINAL_EFFECT_ENTRY_BUDGET').toEqual([
            expired ? 1 : 0,
          ]);
          expect(ambiguousCounts).toEqual([1]);
          expect(client.sqlite.open).toBe(false);
          if (expired) {
            expect(settled, 'EXPIRED_TERMINAL_RESTORATION_IS_NOT_AN_ACK').toBe(false);
            expect(registry.activeOwners).toBeGreaterThan(0);
          } else {
            expect(await action).toBe(surface === 'budget' ? 1 : 0);
            expect(await finiteExit.exited).toBe(143);
            expect(registry.activeOwners).toBe(0);
          }
          expect(registry.budget.deadline()).toBe(3000);
        } finally {
          await Promise.allSettled(rawSweeps);
          for (const fire of [...timers]) fire();
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (client.sqlite.open) client.sqlite.close();
          sweepSpy.mockRestore();
        }
      } finally {
        try {
          if (acquired?.sqlite.open) acquired.sqlite.close();
        } finally {
          vi.restoreAllMocks();
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  },
);
