import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as tick } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  WorkflowEngine,
  createAgentNodeExecutor,
  createDispatchingNodeExecutor,
  parseWorkflow,
  reconstructCheckpointState,
  type BudgetDispatchPreparationResult,
  type RunStore,
} from '@relavium/core';
import {
  createClient,
  runMigrations,
  createRunHistoryStore,
  createRunLeasePort,
} from '@relavium/db';
import { type LlmProvider, type ModelPricing } from '@relavium/llm';
import { type RunEvent } from '@relavium/shared';
import { createCliHost } from './host.js';
import { CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
function held<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('uninitialized');
  };
  let reject: (reason: Error) => void = () => {
    throw new Error('uninitialized');
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const model = 'r2-native-claim';
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
for (const decision of ['approved', 'rejected'] as const)
  for (const cancel of [false, true]) {
    it(`native persisted ${decision} claim retains outcome through prepared timeout refusal cancel=${cancel}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'r2-native-claim-'));
      const file = join(root, 'history.db');
      const client = createClient(file);
      runMigrations(client.db, { dbPath: file });
      const timeoutPreparing = held<void>(),
        timeoutPreparation = held<BudgetDispatchPreparationResult>(),
        nativeDecision = held<void>(),
        ack = held<void>(),
        paused = held<void>();
      void timeoutPreparation.promise.catch(() => undefined);
      let calls = 0,
        keys = 0,
        preparations = 0,
        armed = 0;
      let timeout: () => void = () => {
        throw new Error('gate timer missing');
      };
      const provider: LlmProvider = {
        id: 'openai',
        customEndpoint: true,
        supports: CHAT_TEXT_CAPABILITY_FLAGS,
        generate: () => Promise.reject(new Error('unused')),
        stream: async function* () {
          calls++;
          await ack.promise;
          yield { type: 'text_delta', text: 'real synthetic output' };
          yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      const prices = new Map([[model, price]]);
      const runner = createDispatchingNodeExecutor({
        agent: createAgentNodeExecutor({
          resolveProvider: () => provider,
          keyFor: () => {
            keys++;
            return 'synthetic';
          },
          sleep: () => Promise.resolve(),
          tools: [],
          registry: {
            has: () => false,
            list: () => [],
            dispatch: () => Promise.reject(new Error('unused')),
          },
          resolvePrice: prices,
        }),
      });
      const prepare = runner.prepareBudgetDispatch?.bind(runner);
      if (!prepare) throw new Error('real preparation required');
      const workflow = parseWorkflow(
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'r2-native-claim',
            budget: {
              max_cost_microcents: 1,
              on_exceed: 'pause_for_approval',
              strict_cost_cap: true,
            },
            agents: [{ id: 'a', provider: 'openai', model, system_prompt: 's' }],
            nodes: [
              { id: 'agent', type: 'agent', agent_ref: 'a', prompt_template: 'hi', max_tokens: 64 },
            ],
            edges: [],
          },
        }),
      );
      const nativeStore = createRunHistoryStore(client.db, {
        uuid: randomUUID,
        now: Date.now,
        projectRoot: root,
        workflow: {
          slug: workflow.workflow.id,
          name: 'r2-native-claim',
          definitionJson: JSON.stringify(workflow),
        },
      });
      const nativeHost = createCliHost(nativeStore, { runLeases: createRunLeasePort(nativeStore) });
      const store: RunStore = {
        ...nativeHost.store,
        persistEvent: async (event, context) => {
          await nativeHost.store.persistEvent(event, context);
          if (event.type === 'budget:authorization' && event.authorization.state === 'decided') {
            nativeDecision.resolve();
            await ack.promise;
          }
        },
      };
      const host = {
        ...nativeHost,
        store,
        setTimer: (...args: Parameters<typeof nativeHost.setTimer>) => {
          const [ms, fire, kind] = args;
          if (ms > 1000 && ms <= 2000 && (kind ?? 'work') === 'work') {
            timeout = fire;
            armed++;
            return () => {
              armed--;
            };
          }
          return nativeHost.setTimer(...args);
        },
      };
      const executor = {
        execute: async (...args: Parameters<typeof runner.execute>) => {
          const outcome = await runner.execute(...args);
          return outcome.kind === 'paused'
            ? {
                ...outcome,
                gate: { ...outcome.gate, timeoutMs: 2000, timeoutAction: 'approve' as const },
              }
            : outcome;
        },
        prepareBudgetDispatch: (...args: Parameters<typeof prepare>) => {
          preparations++;
          if (preparations === 1) {
            timeoutPreparing.resolve();
            return timeoutPreparation.promise;
          }
          return prepare(...args);
        },
      };
      const engine = new WorkflowEngine({ host, executor, resolvePrice: prices });
      const handle = engine.start({ workflow });
      const events: RunEvent[] = [];
      const drained = (async () => {
        for await (const event of handle.events) {
          events.push(event);
          if (event.type === 'run:paused') paused.resolve();
        }
      })();
      try {
        await paused.promise;
        const cp = reconstructCheckpointState(events);
        const gate = cp?.pendingGates[0];
        if (
          gate?.allowance?.kind !== 'frozen' ||
          gate.allowance.quote.kind !== 'quoted' ||
          gate.allowance.quote.quote.amount.kind !== 'representable'
        )
          throw new Error('actual quote required');
        timeout();
        await timeoutPreparing.promise;
        const manual = engine.resume(handle.runId, gate.gateId, {
          decision,
          decidedBy: 'human',
          ...(decision === 'approved'
            ? { approvedAmountMicrocents: gate.allowance.quote.quote.amount.microcents }
            : {}),
        });
        await nativeDecision.promise;
        const nativeBefore = nativeStore.loadRunEventLogForReplay(handle.runId);
        expect(
          nativeBefore.filter(
            (e) => e.type === 'budget:authorization' && e.authorization.state === 'decided',
          ),
        ).toHaveLength(1);
        // An already claimed duplicate remains an idempotent no-op while ACK is withheld.
        await engine.resume(handle.runId, gate.gateId, {
          decision: 'rejected',
          decidedBy: 'duplicate',
        });
        if (cancel) handle.cancel();
        timeoutPreparation.reject(new Error('late prepared-host refusal'));
        await tick(0);
        expect(calls).toBe(0);
        expect(keys).toBe(0);
        ack.resolve();
        await manual;
        await drained;
        expect((await handle.depart()).kind).toBe('closed');
        const native = nativeStore.loadRunEventLogForReplay(handle.runId);
        expect(native.at(-1)).toMatchObject(
          cancel
            ? { type: 'run:cancelled' }
            : decision === 'approved'
              ? { type: 'run:completed' }
              : { type: 'run:failed', error: { code: 'budget_exceeded' } },
        );
        expect(
          native.filter(
            (e) =>
              e.type === 'run:completed' || e.type === 'run:failed' || e.type === 'run:cancelled',
          ),
        ).toHaveLength(1);
        expect(calls).toBe(!cancel && decision === 'approved' ? 1 : 0);
        expect(keys).toBe(calls);
        expect(
          native.filter(
            (e) => e.type === 'budget:authorization' && e.authorization.state === 'decided',
          ),
        ).toHaveLength(1);
        expect(await createRunLeasePort(nativeStore).read(handle.runId)).toBeUndefined();
        expect(armed).toBe(0);
      } finally {
        ack.resolve();
        timeoutPreparation.reject(new Error('cleanup'));
        handle.cancel();
        await drained;
        client.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
