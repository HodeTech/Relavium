import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  WorkflowEngine,
  createAgentNodeExecutor,
  createDispatchingNodeExecutor,
  parseWorkflow,
  reconstructCheckpointState,
  type NodeExecContext,
  type NodeExecutor,
  type NodeOutcome,
} from '@relavium/core';
import {
  createClient,
  createEffectJournalStore,
  createModelCatalogStore,
  createProviderStore,
  createRunHistoryStore,
  createRunLeasePort,
  runCosts,
  runMigrations,
} from '@relavium/db';
import { RunEventSchema, type RunEvent } from '@relavium/shared';
import type { LlmProvider, ModelPricing } from '@relavium/llm';
import { buildEngine } from '../engine/build-engine.js';
import { createCliHost } from '../engine/host.js';
import { readBudgetPricingOverlay } from '../engine/pricing-overlay.js';
import { captureIo, CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import { createJsonRenderer, createPlainRenderer, type RunRenderer } from '../render/renderer.js';
import { createInkRenderer } from '../render/tui/ink-renderer.js';
import { gateCommand, budgetCommand } from './gate.js';
import { runCommand } from './run.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Command = 'run' | 'gate' | 'budget';
type Health = 'healthy' | 'money' | 'effect' | 'both';
type Mode = 'json' | 'plain' | 'ink';
type Finish = 'completed' | 'failed' | 'cancelled';
type EffectFinish =
  | 'reject-committed'
  | 'reject-ambiguous'
  | 'reject-discard'
  | 'ambiguous'
  | 'committed'
  | 'discard'
  | 'unsettled';
const model = 'native-departure-fixture';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 100000,
  maxOutputTokens: 1000,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 1000000,
};

