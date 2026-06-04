import { describe, expect, expectTypeOf, it } from 'vitest';

import { RUN_EVENT_TYPES } from './constants.js';
import { CostUpdatedEventSchema, RunEventSchema } from './run-event.js';
import type { RunEvent, RunEventType } from './index.js';

const env = { runId: 'run-1', timestamp: '2026-06-04T00:00:00.000Z', sequenceNumber: 7 };

/** One canonical valid payload per RunEvent variant (sse-event-schema.md). */
const valid: Record<string, Record<string, unknown>> = {
  'run:started': {
    type: 'run:started',
    ...env,
    workflowId: 'b1a2c3d4-0000-4000-8000-000000000000', // workflows.id UUID (ADR-0022)
    inputs: {},
    executionMode: 'local',
  },
  'node:started': { type: 'node:started', ...env, nodeId: 'n', nodeType: 'agent' },
  'agent:token': {
    type: 'agent:token',
    ...env,
    nodeId: 'n',
    token: 'hi',
    model: 'claude-sonnet-4-6',
  },
  'agent:tool_call': {
    type: 'agent:tool_call',
    ...env,
    nodeId: 'n',
    model: 'claude-sonnet-4-6',
    toolId: 'read_file',
    toolInput: { path: 'x' },
  },
  'agent:tool_result': {
    type: 'agent:tool_result',
    ...env,
    nodeId: 'n',
    toolId: 'read_file',
    success: true,
    outputSummary: 'ok',
  },
  'cost:updated': {
    type: 'cost:updated',
    ...env,
    nodeId: 'n',
    model: 'claude-sonnet-4-6',
    inputTokens: 100,
    outputTokens: 50,
    costMicrocents: 1234,
    cumulativeCostMicrocents: 5678,
  },
  'node:completed': {
    type: 'node:completed',
    ...env,
    nodeId: 'n',
    output: {},
    tokensUsed: { input: 1, output: 2, model: 'm' },
    durationMs: 100,
  },
  'node:failed': {
    type: 'node:failed',
    ...env,
    nodeId: 'n',
    error: { code: 'E_X', message: 'boom', retryable: false },
  },
  'human_gate:paused': {
    type: 'human_gate:paused',
    ...env,
    nodeId: 'n',
    gateId: 'g1',
    gateType: 'approval',
    message: 'approve?',
  },
  'human_gate:resumed': {
    type: 'human_gate:resumed',
    ...env,
    nodeId: 'n',
    decision: 'approved',
    decidedBy: 'user-1',
  },
  'run:completed': {
    type: 'run:completed',
    ...env,
    outputs: {},
    totalTokensUsed: { input: 1, output: 2 },
    totalCostMicrocents: 999,
    durationMs: 100,
  },
  'run:failed': {
    type: 'run:failed',
    ...env,
    error: { code: 'E_X', message: 'boom' },
    partialOutputs: {},
  },
  'run:cancelled': { type: 'run:cancelled', ...env },
};

/** One targeted invalid payload per variant (a missing/invalid required field). */
const reject: Record<string, Record<string, unknown>> = {
  'run:started (bad executionMode)': {
    type: 'run:started',
    ...env,
    workflowId: 'b1a2c3d4-0000-4000-8000-000000000000', // valid UUID — isolate the executionMode failure
    inputs: {},
    executionMode: 'turbo',
  },
  'run:started (bad workflowId)': {
    type: 'run:started',
    ...env,
    workflowId: 'wf', // not a UUID (ADR-0022) — isolate the workflowId failure
    inputs: {},
    executionMode: 'local',
  },
  'node:started (missing nodeType)': { type: 'node:started', ...env, nodeId: 'n' },
  'agent:token (missing model)': { type: 'agent:token', ...env, nodeId: 'n', token: 'hi' },
  'agent:tool_call (missing toolId)': {
    type: 'agent:tool_call',
    ...env,
    nodeId: 'n',
    model: 'm',
    toolInput: {},
  },
  'agent:tool_call (missing model)': {
    type: 'agent:tool_call',
    ...env,
    nodeId: 'n',
    toolId: 'read_file',
    toolInput: {},
  },
  'agent:tool_result (missing success)': {
    type: 'agent:tool_result',
    ...env,
    nodeId: 'n',
    toolId: 't',
    outputSummary: 'ok',
  },
  'cost:updated (float costMicrocents)': { ...valid['cost:updated'], costMicrocents: 12.5 },
  'node:completed (bad tokensUsed)': {
    type: 'node:completed',
    ...env,
    nodeId: 'n',
    output: {},
    tokensUsed: { input: 1 },
    durationMs: 100,
  },
  'node:failed (missing error)': { type: 'node:failed', ...env, nodeId: 'n' },
  'human_gate:paused (bad gateType)': {
    type: 'human_gate:paused',
    ...env,
    nodeId: 'n',
    gateId: 'g',
    gateType: 'sign-off',
    message: 'm',
  },
  'human_gate:resumed (bad decision)': {
    type: 'human_gate:resumed',
    ...env,
    nodeId: 'n',
    decision: 'maybe',
    decidedBy: 'u',
  },
  'run:completed (missing outputs)': {
    type: 'run:completed',
    ...env,
    totalTokensUsed: { input: 1, output: 2 },
    totalCostMicrocents: 0,
    durationMs: 100,
  },
  'run:completed (missing totalCostMicrocents)': {
    type: 'run:completed',
    ...env,
    outputs: {},
    totalTokensUsed: { input: 1, output: 2 },
    durationMs: 100,
  },
  'run:failed (missing partialOutputs)': {
    type: 'run:failed',
    ...env,
    error: { code: 'E', message: 'm' },
  },
  'run:cancelled (negative sequenceNumber)': { type: 'run:cancelled', ...env, sequenceNumber: -1 },
};

