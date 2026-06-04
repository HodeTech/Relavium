import { describe, expect, expectTypeOf, it } from 'vitest';

import { RUN_EVENT_TYPES } from './constants.js';
import { CostUpdatedEventSchema, RunEventSchema } from './run-event.js';
import type { RunEvent, RunEventType } from './index.js';

const envelope = { runId: 'run-1', timestamp: '2026-06-04T00:00:00.000Z', sequenceNumber: 7 };
const validCost = {
  type: 'cost:updated',
  ...envelope,
  nodeId: 'scan',
  model: 'claude-sonnet-4-6',
  inputTokens: 100,
  outputTokens: 50,
  costMicrocents: 1234,
  cumulativeCostMicrocents: 5678,
};

describe('RunEvent union', () => {
  it('covers exactly the canonical colon-namespaced names (runtime)', () => {
    const unionTypes = RunEventSchema.options.map((o) => o.shape.type.value).sort();
    expect(unionTypes).toEqual([...RUN_EVENT_TYPES].sort());
  });

  it('pins the RunEvent discriminant to RunEventType (type-level)', () => {
    expectTypeOf<RunEvent['type']>().toEqualTypeOf<RunEventType>();
  });

  it('accepts a valid cost:updated event', () => {
    expect(CostUpdatedEventSchema.safeParse(validCost).success).toBe(true);
    expect(RunEventSchema.safeParse(validCost).success).toBe(true);
  });

  it('pins cost:updated to integer micro-cents', () => {
    expect(CostUpdatedEventSchema.safeParse({ ...validCost, costMicrocents: 12.5 }).success).toBe(
      false,
    );
    expect(
      CostUpdatedEventSchema.safeParse({ ...validCost, cumulativeCostMicrocents: -1 }).success,
    ).toBe(false);
  });

  it('requires the full cost:updated payload', () => {
    const { costMicrocents, ...missing } = validCost;
    void costMicrocents;
    expect(CostUpdatedEventSchema.safeParse(missing).success).toBe(false);
  });

  it('rejects legacy dotted event names', () => {
    expect(RunEventSchema.safeParse({ ...validCost, type: 'cost.update' }).success).toBe(false);
  });

  it('rejects the non-canonical node:error / run:error names', () => {
    expect(RunEventSchema.safeParse({ ...envelope, type: 'node:error', nodeId: 'n' }).success).toBe(
      false,
    );
    expect(RunEventSchema.safeParse({ ...envelope, type: 'run:error' }).success).toBe(false);
  });
});
