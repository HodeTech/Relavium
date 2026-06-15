import { describe, expect, it } from 'vitest';
import type { Budget } from '@relavium/shared';

import { BudgetExceededError, BudgetGovernor, BudgetPauseError } from './budget-governor.js';
import type { RunEventDraft } from './event-bus.js';

describe('BudgetGovernor', () => {
  const budget: Budget = { max_cost_microcents: 1_000_000, on_exceed: 'warn' };

  function makeGovernor(overrides: { budget?: Budget; defaultMaxTokensEstimate?: number } = {}): {
    governor: BudgetGovernor;
    warnings: Omit<Extract<RunEventDraft, { type: 'budget:warning' }>, 'runId'>[];
  } {
    const warnings: Omit<Extract<RunEventDraft, { type: 'budget:warning' }>, 'runId'>[] = [];
    const governor = new BudgetGovernor({
      budget: overrides.budget ?? budget,
      ...(overrides.defaultMaxTokensEstimate === undefined
        ? {}
        : { defaultMaxTokensEstimate: overrides.defaultMaxTokensEstimate }),
      emit: (event) => {
        warnings.push(event);
        return Promise.resolve();
      },
    });
    return { governor, warnings };
  }

  it('allows a call whose estimate stays within the cap', async () => {
    const { governor, warnings } = makeGovernor();
    governor.updateCost(0);
    await expect(governor.checkPreEgress('claude-haiku-4-5', 1000)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  it('warns once when the projected cost exceeds the cap', async () => {
    const { governor, warnings } = makeGovernor();
    governor.updateCost(900_000);
    await governor.checkPreEgress('claude-sonnet-4-6', 10_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.thresholdPct).toBe(90);
    // A second check does not emit another warning.
    await governor.checkPreEgress('claude-sonnet-4-6', 10_000);
    expect(warnings).toHaveLength(1);
  });

  it('fails when on_exceed is fail', async () => {
    const { governor } = makeGovernor({ budget: { ...budget, on_exceed: 'fail' } });
    governor.updateCost(900_000);
    await expect(governor.checkPreEgress('claude-sonnet-4-6', 10_000)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it('pauses when on_exceed is pause_for_approval', async () => {
    const { governor } = makeGovernor({ budget: { ...budget, on_exceed: 'pause_for_approval' } });
    governor.updateCost(900_000);
    const err = await governor.checkPreEgress('claude-sonnet-4-6', 10_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetPauseError);
    const gate = (err as BudgetPauseError).toGateRequest();
    expect(gate.gateType).toBe('approval');
    expect(gate.message).toContain('budget cap');
    expect(gate.spentMicrocents).toBe(900_000);
    expect(gate.limitMicrocents).toBe(1_000_000);
  });

  it('uses the default max_tokens_estimate when maxTokens is omitted', async () => {
    const { governor, warnings } = makeGovernor({
      budget: { ...budget, on_exceed: 'warn' },
      defaultMaxTokensEstimate: 1,
    });
    // At exactly the cap minus the default estimate, the call is allowed.
    governor.updateCost(1_000_000 - 500); // haiku output is 500_000_000 micro-cents/MTok
    await governor.checkPreEgress('claude-haiku-4-5', undefined);
    expect(warnings).toHaveLength(0);
  });

  it('clamps thresholdPct to [0, 100]', async () => {
    const { governor, warnings } = makeGovernor();
    governor.updateCost(2_000_000);
    await governor.checkPreEgress('claude-sonnet-4-6', 1000);
    expect(warnings[0]?.thresholdPct).toBe(100);
  });
});
