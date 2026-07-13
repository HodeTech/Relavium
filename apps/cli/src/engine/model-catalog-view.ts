import type { ModelCatalogListing } from '@relavium/db';
import {
  catalogModel,
  catalogPricing,
  mergeModelCatalog,
  type CatalogPriceTier,
  type ModelCatalogEntry,
  type ModelListing,
  type ModelPricing,
  type PricingOverlay,
  type ProviderId,
} from '@relavium/llm';
import { LLM_PROVIDERS } from '@relavium/shared';

/**
 * The host projection that turns the durable `model_catalog` cache rows into the merged, display-ready catalog the
 * `/models` picker renders (workstream **2.5.G S7**, [ADR-0064](../../../../docs/decisions/0064-live-model-catalog.md) §6/§10).
 * It is the thin, PURE glue between the `@relavium/db` store (which speaks internal provider UUIDs + `source`
 * rows) and the pure `@relavium/llm` {@link mergeModelCatalog} (which speaks the `ProviderId` enum + plain tiers):
 * it builds the LIVE map from the `source='live'` rows (translating provider UUID → slug) and hands it to the
 * merge, whose non-user tier is the generated catalog (ADR-0071). Keeping this in the host — not the store, not the merge
 * — is what lets `@relavium/llm`/`@relavium/core` stay platform-free while every surface reuses the one merge.
 *
 * The ADR-0065 USER-pricing tier is built by {@link buildUserPricing} (workstream **2.5.G S10**): it projects the
 * `source='user'` rows into the ONE `ReadonlyMap<string, ModelPricing>` that serves BOTH consumers — the merge's
 * `userPricing` slot (so the `/models` picker shows a user-priced model's cost) AND the cost path's
 * {@link PricingOverlay} (host-injected exactly like `keyFor`, so the budget governor enforces `max_cost_microcents`
 * on an otherwise-unknown model). The USER tier OUTRANKS the catalog in both (ADR-0071 §1) — they hold the invoice,
 * we hold a snapshot of a third-party aggregator. It cannot be done in SILENCE, though: `models pricing` echoes the
 * catalog price the override replaces (§5), a partial override inherits every dimension it does not state, and a row
 * whose provider contradicts the catalog's is refused rather than stored and quietly ignored.
 */

/** The merged catalog for the picker + the newest live-refresh stamp (the "last updated" freshness badge). */
export interface MergedCatalogView {
  readonly entries: readonly ModelCatalogEntry[];
  /** The newest `lastRefreshedAt` across the `source='live'` rows (epoch-ms), or `undefined` when never refreshed. */
  readonly refreshedAt: number | undefined;
}

/** The store + resolver inputs the projection reads — a structural subset so a test drives it with plain data. */
export interface BuildMergedCatalogInput {
  /** All ACTIVE catalog rows (the store's `listAll()`), across every provider. */
  readonly rows: readonly ModelCatalogListing[];
  /** Resolve an internal `llm_providers` UUID → its provider slug (e.g. `anthropic`) — `createProviderSlugResolver`. */
  readonly providerSlug: (uuid: string) => string;
  /** The providers with a resolvable key (2.5.G key-awareness) — passed straight to {@link mergeModelCatalog} so a
   *  keyless provider's models are dimmed `no-key` + non-selectable. Absent ⇒ not key-gated (unchanged). */
  readonly keyedProviders?: ReadonlySet<ProviderId>;
  /** Current time (epoch-ms) for the deprecation check — passed in so the projection stays pure/testable. */
  readonly now: number;
}

/** A total type-guard over the CLOSED provider enum — a UUID that resolves to a non-enum slug (an unmapped id, or a
 *  future custom provider handled by ADR-0065/S9) is not a `ProviderId` and its live rows are skipped here. */
function isProviderId(slug: string): slug is ProviderId {
  return (LLM_PROVIDERS as readonly string[]).includes(slug);
}

/** Map a stored catalog row → a seam {@link ModelListing} (the live-discovery half): id + the optional limits +
 *  the live deprecation date as ISO (the store carries epoch-ms; the merge unions ISO dates). Pricing is NOT
 *  carried — the merge's pricing authority is the user tier / the catalog, never a live row (ADR-0064 §6). */
