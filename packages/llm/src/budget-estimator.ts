import type { MediaBilledModality } from '@relavium/shared';

import { priceModel, worstCaseRates, type MediaCost, type PricingOverlay } from './cost-tracker.js';
import { cappedMaxTokens, type EndpointKind } from './output-cap.js';

const TOKENS_PER_MTOK = 1_000_000;

/**
 * Pre-egress worst-case cost estimate for a single LLM call.
 *
 * The estimate prices only the **output** side at the model's declared `maxTokens`
 * (or a configured default), because the engine does not tokenize the prompt locally.
 * This is intentionally conservative: it may block slightly early rather than overshoot.
 *
 * **The estimate must price the request the WIRE will carry**
 * ([ADR-0071](../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §7). The adapter holds an
 * authored cap to the model's own output ceiling, so the cap the estimate reasons about is the clamped one —
 * otherwise `gemini-2.5-pro` with `max_tokens: 200000` (ceiling 65 536) is pre-authorized for three times the
 * spend the model can physically produce, and `on_exceed: fail` kills the run over money that could never leave
 * the account.
 *
 * `endpoint` is not decoration, and getting it wrong is the same bug pointing the other way. The adapter does NOT
 * clamp a custom `base_url` (it may serve anything under a familiar id), so estimating a custom endpoint AS IF it
 * clamped produces an estimate BELOW what the wire can spend — and a governor that under-authorizes waves through
 * a call it should have stopped. Absent ⇒ `'official'`, matching the adapter's own default for an un-overridden
 * endpoint; a host that registers a custom `base_url` must say so.
 *
 * All figures are integer micro-cents.
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
