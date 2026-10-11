import { describe, expect, it } from 'vitest';
import type { LlmProvider } from '@relavium/llm';
import {
  RunEventSchema,
  UsageCoverageFold,
  type RunEvent,
  type UsageEvidence,
  type UsageInvocation,
} from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { createAgentNodeExecutor } from './agent-runner.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';

const subscriberMutations: readonly {
  readonly field: string;
  readonly mutate?: (invocation: UsageInvocation) => void;
}[] = [
  { field: 'unchanged' },
  {
    field: 'producerId',
    mutate: (id) => {
      id.producerId = 'observer-producer';
    },
  },
  {
    field: 'ordinal',
    mutate: (id) => {
      id.ordinal = 100;
    },
  },
  {
    field: 'dispatchId',
    mutate: (id) => {
      id.dispatchId = 'observer-dispatch';
    },
  },
  {
    field: 'round',
    mutate: (id) => {
      id.round = 100;
    },
  },
  {
    field: 'chainAttempt',
    mutate: (id) => {
      id.chainAttempt = 100;
    },
  },
];

describe('workflow accounting owns identity before publishing pending events', () => {
  for (const evidence of [
    { kind: 'complete', usage: { inputTokens: 1, outputTokens: 1 } },
    { kind: 'missing', reason: 'not_reported' },
  ] satisfies UsageEvidence[]) {
    it.each(subscriberMutations)(
      `${evidence.kind} live coverage matches serialized replay after $field subscriber mutation`,
      async ({ mutate }) => {
        const host = createInMemoryHost();
        const persist = host.store.persistEvent.bind(host.store);
        const serializedEvents: string[] = [];
        const order: string[] = [];
        host.store.persistEvent = async (event, context) => {
          // This in-memory host models a JSON serialization boundary, not actual SQLite.
          // Public subscribers cannot rewrite already persisted bytes.
          const serialized = JSON.stringify(event);
          await persist(RunEventSchema.parse(JSON.parse(serialized)), context);
          serializedEvents.push(serialized);
          if (event.type === 'cost:usage_pending') order.push('pending-ack');
        };
        let providerCalls = 0;
        const provider: LlmProvider = {
          id: 'openai',
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
          generate: () => Promise.reject(new Error('unexpected generate')),
          stream: async function* () {
            await Promise.resolve();
            providerCalls++;
            order.push('invoke');
            yield { type: 'stop', stopReason: 'stop', usage: evidence };
          },
        };
        const workflow = parseWorkflow(
          JSON.stringify({
            schema_version: '1.0',
            workflow: {
              id: 'usage-event-ownership',
              agents: [
                { id: 'agent', provider: 'openai', model: 'gpt-4o', system_prompt: 'offline' },
              ],
              nodes: [{ id: 'one', type: 'agent', agent_ref: 'agent', prompt_template: 'offline' }],
              edges: [],
            },
          }),
        );
        const handle = new WorkflowEngine({
          host,
          executor: createAgentNodeExecutor({
            resolveProvider: () => provider,
            keyFor: () => 'synthetic-offline-key',
            sleep: () => Promise.resolve(),
            tools: [],
            registry: {
              has: () => false,
              list: () => [],
              dispatch: () => Promise.reject(new Error('unexpected tool')),
            },
          }),
        }).start({ workflow });
        let mutatedPendingEvents = 0;
        handle.subscribe((event) => {
          if (event.type === 'cost:usage_pending' && mutate !== undefined) {
            mutate(event.invocation);
            mutatedPendingEvents++;
          }
        });
        const live: RunEvent[] = [];
        for await (const event of handle.events) live.push(event);
        await handle.depart();

        expect(providerCalls).toBe(1);
        expect(order).toEqual(['pending-ack', 'invoke']);
        expect(mutatedPendingEvents).toBe(mutate === undefined ? 0 : 1);
        expect(handle.durability()).toBe('durable');
        const stored = serializedEvents.map((serialized) =>
          RunEventSchema.parse(JSON.parse(serialized)),
        );
        const pending = stored.filter((event) => event.type === 'cost:usage_pending');
        const settlements = stored.filter(
          (event) =>
            event.type === 'cost:attempt_settled' || event.type === 'cost:usage_disposition',
        );
        expect(pending).toHaveLength(1);
        expect(settlements).toHaveLength(1);
        expect(settlements[0]?.invocation).toEqual(pending[0]?.invocation);
        const replay = new UsageCoverageFold();
        for (const event of stored) replay.apply(event);
        expect(replay.snapshot().coverage).toEqual({
          unverified: false,
          pendingInvocations: 0,
          unknownCalls: evidence.kind === 'complete' ? 0 : 1,
        });
        expect(replay.retainedInvocations).toBe(0);
        expect(live.at(-1)?.type).toBe('run:completed');
        expect(live.at(-1)?.usageCoverage).toEqual(replay.snapshot().coverage);
        const checkpoint = await host.checkpointer.load(handle.runId);
        expect(checkpoint?.usageCoverage).toEqual(replay.snapshot());
        expect(stored.at(-1)?.usageCoverage).toEqual(replay.snapshot().coverage);
      },
    );
  }
});