async function exercise(
  command: Command,
  health: Health,
  mode: Mode,
  terminalAck: 'ok' | 'failed' | 'lost' = 'ok',
  finish: Finish = 'completed',
  effectFinish: EffectFinish = 'reject-committed',
  inputOrder?: 'input-first' | 'receipt-first',
) {
  const dir = mkdtempSync(join(tmpdir(), 'departure-native-'));
  const dbPath = join(dir, 'history.db');
  const client = createClient(dbPath);
  runMigrations(client.db, { dbPath });
  const storeDeps = { uuid: randomUUID, now: Date.now };
  const owner = createProviderStore(client.db, storeDeps).upsert({
    name: 'openai',
    displayName: 'Offline fixture',
    baseUrl: 'https://example.invalid/v1',
  });
  createModelCatalogStore(client.db, storeDeps).upsert({
    providerId: owner.id,
    modelId: model,
    displayName: model,
    source: 'user',
    contextWindowTokens: 100000,
    maxOutputTokens: 1000,
    inputCostPerMtokMicrocents: price.inputPerMtokMicrocents,
    outputCostPerMtokMicrocents: price.outputPerMtokMicrocents,
    cachedInputCostPerMtokMicrocents: price.cachedInputPerMtokMicrocents,
  });
  let providerCalls = 0;
  const provider: LlmProvider = {
    id: 'openai',
    customEndpoint: true,
    supports: CHAT_TEXT_CAPABILITY_FLAGS,
    generate: () => Promise.reject(new Error('unused generate')),
    stream: async function* () {
      providerCalls++;
      yield Promise.resolve({ type: 'text_delta', text: 'REAL_BUDGET_DISPATCH' } as const);
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const providers = {
    resolveProvider: () => provider,
    keyFor: () => 'synthetic-offline-key',
    endpointKind: (): 'custom' => 'custom',
  };
  const workflow = parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'native-departure',
        ...(command === 'budget'
          ? {
              budget: {
                max_cost_microcents: 1,
                on_exceed: 'pause_for_approval',
                strict_cost_cap: true,
              },
              agents: [{ id: 'a', provider: 'openai', model, system_prompt: 's' }],
            }
          : {}),
        nodes:
          command === 'budget'
            ? [{ id: 'work', type: 'agent', agent_ref: 'a', prompt_template: 'hi', max_tokens: 64 }]
            : [
                ...(command === 'gate'
                  ? [{ id: 'human', type: 'human_gate', gate_type: 'approval' }]
                  : []),
                { id: 'work', type: 'input' },
              ],
        edges: command === 'gate' ? [{ from: 'human', to: 'work' }] : [],
      },
    }),
  );
  writeFileSync(join(dir, 'w.relavium.yaml'), JSON.stringify(workflow));
  const store = createRunHistoryStore(client.db, {
    ...storeDeps,
    projectRoot: dir,
    workflow: {
      slug: workflow.workflow.id,
      name: workflow.workflow.id,
      definitionJson: JSON.stringify(workflow),
    },
  });
  let runId = '',
    gateId = '',
    amount = 0;
  if (command !== 'run') {
    const seed = await buildEngine({
      host: createCliHost(store, { runLeases: createRunLeasePort(store) }),
      providers,
      resolvePrice: readBudgetPricingOverlay(client.db),
    });
    const handle = seed.start({ workflow });
    runId = handle.runId;
    const paused = deferred();
    const reader = (async () => {
      for await (const event of handle.events) if (event.type === 'run:paused') paused.resolve();
    })();
    await paused.promise;
    expect(await handle.depart()).toMatchObject({ kind: 'detached', moneyDurability: 'durable' });
    await reader;
    const cp = reconstructCheckpointState(store.loadRunEventLogForReplay(runId));
    const gate = cp?.pendingGates.find((entry) => entry.isBudgetGate === (command === 'budget'));
    if (gate === undefined) throw new Error('real native gate required');
    gateId = gate.gateId;
    if (command === 'budget') {
      const allowance = gate.allowance;
      if (
        allowance?.kind !== 'frozen' ||
        allowance.quote.kind !== 'quoted' ||
        allowance.quote.quote.amount.kind !== 'representable'
      )
        throw new Error('real frozen allowance required');
      amount = allowance.quote.quote.amount.microcents;
    }
  }
  const entered = deferred(),
    release = deferred(),
    primaryTerminal = deferred(),
    inputEntered = deferred(),
    inputRelease = deferred();
  const io = captureIo();
  const delivered: RunEvent[] = [];
  const summaries: string[] = [];
  const moneyFail = health === 'money' || health === 'both';
  const effectRequested = health === 'effect' || health === 'both';
  const effectFail = effectRequested && effectFinish !== 'committed' && effectFinish !== 'discard';
  let cancelRun: () => void = () => {
    throw new Error('engine not constructed');
  };
  let settled = false,
    closes = 0,
    child: Promise<void> | undefined;
  let savedEvents: RunEvent[] = [];
  let savedCost = 0;
  let savedEffects = 0;
  const makeRenderer = (): RunRenderer => {
    const renderer =
      mode === 'json'
        ? createJsonRenderer(io.io)
        : mode === 'plain'
          ? createPlainRenderer(io.io)
          : createInkRenderer({
              color: false,
              mount: () => ({
                unmount: () => {
                  inputEntered.resolve();
                },
                waitUntilExit: () =>
                  inputOrder === undefined ? Promise.resolve() : inputRelease.promise,
              }),
              writeSummary: (text) => {
                summaries.push(text);
              },
              writeTerminalNotice: (text) => io.io.writeErr(text),
            });
    return {
      ...renderer,
      onEvent: (event) => {
        renderer.onEvent(event);
        delivered.push(event);
        if (
          event.type === 'run:completed' ||
          event.type === 'run:failed' ||
          event.type === 'run:cancelled'
        )
          primaryTerminal.resolve();
      },
    };
  };
  const close = () => {
    closes++;
    savedEvents = store.loadRunEventLogForReplay(runId);
    savedCost = client.db
      .select()
      .from(runCosts)
      .all()
      .reduce((sum, row) => sum + row.costMicrocents, 0);
    savedEffects = createEffectJournalStore(client.db, {
      uuid: randomUUID,
      now: Date.now,
    }).unresolvedForRun(runId).length;
    client.sqlite.close();
  };
  const build: typeof buildEngine = (options = {}) => {
    const host = options.host;
    if (host === undefined) throw new Error('native command host required');
    const agent = createAgentNodeExecutor({
      resolveProvider: () => provider,
      keyFor: () => 'synthetic-offline-key',
      tools: [],
      sleep: () => Promise.resolve(),
      resolvePrice: readBudgetPricingOverlay(client.db),
      registry: {
        has: () => false,
        list: () => [],
        dispatch: () => Promise.reject(new Error('unused tools')),
      },
    });
    const runner = createDispatchingNodeExecutor({ agent });
    const attach = async (ctx: NodeExecContext, execute: () => Promise<NodeOutcome>) => {
      if (health !== 'healthy') {
        if (effectRequested) {
          if (ctx.effects === undefined) throw new Error('native journal required');
          expect(await ctx.effects.prepare(0, 'offline_write', 3, {})).toEqual({
            outcome: 'proceed',
          });
        }
        child = ctx.continueReceipt?.(async (receipt) => {
          entered.resolve();
          await release.promise;
          if (moneyFail) {
            receipt.money.record({
              nodeId: 'wrong-node',
              model,
              attemptNumber: 1,
              inputTokens: 1,
              outputTokens: 1,
              costMicrocents: 17,
              priced: true,
            });
            await receipt.money.join().catch(() => {}); // consuming the failure cannot clear final health
          }
          if (effectRequested) {
            if (effectFinish === 'discard' || effectFinish === 'reject-discard')
              await receipt.effects?.discard(0, 'offline_write').catch(() => {});
            else if (effectFinish !== 'unsettled')
              await receipt.effects
                ?.settle(
                  0,
                  'offline_write',
                  effectFinish === 'ambiguous' || effectFinish === 'reject-ambiguous'
                    ? 'ambiguous'
                    : 'committed',
                )
                .catch(() => {});
          }
        });
        if (child === undefined) throw new Error('receipt transfer required');
        void child.catch(() => {});
      } else {
        child = ctx.continueReceipt?.(async () => {
          entered.resolve();
          await release.promise;
        });
        if (child === undefined) throw new Error('receipt transfer required');
      }
      const result = await execute();
      if (finish === 'failed')
        return {
          kind: 'failed',
          error: { code: 'internal', message: 'offline failure', retryable: false },
        } satisfies NodeOutcome;
      if (finish === 'cancelled') cancelRun();
      return result;
    };
    const executor: NodeExecutor = {
      execute: (ctx) =>
        attach(ctx, () =>
          command === 'budget'
            ? runner.execute(ctx)
            : Promise.resolve({ kind: 'completed', output: 'native' }),
        ),
      prepareBudgetDispatch: async (ctx) => {
        const result = await runner.prepareBudgetDispatch?.(ctx);
        if (result === undefined) throw new Error('real budget preparation required');
        if (result.kind !== 'prepared') return result;
        return {
          kind: 'prepared',
          preparation: {
            quote: (context) => result.preparation.quote(context),
            execute: (context) => attach(context, () => result.preparation.execute(context)),
          },
        };
      },
    };
    const engine = new WorkflowEngine({
      ...options,
      executor,
      host: {
        ...host,
        store: {
          ...host.store,
          persistEvent: async (event, context) => {
            if (runId === '' && event.runId !== undefined) runId = event.runId;
            const isTerminal =
              event.type === 'run:completed' ||
              event.type === 'run:failed' ||
              event.type === 'run:cancelled';
            if (event.type === 'cost:attempt_settled' && moneyFail && event.costMicrocents === 17)
              throw new Error('PRIVATE late money refusal');
            if (isTerminal && terminalAck === 'failed')
              throw new Error('PRIVATE failed terminal ACK');
            await host.store.persistEvent(event, context);
            if (isTerminal && terminalAck === 'lost') throw new Error('PRIVATE lost terminal ACK');
          },
        },
      },
      ...(options.effectJournal === undefined
        ? {}
        : {
            effectJournal: (correlation) => {
              const port = options.effectJournal?.(correlation);
              if (port === undefined) throw new Error('native journal required');
              return {
                ...port,
                settle: (...args) =>
                  effectFinish === 'reject-committed' || effectFinish === 'reject-ambiguous'
                    ? Promise.reject(new Error('PRIVATE effect ACK refusal'))
                    : port.settle(...args),
                discard: (...args) =>
                  effectFinish === 'reject-discard'
                    ? Promise.reject(new Error('PRIVATE discard ACK refusal'))
                    : port.discard(...args),
              };
            },
          }),
    });
    cancelRun = () => engine.cancel(runId);
    return Promise.resolve(engine);
  };
  const common = {
    io: io.io,
    global: {
      json: mode === 'json',
      color: false,
      cwd: dir,
      configPath: undefined,
      verbosity: 'normal' as const,
    },
    providers,
    buildEngine: build,
    selectRenderer: makeRenderer,
    selectGatePrompter: () => undefined,
  };
  const baseline = process.listenerCount('SIGINT');
  let execution: Promise<number> | undefined;
  try {
    execution =
      command === 'run'
        ? runCommand(
            { workflow: 'w.relavium.yaml', input: [], allowMcpStdio: [] },
            {
              ...common,
              openRunStore: () => ({
                db: client.db,
                store,
                terminalOutboxPath: join(dir, 'outbox'),
                close,
              }),
            },
          )
        : command === 'gate'
          ? gateCommand(
              { runId, gate: gateId, approve: true },
              { ...common, openDb: () => ({ db: client.db, close }) },
            )
          : budgetCommand(
              { runId, gate: gateId, approveAmount: String(amount) },
              { ...common, openDb: () => ({ db: client.db, close }) },
            );
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await entered.promise;
    await primaryTerminal.promise;
    const terminal = delivered.at(-1);
    expect(terminal).toMatchObject({ type: 'run:' + finish });
    await setImmediate();
    expect(settled).toBe(false);
    expect(closes).toBe(0);
    expect(summaries).toEqual([]);
    if (mode === 'ink') expect(io.err()).toContain(`Run ${finish}; run cleanup is pending.`);
    expect(await createRunLeasePort(store).read(runId)).toBeDefined();
    if (inputOrder !== undefined) {
      await inputEntered.promise;
      await delay(275);
      expect(io.err()).toContain('Run cleanup is still pending');
      expect(settled).toBe(false);
      if (inputOrder === 'input-first') inputRelease.resolve();
      else {
        release.resolve();
        await child;
      }
      await setImmediate();
      expect(closes).toBe(0);
      expect(summaries).toHaveLength(0);
      expect(settled).toBe(false);
    }
    release.resolve();
    inputRelease.resolve();
    await child;
    expect(await execution).toBe(
      moneyFail ? 8 : effectFail ? 7 : terminalAck === 'ok' ? (finish === 'completed' ? 0 : 1) : 5,
    );
    expect(closes).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(baseline);
    expect(
      delivered.filter(
        (event) =>
          event.type.startsWith('run:') &&
          ['run:completed', 'run:failed', 'run:cancelled'].includes(event.type),
      ),
    ).toEqual([terminal]);
    expect(delivered.at(-1)).toBe(terminal);
    const durableTerminal = savedEvents.find((event) => event.type === 'run:' + finish);
    if (terminalAck !== 'failed') expect(durableTerminal).toEqual(terminal);
    expect(
      savedEvents.filter(
        (event) => event.type === 'cost:attempt_settled' && event.costMicrocents === 17,
      ),
    ).toEqual([]);
    expect(savedCost).toBe(command === 'budget' ? 2 : 0);
    expect(providerCalls).toBe(command === 'budget' ? 1 : 0);
    expect(savedEffects).toBe(effectFail ? 1 : 0);
    if (mode === 'ink') expect(summaries).toHaveLength(1);
    if (mode === 'json') {
      const rows: unknown[] = io
        .out()
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line));
      expect(rows).toHaveLength(delivered.length);
      for (const row of rows) expect(RunEventSchema.safeParse(row).success).toBe(true);
      expect(rows.at(-1)).toEqual(terminal);
      const diagnostics: unknown[] = io
        .err()
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line));
      const attention = diagnostics.filter(
        (row) =>
          typeof row === 'object' &&
          row !== null &&
          'code' in row &&
          (row.code === 'money_durability_uncertain' || row.code === 'effect_needs_attention'),
      );
      expect(attention).toHaveLength(moneyFail || effectFail ? 1 : 0);
      if (health === 'both')
        expect(attention[0]).toMatchObject({
          code: 'money_durability_uncertain',
          effectNeedsAttention: true,
        });
    }
    expect(io.err()).not.toContain('PRIVATE');
  } finally {
    inputRelease.resolve();
    release.resolve();
    await execution?.catch(() => {});
    if (closes === 0) client.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const command of ['run', 'gate', 'budget'] satisfies Command[]) {
  for (const health of ['healthy', 'money', 'effect', 'both'] satisfies Health[])
    it(`${command}: native late ${health} receipts join before close and select final health`, () =>
      exercise(command, health, 'json'));
}
for (const mode of ['plain', 'ink'] satisfies Mode[])
  for (const health of ['money', 'effect', 'both'] satisfies Health[])
    it(`${mode}: native ${health} receipts preserve one terminal and one final summary`, () =>
      exercise('run', health, mode));
for (const ack of ['failed', 'lost'] as const)
  it(`${ack} terminal ACK cannot conceal a refused late money receipt`, () =>
    exercise('run', 'money', 'json', ack));

for (const command of ['run', 'gate', 'budget'] satisfies Command[])
  for (const finish of ['cancelled', 'failed'] satisfies Finish[])
    it(`${command}: late money failure preserves actual ${finish} terminal`, () =>
      exercise(command, 'money', 'json', 'ok', finish));
for (const effectFinish of [
  'reject-ambiguous',
  'reject-discard',
  'ambiguous',
  'committed',
  'discard',
  'unsettled',
] satisfies EffectFinish[])
  it(`native child ${effectFinish} ACK selects only retained effect attention`, () =>
    exercise('run', 'effect', 'json', 'ok', 'completed', effectFinish));
for (const order of ['input-first', 'receipt-first'] as const)
  it(`native Ink terminal and cleanup notice remain visible while ${order} barriers join`, () =>
    exercise('run', 'both', 'ink', 'ok', 'completed', 'reject-committed', order));
