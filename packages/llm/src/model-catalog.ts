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
  /**
   * Why an entry is `available: false`, so the picker can show a distinct, actionable reason (2.5.G key-awareness):
   * `'no-key'` — the provider has no resolvable key at all, so the model is genuinely unusable ("no key for
   * `<provider>` — add one"); `'not-on-key'` — the provider IS keyed and has live data, but this model is not in
   * that key's live list (the pre-existing "not available on your key" dim). Absent when `available: true`.
   */
  readonly unavailableReason?: 'no-key' | 'not-on-key';
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
  /**
   * The providers with a **resolvable key** (keychain OR env) — 2.5.G key-awareness. A model whose provider is
   * NOT in this set is `available: false` / `unavailableReason: 'no-key'` REGARDLESS of live/static presence: with
   * no key the model is genuinely uncallable, so the picker must not offer it (and a chat started on it would only
   * fail with `provider_auth`). ABSENT ⇒ availability is **not** key-gated (every provider treated as keyed) — the
   * pre-key-gating behavior, preserved byte-identical for surfaces/tests that do not resolve keys. This REFINES
   * (does not reverse) the ADR-0064 §6 "static presence" safe default: that default applies only to a **keyed**
   * provider with no live data — never dimming a whole provider the user can actually use.
   */
  readonly keyedProviders?: ReadonlySet<ProviderId>;
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
  const pa = a === undefined ? Number.NaN : Date.parse(a);
  const pb = b === undefined ? Number.NaN : Date.parse(b);
  if (Number.isNaN(pa)) return Number.isNaN(pb) ? undefined : b;
  if (Number.isNaN(pb)) return a;
  return pa <= pb ? a : b;
}

/** The pricing provenance for a merged entry: the registry wins, then the user tier, else none (ADR-0064 §6). */
function pricingSourceOf(t: Tiers): PricingSource {
  if (t.registry) return 'registry';
  if (t.user) return 'user';
  return 'none';
}

/**
 * Availability + its reason (2.5.G key-awareness). Key gate FIRST: a provider absent from `keyedProviders` has no
 * resolvable key, so its model is genuinely uncallable → unavailable with an actionable `'no-key'` reason,
 * regardless of live/static presence. A KEYED provider keeps the pre-existing rule: live-list membership when it
 * has live data (a static model absent from the list is `'not-on-key'`-dimmed), else static presence (the ADR-0064
 * §6 "never everything unavailable" safe default — PRESERVED, but now only for a KEYED provider). `keyedProviders`
 * ABSENT ⇒ not key-gated (every provider treated as keyed): the `available` BOOLEAN is unchanged from pre-change;
 * the only new output is the additive `'not-on-key'` reason on a live-omitted static model — informational.
 */
function resolveAvailability(
  t: Tiers,
  live: ReadonlyMap<ProviderId, readonly ModelListing[]>,
  keyedProviders: ReadonlySet<ProviderId> | undefined,
): { available: boolean; unavailableReason?: 'no-key' | 'not-on-key' } {
  const providerKeyed = keyedProviders === undefined || keyedProviders.has(t.provider);
  if (!providerKeyed) return { available: false, unavailableReason: 'no-key' };
  if (live.has(t.provider)) {
    return t.live !== undefined
      ? { available: true }
      : { available: false, unavailableReason: 'not-on-key' };
  }
  return { available: true };
}

/** Build the tier map (registry ⋈ live ⋈ user). A listing/price whose id COLLIDES with a model already anchored to
 *  a DIFFERENT provider is IGNORED, so a mis-keyed or custom-endpoint rogue id can never corrupt an unrelated entry
 *  (model ids are globally unique in practice). */
function buildTiers(
  live: ReadonlyMap<ProviderId, readonly ModelListing[]>,
  userPricing: ReadonlyMap<string, ModelPricing>,
): Map<string, Tiers> {
  const tiers = new Map<string, Tiers>();
  for (const [id, registry] of Object.entries(MODEL_PRICING) as [string, ModelPricing][]) {
    tiers.set(id, { provider: registry.provider, registry });
  }
  for (const [provider, listings] of live) {
    for (const listing of listings) {
      const prev = tiers.get(listing.id);
      if (prev !== undefined && prev.provider !== provider) continue; // cross-provider id collision — drop
      tiers.set(listing.id, { ...prev, provider: prev?.provider ?? provider, live: listing });
    }
  }
  for (const [id, pricing] of userPricing) {
    const prev = tiers.get(id);
    if (prev !== undefined && prev.provider !== pricing.provider) continue; // cross-provider id collision — drop
    tiers.set(id, { ...prev, provider: prev?.provider ?? pricing.provider, user: pricing });
  }
  return tiers;
}

