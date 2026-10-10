import {
  createAgentNodeExecutor,
  createInMemoryHost,
  parseWorkflow,
  WorkflowEngine,
} from '@relavium/core';
import type { LlmProvider, ModelPricing } from '@relavium/llm';
import { UsageCoverageFold, type RunEvent, type UsageEvidence } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { createRunStore } from './run-store.js';

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const cases: readonly {
  name: string;
  evidence: UsageEvidence;
  unknownCalls: number;
  cost: number;
}[] = [
  {
    name: 'missing',
    evidence: { kind: 'missing', reason: 'not_reported' },
    unknownCalls: 3,
    cost: 0,
  },
  {
    name: 'partial',
    evidence: { kind: 'partial', known: { outputTokens: 2 }, reason: 'missing_fields' },
    unknownCalls: 3,
    cost: 0,
  },
  {
    name: 'complete zero',
    evidence: { kind: 'complete', usage: { inputTokens: 0, outputTokens: 0 } },
    unknownCalls: 0,
    cost: 0,
  },
  {
    name: 'complete positive',
    evidence: { kind: 'complete', usage: { inputTokens: 10, outputTokens: 0 } },
    unknownCalls: 0,
    cost: 3000,
  },
];

describe.each([false, true])(
  'concurrent workflow usage publication (held pending ACK=%s)',
  (holdAck) => {
    it.each(cases)(
      'preserves every delivered $name prefix in the shipping run store',
      async ({ evidence, unknownCalls, cost }) => {
        const host = createInMemoryHost();
        const enteredAck = deferred();
        const releaseAck = deferred();
        const allProvidersEntered = deferred();
        const events: RunEvent[] = [];
        const persisted: RunEvent[] = [];
        let held = false;
        const originalPersist = host.store.persistEvent.bind(host.store);
        const persist = vi.spyOn(host.store, 'persistEvent').mockImplementation(async (...args) => {
          await originalPersist(...args);
          persisted.push(args[0]);
          if (holdAck && !held && args[0].type === 'cost:usage_pending') {
            held = true;
            enteredAck.resolve();
            await releaseAck.promise;
          }
        });
        let calls = 0;
        const provider: LlmProvider = {
          id: 'openai',
          customEndpoint: true,
          supports: {
            tools: false,
            streaming: true,
            parallelToolCalls: false,
            vision: false,
            promptCache: false,
            reasoning: false,
            media: {
              input: { image: false, audio: false, video: false, document: false },
              outputCombinations: [],
            },
          },
          generate: () => Promise.reject(new Error('nonstreaming path forbidden')),
          async *stream() {
            calls += 1;
            if (calls === 3) allProvidersEntered.resolve();
            yield { type: 'text_delta', text: 'offline' };
            // All three real invocations overlap; no fabricated accounting frame supplies concurrency.
            await allProvidersEntered.promise;
            yield { type: 'stop', stopReason: 'stop', usage: evidence };
          },
        };
        const price: ModelPricing = {
          provider: 'openai',
          nativeId: 'offline',
          displayName: 'offline',
          contextWindowTokens: 10000,
          maxOutputTokens: 1000,
          inputPerMtokMicrocents: 100000000,
          outputPerMtokMicrocents: 0,
          cachedInputPerMtokMicrocents: 0,
        };
        const resolvePrice = new Map([['offline', price]]);
        const executor = createAgentNodeExecutor({
          resolveProvider: () => provider,
          keyFor: () => 'offline-fixture',
          resolvePrice,
          sleep: () => Promise.resolve(),
          tools: [],
          registry: {
            has: () => false,
            list: () => [],
            dispatch: () => Promise.reject(new Error('tools forbidden')),
          },
        });
        const workflow = parseWorkflow(
          JSON.stringify({
            schema_version: '1.0',
            workflow: {
              id: 'parallel-usage-publication',
              max_parallel: 3,
              agents: [{ id: 'a', provider: 'openai', model: 'offline', system_prompt: 'offline' }],
              nodes: ['one', 'two', 'three'].map((id) => ({
                id,
                type: 'agent',
                agent_ref: 'a',
                prompt_template: 'offline',
              })),
              edges: [],
            },
          }),
        );
        const handle = new WorkflowEngine({ host, executor, resolvePrice }).start({ workflow });
        const fold = new UsageCoverageFold();
        const view = createRunStore(false);
        const differences: unknown[] = [];
        let maximumPending = 0;
        const drain = (async () => {
          for await (const event of handle.events) {
            events.push(event);
            fold.apply(event);
            view.apply(event);
            view.flush();
            const expected = fold.snapshot().coverage;
            const actual = view.getSnapshot().state.usageCoverage;
            maximumPending = Math.max(maximumPending, expected.pendingInvocations);
            if (
              event.type.startsWith('cost:') &&
              event.type !== 'cost:updated' &&
              event.usageCoverage !== undefined
            ) {
              differences.push({
                type: event.type,
                sequenceNumber: event.sequenceNumber,
                unexpectedDurableEnvelope: event.usageCoverage,
              });
            }
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
              differences.push({
                type: event.type,
                sequenceNumber: event.sequenceNumber,
                actual,
                expected,
              });
            }
            if (
              event.usageCoverage !== undefined &&
              JSON.stringify(event.usageCoverage) !== JSON.stringify(expected)
            ) {
              differences.push({
                type: event.type,
                sequenceNumber: event.sequenceNumber,
                envelope: event.usageCoverage,
                expected,
              });
            }
          }
        })();
        try {
          if (holdAck) {
            await Promise.race([
              enteredAck.promise,
              drain.then(() => {
                throw new Error('run ended before pending ACK');
              }),
            ]);
            expect(persisted.filter((event) => event.type === 'cost:usage_pending')).toHaveLength(
              1,
            );
            expect(events.some((event) => event.type === 'cost:usage_pending')).toBe(false);
            expect(calls).toBe(0);
            releaseAck.resolve();
          }
          await drain;
          expect(await handle.depart()).toMatchObject({
            kind: 'closed',
            moneyDurability: 'durable',
          });
          expect(calls).toBe(3);
          expect(maximumPending).toBe(3);
          expect(events.filter((event) => event.type === 'cost:usage_pending')).toHaveLength(3);
          expect(events.filter((event) => event.type === 'cost:attempt_settled')).toHaveLength(
            unknownCalls === 0 ? 3 : 0,
          );
          expect(events.at(-1)?.type).toBe('run:completed');
          expect(differences).toEqual([]);
          expect(view.getSnapshot().state).toMatchObject({
            cumulativeCostMicrocents: cost,
            unpricedCalls: 0,
            usageCoverage: { unverified: false, pendingInvocations: 0, unknownCalls },
          });
          if (unknownCalls > 0) expect(view.summaryText()).toContain('usage unknown for 3 calls');
        } finally {
          releaseAck.resolve();
          allProvidersEntered.resolve();
          await drain;
          await handle.depart();
          persist.mockRestore();
        }
      },
    );
  },
);
