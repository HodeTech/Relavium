import { LLM_PROVIDERS } from '@relavium/shared';

import { MODEL_PRICING, type ModelPricing } from './pricing.js';
import type { ModelListing, ProviderId } from './types.js';

/**
 * The merged model catalog (ADR-0064 §6) — the pure reconciliation of LIVE discovery (which model ids a key
 * can reach, from `LlmProvider.listModels`), the STATIC registry ({@link MODEL_PRICING}), and the optional
 * USER-pricing tier (ADR-0065, filled additively from the `model_catalog` `source='user'` rows). It lives in
 * `@relavium/llm` and is **pure / I/O-free** (the host does the keychain/db/network work and passes plain data
 * in), so every surface — the CLI `/models` picker, the desktop, the VS Code extension — reuses the same
 * precedence. Selection (availability) and pricing are kept cleanly separate: the live list decides
 * **availability**, the static registry stays the **pricing authority**.
 */

/** Where an entry's effective pricing came from. `none` ⇒ the cost cap will not apply (ADR-0064 §6 / ADR-0065). */
export type PricingSource = 'registry' | 'user' | 'none';

/** One reconciled model in the merged catalog (ADR-0064 §6). */
export interface ModelCatalogEntry {
  readonly modelId: string;
  readonly provider: ProviderId;
  readonly displayName: string;
  /** From live ?? static ?? user (live is fresher when present, e.g. Anthropic's `max_input_tokens`). */
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  /**
   * The **effective** pricing: static ({@link MODEL_PRICING}) for a known id, else the USER tier for an
   * unknown id, else undefined. The live tier is **never** a pricing authority (ADR-0064 §6) — providers
   * rarely return a price and a refresh must never overwrite a known one.
   */
  readonly pricing?: ModelPricing;
  readonly pricingSource: PricingSource;
  /** `pricingSource !== 'none'`. `false` ⇒ the picker surfaces "cost cap will not apply" (ADR-0064 §6). */
  readonly priceKnown: boolean;
  /**
   * Whether the model is available to select. When its provider has live data, this is live-list membership
   * (a static model absent from the key's live list is **dimmed** "not available on your key", the K2
   * decision); when its provider has **no** live data (endpoint down, `listModels` absent, or not connected),
   * it falls back to **static presence** (`true`) — never "everything unavailable" (ADR-0064 §6). Whether a
   * non-connected provider's models are ultimately *selectable* is the host surface's call. This rule is
   * **tier-agnostic**: the ADR-0065 USER tier is pricing-only, so a user-declared id that its connected
   * provider's live list omits is likewise dimmed — its `pricing` still applies for cost governance.
   */
  readonly available: boolean;
  /** `true` once `now >= deprecatedAt` (ADR-0064 §7). The picker flags but never forbids a deprecated model. */
  readonly deprecated: boolean;
  /** The effective ISO deprecation date — the earlier of the static and live dates (their union). */
  readonly deprecatedAt?: string;
}

/** Input to {@link mergeModelCatalog} — all plain data the host resolves and passes in (keeps the merge pure). */
export interface MergeModelCatalogInput {
  /**
   * Per-provider LIVE listings from `listModels`. A provider **present** in the map (even with `[]`) has live
   * data, so availability is decided by list membership (an empty `[]` dims all that provider's static models).
   * A provider **absent** from the map has **no** live data — its registry models fall back to static presence.
   */
  readonly live?: ReadonlyMap<ProviderId, readonly ModelListing[]>;
  /**
   * ADR-0065 USER tier: user-supplied pricing by model id. Fills an **unknown** id only — the static registry
   * always wins for a known id (ADR-0064 §6 / ADR-0065 §2), so a user cannot silently misprice a shipped model.
   */
  readonly userPricing?: ReadonlyMap<string, ModelPricing>;
  /** Current time (epoch ms) for the deprecation check — passed in so the merge stays pure and testable. */
  readonly now: number;
}

interface Tiers {
  provider: ProviderId;
  live?: ModelListing;
  registry?: ModelPricing;
  user?: ModelPricing;
}

