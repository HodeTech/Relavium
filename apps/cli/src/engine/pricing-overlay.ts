import { randomUUID } from 'node:crypto';

import { createModelCatalogStore, createProviderStore, type Db } from '@relavium/db';
import type { PricingOverlay } from '@relavium/llm';

import { openLocalDb } from '../db/open.js';
import { buildUserPricing } from './model-catalog-view.js';

/**
 * The host loader for the ADR-0065 §2 USER-pricing overlay (workstream **2.5.G S10**) — the `ReadonlyMap<modelId,
 * ModelPricing>` every cost-enforcing surface injects into its budget governor + realized `CostTracker` so a model
 * with no static price, once user-priced, is enforced by `max_cost_microcents` (the cost-cap gap ADR-0064 §6 left
 * open). It is the DB-facing counterpart of the pure {@link buildUserPricing}: it projects the `model_catalog`
 * `source='user'` rows (translating each internal provider UUID → its slug) into the one overlay that serves both
 * the pre-egress estimate and the realized fold. Static `MODEL_PRICING` still wins for a known id — the user tier
 * only fills an UNKNOWN id — so a user can never silently misprice a shipped model.
 *
 * Living in the host (not `@relavium/core`/`@relavium/llm`) is what keeps the engine platform-free: the engine
 * receives a plain injected map, exactly like `keyFor`, and never imports `@relavium/db`.
 */

/** Fresh store deps for a transient read — a self-generated UUID source + wall clock (no row is written here). */
const readStoreDeps = { uuid: () => randomUUID(), now: () => Date.now() } as const;

/**
 * Build the overlay over an ALREADY-OPEN local db — the caller owns the db lifecycle (the Home + the run path both
 * already hold a `history.db` handle for the session/run store). Reads a fresh `listAll()` snapshot so a mid-session
 * `models pricing` write is reflected on the next build. Never writes; never throws on data (a non-`user` or
 * non-enum-provider row is skipped by {@link buildUserPricing}).
 */
export function buildUserPricingOverlay(db: Db): PricingOverlay {
  const catalogStore = createModelCatalogStore(db, readStoreDeps);
  const providerStore = createProviderStore(db, readStoreDeps);
  // Eager (not the lazy-memoized dispatch resolver): there is no refresh-then-render window here — the map is built
  // and consumed in one breath, so a plain snapshot of the current provider rows is correct.
  const slugByUuid = new Map(providerStore.list().map((p): [string, string] => [p.id, p.name]));
  return buildUserPricing({
    rows: catalogStore.listAll(),
    providerSlug: (uuid) => slugByUuid.get(uuid) ?? uuid,
  });
}

/**
 * The NON-FATAL variant of {@link buildUserPricingOverlay} for a surface that ALREADY holds an open db (`run`,
 * `gate`, `chat-resume`, and the `/clear` rebuild): a READ fault (a corrupt provider/catalog row — e.g.
 * `providerStore.list()` throwing on a tampered `default_headers`) degrades to an EMPTY overlay rather than
 * propagating, so the overlay is never the thing that fails an otherwise-valid run/resume. It mirrors the same
 * best-effort contract {@link loadUserPricingOverlay} gives the transient-open surfaces — the caller's own store /
 * run path is the authoritative fault report. Returns a non-`undefined` empty map (the db is already open here, so
 * there is no open-fault case to signal).
 */
export function readUserPricingOverlay(db: Db): PricingOverlay {
  try {
    return buildUserPricingOverlay(db);
  } catch {
    return new Map();
  }
}

/**
 * Load the overlay via a SELF-CONTAINED transient open→read→close, for a surface with no db handle of its own yet
 * (`relavium chat`, one-shot `agent run`). Deliberately NON-FATAL: an unopenable/unmigratable `history.db` yields
 * `undefined` (cost governance degrades to the no-overlay behavior — unknown models `allow` loudly), so the db
 * fault surfaces through the surface's OWN store-open error path (a clean exit 2), not an opaque throw here. The
 * transient handle closes before the surface opens its real store — sequential opens of the one SQLite file.
 */
export function loadUserPricingOverlay(homeDir: string): PricingOverlay | undefined {
  let opened: { db: Db; close: () => void };
  try {
    opened = openLocalDb(homeDir);
  } catch {
    return undefined; // a broken db is reported by the surface's own store open, not this best-effort read
  }
  try {
    return buildUserPricingOverlay(opened.db);
  } catch {
    // A READ fault too (a corrupt provider/catalog row, a locked table) degrades to `undefined` — the docstring's
    // "any db fault ⇒ undefined" contract is unconditional, so the overlay is never the thing that crashes a
    // surface; the surface's own store open is the authoritative fault report.
    return undefined;
  } finally {
    opened.close();
  }
}
