import type { ModelCatalogListing, ModelCatalogLiveModel } from '@relavium/db';
import type { AbortSignalLike, LlmProvider, ModelListing, ProviderId } from '@relavium/llm';

/**
 * The live model-catalog refresh orchestrator (workstream **2.5.G S5**, [ADR-0064](../../../../docs/decisions/0064-live-model-catalog.md)
 * §5). A **host service with injected deps** so desktop / VS Code reuse it later and `@relavium/llm` /
 * `@relavium/core` stay platform-free ([ADR-0038](../../../../docs/decisions/0038-agentrunner-llm-call-boundary.md)).
 * For each CONNECTED provider (a key resolves) it fetches the live model list over the S2 `listModels?` seam
 * (already bounded + abortable + secret-free), ensures the `llm_providers` row (FK target) exists, and bulk-
 * upserts the discovered ids into the `model_catalog` live cache (S4 `replaceProviderModels`).
 *
 * SECURITY (this is a key-reading, egressing surface):
 *  - A provider key is read ONLY via {@link ModelRefreshDeps.keyFor} per provider per call and handed straight
 *    to `listModels` — it is NEVER logged, persisted (the `model_catalog` holds no key), or placed in a
 *    {@link RefreshReport} / `--json` payload / error message. `listModels`'s failure is already key-redacted +
 *    cause-stripped by the seam's `boundedListModels`, so a failed provider surfaces only `error.message` (or a
 *    generic `'refresh failed'`), never `err.cause`.
 *  - Per-provider ISOLATION (`Promise.allSettled`): one provider's failure (bad key, network, drift throw, or
 *    an adapter with no `listModels`) NEVER fails the whole refresh — it is recorded as `status: 'failed'` /
 *    `'skipped-unsupported'` and the others still refresh (ADR-0064 §5/§8).
 *  - {@link ModelRefreshService.refreshInBackground} is fire-and-forget and swallows ALL errors so a rejection
 *    is never unhandled and never surfaces a stack; it sets no timer of its own (the seam owns the fetch bound).
 */

/** A provider's discovery/refresh outcome. `refreshed` wrote live rows; `skipped-no-key` had no resolvable key
 *  (not an error); `skipped-unsupported` has no `listModels` (degrade to static); `failed` threw (isolated). */
export type RefreshProviderStatus =
  | 'refreshed'
  | 'skipped-no-key'
  | 'skipped-unsupported'
  | 'failed';

/** One provider's line in a {@link RefreshReport} — key-free by construction (no key ever enters this shape). */
export interface RefreshProviderResult {
  readonly provider: ProviderId;
  readonly status: RefreshProviderStatus;
  /** Live model ids newly added this refresh (present only on `refreshed`). */
  readonly added?: number;
  /** Live model ids that already existed and were refreshed in place (present only on `refreshed`). */
  readonly updated?: number;
  /** Previously-active live model ids soft-deactivated because they vanished from the list (present only on `refreshed`). */
  readonly deactivated?: number;
  /** A SECRET-FREE failure reason (the seam already redacts) — present only on `failed`. */
  readonly error?: string;
}

/** The whole-refresh report: one {@link RefreshProviderResult} per considered provider, ordered by provider id. */
export interface RefreshReport {
  readonly providers: readonly RefreshProviderResult[];
}

/** Options common to {@link ModelRefreshService.refresh} / `refreshIfStale` / `refreshInBackground`. */
export interface RefreshOptions {
  /** Restrict the refresh to these provider ids (default: {@link ModelRefreshDeps.knownProviderIds}). */
  readonly providers?: readonly ProviderId[];
  /** Aborts each in-flight `listModels` request (threaded to the seam). */
  readonly signal?: AbortSignalLike;
}

/** The non-secret provider metadata the refresh needs to (re)register the `llm_providers` FK-target row. */
export interface RefreshProviderMeta {
  readonly displayName: string;
  readonly baseUrl: string;
}

/** The narrow provider-store surface the refresh needs (the FK-target row lifecycle only). */
export interface RefreshProviderStore {
  readonly upsert: (input: {
    readonly name: string;
    readonly displayName: string;
    readonly baseUrl: string;
  }) => { readonly id: string };
  readonly get: (name: string) => { readonly id: string } | undefined;
}

