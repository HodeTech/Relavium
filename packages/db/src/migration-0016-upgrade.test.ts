/**
 * The 0015 → 0016 UPGRADE path (`CR-55`, [ADR-0089](../../../docs/decisions/0089-media-correctness-four-boundaries.md) §4).
 *
 * Every other migration test runs the whole batch against a fresh file and then creates data, which
 * exercises the final schema and never the backfill. `0016_absent_falcon.sql` carries a load-bearing one —
 * `UPDATE model_catalog SET token_rates_stated = 1 WHERE source = 'user'` — whose correctness decides
 * whether every pre-existing user override keeps billing its stated token rates or silently starts
 * deferring to the catalog. That statement had no test at all.
 *
 * So this builds a real 0015 database (a migrations folder truncated at 0015, journal included), writes
 * rows in the OLD schema, then applies 0016 and reads the result.
 */

import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, type DbClient } from './client.js';

const DRIZZLE_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
}

/** A migrations folder containing entries 0000..`upTo` only, so `migrate` stops there. */
function migrationsUpTo(upTo: number, into: string): string {
  const dir = join(into, `migrations-${String(upTo)}`);
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const journalPath = join(DRIZZLE_DIR, 'meta', '_journal.json');
  const journal: { entries: JournalEntry[] } = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: JournalEntry[];
  };
  const kept = journal.entries.filter((e) => e.idx <= upTo);
  expect(kept).toHaveLength(upTo + 1); // the folder really does have every earlier migration
  for (const entry of kept) {
    copyFileSync(join(DRIZZLE_DIR, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: kept }, null, 2),
  );
  return dir;
}

describe('migration 0016 — the token_rates_stated backfill, on a real 0015 database', () => {
  let root: string;
  let client: DbClient;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-mig-0016-'));
    client = createClient(join(root, 'history.db'));
  });
  afterEach(() => {
    client.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('marks every pre-existing user row stated, and leaves live/static rows alone', () => {
    // 1) A database at 0015 — the column does not exist yet.
    migrate(client.db, { migrationsFolder: migrationsUpTo(15, root) });
    // Drizzle wraps the SQLite error; the point is only that the column does not exist yet.
    expect(() =>
      client.db.run(sql`SELECT token_rates_stated FROM model_catalog LIMIT 1`),
    ).toThrow();

    // 2) Rows in the OLD schema. The zero-priced user row is the one the backfill has to get right: it is
    //    byte-identical to a row that never stated a price, and only the fact that `models pricing`
    //    REQUIRED both flags tells us it was stated. Getting it wrong silently re-prices someone's model.
    // `model_catalog.provider_id` is an FK, so the provider row comes first.
    const seedProvider = (): void => {
      client.db.run(sql`
        INSERT INTO llm_providers (id, name, display_name, base_url, created_at, updated_at)
        VALUES ('openai', 'openai', 'OpenAI', 'https://api.openai.com/v1', 0, 0)`);
    };
    seedProvider();
    const seed = (id: string, source: string, input: number, output: number): void => {
      client.db.run(sql`
        INSERT INTO model_catalog (id, provider_id, model_id, display_name,
          context_window_tokens, max_output_tokens, source,
          input_cost_per_mtok_microcents, output_cost_per_mtok_microcents, is_active, created_at, updated_at)
        VALUES (${id}, 'openai', ${id}, ${id}, 1000, 1000, ${source}, ${input}, ${output}, 1, 0, 0)`);
    };
    seed('user-priced', 'user', 3_000_000, 9_000_000);
    seed('user-free', 'user', 0, 0); // a deliberately FREE user price
    seed('live-row', 'live', 1_000_000, 2_000_000);
    seed('static-row', 'static', 0, 0);

    // 3) Apply 0016.
    migrate(client.db, { migrationsFolder: DRIZZLE_DIR });

    const stated = new Map(
      client.db
        .all<{
          model_id: string;
          token_rates_stated: number;
        }>(sql`SELECT model_id, token_rates_stated FROM model_catalog`)
        .map((r) => [r.model_id, r.token_rates_stated]),
    );
    expect(stated.get('user-priced')).toBe(1);
    expect(stated.get('user-free')).toBe(1); // a stated ZERO stays stated — it is a price, not a default
    expect(stated.get('live-row')).toBe(0); // never stated by a user ⇒ the catalog still governs
    expect(stated.get('static-row')).toBe(0);
  });

  it('is idempotent — re-running the batch changes nothing', () => {
    migrate(client.db, { migrationsFolder: migrationsUpTo(15, root) });
    client.db.run(sql`
      INSERT INTO llm_providers (id, name, display_name, base_url, created_at, updated_at)
      VALUES ('openai', 'openai', 'OpenAI', 'https://api.openai.com/v1', 0, 0)`);
    client.db.run(sql`
      INSERT INTO model_catalog (id, provider_id, model_id, display_name,
        context_window_tokens, max_output_tokens, source,
        input_cost_per_mtok_microcents, output_cost_per_mtok_microcents, is_active, created_at, updated_at)
      VALUES ('u', 'openai', 'u', 'u', 1000, 1000, 'user', 5, 6, 1, 0, 0)`);
    migrate(client.db, { migrationsFolder: DRIZZLE_DIR });
    migrate(client.db, { migrationsFolder: DRIZZLE_DIR }); // drizzle tracks applied migrations
    const row = client.db.all<{ token_rates_stated: number }>(
      sql`SELECT token_rates_stated FROM model_catalog WHERE model_id = 'u'`,
    );
    expect(row[0]?.token_rates_stated).toBe(1);
  });
});
