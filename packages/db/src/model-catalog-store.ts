import {
  MEDIA_SURFACES,
  MODEL_CATALOG_SOURCES,
  type MediaSurface,
  type ModelCatalogSource,
} from '@relavium/shared';
import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm';

import type { Db } from './client.js';
import { modelCatalog, type ModelCatalogRow, type NewModelCatalogRow } from './schema.js';

/**
 * Model-catalog reader (workstream **2.S**, ADR-0045 §1 / ADR-0044 §2-3) — the host source for the two
 * media routing/validation projections: `AgentRunnerDeps.resolveMediaSurface` (generative-vs-chat routing) and
 * the `WorkflowModelCatalog` `CapabilityFlags` load-check. Until this lands the `model_catalog` table has **no
 * reader**, so every model routes inline and no generative model is reachable.
 *
 * `@relavium/db` depends only on `@relavium/shared`, never on `@relavium/llm` (the `CapabilityFlags` home) or
 * `@relavium/core`. So this store returns a **validated row record** + the pure `MediaSurface` routing; the
 * `CapabilityFlags` projection (which needs the `@relavium/llm` schema) is the **host's** job — the engine stays
 * portable (CLAUDE.md rule 5) and `db` stays vendor-SDK-free. Mirrors `provider-store.ts` (the mapper is the
 * single row↔domain + validation boundary; ids/timestamps are store-minted via injected deps).
 */

/**
 * One active `model_catalog` row, validated at the read boundary; the host projects it → `CapabilityFlags`.
 * This is a DELIBERATE projection of the two consumers — the D15 load-check (the capability flags + the parsed
 * `capabilities`) and the media-cost governor (the per-modality rates) — NOT a full row mirror: descriptive/
 * pricing columns the seam does not need (`displayName`, context/token sizes, text-token costs) are omitted by
 * design. Widen this only when a documented consumer needs the field.
 */
export interface ModelCatalogRecord {
  readonly modelId: string;
  readonly providerId: string;
  /** Media-output routing surface (validated against `MEDIA_SURFACES`; a malformed value degrades to `'chat'`). */
  readonly mediaSurface: MediaSurface;
  readonly supportsToolCalling: boolean;
  readonly supportsVision: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsJsonMode: boolean;
  /** The parsed `capabilities` JSON object (validated to be a JSON object here; the host validates it against
   *  the `@relavium/llm` `CapabilityFlagsSchema`). */
  readonly capabilities: Record<string, unknown>;
  /** Per-modality media-output rates in integer µ¢; `null` ⇒ no metered rate → cost degrades to 0 (ADR-0044 §3 H4). */
  readonly mediaImageCostMicrocents: number | null;
  readonly mediaAudioCostMicrocents: number | null;
  readonly mediaVideoCostMicrocents: number | null;
}

/**
 * Fields a caller supplies to seed/replace a catalog row (the store mints id + timestamps + column defaults).
 * Intentionally scoped to what the generative acceptance fixture + an initial sync need; the remaining capability
 * flags (`supportsToolCalling`/`supportsStreaming`/`supportsJsonMode`) fall to their column defaults until a
 * provider-sync needs to set them, so they read back on {@link ModelCatalogRecord} but are not settable here yet.
 */
export interface ModelCatalogUpsert {
  readonly providerId: string;
  readonly modelId: string;
  /** OMITTED on update ⇒ PRESERVE the existing row's value (a pricing-only patch keeps the discovered name/limits,
   *  incl. a soft-deactivated row's); on a true INSERT ⇒ default (`displayName` → the model id, tokens → the `0`
   *  "unknown" sentinel). A full-row caller (the media fixture / a sync) always passes them, so it is unchanged. */
  readonly displayName?: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly mediaSurface?: MediaSurface;
  readonly supportsVision?: boolean;
  readonly capabilities?: Record<string, unknown>;
  readonly mediaImageCostMicrocents?: number | null;
  readonly mediaAudioCostMicrocents?: number | null;
  readonly mediaVideoCostMicrocents?: number | null;
  /** USER-supplied TEXT-token pricing (2.5.G S10, ADR-0065 §1) — integer micro-cents per Mtok. Written under
   *  `source='user'` (a live refresh NEVER clobbers a user row, §1); OMITTED ⇒ the DB default `0`. */
  readonly inputCostPerMtokMicrocents?: number;
  readonly outputCostPerMtokMicrocents?: number;
  readonly cachedInputCostPerMtokMicrocents?: number;
  /** The provenance discriminant ([ADR-0064] §4). OMITTED ⇒ `'static'` (a hardcoded seed), so every existing
   *  media-routing caller is unchanged; the live refresh writes `'live'`; user pricing writes `'user'`. */
  readonly source?: ModelCatalogSource;
  /** The epoch-ms this row was live-refreshed (ADR-0064 §5). OMITTED ⇒ `null` (a static/user or never-refreshed row). */
  readonly lastRefreshedAt?: number;
}