/** The narrow catalog-store surface the refresh needs (the S4 live-refresh + read/freshness reads). */
export interface RefreshCatalogStore {
  readonly replaceProviderModels: (
    providerId: string,
    rows: ReadonlyArray<ModelCatalogLiveModel>,
    now: number,
  ) => void;
  readonly listByProvider: (providerId: string) => ModelCatalogListing[];
  readonly providerRefreshedAt: (providerId: string) => number | undefined;
}

export interface ModelRefreshDeps {
  /** The keyless `@relavium/llm` adapter for a provider id (from the injected {@link ProviderResolver}). */
  readonly resolveProvider: (id: ProviderId) => LlmProvider | undefined;
  /** Resolve a provider's key (keychain → env → throw). Thrown ⇒ the provider is skipped (`skipped-no-key`). */
  readonly keyFor: (id: ProviderId) => string;
  readonly providerStore: RefreshProviderStore;
  readonly catalogStore: RefreshCatalogStore;
  /** The provider ids to consider by default (production: `KNOWN_PROVIDER_IDS`). */
  readonly knownProviderIds: readonly ProviderId[];
  /** Non-secret display/base-URL metadata for the FK-target `llm_providers` row (production: `KNOWN_PROVIDERS`). */
  readonly knownProviders: Readonly<Record<ProviderId, RefreshProviderMeta>>;
  /** Injected clock — the `last_refreshed_at` stamp + the TTL comparison read from here (never `Date.now()`). */
  readonly now: () => number;
}

export interface ModelRefreshService {
  /** Force-refresh every connected provider (or `opts.providers`), per-provider-isolated. Never rejects. */
  refresh(opts?: RefreshOptions): Promise<RefreshReport>;
  /** Refresh only providers whose live cache is empty/never-refreshed or older than {@link TTL_MS}; `undefined`
   *  when nothing was stale. */
  refreshIfStale(opts?: RefreshOptions): Promise<RefreshReport | undefined>;
  /** Fire-and-forget non-blocking TTL refresh (ADR-0064 §5c). Swallows ALL errors; sets no timer. The actual
   *  picker/Home trigger is S7's wiring — S5 provides the mechanism only. */
  refreshInBackground(opts?: RefreshOptions): void;
}

/** The staleness TTL (ADR-0064 §5): a provider's live cache older than 24h (or empty) is refreshed. */
export const TTL_MS = 24 * 60 * 60 * 1000;

/** Map a seam {@link ModelListing} → the S4 store's live-model shape (discovery half only; no pricing/media). */
function toLiveModel(listing: ModelListing): ModelCatalogLiveModel {
  return {
    modelId: listing.id,
    // The store falls back to the model id on an empty display name — pass `''` when the provider gave none.
    displayName: listing.displayName ?? '',
    ...(listing.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: listing.contextWindowTokens }),
    ...(listing.maxOutputTokens === undefined ? {} : { maxOutputTokens: listing.maxOutputTokens }),
  };
}

/** The provider's currently-active `source='live'` model ids (the before/after diff basis). */
function liveModelIds(listings: readonly ModelCatalogListing[]): Set<string> {
  const ids = new Set<string>();
  for (const listing of listings) {
    if (listing.source === 'live') {
      ids.add(listing.modelId);
    }
  }
  return ids;
}

/** |a \ b| — the count of members of `a` absent from `b`. */
function countMissing(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const id of a) {
    if (!b.has(id)) n += 1;
  }
  return n;
}

/** |a ∩ b|. */
function countShared(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const id of a) {
    if (b.has(id)) n += 1;
  }
  return n;
}

/**
 * A SECRET-FREE failure reason. The seam's `boundedListModels` already redacts the key AND strips the cause,
 * so its `error.message` is safe to surface; a non-Error / empty message degrades to a generic string. We NEVER
 * read `err.cause` (it could carry a nested field a verbose render might expose — the `validateProviderKey` rule).
 */
function secretFreeReason(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== '') {
    return err.message;
  }
  return 'refresh failed';
}

