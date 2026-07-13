import { deprecationFor } from './catalog/deprecations.js';
import { toPricing } from './catalog/pricing.js';
import { catalogModel, catalogModelIds } from './catalog/lookup.js';
import type { ModelPricing } from './pricing.js';
import type { ModelListing, ProviderId } from './types.js';

/**
 * The merged model catalog (ADR-0064 §6, ADR-0071 §1) — the pure reconciliation of LIVE discovery (which model
 * ids a key can actually reach, from `LlmProvider.listModels`), the generated CATALOG (`catalog/snapshot.ts`,
 * synced from models.dev — what the hand-typed registry used to be), and the USER-pricing tier (ADR-0065, from
 * the `model_catalog` `source='user'` rows). It lives in `@relavium/llm` and is **pure / I/O-free** (the host does
 * the keychain/db/network work and passes plain data in), so every surface — the CLI `/models` picker, the
 * desktop, the VS Code extension — reuses the same precedence.
 *
 * Selection and pricing stay cleanly separate: the **live list decides availability**, and pricing resolves
 * **user → catalog**, the same order `priceModel` bills at. The live tier is never a pricing authority (providers
 * rarely return a price, and a refresh must never overwrite a known one).
 */

/** Where an entry's effective pricing came from. `none` ⇒ the cost cap will not apply (ADR-0064 §6 / ADR-0065). */
export type PricingSource = 'catalog' | 'user' | 'none';

