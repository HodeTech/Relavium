import type { ModelCatalogListing } from '@relavium/db';
import {
  mergeModelCatalog,
  type ModelCatalogEntry,
  type ModelListing,
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
 * The ADR-0065 USER-pricing tier is intentionally NOT built here yet — S7 ships availability + static pricing; the
 * `source='user'` rows are populated + merged in S10 (the merge already accepts an optional `userPricing` slot, so
 * that lands additively with no signature change).
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
 * Project the active catalog rows into the merged `/models` view. Partitions the `source='live'` rows into a
 * per-`ProviderId` live map (a provider PRESENT in the map — even with no surviving rows — has live data, so its
 * static models are availability-checked against the list; a provider ABSENT has no live data, so its static
 * models fall back to static presence — ADR-0064 §6), then delegates to the pure merge. A live row whose provider
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
  const entries = mergeModelCatalog({ live, now: input.now });
  return { entries, refreshedAt };
}