/** Create the refresh orchestrator over its injected deps. Pure of platform I/O beyond the injected ports. */
export function createModelRefreshService(deps: ModelRefreshDeps): ModelRefreshService {
  /** Refresh ONE connected provider (its key already resolved). NEVER throws — a fault becomes `status:'failed'`. */
  const refreshOne = async (
    id: ProviderId,
    key: string,
    signal: AbortSignalLike | undefined,
  ): Promise<RefreshProviderResult> => {
    try {
      const adapter = deps.resolveProvider(id);
      if (adapter?.listModels === undefined) {
        // No adapter, or an adapter without the optional list capability — degrade to static (ADR-0064 §1/§5).
        return { provider: id, status: 'skipped-unsupported' };
      }
      // The key reaches ONLY this call; the seam bounds + aborts + redacts it.
      const listings = await adapter.listModels(key, signal);

      // Ensure the FK-target `llm_providers` row exists BEFORE writing model rows (FK ordering). The metadata is
      // non-secret; the row never carries a key.
      const meta = deps.knownProviders[id];
      const providerUuid = deps.providerStore.upsert({
        name: id,
        displayName: meta.displayName,
        baseUrl: meta.baseUrl,
      }).id;

      const before = liveModelIds(deps.catalogStore.listByProvider(providerUuid));
      const rows = listings.map(toLiveModel);
      deps.catalogStore.replaceProviderModels(providerUuid, rows, deps.now());
      const after = liveModelIds(deps.catalogStore.listByProvider(providerUuid));

      return {
        provider: id,
        status: 'refreshed',
        added: countMissing(after, before),
        updated: countShared(before, after),
        deactivated: countMissing(before, after),
      };
    } catch (err) {
      return { provider: id, status: 'failed', error: secretFreeReason(err) };
    }
  };

  const refresh = async (opts?: RefreshOptions): Promise<RefreshReport> => {
    const candidates = opts?.providers ?? deps.knownProviderIds;
    const signal = opts?.signal;

    // Partition: a provider whose key does NOT resolve is skipped (not an error); the rest are connected and run
    // in parallel with per-provider isolation.
    const results: RefreshProviderResult[] = [];
    const connected: { readonly id: ProviderId; readonly key: string }[] = [];
    for (const id of candidates) {
      let key: string;
      try {
        key = deps.keyFor(id);
      } catch {
        results.push({ provider: id, status: 'skipped-no-key' });
        continue;
      }
      connected.push({ id, key });
    }

    const settled = await Promise.allSettled(
      connected.map(({ id, key }) => refreshOne(id, key, signal)),
    );
    settled.forEach((outcome, index) => {
      const entry = connected[index];
      if (entry === undefined) return; // unreachable — 1:1 with `connected`
      // `refreshOne` catches internally, so `rejected` is defence-in-depth (never a leaked stack).
      results.push(
        outcome.status === 'fulfilled'
          ? outcome.value
          : { provider: entry.id, status: 'failed', error: 'refresh failed' },
      );
    });

    // Deterministic order regardless of settle timing (a stable report for the human table + the --json stream).
    results.sort((a, b) => a.provider.localeCompare(b.provider));
    return { providers: results };
  };

  const refreshIfStale = async (opts?: RefreshOptions): Promise<RefreshReport | undefined> => {
    const candidates = opts?.providers ?? deps.knownProviderIds;
    const now = deps.now();
    const stale: ProviderId[] = [];
    for (const id of candidates) {
      // Only a CONNECTED provider can be refreshed — an unconnected one is never "stale" (nothing to fetch).
      try {
        deps.keyFor(id);
      } catch {
        continue;
      }
      const record = deps.providerStore.get(id);
      const refreshedAt =
        record === undefined ? undefined : deps.catalogStore.providerRefreshedAt(record.id);
      if (refreshedAt === undefined || now - refreshedAt >= TTL_MS) {
        stale.push(id);
      }
    }
    if (stale.length === 0) {
      return undefined;
    }
    return refresh({
      providers: stale,
      ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
    });
  };

  const refreshInBackground = (opts?: RefreshOptions): void => {
    // Fire-and-forget: the `.catch` swallows ALL errors so a rejection is never unhandled and never surfaces a
    // stack. We set NO timer here (the seam owns the per-request bound), so nothing of ours can keep a
    // short-lived CLI process alive; the caller (S7 picker/Home) governs process lifecycle.
    void refreshIfStale(opts).catch(() => {
      /* intentionally swallowed — a background refresh must stay silent and non-fatal */
    });
  };

  return { refresh, refreshIfStale, refreshInBackground };
}
