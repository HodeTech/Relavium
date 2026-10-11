import { RunEventSchema, type RunEvent, type UsageInvocation } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { createCheckpointReconstructor, reconstructCheckpointState } from './checkpoint.js';

const base = (sequenceNumber: number) => ({
  runId: 'legacy-price-run',
  sequenceNumber,
  timestamp: '2026-10-10T00:00:00.000Z',
});
const valid = (event: RunEvent): RunEvent => RunEventSchema.parse(event);
const started = valid({
  ...base(0),
  type: 'run:started',
  workflowId: '00000000-0000-4000-8000-000000000001',
  inputs: {},
  executionMode: 'local',
});
const legacyCoverage = { unverified: true, pendingInvocations: 0, unknownCalls: 0 };
const invocation = (ordinal: number): UsageInvocation => ({
  producerId: 'resumed-owner',
  ordinal,
  dispatchId: 'agent-dispatch',
  round: ordinal - 1,
  chainAttempt: 1,
});

function settled(
  sequenceNumber: number,
  options: {
    readonly priced: boolean;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly costMicrocents?: number;
    readonly cumulativeCostMicrocents?: number;
    readonly cumulativeUnpricedCalls?: number;
    readonly invocation?: UsageInvocation;
  },
): RunEvent {
  return valid({
    ...base(sequenceNumber),
    type: 'cost:attempt_settled',
    nodeId: 'agent',
    model: options.priced ? 'known-text-model' : 'model-without-rate',
    attemptNumber: 1,
    inputTokens: 10,
    outputTokens: 3,
    costMicrocents: 0,
    cumulativeCostMicrocents: 0,
    ...options,
  });
}

function boundary(
  sequenceNumber: number,
  cumulativeCostMicrocents: number,
  cumulativeUnpricedCalls?: number,
): RunEvent {
  return valid({
    ...base(sequenceNumber),
    type: 'node:completed',
    nodeId: `node-${sequenceNumber}`,
    output: { useful: true },
    tokensUsed: { input: 10, output: 3 },
    durationMs: 1,
    cumulativeCostMicrocents,
    ...(cumulativeUnpricedCalls === undefined ? {} : { cumulativeUnpricedCalls }),
  });
}

function pending(sequenceNumber: number, ordinal: number): RunEvent {
  return valid({
    ...base(sequenceNumber),
    type: 'cost:usage_pending',
    nodeId: 'agent',
    model: 'model-without-rate',
    invocation: invocation(ordinal),
  });
}