describe('RunEvent union — every variant', () => {
  it.each(Object.keys(valid))('accepts a valid %s', (name) => {
    expect(RunEventSchema.safeParse(valid[name]).success).toBe(true);
  });

  it.each(Object.keys(reject))('rejects %s', (name) => {
    expect(RunEventSchema.safeParse(reject[name]).success).toBe(false);
  });

  it('covers exactly the 13 canonical colon-namespaced names, pinned to a literal list', () => {
    // A hardcoded contract list — independent of RUN_EVENT_TYPES — so the union and the
    // constant cannot silently drift together.
    const CONTRACT_NAMES = [
      'run:started',
      'node:started',
      'agent:token',
      'agent:tool_call',
      'agent:tool_result',
      'cost:updated',
      'node:completed',
      'node:failed',
      'human_gate:paused',
      'human_gate:resumed',
      'run:completed',
      'run:failed',
      'run:cancelled',
    ];
    // The matrix above proves each canonical name's valid payload parses (so a
    // renamed/missing variant fails there); the union member count catches an *extra*
    // variant — without reaching into Zod's internal schema representation.
    expect(RunEventSchema.options).toHaveLength(CONTRACT_NAMES.length);
    expect(new Set(RUN_EVENT_TYPES)).toEqual(new Set(CONTRACT_NAMES));
    expect(Object.keys(valid)).toEqual(CONTRACT_NAMES); // the matrix covers all 13
  });

  it('pins the RunEvent discriminant to RunEventType (type-level)', () => {
    expectTypeOf<RunEvent['type']>().toEqualTypeOf<RunEventType>();
  });
});

describe('cost:updated and sequenceNumber invariants', () => {
  it('pins cost:updated to integer micro-cents', () => {
    const ok = valid['cost:updated'];
    expect(CostUpdatedEventSchema.safeParse(ok).success).toBe(true);
    expect(CostUpdatedEventSchema.safeParse({ ...ok, costMicrocents: 12.5 }).success).toBe(false);
    expect(CostUpdatedEventSchema.safeParse({ ...ok, cumulativeCostMicrocents: -1 }).success).toBe(
      false,
    );
  });

  it('accepts an optional 1-based attemptNumber on cost:updated, rejects non-positive', () => {
    const ok = valid['cost:updated'];
    expect(CostUpdatedEventSchema.safeParse({ ...ok, attemptNumber: 2 }).success).toBe(true);
    expect(CostUpdatedEventSchema.safeParse({ ...ok, attemptNumber: 0 }).success).toBe(false);
  });

  it('accepts sequenceNumber 0 but rejects negative / fractional', () => {
    const cancelled = { type: 'run:cancelled', ...env };
    expect(RunEventSchema.safeParse({ ...cancelled, sequenceNumber: 0 }).success).toBe(true);
    expect(RunEventSchema.safeParse({ ...cancelled, sequenceNumber: -1 }).success).toBe(false);
    expect(RunEventSchema.safeParse({ ...cancelled, sequenceNumber: 1.5 }).success).toBe(false);
  });

  it('accepts the human-gate events with their optional fields present', () => {
    expect(
      RunEventSchema.safeParse({
        ...valid['human_gate:paused'],
        assignee: 'reviewer@example.com',
        timeoutMs: 1000,
        expiresAt: '2026-06-04T01:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      RunEventSchema.safeParse({ ...valid['human_gate:resumed'], payload: { input: 'yes' } })
        .success,
    ).toBe(true);
  });

  it('rejects a non-ISO-8601 timestamp', () => {
    expect(
      RunEventSchema.safeParse({ ...env, type: 'run:cancelled', timestamp: 'June 4 2026' }).success,
    ).toBe(false);
  });

  it('rejects legacy dotted and non-canonical event names', () => {
    expect(
      RunEventSchema.safeParse({ ...valid['cost:updated'], type: 'cost.update' }).success,
    ).toBe(false);
    expect(RunEventSchema.safeParse({ ...env, type: 'node:error', nodeId: 'n' }).success).toBe(
      false,
    );
    expect(RunEventSchema.safeParse({ ...env, type: 'run:error' }).success).toBe(false);
  });
});
