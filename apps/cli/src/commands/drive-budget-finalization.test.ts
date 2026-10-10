import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { reconstructCheckpointState, type RunStore } from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
} from '@relavium/db';
import type { LlmProvider, ModelPricing } from '@relavium/llm';
import { buildEngine } from '../engine/build-engine.js';
import { createInkRenderer } from '../render/tui/ink-renderer.js';
import { runCommand } from './run.js';
import { captureIo, CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
function latch() {
  let release = () => {};
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
const model = 'round3-owned-quote';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 50000,
  maxOutputTokens: 1000,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 1000000,
};
// Windows cannot deliver these cooperative self-SIGINT probes; non-signal native controls still run.
for (const mode of ['prompt-cancel', 'os-signal', 'approve-all'] as const)
  it.skipIf(process.platform === 'win32' && mode === 'os-signal')(
    'native queued gate ownership: ' + mode,
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'round3-native-'));
      const dbPath = join(root, 'history.db');
      const client = createClient(dbPath);
      runMigrations(client.db, { dbPath });
      const pauseEnter = latch(),
        pauseRelease = latch(),
        firstPrompt = latch(),
        firstRelease = latch(),
        secondRelease = latch(),
        terminalEnter = latch(),
        terminalRelease = latch(),
        terminalAck = latch(),
        signalSeen = latch();
      let prompts = 0,
        calls = 0,
        closes = 0,
        lateWrites = 0,
        settled = false,
        runId = '';
      const log: string[] = [];
      const provider: LlmProvider = {
        id: 'openai',
        customEndpoint: true,
        supports: CHAT_TEXT_CAPABILITY_FLAGS,
        generate: () => Promise.reject(new Error('unused')),
        stream: async function* () {
          calls++;
          await Promise.resolve();
          yield { type: 'text_delta', text: 'native independent' };
          yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      writeFileSync(
        join(root, 'w.relavium.yaml'),
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'round3-queued',
            budget: {
              max_cost_microcents: 1,
              on_exceed: 'pause_for_approval',
              strict_cost_cap: true,
            },
            agents: [{ id: 'a', provider: 'openai', model, system_prompt: 'go' }],
            nodes: [
              {
                id: 'first',
                type: 'agent',
                agent_ref: 'a',
                prompt_template: 'first',
                max_tokens: 20,
              },
              {
                id: 'second',
                type: 'agent',
                agent_ref: 'a',
                prompt_template: 'second',
                max_tokens: 20,
              },
              { id: 'human', type: 'human_gate', gate_type: 'approval' },
            ],
            edges: [],
          },
        }),
      );
      const capture = captureIo();
      const before = process.listenerCount('SIGINT');
      let execution: Promise<number> | undefined;
      try {
        execution = runCommand(
          { workflow: 'w.relavium.yaml', input: [], allowMcpStdio: [] },
          {
            io: capture.io,
            global: {
              cwd: root,
              json: false,
              color: false,
              configPath: undefined,
              verbosity: 'normal',
            },
            providers: {
              resolveProvider: () => provider,
              keyFor: () => 'synthetic',
              endpointKind: () => 'custom',
            },
            openRunStore: (workflow) => {
              const store = createRunHistoryStore(client.db, {
                uuid: randomUUID,
                now: Date.now,
                projectRoot: root,
                workflow: {
                  slug: workflow.workflow.id,
                  name: 'r3',
                  definitionJson: JSON.stringify(workflow),
                },
              });
              return {
                db: client.db,
                store,
                terminalOutboxPath: join(root, 'outbox'),
                close: () => {
                  closes++;
                  log.push('close');
                  client.sqlite.close();
                },
              };
            },
            buildEngine: async (options) => {
              if (!options?.host) throw new Error('actual host missing');
              const host = options.host;
              const store: RunStore = {
                ...host.store,
                persistEvent: async (event, context) => {
                  if (event.type === 'run:started') runId = event.runId;
                  if (event.type === 'run:paused') {
                    pauseEnter.release();
                    await pauseRelease.promise;
                  }
                  if (event.type === 'run:cancelled') {
                    terminalEnter.release();
                    await terminalRelease.promise;
                  }
                  try {
                    await host.store.persistEvent(event, context);
                    log.push(event.type);
                    if (event.type === 'run:cancelled') terminalAck.release();
                  } catch (error) {
                    lateWrites++;
                    throw error;
                  }
                },
              };
              return buildEngine({
                ...options,
                resolvePrice: new Map([[model, price]]),
                host: { ...host, store },
              });
            },
            selectGatePrompter: () => ({
              prompt: async (_event, budget) => {
                prompts++;
                log.push('prompt' + prompts);
                if (prompts === 1) {
                  firstPrompt.release();
                  await firstRelease.promise;
                  if (mode !== 'approve-all') return null;
                } else if (mode !== 'approve-all') await secondRelease.promise;
                return {
                  decision: 'approved',
                  decidedBy: 'round3',
                  ...(budget?.kind === 'amount'
                    ? { approvedAmountMicrocents: budget.microcents }
                    : {}),
                };
              },
            }),
          },
        ).then((code) => {
          settled = true;
          return code;
        });
        await firstPrompt.promise;
        await pauseEnter.promise;
        if (mode === 'os-signal') {
          process.once('SIGINT', signalSeen.release);
          process.kill(process.pid, 'SIGINT');
          await signalSeen.promise;
          await turn();
        }
        firstRelease.release();
        pauseRelease.release();
        if (mode !== 'approve-all') {
          await terminalEnter.promise;
          await turn();
          const observed = { prompts, settled, open: client.sqlite.open, closes };
          terminalRelease.release();
          await terminalAck.promise;
          await turn();
          const afterAck = { prompts, settled, open: client.sqlite.open, closes };
          writeFileSync(
            join(root, 'queued-observation.json'),
            JSON.stringify(
              {
                mode,
                observed,
                afterAck,
                log,
                signalMethod:
                  mode === 'os-signal'
                    ? 'process.kill(self,SIGINT) acknowledged actual listener'
                    : 'GatePrompter null',
              },
              null,
              2,
            ),
          );
          secondRelease.release();
          const code = await execution;
          await turn();
          const inspect = createClient(dbPath);
          try {
            const store = createRunHistoryStore(inspect.db, {
              uuid: randomUUID,
              now: Date.now,
              workflow: { slug: 'round3-queued', name: 'r3', definitionJson: '{}' },
            });
            const events = store.loadRunEventLogForReplay(runId);
            expect(code).toBe(1);
            expect(events.at(-1)?.type).toBe('run:cancelled');
            expect(await createRunLeasePort(store).read(runId)).toBeUndefined();
            expect(calls).toBe(0);
            expect(lateWrites).toBe(0);
            expect(log.indexOf('close')).toBeGreaterThan(log.indexOf('run:cancelled'));
            expect(observed).toEqual({ prompts: 1, settled: false, open: true, closes: 0 });
          } finally {
            inspect.sqlite.close();
          }
        } else {
          terminalRelease.release();
          secondRelease.release();
          expect(await execution).toBe(0);
          expect(prompts).toBe(3);
          expect(calls).toBe(2);
          const inspect = createClient(dbPath);
          try {
            const store = createRunHistoryStore(inspect.db, {
              uuid: randomUUID,
              now: Date.now,
              workflow: { slug: 'round3-queued', name: 'r3', definitionJson: '{}' },
            });
            const events = store.loadRunEventLogForReplay(runId);
            expect(events.at(-1)?.type).toBe('run:completed');
            expect(reconstructCheckpointState(events)?.resolvedBudgetGateIds).toHaveLength(2);
            expect(await createRunLeasePort(store).read(runId)).toBeUndefined();
          } finally {
            inspect.sqlite.close();
          }
        }
        expect(closes).toBe(1);
        expect(process.listenerCount('SIGINT')).toBe(before);
      } finally {
        firstRelease.release();
        pauseRelease.release();
        secondRelease.release();
        terminalRelease.release();
        if (execution) await execution.catch(() => undefined);
        if (client.sqlite.open) client.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

for (const rendererMode of ['custom', 'custom-no-barrier', 'actual-ink'] as const)
  for (const cancel of [false, true])
    it.skipIf(process.platform === 'win32' && cancel)(
      'native cancellation before paused input release acknowledgement ' +
        rendererMode +
        ' ' +
        cancel,
      async () => {
        const root = mkdtempSync(join(tmpdir(), 'round3-finalize-'));
        const file = join(root, 'history.db');
        const client = createClient(file);
        runMigrations(client.db, { dbPath: file });
        const finalizeEnter = latch(),
          finalizeRelease = latch(),
          terminalEnter = latch(),
          terminalRelease = latch(),
          terminalObserved = latch(),
          signalSeen = latch();
        let closed = 0,
          settled = false,
          lateWrites = 0,
          runId = '';
        const order: string[] = [];
        const summaries: string[] = [];
        const capture = captureIo();
        const before = process.listenerCount('SIGINT');
        let execution: Promise<number> | undefined;
        writeFileSync(
          join(root, 'w.relavium.yaml'),
          JSON.stringify({
            schema_version: '1.0',
            workflow: {
              id: 'round3-finalize',
              budget: {
                max_cost_microcents: 1,
                on_exceed: 'pause_for_approval',
                strict_cost_cap: true,
              },
              agents: [{ id: 'a', provider: 'openai', model, system_prompt: 'go' }],
              nodes: [
                {
                  id: 'agent',
                  type: 'agent',
                  agent_ref: 'a',
                  prompt_template: 'pause',
                  max_tokens: 20,
                },
              ],
              edges: [],
            },
          }),
        );
        const provider: LlmProvider = {
          id: 'openai',
          customEndpoint: true,
          supports: CHAT_TEXT_CAPABILITY_FLAGS,
          generate: () => Promise.reject(new Error('unused')),
          stream: async function* () {
            await Promise.resolve();
            yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } };
          },
        };
        try {
          execution = runCommand(
            { workflow: 'w.relavium.yaml', input: [], allowMcpStdio: [] },
            {
              io: capture.io,
              global: {
                cwd: root,
                json: false,
                color: false,
                configPath: undefined,
                verbosity: 'normal',
              },
              providers: {
                resolveProvider: () => provider,
                keyFor: () => 'synthetic',
                endpointKind: () => 'custom',
              },
              openRunStore: (workflow) => {
                const store = createRunHistoryStore(client.db, {
                  uuid: randomUUID,
                  now: Date.now,
                  projectRoot: root,
                  workflow: {
                    slug: workflow.workflow.id,
                    name: 'r3',
                    definitionJson: JSON.stringify(workflow),
                  },
                });
                return {
                  db: client.db,
                  store,
                  terminalOutboxPath: join(root, 'outbox'),
                  close: () => {
                    closed++;
                    order.push('close');
                    client.sqlite.close();
                  },
                };
              },
              buildEngine: async (options) => {
                if (!options?.host) throw new Error('actual host required');
                const host = options.host;
                const store: RunStore = {
                  ...host.store,
                  persistEvent: async (e, c) => {
                    if (e.type === 'run:started') runId = e.runId;
                    if (e.type === 'run:cancelled') {
                      terminalEnter.release();
                      await terminalRelease.promise;
                    }
                    try {
                      await host.store.persistEvent(e, c);
                      order.push(e.type);
                    } catch (error) {
                      lateWrites++;
                      order.push('writer-error');
                      throw error;
                    }
                  },
                };
                const engine = await buildEngine({
                  ...options,
                  resolvePrice: new Map([[model, price]]),
                  host: { ...host, store },
                });
                const start = engine.start.bind(engine);
                engine.start = (args) => {
                  const handle = start(args);
                  handle.subscribe((e) => {
                    if (e.type === 'run:cancelled') terminalObserved.release();
                  });
                  return handle;
                };
                return engine;
              },
              selectGatePrompter: () =>
                rendererMode === 'actual-ink'
                  ? undefined
                  : {
                      prompt: () =>
                        Promise.resolve({ decision: 'approved', decidedBy: 'invalid-no-amount' }),
                    },
              selectRenderer: () =>
                rendererMode === 'actual-ink'
                  ? createInkRenderer({
                      color: false,
                      mount: () => ({
                        unmount: () => finalizeEnter.release(),
                        waitUntilExit: () => finalizeRelease.promise,
                      }),
                      writeSummary: (text) => summaries.push(text),
                    })
                  : {
                      onEvent: (e) => order.push('delivered-' + e.type),
                      releaseInput: async () => {
                        finalizeEnter.release();
                        await finalizeRelease.promise;
                      },
                      finalize: async (beforeSummary?: () => Promise<void>) => {
                        if (rendererMode !== 'custom-no-barrier') await beforeSummary?.();
                        order.push('finalized');
                      },
                    },
            },
          ).then((code) => {
            settled = true;
            return code;
          });
          await finalizeEnter.promise;
          expect(client.sqlite.open).toBe(true);
          expect(closed).toBe(0);
          if (cancel) {
            process.once('SIGINT', signalSeen.release);
            process.kill(process.pid, 'SIGINT');
            await signalSeen.promise;
            await terminalEnter.promise;
          }
          finalizeRelease.release();
          await turn();
          await turn();
          const beforeAck = { settled, open: client.sqlite.open, closed };
          terminalRelease.release();
          const code = await execution;
          if (cancel) await terminalObserved.promise;
          writeFileSync(
            join(root, 'finalize-observation.json'),
            JSON.stringify(
              {
                rendererMode,
                cancel,
                beforeAck,
                code,
                lateWrites,
                order,
                summaries,
                signalMethod: cancel ? 'observed process.kill self OS SIGINT' : null,
              },
              null,
              2,
            ),
          );
          const inspect = createClient(file);
          try {
            const store = createRunHistoryStore(inspect.db, {
              uuid: randomUUID,
              now: Date.now,
              workflow: { slug: 'round3-finalize', name: 'r3', definitionJson: '{}' },
            });
            const events = store.loadRunEventLogForReplay(runId);
            if (cancel) {
              expect(beforeAck).toEqual({ settled: false, open: true, closed: 0 });
              expect(code).toBe(1);
              expect(lateWrites).toBe(0);
              expect(events.at(-1)?.type).toBe('run:cancelled');
              if (rendererMode === 'actual-ink') {
                expect(summaries).toHaveLength(1);
                expect(summaries[0]).toContain('run cancelled');
              }
            } else {
              expect(code).toBe(3);
              expect(events.at(-1)?.type).toBe('run:paused');
            }
            expect(await createRunLeasePort(store).read(runId)).toBeUndefined();
          } finally {
            inspect.sqlite.close();
          }
          expect(process.listenerCount('SIGINT')).toBe(before);
        } finally {
          finalizeRelease.release();
          terminalRelease.release();
          if (execution) await execution.catch(() => undefined);
          if (client.sqlite.open) client.sqlite.close();
          rmSync(root, { recursive: true, force: true });
        }
      },
    );
