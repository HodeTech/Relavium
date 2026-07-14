import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CATALOG_SNAPSHOT, catalogModel, clearCatalogRefresh } from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { catalogCachePath, loadCachedCatalog, refreshCatalog } from './catalog-refresh.js';

/**
 * The models.dev catalog refresh (ADR-0071 §4/§8).
 *
 * Two promises, and they are the whole test surface:
 *
 *   1. **Additive only.** A refresh may add models and enrich thin ones. It may NEVER leave a model less described
 *      than it shipped — a failed, unreachable, or malformed refresh is a NO-OP, not a downgrade and not a blank
 *      catalog. The cost cap is a safety control, and it does not lapse because a third party had a bad deploy.
 *   2. **One destination, no credentials.** models.dev, over HTTPS, with no key, no cookie and no user data — and a
 *      redirect OFF models.dev is an error, not a hop.
 */

let home: string;

/** A minimal, VALID models.dev payload — the same shape the offline snapshot generator eats. */
function payload(models: Record<string, unknown>): string {
  return JSON.stringify({
    openai: {
      models: Object.fromEntries(
        Object.entries(models).map(([id, m]) => [
          id,
          {
            id,
            name: id,
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 1, output: 2 },
            ...(m as object),
          },
        ]),
      ),
    },
  });
}

function respond(body: string, init: ResponseInit = {}): typeof globalThis.fetch {
  return () => Promise.resolve(new Response(body, { status: 200, ...init }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'relavium-catalog-'));
});

afterEach(() => {
  clearCatalogRefresh(); // module state — a leaked refresh would poison every later test in the process
  rmSync(home, { recursive: true, force: true });
});

