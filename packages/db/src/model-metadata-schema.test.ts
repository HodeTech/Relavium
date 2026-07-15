import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import {
  catalogMeta,
  llmProviders,
  modelCatalog,
  modelMetadata,
  type NewModelMetadataRow,
} from './schema.js';

const TS_MS = new Date('2026-07-16T12:00:00.000Z').getTime();

/**
 * P1 acceptance (ADR-0072) — the money-safety CHECK constraints on `model_metadata` / `catalog_meta` behave AT THE
 * DB LEVEL, before any store code exists. These lock the migration: the `origin` value set, the singleton cursor,
 * and — the load-bearing one — that a REFRESHED long-tail row must be priced on both sides while a SHIPPED row is
 * whatever the reviewed snapshot says (a free shipped model is legitimate and pinned).
 */
describe('model_metadata / catalog_meta schema constraints (ADR-0072 P1)', () => {
  let client: DbClient;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
  });

  const row = (over: Partial<NewModelMetadataRow>): NewModelMetadataRow => ({
    modelId: 'some-model',
    provider: 'openai',
    displayName: 'Some Model',
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

  it('admits a priced refreshed long-tail row', () => {
    client.db
      .insert(modelMetadata)
      .values(row({ modelId: 'gpt-6-mini', origin: 'refreshed' }))
      .run();
    const got = client.db
      .select()
      .from(modelMetadata)
      .where(eq(modelMetadata.modelId, 'gpt-6-mini'))
      .all();
    expect(got).toHaveLength(1);
    expect(got[0]?.origin).toBe('refreshed');
  });

  it('REJECTS a refreshed row with a zero OR negative base price (the gpt-5.5 $0.00 regression class, at rest)', () => {
    expect(() =>
      client.db
        .insert(modelMetadata)
        .values(row({ modelId: 'free-longtail', inputCostPerMtokMicrocents: 0 }))
        .run(),
    ).toThrow(/CHECK|constraint/i);
    expect(() =>
      client.db
        .insert(modelMetadata)
        .values(row({ modelId: 'free-longtail-2', outputCostPerMtokMicrocents: 0 }))
        .run(),
    ).toThrow(/CHECK|constraint/i);
    // A NEGATIVE rate bounds the CHECK's direction, not just its zero edge — it must fail exactly the same way.
    expect(() =>
      client.db
        .insert(modelMetadata)
        .values(row({ modelId: 'neg-longtail', inputCostPerMtokMicrocents: -1 }))
        .run(),
    ).toThrow(/CHECK|constraint/i);
  });

  it('ADMITS a shipped row with a zero base price (a free shipped model is legitimate and pinned)', () => {
    client.db
      .insert(modelMetadata)
      .values(
        row({
          modelId: 'free-shipped',
          origin: 'shipped',
          inputCostPerMtokMicrocents: 0,
          outputCostPerMtokMicrocents: 0,
        }),
      )
      .run();
    const got = client.db
      .select()
      .from(modelMetadata)
      .where(eq(modelMetadata.modelId, 'free-shipped'))
      .all();
    expect(got[0]?.inputCostPerMtokMicrocents).toBe(0);
  });

  it('REJECTS an unknown origin value', () => {
    // Raw SQL so an invalid `origin` reaches the DB unfiltered by the type system — the CHECK is the last line.
    // drizzle's `.run(sql)` wraps the driver error, so the SQLite "CHECK constraint failed" rides on `.cause`.
    let caught: unknown;
    try {
      client.db.run(
        sql`INSERT INTO model_metadata
              (model_id, provider, display_name, context_window_tokens, max_output_tokens,
               input_cost_per_mtok_microcents, output_cost_per_mtok_microcents, origin,
               catalog_schema_version, created_at, updated_at)
            VALUES ('bad-origin', 'openai', 'Bad', 1000, 100, 1, 1, 'bogus', 1, ${TS_MS}, ${TS_MS})`,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const causeMsg =
      caught instanceof Error && caught.cause instanceof Error ? caught.cause.message : '';
    const detail = caught instanceof Error ? `${caught.message} ${causeMsg}` : '';
    expect(detail).toMatch(/CHECK|constraint/i);
  });

  it('round-trips NULL cache columns as null, never 0 (ADR-0071 §10)', () => {
    client.db
      .insert(modelMetadata)
      .values(
        row({
          modelId: 'no-cache-rate',
          cachedInputCostPerMtokMicrocents: null,
          cacheWriteCostPerMtokMicrocents: null,
        }),
      )
      .run();
    const got = client.db
      .select()
      .from(modelMetadata)
      .where(eq(modelMetadata.modelId, 'no-cache-rate'))
      .all();
    expect(got[0]?.cachedInputCostPerMtokMicrocents).toBeNull();
    expect(got[0]?.cacheWriteCostPerMtokMicrocents).toBeNull();
  });

  it('defaults model_catalog.visible to true on an existing/omitting-insert row (the ALTER ADD DEFAULT 1)', () => {
    // A row inserted WITHOUT `visible` must read back visible — the migration's constant default, the property the
    // read-modify-write preservation (ADR-0072 point 4, wired in a later phase) relies on to never un-hide silently.
    client.db
      .insert(llmProviders)
      .values({
        id: 'p1',
        name: 'openai',
        displayName: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        createdAt: TS_MS,
        updatedAt: TS_MS,
      })
      .run();
    client.db
      .insert(modelCatalog)
      .values({
        id: 'm1',
        providerId: 'p1',
        modelId: 'gpt-4o',
        displayName: 'GPT-4o',
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000,
        createdAt: TS_MS,
        updatedAt: TS_MS,
      })
      .run();
    const got = client.db.select().from(modelCatalog).where(eq(modelCatalog.id, 'm1')).all();
    expect(got[0]?.visible).toBe(true);
  });

  it('enforces the catalog_meta singleton — BOTH halves: CHECK (id != 1) and PK (duplicate id = 1)', () => {
    client.db.insert(catalogMeta).values({ id: 1, updatedAt: TS_MS }).run();
    expect(client.db.select().from(catalogMeta).all()).toHaveLength(1);
    // The CHECK half: no row may have id != 1.
    expect(() => client.db.insert(catalogMeta).values({ id: 2, updatedAt: TS_MS }).run()).toThrow(
      /CHECK|constraint/i,
    );
    // The PRIMARY KEY half: a SECOND id = 1 is a PK collision — together with the CHECK this pins "exactly one row".
    expect(() => client.db.insert(catalogMeta).values({ id: 1, updatedAt: TS_MS }).run()).toThrow(
      /constraint|UNIQUE|PRIMARY/i,
    );
    expect(client.db.select().from(catalogMeta).all()).toHaveLength(1);
  });
});
