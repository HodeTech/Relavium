import { CATALOG_METADATA_ORIGINS, type CatalogMetadataOrigin } from '@relavium/shared';
import { eq } from 'drizzle-orm';

import type { Db } from './client.js';
import { withBusyRetry } from './retry.js';
import {
  catalogMeta,
  modelMetadata,
  type CatalogMetaRow,
  type ModelMetadataRow,
  type NewModelMetadataRow,
} from './schema.js';

/**
 * The `model_metadata` / `catalog_meta` store (ADR-0072) — the durable backing for the runtime catalog overlay
 * that replaces the `~/.relavium` file cache.
 *
 * Like `model-catalog-store.ts`, this store is **`@relavium/db`-pure**: it depends only on `@relavium/shared`,
 * never on `@relavium/llm` (the `CatalogModel` home) or `@relavium/core`. So it reads and writes **raw
 * {@link ModelMetadataRow} records** — the projection to/from `CatalogModel` and the `admitRefreshedModels`
 * money gate are the **host's** job (apps/cli, which imports both packages), keeping the engine portable
 * (CLAUDE.md rule 5) and `db` vendor-free. The JSON columns (`context_tiers`, `reasoning`,
 * `request_capabilities`, `*_modalities`) are stored as already-serialized TEXT: the host serializes on write
 * and validates on read.
 *
 * **This store is never a pricing authority.** It holds a mirror; the generated snapshot floor stays terminal
 * for shipped ids (ADR-0072 point 2). The `origin='shipped'` vs `'refreshed'` distinction is enforced by the
 * caller's choice of write method: {@link ModelMetadataStore.upsert} writes full rows (a boot seed, or a
 * long-tail refresh that already passed the host's gate), while {@link ModelMetadataStore.updateEnrichment}
 * touches ONLY the pure-enrichment columns — the path a catalog refresh uses on a shipped row, so its
 * human-reviewed money+wire is written once (at seed) and never by a bot refresh (ADR-0072 point 5).
 */
export interface ModelMetadataStoreDeps {
  readonly now: () => number;
}

/** The pure-enrichment columns a catalog refresh may write onto a SHIPPED row — NEVER money or wire (ADR-0072 §5).
 *  JSON values arrive already serialized (or `null`), so this stays `@relavium/db`-pure. */
export interface EnrichmentUpdate {
  readonly modelId: string;
  readonly inputModalities: string | null;
  readonly outputModalities: string | null;
  readonly knowledgeCutoff: string | null;
  readonly description: string | null;
}

/** A partial write to the singleton `catalog_meta` cursor — only the named fields change; the rest are preserved. */
export interface CatalogMetaPatch {
  readonly seededSnapshotSha?: string | null;
  readonly catalogSchemaVersion?: number | null;
  readonly availabilityCheckedAt?: number | null;
  readonly catalogCheckedAt?: number | null;
  readonly catalogSourceEtag?: string | null;
}

export interface ModelMetadataStore {
  /** Every stored row, for the host to project + gate. Unfiltered — the host applies the schema-version gate. */
  readonly readAll: () => ModelMetadataRow[];
  /** Full-row upsert (a boot seed of shipped rows, or long-tail rows the host's gate already admitted). */
  readonly upsert: (rows: readonly NewModelMetadataRow[]) => void;
  /** Enrichment-columns-ONLY update (a catalog refresh enriching a shipped row) — never touches money or wire. */
  readonly updateEnrichment: (updates: readonly EnrichmentUpdate[]) => void;
  /** The singleton cursor row, or `undefined` before the first write. */
  readonly readMeta: () => CatalogMetaRow | undefined;
  /** Upsert the singleton cursor (id = 1); only the patch's fields change. */
  readonly upsertMeta: (patch: CatalogMetaPatch) => void;
}

/**
 * Coerce a stored `origin` to the closed set — belt-and-suspenders to the DB CHECK (which already forbids a
 * foreign value at write time). A value outside the set degrades to `'refreshed'`, NEVER `'shipped'`: `refreshed`
 * is the money-GATED default (a refreshed row must clear the positivity CHECK), so a tampered value can never
 * accidentally earn the price-CHECK exemption a shipped row carries.
 */
