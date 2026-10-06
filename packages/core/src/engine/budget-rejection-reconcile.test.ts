import { describe, expect, it, vi } from 'vitest';
import { RunEventSchema, type RunEvent } from '@relavium/shared';

import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import type { NodeOutcome } from './node-executor.js';

const event = (sequenceNumber: number, fields: Record<string, unknown>): RunEvent =>
  RunEventSchema.parse({
    runId: 'interrupted-budget',
    timestamp: '2026-10-04T00:00:00.000Z',
    sequenceNumber,
    ...fields,
  });

async function seed(
  store: InMemoryRunStore,
  kind: 'authority' | 'legacy' | 'human',
  decision: 'approved' | 'rejected',
  companion = false,
  sibling = false,
): Promise<void> {
  await store.persistEvent(
    event(0, {
      type: 'run:started',
      workflowId: '00000000-0000-4000-8000-000000000001',
      inputs: {},
      executionMode: 'local',
    }),
  );
  await store.persistEvent(
    event(1, {
      nodeId: 'agent',
      gateId: 'gate',
      ...(kind === 'authority'
        ? {
            type: 'budget:authorization',
            authorization: {
              state: 'paused',
              allowance: { kind: 'legacy_no_allowance' },
              spentMicrocents: 2,
              limitMicrocents: 1,
            },
          }
        : kind === 'legacy'
          ? { type: 'budget:paused', spentMicrocents: 2, limitMicrocents: 1 }
          : { type: 'human_gate:paused', gateType: 'approval', message: 'ordinary approval' }),
    }),
  );
  await store.persistEvent(
    event(2, {
      nodeId: 'agent',
      ...(kind === 'authority'
        ? {
            type: 'budget:authorization',
            gateId: 'gate',
            authorization: {
              state: 'decided',
              allowance: { kind: 'legacy_no_allowance' },
              decision,
              decidedBy: 'operator',
            },
          }
        : { type: 'human_gate:resumed', decision, decidedBy: 'operator' }),
    }),
  );
  if (companion)
    await store.persistEvent(
      event(3, {
        type: 'human_gate:resumed',
        nodeId: 'agent',
        gateId: 'gate',
        decision,
        decidedBy: 'operator',
      }),
    );
  if (sibling)
    await store.persistEvent(
      event(companion ? 4 : 3, {
        type: 'human_gate:paused',
        nodeId: 'sibling',
        gateId: 'sibling-gate',
        gateType: 'approval',
        message: 'another outstanding gate',
      }),
    );
}

describe('interrupted budget rejection retains its failure reason', () => {
  for (const [kind, companion] of [
    ['authority', false],
    ['authority', true],
    ['legacy', false],
  ] as const)
    it(`reconciles ${kind} rejection (companion=${companion}) without dispatch or a second terminal`, async () => {
      const store = new InMemoryRunStore();
      await seed(store, kind, 'rejected', companion);
      const before = [...store.eventsFor('interrupted-budget')];
      const execute = vi.fn(() => Promise.resolve<NodeOutcome>({ kind: 'completed', output: '' }));
      const engine = new WorkflowEngine({
        host: createInMemoryHost({ store }),
        executor: { execute },
      });
      const reconciled = await engine.reconcile();
      expect(reconciled).toHaveLength(1);
      expect(reconciled[0]).toMatchObject({
        type: 'run:failed',
        runId: 'interrupted-budget',
        sequenceNumber: (before.at(-1)?.sequenceNumber ?? -1) + 1,
        error: { code: 'budget_exceeded', retryable: false },
        partialOutputs: {},
      });
      expect(execute).not.toHaveBeenCalled();
      expect(store.eventsFor('interrupted-budget').slice(0, before.length)).toEqual(before);
      expect(await engine.reconcile()).toEqual([]);
      expect(
        store.eventsFor('interrupted-budget').filter((row) => row.type === 'run:failed'),
      ).toHaveLength(1);
    });

  for (const [kind, decision] of [
    ['authority', 'approved'],
    ['human', 'rejected'],
  ] as const)
    it(`does not invent a budget rejection for ${kind} ${decision}`, async () => {
      const store = new InMemoryRunStore();
      await seed(store, kind, decision);
      const execute = vi.fn(() => Promise.resolve<NodeOutcome>({ kind: 'completed', output: '' }));
      const engine = new WorkflowEngine({
        host: createInMemoryHost({ store }),
        executor: { execute },
      });
      const [reconciled] = await engine.reconcile();
      expect(reconciled).toMatchObject({ type: 'run:failed', error: { code: 'internal' } });
      expect(execute).not.toHaveBeenCalled();
    });

  it('leaves an outstanding sibling gate and all recorded rejection evidence available for resume', async () => {
    const store = new InMemoryRunStore();
    await seed(store, 'authority', 'rejected', true, true);
    const before = [...store.eventsFor('interrupted-budget')];
    const execute = vi.fn(() => Promise.resolve<NodeOutcome>({ kind: 'completed', output: '' }));
    const engine = new WorkflowEngine({
      host: createInMemoryHost({ store }),
      executor: { execute },
    });
    expect(await engine.reconcile()).toEqual([]);
    expect(store.eventsFor('interrupted-budget')).toEqual(before);
    expect(execute).not.toHaveBeenCalled();
  });
});
