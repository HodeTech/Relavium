import { createClient, createModelMetadataStore, runMigrations, type DbClient } from '@relavium/db';
import {
  admitRefreshedModels,
  catalogModel,
  CATALOG_SNAPSHOT,
  CATALOG_SCHEMA_VERSION,
  clearCatalogRefresh,
  installCatalogRefresh,
  type CatalogModel,
} from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  catalogModelToRow,
  installCatalogFromDb,
  persistCatalogToDb,
  rowToCatalogModel,
  seedShippedCatalog,
  syncCatalogFromDb,
} from './catalog-metadata.js';

const TS = new Date('2026-07-16T00:00:00Z').getTime();

/** A real shipped id — the snapshot pins it, so the gate must exclude it from the overlay. */
const SHIPPED_ID = 'gpt-5.5';

/** A well-formed long-tail model (NOT in the snapshot). */
function tail(over: Partial<CatalogModel> & Pick<CatalogModel, 'modelId'>): CatalogModel {
  return {
    provider: 'openai',
    displayName: over.modelId,
    contextWindowTokens: 100_000,
    maxOutputTokens: 10_000,
    inputPerMtokMicrocents: 1_000_000,
    outputPerMtokMicrocents: 2_000_000,
    ...over,
  };
}

describe('catalog-metadata (ADR-0072 P4 — host projection + seed + install + persist)', () => {
  let client: DbClient;
  let store: ReturnType<typeof createModelMetadataStore>;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    store = createModelMetadataStore(client.db, { now: () => TS });
  });

  afterEach(() => {
    clearCatalogRefresh(); // reset the module-global overlay so a leaked install can't poison the next test
    client.sqlite.close();
  });

  describe('projection round-trip', () => {
    it('round-trips a fully-populated model incl. contextTiers + cacheWrite, NULL cachedInput staying undefined', () => {
      const model = tail({
        modelId: 'rich-tail',
        cacheWritePerMtokMicrocents: 500_000,
        contextTiers: [
          {
            aboveContextTokens: 200_000,
            inputPerMtokMicrocents: 2_000_000,
            outputPerMtokMicrocents: 4_000_000,
            cachedInputPerMtokMicrocents: 250_000,
          },
        ],
        reasoning: { effortValues: ['low', 'high'] },
        requestCapabilities: { temperature: false },
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        knowledgeCutoff: '2024-10',
        description: 'desc',
        // no cachedInput rate → must project back as ABSENT, not 0
      });
      store.upsert([catalogModelToRow(model, 'refreshed', TS)]);
      const back = rowToCatalogModel(store.readAll()[0]!);
      expect(back).toEqual(model); // exhaustive: covers contextTiers + cacheWrite round-trip
      expect(back).not.toHaveProperty('cachedInputPerMtokMicrocents'); // absent, not 0
    });

    it('a corrupt or wrong-shaped money JSON column drops the FIELD, keeping the priced model at its flat rate', () => {
      const base = catalogModelToRow(tail({ modelId: 'corrupt-tiers' }), 'refreshed', TS);
      // Malformed JSON.
      store.upsert([{ ...base, contextTiers: '{not valid json' }]);
      let back = rowToCatalogModel(store.readAll().find((r) => r.modelId === 'corrupt-tiers')!);
      expect(back).toBeDefined();
      expect(back).not.toHaveProperty('contextTiers'); // dropped, not trusted
      expect(back?.inputPerMtokMicrocents).toBe(1_000_000); // still priced (flat rate engages the cap)
      // Valid JSON, wrong SHAPE — Zod rejects it, field dropped, model still priced.
      store.upsert([{ ...base, contextTiers: JSON.stringify({ not: 'an array' }) }]);
      back = rowToCatalogModel(store.readAll().find((r) => r.modelId === 'corrupt-tiers')!);
      expect(back).not.toHaveProperty('contextTiers');
      expect(back?.outputPerMtokMicrocents).toBe(2_000_000);
    });

    it('preserves a present cache rate of 0 as 0 (a real "no discount"), distinct from absent', () => {
      const model = tail({ modelId: 'zero-cache', cachedInputPerMtokMicrocents: 0 });
      store.upsert([catalogModelToRow(model, 'refreshed', TS)]);
      expect(rowToCatalogModel(store.readAll()[0]!)?.cachedInputPerMtokMicrocents).toBe(0);
    });

    it('returns undefined for a provider outside the closed seam enum (an unusable long-tail row)', () => {
      store.upsert([catalogModelToRow(tail({ modelId: 'x' }), 'refreshed', TS)]);
      const realRow = store.readAll()[0]!;
      expect(rowToCatalogModel({ ...realRow, provider: 'some-unmapped-provider' })).toBeUndefined();
    });
  });

  describe('seedShippedCatalog — SHA-gated', () => {
    it('seeds every shipped model on first run, then is a no-op while the SHA + version match', () => {
      expect(seedShippedCatalog(store, TS)).toBe(true);
      expect(store.readAll()).toHaveLength(Object.keys(CATALOG_SNAPSHOT).length);
      expect(store.readAll().every((r) => r.origin === 'shipped')).toBe(true);
      expect(seedShippedCatalog(store, TS)).toBe(false); // SHA matches → no-op
    });

    it('stamps the meta cursor with the snapshot SHA and the schema version', () => {
      seedShippedCatalog(store, TS);
      const meta = store.readMeta();
      expect(meta?.seededSnapshotSha).toBeTruthy();
      expect(meta?.catalogSchemaVersion).toBe(CATALOG_SCHEMA_VERSION);
    });

    it('a reseed CARRIES FORWARD enrichment a refresh had populated — never blanks it (ADR-0072 point 5)', () => {
      seedShippedCatalog(store, TS);
      const shippedId = Object.keys(CATALOG_SNAPSHOT)[0]!;
      // A `models refresh --catalog` populated enrichment on a shipped id (the snapshot itself carries none).
      store.updateEnrichment([
        {
          modelId: shippedId,
          inputModalities: JSON.stringify(['text', 'image']),
          outputModalities: null,
          knowledgeCutoff: '2099-01',
          description: 'fetched',
        },
      ]);
      // Simulate a binary upgrade (a changed snapshot SHA) so the next call reseeds.
      store.upsertMeta({ seededSnapshotSha: 'a-different-sha' });
      expect(seedShippedCatalog(store, TS + 1)).toBe(true); // it reseeds
      const row = store.readAll().find((r) => r.modelId === shippedId)!;
      // Money+wire came from the (re-reviewed) snapshot; enrichment SURVIVED the reseed rather than resetting to NULL.
      expect(row.knowledgeCutoff).toBe('2099-01');
      expect(row.inputModalities).toBe(JSON.stringify(['text', 'image']));
      expect(row.description).toBe('fetched');
    });
  });

  describe('installCatalogFromDb — the overlay is the long tail only; the snapshot answers shipped', () => {
    it('excludes shipped ids (snapshot answers) and installs a priced long-tail row', () => {
      seedShippedCatalog(store, TS);
      store.upsert([catalogModelToRow(tail({ modelId: 'longtail-1' }), 'refreshed', TS)]);
      const installed = installCatalogFromDb(store);
      expect(installed).toBe(1); // only the long tail — every shipped id is excluded by the gate
      expect(catalogModel('longtail-1')?.provider).toBe('openai');
      // A shipped id still resolves to the SNAPSHOT, not a DB row.
      expect(catalogModel(SHIPPED_ID)).toEqual(CATALOG_SNAPSHOT[SHIPPED_ID]);
    });

    it('treats a stale-schema-version row as ABSENT (falls to the snapshot)', () => {
      const staleRow = catalogModelToRow(tail({ modelId: 'stale-tail' }), 'refreshed', TS);
      store.upsert([{ ...staleRow, catalogSchemaVersion: CATALOG_SCHEMA_VERSION - 1 }]);
      expect(installCatalogFromDb(store)).toBe(0);
      expect(catalogModel('stale-tail')).toBeUndefined();
    });

    it('does NOT wipe a pre-installed (file-cache) overlay when the DB adds no long tail (ADR-0072 point 7)', () => {
      // The boot file-cache overlay: a long-tail model installed BEFORE the DB sync.
      installCatalogRefresh({ 'file-cache-tail': tail({ modelId: 'file-cache-tail' }) });
      expect(catalogModel('file-cache-tail')).toBeDefined();
      // The DB holds ONLY shipped rows (the normal post-seed state) — its admitted long tail is empty. Installing
      // that empty set unconditionally would WIPE the file-cache overlay and silently unprice its long tail.
      seedShippedCatalog(store, TS);
      expect(installCatalogFromDb(store)).toBe(0);
      // The file-cache overlay MUST survive — the single-authoritative-backing guard leaves it intact.
      expect(catalogModel('file-cache-tail')).toBeDefined();
    });

    it('DOES supersede the overlay once the DB has an admitted long-tail row', () => {
      installCatalogRefresh({ 'old-tail': tail({ modelId: 'old-tail' }) });
      seedShippedCatalog(store, TS);
      store.upsert([catalogModelToRow(tail({ modelId: 'db-tail' }), 'refreshed', TS)]);
      expect(installCatalogFromDb(store)).toBe(1);
      // Wholesale replace: the DB is now authoritative, so the stale file-cache-only model is gone.
      expect(catalogModel('db-tail')).toBeDefined();
      expect(catalogModel('old-tail')).toBeUndefined();
    });
  });

  describe('syncCatalogFromDb — best-effort', () => {
    it('seeds + installs over a live db', () => {
      store.upsert([catalogModelToRow(tail({ modelId: 'sync-tail' }), 'refreshed', TS)]);
      expect(syncCatalogFromDb(client.db, () => TS)).toBe(1);
      expect(catalogModel('sync-tail')).toBeDefined();
    });

    it('a closed/faulting db degrades to 0 (the snapshot floor answers), never throws', () => {
      client.sqlite.close(); // any DB op now throws
      expect(() => syncCatalogFromDb(client.db, () => TS)).not.toThrow();
      expect(syncCatalogFromDb(client.db, () => TS)).toBe(0);
      // Reassign to a FRESH handle so afterEach's close() hits that, not the already-closed original (which would
      // throw a double-close).
      client = createClient(':memory:');
    });
  });

  describe('persistCatalogToDb — money gate at the DB write boundary', () => {
    it('upserts only the ADMITTED long tail as refreshed, and enriches (never re-prices) a shipped id', () => {
      seedShippedCatalog(store, TS);
      const shippedBefore = store.readAll().find((r) => r.modelId === SHIPPED_ID)!;
      const catalog: Record<string, CatalogModel> = {
        [SHIPPED_ID]: tail({
          modelId: SHIPPED_ID,
          inputPerMtokMicrocents: 1, // a hostile lowered price…
          knowledgeCutoff: '2099-01', // …riding a plausible enrichment
        }),
        'priced-tail': tail({ modelId: 'priced-tail' }),
        'free-tail': tail({ modelId: 'free-tail', inputPerMtokMicrocents: 0 }), // unpriced → rejected
      };
      persistCatalogToDb(store, catalog, TS + 1);
      const rows = store.readAll();
      // The long tail: only the priced one landed, as origin='refreshed'.
      const refreshed = rows.filter((r) => r.origin === 'refreshed').map((r) => r.modelId);
      expect(refreshed).toEqual(['priced-tail']);
      // The shipped id: money is BYTE-IDENTICAL to the seed (the hostile price never landed)…
      const shippedAfter = rows.find((r) => r.modelId === SHIPPED_ID)!;
      expect(shippedAfter.inputCostPerMtokMicrocents).toBe(shippedBefore.inputCostPerMtokMicrocents);
      expect(shippedAfter.origin).toBe('shipped');
      // …but the enrichment DID land.
      expect(shippedAfter.knowledgeCutoff).toBe('2099-01');
      // The catalog-axis TTL cursor advanced.
      expect(store.readMeta()?.catalogCheckedAt).toBe(TS + 1);
    });

    it('PARITY: what persist stores as refreshed == what installCatalogRefresh admits from the same catalog', () => {
      // The cross-implementation parity ADR-0072 point 3 / Negative demands: the DB write path and the overlay
      // install path admit the IDENTICAL set. Both route through admitRefreshedModels, and this proves the DB
      // round-trip (persist → read → install) reflects exactly that set.
      seedShippedCatalog(store, TS);
      const catalog: Record<string, CatalogModel> = {
        [SHIPPED_ID]: tail({ modelId: SHIPPED_ID }),
        a: tail({ modelId: 'a' }),
        b: tail({ modelId: 'b' }),
        c: tail({ modelId: 'c', outputPerMtokMicrocents: 0 }), // rejected
      };
      persistCatalogToDb(store, catalog, TS);
      const persistedRefreshed = store
        .readAll()
        .filter((r) => r.origin === 'refreshed')
        .map((r) => r.modelId)
        .sort();
      const gateAdmitted = Object.keys(admitRefreshedModels(catalog)).sort();
      const overlayInstalled = (() => {
        clearCatalogRefresh();
        installCatalogFromDb(store);
        return ['a', 'b', 'c', SHIPPED_ID].filter((id) => catalogModel(id) !== CATALOG_SNAPSHOT[id] && CATALOG_SNAPSHOT[id] === undefined).sort();
      })();
      expect(persistedRefreshed).toEqual(gateAdmitted);
      expect(overlayInstalled).toEqual(gateAdmitted);
    });
  });
});
