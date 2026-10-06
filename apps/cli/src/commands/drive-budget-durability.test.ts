import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { parseWorkflow, reconstructCheckpointState, type RunStore } from '@relavium/core';
import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
} from '@relavium/db';
import { clearCatalogRefresh, type LlmProvider, type ModelPricing } from '@relavium/llm';
import { afterEach, expect, it } from 'vitest';
import { buildEngine } from '../engine/build-engine.js';
import { createCliHost } from '../engine/host.js';
import { budgetCommand, gateCommand, type GateCommandDeps } from './gate.js';
import { runCommand } from './run.js';
import { captureIo, CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';

const roots: string[] = [];
afterEach(() => {
  clearCatalogRefresh();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function deferred() {
  let complete: () => void = () => {
    throw new Error('deferred not initialized');
  };
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: () => complete() };
}

const MODEL = 'independent-runtime-primary';
const SECOND = 'independent-runtime-fallback';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: MODEL,
  displayName: MODEL,
  contextWindowTokens: 100000,
  maxOutputTokens: 1000,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 1000000,
};
async function fixture(fallback = false, human = false) {
  const root = mkdtempSync(join(tmpdir(), 'group3-runtime-'));
  roots.push(root);
  const file = join(root, 'history.db');
  const client = createClient(file);
  runMigrations(client.db, { dbPath: file });
  const storeDeps = { uuid: randomUUID, now: Date.now };
  let calls = 0,
    keys = 0,
    factories = 0,
    builds = 0,
    opens = 0,
    closes = 0;
  const persist = (p: ModelPricing) => {
    const id = createProviderStore(client.db, storeDeps).upsert({
      name: 'openai',
      displayName: 'Offline runtime fixture',
      baseUrl: 'https://runtime.example.invalid/v1',
    }).id;
    createModelCatalogStore(client.db, storeDeps).upsert({
      providerId: id,
      modelId: p.nativeId,
      displayName: p.displayName,
      source: 'user',
      contextWindowTokens: p.contextWindowTokens,
      maxOutputTokens: p.maxOutputTokens,
      inputCostPerMtokMicrocents: p.inputPerMtokMicrocents,
      outputCostPerMtokMicrocents: p.outputPerMtokMicrocents,
      cachedInputCostPerMtokMicrocents: p.cachedInputPerMtokMicrocents,
    });
  };
  persist(price);
  const provider: LlmProvider = {
    id: 'openai',
    customEndpoint: true,
    supports: CHAT_TEXT_CAPABILITY_FLAGS,
    generate: () => Promise.reject(new Error('unexpected generate')),
    stream: async function* () {
      await Promise.resolve();
      calls++;
      yield { type: 'text_delta', text: 'actual synthetic output' };
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const providers = {
    resolveProvider: () => provider,
    keyFor: () => {
      keys++;
      return 'synthetic-only';
    },
    endpointKind: () => 'custom' as const,
  };
  const yaml = `schema_version: '1.0'\nworkflow:\n  id: independent-runtime\n  budget: {max_cost_microcents: 1, on_exceed: pause_for_approval, strict_cost_cap: true}\n  agents:\n    - {id: worker, model: ${MODEL}, provider: openai, system_prompt: go${fallback ? `, fallback_chain: [{model: ${SECOND}, provider: openai, max_attempts: 1}]` : ''}}\n  nodes:\n    - {id: agent, type: agent, agent_ref: worker, prompt_template: hello, max_tokens: 64}\n${human ? '    - {id: human, type: human_gate, gate_type: approval}\n' : ''}    - {id: out, type: output}\n  edges:\n    - {from: agent, to: out}\n${human ? '    - {from: human, to: out}\n' : ''}`;
  const workflow = parseWorkflow(yaml);
  const store = createRunHistoryStore(client.db, {
    ...storeDeps,
    projectRoot: root,
    workflow: {
      slug: workflow.workflow.id,
      name: 'Independent runtime',
      definitionJson: JSON.stringify(workflow),
    },
  });
  const engine = await buildEngine({
    host: createCliHost(store, { runLeases: createRunLeasePort(store) }),
    resolvePrice: new Map([[MODEL, price]]),
    providers,
  });
  const handle = engine.start({ workflow });
  let gateId = '',
    amount = 0,
    humanId = '';
  for await (const event of handle.events) {
    if (event.type === 'budget:authorization' && event.authorization.state === 'paused') {
      gateId = event.gateId;
      const a = event.authorization.allowance;
      if (
        a.kind !== 'frozen' ||
        a.quote.kind !== 'quoted' ||
        a.quote.quote.amount.kind !== 'representable'
      )
        throw new Error('expected native scalar');
      amount = a.quote.quote.amount.microcents;
    }
    if (event.type === 'human_gate:paused' && event.nodeId === 'human') humanId = event.gateId;
    if (event.type === 'run:paused') break;
  }
  const { io } = captureIo();
  const global = {
    json: false,
    color: false,
    cwd: root,
    configPath: undefined,
    verbosity: 'normal' as const,
  };
  const deps: GateCommandDeps = {
    io,
    global,
    openDb: () => {
      opens++;
      return {
        db: client.db,
        close: () => {
          closes++;
        },
      };
    },
    resolveKeys: (db) => {
      expect(db).toBe(client.db);
      factories++;
      return {
        providers,
        mcpSecretResolver: () => {
          throw new Error('no secret');
        },
      };
    },
    buildEngine: (options) => {
      builds++;
      return buildEngine(options);
    },
  };
  return {
    root,
    file,
    client,
    persist,
    store,
    engine,
    handle,
    gateId,
    amount,
    humanId,
    deps,
    provider,
    providers,
    yaml,
    global,
    io,
    counts: () => ({ calls, keys, factories, builds, opens, closes }),
  };
}
it('actual CLI refuses complete eligibility drift after matching rate-only check', async () => {
  const f = await fixture(true);
  try {
    const before = f.store.loadRunEventLogForReplay(f.handle.runId);
    f.persist({ ...price, nativeId: SECOND });
    await expect(
      budgetCommand(
        { runId: f.handle.runId, gate: f.gateId, approveAmount: String(f.amount) },
        f.deps,
      ),
    ).rejects.toMatchObject({ code: 'invalid_invocation' });
    expect(f.counts()).toEqual({ calls: 0, keys: 0, factories: 1, builds: 1, opens: 1, closes: 1 });
    expect(f.store.loadRunEventLogForReplay(f.handle.runId)).toEqual(before);
    expect(await createRunLeasePort(f.store).read(f.handle.runId)).toBeUndefined();
  } finally {
    f.client.sqlite.close();
  }
});
it('actual CLI re-reads price changed by a resource factory after the early match', async () => {
  const f = await fixture();
  try {
    const before = f.store.loadRunEventLogForReplay(f.handle.runId);
    await expect(
      budgetCommand(
        { runId: f.handle.runId, gate: f.gateId, approveAmount: String(f.amount) },
        {
          ...f.deps,
          resolveKeys: (db) => {
            const result = f.deps.resolveKeys?.(db);
            f.persist({ ...price, inputPerMtokMicrocents: 2000000 });
            if (!result) throw new Error('missing resources');
            return result;
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_invocation' });
    expect(f.counts()).toEqual({ calls: 0, keys: 0, factories: 1, builds: 1, opens: 1, closes: 1 });
    expect(f.store.loadRunEventLogForReplay(f.handle.runId)).toEqual(before);
    expect(await createRunLeasePort(f.store).read(f.handle.runId)).toBeUndefined();
  } finally {
    f.client.sqlite.close();
  }
});
it('native human resolution is refused by budget while the budget sibling remains pending', async () => {
  const f = await fixture(false, true);
  try {
    expect(
      await gateCommand({ runId: f.handle.runId, gate: f.humanId, approve: true }, f.deps),
    ).toBe(3);
    const before = f.store.loadRunEventLogForReplay(f.handle.runId),
      counts = f.counts();
    await expect(
      budgetCommand({ runId: f.handle.runId, gate: f.humanId, abort: true }, f.deps),
    ).rejects.toMatchObject({ code: 'invalid_invocation' });
    expect(f.store.loadRunEventLogForReplay(f.handle.runId)).toEqual(before);
    expect(f.counts()).toEqual({ ...counts, opens: counts.opens + 1, closes: counts.closes + 1 });
    expect(reconstructCheckpointState(before)?.pendingGates.map((g) => g.gateId)).toEqual([
      f.gateId,
    ]);
  } finally {
    f.client.sqlite.close();
  }
});
for (const mode of ['invalid', 'stale', 'reject', 'cancel', 'none'] as const)
  it(`native inline ${mode} drains aggregate pause before closing the command database`, async () => {
    const f = await fixture();
    f.client.sqlite.close();
    const file = join(f.root, 'inline.db');
    const client = createClient(file);
    runMigrations(client.db, { dbPath: file });
    let stored: ReturnType<typeof createRunHistoryStore> | undefined;
    let runId = '';
    let lateWrite = false;
    let lateError = '';
    let lateCause = '';
    let closeAt = 0,
      pauseAckAt = 0;
    let waiting: Promise<void> | undefined;
    const pauseEntered = deferred();
    const releasePause = deferred();
    const promptObserved = deferred();
    const refusalObserved = deferred();
    let commandSettled = false;
    const prices = new Map([[MODEL, price]]);
    writeFileSync(join(f.root, 'inline.relavium.yaml'), f.yaml);
    const { io } = captureIo();
    try {
      const execution = runCommand(
        { workflow: 'inline.relavium.yaml', input: [], allowMcpStdio: [] },
        {
          io: {
            ...io,
            writeErr: (text) => {
              io.writeErr(text);
              if (text.includes(' remains pending: ')) refusalObserved.resolve();
            },
          },
          global: f.global,
          providers: f.providers,
          openRunStore: (workflow) => {
            stored = createRunHistoryStore(client.db, {
              uuid: randomUUID,
              now: Date.now,
              projectRoot: f.root,
              workflow: {
                slug: workflow.workflow.id,
                name: 'Inline',
                definitionJson: JSON.stringify(workflow),
              },
            });
            return {
              db: client.db,
              store: stored,
              terminalOutboxPath: join(f.root, 'outbox.ndjson'),
              close: () => {
                closeAt = Date.now();
                client.sqlite.close();
              },
            };
          },
          buildEngine: async (options) => {
            if (!options?.host) throw new Error('native host required');
            const host = options.host;
            const store: RunStore = {
              ...host.store,
              persistEvent: async (event, context) => {
                if (event.type === 'run:started') runId = event.runId;
                if (event.type === 'run:paused') {
                  waiting = releasePause.promise;
                  pauseEntered.resolve();
                  await waiting;
                  try {
                    await host.store.persistEvent(event, context);
                    pauseAckAt = Date.now();
                  } catch (error) {
                    lateWrite = true;
                    lateError = error instanceof Error ? error.message : String(error);
                    lateCause =
                      error instanceof Error && error.cause instanceof Error
                        ? error.cause.message
                        : '';
                    throw error;
                  }
                  return;
                }
                return host.store.persistEvent(event, context);
              },
            };
            return buildEngine({ ...options, resolvePrice: prices, host: { ...host, store } });
          },
          selectGatePrompter: () =>
            mode === 'none'
              ? undefined
              : {
                  prompt: (_event, budget) => {
                    promptObserved.resolve();
                    if (mode === 'cancel') return Promise.resolve(null);
                    if (mode === 'reject')
                      return Promise.resolve({ decision: 'rejected', decidedBy: 'cli' });
                    if (mode === 'stale')
                      prices.set(MODEL, { ...price, inputPerMtokMicrocents: 2000000 });
                    return Promise.resolve({
                      decision: 'approved',
                      decidedBy: 'cli',
                      ...(mode === 'stale'
                        ? {
                            approvedAmountMicrocents:
                              budget?.kind === 'amount' ? budget.microcents : undefined,
                          }
                        : {}),
                    });
                  },
                },
        },
      ).then((code) => {
        commandSettled = true;
        return code;
      });
      // Hold the actual pause append until the decision/refusal was observed. A whole event-loop
      // turn lets teardown finish if the driver incorrectly treats the gate companion as a barrier.
      if (mode === 'invalid' || mode === 'stale') await refusalObserved.promise;
      else if (mode === 'none') await pauseEntered.promise;
      else await promptObserved.promise;
      await wait(0);
      const beforeAcknowledgement = { commandSettled, databaseOpen: client.sqlite.open };
      releasePause.resolve();
      const code = await execution;
      expect(code).toBe(mode === 'reject' || mode === 'cancel' ? 1 : 3);
      expect(f.counts()).toMatchObject({ calls: 0, keys: 1 });
      await waiting;
      await wait(30);
      const inspect = createClient(file);
      try {
        const inspectStore = createRunHistoryStore(inspect.db, {
          uuid: randomUUID,
          now: Date.now,
          workflow: { slug: 'independent-runtime', name: 'Inline', definitionJson: '{}' },
        });
        const events = inspectStore.loadRunEventLogForReplay(runId);
        const lease = await createRunLeasePort(inspectStore).read(runId);
        if (mode === 'invalid' || mode === 'stale')
          expect(beforeAcknowledgement).toEqual({ commandSettled: false, databaseOpen: true });
        expect({
          lateWrite,
          lateError,
          lateCause,
          pauseAckAt,
          closeAt,
          events: events.map((e) => e.type),
        }).toMatchObject({ lateWrite: false });
        if (mode === 'cancel') expect(events.at(-1)).toMatchObject({ type: 'run:cancelled' });
        else {
          expect(pauseAckAt).toBeGreaterThan(0);
          expect(closeAt).toBeGreaterThanOrEqual(pauseAckAt);
        }
        expect(lease).toBeUndefined();
      } finally {
        inspect.sqlite.close();
      }
    } finally {
      releasePause.resolve();
      if (client.sqlite.open) client.sqlite.close();
    }
  });
