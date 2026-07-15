import { beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import {
  coerceCatalogMetadataOrigin,
  createModelMetadataStore,
  type ModelMetadataStore,
} from './metadata-store.js';
import { type NewModelMetadataRow } from './schema.js';

const TS_MS = new Date('2026-07-16T12:00:00.000Z').getTime();

describe('createModelMetadataStore (ADR-0072 — the DB catalog mirror)', () => {
  let client: DbClient;
  let store: ModelMetadataStore;
  let clock: number;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    clock = TS_MS;
    store = createModelMetadataStore(client.db, { now: () => clock });
  });

  const row = (over: Partial<NewModelMetadataRow>): NewModelMetadataRow => ({
    modelId: 'gpt-x',
    provider: 'openai',
    displayName: 'GPT-X',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_000,
    inputCostPerMtokMicrocents: 250_000_000,
    outputCostPerMtokMicrocents: 1_000_000_000,
    origin: 'refreshed',
    catalogSchemaVersion: 1,
    createdAt: TS_MS,
    updatedAt: TS_MS,
    ...over,
  });

  it('upserts full rows and reads them all back', () => {
    store.upsert([
      row({ modelId: 'a', origin: 'shipped', inputCostPerMtokMicrocents: 100 }),
      row({ modelId: 'b', origin: 'refreshed' }),
    ]);
    const all = store.readAll();
    expect(all.map((r) => r.modelId).sort()).toEqual(['a', 'b']);
    expect(all.find((r) => r.modelId === 'a')?.origin).toBe('shipped');
  });

  it('upsert OVERWRITES money+wire+enrichment on conflict (a re-seed after a binary upgrade), preserving created_at', () => {
    store.upsert([
      row({
        modelId: 'a',
        outputCostPerMtokMicrocents: 500,
        reasoning: JSON.stringify({ effortValues: ['low'] }),
        requestCapabilities: JSON.stringify({ temperature: false }),
        createdAt: TS_MS,
      }),
    ]);
    clock = TS_MS + 10_000;
    store.upsert([
      row({
        modelId: 'a',
        outputCostPerMtokMicrocents: 999,
        reasoning: JSON.stringify({ effortValues: ['low', 'high'] }),
        requestCapabilities: null,
        createdAt: TS_MS + 99,
      }),
    ]);
    const got = store.readAll().find((r) => r.modelId === 'a');
    expect(got?.outputCostPerMtokMicrocents).toBe(999); // money overwritten
    // WIRE overwritten too — if fullUpsertSet ever dropped `reasoning`, a shipped model's reasoning would go stale
    // after a binary upgrade while this money assertion still passed.
    expect(got?.reasoning).toBe(JSON.stringify({ effortValues: ['low', 'high'] }));
    expect(got?.requestCapabilities).toBeNull();
    expect(got?.createdAt).toBe(TS_MS); // created_at preserved (the ON CONFLICT set omits it)
    expect(got?.updatedAt).toBe(TS_MS + 10_000);
  });

  it('updateEnrichment touches ONLY the enrichment columns — money and wire are NEVER moved (ADR-0072 point 5)', () => {
    store.upsert([
      row({
        modelId: 'shipped-1',
        origin: 'shipped',
        inputCostPerMtokMicrocents: 250_000_000,
        outputCostPerMtokMicrocents: 1_000_000_000,
        cachedInputCostPerMtokMicrocents: 50_000_000,
        reasoning: JSON.stringify({ effortValues: ['low', 'high'] }),
        requestCapabilities: JSON.stringify({ temperature: false }),
      }),
    ]);
    clock = TS_MS + 5_000;
    store.updateEnrichment([
      {
        modelId: 'shipped-1',
        inputModalities: JSON.stringify(['text', 'image']),
        outputModalities: JSON.stringify(['text']),
        knowledgeCutoff: '2024-10',
        description: 'enriched',
      },
    ]);
    const got = store.readAll().find((r) => r.modelId === 'shipped-1');
    // Enrichment landed…
    expect(got?.inputModalities).toBe(JSON.stringify(['text', 'image']));
    expect(got?.knowledgeCutoff).toBe('2024-10');
    expect(got?.description).toBe('enriched');
    // …and money + wire are byte-identical to the seed (a bot refresh never moves a pinned shipped price/reasoning).
    expect(got?.inputCostPerMtokMicrocents).toBe(250_000_000);
    expect(got?.outputCostPerMtokMicrocents).toBe(1_000_000_000);
    expect(got?.cachedInputCostPerMtokMicrocents).toBe(50_000_000);
    expect(got?.reasoning).toBe(JSON.stringify({ effortValues: ['low', 'high'] }));
    expect(got?.requestCapabilities).toBe(JSON.stringify({ temperature: false }));
  });

  it('preserves a NULL cache rate as null on BOTH the insert and the conflict/update path (never 0, ADR-0071 §10)', () => {
    // INSERT path.
    store.upsert([row({ modelId: 'no-cache', cachedInputCostPerMtokMicrocents: null, cacheWriteCostPerMtokMicrocents: null })]);
    let got = store.readAll().find((r) => r.modelId === 'no-cache');
    expect(got?.cachedInputCostPerMtokMicrocents).toBeNull();
    expect(got?.cacheWriteCostPerMtokMicrocents).toBeNull();
    // CONFLICT/UPDATE path — a re-seed of the same id with null caches must ALSO round-trip as null (the `?? null`
    // in fullUpsertSet), not silently coerce to 0.
    store.upsert([row({ modelId: 'no-cache', cachedInputCostPerMtokMicrocents: null, cacheWriteCostPerMtokMicrocents: null })]);
    got = store.readAll().find((r) => r.modelId === 'no-cache');
    expect(got?.cachedInputCostPerMtokMicrocents).toBeNull();
    expect(got?.cacheWriteCostPerMtokMicrocents).toBeNull();
  });

  it('empty inputs are no-ops', () => {
    store.upsert([]);
    store.updateEnrichment([]);
    expect(store.readAll()).toHaveLength(0);
    // An empty patch is a safe no-op that still stamps the singleton (only updated_at moves).
    store.upsertMeta({});
    expect(store.readMeta()?.id).toBe(1);
  });

  it('updateEnrichment on a NON-EXISTENT id is a silent no-op (0 rows matched, no throw)', () => {
    store.upsert([row({ modelId: 'real' })]);
    expect(() =>
      store.updateEnrichment([
        { modelId: 'ghost', inputModalities: null, outputModalities: null, knowledgeCutoff: 'x', description: null },
      ]),
    ).not.toThrow();
    expect(store.readAll().map((r) => r.modelId)).toEqual(['real']); // the ghost created nothing
  });

  describe('catalog_meta cursor', () => {
    it('is undefined before the first write, then upserts the singleton', () => {
      expect(store.readMeta()).toBeUndefined();
      store.upsertMeta({ seededSnapshotSha: 'sha-abc', catalogSchemaVersion: 1 });
      const meta = store.readMeta();
      expect(meta?.id).toBe(1);
      expect(meta?.seededSnapshotSha).toBe('sha-abc');
      expect(meta?.catalogSchemaVersion).toBe(1);
    });

    it('a partial patch preserves the other fields (independent per-axis TTL cursors)', () => {
      store.upsertMeta({ seededSnapshotSha: 'sha-abc', availabilityCheckedAt: 111 });
      clock = TS_MS + 1;
      store.upsertMeta({ catalogCheckedAt: 222 }); // only the catalog axis moves
      const meta = store.readMeta();
      expect(meta?.availabilityCheckedAt).toBe(111); // preserved
      expect(meta?.catalogCheckedAt).toBe(222); // updated
      expect(meta?.seededSnapshotSha).toBe('sha-abc'); // preserved
      expect(store.readAll()).toHaveLength(0); // meta writes never touch model rows
    });
  });

  describe('coerceCatalogMetadataOrigin', () => {
    it('passes a valid origin through', () => {
      expect(coerceCatalogMetadataOrigin('shipped')).toBe('shipped');
      expect(coerceCatalogMetadataOrigin('refreshed')).toBe('refreshed');
    });

    it('degrades a foreign value to `refreshed`, NEVER `shipped` (which would earn the price-CHECK exemption)', () => {
      expect(coerceCatalogMetadataOrigin('bogus')).toBe('refreshed');
      expect(coerceCatalogMetadataOrigin('')).toBe('refreshed');
    });
  });
});
