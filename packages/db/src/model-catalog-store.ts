import { MEDIA_SURFACES, type MediaSurface } from '@relavium/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';

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
  readonly displayName: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly mediaSurface?: MediaSurface;
  readonly supportsVision?: boolean;
  readonly capabilities?: Record<string, unknown>;
  readonly mediaImageCostMicrocents?: number | null;
  readonly mediaAudioCostMicrocents?: number | null;
  readonly mediaVideoCostMicrocents?: number | null;
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
  /** Seed/replace a catalog row (by provider + model) — used by the generative acceptance fixture and a future
   *  provider-sync; the store mints the id + timestamps. */
  upsert: (input: ModelCatalogUpsert) => ModelCatalogRecord;
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
 * A `model_catalog.capabilities` column that is not a JSON object — invalid JSON, or valid JSON that is `null` /
 * an array / a scalar. A typed DOMAIN fault (mirrors {@link MediaWriteError}/`MediaEgressError`), DISTINCT from an
 * infrastructure error (a closed/locked DB connection, an IO fault). The distinction matters to a caller that
 * isolates a single corrupt row: the host D15 capability projection swallows THIS to defer one model, but must
 * let a genuine store fault propagate. Names a reason only — never the column bytes.
 */
export class ModelCatalogCapabilitiesError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'ModelCatalogCapabilitiesError';
  }
}

/**
 * Parse a stored `capabilities` JSON-text column into a JSON object — `unknown` + a runtime shape check at the
 * DB read boundary (no unsafe `as`; mirrors `provider-store.ts`'s `parseStringRecord`). A corrupt/non-object
 * value aborts the read with a typed {@link ModelCatalogCapabilitiesError} rather than propagating a wrongly-typed
 * value (or a bare TypeError/SyntaxError a caller cannot tell apart from a DB fault); the host then validates the
 * object against `CapabilityFlagsSchema`.
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
  // The earliest active, non-deleted row for a (non-unique-alone) model id — `model_catalog` is unique on
  // (provider, model), so a model offered by two providers yields more than one active row. `asc(createdAt)`
  // with a stable `asc(id)` tiebreaker (the `run-history-store.ts` convention) keeps the resolved row — hence
  // the routing surface + capability record — deterministic across reads even when two rows share a createdAt.
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
      .orderBy(asc(modelCatalog.createdAt), asc(modelCatalog.id))
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
        displayName: input.displayName,
        contextWindowTokens: input.contextWindowTokens,
        maxOutputTokens: input.maxOutputTokens,
        mediaSurface: input.mediaSurface ?? 'chat',
        supportsVision: input.supportsVision ?? false,
        capabilities: JSON.stringify(input.capabilities ?? {}),
        mediaImageCostMicrocents: input.mediaImageCostMicrocents ?? null,
        mediaAudioCostMicrocents: input.mediaAudioCostMicrocents ?? null,
        mediaVideoCostMicrocents: input.mediaVideoCostMicrocents ?? null,
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
  };
}