describe('refreshCatalog — additive only, and the shipped snapshot is the floor', () => {
  it('ADDS a model the snapshot never carried — the reason to run it at all', async () => {
    expect(catalogModel('gpt-6-imaginary')).toBeUndefined(); // the premise

    const result = await refreshCatalog({
      homeDir: home,
      fetch: respond(payload({ 'gpt-6-imaginary': {} })),
    });

    expect(result.status).toBe('refreshed');
    expect(result.added).toBe(1);
    expect(catalogModel('gpt-6-imaginary')?.inputPerMtokMicrocents).toBe(100_000_000); // $1/MTok
  });

  it('an UNREACHABLE models.dev is a NO-OP — every shipped model is still priced', async () => {
    const before = catalogModel('gpt-5.5');
    const result = await refreshCatalog({
      homeDir: home,
      fetch: () => Promise.reject(new Error('ENOTFOUND')),
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('models.dev unreachable');
    expect(catalogModel('gpt-5.5')).toEqual(before); // unchanged — not blanked, not downgraded
    expect(catalogModel('gpt-5.5')?.outputPerMtokMicrocents).toBeGreaterThan(0);
  });

  it("a MALFORMED payload is a no-op — a third party's bad deploy cannot unprice our models", async () => {
    const result = await refreshCatalog({ homeDir: home, fetch: respond('{"openai":{"models":') });
    expect(result.status).toBe('failed');
    expect(catalogModel('gpt-5.5')?.outputPerMtokMicrocents).toBeGreaterThan(0);
  });

  it('a 5xx is a no-op, and says which one', async () => {
    const result = await refreshCatalog({
      homeDir: home,
      fetch: () => Promise.resolve(new Response('nope', { status: 503 })),
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('503');
  });

  it('the fetch→install path leaves a SHIPPED model untouched (§9 — the floor, end to end)', async () => {
    // The exhaustive floor lives in `@relavium/llm`'s `lookup.test.ts` (source-direct, so its break-verify is
    // reliable — this file imports across the package boundary, from `dist`). This is the integration leg: a real
    // `refreshCatalog` over a payload that would DOWNGRADE `gpt-5.5` must leave its human-verified price standing.
    const shipped = CATALOG_SNAPSHOT['gpt-5.5'];
    expect(shipped?.outputPerMtokMicrocents).toBeGreaterThan(0);

    await refreshCatalog({
      homeDir: home,
      fetch: respond(
        JSON.stringify({
          openai: {
            models: {
              'gpt-5.5': {
                id: 'gpt-5.5',
                name: 'GPT-5.5',
                limit: { context: 8_000, output: 1_000 },
                cost: { input: 0, output: 0.00000001 }, // ~free — the cap-defeating price
              },
            },
          },
        }),
      ),
    });

    expect(catalogModel('gpt-5.5')?.outputPerMtokMicrocents).toBe(shipped?.outputPerMtokMicrocents);
  });

  it('reports `added` as what the FLOOR admitted, not what the payload offered', async () => {
    // A models.dev payload can carry a NEW priced model and a NEW unpriced one (a preview row at `output: 0` passes
    // Zod). Only the priced one is admitted — so `added` must be 1, not 2. Counting the payload's new ids by hand,
    // host-side, drifted from what actually installed; the count now comes from `installCatalogRefresh` itself.
    const result = await refreshCatalog({
      homeDir: home,
      fetch: respond(
        payload({ 'gpt-7-priced': {}, 'gpt-7-free': { cost: { input: 0, output: 0 } } }),
      ),
    });
    expect(result.added).toBe(1);
    expect(catalogModel('gpt-7-priced')).toBeDefined();
    expect(catalogModel('gpt-7-free')).toBeUndefined();
  });

  it('ABORTS an over-cap body instead of buffering it whole (ADR-0071 §8)', async () => {
    // The cap must REFUSE an endless body, not read it all and then measure. A ReadableStream that would yield far
    // more than 16 MB is cut off the moment the running count crosses the ceiling — the reader is never drained.
    let chunksRead = 0;
    const oversized = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        chunksRead += 1;
        ctrl.enqueue(new Uint8Array(8 * 1024 * 1024)); // 8 MB a chunk — the cap is 16 MB
      },
    });
    const result = await refreshCatalog({
      homeDir: home,
      fetch: () => Promise.resolve(new Response(oversized, { status: 200 })),
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('too large');
    expect(chunksRead).toBeLessThan(5); // aborted early — NOT the thousands an unbounded read would pull
  });
});

describe('refreshCatalog — one destination, and it stays there', () => {
  it('REFUSES a redirect off models.dev — the destination IS the posture', async () => {
    const result = await refreshCatalog({
      homeDir: home,
      fetch: () =>
        Promise.resolve(
          Object.defineProperty(new Response('{}', { status: 200 }), 'url', {
            value: 'https://evil.example.com/api.json',
          }),
        ),
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('off-host');
  });

  it('a MANUAL-caught redirect (opaque, status 0) is named "off-host", not the misleading "returned 0"', async () => {
    const result = await refreshCatalog({
      homeDir: home,
      fetch: () => {
        // `redirect: 'manual'` surfaces a caught 3xx as an OPAQUE response: type 'opaqueredirect', status 0.
        const r = new Response('{}', { status: 200 });
        Object.defineProperty(r, 'status', { value: 0 });
        Object.defineProperty(r, 'type', { value: 'opaqueredirect' });
        return Promise.resolve(r);
      },
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('models.dev redirected off-host'); // NOT "models.dev returned 0"
  });

  it('sends NO credentials and NO user data — an unauthenticated GET of a public file', async () => {
    let sent: RequestInit | undefined;
    let url: unknown;
    await refreshCatalog({
      homeDir: home,
      fetch: (u: unknown, init?: RequestInit) => {
        url = u;
        sent = init;
        return Promise.resolve(new Response(payload({}), { status: 200 }));
      },
    });

    expect(url).toBe('https://models.dev/api.json'); // a compile-time constant — not user- and not model-supplied
    expect(sent?.redirect).toBe('manual');
    expect(sent?.credentials).toBeUndefined();
    const headers = sent?.headers as Record<string, string> | undefined;
    expect(Object.keys(headers ?? {})).toEqual(['accept']); // no authorization, no cookie, no telemetry
  });
});

describe('the cache — a refresh survives the process that ran it', () => {
  it('writes what it installed, and loads it back', async () => {
    await refreshCatalog({ homeDir: home, fetch: respond(payload({ 'gpt-6-imaginary': {} })) });
    // The RAW payload, not the normalized rows: caching the normalized ones would freeze today's normalizer into the
    // file, so a release that FIXED a normalization bug would go on serving the old wrong rows to everyone who had
    // ever refreshed. Re-normalizing on load means an upgrade repairs the cache for free.
    const cached: unknown = JSON.parse(readFileSync(catalogCachePath(home), 'utf8'));
    expect(cached).toHaveProperty(['openai', 'models', 'gpt-6-imaginary']);

    clearCatalogRefresh();
    expect(catalogModel('gpt-6-imaginary')).toBeUndefined(); // gone from this process…

    loadCachedCatalog(home);
    expect(catalogModel('gpt-6-imaginary')).toBeDefined(); // …and back, with no fetch
  });

  it('a MISSING or CORRUPT cache is silent — the shipped snapshot is the floor, not a fallback', () => {
    expect(loadCachedCatalog(join(home, 'nowhere'))).toBeUndefined();
    expect(catalogModel('gpt-5.5')?.outputPerMtokMicrocents).toBeGreaterThan(0);
  });
});
