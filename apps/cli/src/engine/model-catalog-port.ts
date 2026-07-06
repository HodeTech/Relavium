import { createModelCatalogStore, createProviderStore, type Db } from '@relavium/db';

import { buildMergedCatalog, type MergedCatalogView } from './model-catalog-view.js';
import { createModelRefreshService, type RefreshReport } from './model-refresh.js';
import {
  KNOWN_PROVIDERS,
  KNOWN_PROVIDER_IDS,
  providerHasKey,
  type ProviderResolver,
} from './providers.js';

/**
 * The catalog-loading trio shared by the Home `/models` picker (ADR-0064 §10 — writes the next-session default) and
 * the chat `/models` reseat picker (ADR-0059 — rebinds the live session). Built over the ONE open `history.db`
 * handle + the provider resolver so both surfaces read the SAME merged catalog + run the SAME long-lived-process
 * TTL background refresh; each surface layers its own accept action on top. Factored here so the two surfaces can
 * never drift on how the catalog is loaded, keyed (which provider has a key), or refreshed.
 */
export interface ModelCatalogPort {
  /** The merged catalog (all providers) + the newest live-refresh stamp (the freshness badge). Sync read + merge. */
  readonly load: () => MergedCatalogView;
  /** TTL-bounded background refresh (ADR-0064 §5c) — refreshes empty/stale providers; `undefined` when none were. */
  readonly refreshIfStale: () => Promise<RefreshReport | undefined>;
  /** Unbounded, user-initiated refresh (Ctrl+R) — every connected provider, per-provider-isolated. Never rejects. */
  readonly refresh: () => Promise<RefreshReport>;
}

export function createModelCatalogPort(params: {
  readonly db: Db;
  readonly providers: ProviderResolver;
  readonly now: () => number;
  readonly uuid: () => string;
}): ModelCatalogPort {
  const storeDeps = { uuid: params.uuid, now: params.now };
  const providerStore = createProviderStore(params.db, storeDeps);
  const catalogStore = createModelCatalogStore(params.db, storeDeps);
  const refreshService = createModelRefreshService({
    resolveProvider: params.providers.resolveProvider,
    keyFor: params.providers.keyFor,
    providerStore,
    catalogStore,
    knownProviderIds: KNOWN_PROVIDER_IDS,
    knownProviders: KNOWN_PROVIDERS,
    now: params.now,
  });
  // Memoized: a keychain read is a SYNC native N-API call (and can pop an OS ACL prompt on first access), so it must
  // not repeat on every `/models` open + every refresh completion on the live ink render thread. The resolvable key
  // set is fixed for the process (a mid-session key change ⇒ restart), the same posture as the startup key probe.
  let keyedProviders: ReadonlySet<(typeof KNOWN_PROVIDER_IDS)[number]> | undefined;
  return {
    load: () => {
      // Rebuild the UUID→slug map on every load (NOT memoized): a refresh may register a provider's FK row, and the
      // next load must resolve its live rows' provider — not drop them (mirrors the Home's load).
      const slugByUuid = new Map(providerStore.list().map((p) => [p.id, p.name] as const));
      keyedProviders ??= new Set(KNOWN_PROVIDER_IDS.filter((id) => providerHasKey(params.providers, id)));
      return buildMergedCatalog({
        rows: catalogStore.listAll(),
        providerSlug: (uuid) => slugByUuid.get(uuid) ?? uuid,
        keyedProviders,
        now: params.now(),
      });
    },
    refreshIfStale: () => refreshService.refreshIfStale(),
    refresh: () => refreshService.refresh(),
  };
}