/** Reconcile one tier-set into a catalog entry (ADR-0064 §6 per-field precedence). */
function buildEntry(
  modelId: string,
  t: Tiers,
  input: MergeModelCatalogInput,
  live: ReadonlyMap<ProviderId, readonly ModelListing[]>,
): ModelCatalogEntry {
  const pricing = t.registry ?? t.user; // registry wins for a known id; user fills an unknown one.
  const pricingSource = pricingSourceOf(t);
  const contextWindowTokens =
    t.live?.contextWindowTokens ?? t.registry?.contextWindowTokens ?? t.user?.contextWindowTokens;
  const maxOutputTokens =
    t.live?.maxOutputTokens ?? t.registry?.maxOutputTokens ?? t.user?.maxOutputTokens;
  const { available, unavailableReason } = resolveAvailability(t, live, input.keyedProviders);
  const deprecatedAt = earlierIsoDate(
    earlierIsoDate(t.registry?.deprecatedAt, t.live?.deprecatedAt),
    t.user?.deprecatedAt,
  );
  const parsedDeprecation = deprecatedAt === undefined ? Number.NaN : Date.parse(deprecatedAt);
  const deprecated = !Number.isNaN(parsedDeprecation) && parsedDeprecation <= input.now;
  return {
    modelId,
    provider: t.provider,
    displayName: t.registry?.displayName ?? t.live?.displayName ?? t.user?.displayName ?? modelId,
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(pricing !== undefined ? { pricing } : {}),
    pricingSource,
    priceKnown: pricingSource !== 'none',
    available,
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
    deprecated,
    ...(deprecatedAt !== undefined ? { deprecatedAt } : {}),
    // Reasoning capability via the SAME authority as the engine gate (ADR-0066 §4): the registry flag for a known
    // id (authoritative — true or false), else the conservative id heuristic for a live-discovered id. So the
    // picker's effort sub-step lights up exactly for the models the engine will actually honor — including a newly
    // released reasoning family member absent from the registry.
  };
}

/**
 * Reconcile live discovery ⋈ the static registry ⋈ the user tier into one deterministically-ordered catalog
 * (ADR-0064 §6). Pure: no I/O, no `Date.now()` (the caller passes `now`). Per-field precedence —
 * availability ← live (else static presence); price ← registry ?? user (never live); context/output ← live ??
 * static ?? user; deprecation ← the earliest of the static, live, and user dates; priceKnown ← a static or
 * user price exists.
 */
export function mergeModelCatalog(input: MergeModelCatalogInput): ModelCatalogEntry[] {
  const live = input.live ?? new Map<ProviderId, readonly ModelListing[]>();
  const userPricing = input.userPricing ?? new Map<string, ModelPricing>();
  const tiers = buildTiers(live, userPricing);
  const entries: ModelCatalogEntry[] = [];
  for (const [modelId, t] of tiers) {
    entries.push(buildEntry(modelId, t, input, live));
  }

  // Order (maintainer, 2.5.G): AVAILABLE (selectable) models FIRST, then the dimmed/unavailable ones — each group
  // sorted alphabetically by displayName, with modelId as the deterministic tiebreaker. So the picker shows the
  // models a user can actually pick at the top (alphabetical), with the no-key / not-on-key ones grouped below
  // (ADR-0064 §6: dimmed, never hidden). Provider is no longer a sort key — availability + name is the user's axis.
  entries.sort((x, y) => {
    // `available: true` sorts BEFORE `available: false` (true → 0, false → 1).
    const byAvailability = (x.available ? 0 : 1) - (y.available ? 0 : 1);
    if (byAvailability !== 0) return byAvailability;
    // Pin an explicit locale so the catalog order is byte-identical across every host/OS/CI locale (a
    // runtime-default locale — e.g. Danish — can flip case ordering for a provider-controlled live displayName).
    const byName = x.displayName.localeCompare(y.displayName, 'en');
    return byName !== 0 ? byName : x.modelId.localeCompare(y.modelId, 'en');
  });
  return entries;
}
