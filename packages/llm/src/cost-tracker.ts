import type { MediaBilledModality } from '@relavium/shared';

import { catalogPricing, pricedModelIds } from './catalog/pricing.js';
import { UnknownModelError } from './errors.js';
import type { ModelPricing } from './pricing.js';
import type { MediaUnitsEntry, Usage } from './types.js';

/**
 * Cost tracking Relavium owns, keyed on the canonical model id — never read from a provider
 * field (1.B). All figures are integer **micro-cents** (1 micro-cent = 1e-8 USD), consistent with
 * the seam's `Usage.costMicrocents` and the `cost:updated` event.
 */

/**
 * An optional **user-pricing overlay** (2.5.G S10, [ADR-0065](../../../docs/decisions/0065-provider-economics-and-extensibility.md) §2)
 * — canonical model id → {@link ModelPricing}, host-built from the `model_catalog` `source='user'` rows and
 * injected **exactly like `keyFor`** (a plain Relavium map; `@relavium/core`/`@relavium/llm` never import
 * `@relavium/db`). It OUTRANKS the catalog (ADR-0071 §1): the catalog is a generated snapshot of a third-party
 * aggregator, and the user is the one holding the invoice. A partial override stays partial — a dimension they did
 * not state inherits the catalog's, and a cache read is never free. `models pricing` says out loud which catalog
 * price it replaced, because the user gets what they asked for; they simply cannot do it in silence (§5).
 */
export type PricingOverlay = ReadonlyMap<string, ModelPricing>;

/**
 * Look up pricing for a model id: **user → catalog → throw**
 * ([ADR-0071](../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §1).
 *
 * **The precedence flipped, deliberately.** It used to be static-first: the hand-typed registry won for a known
 * id, and a user's `models pricing` row could only fill an id the registry LACKED. That made sense while the
 * registry was our own verified table — and it is exactly wrong now. The catalog is a snapshot of a third-party
 * aggregator; the user is the one holding the invoice. When they tell us their negotiated rate, their enterprise
 * discount, or a price the snapshot has not caught up with, that is not a hint to be overruled by a file we
 * generated last Tuesday. The user's number wins.
 *
 * A truly unknown id throws `UnknownModelError` — never a silent zero, which would bill a run at nothing and
 * enforce a cost cap that can never trip. The caller degrades cost governance to `allow`, loudly.
 */
export function priceModel(modelId: string, overlay?: PricingOverlay): ModelPricing {
  const fromUser = overlay?.get(modelId);
  if (fromUser !== undefined) {
    return fromUser; // the user holds the invoice; we hold a snapshot of someone else's table
  }
  const fromCatalog = catalogPricing(modelId);
  if (fromCatalog !== undefined) {
    return fromCatalog;
  }
  throw new UnknownModelError(modelId, pricedModelIds());
}

const TOKENS_PER_MTOK = 1_000_000;

/** The three input-side rates that a context tier can move. Output moves too; it rides alongside. */
export interface Rates {
  readonly input: number;
  readonly output: number;
  readonly cachedInput: number;
}

/**
 * The rates for a prompt of `contextTokens` — the tier it actually landed in (ADR-0071 §11).
 *
 * A model with no tiers is flat, which is every model the retired table carried and every price a user states. For
 * a tiered one, the HIGHEST threshold at or below the prompt's size wins: `gemini-2.5-pro` is $1.25/$10 up to 200k
 * and $2.50/$15 above it, so a 500k-token prompt billed at the cheap rate under-states its own cost by 2×.
 *
 * `contextTokens` is the whole input side — the prompt, cached or not, plus what is being written INTO the cache.
 * All of it is context the model has to hold this turn, and it is a long conversation's cached history that pushes
 * it over the threshold in the first place.
 *
 * One gap, deliberately not papered over: **cache WRITES are billed at the flat rate**, never a tier's. models.dev's
 * tier schema publishes `input`, `output` and `cache_read` — and no `cache_write` — so a per-tier write rate is not a
 * number we have. Inventing one by scaling would be a guess on a money path. Filed in deferred-tasks; the exposure is
 * a cache-write-heavy prompt above 272k on the four `gpt-5.6` variants.
 */
function ratesFor(p: ModelPricing, contextTokens: number): Rates {
  const flat: Rates = {
    input: p.inputPerMtokMicrocents,
    output: p.outputPerMtokMicrocents,
    cachedInput: p.cachedInputPerMtokMicrocents,
  };
  if (p.contextTiers === undefined || p.contextTiers.length === 0) return flat;
  let best: Rates = flat;
  let bestThreshold = -1;
  for (const tier of p.contextTiers) {
    if (contextTokens > tier.aboveContextTokens && tier.aboveContextTokens > bestThreshold) {
      bestThreshold = tier.aboveContextTokens;
      best = {
        input: tier.inputPerMtokMicrocents,
        output: tier.outputPerMtokMicrocents,
        // A tier that states no cache rate of its own falls back to THAT TIER's input rate — the same rule the base
        // level follows (ADR-0071 §10), and for the same reason: a cache read is never free just because nobody said
        // what it costs. It does NOT carry the base tier's discount forward, and it does not need to: every shipped
        // model with a real base cache discount states one at the tier level too.
        cachedInput: tier.cachedInputPerMtokMicrocents ?? tier.inputPerMtokMicrocents,
      };
    }
  }
  return best;
}

/**
 * The rates for the WORST case — the highest tier the model has (ADR-0071 §11).
 *
 * The pre-egress estimate does not know how long the prompt will be (the engine does not tokenize locally), so it
 * assumes the expensive end. A cap that over-estimates refuses a turn the user could have afforded; a cap that
 * under-estimates lets real money escape. Only one of those is recoverable.
 */
export function worstCaseRates(p: ModelPricing): Rates {
  return ratesFor(p, Number.MAX_SAFE_INTEGER);
}

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
export function cost(modelId: string, usage: Usage, overlay?: PricingOverlay): number {
  const p = priceModel(modelId, overlay);
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  // The tier the prompt ACTUALLY landed in (ADR-0071 §11) — the whole input side, cached or not, is context the
  // model had to hold. A flat-priced model (and every user-stated price) resolves to its one set of rates.
  const rates = ratesFor(p, usage.inputTokens + cacheReadTokens + cacheWriteTokens);
  const perClass = (tokens: number, ratePerMtok: number): number =>
    Math.round((tokens * ratePerMtok) / TOKENS_PER_MTOK);
  return (
    perClass(usage.inputTokens, rates.input) +
    perClass(usage.outputTokens, rates.output) +
    perClass(cacheReadTokens, rates.cachedInput) +
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
    // Round once to an INTEGER micro-cent (a fractional `durationSeconds` × per-second rate would otherwise
    // produce a non-integer addend) — matching the token path's per-class rounding so every cost stays integer.
    total += Math.round(entry.units * rate);
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
  readonly #overlay: PricingOverlay | undefined;

  /** `overlay` (2.5.G S10) is the host-injected user-pricing tier — consulted FIRST (ADR-0071 §1), so a model the
   *  user has priced is billed at their number, and everything else at the catalog's. */
  constructor(overlay?: PricingOverlay) {
    this.#overlay = overlay;
  }

  /** Price one attempt's usage and fold it into the running total. */
  record(modelId: string, usage: Usage): CostUpdate {
    const costMicrocents = cost(modelId, usage, this.#overlay);
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
