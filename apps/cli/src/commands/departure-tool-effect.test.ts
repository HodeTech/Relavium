import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { BUILTIN_TOOLS, createToolRegistry, WorkflowEngine } from '@relavium/core';
import {
  createClient,
  createEffectJournalStore,
  createRunHistoryStore,
  runMigrations,
} from '@relavium/db';
import { type RunEvent } from '@relavium/shared';
import { captureIo } from '../test-support.js';
import { createJsonRenderer } from '../render/renderer.js';
import { runCommand } from './run.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Scenario =
  | 'late-dispatch'
  | 'committed-refused'
  | 'ambiguous-refused'
  | 'discard-refused'
  | 'mapping-failed'
  | 'bounding-aborted'
  | 'committed-ack'
  | 'discard-ack'
  | 'ambiguous-ack';

async function exercise(scenario: Scenario, combinedMoney = false) {
  const dir = mkdtempSync(join(tmpdir(), 'native-tool-departure-'));
  const path = join(dir, 'history.db');
  const client = createClient(path);
  runMigrations(client.db, { dbPath: path });
  writeFileSync(
    join(dir, 'w.relavium.yaml'),
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'native-tool-departure',
        nodes: [{ id: 'work', type: 'input' }],
        edges: [],
      },
    }),
  );
  const hostEntered = deferred(),
    rawRelease = deferred(),
    primaryTerminal = deferred();
  let closeCount = 0,
    settled = false,
    runId = '';
  let cancel: () => void = () => {
    throw new Error('handle not ready');
  };
  let fireGrace: () => void = () => {
    throw new Error('grace not armed');
  };
  let savedEvents: RunEvent[] = [];
  let savedState: string | undefined;
  const needsAttention = scenario !== 'committed-ack' && scenario !== 'discard-ack';
  const expectedState =
    scenario === 'ambiguous-ack' ? 'ambiguous' : needsAttention ? 'prepared' : undefined;
  const settlements: string[] = [];
  const nativeAcknowledgements: string[] = [];
  let discards = 0,
    dispatched = 0,
    mapped = 0,
    spilled = 0;
  const delivered: RunEvent[] = [];
  const io = captureIo();
  let execution: Promise<number> | undefined;
  try {
    execution = runCommand(
      { workflow: 'w.relavium.yaml', input: [], allowMcpStdio: [] },
      {
        io: io.io,
        global: {
          json: true,
          color: false,
          cwd: dir,
          configPath: undefined,
          verbosity: 'normal',
        },
        providers: {
          resolveProvider: () => {
            throw new Error('unused provider');
          },
          keyFor: () => 'synthetic',
        },
        openRunStore: (workflow) => {
          const store = createRunHistoryStore(client.db, {
            uuid: randomUUID,
            now: Date.now,
            projectRoot: dir,
            workflow: {
              slug: workflow.workflow.id,
              name: workflow.workflow.id,
              definitionJson: JSON.stringify(workflow),
            },
          });
          return {
            db: client.db,
            store,
            terminalOutboxPath: join(dir, 'outbox'),
            close: () => {
              closeCount++;
              savedEvents = store.loadRunEventLogForReplay(runId);
              const rows = createEffectJournalStore(client.db, {
                uuid: randomUUID,
                now: Date.now,
              }).unresolvedForRun(runId);
              expect(rows).toHaveLength(needsAttention ? 1 : 0);
              savedState = rows[0]?.state;
              client.sqlite.close();
            },
          };
        },
        buildEngine: (options = {}) => {
          const host = options.host;
          if (host === undefined) throw new Error('native host required');
          const registry = createToolRegistry({
            tools: BUILTIN_TOOLS,
            host: {
              ...(scenario === 'discard-refused' || scenario === 'discard-ack'
                ? {}
                : {
                    egress: {
                      fetch: async () => {
                        dispatched++;
                        if (scenario === 'late-dispatch') {
                          hostEntered.resolve();
                          await rawRelease.promise;
                        }
                        if (scenario === 'ambiguous-refused' || scenario === 'ambiguous-ack')
                          throw new Error('PRIVATE target outcome unknown');
                        return {
                          status: 200,
                          headers:
                            scenario === 'mapping-failed'
                              ? {
                                  get fault(): string {
                                    mapped++;
                                    throw new Error('PRIVATE mapping failure after target write');
                                  },
                                }
                              : {},
                          body:
                            scenario === 'bounding-aborted'
                              ? 'TARGET_WRITE_LANDED'.repeat(100)
                              : 'TARGET_WRITE_LANDED',
                          truncated: false,
                        };
                      },
                    },
                  }),
              ...(scenario === 'bounding-aborted'
                ? {
                    outputStore: {
                      spill: async () => {
                        spilled++;
                        hostEntered.resolve();
                        await rawRelease.promise;
                        throw Object.assign(new Error('PRIVATE spill aborted after target write'), {
                          name: 'AbortError',
                        });
                      },
                    },
                  }
                : {}),
            },
          });
          const engine = new WorkflowEngine({
            ...options,
            effectJournal: (correlation) => {
              const port = options.effectJournal?.(correlation);
              if (port === undefined) throw new Error('native effect port required');
              return {
                ...port,
                settle: async (...args) => {
                  settlements.push(args[2]);
                  hostEntered.resolve();
                  await rawRelease.promise;
                  if (scenario === 'committed-refused' || scenario === 'ambiguous-refused')
                    throw new Error('PRIVATE settlement ACK refused');
                  await port.settle(...args);
                  nativeAcknowledgements.push(
                    ...createEffectJournalStore(client.db, {
                      uuid: randomUUID,
                      now: Date.now,
                    })
                      .recordsFor(correlation)
                      .map((row) => row.state),
                  );
                },
                discard: async (...args) => {
                  discards++;
                  hostEntered.resolve();
                  await rawRelease.promise;
                  if (scenario === 'discard-refused')
                    throw new Error('PRIVATE discard ACK refused');
                  await port.discard(...args);
                  nativeAcknowledgements.push(
                    ...createEffectJournalStore(client.db, {
                      uuid: randomUUID,
                      now: Date.now,
                    })
                      .recordsFor(correlation)
                      .map((row) => row.state),
                  );
                },
              };
            },
            host: {
              ...host,
              setTimer: (ms, fire, kind) => {
                if (ms === 10000 && kind === 'deadline') {
                  fireGrace = fire;
                  return () => {};
                }
                return host.setTimer(ms, fire, kind);
              },
              store: {
                ...host.store,
                persistEvent: (event, context) => {
                  if (event.runId !== undefined) runId = event.runId;
                  if (event.type === 'cost:attempt_settled' && event.costMicrocents === 17)
                    return Promise.reject(new Error('PRIVATE late money refusal'));
                  return host.store.persistEvent(event, context);
                },
              },
            },
            executor: {
              execute: async (ctx) => {
                if (combinedMoney) {
                  const child = ctx.continueReceipt?.(async (receipt) => {
                    await rawRelease.promise;
                    receipt.money.record({
                      nodeId: 'wrong',
                      model: 'offline',
                      attemptNumber: 1,
                      inputTokens: 1,
                      outputTokens: 1,
                      costMicrocents: 17,
                      priced: true,
                    });
                    await receipt.money.join().catch(() => {});
                  });
                  if (child === undefined) throw new Error('receipt transfer required');
                  void child.catch(() => {});
                }
                if (ctx.effects === undefined) throw new Error('native effect journal required');
                try {
                  await registry.dispatch(
                    {
                      type: 'tool_call',
                      name: 'http_request',
                      id: 'real-post',
                      args: { url: 'https://api.example/x', method: 'POST' },
                    },
                    {
                      nodeId: ctx.vertex.id,
                      grantedToolIds: new Set(['http_request']),
                      config:
                        scenario === 'mapping-failed'
                          ? { outputMapping: { field: 'headers.fault' } }
                          : {},
                      ...(scenario === 'bounding-aborted'
                        ? { limits: { maxBytes: 64, maxLines: 4 } }
                        : {}),
                      toolPolicy: { allowedDomains: ['api.example'] },
                      fsScope: 'sandboxed',
                      gateApproved: false,
                      effects: ctx.effects,
                      effectSlot: 0,
                      signal: ctx.signal,
                    },
                  );
                  return { kind: 'completed', output: 'unexpected success after abort' };
                } catch {
                  if (scenario === 'mapping-failed') {
                    // The real mapping failed before settlement; keep the entered executor owed until T.
                    hostEntered.resolve();
                    await rawRelease.promise;
                  }
                  return {
                    kind: 'failed',
                    error: { code: 'cancelled', message: 'aborted', retryable: false },
                  };
                }
              },
            },
          });
          return Promise.resolve(
            Object.assign(engine, {
              start: (args: Parameters<typeof engine.start>[0]) => {
                const handle = WorkflowEngine.prototype.start.call(engine, args);
                cancel = handle.cancel;
                return handle;
              },
            }),
          );
        },
        selectRenderer: () => {
          const renderer = createJsonRenderer(io.io);
          return {
            ...renderer,
            onEvent: (event) => {
              renderer.onEvent(event);
              delivered.push(event);
              if (event.type === 'run:cancelled') primaryTerminal.resolve();
            },
          };
        },
        selectGatePrompter: () => undefined,
      },
    );
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await hostEntered.promise;
    expect(
      createEffectJournalStore(client.db, { uuid: randomUUID, now: Date.now }).unresolvedForRun(
        runId,
      )[0]?.state,
    ).toBe('prepared');
    cancel();
    fireGrace();
    await primaryTerminal.promise;
    await setImmediate();
    expect(closeCount).toBe(0);
    expect(settled).toBe(false);
    const terminal = delivered.at(-1);
    expect(terminal).toMatchObject({ type: 'run:cancelled' });
    rawRelease.resolve();
    expect(await execution).toBe(combinedMoney ? 8 : needsAttention ? 7 : 1);
    expect(closeCount).toBe(1);
    expect(savedState).toBe(expectedState);
    expect(dispatched).toBe(scenario === 'discard-refused' || scenario === 'discard-ack' ? 0 : 1);
    expect(mapped).toBe(scenario === 'mapping-failed' ? 1 : 0);
    expect(spilled).toBe(scenario === 'bounding-aborted' ? 1 : 0);
    expect(discards).toBe(scenario === 'discard-refused' || scenario === 'discard-ack' ? 1 : 0);
    expect(settlements).toEqual(
      scenario === 'committed-refused' || scenario === 'committed-ack'
        ? ['committed']
        : scenario === 'ambiguous-refused' || scenario === 'ambiguous-ack'
          ? ['ambiguous']
          : [],
    );
    expect(nativeAcknowledgements).toEqual(
      scenario === 'committed-ack'
        ? ['committed']
        : scenario === 'ambiguous-ack'
          ? ['ambiguous']
          : [],
    );
    expect(savedEvents.filter((event) => event.type === 'run:cancelled')).toEqual([terminal]);
    expect(delivered.at(-1)).toBe(terminal);
    if (needsAttention) expect(io.err()).toContain('inspect the target');
    expect(io.err()).not.toContain('PRIVATE');
    const warnings: unknown[] = io
      .err()
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line));
    expect(warnings).toHaveLength(needsAttention || combinedMoney ? 1 : 0);
    if (needsAttention || combinedMoney)
      expect(warnings[0]).toMatchObject({
        code: combinedMoney ? 'money_durability_uncertain' : 'effect_needs_attention',
        effectNeedsAttention: needsAttention,
      });
  } finally {
    rawRelease.resolve();
    await execution?.catch(() => {});
    if (closeCount === 0) client.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const scenario of [
  'late-dispatch',
  'committed-refused',
  'ambiguous-refused',
  'discard-refused',
  'mapping-failed',
  'bounding-aborted',
] satisfies Scenario[])
  for (const combinedMoney of [false, true])
    it(`shipping registry ${scenario} retains native final attention (money=${combinedMoney})`, () =>
      exercise(scenario, combinedMoney));
for (const scenario of ['committed-ack', 'discard-ack', 'ambiguous-ack'] satisfies Scenario[])
  it(`shipping registry ${scenario} uses its actual native receipt disposition`, () =>
    exercise(scenario));