function rowToListing(row: ModelCatalogListing): ModelListing {
  return {
    id: row.modelId,
    ...(row.displayName.length > 0 ? { displayName: row.displayName } : {}),
    ...(row.contextWindowTokens !== undefined
      ? { contextWindowTokens: row.contextWindowTokens }
      : {}),
    ...(row.maxOutputTokens !== undefined ? { maxOutputTokens: row.maxOutputTokens } : {}),
    ...(row.deprecationDate !== undefined
      ? { deprecatedAt: new Date(row.deprecationDate).toISOString() }
      : {}),
  };
}

/**
 * A LIMIT column's "not set" sentinel is `0` (the columns are NOT NULL DEFAULT 0) — read it as absent.
 *
 * Only for the limits. A zero context window or a zero output ceiling is never a value anyone means, so the sentinel
 * is unambiguous there. It is NOT used for money: `--cached 0` is a thing a user can genuinely mean (a self-hosted
 * endpoint with a free cache), and the ambiguity is resolved where it actually exists — at WRITE time, in
 * `models pricing`, which knows whether the flag was passed. The column stores what the user meant.
 */
function statedLimit(value: number | undefined): number | undefined {
  return value === undefined || value <= 0 ? undefined : value;
}

/**
 * The cache-read rate for a user who never stated one (ADR-0071 §10).
 *
 * The catalog's DISCOUNT, applied to the rate the user actually stated — not the catalog's absolute number. A user
 * who negotiated $0.10/MTok input on `gpt-5.5` would otherwise inherit its $0.50 cache rate and pay FIVE TIMES MORE
 * for a cache HIT than for a cache MISS, which is not a price anyone has ever been charged. A cache read is a
 * discount off input; the discount is the part that survives an override, and it can never exceed the input rate it
 * is a discount off.
 *
 * No catalog row to inherit from ⇒ their own input rate. A cache read is never free just because nobody said what it
 * costs — and a user who knows it IS free says so with `--cached 0`, and is believed.
 */
function inheritedCacheRate(base: ModelPricing | undefined, input: number): number {
  if (base === undefined || base.inputPerMtokMicrocents <= 0) return input;
  const ratio = base.cachedInputPerMtokMicrocents / base.inputPerMtokMicrocents;
  return Math.min(input, Math.round(input * ratio));
}

/**
 * The catalog's context TIERS, re-expressed against the user's own rates (ADR-0071 §11).
 *
 * A tiered model is tiered whoever is paying: `gemini-2.5-pro` doubles its input rate above 200k context, and a user
 * who negotiated a discount has not negotiated that away. Dropping the tiers because the user stated a flat price
 * reopens the silent 2× under-bill on every long-context turn — the exact hole the tiers were wired up to close.
 *
 * So the tiers are inherited as MULTIPLIERS, not as absolute rates. The catalog's $2.50-above-$1.25 is a fact about
 * the price the user is no longer paying; that it DOUBLES is a fact about the model. The CLI cannot express a
 * per-tier price, so this is the honest reading of a flat price on a tiered model — and it is strictly safer than
 * the alternative, because it can only ever bill more than flat, never less.
 */
function scaledTiers(
  base: ModelPricing | undefined,
  input: number,
  output: number,
  cachedInput: number,
): readonly CatalogPriceTier[] | undefined {
  if (base?.contextTiers === undefined || base.inputPerMtokMicrocents <= 0) return undefined;
  const baseIn = base.inputPerMtokMicrocents;
  const baseOut = base.outputPerMtokMicrocents;
  const baseCached = base.cachedInputPerMtokMicrocents;
  return base.contextTiers.map((tier) => ({
    aboveContextTokens: tier.aboveContextTokens,
    inputPerMtokMicrocents: Math.round(input * (tier.inputPerMtokMicrocents / baseIn)),
    outputPerMtokMicrocents:
      baseOut <= 0 ? output : Math.round(output * (tier.outputPerMtokMicrocents / baseOut)),
    ...(tier.cachedInputPerMtokMicrocents === undefined || baseCached <= 0
      ? {}
      : {
          cachedInputPerMtokMicrocents: Math.round(
            cachedInput * (tier.cachedInputPerMtokMicrocents / baseCached),
          ),
        }),
  }));
}