/**
 * The picker/refresh read view of a catalog row ([ADR-0064] §4/§5) — DISTINCT from the narrow media-routing
 * {@link ModelCatalogRecord}: this is the discovery/economics projection the `/models` picker and the
 * `models refresh` reporter consume (id + display + context/limits + the text-token cost columns + provenance
 * + freshness). A stored context/maxOutput of `0` is the NOT-NULL "unknown" sentinel and reads back as
 * `undefined` (ADR-0064 §3, matching `@relavium/llm`'s `ModelListing`, which omits an unknown limit). Cost
 * columns are integer µ¢ (never float); they are `0` for a `live` row (the static registry is the pricing
 * authority — ADR-0064 §6) and carry user pricing only on a `source='user'` row (ADR-0065).
 */
export interface ModelCatalogListing {
  readonly modelId: string;
  readonly providerId: string;
  readonly displayName: string;
  /** `undefined` when unknown (a stored `0` sentinel, ADR-0064 §3). */
  readonly contextWindowTokens?: number;
  /** `undefined` when unknown (a stored `0` sentinel, ADR-0064 §3). */
  readonly maxOutputTokens?: number;
  readonly inputCostPerMtokMicrocents: number;
  readonly outputCostPerMtokMicrocents: number;
  readonly cachedInputCostPerMtokMicrocents: number;
  /** Live-discovered deprecation epoch-ms (ADR-0064 §7); `undefined` when none. */
  readonly deprecationDate?: number;
  /** Provenance, validated at the read boundary (a foreign value degrades to `'static'`). */
  readonly source: ModelCatalogSource;
  /** The last live-refresh epoch-ms; `undefined` for a static/user or never-refreshed row. */
  readonly lastRefreshedAt?: number;
  readonly isActive: boolean;
}

/** One model to seed in a bulk live refresh ({@link ModelCatalogStore.replaceProviderModels}) — the discovery
 *  half only. An absent `contextWindowTokens`/`maxOutputTokens` stores as the `0` "unknown" sentinel; an empty
 *  `displayName` falls back to the model id. Pricing/media columns are NOT set by a live refresh (ADR-0064 §6). */
