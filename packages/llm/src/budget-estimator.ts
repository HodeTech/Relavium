import type {
  MediaBilledModality,
  MediaUnitsEstimate,
  MediaEstimateBasis,
  RequestEstimateBasis,
  ResolvedRequestEstimate,
} from '@relavium/shared';

export type {
  MediaUnitsEstimate,
  MediaEstimateBasis,
  RequestEstimateBasis,
  ResolvedRequestEstimate,
} from '@relavium/shared';

import {
  priceModel,
  worstCaseRateBasis,
  worstCaseRates,
  type MediaCost,
  type PricingOverlay,
} from './cost-tracker.js';
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

function assertEstimate(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new InvalidTokenEstimateError();
}

/**
 * One rate-only kernel for governor admission and frozen allowance quotes (ADR-0096/0097/0101).
 * Read the user/catalog price once, select the same highest context threshold as realized accounting,
 * and round each token class and media entry independently. Effective native caps are already resolved;
 * no catalog ceiling is applied here. An unsafe COST is distinguishable from malformed estimates/rates,
 * so a reject-only quote can retain its finite provenance without persisting an invented amount.
 */
export function estimateResolvedRequestCost(
  modelId: string,
  inputTokensEstimate: number,
  outputTokensReservation: number,
  mediaUnitsEstimate: readonly MediaUnitsEstimate[] = [],
  overlay?: PricingOverlay,
): ResolvedRequestEstimate {
  assertEstimate(inputTokensEstimate);
  assertEstimate(outputTokensReservation);
  const volumes = mediaUnitsEstimate.map((entry) => {
    const units = entry.units;
    assertEstimate(units);
    return { modality: entry.modality, units };
  });
  const pricing = priceModel(modelId, overlay);
  for (const tier of pricing.contextTiers ?? []) assertEstimate(tier.aboveContextTokens);
  const selected = worstCaseRateBasis(pricing);
  assertEstimate(selected.rates.input);
  assertEstimate(selected.rates.output);
  const media: MediaEstimateBasis[] = [];
  const gaps = new Set<MediaBilledModality>();
  let amount =
    Math.round((inputTokensEstimate * selected.rates.input) / TOKENS_PER_MTOK) +
    Math.round((outputTokensReservation * selected.rates.output) / TOKENS_PER_MTOK);
  for (const entry of volumes) {
    const rate = pricing.mediaOutputRates?.[entry.modality];
    if (rate === undefined || !Number.isFinite(rate) || rate < 0) {
      // A requested modality remains unpriced when its assumed volume is zero (ADR-0089 §4).
      gaps.add(entry.modality);
      media.push(Object.freeze({ modality: entry.modality, units: entry.units }));
    } else {
      media.push(
        Object.freeze({ modality: entry.modality, units: entry.units, rateMicrocents: rate }),
      );
      amount += Math.round(entry.units * rate);
    }
  }
  const basis: RequestEstimateBasis = Object.freeze({
    inputTokensEstimate,
    outputTokensReservation,
    inputRateKind: 'non_cached',
    inputPerMtokMicrocents: selected.rates.input,
    outputPerMtokMicrocents: selected.rates.output,
    ...(selected.aboveContextTokens === undefined
      ? {}
      : {
          contextTierAboveTokens: selected.aboveContextTokens,
        }),
    media: Object.freeze(media),
  });
  const unpricedModalities = Object.freeze([...gaps]);
  return Number.isSafeInteger(amount) && amount >= 0
    ? Object.freeze({ kind: 'priced', microcents: amount, basis, unpricedModalities })
    : Object.freeze({ kind: 'unrepresentable', basis, unpricedModalities });
}

function pricedAmount(estimate: ResolvedRequestEstimate): number {
  if (estimate.kind === 'unrepresentable') {
    throw new InvalidTokenEstimateError('unrepresentable_cost');
  }
  return estimate.microcents;
}

/** Compatibility number result for already resolved token-only estimates. */
export function estimateResolvedNextCost(
  modelId: string,
  inputTokensEstimate: number,
  outputTokensReservation: number,
  overlay?: PricingOverlay,
): number {
  return pricedAmount(
    estimateResolvedRequestCost(modelId, inputTokensEstimate, outputTokensReservation, [], overlay),
  );
}

/** Compatibility media-only result; policy remains with the governor. */
export function estimateMediaCost(
  modelId: string,
  estimate: readonly MediaUnitsEstimate[],
  overlay?: PricingOverlay,
): MediaCost {
  const priced = estimateResolvedRequestCost(modelId, 0, 0, estimate, overlay);
  return { microcents: pricedAmount(priced), unpricedModalities: priced.unpricedModalities };
}