/**
 * Map a `source='user'` catalog row → a seam {@link ModelPricing} (the ADR-0065 user tier, which OUTRANKS the
 * catalog since ADR-0071 §1).
 *
 * **A PARTIAL OVERRIDE MUST BE PARTIAL.** The user types `models pricing gpt-5.5 --input 3 --output 12` to record
 * their negotiated token rates. They have not said anything about the model's context window, its output ceiling,
 * or its cache-read discount — and the DB's columns are `NOT NULL DEFAULT 0`, so "unsaid" arrives here as `0`.
 * Reading those zeroes as VALUES was harmless while a user row could only describe a model the registry had never
 * heard of: there was nothing to overwrite. Under user-first precedence it destroys verified data — the picker
 * showed a 0-token context window for GPT-5.5, and every cached token on it billed at nothing.
 *
 * So each dimension the user did not state falls back to the CATALOG's, and only then to a safe floor. A cache read
 * is never free: absent everywhere, it bills at the user's own input rate (ADR-0071 §10 — "no published cache rate"
 * means the provider does not DISCOUNT cache reads, not that it gives them away).
 *
 * `--cached 0` cannot be told apart from an omitted `--cached`: one column, one sentinel. Treating an explicit zero
 * as "not stated" is the safe reading of the ambiguity — the alternative bills a whole class of tokens at nothing.
 */
function rowToUserPricing(row: ModelCatalogListing, provider: ProviderId): ModelPricing {
  const base = catalogPricing(row.modelId); // undefined for a model the catalog has never heard of
  const input = row.inputCostPerMtokMicrocents;
  const output = row.outputCostPerMtokMicrocents;
  // STATED ⇒ their number, zero included. NOT stated ⇒ derive it, because the column's `0` is a default and not an
  // instruction (ADR-0071 §10 — the flag exists precisely so the two can be told apart).
  const cachedInput = row.cachedInputStated
    ? row.cachedInputCostPerMtokMicrocents
    : inheritedCacheRate(base, input);
  const tiers = scaledTiers(base, input, output, cachedInput);
  return {
    provider,
    nativeId: row.modelId,
    displayName: row.displayName,
    contextWindowTokens: statedLimit(row.contextWindowTokens) ?? base?.contextWindowTokens ?? 0,
    maxOutputTokens: statedLimit(row.maxOutputTokens) ?? base?.maxOutputTokens ?? 0,
    inputPerMtokMicrocents: input,
    outputPerMtokMicrocents: output,
    cachedInputPerMtokMicrocents: cachedInput,
    // Cache-WRITE has no user column at all, so it can only come from the catalog. Dropping it would bill Anthropic
    // cache writes — the expensive half of prompt caching — at zero for any model the user has priced.
    ...(base?.cacheWritePerMtokMicrocents === undefined
      ? {}
      : { cacheWritePerMtokMicrocents: base.cacheWritePerMtokMicrocents }),
    ...(tiers === undefined ? {} : { contextTiers: tiers }),
    ...(row.deprecationDate !== undefined
      ? { deprecatedAt: new Date(row.deprecationDate).toISOString() }
      : {}),
  };
}

/**
 * Project the active catalog rows into the ADR-0065 USER-pricing map — the single source that feeds BOTH the merge's
 * `userPricing` slot and the cost path's {@link PricingOverlay}. Only `source='user'` rows contribute; a row whose
 * provider UUID resolves to a non-enum slug is dropped (a mis-keyed or future custom-provider row can never inject a
 * price under a known provider). The map is keyed by model id — the same key the merge and {@link priceModel} look
 * up — so a user price reaches an unknown model in both the picker and the governor with one build.
 */
