import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createClient, createModelMetadataStore, runMigrations, type DbClient } from '@relavium/db';
import {
  catalogModel,
  CATALOG_SCHEMA_VERSION,
  clearCatalogRefresh,
  cost,
  priceModel,
  type CatalogModel,
} from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFileCatalogSeed } from '../process/file-catalog-seed.js';
import { catalogModelToRow } from './catalog-metadata.js';
import { catalogCachePath, loadCachedCatalog } from './catalog-refresh.js';
import {
  loadUserPricingOverlay,
  readBudgetPricingOverlay,
  readUserPricingOverlay,
} from './pricing-overlay.js';

const MODEL = 'step7-cutover-long-tail';
const FILE_PRICE = 100_000_000;
const DB_PRICE = 700_000_000;
const TS = 1_800_000_000_000;

function dbModel(price = DB_PRICE): CatalogModel {
  return {
    modelId: MODEL,
    provider: 'openai',
    displayName: 'DB long tail',
    contextWindowTokens: 123_456,
    maxOutputTokens: 4_321,
    inputPerMtokMicrocents: price,
    outputPerMtokMicrocents: price * 2,
    requestCapabilities: { toolCall: false },
  };
}

function cachedPayload(price = 1): string {
  return JSON.stringify({
    openai: {
      models: {
        [MODEL]: {
          id: MODEL,
          name: 'File long tail',
          limit: { context: 100_000, output: 10_000 },
          cost: { input: price, output: price * 2 },
          tool_call: true,
        },
      },
    },
  });
}