export function coerceCatalogMetadataOrigin(value: string): CatalogMetadataOrigin {
  return CATALOG_METADATA_ORIGINS.find((origin) => origin === value) ?? 'refreshed';
}

/** The columns a full upsert overwrites on conflict — everything EXCEPT the `model_id` key and `created_at`. */
function fullUpsertSet(row: NewModelMetadataRow, now: number): Omit<NewModelMetadataRow, 'modelId' | 'createdAt'> {
  return {
    provider: row.provider,
    displayName: row.displayName,
    contextWindowTokens: row.contextWindowTokens,
    maxOutputTokens: row.maxOutputTokens,
    inputCostPerMtokMicrocents: row.inputCostPerMtokMicrocents,
    outputCostPerMtokMicrocents: row.outputCostPerMtokMicrocents,
    cachedInputCostPerMtokMicrocents: row.cachedInputCostPerMtokMicrocents ?? null,
    cacheWriteCostPerMtokMicrocents: row.cacheWriteCostPerMtokMicrocents ?? null,
    contextTiers: row.contextTiers ?? null,
    reasoning: row.reasoning ?? null,
    requestCapabilities: row.requestCapabilities ?? null,
    inputModalities: row.inputModalities ?? null,
    outputModalities: row.outputModalities ?? null,
    knowledgeCutoff: row.knowledgeCutoff ?? null,
    description: row.description ?? null,
    origin: row.origin,
    catalogSchemaVersion: row.catalogSchemaVersion,
    refreshedAt: row.refreshedAt ?? null,
    updatedAt: now,
  };
}

export function createModelMetadataStore(db: Db, deps: ModelMetadataStoreDeps): ModelMetadataStore {
  return {
    readAll: () => db.select().from(modelMetadata).all(),

    upsert: (rows) => {
      if (rows.length === 0) return;
      const now = deps.now();
      // `BEGIN IMMEDIATE` + `withBusyRetry` (ADR-0064 2.5.I): the seed/refresh writer may race a second `relavium`
      // process, so take the write lock up front and retry a bounded number of times on SQLITE_BUSY.
      withBusyRetry(() =>
        db.transaction(
          () => {
            for (const row of rows) {
              db.insert(modelMetadata)
                // `?? now`, not `|| now`: a `createdAt` of 0 (the epoch) is a real timestamp, not "unset" — `||`
                // would silently rewrite it. On conflict this value is ignored anyway (the set omits createdAt).
                .values({ ...row, createdAt: row.createdAt ?? now, updatedAt: now })
                .onConflictDoUpdate({ target: modelMetadata.modelId, set: fullUpsertSet(row, now) })
                .run();
            }
          },
          { behavior: 'immediate' },
        ),
      );
    },

    updateEnrichment: (updates) => {
      if (updates.length === 0) return;
      const now = deps.now();
      withBusyRetry(() =>
        db.transaction(
          () => {
            for (const u of updates) {
              // ONLY the four enrichment columns — money and wire are untouched, so a catalog refresh can enrich a
              // shipped row without ever moving its pinned, human-reviewed price/reasoning (ADR-0072 point 5).
              db.update(modelMetadata)
                .set({
                  inputModalities: u.inputModalities,
                  outputModalities: u.outputModalities,
                  knowledgeCutoff: u.knowledgeCutoff,
                  description: u.description,
                  updatedAt: now,
                })
                .where(eq(modelMetadata.modelId, u.modelId))
                .run();
            }
          },
          { behavior: 'immediate' },
        ),
      );
    },

    readMeta: () => db.select().from(catalogMeta).where(eq(catalogMeta.id, 1)).get(),

    upsertMeta: (patch) => {
      const now = deps.now();
      withBusyRetry(() =>
        db
          .insert(catalogMeta)
          .values({ id: 1, ...patch, updatedAt: now })
          .onConflictDoUpdate({ target: catalogMeta.id, set: { ...patch, updatedAt: now } })
          .run(),
      );
    },
  };
}