export interface ModelCatalogLiveModel {
  readonly modelId: string;
  readonly displayName: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

/**
 * The row tallies a {@link ModelCatalogStore.replaceProviderModels} refresh applied, counted ATOMICALLY inside its
 * own transaction and returned to the caller ([ADR-0064] §5). Returning them here — rather than the host diffing a
 * before/after `listByProvider` snapshot — is what makes the counts correct under two CONCURRENT same-provider
 * refreshes: an external diff reads a stale `before` and can double-count the same rows, whereas these tallies are
 * observed from within the serialized write. Counts LIVE rows only (a non-`live` `static`/`user` row is skipped and
 * never contributes — the same provenance protection the write itself enforces). `added` = INSERTed live rows,
 * `updated` = existing live rows refreshed in place, `deactivated` = vanished live rows soft-deactivated.
 */
export interface ReplaceProviderModelsResult {
  readonly added: number;
  readonly updated: number;
  readonly deactivated: number;
}

export interface ModelCatalogStoreDeps {
  readonly uuid: () => string;
  readonly now: () => number;
}

export interface ModelCatalogStore {
  /** The `AgentRunnerDeps.resolveMediaSurface` projection: a model's media-output surface, or `undefined` when
   *  the model is not in the catalog (the host then defaults to `'chat'` — the safe inline path, never generative). */
  resolveMediaSurface: (modelId: string) => MediaSurface | undefined;
  /** The active catalog record for a model id (the host projects it → `CapabilityFlags` for the D15 load-check).
   *  THROWS a {@link ModelCatalogCapabilitiesError} on a corrupt `capabilities` row (non-object / non-JSON) —
   *  fail-closed; the host catches THAT type per-model (so one tampered row degrades that model, not the
   *  whole-catalog projection) while a genuine store/DB fault propagates. Unlike {@link resolveMediaSurface},
   *  which never parses `capabilities` and so stays usable for routing. */
  getByModelId: (modelId: string) => ModelCatalogRecord | undefined;
  /**
   * The active catalog ROW ID — the `model_catalog.id` UUID that is the FK target of `session_messages.model_id`
   * and `agent_sessions.model_id` — for a model STRING, or `undefined` when the model is not cataloged. Uses the
   * SAME source-ranked authoritative-row selection as {@link getByModelId}. Lets a caller resolve a model string
   * (a bound model, or a failover-aware `cost:updated.model`) to the referential id a transcript row stores for
   * per-model cost attribution ([ADR-0059]), degrading to `undefined` → a NULL column (the "unknown" bucket) when
   * the model has not been discovered into the catalog yet.
   */
  catalogIdByModelId: (modelId: string) => string | undefined;
  /** Seed/replace a catalog row (by provider + model) — used by the generative acceptance fixture and a future
   *  provider-sync; the store mints the id + timestamps. */
  upsert: (input: ModelCatalogUpsert) => ModelCatalogRecord;
  /** Active, non-deleted rows for one provider, ordered deterministically (by model id) — the `/models` picker /
   *  `models refresh` view ([ADR-0064] §4). Returns the wide {@link ModelCatalogListing}, NOT the media record. */
  listByProvider: (providerId: string) => ModelCatalogListing[];
  /** Active, non-deleted rows across every provider, ordered by model id — the cross-provider `/models` catalog. */
  listAll: () => ModelCatalogListing[];
  /**
   * Bulk live-upsert for one provider's discovered models ([ADR-0064] §5), in ONE transaction: each `rows` entry
   * is upserted as `source='live'` with `lastRefreshedAt=now` (reusing the existing (provider, model) row id so
   * the FK graph stays stable, reactivating a previously-deactivated live row); every currently-active
   * `source='live'` row of THIS provider whose model id is ABSENT from `rows` is SOFT-DEACTIVATED (`isActive=false`,
   * `deletedAt` untouched). `source='user'`/`source='static'` rows are NEVER touched (the ADR-0065 §1 "a refresh
   * never clobbers a user row" invariant + the media-routing seed's integrity), and nothing is ever hard-DELETED
   * (`model_catalog.id` is an FK target from five tables).
   *
   * Returns the {@link ReplaceProviderModelsResult} tallies (added/updated/deactivated), counted ATOMICALLY inside
   * the transaction — so a concurrent same-provider refresh can never miscount (an external before/after diff would
   * read a stale `before`). Only LIVE rows are counted; a `static`/`user` row is provenance-skipped and excluded.
   */
  replaceProviderModels: (
    providerId: string,
    rows: ReadonlyArray<ModelCatalogLiveModel>,
    now: number,
  ) => ReplaceProviderModelsResult;
  /** The freshness read for the TTL ([ADR-0064] §5): the max `lastRefreshedAt` among a provider's active
   *  `source='live'` rows, or `undefined` when the provider has none. */
  providerRefreshedAt: (providerId: string) => number | undefined;
}

/**
 * Validate the stored `media_surface` against the closed `MEDIA_SURFACES` set. The column is `$type<MediaSurface>`
 * but carries no DB CHECK (a SQLite `ALTER ADD` limitation, schema.ts), so a tampered/foreign value must not be
 * trusted. A non-member degrades to `'chat'` — the SAFE inline surface — so a malformed value can never route a
 * node to the generative `generateMedia` path (fail-closed toward the lower-capability surface).
 */
function coerceMediaSurface(value: string): MediaSurface {
  return MEDIA_SURFACES.find((surface) => surface === value) ?? 'chat';
}

/**
 * Validate the stored `source` against the closed `MODEL_CATALOG_SOURCES` set. Like `media_surface`, the column
 * is `$type<ModelCatalogSource>` but carries no DB CHECK (a SQLite `ALTER ADD` limitation, schema.ts), so a
 * tampered/foreign value must not be trusted. A non-member degrades to `'static'` — the safe, lowest-provenance
 * default: a foreign value is never mistaken for authoritative `'live'` discovery or a `'user'` pricing override.
 * Mirrors {@link coerceMediaSurface} (fail-closed toward the safe default).
 */
function coerceModelCatalogSource(value: string): ModelCatalogSource {
  return MODEL_CATALOG_SOURCES.find((source) => source === value) ?? 'static';
}

/**
 * Map a stored context/maxOutput token count to the picker view: `0` is the NOT-NULL "unknown" sentinel
 * (ADR-0064 §3) and reads back as `undefined`, matching `@relavium/llm`'s `ModelListing` (which omits an
 * unknown limit rather than storing a `0`). A positive value passes through unchanged.
 */
function tokensOrUndefined(value: number): number | undefined {
  return value > 0 ? value : undefined;
}

/**
 * The wide picker/refresh projection ({@link ModelCatalogListing}) — DISTINCT from {@link fromRow} (the narrow
 * media-routing record). Validates `source` at the read boundary and applies the `0 ⇒ undefined` token
 * convention. Optional fields are OMITTED (never assigned `undefined`) under `exactOptionalPropertyTypes`.
 */
function toListing(row: ModelCatalogRow): ModelCatalogListing {
  const contextWindowTokens = tokensOrUndefined(row.contextWindowTokens);
  const maxOutputTokens = tokensOrUndefined(row.maxOutputTokens);
  return {
    modelId: row.modelId,
    providerId: row.providerId,
    displayName: row.displayName,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    inputCostPerMtokMicrocents: row.inputCostPerMtokMicrocents,
    outputCostPerMtokMicrocents: row.outputCostPerMtokMicrocents,
    cachedInputCostPerMtokMicrocents: row.cachedInputCostPerMtokMicrocents,
    ...(row.deprecationDate === null ? {} : { deprecationDate: row.deprecationDate }),
    source: coerceModelCatalogSource(row.source),
    ...(row.lastRefreshedAt === null ? {} : { lastRefreshedAt: row.lastRefreshedAt }),
    isActive: row.isActive,
  };
}

/**
 * A `model_catalog.capabilities` column that is not a JSON object — invalid JSON, or valid JSON that is `null` /
 * an array / a scalar. A typed DOMAIN fault (mirrors {@link MediaWriteError}/`MediaEgressError`), DISTINCT from an
 * infrastructure error (a closed/locked DB connection, an IO fault). The distinction matters to a caller that
 * isolates a single corrupt row: the host D15 capability projection swallows THIS to defer one model, but must
 * let a genuine store fault propagate. Names a reason only — never the column bytes.
 */
export class ModelCatalogCapabilitiesError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelCatalogCapabilitiesError';
  }
}

