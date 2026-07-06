import type { MediaBilledModality } from '@relavium/shared';

import { priceModel, type PricingOverlay } from './cost-tracker.js';

const TOKENS_PER_MTOK = 1_000_000;

/**
 * Pre-egress worst-case cost estimate for a single LLM call.
 *
 * The estimate prices only the **output** side at the model's declared `maxTokens`
 * (or a configured default), because the engine does not tokenize the prompt locally.
 * This is intentionally conservative: it may block slightly early rather than overshoot.
 *
 * All figures are integer micro-cents.
 */
export function estimateMaxNextCost(
  modelId: string,
  maxOutputTokens: number,
  overlay?: PricingOverlay,
): number {
  const p = priceModel(modelId, overlay);
  if (maxOutputTokens <= 0) {
    return 0;
  }
  return Math.round((maxOutputTokens * p.outputPerMtokMicrocents) / TOKENS_PER_MTOK);
}

/** One element of the pre-egress media estimate: a billed modality + its assumed unit count (a count for
 *  image, seconds for audio/video) — built by the runner from `output_modalities` + `media_cost_estimate`. */
export interface MediaUnitsEstimate {
  readonly modality: MediaBilledModality;
  readonly units: number;
}

/**
 * Pre-egress media cost estimate for a single call (1.AF/D17, ADR-0044 §3) — `Σ units × rate`, integer
 * micro-cents, using the model's per-modality media-output rates. A modality the model does not price
 * **degrades to 0** (H4 — never hard-fail a valid run on a missing media rate), mirroring the token
 * estimate's unpriced-model handling. Throws `UnknownModelError` for a model not in the pricing table
 * (the governor catches it and degrades the WHOLE estimate to allow, exactly as for the token estimate).
 */
export function estimateMediaCost(
  modelId: string,
  estimate: readonly MediaUnitsEstimate[],
  overlay?: PricingOverlay,
): number {
  const p = priceModel(modelId, overlay);
  let total = 0;
  for (const { modality, units } of estimate) {
    const rate = p.mediaOutputRates?.[modality];
    if (rate !== undefined && units > 0) {
      // Round per entry, exactly as the realized `mediaCost` fold does (cost-tracker.ts), so the pre-egress
      // gate estimate and the realized addend agree to the micro-cent on a fractional duration (N3).
      total += Math.round(units * rate);
    }
  }
  return total;
}