/** The earlier of two optional ISO dates (their "union" for deprecation), skipping any that fails to parse. */
function earlierIsoDate(a: string | undefined, b: string | undefined): string | undefined {
  const pa = a === undefined ? NaN : Date.parse(a);
  const pb = b === undefined ? NaN : Date.parse(b);
  if (Number.isNaN(pa)) return Number.isNaN(pb) ? undefined : b;
  if (Number.isNaN(pb)) return a;
  return pa <= pb ? a : b;
}

const PROVIDER_RANK = new Map<ProviderId, number>(LLM_PROVIDERS.map((p, i) => [p, i]));

/**
 * Reconcile live discovery ⋈ the static registry ⋈ the user tier into one deterministically-ordered catalog
 * (ADR-0064 §6). Pure: no I/O, no `Date.now()` (the caller passes `now`). Per-field precedence —
 * availability ← live (else static presence); price ← registry ?? user (never live); context/output ← live ??
 * static ?? user; deprecation ← the earlier of the static and live dates; priceKnown ← a static or user price
 * exists.
 */
export function mergeModelCatalog(input: MergeModelCatalogInput): ModelCatalogEntry[] {
  const live = input.live ?? new Map<ProviderId, readonly ModelListing[]>();
  const userPricing = input.userPricing ?? new Map<string, ModelPricing>();
  const tiers = new Map<string, Tiers>();

  // Registry tier — every static model.
  for (const [id, registry] of Object.entries(MODEL_PRICING) as [string, ModelPricing][]) {
    tiers.set(id, { provider: registry.provider, registry });
  }
  // Live tier — per provider present in the map. The map key is authoritative for a live-only id's provider.
  for (const [provider, listings] of live) {
    for (const listing of listings) {
      const prev = tiers.get(listing.id);
      tiers.set(listing.id, { ...prev, provider: prev?.provider ?? provider, live: listing });
    }
  }
  // User tier — fills an unknown id; a known id keeps its registry provider.
  for (const [id, pricing] of userPricing) {
    const prev = tiers.get(id);
    tiers.set(id, { ...prev, provider: prev?.provider ?? pricing.provider, user: pricing });
  }

  const entries: ModelCatalogEntry[] = [];
  for (const [modelId, t] of tiers) {
    const pricing = t.registry ?? t.user; // registry wins for a known id; user fills an unknown one.
    const pricingSource: PricingSource = t.registry ? 'registry' : t.user ? 'user' : 'none';
    const contextWindowTokens =
      t.live?.contextWindowTokens ?? t.registry?.contextWindowTokens ?? t.user?.contextWindowTokens;
    const maxOutputTokens =
      t.live?.maxOutputTokens ?? t.registry?.maxOutputTokens ?? t.user?.maxOutputTokens;
    // Availability: live-list membership when the provider has live data, else static presence.
    const available = live.has(t.provider) ? t.live !== undefined : true;
    const deprecatedAt = earlierIsoDate(t.registry?.deprecatedAt, t.live?.deprecatedAt);
    const parsedDeprecation = deprecatedAt === undefined ? NaN : Date.parse(deprecatedAt);
    const deprecated = !Number.isNaN(parsedDeprecation) && parsedDeprecation <= input.now;

    entries.push({
      modelId,
      provider: t.provider,
      displayName: t.registry?.displayName ?? t.live?.displayName ?? t.user?.displayName ?? modelId,
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(pricing !== undefined ? { pricing } : {}),
      pricingSource,
      priceKnown: pricingSource !== 'none',
      available,
      deprecated,
      ...(deprecatedAt !== undefined ? { deprecatedAt } : {}),
    });
  }

  // Deterministic order: provider (in the seam's LLM_PROVIDERS order), then displayName, then modelId.
  entries.sort((x, y) => {
    const byProvider =
      (PROVIDER_RANK.get(x.provider) ?? LLM_PROVIDERS.length) -
      (PROVIDER_RANK.get(y.provider) ?? LLM_PROVIDERS.length);
    if (byProvider !== 0) return byProvider;
    const byName = x.displayName.localeCompare(y.displayName);
    return byName !== 0 ? byName : x.modelId.localeCompare(y.modelId);
  });
  return entries;
}
