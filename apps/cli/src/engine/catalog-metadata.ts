import {
  createModelMetadataStore,
  type Db,
  type EnrichmentUpdate,
  type ModelMetadataRow,
  type ModelMetadataStore,
  type NewModelMetadataRow,
} from '@relavium/db';
import {
  admitRefreshedModels,
  CATALOG_SCHEMA_VERSION,
  CATALOG_SHA256,
  CATALOG_SNAPSHOT,
  installCatalogRefresh,
  ProviderIdSchema,
  type CatalogModel,
  type CatalogPriceTier,
  type ReasoningControls,
  type RequestCapabilities,
} from '@relavium/llm';
import { z } from 'zod';

/**
 * The HOST half of the DB-backed catalog ([ADR-0072](../../../../docs/decisions/0072-model-metadata-in-the-db-behind-a-generated-offline-floor.md)).
 *
 * This is where `@relavium/db` (raw `model_metadata` rows) and `@relavium/llm` (the `CatalogModel` shape + the
 * `admitRefreshedModels` money gate) meet — the ONE place both may be imported, exactly like `pricing-overlay.ts`.
 * The engine stays platform-free: it receives the installed overlay through the pure `installCatalogRefresh` seam
 * and never sees the DB.
 *
 * **The DB is a durable BACKING, never the terminal money source.** The generated snapshot floor stays
 * authoritative for shipped ids (ADR-0072 point 2): the read path installs only the LONG TAIL as the overlay (the
 * shared gate excludes every snapshot id on compile-time membership), and `catalogModel = refreshed[id] ??
 * CATALOG_SNAPSHOT[id]` answers a shipped model from the snapshot. So a torn/empty/older-schema DB degrades to the
 * snapshot, offline — the money floor cannot erode.
 */

// Zod schemas for the normalized JSON columns — the boundary validation the sibling stores (`provider-store.ts`
// `parseStringRecord`, `model-catalog-store.ts` `parseCapabilities`) apply, so a stored value is VALIDATED, never
// trusted through an unsafe `as` (CLAUDE.md rule 1). Each mirrors a `CatalogModel` sub-shape.
const StringArraySchema = z.array(z.string());
const PriceTiersSchema = z.array(
  z.object({
    aboveContextTokens: z.number(),
    inputPerMtokMicrocents: z.number(),
    outputPerMtokMicrocents: z.number(),
    cachedInputPerMtokMicrocents: z.number().optional(),
  }),
);
const ReasoningSchema = z.object({
  effortValues: z.array(z.string()).optional(),
  budgetTokens: z.object({ min: z.number(), max: z.number().optional() }).optional(),
  toggle: z.literal(true).optional(),
});
const CapabilitiesSchema = z.object({
  temperature: z.boolean().optional(),
  toolCall: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  attachment: z.boolean().optional(),
});

/**
 * Parse + VALIDATE a JSON text column against its schema. A NULL column, malformed JSON, or a value that fails the
 * shape all yield `undefined` — the field falls back to its safe default. Returning `undefined` (drop the FIELD),
 * not `undefined` from the whole row, is deliberate even for the money-relevant `contextTiers`: a long-tail model
 * keeps its NOT-NULL flat base rate, so the cost cap still ENGAGES (understating long-context) — strictly safer
 * than failing the row into "unpriced", where the cap degrades to `allow` ("a wrong price engages the cap; a
 * missing price does not"). These rows are written by our own serializer, so a failure here is belt-and-suspenders.
 */