/** One reconciled model in the merged catalog (ADR-0064 §6). */
export interface ModelCatalogEntry {
  readonly modelId: string;
  readonly provider: ProviderId;
  readonly displayName: string;
  /** From live ?? user ?? catalog (live is fresher when present, e.g. Anthropic's `max_input_tokens`). */
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  /**
   * The **effective** pricing: the USER's row if they set one, else the generated catalog's, else undefined.
   * The live tier is **never** a pricing authority (ADR-0064 §6) — providers rarely return a price, and a
   * refresh must never overwrite a known one.
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
   * A provider **absent** from the map has **no** live data — its catalog models fall back to catalog presence.
   */
  readonly live?: ReadonlyMap<ProviderId, readonly ModelListing[]>;
  /**
   * ADR-0065 USER tier: user-supplied pricing by model id — and it **OUTRANKS the catalog** (ADR-0071 §1). It used
   * to fill an unknown id only, on the reasoning that a user should not be able to misprice a shipped model. That
   * reasoning belonged to a table WE verified. The catalog is a snapshot of a third-party aggregator, and the user
   * is the one holding the invoice: their negotiated rate is not a hint for a generated file to overrule.
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
  /** The generated catalog's row (ADR-0071) — what the hand-typed `MODEL_PRICING` registry used to be. */
  catalog?: ModelPricing;
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

/** The pricing provenance for a merged entry: the USER wins, then the catalog, else none (ADR-0064 §6). */
function pricingSourceOf(t: Tiers): PricingSource {
  // USER first — the same precedence `priceModel` applies (ADR-0071 §1). The badge must name the price we would
  // actually BILL at, or it is a lie the user reads while being charged something else.
  if (t.user) return 'user';
  if (t.catalog) return 'catalog';
  return 'none';
}

/** A model id shaped `base-YYYYMMDD` → its rolling-alias base; else `undefined`. Anthropic pins a snapshot with an
 *  8-digit date suffix (`claude-haiku-4-5-20251001`), and the base (`claude-haiku-4-5`) is the rolling alias. */
const DATED_PIN = /^(.+)-\d{8}$/;
function datedPinBase(id: string): string | undefined {
  return DATED_PIN.exec(id)?.[1];
}

/**
 * Does a keyed provider's live list carry this model's alias↔dated-pin SIBLING? (ADR-0064 §6 amendment, ADR-0071.)
 *
 * Anthropic's `models.list()` returns only ONE of a rolling alias (`claude-haiku-4-5`) and its dated pin
 * (`claude-haiku-4-5-20251001`), yet the catalog SHIPS BOTH as priced rows — so the id the list omits dimmed as
 * `not-on-key` even though the SAME key calls it (server-side both resolve to the same model). The current id is
 * available when its sibling IS in the live list AND is itself a shipped catalog row of the same provider. The
 * catalog-row gate is what stops this fabricating availability for an arbitrary unpriced id. ANTHROPIC-ONLY, by the
 * maintainer's scoping decision — the OpenAI `gpt-4o` dated family is deliberately out of scope for this round.
 */
function hasLiveSibling(
  modelId: string,
  provider: ProviderId,
  live: ReadonlyMap<ProviderId, readonly ModelListing[]>,
): boolean {
  if (provider !== 'anthropic') return false;
  const listings = live.get(provider);
  if (listings === undefined) return false;
  const base = datedPinBase(modelId);
  if (base !== undefined) {
    // `modelId` is the dated PIN → the live rolling alias `base` is its sibling.
    return listings.some((l) => l.id === base) && catalogModel(base)?.provider === provider;
  }
  // `modelId` is the rolling ALIAS → a live dated pin whose base equals it is its sibling.
  return listings.some(
    (l) => datedPinBase(l.id) === modelId && catalogModel(l.id)?.provider === provider,
  );
}

/**
 * Availability + its reason (2.5.G key-awareness). Key gate FIRST: a provider absent from `keyedProviders` has no
 * resolvable key, so its model is genuinely uncallable → unavailable with an actionable `'no-key'` reason,
 * regardless of live/static presence. A KEYED provider keeps the pre-existing rule: live-list membership when it
 * has live data (a static model absent from the list is `'not-on-key'`-dimmed), else static presence (the ADR-0064
 * §6 "never everything unavailable" safe default — PRESERVED, but now only for a KEYED provider). `keyedProviders`
 * ABSENT ⇒ not key-gated (every provider treated as keyed): the `available` BOOLEAN is unchanged from pre-change;
 * the only new output is the additive `'not-on-key'` reason on a live-omitted static model — informational.
 *
 * ADR-0064 §6 amendment (ADR-0071): before dimming a live-omitted model, {@link hasLiveSibling} rescues an
 * alias↔dated-pin pair — the id the provider's list left out is still callable on the same key.
 */
function resolveAvailability(
  modelId: string,
  t: Tiers,
  live: ReadonlyMap<ProviderId, readonly ModelListing[]>,
  keyedProviders: ReadonlySet<ProviderId> | undefined,
): { available: boolean; unavailableReason?: 'no-key' | 'not-on-key' } {
  const providerKeyed = keyedProviders === undefined || keyedProviders.has(t.provider);
  if (!providerKeyed) return { available: false, unavailableReason: 'no-key' };
  if (live.has(t.provider)) {
    if (t.live !== undefined) return { available: true };
    if (hasLiveSibling(modelId, t.provider, live)) return { available: true };
    return { available: false, unavailableReason: 'not-on-key' };
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
  // The refreshed catalog when the host installed one, else the shipped snapshot — `catalogModel` decides, so the
  // picker shows a model a `models refresh --catalog` just added without a second merge path.
  for (const id of catalogModelIds()) {
    const entry = catalogModel(id);
    if (entry === undefined) continue;
    tiers.set(entry.modelId, { provider: entry.provider, catalog: toPricing(entry) });
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
  // USER OUTRANKS THE CATALOG (ADR-0071 §1) — the flip. The old rule was registry-first, and it made sense while
  // the registry was our own verified table: a user could not misprice a shipped model. The catalog is a snapshot
  // of a third-party aggregator, and the user is the one holding the invoice. Their negotiated rate, their
  // enterprise discount, or simply a price we have not re-synced is not a hint to be overruled by a generated file.
  const pricing = t.user ?? t.catalog;
  const pricingSource = pricingSourceOf(t);
  // The LIMITS stay live-first: a provider's own list is the freshest word on its own model's window, and a user
  // pricing row rarely carries one. Below it, the same user > catalog order as the price.
  const contextWindowTokens =
    t.live?.contextWindowTokens ?? t.user?.contextWindowTokens ?? t.catalog?.contextWindowTokens;
  const maxOutputTokens =
    t.live?.maxOutputTokens ?? t.user?.maxOutputTokens ?? t.catalog?.maxOutputTokens;
  const { available, unavailableReason } = resolveAvailability(
    modelId,
    t,
    live,
    input.keyedProviders,
  );
  // Deprecation is a UNION of three sources, and the EARLIEST wins — a warning is only useful before the date.
  //
  // models.dev publishes a `status` flag, not a date, so the retirement date lives in Relavium's own small overlay
  // (ADR-0071 §10 — an editorial call about our users, not a data fact). It is NOT a second pricing home: one date
  // per model, from a published announcement. The first version of the swap dropped it on the theory that the live
  // list would carry it — but no adapter populates `ModelListing.deprecatedAt` (the OpenAI list is id-only), so
  // `deprecated` was permanently `false` for every model in the product and `deepseek-chat` was set to stop working
  // in eleven days with nothing to say so.
  const deprecatedAt = earlierIsoDate(
    earlierIsoDate(deprecationFor(modelId), t.live?.deprecatedAt),
    t.user?.deprecatedAt,
  );
  const parsedDeprecation = deprecatedAt === undefined ? Number.NaN : Date.parse(deprecatedAt);
  const deprecated = !Number.isNaN(parsedDeprecation) && parsedDeprecation <= input.now;
  return {
    modelId,
    provider: t.provider,
    // The catalog's name first: models.dev carries a curated one ("GPT-5.4 Pro"), while a provider's live list
    // often echoes the raw id back. A user row's name is the last resort — they set a PRICE, not a label.
    displayName: t.catalog?.displayName ?? t.live?.displayName ?? t.user?.displayName ?? modelId,
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(pricing !== undefined ? { pricing } : {}),
    pricingSource,
    priceKnown: pricingSource !== 'none',
    available,
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
    deprecated,
    ...(deprecatedAt !== undefined ? { deprecatedAt } : {}),
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
