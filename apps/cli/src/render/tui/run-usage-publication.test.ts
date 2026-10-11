import {
  createAgentNodeExecutor,
  createDispatchingNodeExecutor,
  createHumanGateNodeExecutor,
  createInMemoryHost,
  parseWorkflow,
  WorkflowEngine,
} from '@relavium/core';
import { makeLlmError, type LlmProvider, type ModelPricing } from '@relavium/llm';
import { UsageCoverageFold, type RunEvent, type UsageEvidence } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { createRunStore } from './run-store.js';
import { formatReportedCost } from './format.js';
import { createJsonRenderer } from '../renderer.js';
import { captureIo, parseNdjson, CHAT_TEXT_CAPABILITY_FLAGS } from '../../test-support.js';

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

describe.each([0, 10000])('real workflow lifecycle totals (known input=%i)', (knownInput) => {
  it.each(['failed', 'cancelled', 'paused', 'early-exit'] as const)(
    'keeps the %s final/footer and raw JSON qualified',
    async (outcome) => {
      const entered = deferred();
      let calls = 0;
      const provider: LlmProvider = {
        id: 'openai',
        customEndpoint: true,
        supports: CHAT_TEXT_CAPABILITY_FLAGS,
        generate: () => Promise.reject(new Error('nonstreaming forbidden')),
        async *stream(request) {
          calls++;
          yield { type: 'text_delta', text: 'offline' };
          if (calls === 1) {
            yield {
              type: 'stop',
              stopReason: 'stop',
              usage: { kind: 'complete', usage: { inputTokens: knownInput, outputTokens: 0 } },
            };
            return;
          }
          entered.resolve();
          if (outcome === 'failed')
            throw Object.assign(
              new Error('offline refusal'),
              makeLlmError({
                kind: 'content_filter',
                message: 'offline refusal',
                provider: 'openai',
              }),
            );
          if (outcome === 'cancelled' || outcome === 'early-exit') {
            await new Promise<void>((resolve) => {
              if (request.signal?.aborted === true) resolve();
              else request.signal?.addEventListener('abort', () => resolve());
            });
          }
          yield {
            type: 'stop',
            stopReason: 'stop',
            usage: { kind: 'missing', reason: 'not_reported' },
          };
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
      const workflow = parseWorkflow(
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'lifecycle-coverage',
            agents: [{ id: 'a', provider: 'openai', model: 'offline', system_prompt: 'offline' }],
            nodes: [
              { id: 'known', type: 'agent', agent_ref: 'a', prompt_template: 'offline' },
              { id: 'uncertain', type: 'agent', agent_ref: 'a', prompt_template: 'offline' },
              ...(outcome === 'paused'
                ? [
                    {
                      id: 'gate',
                      type: 'human_gate',
                      gate_type: 'approval',
                    },
                  ]
                : []),
            ],
            edges: [
              { from: 'known', to: 'uncertain' },
              ...(outcome === 'paused' ? [{ from: 'uncertain', to: 'gate' }] : []),
            ],
          },
        }),
      );
      const handle = new WorkflowEngine({
        host: createInMemoryHost(),
        resolvePrice,
        executor: createDispatchingNodeExecutor({
          human_in_the_loop: createHumanGateNodeExecutor({}),
          agent: createAgentNodeExecutor({
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
          }),
        }),
      }).start({ workflow });
      const view = createRunStore(false);
      const io = captureIo();
      const renderer = createJsonRenderer(io.io);
      const paused = deferred();
      const releasePausedReader = deferred();
      const drain = (async () => {
        for await (const event of handle.events) {
          renderer.onEvent(event);
          view.apply(event);
          view.flush();
          if (event.type === 'run:paused') {
            paused.resolve();
            await releasePausedReader.promise;
          }
        }
      })();
      try {
        await Promise.race([
          entered.promise,
          drain.then(() => {
            throw new Error('run ended before uncertain provider invocation');
          }),
        ]);
        if (outcome === 'early-exit') {
          const state = view.getSnapshot().state;
          expect(state.usageCoverage).toEqual({
            unverified: false,
            pendingInvocations: 1,
            unknownCalls: 0,
          });
          expect(view.summaryText()).toContain('run ended');
          expect(view.summaryText()).toContain(
            `${knownInput === 0 ? '$0.0000' : '$0.0100'} known; 1 usage pending`,
          );
          expect(
            formatReportedCost(
              state.cumulativeCostMicrocents,
              state.usageCoverage,
              state.unpricedCalls,
            ),
          ).toContain('1 usage pending');
          const prefix = parseNdjson<RunEvent>(io.out());
          expect(prefix.filter((event) => event.type === 'cost:usage_pending')).toHaveLength(2);
          expect(
            prefix.some(
              (event) =>
                event.type === 'run:completed' ||
                event.type === 'run:cancelled' ||
                event.type === 'run:failed',
            ),
          ).toBe(false);
        }
        if (outcome === 'cancelled' || outcome === 'early-exit') handle.cancel();
        if (outcome === 'paused') await paused.promise;
        else await drain;
        expect(await handle.depart()).toMatchObject({
          kind: outcome === 'paused' ? 'detached' : 'closed',
        });
        releasePausedReader.resolve();
        await drain;
        expect(calls).toBe(2);
        const events = parseNdjson<RunEvent>(io.out());
        const terminal = events.at(-1);
        expect(terminal?.type).toBe(
          outcome === 'paused'
            ? 'run:paused'
            : outcome === 'failed'
              ? 'run:failed'
              : 'run:cancelled',
        );
        expect(terminal?.usageCoverage).toEqual({
          unverified: false,
          pendingInvocations: 0,
          unknownCalls: 1,
        });
        expect(terminal?.cumulativeCostMicrocents).toBe(knownInput * 100);
        const state = view.getSnapshot().state;
        expect(state.cumulativeCostMicrocents).toBe(knownInput * 100);
        expect(view.summaryText()).toContain('known; usage unknown for 1 call');
        expect(
          formatReportedCost(
            state.cumulativeCostMicrocents,
            state.usageCoverage,
            state.unpricedCalls,
          ),
        ).toContain('known; usage unknown for 1 call');
        expect(view.summaryText()).not.toContain('free');
        expect(io.err()).toBe('');
      } finally {
        releasePausedReader.resolve();
        handle.cancel();
        await drain;
        await handle.depart();
      }
    },
  );
});