function parseJson<T>(text: string | null, schema: z.ZodTypeAny): T | undefined {
  if (text === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = schema.safeParse(parsed);
  // The value is now Zod-VALIDATED against `schema`. The assertion to `T` only reconciles Zod's `field?: X |
  // undefined` optional typing with the `CatalogModel` interfaces' `exactOptionalPropertyTypes` (`field?: X`) — a
  // pure type-representation difference (Zod never materializes an `undefined` KEY), NOT a validation bypass. This
  // is the deliberate distinction from the original `JSON.parse(text) as T`, which trusted the column unchecked.
  return result.success ? (result.data as T) : undefined;
}

/** Project a stored row to a {@link CatalogModel}, or `undefined` if it cannot be one (a provider outside the closed
 *  seam enum — a long-tail model of a provider Relavium has no adapter for). Money columns keep their DB semantics:
 *  a NULL cache rate becomes `undefined`, NEVER `0` (ADR-0071 §10). The row's `origin`/`catalog_schema_version`
 *  bookkeeping is not part of the shape — the caller filters on version before projecting. */
export function rowToCatalogModel(row: ModelMetadataRow): CatalogModel | undefined {
  const provider = ProviderIdSchema.safeParse(row.provider);
  if (!provider.success) return undefined;
  const cachedInput = row.cachedInputCostPerMtokMicrocents;
  const cacheWrite = row.cacheWriteCostPerMtokMicrocents;
  const tiers = parseJson<readonly CatalogPriceTier[]>(row.contextTiers, PriceTiersSchema);
  const reasoning = parseJson<ReasoningControls>(row.reasoning, ReasoningSchema);
  const requestCapabilities = parseJson<RequestCapabilities>(
    row.requestCapabilities,
    CapabilitiesSchema,
  );
  const inputModalities = parseJson<readonly string[]>(row.inputModalities, StringArraySchema);
  const outputModalities = parseJson<readonly string[]>(row.outputModalities, StringArraySchema);
  return {
    provider: provider.data,
    modelId: row.modelId,
    displayName: row.displayName,
    contextWindowTokens: row.contextWindowTokens,
    maxOutputTokens: row.maxOutputTokens,
    inputPerMtokMicrocents: row.inputCostPerMtokMicrocents,
    outputPerMtokMicrocents: row.outputCostPerMtokMicrocents,
    // NULL ⇒ undefined, never 0 (0 would price a cached read as FREE — ADR-0071 §10).
    ...(cachedInput === null ? {} : { cachedInputPerMtokMicrocents: cachedInput }),
    ...(cacheWrite === null ? {} : { cacheWritePerMtokMicrocents: cacheWrite }),
    ...(tiers === undefined ? {} : { contextTiers: tiers }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(requestCapabilities === undefined ? {} : { requestCapabilities }),
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(outputModalities === undefined ? {} : { outputModalities }),
    ...(row.knowledgeCutoff === null ? {} : { knowledgeCutoff: row.knowledgeCutoff }),
    ...(row.description === null ? {} : { description: row.description }),
  };
}

/** Serialize a {@link CatalogModel} into a full `model_metadata` row. `undefined` money ⇒ NULL (never 0);
 *  `undefined` JSON ⇒ NULL. `origin` and the schema version are the caller's, not the model's. */
export function catalogModelToRow(
  model: CatalogModel,
  origin: 'shipped' | 'refreshed',
  now: number,
): NewModelMetadataRow {
  return {
    modelId: model.modelId,
    provider: model.provider,
    displayName: model.displayName,
    contextWindowTokens: model.contextWindowTokens,
    maxOutputTokens: model.maxOutputTokens,
    inputCostPerMtokMicrocents: model.inputPerMtokMicrocents,
    outputCostPerMtokMicrocents: model.outputPerMtokMicrocents,
    cachedInputCostPerMtokMicrocents: model.cachedInputPerMtokMicrocents ?? null,
    cacheWriteCostPerMtokMicrocents: model.cacheWritePerMtokMicrocents ?? null,
    contextTiers: model.contextTiers === undefined ? null : JSON.stringify(model.contextTiers),
    reasoning: model.reasoning === undefined ? null : JSON.stringify(model.reasoning),
    requestCapabilities:
      model.requestCapabilities === undefined ? null : JSON.stringify(model.requestCapabilities),
    inputModalities:
      model.inputModalities === undefined ? null : JSON.stringify(model.inputModalities),
    outputModalities:
      model.outputModalities === undefined ? null : JSON.stringify(model.outputModalities),
    knowledgeCutoff: model.knowledgeCutoff ?? null,
    description: model.description ?? null,
    origin,
    catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
    refreshedAt: origin === 'refreshed' ? now : null,
    createdAt: now,
    updatedAt: now,
  };
}

/** The enrichment tuple for a SHIPPED row — the only columns a catalog refresh may write onto it (ADR-0072 §5). */
function enrichmentOf(model: CatalogModel): EnrichmentUpdate {
  return {
    modelId: model.modelId,
    inputModalities:
      model.inputModalities === undefined ? null : JSON.stringify(model.inputModalities),
    outputModalities:
      model.outputModalities === undefined ? null : JSON.stringify(model.outputModalities),
    knowledgeCutoff: model.knowledgeCutoff ?? null,
    description: model.description ?? null,
  };
}

/**
 * Seed the shipped models into the DB from `CATALOG_SNAPSHOT`, **SHA-gated** so it is a no-op once the DB already
 * mirrors this binary's snapshot (ADR-0072 point 6). Re-seeds after a binary upgrade (a changed snapshot SHA) or a
 * normalizer-version change, rewriting the pinned money+wire from the reviewed snapshot. Returns `true` if it wrote.
 */
export function seedShippedCatalog(store: ModelMetadataStore, now: number): boolean {
  const meta = store.readMeta();
  if (
    meta?.seededSnapshotSha === CATALOG_SHA256 &&
    meta?.catalogSchemaVersion === CATALOG_SCHEMA_VERSION
  ) {
    return false; // the DB already mirrors this binary — nothing to do
  }
  // CARRY FORWARD enrichment across a reseed. A reseed rewrites the money+wire from the newly-reviewed snapshot, but
  // the snapshot carries NO enrichment (modalities/knowledge/description) yet — so a naive full overwrite would
  // blank whatever a prior `models refresh --catalog` had fetched via `updateEnrichment`, on EVERY binary release,
  // silently undoing ADR-0072 point 5's DB-refreshed enrichment. So: prefer the (new) snapshot's enrichment when it
  // has any, else keep the existing DB row's. `?? prior` on each of the four pure-enrichment columns does exactly
  // that — and stays correct for a FUTURE snapshot that DOES bake enrichment in (its value wins over `?? prior`).
  const prior = new Map(store.readAll().map((r): [string, typeof r] => [r.modelId, r]));
  const rows = Object.values(CATALOG_SNAPSHOT).map((model) => {
    const row = catalogModelToRow(model, 'shipped', now);
    const existing = prior.get(model.modelId);
    if (existing === undefined) return row;
    return {
      ...row,
      inputModalities: row.inputModalities ?? existing.inputModalities,
      outputModalities: row.outputModalities ?? existing.outputModalities,
      knowledgeCutoff: row.knowledgeCutoff ?? existing.knowledgeCutoff,
      description: row.description ?? existing.description,
    };
  });
  store.upsert(rows);
  store.upsertMeta({
    seededSnapshotSha: CATALOG_SHA256,
    catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
  });
  return true;
}

/**
 * Install the runtime overlay FROM the DB (ADR-0072 point 7) — the DB replaces the file cache as the durable
 * backing. Reads every row at the CURRENT normalizer version (an older-shape row is treated as ABSENT and falls to
 * the snapshot), projects each to a `CatalogModel`, and hands the lot to `installCatalogRefresh` — which applies the
 * SAME `admitRefreshedModels` gate the overlay always has, so shipped ids are excluded on snapshot membership and
 * only the priced long tail becomes the overlay. Returns the count admitted.
 */
export function installCatalogFromDb(store: ModelMetadataStore): number {
  const models: Record<string, CatalogModel> = {};
  for (const row of store.readAll()) {
    // Only 'refreshed' long-tail rows can ever become the overlay — a shipped id is excluded by the gate on
    // snapshot membership regardless, so parsing its JSON columns on every priced command is pure waste. Filtering
    // by origin here (a) skips that parse, and (b) means a STALE `origin='shipped'` row for a model a later binary
    // DE-SHIPPED is never re-admitted as long-tail: it simply falls out, and the snapshot (which no longer carries
    // it) is the correct authority. So there is no lingering-de-shipped-at-old-price drift to accept.
    if (row.origin !== 'refreshed') continue;
    if (row.catalogSchemaVersion !== CATALOG_SCHEMA_VERSION) continue; // stale shape ⇒ absent, fall to the snapshot
    const model = rowToCatalogModel(row);
    if (model !== undefined) models[row.modelId] = model;
  }
  // SINGLE AUTHORITATIVE BACKING (ADR-0072 point 7): install from the DB ONLY when it actually contributes admitted
  // long-tail rows. `installCatalogRefresh` is a WHOLESALE REPLACE, so installing an empty set would WIPE whatever
  // overlay is already live — and right after `seedShippedCatalog` the DB holds only shipped rows (all excluded by
  // the gate on snapshot membership), so the admitted set is empty. An unconditional install there would erase the
  // boot file-cache overlay and silently UNPRICE its long tail (the cap degrades to `allow` — "a missing price does
  // not engage the cap"). So: gate on non-emptiness, and leave the existing (file-cache/snapshot) overlay untouched
  // when the DB has nothing current to add. Once a P4 refresh has populated `model_metadata`, the DB wins.
  const admitted = admitRefreshedModels(models);
  if (Object.keys(admitted).length === 0) return 0;
  return installCatalogRefresh(models);
}

/**
 * The host entry a pricing surface calls once its `history.db` is open: seed the shipped rows (SHA-gated) and
 * install the overlay from the DB. This SUPERSEDES the boot-time file-cache overlay (`installCatalogRefresh` is a
 * wholesale replace), making the DB the single authoritative backing whenever it is reachable — while a
 * fresh/torn/older-schema DB degrades to the snapshot floor, offline (ADR-0072 point 7).
 */
export function syncCatalogFromDb(db: Db, now: () => number): number {
  try {
    const store = createModelMetadataStore(db, { now });
    seedShippedCatalog(store, now());
    return installCatalogFromDb(store);
  } catch {
    // A DB fault (a torn write, a locked table) is NOT a reason to fail a priced command — the boot file-cache
    // overlay and, under it, the snapshot floor still answer. Best-effort, exactly like `loadCachedCatalog`.
    return 0;
  }
}

/**
 * Persist a freshly-fetched models.dev catalog to the DB (ADR-0072 points 5, 7). The write is split by the SAME
 * money gate the overlay uses, so the DB path cannot admit a row the overlay would reject:
 *
 * - the priced **long tail** (`admitRefreshedModels` — excludes shipped ids, requires a finite positive price) is
 *   upserted as full `origin='refreshed'` rows;
 * - a **shipped** id is enriched **only** (`updateEnrichment` — modalities/knowledge/description), so its
 *   human-reviewed, snapshot-pinned money+wire is never moved by a bot refresh.
 *
 * Then the `catalog_meta` catalog-axis TTL cursor is stamped. `catalog` is the normalized output of
 * `normalizeCatalog` (already Relavium types); this never fetches or normalizes — that is the refresh path's job.
 *
 * **Accepted drift (upsert-only, no eviction):** a long-tail id that later DROPS OUT of the models.dev payload is
 * not deleted here — it lingers at its last-fetched price and is re-admitted by every subsequent install. This is
 * not a money regression (the lingering price is a real, last-known-good one, and if the model is truly gone the
 * provider call errors rather than silently overspending), only staleness; eventual eviction is a deferred follow-up.
 */
export function persistCatalogToDb(
  store: ModelMetadataStore,
  catalog: Readonly<Record<string, CatalogModel>>,
  now: number,
): void {
  // The long tail, through the shared gate — the DB write boundary enforces the identical additive-admission rule.
  const admitted = admitRefreshedModels(catalog);
  const refreshedRows = Object.values(admitted).map((model) =>
    catalogModelToRow(model, 'refreshed', now),
  );
  // Shipped ids: enrichment only. In the current wiring the boot/command seed always runs before this persist over
  // the same store, so the row exists; the `updateEnrichment` no-op-on-0-rows behavior is defensive for a future
  // caller that persists before seeding, not a routinely-hit path.
  const shippedEnrichment: EnrichmentUpdate[] = [];
  for (const [id, model] of Object.entries(catalog)) {
    if (CATALOG_SNAPSHOT[id] !== undefined) shippedEnrichment.push(enrichmentOf(model));
  }
  store.upsert(refreshedRows);
  store.updateEnrichment(shippedEnrichment);
  store.upsertMeta({ catalogCheckedAt: now });
}
