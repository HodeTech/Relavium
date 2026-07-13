import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  CATALOG_SNAPSHOT,
  ModelsDevPayloadSchema,
  installCatalogRefresh,
  normalizeCatalog,
  type CatalogModel,
} from '@relavium/llm';

/**
 * The models.dev catalog refresh (ADR-0071 §4) — the HOST half of the seam.
 *
 * `@relavium/llm` does no I/O: it takes a catalog as plain data and answers questions about it. Fetching a URL and
 * writing a file are platform work, so they live here, exactly where the provider refresh already lives. The pure
 * merge stays pure.
 *
 * **Default OFF.** `[catalog] auto_refresh` is `false`, and this module runs only when the user asks — either by
 * typing `relavium models refresh`, which IS consent, or by turning the key on themselves. A local-first tool that
 * contacts a third party by default violates its own spirit even when the payload is innocuous (CLAUDE.md rule 6),
 * so the shipped snapshot answers everything, offline, until someone decides otherwise.
 *
 * **Additive only.** A refresh may add models and enrich thin ones; it may never leave a model less described than
 * it shipped. A failed, unreachable, or malformed refresh is a NO-OP — the snapshot stands. The cost cap is a safety
 * control, and it does not get to lapse because a third party had a bad deploy.
 */

/** The one destination. A compile-time constant, not user- and not model-supplied — see ADR-0071 §8. */
const SOURCE_URL = 'https://models.dev/api.json';
const SOURCE_HOST = 'models.dev';

/** models.dev's payload is ~1 MB. A generous ceiling that still refuses an endless body. */
const MAX_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/** Where a refreshed catalog is cached, so the next process starts current without re-fetching. */
export function catalogCachePath(homeDir: string): string {
  return join(homeDir, 'catalog', 'models-dev.json');
}

/** What a `--catalog` refresh did, for the report and for `--json`. */
export interface CatalogRefreshResult {
  readonly status: 'refreshed' | 'failed';
  /** Models the refreshed catalog describes. `0` on a failure (the snapshot still answers). */
  readonly models: number;
  /** Models the shipped snapshot did NOT carry — the reason to run this at all. */
  readonly added: number;
  /** A short, actionable reason. Never a raw fetch error (it can carry a URL); never a key (there is none to leak). */
  readonly reason?: string;
}

export interface CatalogRefreshDeps {
  readonly homeDir: string;
  /** Injectable for tests — the real one is global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Fetch models.dev, validate it, install it, and cache it to disk.
 *
 * Every failure mode lands on the same answer — **the shipped snapshot** — so this can never make the product worse
 * than not running it. It returns the outcome rather than throwing, because "the network was down" is not a reason
 * to fail a command the user ran to *look at their models*.
 */
export async function refreshCatalog(deps: CatalogRefreshDeps): Promise<CatalogRefreshResult> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await doFetch(SOURCE_URL, {
      signal: controller.signal,
      // NO credentials, NO cookies, NO user data — an unauthenticated GET of a public file (ADR-0071 §8).
      headers: { accept: 'application/json' },
      // A redirect OFF models.dev is an error, not a hop: the destination is the point of the posture. `manual`
      // surfaces the 3xx as a non-ok response rather than quietly following it somewhere else.
      redirect: 'manual',
    });
    if (!response.ok) {
      return {
        status: 'failed',
        models: 0,
        added: 0,
        reason: `models.dev returned ${response.status}`,
      };
    }
    // The response URL must still be models.dev — belt to the `redirect: 'manual'` braces, in case a fetch
    // implementation resolves one anyway.
    if (response.url !== '' && new URL(response.url).hostname !== SOURCE_HOST) {
      return { status: 'failed', models: 0, added: 0, reason: 'models.dev redirected off-host' };
    }
    const text = await response.text();
    if (text.length > MAX_BYTES) {
      return { status: 'failed', models: 0, added: 0, reason: 'models.dev payload is too large' };
    }
    return install(text, deps.homeDir);
  } catch (err) {
    // A timeout, a DNS failure, an offline laptop. The snapshot answers; the user is told, and nothing breaks.
    return {
      status: 'failed',
      models: 0,
      added: 0,
      reason:
        err instanceof Error && err.name === 'AbortError'
          ? 'models.dev timed out'
          : 'models.dev unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Load a previously-cached refresh, if there is one. Silent on absence or corruption — the snapshot answers. */
export function loadCachedCatalog(homeDir: string): CatalogRefreshResult | undefined {
  try {
    // The SAME parse the fetch path runs, over the SAME raw payload — one normalizer, one shape, no second code path
    // that could drift. A tampered or truncated cache fails Zod here and lands on the snapshot, exactly like a bad
    // fetch does.
    const models = parse(readFileSync(catalogCachePath(homeDir), 'utf8'));
    installCatalogRefresh(models);
    return { status: 'refreshed', models: Object.keys(models).length, added: countAdded(models) };
  } catch {
    // No cache, or a cache we cannot read. Not an error: the shipped snapshot is the floor, not a fallback.
    return undefined;
  }
}

/** Parse + normalize a models.dev payload into Relavium's own types. Throws on a payload we cannot use. */
function parse(text: string): Record<string, CatalogModel> {
  // Zod at the boundary, never a cast: the payload is a third party's JSON, and it now feeds a safety control.
  // `normalizeCatalog` is the SAME function the offline snapshot generator uses, so a refreshed row and a shipped row
  // cannot end up shaped differently — the discipline ADR-0064 §1 already applies to a provider's `ModelListing`.
  const payload = ModelsDevPayloadSchema.parse(JSON.parse(text));
  const { catalog } = normalizeCatalog(payload);
  return catalog;
}

/**
 * Normalize, install, and cache — the RAW payload, not the normalized one.
 *
 * The cache holds exactly what models.dev sent. Caching the normalized rows instead would freeze TODAY's normalizer
 * into the file: a Relavium release that fixes a normalization bug (a mis-read reasoning shape, a dropped cache
 * rate) would go on serving the old, wrong rows to every user who had ever refreshed, and nothing would tell them.
 * Re-normalizing on load means an upgrade repairs the cache for free.
 *
 * A cache-WRITE failure is not a refresh failure: the models are already live in this process. It just will not
 * survive it.
 */
function install(text: string, homeDir: string): CatalogRefreshResult {
  const models = parse(text); // throws on a payload we cannot use — the caller turns that into a no-op
  installCatalogRefresh(models);
  const path = catalogCachePath(homeDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
  } catch {
    // A read-only home, a full disk.
  }
  return {
    status: 'refreshed',
    models: Object.keys(models).length,
    added: countAdded(models),
  };
}

/**
 * How many of these the shipped snapshot did not carry — the number that answers "why run this at all?".
 *
 * Counted against `CATALOG_SNAPSHOT` directly, NOT against `catalogModelIds()`: by the time this runs the refresh is
 * already installed, so asking the live lookup would compare the new catalog against itself and always answer zero.
 */
function countAdded(models: Record<string, CatalogModel>): number {
  let added = 0;
  for (const id of Object.keys(models)) {
    if (CATALOG_SNAPSHOT[id] === undefined) added += 1;
  }
  return added;
}
