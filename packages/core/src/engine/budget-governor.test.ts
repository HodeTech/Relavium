import { describe, expect, it } from 'vitest';
import {
  estimateMaxNextCost,
  type EndpointKind,
  type PricingOverlay,
  type ProviderId,
} from '@relavium/llm';
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
      resolveEndpoint?: (provider: ProviderId) => EndpointKind;
    } = {},
  ): {
    governor: BudgetGovernor;
    warnings: Omit<Extract<RunEventDraft, { type: 'budget:warning' }>, 'runId'>[];
    unpriced: string[];
  } {
    const warnings: Omit<Extract<RunEventDraft, { type: 'budget:warning' }>, 'runId'>[] = [];
    const unpriced: string[] = [];
    const governor = new BudgetGovernor({
      budget: overrides.budget ?? budget,
      ...(overrides.defaultMaxTokensEstimate === undefined
        ? {}
        : { defaultMaxTokensEstimate: overrides.defaultMaxTokensEstimate }),
      ...(overrides.resolvePrice === undefined ? {} : { resolvePrice: overrides.resolvePrice }),
      ...(overrides.resolveEndpoint === undefined
        ? {}
        : { resolveEndpoint: overrides.resolveEndpoint }),
      onUnpriced: (model) => unpriced.push(model),
      emit: (event) => {
        warnings.push(event);
        return Promise.resolve();
      },
    });
    return { governor, warnings, unpriced };
  }

  it('allows a call whose estimate stays within the cap', async () => {
    const { governor, warnings } = makeGovernor();
    governor.updateCost(0);
    const admission = await governor.checkPreEgress('claude-haiku-4-5', 1000);
    expect(admission).toBeDefined();
    admission?.release();
    expect(warnings).toHaveLength(0);
  });

  it('dedupes an unchanged overage, then re-arms after realized spend with the projected threshold', async () => {
    const { governor, warnings } = makeGovernor();
    governor.updateCost(900_000);
    const first = await governor.checkPreEgress('claude-sonnet-4-6', 10_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.spentMicrocents).toBe(900_000);
    // The estimate carries the projection far beyond the cap, so the advisory percentage describes the proposed
    // post-call state rather than the misleading pre-call 90% value.
    expect(warnings[0]?.thresholdPct).toBe(100);

    // The same standing condition is one notice, even though warn mode admits both calls.
    const duplicate = await governor.checkPreEgress('claude-sonnet-4-6', 10_000);
    expect(warnings).toHaveLength(1);
    duplicate?.release();

    // A successful attempt replaces its reservation with actual spend. That new spend re-arms the advisory path
    // for a long-lived session, rather than leaving it permanently silent after its first overage.
    first?.settle(100_000);
    governor.updateCost(1_000_000); // mirrors the authoritative engine/session cost event after settlement
    const continued = await governor.checkPreEgress('claude-sonnet-4-6', 10_000);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]?.spentMicrocents).toBe(1_000_000);
    expect(warnings[1]?.thresholdPct).toBe(100);
    continued?.release();
  });

  it('atomically reserves a priced call so a concurrent admission cannot overspend the cap', async () => {
    const estimatedCallCost = estimateMaxNextCost('claude-haiku-4-5', 1000);
    const { governor } = makeGovernor({
      budget: {
        max_cost_microcents: estimatedCallCost + Math.floor(estimatedCallCost / 2),
        on_exceed: 'fail',
      },
    });

    const first = await governor.checkPreEgress('claude-haiku-4-5', 1000);
    expect(first).toBeDefined();
    await expect(governor.checkPreEgress('claude-haiku-4-5', 1000)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );

    // A failed/cancelled attempt has no attributable charge, so its reservation releases capacity for the next one.
    first?.release();
    const retry = await governor.checkPreEgress('claude-haiku-4-5', 1000);
    expect(retry).toBeDefined();
    retry?.release();
  });

  it('reconciles one reservation with realized cost exactly once before the engine syncs its total', async () => {
    const estimatedCallCost = estimateMaxNextCost('claude-haiku-4-5', 1000);
    const { governor } = makeGovernor({
      budget: { max_cost_microcents: estimatedCallCost + 100_000, on_exceed: 'fail' },
    });

    const first = await governor.checkPreEgress('claude-haiku-4-5', 1000);
    expect(first).toBeDefined();
    first?.settle(100_000);
    first?.settle(999_999); // idempotent: an accidental second completion cannot inflate the ledger
    first?.release();

    // The reservation is gone, but its actual charge remains. The later authoritative sync is the same total,
    // not a second charge, so a next call exactly at the cap is still admitted.
    governor.updateCost(100_000);
    const next = await governor.checkPreEgress('claude-haiku-4-5', 1000);
    expect(next).toBeDefined();
    next?.release();
  });

  it('rolls back a warning-path reservation when warning durability fails', async () => {
    const estimatedCallCost = estimateMaxNextCost('claude-haiku-4-5', 1000);
    let shouldFail = true;
    let emits = 0;
    const governor = new BudgetGovernor({
      budget: {
        max_cost_microcents: estimatedCallCost + Math.floor(estimatedCallCost / 2),
        on_exceed: 'warn',
      },
      emit: () => {
        emits += 1;
        return shouldFail
          ? Promise.reject(new Error('durable warning sink failed'))
          : Promise.resolve();
      },
    });
    governor.updateCost(Math.floor(estimatedCallCost / 2) + 1); // pushes the next call into warn mode

    await expect(governor.checkPreEgress('claude-haiku-4-5', 1000)).rejects.toThrow(
      'durable warning sink failed',
    );

    // Restore a below-cap authoritative state. A leaked reservation would turn this otherwise-allowed call back
    // into warn mode and invoke the sink a second time.
    shouldFail = false;
    governor.updateCost(0);
    const admission = await governor.checkPreEgress('claude-haiku-4-5', 1000);
    expect(emits).toBe(1);
    admission?.release();
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
    const admission = await governor.checkPreEgress('claude-haiku-4-5', undefined);
    admission?.release();
    expect(warnings).toHaveLength(0);
  });

  it('clamps thresholdPct to [0, 100]', async () => {
    const { governor, warnings } = makeGovernor();
    governor.updateCost(2_000_000);
    const admission = await governor.checkPreEgress('claude-sonnet-4-6', 1000);
    admission?.release();
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

  it('degrades to allow (does not crash the run) for any unlisted/unpriced model when strict mode is off', async () => {
    // An unpriced model id has no pricing row → estimateMaxNextCost throws UnknownModelError. With strict mode off,
    // the governor deliberately permits BOTH custom/self-hosted ids and first-party catalog gaps, because it has no
    // trustworthy price estimate for either. It says so once rather than silently pretending the cap applied.
    const { governor, warnings, unpriced } = makeGovernor({
      budget: { ...budget, on_exceed: 'fail' },
    });
    governor.updateCost(900_000);
    await expect(governor.checkPreEgress('my-self-hosted-model', 10_000)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(0); // it did not exceed — nothing WAS billed
    // …but it is UNPRICED, so the cap could not apply, and that is said once (ADR-0071 §K7): a cap that silently
    // does not apply is a false sense of safety.
    expect(unpriced).toEqual(['my-self-hosted-model']);
  });

  describe('strict_cost_cap (ADR-0071 §K7)', () => {
    it('BLOCKS every unpriced model when on — "if you cannot price it, do not run it"', () => {
      // Strict mode intentionally makes no provenance distinction at this seam: both a self-hosted id and a
      // first-party catalog gap are unpriced, so both would leave a user-requested cap unenforceable.
      const { governor } = makeGovernor({
        budget: { ...budget, on_exceed: 'fail', strict_cost_cap: true },
      });
      for (const model of ['my-self-hosted-model', 'unlisted-first-party-model']) {
        const result = governor.evaluatePreEgress(model, 10_000);
        expect(result.kind).toBe('fail');
        if (result.kind === 'fail') {
          expect(result.error.message).toContain('no price');
          expect(result.error.message).toContain('strict_cost_cap');
        }
      }
    });

    it('does NOT block a PRICED model — strict only bites when we genuinely cannot price', () => {
      const { governor } = makeGovernor({
        budget: { ...budget, on_exceed: 'fail', strict_cost_cap: true },
      });
      governor.updateCost(0);
      expect(governor.evaluatePreEgress('claude-haiku-4-5', 1000).kind).toBe('allow');
    });

    it('OFF (the default) permits every unpriced model with a notice, not a block', async () => {
      const { governor, unpriced } = makeGovernor({ budget: { ...budget, on_exceed: 'fail' } });
      // `evaluatePreEgress` classifies; `checkPreEgress` is what APPLIES the result and fires the sink. Drive the
      // applying path, so the "with a notice" in this test's name is actually asserted.
      expect(governor.evaluatePreEgress('my-self-hosted-model', 10_000).kind).toBe('unpriced');
      await expect(
        governor.checkPreEgress('my-self-hosted-model', 10_000),
      ).resolves.toBeUndefined();
      expect(unpriced).toEqual(['my-self-hosted-model']);
    });

    it('is inert without a positive cap, even when strict mode is on', async () => {
      const { governor, unpriced } = makeGovernor({
        budget: { max_cost_microcents: 0, on_exceed: 'fail', strict_cost_cap: true },
      });
      await expect(
        governor.checkPreEgress('unlisted-first-party-model', 10_000),
      ).resolves.toBeUndefined();
      expect(unpriced).toEqual([]);
    });
  });

  it('notifies UNPRICED only once per model — a loop must not repeat it every turn', async () => {
    const { governor, unpriced } = makeGovernor();
    await governor.checkPreEgress('my-self-hosted-model', 1000);
    await governor.checkPreEgress('my-self-hosted-model', 1000);
    await governor.checkPreEgress('another-unpriced-one', 1000);
    expect(unpriced).toEqual(['my-self-hosted-model', 'another-unpriced-one']); // deduped per model
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
    // A user price for a model the static registry does not know — output $9/MTok so 10_000 tok ⇒ 9_000_000µ¢.
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
      const admission = await governor.checkPreEgress('acme-custom-1', 1_000);
      expect(admission).toBeDefined();
      admission?.release();
      expect(warnings).toHaveLength(0);
    });
  });

  describe('endpoint keys on the ROUTING provider, not the model catalog (review M2)', () => {
    // A custom `openai` gateway (OpenRouter/LiteLLM) serving `deepseek-v4-flash`: the wire is UNCLAMPED (a gateway
    // may serve anything under a familiar id), so the estimate must reflect the FULL request — keyed on the routing
    // provider ('openai' = custom here), never the model's catalog provider ('deepseek' = official) which clamps to
    // the ceiling and under-authorizes. Before M2, resolveEndpoint(model)→catalog provider→official→clamp→allow.
    const HUGE = 10_000_000;
    const resolveEndpoint = (provider: ProviderId): EndpointKind =>
      provider === 'openai' ? 'custom' : 'official';

    it('routes the endpoint by the provider argument — same model, opposite clamp', () => {
      const official = estimateMaxNextCost('deepseek-v4-flash', HUGE, undefined, 'official');
      const custom = estimateMaxNextCost('deepseek-v4-flash', HUGE, undefined, 'custom');
      expect(custom).toBeGreaterThan(official); // the catalog ceiling clamp is real for this model

      // A cap between the clamped and unclamped cost: official passes, custom must not.
      const cap = official + Math.round((custom - official) / 2);
      const { governor } = makeGovernor({
        budget: { max_cost_microcents: cap, on_exceed: 'fail' },
        resolveEndpoint,
      });
      governor.updateCost(0);

      // On its own API (official) → clamped to the ceiling → under the cap → allow.
      expect(
        governor.evaluatePreEgress('deepseek-v4-flash', HUGE, undefined, 'deepseek').kind,
      ).toBe('allow');
      // Through the custom 'openai' gateway → unclamped → over the cap → fail. Keying on the catalog provider
      // ('deepseek') would have wrongly clamped THIS path and waved the overspend through (the M2 defect).
      expect(governor.evaluatePreEgress('deepseek-v4-flash', HUGE, undefined, 'openai').kind).toBe(
        'fail',
      );
    });

    it('omitting the provider (a media-only gate) defaults to official — a harmless no-op at maxTokens 0', () => {
      const { governor } = makeGovernor({
        budget: { ...budget, on_exceed: 'fail' },
        resolveEndpoint,
      });
      governor.updateCost(0);
      // maxTokens 0 → token estimate 0 regardless of endpoint, so the absent provider cannot mis-authorize.
      expect(governor.evaluatePreEgress('deepseek-v4-flash', 0).kind).toBe('allow');
    });
  });
});
