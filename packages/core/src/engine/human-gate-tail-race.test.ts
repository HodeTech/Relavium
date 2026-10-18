import type { AbortSignalLike, RunEvent } from '@relavium/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as resolver from '../interpolation/resolve.js';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import type { NodeOutcome } from './node-executor.js';
import { createDispatchingNodeExecutor } from './node-handlers/dispatcher.js';
import { createHumanGateNodeExecutor } from './node-handlers/human-gate.js';

const originalResolve = resolver.resolvePublicTemplate;
afterEach(() => vi.restoreAllMocks());

function fixture(): {
  engine: WorkflowEngine;
  store: InMemoryRunStore;
  outcomes: NodeOutcome[];
  signals: AbortSignalLike[];
} {
  const store = new InMemoryRunStore();
  const handler = createHumanGateNodeExecutor();
  const outcomes: NodeOutcome[] = [];
  const signals: AbortSignalLike[] = [];
  const executor = createDispatchingNodeExecutor({
    human_in_the_loop: {
      execute: async (ctx) => {
        signals.push(ctx.signal);
        const outcome = await handler.execute(ctx);
        outcomes.push(outcome);
        return outcome;
      },
    },
  });
  return {
    engine: new WorkflowEngine({ host: createInMemoryHost({ store }), executor }),
    store,
    outcomes,
    signals,
  };
}
function workflow() {
  return parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'gate-tail',
        nodes: [
          {
            id: 'gate',
            type: 'human_gate',
            gate_type: 'approval',
            message_template: 'literal gate message',
            assignee: 'literal reviewer',
          },
        ],
        edges: [],
      },
    }),
  );
}
function assertOrder(events: readonly RunEvent[]): void {
  const numbers = events.map((event) => event.sequenceNumber);
  expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  expect(new Set(numbers).size).toBe(numbers.length);
}

describe('real engine human gate final resolver race (G9)', () => {
  it('cancels the real handler and preserves no durable or delivered gate pause', async () => {
    const { engine, store, outcomes, signals } = fixture();
    const trace: string[] = [];
    vi.spyOn(resolver, 'resolvePublicTemplate').mockImplementation(async (...args) => {
      const text = await originalResolve(...args);
      if (args[0] === 'literal reviewer') {
        expect(args[3]).toBe(signals[0]);
        trace.push('resolver-settled');
        handle.cancel();
        expect(args[3]?.aborted, 'real handle cancellation aborts actual handler signal').toBe(
          true,
        );
        trace.push('abort-requested');
      }
      return text;
    });
    const handle = engine.start({ workflow: workflow() });
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    for (const rail of [events, store.eventsFor(handle.runId)]) {
      expect(rail.filter((event) => event.type === 'run:cancelled')).toHaveLength(1);
      expect
        .soft(
          rail.filter((event) =>
            [
              'human_gate:paused',
              'run:paused',
              'human_gate:resumed',
              'run:completed',
              'node:retrying',
            ].includes(event.type),
          ),
        )
        .toEqual([]);
      assertOrder(rail);
    }
    expect(trace).toEqual(['resolver-settled', 'abort-requested']);
    expect
      .soft(outcomes, 'recorded real handler outcome is the causal final-tail control')
      .toMatchObject([{ kind: 'failed', error: { code: 'cancelled', retryable: false } }]);
  });

  it('live real handler pauses durably and resumes to completion', async () => {
    const { engine, store, outcomes } = fixture();
    const handle = engine.start({ workflow: workflow() });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused') {
        const gateId = event.gateIds[0];
        if (gateId === undefined) throw new Error('real pause omitted gate id');
        await engine.resume(handle.runId, gateId, { decision: 'approved', decidedBy: 'tester' });
      }
    }
    expect(outcomes).toEqual([
      {
        kind: 'paused',
        gate: {
          gateType: 'approval',
          message: 'literal gate message',
          assignee: 'literal reviewer',
        },
      },
    ]);
    for (const rail of [events, store.eventsFor(handle.runId)]) {
      const pauses = rail.filter((event) => event.type === 'human_gate:paused');
      expect(pauses).toHaveLength(1);
      expect(pauses[0]).toMatchObject({
        gateType: 'approval',
        message: 'literal gate message',
        assignee: 'literal reviewer',
      });
      expect(typeof pauses[0]?.gateId).toBe('string');
      expect(pauses[0]?.gateId.length).toBeGreaterThan(0);
      expect(rail.filter((event) => event.type === 'run:paused')).toHaveLength(1);
      expect(rail.filter((event) => event.type === 'run:completed')).toHaveLength(1);
      assertOrder(rail);
    }
  });
});
