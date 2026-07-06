import { describe, expect, it } from 'vitest';
import type { PricingOverlay } from '@relavium/llm';
import type { Budget } from '@relavium/shared';

import { BudgetExceededError, BudgetGovernor, BudgetPauseError } from './budget-governor.js';
import type { RunEventDraft } from './event-bus.js';

describe('BudgetGovernor', () => {
  const budget: Budget = { max_cost_microcents: 1_000_000, on_exceed: 'warn' };

  function makeGovernor(
    overrides: {
      budget?: Budget;
      defaultMaxTokensEstimate?: number;
      resolvePrice?: PricingOverlay;
    } = {},
  ): {
    governor: BudgetGovernor;
    warnings: Omit<Extract<RunEventDraft, { type: 'budget:warning' }>, 'runId'>[];
  } {
    const warnings: Omit<Extract<RunEventDraft, { type: 'budget:warning' }>, 'runId'>[] = [];
    const governor = new BudgetGovernor({
      budget: overrides.budget ?? budget,
      ...(overrides.defaultMaxTokensEstimate === undefined
        ? {}
        : { defaultMaxTokensEstimate: overrides.defaultMaxTokensEstimate }),
      ...(overrides.resolvePrice === undefined ? {} : { resolvePrice: overrides.resolvePrice }),
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

  it('the BudgetExceededError carries the spent / limit / projected cost figures', async () => {
    const { governor } = makeGovernor({ budget: { ...budget, on_exceed: 'fail' } });
    governor.updateCost(900_000);
    const err = await governor.checkPreEgress('claude-sonnet-4-6', 10_000).catch((e: unknown) => e);
    if (!(err instanceof BudgetExceededError)) throw new Error('expected a BudgetExceededError'); // narrow (no `as`)
    expect(err.spentMicrocents).toBe(900_000);
    expect(err.limitMicrocents).toBe(1_000_000);
    // sonnet output is $15/MTok = 1_500 micro-cents/token → 10_000 tok projects 15_000_000 on top of the
    // 900_000 already spent (the estimate is output-only).
    expect(err.projectedMicrocents).toBe(900_000 + 15_000_000);
    expect(err.projectedMicrocents).toBeGreaterThan(err.limitMicrocents);
  });

  it('pauses when on_exceed is pause_for_approval', async () => {
    const { governor } = makeGovernor({ budget: { ...budget, on_exceed: 'pause_for_approval' } });
    governor.updateCost(900_000);
    const err = await governor.checkPreEgress('claude-sonnet-4-6', 10_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetPauseError);
    if (!(err instanceof BudgetPauseError)) throw new Error('expected a BudgetPauseError'); // narrow (no `as`)
    const gate = err.toGateRequest();
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

  it('treats max_cost_microcents: 0 as unbounded — always allows, never divides by zero', async () => {
    // 0 = unbounded ([chat] semantics). The governor must never block and never reach the thresholdPct
    // division (cumulative / 0 → NaN). Even far "over" a 0 cap, every check resolves with no warning.
    const { governor, warnings } = makeGovernor({
      budget: { max_cost_microcents: 0, on_exceed: 'fail' },
    });
    governor.updateCost(5_000_000);
    await expect(governor.checkPreEgress('claude-sonnet-4-6', 10_000)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  it('degrades to allow (does not crash the run) for an unlisted/unpriced model — H4', async () => {
    // An unpriced custom/self-hosted model id has no pricing row → estimateMaxNextCost throws
    // UnknownModelError. The pre-egress governor must NOT hard-fail an otherwise-valid run on it; it
    // degrades to `allow` (mirrors the FallbackChain's unpriced⇒no-cost policy). Even with on_exceed: fail
    // and the run already over a notional cap, an unpriced model resolves rather than throwing.
    const { governor, warnings } = makeGovernor({ budget: { ...budget, on_exceed: 'fail' } });
    governor.updateCost(900_000);
    await expect(governor.checkPreEgress('my-self-hosted-model', 10_000)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  it('accepts a media-unit estimate and folds it as a disjoint addend (1.AF/D17)', () => {
    // No 1.AF model carries a media rate, so the media estimate degrades to 0 — the decision matches the
    // token-only projection (the units×rate math is covered in mediaCost/estimateMediaCost). This pins the
    // wiring: the governor accepts the estimate and never crashes/over-blocks on a media-output turn.
    const { governor } = makeGovernor();
    governor.updateCost(0);
    const tokenOnly = governor.evaluatePreEgress('claude-haiku-4-5', 1000);
    const withMedia = governor.evaluatePreEgress('claude-haiku-4-5', 1000, [
      { modality: 'image', units: 4 },
      { modality: 'audio', units: 30 },
    ]);
    expect(withMedia).toEqual(tokenOnly); // media adds 0 (unrated model) — decision unchanged
    expect(withMedia.kind).toBe('allow');
  });

  it('an unpriced model still degrades to allow even WITH a media estimate (H4)', async () => {
    const { governor } = makeGovernor({ budget: { ...budget, on_exceed: 'fail' } });
    governor.updateCost(900_000);
    await expect(
      governor.checkPreEgress('my-self-hosted-model', 10_000, [{ modality: 'image', units: 2 }]),
    ).resolves.toBeUndefined();
  });

  describe('user-pricing overlay (2.5.G S10, ADR-0065 §2 — closes the cost-cap gap)', () => {
    // A user price for a model the static registry does not know — output $9/MTok so 10_000 tok ⇒ 90_000µ¢.
    const OVERLAY: PricingOverlay = new Map([
      [
        'acme-custom-1',
        {
          provider: 'openai',
          nativeId: 'acme-custom-1',
          displayName: 'Acme Custom 1',
          contextWindowTokens: 32_000,
          maxOutputTokens: 4_000,
          inputPerMtokMicrocents: 300_000_000,
          outputPerMtokMicrocents: 900_000_000,
          cachedInputPerMtokMicrocents: 0,
        },
      ],
    ]);

    it('ENFORCES the cap on a user-priced model that WOULD have degraded to allow without the overlay', async () => {
      // THE ACCEPTANCE: with the overlay, `acme-custom-1` is priced, so the projected 9_000_000µ¢ (10_000 out
      // @ $9/MTok) far exceeds the 1_000_000µ¢ cap → fail (not the old silent degrade-to-allow).
      const { governor } = makeGovernor({
        budget: { ...budget, on_exceed: 'fail' },
        resolvePrice: OVERLAY,
      });
      governor.updateCost(0);
      await expect(governor.checkPreEgress('acme-custom-1', 10_000)).rejects.toBeInstanceOf(
        BudgetExceededError,
      );
    });

    it('the SAME model WITHOUT the overlay degrades to allow (proves the overlay is what closes the gap)', async () => {
      const { governor } = makeGovernor({ budget: { ...budget, on_exceed: 'fail' } });
      governor.updateCost(0);
      await expect(governor.checkPreEgress('acme-custom-1', 10_000)).resolves.toBeUndefined();
    });

    it('a user-priced model UNDER the cap is allowed (no false positive)', async () => {
      // 1_000 output tokens @ $9/MTok = 900_000µ¢, under the 1_000_000µ¢ cap → allow, no warning (warn-cap is 0.9).
      const { governor, warnings } = makeGovernor({
        budget: { ...budget, on_exceed: 'fail' },
        resolvePrice: OVERLAY,
      });
      governor.updateCost(0);
      await expect(governor.checkPreEgress('acme-custom-1', 1_000)).resolves.toBeUndefined();
      expect(warnings).toHaveLength(0);
    });
  });
});
