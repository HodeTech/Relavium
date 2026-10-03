import { describe, expect, it } from 'vitest';
import { RunEventSchema, type RunEvent } from '@relavium/shared';

import { reconstructCheckpointState } from './checkpoint.js';

const timestamp = '2026-10-03T00:00:00.000Z';
const runId = 'budget-authorization-replay';

function event(sequenceNumber: number, fields: Readonly<Record<string, unknown>>): RunEvent {
  return RunEventSchema.parse({ runId, timestamp, sequenceNumber, ...fields });
}

const started = event(0, {
  type: 'run:started',
  workflowId: '00000000-0000-4000-8000-000000000001',
  inputs: {},
  executionMode: 'local',
});
const budgetPause = event(1, {
  type: 'budget:paused',
  nodeId: 'agent',
  gateId: 'budget-gate',
  spentMicrocents: 2,
  limitMicrocents: 1,
});

function humanPause(sequenceNumber: number, nodeId: string, gateId: string): RunEvent {
  return event(sequenceNumber, {
    type: 'human_gate:paused',
    nodeId,
    gateId,
    gateType: 'approval',
    message: 'Offline approval',
  });
}

function decision(sequenceNumber: number, nodeId: string, value: string): RunEvent {
  return event(sequenceNumber, {
    type: 'human_gate:resumed',
    nodeId,
    decision: value,
    decidedBy: 'offline-maintainer',
  });
}

describe('budget authorization checkpoint semantics — ADR-0097/0100, CR-96', () => {
  it('legacy budget approval restores a pending agent without an invented output', () => {
    const checkpoint = reconstructCheckpointState([
      started,
      budgetPause,
      humanPause(2, 'agent', 'budget-gate'),
      decision(3, 'agent', 'approved'),
    ]);

    expect(checkpoint).toBeDefined();
    expect(checkpoint?.completedNodeIds).not.toContain('agent');
    expect(checkpoint?.nodeStates.has('agent')).toBe(false);
    expect(checkpoint?.pendingGates).toEqual([]);
    expect(checkpoint?.resolvedGateIds).toEqual(['budget-gate']);
  });

  it('legacy rejection retains an explicit fatal budget cause with an ordinary sibling', () => {
    const checkpoint = reconstructCheckpointState([
      started,
      budgetPause,
      humanPause(2, 'human', 'human-gate'),
      decision(3, 'agent', 'rejected'),
    ]);

    expect(checkpoint?.nodeStates.get('agent')).toMatchObject({
      status: 'failed',
      error: { code: 'budget_exceeded', retryable: false },
    });
    expect(checkpoint).toMatchObject({
      budgetRejections: [{ nodeId: 'agent', gateId: 'budget-gate' }],
      pendingGates: [{ nodeId: 'human', gateId: 'human-gate', isBudgetGate: false }],
    });
  });

  it('an ordinary approval gate retains its actual human decision output', () => {
    const checkpoint = reconstructCheckpointState([
      started,
      humanPause(1, 'human', 'human-gate'),
      decision(2, 'human', 'approved'),
    ]);

    expect(checkpoint?.nodeStates.get('human')).toEqual({
      status: 'completed',
      output: { decision: 'approved' },
    });
    expect(checkpoint?.resolvedGateIds).toEqual(['human-gate']);
  });

  it('historical budget input_provided is a fatal rejection with no invented output', () => {
    const checkpoint = reconstructCheckpointState([
      started,
      budgetPause,
      event(2, {
        type: 'human_gate:resumed',
        nodeId: 'agent',
        decision: 'input_provided',
        decidedBy: 'historical-user',
        payload: { historical: 'answer' },
      }),
    ]);
    expect(checkpoint?.nodeStates.get('agent')).toMatchObject({
      status: 'failed',
      error: { code: 'budget_exceeded', retryable: false },
    });
    expect(checkpoint?.nodeStates.get('agent')).not.toHaveProperty('output');
    expect(checkpoint?.budgetRejections).toEqual([{ nodeId: 'agent', gateId: 'budget-gate' }]);
    expect(checkpoint?.pendingGates).toEqual([]);
  });
});
