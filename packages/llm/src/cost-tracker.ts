import { UnknownModelError } from './errors.js';
import { KNOWN_MODEL_IDS, MODEL_PRICING, type ModelPricing } from './pricing.js';
import type { Usage } from './types.js';

/**
 * Cost tracking Relavium owns, keyed on the canonical model id — never read from a provider
 * field (1.B). All figures are integer **micro-cents** (1 micro-cent = 1e-8 USD), consistent with
 * the seam's `Usage.costMicrocents` and the `cost:updated` event.
 */

/** Look up pricing for a canonical model id; throws `UnknownModelError` (never a silent zero). */
export function priceModel(modelId: string): ModelPricing {
  const pricing: ModelPricing | undefined = (MODEL_PRICING as Record<string, ModelPricing>)[
    modelId
  ];
  if (pricing === undefined) {
    throw new UnknownModelError(modelId, KNOWN_MODEL_IDS);
  }
  return pricing;
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
    perClass(cacheWriteTokens, p.cacheWritePerMtokMicrocents ?? 0)
  );
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
