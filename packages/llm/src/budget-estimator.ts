import type { MediaBilledModality } from '@relavium/shared';

import { priceModel, worstCaseRates, type MediaCost, type PricingOverlay } from './cost-tracker.js';
import { InvalidTokenEstimateError } from './errors.js';
import { cappedMaxTokens, type EndpointKind } from './output-cap.js';

const TOKENS_PER_MTOK = 1_000_000;

/**
 * Compatibility output-only pricing for canonical authored caps (ADR-0071).
 * This path clamps against a current official catalog ceiling. Admission and allowance consumers
 * use estimateResolvedNextCost after binding an effective wire-cap plan (ADR-0096/0101), including
 * current-request input. Never pass a surviving native cap through this compatibility wrapper.
 */
export function estimateMaxNextCost(
  modelId: string,
  maxOutputTokens: number,
  overlay?: PricingOverlay,
  endpoint: EndpointKind = 'official',
): number {
  const p = priceModel(modelId, overlay);
  // A model the catalog cannot describe passes through unclamped — the same rule the adapter follows, so the
  // estimate stays a faithful prediction of the request rather than a second, disagreeing opinion about it.
  const capped = cappedMaxTokens(maxOutputTokens, modelId, endpoint) ?? maxOutputTokens;
  if (capped <= 0) {
    return 0;
  }
  // The HIGHEST tier the model has (ADR-0071 §11). The engine does not tokenize the prompt locally, so it cannot
  // know which side of a 200k/272k threshold this turn will land on — and on a SAFETY control, guessing the cheap
  // side is the guess that lets money escape.
  return Math.round((capped * worstCaseRates(p).output) / TOKENS_PER_MTOK);
}

/**
 * Rate-only admission/allowance pricing (ADR-0096/0101). Inputs are already resolved; there is
 * deliberately no catalog-cap lookup here. Native caps may exceed a catalog's output ceiling.
 * Both terms use the highest context tier and NON-cached input, including user pricing overlays.
 */
export function estimateResolvedNextCost(
  modelId: string,
  inputTokensEstimate: number,
  outputTokensReservation: number,
  overlay?: PricingOverlay,
): number {
  if (
    ![inputTokensEstimate, outputTokensReservation].every(
      (value) => Number.isFinite(value) && value >= 0,
    )
  ) {
    throw new InvalidTokenEstimateError();
  }
  const rates = worstCaseRates(priceModel(modelId, overlay));
  // Realized cost rounds each token class separately; combining first can under-reserve a microcent.
  const cost =
    Math.round((inputTokensEstimate * rates.input) / TOKENS_PER_MTOK) +
    Math.round((outputTokensReservation * rates.output) / TOKENS_PER_MTOK);
  if (!Number.isSafeInteger(cost) || cost < 0) throw new InvalidTokenEstimateError();
  return cost;
}

/** One element of the pre-egress media estimate: a billed modality + its assumed unit count (a count for
 *  image, seconds for audio/video) — built by the runner from `output_modalities` + `media_cost_estimate`. */
export interface MediaUnitsEstimate {
  readonly modality: MediaBilledModality;
  readonly units: number;
}

/**
 * Pre-egress media cost estimate for a single call (1.AF/D17, ADR-0044 §3) — `Σ units × rate`, integer
 * micro-cents, using the model's per-modality media-output rates. Throws `UnknownModelError` for a model not
 * in the pricing table (the governor catches it and degrades the WHOLE estimate, exactly as for the token
 * estimate).
 *
 * **A modality the model does not price is NAMED, not zeroed**
 * ([ADR-0089](../../../docs/decisions/0089-media-correctness-four-boundaries.md) §4). The pre-egress twin of
 * the realized `mediaCost` fold, and it has to be: the governor decides admission from this number, so a
 * silent 0 here is a cap that waves through the one call class most likely to be expensive. The policy
 * (allow-with-notice, or refuse under `strict_cost_cap`) stays the governor's — this only reports the fact.
 */
export function estimateMediaCost(
  modelId: string,
  estimate: readonly MediaUnitsEstimate[],
  overlay?: PricingOverlay,
): MediaCost {
  const p = priceModel(modelId, overlay);
  let microcents = 0;
  const unpriced = new Set<MediaBilledModality>();
  for (const { modality, units } of estimate) {
    const rate = p.mediaOutputRates?.[modality];
    // The rate check comes FIRST, and deliberately does not depend on the unit count. An entry exists here only
    // because the node's `output_modalities` REQUESTED that modality — the count is a configured guess
    // (`[defaults].media_cost_estimate`), and that guess is authorable as `0` (`nonNegativeInt`). Skipping on
    // `units <= 0` first therefore let a git-committable `media_cost_estimate = { image = 0 }` silently disable
    // the strict cap for image output: no units, so no gap, so no refusal, and the image bills anyway.
    //
    // This is the mirror-image of the realized fold's guard and the two must NOT be made symmetric. There,
    // `units === 0` means the provider reported nothing produced, so an absent rate really is not a gap. Here,
    // zero means "we cannot guess the volume", which says nothing about whether a charge is coming.
    if (rate === undefined) {
      unpriced.add(modality);
      continue;
    }
    if (units <= 0) {
      continue; // priced, but no volume to multiply — contributes nothing to the estimate
    }
    // Round per entry, exactly as the realized `mediaCost` fold does (cost-tracker.ts), so the pre-egress
    // gate estimate and the realized addend agree to the micro-cent on a fractional duration (N3).
    microcents += Math.round(units * rate);
  }
  return unpriced.size === 0
    ? { microcents, unpricedModalities: [] }
    : { microcents, unpricedModalities: [...unpriced] };
}