/**
 * Parse a stored `capabilities` JSON-text column into a JSON object — `unknown` + a runtime shape check at the
 * DB read boundary (no unsafe `as`; same `unknown` + runtime-shape-check boundary posture as `provider-store.ts`'s
 * `parseStringRecord`). UNLIKE that sibling (which still throws a bare TypeError / lets `JSON.parse`'s SyntaxError
 * escape), a corrupt/non-object value here aborts the read with a typed {@link ModelCatalogCapabilitiesError} —
 * so a caller can isolate a corrupt row from a genuine DB fault; the host then validates the object against
 * `CapabilityFlagsSchema`.
 */
function parseCapabilities(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new ModelCatalogCapabilitiesError('model_catalog.capabilities is not valid JSON', {
      cause: err,
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ModelCatalogCapabilitiesError('model_catalog.capabilities is not a JSON object');
  }
  return { ...parsed };
}

function fromRow(row: ModelCatalogRow): ModelCatalogRecord {
  return {
    modelId: row.modelId,
    providerId: row.providerId,
    mediaSurface: coerceMediaSurface(row.mediaSurface),
    supportsToolCalling: row.supportsToolCalling,
    supportsVision: row.supportsVision,
    supportsStreaming: row.supportsStreaming,
    supportsJsonMode: row.supportsJsonMode,
    capabilities: parseCapabilities(row.capabilities),
    mediaImageCostMicrocents: row.mediaImageCostMicrocents,
    mediaAudioCostMicrocents: row.mediaAudioCostMicrocents,
    mediaVideoCostMicrocents: row.mediaVideoCostMicrocents,
  };
}

/** Wire a {@link ModelCatalogStore} over a `@relavium/db` connection. */
export function createModelCatalogStore(db: Db, deps: ModelCatalogStoreDeps): ModelCatalogStore {
  // The authoritative active, non-deleted row for a (non-unique-alone) model id — `model_catalog` is unique on
  // (provider, model), so a model offered by two providers yields more than one active row. A SOURCE-RANK
  // tiebreaker orders FIRST: a `source='live'` row (rank 1) always loses to a non-live `source='static'`/
  // `'user'` row (rank 0) for the same model id. For media/capability resolution the static/user row is
  // AUTHORITATIVE over live — so a `source='live'` chat row (media_surface default 'chat', e.g. a cross-provider
  // live-discovery hit) can never sort ahead of and silently shadow a `source='static'` generative media seed
  // (or a `source='user'` capability/pricing row) and disable `generateMedia()` routing. Within a rank,
  // `asc(createdAt)` with a stable `asc(id)` tiebreaker (the `run-history-store.ts` convention) keeps the
  // resolved row — hence the routing surface + capability record — deterministic across reads even when two
  // rows share a createdAt (two static rows stay rank 0 = 0 and fall through to createdAt/id, unchanged).
  const activeRow = (modelId: string): ModelCatalogRow | undefined =>
    db
      .select()
      .from(modelCatalog)
      .where(
        and(
          eq(modelCatalog.modelId, modelId),
          eq(modelCatalog.isActive, true),
          isNull(modelCatalog.deletedAt),
        ),
      )
      .orderBy(
        sql`CASE WHEN ${modelCatalog.source} = 'live' THEN 1 ELSE 0 END`,
        asc(modelCatalog.createdAt),
        asc(modelCatalog.id),
      )
      .get();

  const rowById = (id: string): ModelCatalogRow | undefined =>
    db.select().from(modelCatalog).where(eq(modelCatalog.id, id)).get();

  const getByModelId = (modelId: string): ModelCatalogRecord | undefined => {
    const row = activeRow(modelId);
    return row === undefined ? undefined : fromRow(row);
  };

  return {
    resolveMediaSurface: (modelId) => {
      const row = activeRow(modelId);
      return row === undefined ? undefined : coerceMediaSurface(row.mediaSurface);
    },

    getByModelId,

    // The authoritative active row's UUID (the FK target) for a model string, or `undefined` when uncataloged —
    // the same source-ranked selection `getByModelId` uses, projected to just the id (ADR-0059 attribution).
    catalogIdByModelId: (modelId) => activeRow(modelId)?.id,

    upsert: (input) => {
      const t = deps.now();
      const existing = db
        .select()
        .from(modelCatalog)
        .where(
          and(
            eq(modelCatalog.providerId, input.providerId),
            eq(modelCatalog.modelId, input.modelId),
            isNull(modelCatalog.deletedAt),
          ),
        )
        .get();
      const id = existing?.id ?? deps.uuid();
      const shared = {
        // Display name + token limits also follow the "never clobber an omitted field on update" invariant (2.5.G
        // S10): a pricing-only `models pricing` patch omits them, so they PRESERVE the existing row's values — incl.
        // a soft-deactivated live row the command's active-only read cannot see (else a re-price would silently zero
        // the discovered name/context). A true INSERT defaults `displayName` → the model id, tokens → the `0`
        // "unknown" sentinel; a full-row caller (media fixture / a sync) passes all three, so it is unchanged.
        displayName: input.displayName ?? existing?.displayName ?? input.modelId,
        contextWindowTokens: input.contextWindowTokens ?? existing?.contextWindowTokens ?? 0,
        maxOutputTokens: input.maxOutputTokens ?? existing?.maxOutputTokens ?? 0,
        // Media routing / capability columns follow the SAME "never clobber an omitted field on update" invariant
        // as the pricing + provenance columns below (2.5.G S10): a partial upsert — e.g. `models pricing` writing a
        // `source='user'` row over a model the live refresh discovered — must NOT reset a live/seed row's
        // `media_surface` back to `'chat'` (silently disabling generative routing) or blank its capabilities. On a
        // true INSERT (`existing` undefined) each still falls to its documented default, so every full-row caller
        // (the media fixture, a re-seed) is byte-for-byte unchanged (it always passes these).
        mediaSurface: input.mediaSurface ?? existing?.mediaSurface ?? 'chat',
        supportsVision: input.supportsVision ?? existing?.supportsVision ?? false,
        capabilities:
          input.capabilities !== undefined
            ? JSON.stringify(input.capabilities)
            : (existing?.capabilities ?? JSON.stringify({})),
        mediaImageCostMicrocents:
          input.mediaImageCostMicrocents ?? existing?.mediaImageCostMicrocents ?? null,
        mediaAudioCostMicrocents:
          input.mediaAudioCostMicrocents ?? existing?.mediaAudioCostMicrocents ?? null,
        mediaVideoCostMicrocents:
          input.mediaVideoCostMicrocents ?? existing?.mediaVideoCostMicrocents ?? null,
        // USER text-token pricing (2.5.G S10) — write the supplied prices, else PRESERVE the existing row's (an
        // update that omits them must not zero a hand-entered price), else the NOT-NULL default `0`.
        inputCostPerMtokMicrocents:
          input.inputCostPerMtokMicrocents ?? existing?.inputCostPerMtokMicrocents ?? 0,
        outputCostPerMtokMicrocents:
          input.outputCostPerMtokMicrocents ?? existing?.outputCostPerMtokMicrocents ?? 0,
        cachedInputCostPerMtokMicrocents:
          input.cachedInputCostPerMtokMicrocents ?? existing?.cachedInputCostPerMtokMicrocents ?? 0,
        // Provenance + freshness (ADR-0064 §4/§5). On a true INSERT (`existing` undefined) these fall to
        // `'static'` / `null`, so every existing media-routing caller (which passes neither) writes a static,
        // never-refreshed row unchanged. On an UPDATE they PRESERVE the existing row's `source`/`lastRefreshedAt`
        // when the caller omits them — a caller that omits `source` (e.g. a future provider-sync patch) must
        // NEVER demote a live-refreshed row back to `'static'` or null its stamp (the "never clobber" invariant,
        // symmetric with `replaceProviderModels`).
        source: input.source ?? existing?.source ?? 'static',
        lastRefreshedAt: input.lastRefreshedAt ?? existing?.lastRefreshedAt ?? null,
        // An upsert (re)activates the row: keep `isActive` in lockstep with `activeRow`'s `isActive = true`
        // filter so a re-upserted, previously-deactivated row is reachable again and the returned record never
        // disagrees with a subsequent `getByModelId` (which filters inactive rows out).
        isActive: true,
        updatedAt: t,
      } satisfies Partial<NewModelCatalogRow>;
      if (existing === undefined) {
        const row: NewModelCatalogRow = {
          id,
          providerId: input.providerId,
          modelId: input.modelId,
          createdAt: t,
          ...shared,
        };
        db.insert(modelCatalog).values(row).run();
      } else {
        db.update(modelCatalog).set(shared).where(eq(modelCatalog.id, id)).run();
      }
      // Re-read by the exact id written (not by modelId — that would return the earliest row for a model id
      // offered by multiple providers, not necessarily the one just upserted).
      const row = rowById(id);
      if (row === undefined) {
        throw new Error(`model_catalog '${input.modelId}' not found after upsert`); // unreachable — just inserted/updated
      }
      return fromRow(row);
    },

    listByProvider: (providerId) =>
      db
        .select()
        .from(modelCatalog)
        .where(
          and(
            eq(modelCatalog.providerId, providerId),
            eq(modelCatalog.isActive, true),
            isNull(modelCatalog.deletedAt),
          ),
        )
        // Deterministic by model id, with `id` as a stable tiebreak (the `activeRow`/`run-history-store`
        // convention) so the picker order never flips between reads for two rows sharing a model id.
        .orderBy(asc(modelCatalog.modelId), asc(modelCatalog.id))
        .all()
        .map(toListing),

    listAll: () =>
      db
        .select()
        .from(modelCatalog)
        .where(and(eq(modelCatalog.isActive, true), isNull(modelCatalog.deletedAt)))
        .orderBy(asc(modelCatalog.modelId), asc(modelCatalog.id))
        .all()
        .map(toListing),

    replaceProviderModels: (providerId, rows, now) =>
      // The transaction RETURNS the tallies so they are observed from WITHIN the serialized write — a concurrent
      // same-provider refresh can never miscount them (an external before/after `listByProvider` diff would read a
      // stale `before` and could double-count). drizzle's better-sqlite3 `transaction()` returns the callback value.
      db.transaction(() => {
        // Only LIVE rows are tallied: `added` on a true INSERT, `updated` on an existing-live-row UPDATE (a non-live
        // `static`/`user` row hits the provenance `continue` below and is counted in NEITHER), `deactivated` from the
        // soft-deactivate UPDATE's `.changes` (its WHERE is already `source='live'`-scoped) — so the counts carry the
        // same LIVE-only intent the write enforces, with no separate source filter needed.
        let added = 0;
        let updated = 0;
        for (const input of rows) {
          const displayName = input.displayName.trim() === '' ? input.modelId : input.displayName;
          // `0` is the NOT-NULL "unknown" sentinel (ADR-0064 §3) — an absent live limit stores as 0.
          const contextWindowTokens = input.contextWindowTokens ?? 0;
          const maxOutputTokens = input.maxOutputTokens ?? 0;
          // Find the existing (provider, model) row (deletedAt IS NULL — the partial-unique scope), whether it
          // is active or soft-deactivated. Reuse its id so FK targets stay stable.
          const existing = db
            .select()
            .from(modelCatalog)
            .where(
              and(
                eq(modelCatalog.providerId, providerId),
                eq(modelCatalog.modelId, input.modelId),
                isNull(modelCatalog.deletedAt),
              ),
            )
            .get();
          if (existing !== undefined && existing.source !== 'live') {
            // A `source='user'` (user pricing, ADR-0065 §1) or `source='static'` (a media-routing seed —
            // media_surface/capabilities/rates) row already represents this model. A live refresh must NEVER
            // clobber it (that would drop user pricing or regress media routing), so it is left UNTOUCHED and,
            // being non-`live`, is also never deactivated below — the model stays represented by its own row.
            // It is counted in neither `added` nor `updated` (provenance-protected — never part of the live delta).
            continue;
          }
          if (existing === undefined) {
            const row: NewModelCatalogRow = {
              id: deps.uuid(),
              providerId,
              modelId: input.modelId,
              displayName,
              contextWindowTokens,
              maxOutputTokens,
              source: 'live',
              lastRefreshedAt: now,
              isActive: true,
              createdAt: now,
              updatedAt: now,
            };
            db.insert(modelCatalog).values(row).run();
            added += 1;
          } else {
            // Reactivate + refresh the existing live row in place (id/created_at/FK refs preserved); only the
            // discovery columns + provenance/freshness are written — pricing/media columns are left as-is.
            db.update(modelCatalog)
              .set({
                displayName,
                contextWindowTokens,
                maxOutputTokens,
                source: 'live',
                lastRefreshedAt: now,
                isActive: true,
                updatedAt: now,
              })
              .where(eq(modelCatalog.id, existing.id))
              .run();
            updated += 1;
          }
        }
        // Soft-deactivate the vanished live rows: every currently-active `source='live'` row of THIS provider
        // whose model id is absent from the new list. `isActive=false` with `deletedAt` untouched keeps the
        // partial-unique slot occupied so a reappearing model reuses the SAME row (reactivated above). NEVER a
        // hard-DELETE (FK target from five tables); NEVER touches `source='user'`/`source='static'`.
        const incomingModelIds = rows.map((r) => r.modelId);
        const deactivateScope = and(
          eq(modelCatalog.providerId, providerId),
          eq(modelCatalog.isActive, true),
          eq(modelCatalog.source, 'live'),
          isNull(modelCatalog.deletedAt),
        );
        const deactivateResult = db
          .update(modelCatalog)
          .set({ isActive: false, updatedAt: now })
          // An empty new list deactivates ALL of the provider's live rows (no `notInArray([])` — its semantics
          // vary; the guard makes the "everything vanished" case explicit).
          .where(
            incomingModelIds.length === 0
              ? deactivateScope
              : and(deactivateScope, notInArray(modelCatalog.modelId, incomingModelIds)),
          )
          .run();
        // better-sqlite3's `RunResult.changes` = the rows the UPDATE matched (each flips isActive true→false, so
        // every matched row is genuinely modified) = the number of live rows soft-deactivated this refresh.
        return { added, updated, deactivated: deactivateResult.changes };
      }),

    providerRefreshedAt: (providerId) => {
      const row = db
        .select({ max: sql<number | null>`max(${modelCatalog.lastRefreshedAt})` })
        .from(modelCatalog)
        .where(
          and(
            eq(modelCatalog.providerId, providerId),
            eq(modelCatalog.isActive, true),
            eq(modelCatalog.source, 'live'),
            isNull(modelCatalog.deletedAt),
          ),
        )
        .get();
      // A bare aggregate returns one row; `max()` over no matching rows is NULL ⇒ undefined.
      const max = row?.max ?? null;
      return max === null ? undefined : max;
    },
  };
}
