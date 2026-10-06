import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  parseWorkflow,
  budgetAllowancePricesMatch,
  reconstructCheckpointState,
} from '@relavium/core';
import {
  createClient,
  createProviderStore,
  createModelCatalogStore,
  createModelMetadataStore,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import type { LlmProvider, ModelPricing } from '@relavium/llm';
import { clearCatalogRefresh } from '@relavium/llm';
import { buildEngine } from '../engine/build-engine.js';
import { createCliHost } from '../engine/host.js';
import { readBudgetPricingOverlay } from '../engine/pricing-overlay.js';
import { budgetCommand, gateCommand, type GateCommandDeps } from './gate.js';
import { captureIo, CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';

const MODEL = 'independent-native-budget';
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
let client: DbClient;
let dir: string;
let calls = 0;
let keys = 0;
let factories = 0;
let builds = 0;
const storeDeps = { uuid: randomUUID, now: Date.now };
const provider: LlmProvider = {
  id: 'openai',
  customEndpoint: true,
  supports: CHAT_TEXT_CAPABILITY_FLAGS,
  generate: () => Promise.reject(new Error('unused generate')),
  stream: async function* () {
    calls++;
    await Promise.resolve();
    yield { type: 'text_delta', text: 'NATIVE_REAL_OUTPUT' };
    yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
  },
};
const providers = () => ({
  resolveProvider: () => provider,
  keyFor: () => {
    keys++;
    return 'synthetic';
  },
  endpointKind: () => 'custom' as const,
});
function persist(model = MODEL, delta = 0) {
  const owner = createProviderStore(client.db, storeDeps).upsert({
    name: 'openai',
    displayName: 'Offline',
    baseUrl: 'https://example.invalid/v1',
  });
  createModelCatalogStore(client.db, storeDeps).upsert({
    providerId: owner.id,
    modelId: model,
    displayName: model,
    source: 'user',
    contextWindowTokens: 100000,
    maxOutputTokens: 1000,
    inputCostPerMtokMicrocents: price.inputPerMtokMicrocents + delta,
    outputCostPerMtokMicrocents: price.outputPerMtokMicrocents,
    cachedInputCostPerMtokMicrocents: price.cachedInputPerMtokMicrocents,
  });
}
const reader = () =>
  createRunHistoryStore(client.db, {
    ...storeDeps,
    workflow: { slug: 'native-review', name: 'native-review', definitionJson: '{}' },
  });
beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  dir = mkdtempSync(join(tmpdir(), 'independent-native-'));
  calls = keys = factories = builds = 0;
  persist();
});
afterEach(() => {
  client.sqlite.close();
  rmSync(dir, { recursive: true, force: true });
  clearCatalogRefresh();
});
async function seed(human = false, excluded = false) {
  const workflow = parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'native-review',
        budget: { max_cost_microcents: 1, on_exceed: 'pause_for_approval', strict_cost_cap: true },
        agents: [
          {
            id: 'a',
            provider: 'openai',
            model: MODEL,
            system_prompt: 's',
            ...(excluded
              ? { fallback_chain: [{ model: 'new-excluded', provider: 'openai', max_attempts: 1 }] }
              : {}),
          },
        ],
        nodes: [
          { id: 'agent', type: 'agent', agent_ref: 'a', prompt_template: 'hi', max_tokens: 64 },
          ...(human ? [{ id: 'human', type: 'human_gate', gate_type: 'approval' }] : []),
        ],
        edges: [],
      },
    }),
  );
  const store = createRunHistoryStore(client.db, {
    ...storeDeps,
    projectRoot: dir,
    workflow: {
      slug: 'native-review',
      name: 'native-review',
      definitionJson: JSON.stringify(workflow),
    },
  });
  const engine = await buildEngine({
    host: createCliHost(store, { runLeases: createRunLeasePort(store) }),
    providers: providers(),
    resolvePrice: readBudgetPricingOverlay(client.db),
  });
  const handle = engine.start({ workflow });
  for await (const e of handle.events) {
    if (e.type === 'run:paused') break;
  }
  const cp = reconstructCheckpointState(reader().loadRunEventLogForReplay(handle.runId));
  const gate = cp?.pendingGates.find((g) => g.isBudgetGate);
  if (
    gate?.allowance?.kind !== 'frozen' ||
    gate.allowance.quote.kind !== 'quoted' ||
    gate.allowance.quote.quote.amount.kind !== 'representable'
  )
    throw new Error('expected real budget');
  return {
    runId: handle.runId,
    gateId: gate.gateId,
    amount: gate.allowance.quote.quote.amount.microcents,
    quote: gate.allowance.quote,
    human: cp?.pendingGates.find((g) => !g.isBudgetGate),
  };
}
function deps(mutate?: () => void): GateCommandDeps {
  const { io } = captureIo();
  return {
    io,
    global: { json: false, color: false, cwd: dir, configPath: undefined, verbosity: 'normal' },
    openDb: () => ({ db: client.db, close: () => {} }),
    resolveKeys: (db) => {
      expect(db).toBe(client.db);
      factories++;
      mutate?.();
      return {
        providers: providers(),
        mcpSecretResolver: () => {
          throw new Error('unused MCP');
        },
      };
    },
    buildEngine: (options) => {
      builds++;
      return buildEngine(options);
    },
  };
}
it('an early native read is write-free and genuine exact approval dispatches once', async () => {
  const r = await seed();
  const before = client.sqlite.prepare('SELECT total_changes()').pluck().get();
  const overlay = readBudgetPricingOverlay(client.db);
  expect(budgetAllowancePricesMatch(r.quote, overlay)).toBe(true);
  expect(client.sqlite.prepare('SELECT total_changes()').pluck().get()).toBe(before);
  expect(createModelMetadataStore(client.db, storeDeps).readAll()).toEqual([]);
  expect(await budgetCommand({ runId: r.runId, approveAmount: String(r.amount) }, deps())).toBe(0);
  expect({ factories, builds, calls, keys }).toEqual({
    factories: 1,
    builds: 1,
    calls: 1,
    keys: 1,
  });
  expect(reader().loadRunEventLogForReplay(r.runId).at(-1)?.type).toBe('run:completed');
});
it('early native rate-only refusal prevents resolver and full engine construction', async () => {
  const r = await seed();
  persist(MODEL, 1);
  const before = reader().loadRunEventLogForReplay(r.runId);
  await expect(
    budgetCommand({ runId: r.runId, approveAmount: String(r.amount) }, deps()),
  ).rejects.toMatchObject({ code: 'invalid_invocation' });
  expect({ factories, builds, calls, keys }).toEqual({
    factories: 0,
    builds: 0,
    calls: 0,
    keys: 0,
  });
  expect(reader().loadRunEventLogForReplay(r.runId)).toEqual(before);
  expect(await createRunLeasePort(reader()).read(r.runId)).toBeUndefined();
});
it.each(['rate-after-read', 'excluded-becomes-priced'] as const)(
  'a genuine early match gives no authority after %s',
  async (kind) => {
    const r = await seed(false, kind === 'excluded-becomes-priced');
    const before = reader().loadRunEventLogForReplay(r.runId);
    expect(budgetAllowancePricesMatch(r.quote, readBudgetPricingOverlay(client.db))).toBe(true);
    await expect(
      budgetCommand(
        { runId: r.runId, approveAmount: String(r.amount) },
        deps(() => {
          if (kind === 'rate-after-read') persist(MODEL, 1);
          else persist('new-excluded');
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_invocation' });
    expect({ factories, builds, calls, keys }).toEqual({
      factories: 1,
      builds: 1,
      calls: 0,
      keys: 0,
    });
    expect(reader().loadRunEventLogForReplay(r.runId)).toEqual(before);
    expect(await createRunLeasePort(reader()).read(r.runId)).toBeUndefined();
  },
);
it('native human resolution never turns into budget-command idempotency while budget remains pending', async () => {
  const r = await seed(true);
  if (r.human === undefined) throw new Error('expected human sibling');
  expect(await gateCommand({ runId: r.runId, gate: r.human.gateId, approve: true }, deps())).toBe(
    3,
  );
  const cp = reconstructCheckpointState(reader().loadRunEventLogForReplay(r.runId));
  expect(cp?.resolvedGateIds).toContain(r.human.gateId);
  expect(cp?.resolvedBudgetGateIds).not.toContain(r.human.gateId);
  const before = reader().loadRunEventLogForReplay(r.runId);
  const count = factories;
  await expect(
    budgetCommand({ runId: r.runId, gate: r.human.gateId, abort: true }, deps()),
  ).rejects.toMatchObject({ code: 'invalid_invocation' });
  expect(factories).toBe(count);
  expect(reader().loadRunEventLogForReplay(r.runId)).toEqual(before);
  expect(await budgetCommand({ runId: r.runId, gate: r.gateId, abort: true }, deps())).toBe(1);
  expect(calls).toBe(0);
});
