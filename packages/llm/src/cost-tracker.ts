import type { MediaBilledModality } from '@relavium/shared';

import { UnknownModelError } from './errors.js';
import {
  isCanonicalModelId,
  KNOWN_MODEL_IDS,
  MODEL_PRICING,
  type ModelPricing,
} from './pricing.js';
import type { MediaUnitsEntry, Usage } from './types.js';

/**
 * Cost tracking Relavium owns, keyed on the canonical model id — never read from a provider
 * field (1.B). All figures are integer **micro-cents** (1 micro-cent = 1e-8 USD), consistent with
 * the seam's `Usage.costMicrocents` and the `cost:updated` event.
 */

/** Look up pricing for a canonical model id; throws `UnknownModelError` (never a silent zero). */
export function priceModel(modelId: string): ModelPricing {
  if (!isCanonicalModelId(modelId)) {
    throw new UnknownModelError(modelId, KNOWN_MODEL_IDS);
  }
  return MODEL_PRICING[modelId];
}

const TOKENS_PER_MTOK = 1_000_000;

/**
 * The integer micro-cent cost of one usage record. Each token class is `tokens ×
 * pricePerMtokMicrocents / 1e6`, rounded once (the only float in the path; everything downstream
 * sums integers).
 *
 * **Convention:** `inputTokens` is the count billed at the full input rate — cache-read and
 * cache-write tokens are **separate** counts, not included in `inputTokens`. Adapters normalize to
 * this (Anthropic's `input_tokens` is already net; the OpenAI-compatible adapter subtracts the
 * cached subset). So each token class is billed exactly once.
 */
export function cost(modelId: string, usage: Usage): number {
  const p = priceModel(modelId);
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const perClass = (tokens: number, ratePerMtok: number): number =>
    Math.round((tokens * ratePerMtok) / TOKENS_PER_MTOK);
  return (
    perClass(usage.inputTokens, p.inputPerMtokMicrocents) +
    perClass(usage.outputTokens, p.outputPerMtokMicrocents) +
    perClass(cacheReadTokens, p.cachedInputPerMtokMicrocents) +
    perClass(cacheWriteTokens, p.cacheWritePerMtokMicrocents ?? 0) +
    // Media is a DISJOINT addend (1.AF/D17, ADR-0044 §3) — priced per image / audio-second / video-second,
    // never mixed into the token cost path, so the cumulative figure folds realized media spend.
    mediaCost(p, usage.mediaUnits)
  );
}

/** The canonical billed unit per modality: `image` is per-COUNT, `audio`/`video` per-SECOND. */
function unitMatchesBilledModality(
  modality: MediaBilledModality,
  unit: 'count' | 'second',
): boolean {
  return modality === 'image' ? unit === 'count' : unit === 'second';
}

/**
 * The integer micro-cent cost of one usage record's media units (1.AF/D17, ADR-0044 §3) — a disjoint
 * addend, never mixed into the token path. Prices only **`output`-direction** entries (input media bills as
 * input tokens already, folded into `inputTokens` by the adapter), and only when the model declares a rate
 * for that modality AND the reported `unit` matches its canonical billed unit (image=count, audio/video=
 * second). A missing rate, or a token-`count` audio unit from a token-based provider with only a per-second
 * rate, contributes **0** (observability-only) — never a hard fail (H4). Exported for direct unit testing
 * against a constructed `ModelPricing`, since no 1.AF model carries a media rate.
 */
export function mediaCost(
  pricing: ModelPricing,
  mediaUnits: readonly MediaUnitsEntry[] | undefined,
): number {
  if (mediaUnits === undefined) {
    return 0;
  }
  let total = 0;
  for (const entry of mediaUnits) {
    if (entry.direction !== 'output') {
      continue; // input media is billed as input tokens, never double-counted here
    }
    const rate = pricing.mediaOutputRates?.[entry.modality];
    if (rate === undefined || !unitMatchesBilledModality(entry.modality, entry.unit)) {
      continue; // unpriced modality, or a unit that does not match the model's billed unit → observability-only
    }
    total += entry.units * rate;
  }
  return total;
}

/** The cost figures for one `cost:updated` event (the engine adds `nodeId` / `model` / `attemptNumber`). */
export interface CostUpdate {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrocents: number;
  readonly cumulativeCostMicrocents: number;
}

/**
 * Accumulates per-attempt cost across a node/session. Call `record` once per LLM attempt (each
 * fallback attempt has its own `Usage`), so the running total stays accurate across a failover.
 */
export class CostTracker {
  #cumulativeMicrocents = 0;

  /** Price one attempt's usage and fold it into the running total. */
  record(modelId: string, usage: Usage): CostUpdate {
    const costMicrocents = cost(modelId, usage);
    this.#cumulativeMicrocents += costMicrocents;
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costMicrocents,
      cumulativeCostMicrocents: this.#cumulativeMicrocents,
    };
  }

  /** The running total in integer micro-cents. */
  get cumulativeCostMicrocents(): number {
    return this.#cumulativeMicrocents;
  }
}