// Actual cache parsing, SQLite rows and production overlay helpers; these do not simulate
// full Home/clear/reseat/resume journeys or claim coverage of every production caller.
describe('file-to-DB catalog cutover (ADR-0071/0072/0111)', () => {
  let home: string;
  let client: DbClient;

  beforeEach(() => {
    clearCatalogRefresh();
    expect(catalogModel(MODEL)).toBeUndefined();
    home = mkdtempSync(join(tmpdir(), 'relavium-file-catalog-'));
    client = createClient(':memory:');
    const path = catalogCachePath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, cachedPayload());
  });

  afterEach(() => {
    if (client.sqlite.open) client.sqlite.close();
    clearCatalogRefresh();
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function seedOwner() {
    const load = vi.fn(() => {
      loadCachedCatalog(home);
    });
    return { load, seed: createFileCatalogSeed(load) };
  }

  function persist(price = DB_PRICE): void {
    const store = createModelMetadataStore(client.db, { now: () => TS });
    store.upsert([catalogModelToRow(dbModel(price), 'refreshed', TS)]);
  }

  it.each(['unmigrated', 'empty', 'torn', 'stale'] as const)(
    '%s DB retains file pricing at the first actual cost lookup',
    async (state) => {
      if (state !== 'unmigrated') runMigrations(client.db);
      if (state === 'torn') client.sqlite.exec('DROP TABLE model_metadata');
      if (state === 'stale') {
        const store = createModelMetadataStore(client.db, { now: () => TS });
        store.upsert([
          {
            ...catalogModelToRow(dbModel(), 'refreshed', TS),
            catalogSchemaVersion: CATALOG_SCHEMA_VERSION - 1,
          },
        ]);
      }
      const { seed, load } = seedOwner();
      await seed();
      const overlay = readUserPricingOverlay(client.db);
      expect(priceModel(MODEL, overlay).inputPerMtokMicrocents).toBe(FILE_PRICE);
      expect(
        cost(MODEL, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, overlay).microcents,
      ).toBe(FILE_PRICE * 3);
      expect(load).toHaveBeenCalledTimes(1);
    },
  );

  it('a current DB row wins before the first capability and cost consumers', async () => {
    runMigrations(client.db);
    persist();
    const { seed } = seedOwner();
    await seed();
    expect(priceModel(MODEL).inputPerMtokMicrocents).toBe(FILE_PRICE);
    const overlay = readUserPricingOverlay(client.db);
    expect(catalogModel(MODEL)?.requestCapabilities?.toolCall).toBe(false);
    expect(priceModel(MODEL, overlay).maxOutputTokens).toBe(4_321);
    expect(
      cost(MODEL, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, overlay).microcents,
    ).toBe(DB_PRICE * 3);
  });

  it('repeated owner-level rebuild reads see the newest DB rows without a late file reinstall', async () => {
    runMigrations(client.db);
    const { seed, load } = seedOwner();
    await seed();
    // The production clear/reseat/resume sites call this same fresh-read helper. This
    // loop tests that helper with one seed owner, not those UI/session lifecycles.
    for (const price of [DB_PRICE, DB_PRICE + 100_000_000, DB_PRICE + 200_000_000]) {
      persist(price);
      writeFileSync(catalogCachePath(home), cachedPayload(99));
      await seed();
      const overlay = readUserPricingOverlay(client.db);
      await seed();
      expect(priceModel(MODEL, overlay).inputPerMtokMicrocents).toBe(price);
      expect(cost(MODEL, { inputTokens: 1_000_000, outputTokens: 0 }, overlay).microcents).toBe(
        price,
      );
    }
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a transient loader cuts over from the file to the persisted SQLite price', async () => {
    client.sqlite.close();
    mkdirSync(join(home, '.relavium'));
    client = createClient(join(home, '.relavium', 'history.db'));
    runMigrations(client.db);
    persist();
    const { seed } = seedOwner();
    await seed();
    const errors: string[] = [];
    const overlay = loadUserPricingOverlay(home, {
      writeErr: (text) => {
        errors.push(text);
      },
    });
    expect(overlay).toBeDefined();
    expect(errors).toEqual([]);
    expect(cost(MODEL, { inputTokens: 1_000_000, outputTokens: 0 }, overlay).microcents).toBe(
      DB_PRICE,
    );
  });

  it('quote-only reading installs the DB price without seeding or changing a single database byte', async () => {
    runMigrations(client.db);
    persist();
    const store = createModelMetadataStore(client.db, { now: () => TS });
    expect(store.readMeta()).toBeUndefined();
    expect(store.readAll()).toHaveLength(1);
    const before = client.sqlite.serialize();
    const { seed } = seedOwner();
    await seed();
    const overlay = readBudgetPricingOverlay(client.db);
    expect(cost(MODEL, { inputTokens: 1_000_000, outputTokens: 0 }, overlay).microcents).toBe(
      DB_PRICE,
    );
    expect(client.sqlite.serialize()).toEqual(before);
    expect(store.readMeta()).toBeUndefined();
    expect(store.readAll()).toHaveLength(1);
  });

  it.each(['missing', 'malformed'] as const)(
    'a %s cache is attempted once even if a valid file appears later',
    async (state) => {
      if (state === 'missing') rmSync(catalogCachePath(home));
      else writeFileSync(catalogCachePath(home), '{"openai":');
      const { seed, load } = seedOwner();
      await seed();
      expect(catalogModel(MODEL)).toBeUndefined();
      writeFileSync(catalogCachePath(home), cachedPayload());
      await seed();
      expect(load).toHaveBeenCalledTimes(1);
      expect(catalogModel(MODEL)).toBeUndefined();
      // A distinct invocation can consume the newly available cache.
      await seedOwner().seed();
      expect(priceModel(MODEL).inputPerMtokMicrocents).toBe(FILE_PRICE);
    },
  );

  it('reading a valid cache changes neither its bytes nor the directory contents', async () => {
    const path = catalogCachePath(home);
    const before = readFileSync(path);
    const files = readdirSync(dirname(path));
    const { seed } = seedOwner();
    await seed();
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(dirname(path))).toEqual(files);
    expect(priceModel(MODEL).inputPerMtokMicrocents).toBe(FILE_PRICE);
  });
});
