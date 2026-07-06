import type { ModelCatalogListing } from '@relavium/db';
import {
  mergeModelCatalog,
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
 * merge, whose static tier is the in-code `MODEL_PRICING`. Keeping this in the host — not the store, not the merge
 * — is what lets `@relavium/llm`/`@relavium/core` stay platform-free while every surface reuses the one merge.
 *
 * The ADR-0065 USER-pricing tier is built by {@link buildUserPricing} (workstream **2.5.G S10**): it projects the
 * `source='user'` rows into the ONE `ReadonlyMap<string, ModelPricing>` that serves BOTH consumers — the merge's
 * `userPricing` slot (so the `/models` picker shows a user-priced model's cost) AND the cost path's
 * {@link PricingOverlay} (host-injected exactly like `keyFor`, so the budget governor enforces `max_cost_microcents`
 * on an otherwise-unknown model). Static `MODEL_PRICING` still wins for a known id in both — the user tier only ever
 * fills an UNKNOWN id (ADR-0065 §2), so a user can never silently misprice a shipped model.
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
 *  carried — the merge's pricing authority is the static registry / user tier, never a live row (ADR-0064 §6). */
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
 * Map a `source='user'` catalog row → a seam {@link ModelPricing} (the ADR-0065 user tier). The DB stores integer
 * micro-cents in the three `*_per_mtok_microcents` columns (NOT NULL, default `0`) — a captured price is a real
 * value; a `0` means "not set for this dimension" and costs that dimension as free, which is the user's declared
 * intent. Media output rates + cache-write are NOT user-capturable (no column), so they stay undefined — the cost
 * fold degrades those to 0 (H4: never hard-fail on a missing rate). The context/output limits carry through so the
 * merged picker and the footer context indicator can show them for an otherwise-unknown model.
 */
function rowToUserPricing(row: ModelCatalogListing, provider: ProviderId): ModelPricing {
  return {
    provider,
    nativeId: row.modelId,
    displayName: row.displayName,
    contextWindowTokens: row.contextWindowTokens ?? 0,
    maxOutputTokens: row.maxOutputTokens ?? 0,
    inputPerMtokMicrocents: row.inputCostPerMtokMicrocents,
    outputPerMtokMicrocents: row.outputCostPerMtokMicrocents,
    cachedInputPerMtokMicrocents: row.cachedInputCostPerMtokMicrocents,
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
      refreshedAt = refreshedAt === undefined ? row.lastRefreshedAt : Math.max(refreshedAt, row.lastRefreshedAt);
    }
    const list = live.get(slug) ?? [];
    list.push(rowToListing(row));
    live.set(slug, list);
  }
  const userPricing = buildUserPricing({ rows: input.rows, providerSlug: input.providerSlug });
  const entries = mergeModelCatalog({ live, userPricing, now: input.now });
  return { entries, refreshedAt };
}
