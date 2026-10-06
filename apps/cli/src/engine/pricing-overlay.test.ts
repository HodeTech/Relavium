import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createModelCatalogStore,
  createModelMetadataStore,
  createProviderStore,
  runMigrations,
  type Db,
  type DbClient,
} from '@relavium/db';
import { clearCatalogRefresh, priceModel } from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openLocalDb } from '../db/open.js';
import { catalogModelToRow } from './catalog-metadata.js';
import {
  buildUserPricingOverlay,
  loadUserPricingOverlay,
  readBudgetPricingOverlay,
  readUserPricingOverlay,
} from './pricing-overlay.js';

/**
 * `pricing-overlay` host-loader tests (2.5.G S10, ADR-0065 §2). `buildUserPricingOverlay` is driven over a real
 * `:memory:` db + stores (the projection of `source='user'` rows is the point); `loadUserPricingOverlay` gets a
 * real temp-home round-trip (open → seed → reopen → read) plus its NON-FATAL "missing db ⇒ undefined" contract.
 */

const NOW = 1_700_000_000_000;
let uuidSeq = 0;
const deps = {
  uuid: () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`,
  now: () => NOW,
};

/** Seed one registered provider + a `source='user'` priced model on `db`. */
function seedUserPriced(db: Db): void {
  const providerStore = createProviderStore(db, deps);
  const providerId = providerStore.upsert({
    name: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
  }).id;
  createModelCatalogStore(db, deps).upsert({
    providerId,
    modelId: 'acme-custom-1',
    displayName: 'Acme Custom 1',
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_000,
    source: 'user',
    inputCostPerMtokMicrocents: 300_000_000,
    outputCostPerMtokMicrocents: 900_000_000,
  });
}

describe('buildUserPricingOverlay (over an open db)', () => {
  let client: DbClient;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
  });
  afterEach(() => {
    clearCatalogRefresh();
    client.sqlite.close();
  });

  it('projects the source="user" rows into a ModelPricing overlay keyed by model id', () => {
    seedUserPriced(client.db);
    const overlay = buildUserPricingOverlay(client.db);
    const priced = overlay.get('acme-custom-1');
    expect(priced?.provider).toBe('openai');
    expect(priced?.inputPerMtokMicrocents).toBe(300_000_000);
    expect(priced?.outputPerMtokMicrocents).toBe(900_000_000);
  });

  it('is an empty map when there are no user rows (harmless — fills nothing)', () => {
    const overlay = buildUserPricingOverlay(client.db);
    expect(overlay.size).toBe(0);
  });

  it('readUserPricingOverlay returns the same overlay on a healthy db (the non-fatal wrapper)', () => {
    seedUserPriced(client.db);
    expect(readUserPricingOverlay(client.db).get('acme-custom-1')?.inputPerMtokMicrocents).toBe(
      300_000_000,
    );
  });

  it('readUserPricingOverlay degrades to an EMPTY map (never throws) when the read faults', () => {
    // A separate, already-CLOSED db: better-sqlite3 throws on any query against a closed handle, so the read
    // faults. The non-fatal wrapper must swallow it and return an empty overlay (the surface's own store open is
    // the authoritative report). A throwaway client so the shared `client`/afterEach lifecycle is untouched.
    const doomed = createClient(':memory:');
    runMigrations(doomed.db);
    doomed.sqlite.close();
    expect(readUserPricingOverlay(doomed.db).size).toBe(0);
  });

  it('reads current approval prices without writing or seeding an empty catalog', () => {
    seedUserPriced(client.db);
    const before = client.sqlite.prepare('SELECT total_changes()').pluck().get();
    expect(readBudgetPricingOverlay(client.db).get('acme-custom-1')?.inputPerMtokMicrocents).toBe(
      300_000_000,
    );
    expect(client.sqlite.prepare('SELECT total_changes()').pluck().get()).toBe(before);
    expect(createModelMetadataStore(client.db, deps).readAll()).toEqual([]);
  });

  it('installs existing refreshed approval prices in memory without changing durable rows', () => {
    const store = createModelMetadataStore(client.db, deps);
    store.upsert([
      catalogModelToRow(
        {
          modelId: 'approval-current-tail',
          provider: 'openai',
          displayName: 'Current approval tail',
          contextWindowTokens: 32_000,
          maxOutputTokens: 4_000,
          inputPerMtokMicrocents: 7_000_000,
          outputPerMtokMicrocents: 13_000_000,
        },
        'refreshed',
        NOW,
      ),
    ]);
    const before = client.sqlite.prepare('SELECT total_changes()').pluck().get();
    const rows = store.readAll();
    expect(readBudgetPricingOverlay(client.db).size).toBe(0);
    expect(priceModel('approval-current-tail').inputPerMtokMicrocents).toBe(7_000_000);
    expect(client.sqlite.prepare('SELECT total_changes()').pluck().get()).toBe(before);
    expect(store.readAll()).toEqual(rows);
  });
});

describe('loadUserPricingOverlay (self-contained transient open)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'relavium-pricing-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('opens the real history.db, reads the user pricing, and closes (round-trip)', () => {
    // Seed via one connection, then load via a FRESH transient open — proving the durable read path.
    const opened = openLocalDb(home);
    try {
      seedUserPriced(opened.db);
    } finally {
      opened.close();
    }
    const overlay = loadUserPricingOverlay(home);
    expect(overlay?.get('acme-custom-1')?.inputPerMtokMicrocents).toBe(300_000_000);
  });

  it('returns undefined NON-FATALLY when the db path is unopenable (the surface reports the fault itself)', () => {
    // Put a regular FILE where the home dir's `.relavium/` would go: `ensureGlobalConfigDir` can't `mkdir` a
    // directory under a file (ENOTDIR), so `openLocalDb` throws — and the loader degrades to `undefined` rather
    // than propagating (the surface's own session/run store open is the authoritative fault report, a clean exit 2).
    const blocker = join(home, 'blocker');
    writeFileSync(blocker, 'not a directory');
    expect(loadUserPricingOverlay(blocker)).toBeUndefined();
  });
});
