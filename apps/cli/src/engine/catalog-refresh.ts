import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  CATALOG_PROVIDER_KEYS,
  ModelsDevPayloadSchema,
  catalogModelIds,
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

/** models.dev's payload is ~1 MB. A generous ceiling — and a REAL one: `readCapped` aborts the transfer the
 *  moment a body exceeds it, rather than buffering an endless one and checking its length too late. */
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
  const fetched = await fetchModelsDevPayload(deps);
  if (typeof fetched !== 'string') return fetched; // a classified network/HTTP failure — the snapshot answers

  // INSTALL is a SEPARATE failure domain from the network. A Zod / parse / normalization throw here means models.dev
  // was REACHABLE but sent something we cannot use — reporting that as "unreachable" or "timed out" would point the
  // user at the wrong problem. Its own generic reason, and NEVER the raw error text (a Zod message can echo the very
  // payload fields we refuse to surface).
  try {
    return install(fetched, deps.homeDir);
  } catch {
    return { status: 'failed', models: 0, added: 0, reason: 'models.dev sent a catalog we could not read' };
  }
}

/**
 * Fetch and read the models.dev body, CLASSIFIED. Returns the raw text on success, or a `failed` result naming the
 * network / HTTP fault (timeout, unreachable, non-2xx, off-host redirect, over-cap). Never surfaces a raw upstream
 * error string. Kept separate from {@link install} so a malformed-payload fault is not mistaken for a network one.
 */
async function fetchModelsDevPayload(deps: CatalogRefreshDeps): Promise<string | CatalogRefreshResult> {
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
      return { status: 'failed', models: 0, added: 0, reason: `models.dev returned ${response.status}` };
    }
    // The response URL must still be models.dev — belt to the `redirect: 'manual'` braces, in case a fetch
    // implementation resolves one anyway.
    if (response.url !== '' && new URL(response.url).hostname !== SOURCE_HOST) {
      return { status: 'failed', models: 0, added: 0, reason: 'models.dev redirected off-host' };
    }
    const text = await readCapped(response, controller);
    if (text === undefined) {
      return { status: 'failed', models: 0, added: 0, reason: 'models.dev payload is too large' };
    }
    return text;
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

/**
 * Read the body, ABORTING the moment it exceeds the cap — not after buffering the whole thing (ADR-0071 §8).
 *
 * `response.text()` reads everything into memory first and only then checks the length, so on a fast link a
 * misbehaving host could deliver many times the cap inside the timeout before the check ever fired. `MAX_BYTES` is
 * meant to REFUSE an endless body, and a check after the buffer does not refuse anything. Streaming the reader and
 * aborting on overflow makes the ceiling real. `undefined` ⇒ over the cap (the caller degrades to the snapshot).
 *
 * A body with no reader (a test `Response`, an empty body) falls back to `text()` — bounded there by the cap check
 * on the fully-read string, which is fine because such a body was never the streaming threat.
 */
async function readCapped(
  response: Response,
  controller: AbortController,
): Promise<string | undefined> {
  const body = response.body;
  if (body === null) {
    const text = await response.text();
    return text.length > MAX_BYTES ? undefined : text;
  }
  const decoder = new TextDecoder();
  let out = '';
  let bytes = 0;
  // `ReadableStream` is untyped in the DOM lib (`ReadableStream<any>`), so type the reader explicitly — otherwise
  // `value` is `any` and the byte-count arithmetic reads as unsafe.
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    bytes += value.byteLength;
    if (bytes > MAX_BYTES) {
      controller.abort(); // stop the transfer NOW — do not read another chunk
      return undefined;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/** Load a previously-cached refresh, if there is one. Silent on absence or corruption — the snapshot answers. */
export function loadCachedCatalog(homeDir: string): CatalogRefreshResult | undefined {
  try {
    // The SAME parse the fetch path runs, over the SAME raw payload — one normalizer, one shape, no second code path
    // that could drift. A tampered or truncated cache fails Zod here and lands on the snapshot, exactly like a bad
    // fetch does.
    const models = parse(readFileSync(catalogCachePath(homeDir), 'utf8'));
    const added = installCatalogRefresh(models);
    return { status: 'refreshed', models: catalogModelIds().length, added };
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
  const added = installCatalogRefresh(models); // the count the FLOOR admitted, not the count the payload offered
  writeCache(text, homeDir);
  return {
    // TOTAL describable after the install — the shipped snapshot plus whatever the refresh added — and how many of
    // those were new. `models: 200, added: 120` reads as "200 models, 120 the snapshot didn't carry".
    status: 'refreshed',
    models: catalogModelIds().length,
    added,
  };
}

/**
 * Cache the payload, filtered to the FOUR providers we have an adapter for.
 *
 * models.dev ships 166 providers and ~5,600 models — the 2–3 MB blob ADR-0071 §3 explicitly declined to vendor. We
 * consume four of them, and `seedCatalog` re-reads + re-parses this file on EVERY invocation, including `--help`.
 * Caching the whole thing taxes the cheapest, hottest commands with a parse we throw almost all of away. Filtering
 * to the mapped providers keeps the file small AND keeps it RAW-per-provider, so a future release that fixes a
 * normalization bug still repairs the cache on the next load.
 *
 * A cache-WRITE failure is not a refresh failure: the models are already live in this process; the cache just will
 * not outlive it. Written temp-then-rename so a concurrent reader never sees a torn file.
 */
function writeCache(text: string, homeDir: string): void {
  const path = catalogCachePath(homeDir);
  try {
    const parsed: unknown = JSON.parse(text);
    const filtered: Record<string, unknown> = {};
    if (parsed !== null && typeof parsed === 'object') {
      for (const key of Object.values(CATALOG_PROVIDER_KEYS)) {
        const provider = (parsed as Record<string, unknown>)[key];
        if (provider !== undefined) filtered[key] = provider;
      }
    }
    mkdirSync(dirname(path), { recursive: true });
    // temp-then-rename: rename is atomic on the same filesystem, so a reader either sees the OLD cache or the NEW
    // one, never a half-written body. `${pid}` keeps two concurrent refreshes from racing on the same temp name.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(filtered), 'utf8');
    renameSync(tmp, path);
  } catch {
    // A read-only home, a full disk, an unparseable body we somehow got past `parse` — the refresh HELD regardless.
  }
}