describe('checkpoint price-gap compatibility (ADR-0104 / R10-MONEY-1)', () => {
  for (const tokens of [
    { inputTokens: 10, outputTokens: 3 },
    { inputTokens: 0, outputTokens: 0 },
  ]) {
    it(`retains a legacy missing price with ${tokens.inputTokens}/${tokens.outputTokens} known tokens`, () => {
      const state = reconstructCheckpointState([
        started,
        settled(1, { priced: true, costMicrocents: 125, cumulativeCostMicrocents: 125 }),
        settled(2, { priced: false, ...tokens, cumulativeCostMicrocents: 125 }),
        boundary(3, 125),
      ]);
      expect(state?.cumulativeUnpricedCalls).toBe(1);
      expect(state?.cumulativeCostMicrocents).toBe(125);
      expect(state?.conservativeCostMicrocents).toBe(0);
      expect(state?.usageCoverage?.coverage).toEqual(legacyCoverage);
      expect(state?.totalInputTokens).toBe(10);
      expect(state?.totalOutputTokens).toBe(3);
    });
  }

  for (const cumulativeUnpricedCalls of [undefined, 0]) {
    it(`does not invent a price gap for a priced zero with snapshot ${String(cumulativeUnpricedCalls)}`, () => {
      const state = reconstructCheckpointState([
        started,
        settled(1, {
          priced: true,
          inputTokens: 0,
          outputTokens: 0,
          ...(cumulativeUnpricedCalls === undefined ? {} : { cumulativeUnpricedCalls }),
        }),
      ]);
      expect(state?.cumulativeUnpricedCalls).toBe(0);
      expect(state?.cumulativeCostMicrocents).toBe(0);
      expect(state?.usageCoverage?.coverage).toEqual(legacyCoverage);
    });

    it(`restores an explicit false row with snapshot ${String(cumulativeUnpricedCalls)}`, () => {
      const state = reconstructCheckpointState([
        started,
        settled(1, {
          priced: false,
          ...(cumulativeUnpricedCalls === undefined ? {} : { cumulativeUnpricedCalls }),
        }),
      ]);
      expect(state?.cumulativeUnpricedCalls).toBe(1);
      expect(state?.cumulativeCostMicrocents).toBe(0);
      expect(state?.usageCoverage?.coverage).toEqual(legacyCoverage);
    });
  }

  it('keeps legacy price gaps through new coverage and a second unpriced invocation', () => {
    const events = [
      started,
      settled(1, { priced: false }),
      boundary(2, 0),
      valid({ ...base(3), type: 'cost:coverage_started', basis: 'legacy_unverified' }),
      pending(4, 1),
      settled(5, { priced: false, cumulativeUnpricedCalls: 2, invocation: invocation(1) }),
      boundary(6, 0, 2),
    ];
    const state = reconstructCheckpointState(events);
    expect(state?.cumulativeUnpricedCalls).toBe(2);
    expect(state?.cumulativeCostMicrocents).toBe(0);
    expect(state?.usageCoverage).toMatchObject({
      coverage: legacyCoverage,
      started: true,
      highWater: 1,
    });
    expect(reconstructCheckpointState(events)?.cumulativeUnpricedCalls).toBe(2);
  });

  it('does not count a current settlement again through its enclosing node snapshots', () => {
    const state = reconstructCheckpointState([
      started,
      valid({ ...base(1), type: 'cost:coverage_started', basis: 'complete' }),
      pending(2, 1),
      settled(3, { priced: false, cumulativeUnpricedCalls: 1, invocation: invocation(1) }),
      boundary(4, 0, 1),
      boundary(5, 0, 1),
    ]);
    expect(state?.cumulativeUnpricedCalls).toBe(1);
    expect(state?.usageCoverage?.coverage).toEqual({ ...legacyCoverage, unverified: false });
    expect(state?.cumulativeCostMicrocents).toBe(0);
  });

  it('does not add later ledger rows already covered by an ahead-of-ledger snapshot', () => {
    const reconstructor = createCheckpointReconstructor();
    for (const event of [started, boundary(1, 420, 3)]) reconstructor.apply(event);
    expect(reconstructor.finish()?.cumulativeUnpricedCalls).toBe(3);
    for (let sequenceNumber = 2; sequenceNumber <= 4; sequenceNumber++) {
      reconstructor.apply(
        settled(sequenceNumber, { priced: false, cumulativeCostMicrocents: 420 }),
      );
      expect(reconstructor.finish()?.cumulativeUnpricedCalls).toBe(3);
      expect(reconstructor.finish()?.cumulativeCostMicrocents).toBe(420);
    }
    expect(reconstructor.finish()?.usageCoverage?.coverage).toEqual(legacyCoverage);
  });

  it('counts subsequent uncovered legacy rows without finish mutating the incremental fold', () => {
    const reconstructor = createCheckpointReconstructor();
    reconstructor.apply(started);
    reconstructor.apply(settled(1, { priced: false }));
    const first = reconstructor.finish();
    expect(first?.cumulativeUnpricedCalls).toBe(1);
    expect(reconstructor.finish()?.cumulativeUnpricedCalls).toBe(1);
    reconstructor.apply(boundary(2, 0, 1));
    reconstructor.apply(settled(3, { priced: false }));
    expect(reconstructor.finish()?.cumulativeUnpricedCalls).toBe(2);
    expect(reconstructor.finish()?.cumulativeUnpricedCalls).toBe(2);
    expect(first?.cumulativeUnpricedCalls).toBe(1);
  });

  it('retains snapshot-only native media gaps and the greatest absolute snapshot', () => {
    const state = reconstructCheckpointState([
      started,
      boundary(1, 900, 2), // Native media has no cost:attempt_settled row.
      boundary(2, 900, 1), // A concurrently queued boundary can carry an older counter.
      settled(3, { priced: true, costMicrocents: 25, cumulativeCostMicrocents: 925 }),
      boundary(4, 925, 2),
      boundary(5, 900, 1), // Delayed older snapshot must not erase either known total.
    ]);
    expect(state?.cumulativeUnpricedCalls).toBe(2);
    expect(state?.cumulativeCostMicrocents).toBe(925);
    expect(state?.usageCoverage?.coverage).toEqual(legacyCoverage);
  });

  for (const evidence of [
    { kind: 'partial', known: { outputTokens: 3 }, reason: 'missing_fields' },
    { kind: 'missing', reason: 'not_reported' },
  ] as const) {
    it(`keeps ${evidence.kind} usage uncertainty distinct from a missing price`, () => {
      const state = reconstructCheckpointState([
        started,
        valid({ ...base(1), type: 'cost:coverage_started', basis: 'complete' }),
        pending(2, 1),
        valid({
          ...base(3),
          type: 'cost:usage_disposition',
          nodeId: 'agent',
          model: 'model-without-rate',
          invocation: invocation(1),
          disposition: { kind: 'incomplete', evidence },
        }),
        boundary(4, 0, 0),
      ]);
      expect(state?.cumulativeUnpricedCalls).toBe(0);
      expect(state?.cumulativeCostMicrocents).toBe(0);
      expect(state?.usageCoverage?.coverage).toEqual({
        unverified: false,
        pendingInvocations: 0,
        unknownCalls: 1,
      });
    });
  }

  it('keeps empty legacy history unverified without inventing a ledger or price gap', () => {
    const state = reconstructCheckpointState([started, boundary(1, 0)]);
    expect(state?.cumulativeUnpricedCalls).toBe(0);
    expect(state?.cumulativeCostMicrocents).toBe(0);
    expect(state?.usageCoverage?.coverage).toEqual(legacyCoverage);
  });
});