export function buildUserPricing(input: {
  readonly rows: readonly ModelCatalogListing[];
  readonly providerSlug: (uuid: string) => string;
}): PricingOverlay {
  const map = new Map<string, ModelPricing>();
  for (const row of input.rows) {
    if (row.source !== 'user') continue; // only the user-pricing rows carry an authored price
    const slug = input.providerSlug(row.providerId);
    if (!isProviderId(slug)) continue; // an unmapped UUID / non-enum provider — never inject under a known provider
    // Cross-provider collision guard (mirrors {@link mergeModelCatalog}'s): the overlay is keyed by model id
    // (the runtime references a model by id alone), so two providers' user rows for the SAME id are ambiguous.
    // Keep the FIRST (deterministic: `listAll()` orders `asc(modelId), asc(id)`) rather than letting the last
    // write win by UUID luck. `models pricing` REJECTS creating such a duplicate, so this is a defense-in-depth
    // floor for a legacy / directly-edited db, never the primary guard.
    if (map.has(row.modelId)) continue;
    // …and the guard the merge ALREADY had, which the overlay did not: a user row whose provider contradicts the
    // CATALOG's is dropped here too, so the two cannot disagree about which rows apply.
    //
    // They did, and it was the sharpest hole the flip opened. `mergeModelCatalog` drops a cross-provider row (the
    // picker keeps showing the catalog's price and says `pricingSource: 'catalog'`), while `priceModel` read the
    // overlay unconditionally and BILLED it. So `models pricing gpt-5.5 --provider anthropic --input 0.00000001`
    // zeroed the cost of a shipped OpenAI model — realized fold and pre-egress estimate alike, making
    // `max_cost_microcents` unenforceable on it — while the UI displayed $5/MTok. Not merely silent: actively wrong.
    const anchored = catalogModel(row.modelId)?.provider;
    if (anchored !== undefined && anchored !== slug) continue;
    map.set(row.modelId, rowToUserPricing(row, slug));
  }
  return map;
}

/**
 * Project the active catalog rows into the merged `/models` view. Partitions the `source='live'` rows into a
 * per-`ProviderId` live map, then delegates to the pure merge. A provider is added to the live map only when it
 * has ≥1 ACTIVE `source='live'` row; a provider with no active live rows (never refreshed, OR refreshed to an
 * empty list — `replaceProviderModels` soft-deactivates all its live rows, so the two are indistinguishable at
 * this seam) is ABSENT from the map, so its static models fall back to static presence (ADR-0064 §6's "never
 * everything unavailable" safe default). This means the merge's `present-with-[]` case (dim all a provider's
 * statics) is never produced HERE — the real providers never return an empty list for a valid key, and the safe
 * default is preferred over dimming a whole provider on an ambiguous zero-row read. A live row whose provider
 * UUID resolves to a non-enum slug is dropped (defensive: a mis-keyed or future custom-provider row can never
 * corrupt an unrelated known provider's entry — the merge has its own cross-provider guard too).
 */
export function buildMergedCatalog(input: BuildMergedCatalogInput): MergedCatalogView {
  const live = new Map<ProviderId, ModelListing[]>();
  let refreshedAt: number | undefined;
  for (const row of input.rows) {
    if (row.source !== 'live') continue; // only the live-discovery rows decide availability
    const slug = input.providerSlug(row.providerId);
    if (!isProviderId(slug)) continue; // an unmapped UUID / a non-enum (custom) provider — not this step's concern
    // Freshness reflects only VALID (enum-provider) live rows — a dropped rogue row must not skew the badge.
    if (row.lastRefreshedAt !== undefined) {
      refreshedAt =
        refreshedAt === undefined
          ? row.lastRefreshedAt
          : Math.max(refreshedAt, row.lastRefreshedAt);
    }
    const list = live.get(slug) ?? [];
    list.push(rowToListing(row));
    live.set(slug, list);
  }
  const userPricing = buildUserPricing({ rows: input.rows, providerSlug: input.providerSlug });
  const entries = mergeModelCatalog({
    live,
    userPricing,
    ...(input.keyedProviders === undefined ? {} : { keyedProviders: input.keyedProviders }),
    now: input.now,
  });
  return { entries, refreshedAt };
}
