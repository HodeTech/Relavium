import {
  AgentSessionSchema,
  SessionMessageSchema,
  type AgentSessionRecord,
  type SessionMessage,
} from '@relavium/shared';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Db } from './client.js';
import { withBusyRetry } from './retry.js';
import {
  agentSessions,
  sessionMessages,
  type AgentSessionRow,
  type NewAgentSessionRow,
  type NewSessionMessageRow,
  type SessionMessageRow,
  sessionCosts,
} from './schema.js';
import { epochMsToIso, isoToEpochMs } from './time.js';

/**
 * Session persistence (workstream **1.X**) — the directly-stored, append-only transcript layer over the
 * `agent_sessions` + `session_messages` tables (database-schema.md, agent-session-spec.md). A session is
 * **not** event-sourced (ADR-0003 governs *runs*); its row + ordered messages ARE the durable record.
 *
 * The mappers are the single **domain ↔ row** translation point, and the single **validation boundary**:
 * every value is parsed against its `@relavium/shared` schema on the way in (write) and out (read), so a
 * malformed transcript can neither be persisted nor returned, and the reasoning `signature` / inline media
 * a {@link DurableContentPart} forbids stay structurally impossible end to end (ADR-0030/0031). Timestamps
 * are ISO-8601 in the domain and epoch-millisecond `INTEGER`s in storage — converted only here, at the edge.
 *
 * `SessionMessage.content` (a `DurableContentPart[]`) is the canonical body, stored as JSON in
 * `content_parts`; the other scalar columns (`content` text projection, `tool_calls`, `tool_call_id`,
 * `name`, `finish_reason`, token/cost counters) are **optional denormalized metadata** supplied via
 * {@link SessionMessageMeta} — NULL/0 when the durable parts array is the sole source of a row.
 *
 * This package is host-facing (it uses `better-sqlite3`); the platform-free engine never imports it. The
 * desktop / CLI open `history.db` and wire this store — the desktop with SQLCipher (ADR-0005), the CLI
 * unencrypted, guarded by `0600`/`0700` OS permissions (ADR-0050); the per-turn `AgentSession`→store wiring
 * + cross-restart resume are the later sub-spine (1.Y / 1.AA).
 */

/**
 * Optional denormalized metadata for a `session_messages` row that is **not** part of the canonical
 * {@link SessionMessage} transcript: a plain-text projection (display/search), the OpenAI-shape
 * `tool_calls`, the `tool_call_id` / `name` / `finish_reason` scalars, and the per-message token/cost
 * counters. All optional — the durable `content_parts` array is the source of truth for the body.
 */
export interface SessionMessageMeta {
  readonly content?: string;
  readonly toolCalls?: unknown;
  readonly toolCallId?: string;
  readonly name?: string;
  readonly finishReason?: string;
}

/** Map a validated {@link AgentSessionRecord} to an `agent_sessions` insert row (validates on the way in). */
export function toAgentSessionRow(record: AgentSessionRecord): NewAgentSessionRow {
  const s = AgentSessionSchema.parse(record);
  return {
    id: s.id,
    agentId: s.agentId ?? null,
    agentSlug: s.agentSlug,
    agentSnapshot: s.agentSnapshot === undefined ? null : JSON.stringify(s.agentSnapshot),
    title: s.title ?? null,
    modelId: s.modelId ?? null,
    // Denormalized out of context_json for indexing; context_json stays authoritative.
    workingDir: s.context.workingDir,
    gitRef: s.context.gitRef ?? null,
    fsScopeTier: s.context.fsScopeTier,
    status: s.status,
    contextJson: JSON.stringify(s.context),
    totalInputTokens: s.totalInputTokens,
    totalOutputTokens: s.totalOutputTokens,
    totalCostMicrocents: s.totalCostMicrocents,
    exportedWorkflowPath: s.exportedWorkflowPath ?? null,
    deletedAt: s.deletedAt === undefined ? null : isoToEpochMs(s.deletedAt),
    createdAt: isoToEpochMs(s.createdAt),
    updatedAt: isoToEpochMs(s.updatedAt),
  };
}

/**
 * Reconstruct an {@link AgentSessionRecord} from a row. The Zod parse validates **schema-level** integrity
 * (a wrong type / out-of-set enum is rejected with a typed `ZodError`); a non-JSON byte-corruption in a JSON
 * column surfaces earlier as a thrown `SyntaxError` from `JSON.parse` — it aborts the read, never silently
 * returned. Either way a corrupt row cannot yield an invalid record.
 */
export function fromAgentSessionRow(row: AgentSessionRow): AgentSessionRecord {
  // Optional columns spread in only when present (NULL → omitted, honoring exactOptionalPropertyTypes). The
  // `=== null ? {} : {…}` form keeps the test non-negated (sonarjs/no-negated-condition) — type-identical.
  const candidate = {
    id: row.id,
    agentSlug: row.agentSlug,
    ...(row.agentId === null ? {} : { agentId: row.agentId }),
    ...(row.agentSnapshot === null
      ? {}
      : { agentSnapshot: JSON.parse(row.agentSnapshot) as unknown }),
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.modelId === null ? {} : { modelId: row.modelId }),
    context: JSON.parse(row.contextJson) as unknown,
    status: row.status,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    totalCostMicrocents: row.totalCostMicrocents,
    ...(row.exportedWorkflowPath === null
      ? {}
      : { exportedWorkflowPath: row.exportedWorkflowPath }),
    createdAt: epochMsToIso(row.createdAt),
    updatedAt: epochMsToIso(row.updatedAt),
    ...(row.deletedAt === null ? {} : { deletedAt: epochMsToIso(row.deletedAt) }),
  };
  return AgentSessionSchema.parse(candidate);
}

/** Map a validated {@link SessionMessage} (+ optional denormalized {@link SessionMessageMeta}) to a row. */
export function toSessionMessageRow(
  message: SessionMessage,
  meta: SessionMessageMeta = {},
): NewSessionMessageRow {
  const m = SessionMessageSchema.parse(message);
  return {
    id: m.id,
    sessionId: m.sessionId,
    sequenceNumber: m.sequenceNumber,
    role: m.role,
    content: meta.content ?? null,
    // The canonical durable body — the source of truth round-tripped by fromSessionMessageRow.
    contentParts: JSON.stringify(m.content),
    toolCalls: meta.toolCalls === undefined ? null : JSON.stringify(meta.toolCalls),
    toolCallId: meta.toolCallId ?? null,
    name: meta.name ?? null,
    finishReason: meta.finishReason ?? null,
    modelId: m.modelId ?? null,
    // ADR-0062 boundary marker: NULL for every normal row; the durable boundary for a compaction/trim marker.
    compactionDroppedThroughSequence: m.compaction?.droppedThroughSequence ?? null,
    createdAt: isoToEpochMs(m.timestamp),
  };
}

/**
 * Reconstruct a {@link SessionMessage} from a row. The Zod parse validates **schema-level** integrity — and
 * is the read-side guarantee that a base64/inline-media or signature-bearing `content_parts` (one that
 * slipped past the write path) can never be RETURNED (ADR-0030/0031); a non-JSON byte-corruption surfaces
 * earlier as a thrown `SyntaxError` from `JSON.parse`, aborting the read.
 */
export function fromSessionMessageRow(row: SessionMessageRow): SessionMessage {
  const candidate = {
    id: row.id,
    sessionId: row.sessionId,
    sequenceNumber: row.sequenceNumber,
    role: row.role,
    content: row.contentParts === null ? [] : (JSON.parse(row.contentParts) as unknown),
    ...(row.modelId === null ? {} : { modelId: row.modelId }),
    ...(row.compactionDroppedThroughSequence === null
      ? {}
      : { compaction: { droppedThroughSequence: row.compactionDroppedThroughSequence } }),
    timestamp: epochMsToIso(row.createdAt),
  };
  return SessionMessageSchema.parse(candidate);
}

/**
 * Persist + reload an agent session and its append-only transcript. Synchronous (better-sqlite3); the
 * caller supplies fully-formed records (ids + ISO timestamps) — the store owns neither id generation nor
 * the clock, mirroring how the engine takes them from its host.
 */
/**
 * The model string the ADR-0070 migration backfills for a session that predates per-model attribution — one row
 * carrying the whole legacy total, because the per-attempt increments that would have split it were never kept.
 *
 * The CANONICAL home of this value (CLAUDE.md rule 8). It is written by migration 0009 and read by every surface
 * that renders a breakdown; a copy on the other side of the package boundary could drift, and a drift would silently
 * turn the honest "breakdown unavailable" line into a model row literally named `(pre-2.6.C)`.
 */
export const LEGACY_COST_SENTINEL = '(pre-2.6.C)';

/** One `cost:updated` egress, as the store folds it (ADR-0070 §2). */
export interface SessionCostEntry {
  /** A fresh id from the host's `uuid()` — the pattern every other store write uses. It is DISCARDED on the common
   *  path: the conflict target is the `(session_id, model)` unique index, never the PK, so a repeat egress of the
   *  same model folds into the existing row and this id is never stored. */
  readonly id: string;
  readonly sessionId: string;
  /** The RAW provider model string from the event — the attribution KEY (never the catalog UUID; see the schema). */
  readonly model: string;
  /** The catalog id, when the model is catalogued. A join column for enrichment; NEVER the key. */
  readonly modelCatalogId?: string | undefined;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The PER-ATTEMPT increment — never a running cumulative. The store adds it to both sides of the invariant. */
  readonly costMicrocents: number;
  /** `false` when the model could not be priced: the egress still spent real tokens, but `costMicrocents` is 0. A
   *  COUNTER on the row, not a boolean, because 2.6.Q can price a model mid-session (ADR-0070 §6). */
  readonly priced: boolean;
  readonly ts: number;
}

/** A per-`(session, model)` row of the durable money attribution. */
export interface SessionCostRow {
  readonly model: string;
  readonly modelCatalogId: string | undefined;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrocents: number;
  readonly callCount: number;
  /** Of `callCount`, how many could not be priced. `> 0` ⇒ a free-LOOKING row is not a free model. */
  readonly unpricedCalls: number;
}

export interface SessionStore {
  /** Insert a new `agent_sessions` row. */
  createSession: (record: AgentSessionRecord) => void;
  /** Overwrite a session's mutable fields (status, totals, title, exportedWorkflowPath, …) by id. */
  updateSession: (record: AgentSessionRecord) => void;
  /** Load a session record by id, or `undefined` if absent. */
  loadSession: (sessionId: string) => AgentSessionRecord | undefined;
  /**
   * List the non-deleted sessions, most-recently-updated first (the `relavium chat-list` read seam, 2.O; and
   * the 2.5.B Home "recent sessions" strip) — the session counterpart of the run-history `listRuns`.
   * Soft-deleted rows (`deleted_at` set) are excluded, matching `loadSession`; `id` is the stable secondary
   * sort key so the order is deterministic when two rows share an `updated_at`. The order + soft-delete filter
   * are served off the `idx_agent_sessions_updated` partial index (no filesort). Pass `{ limit }` to bound the
   * read to the top-N (the Home reads only what it shows — an indexed top-N, never a full materialization);
   * omit it for the full list (the `chat-list` contract).
   */
  listSessions: (opts?: { readonly limit?: number }) => AgentSessionRecord[];
  /**
   * Fold ONE `cost:updated` egress into the session's durable money attribution (ADR-0070).
   *
   * The SINGLE OWNER of `agent_sessions.total_cost_microcents`. In ONE `BEGIN IMMEDIATE` transaction it does two
   * ADDITIVE writes — upsert the `(session_id, model)` row, and bump the session total by the same increment — so
   * `SUM(session_costs.cost_microcents) == agent_sessions.total_cost_microcents` holds BY CONSTRUCTION, for every
   * session, across resume, reseat, failover, tool loops, compaction, errored turns and aborted turns.
   *
   * Both halves MUST be additive. A resume or an ADR-0059 reseat builds a FRESH persister whose in-process
   * accumulators start at zero, so an absolute write would zero every model row the prior process had committed.
   */
  recordSessionCost: (entry: SessionCostEntry) => void;
  /** The per-model money attribution of a session, ordered by spend (descending). Empty — never `null` — when the
   *  session has not spent. The `/cost` breakdown reads THIS, never an in-memory counter: a resumed session's total
   *  is seeded from the row and covers the whole session, while memory knows only this process's models. */
  loadSessionCosts: (sessionId: string) => SessionCostRow[];
  /**
   * The total AND its per-model rows, read in ONE transaction (ADR-0070 §7).
   *
   * `/cost` promises that the rows sum to the total it prints. The TABLE guarantees that — but two independent reads
   * do NOT: `history.db` runs in WAL, so a reader is never blocked by a writer, and another Relavium process on the
   * same session (the very concurrency the single-writer design defends against) can commit a `recordSessionCost`
   * BETWEEN a `loadSession` and a `loadSessionCosts`. The panel would then print rows that sum to MORE than the total
   * above them — a share over 100% on a money surface. One snapshot, one truth.
   */
  loadSessionCostBreakdown: (sessionId: string) => {
    readonly totalCostMicrocents: number;
    readonly rows: SessionCostRow[];
  };
  /** Append a transcript message (the caller assigns the next monotonic `sequenceNumber`). */
  appendMessage: (message: SessionMessage, meta?: SessionMessageMeta) => void;
  /** Load a session's full transcript in `sequenceNumber` order. */
  loadMessages: (sessionId: string) => SessionMessage[];
  /** Load a session and its ordered transcript — the resume entry point (`undefined` if the session is absent). */
  loadFull: (
    sessionId: string,
  ) => { session: AgentSessionRecord; messages: SessionMessage[] } | undefined;
}

/** Wire a {@link SessionStore} over a `@relavium/db` connection. */
export function createSessionStore(db: Db): SessionStore {
  const loadSession = (sessionId: string): AgentSessionRecord | undefined => {
    // Exclude soft-deleted rows (matching `listSessions`): a tombstoned session must not reload or resume —
    // `chat-resume`'s `loadFull` would otherwise resurrect it and the persister would re-write the row.
    const row = db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.id, sessionId), isNull(agentSessions.deletedAt)))
      .get();
    return row === undefined ? undefined : fromAgentSessionRow(row);
  };

  const listSessions = (opts?: { readonly limit?: number }): AgentSessionRecord[] => {
    // This ORDER BY is index-served (idx_agent_sessions_updated, no filesort); its plan is pinned by
    // apps/cli/src/harness/perf-budget.e2e.test.ts (2.5.I S5) — keep the WHERE/ORDER BY in sync with that budget.
    const query = db
      .select()
      .from(agentSessions)
      .where(isNull(agentSessions.deletedAt))
      .orderBy(desc(agentSessions.updatedAt), desc(agentSessions.id));
    // Only a FINITE POSITIVE INTEGER bounds the read; anything else (undefined, `≤0`, a fraction, `NaN`,
    // `Infinity`) falls back to the unbounded `all()` — the codebase `≤0 ⇒ unbounded` convention, hardened so a
    // non-integer can never reach the SQL `LIMIT` (where it would error or silently truncate).
    const limit = opts?.limit;
    const rows =
      limit !== undefined && Number.isInteger(limit) && limit > 0
        ? query.limit(limit).all()
        : query.all();
    return rows.map(fromAgentSessionRow);
  };

  const loadMessages = (sessionId: string): SessionMessage[] =>
    // Ordered range read by session_id — index-served (idx_session_messages_seq, no filesort); its plan is
    // pinned by apps/cli/src/harness/perf-budget.e2e.test.ts (2.5.I S5).
    db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(asc(sessionMessages.sequenceNumber))
      .all()
      .map(fromSessionMessageRow);

  const readCostRows = (sessionId: string): SessionCostRow[] =>
    db
      .select()
      .from(sessionCosts)
      .where(eq(sessionCosts.sessionId, sessionId))
      .orderBy(desc(sessionCosts.costMicrocents))
      .all()
      .map((r) => ({
        model: r.model,
        modelCatalogId: r.modelCatalogId ?? undefined,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costMicrocents: r.costMicrocents,
        callCount: r.callCount,
        unpricedCalls: r.unpricedCalls,
      }));

  return {
    createSession: (record) => {
      db.insert(agentSessions).values(toAgentSessionRow(record)).run();
    },
    updateSession: (record) => {
      // `created_at` is frozen at creation, so it (and the `id` WHERE-key) are dropped from the SET payload —
      // an update overwrites only the mutable columns (status, title, context, exportedWorkflowPath, deletedAt,
      // updatedAt, …), never the creation timestamp, regardless of what the caller passes.
      //
      // `total_cost_microcents` is ALSO dropped (ADR-0070 §2): it has exactly ONE writer, `recordSessionCost`, which
      // bumps it ADDITIVELY in the same transaction as the `session_costs` row. It used to be SET blindly here from
      // whatever cumulative the caller happened to hold — from four persister call sites and from `chat-export` — so
      // any writer with a stale in-memory total (two `chat-resume` processes on one sessionId; a late flush landing
      // after a cost write) would permanently break `SUM(session_costs) == total_cost_microcents`. A single owner is
      // what makes the invariant a property of the code rather than a hope about call ordering.
      const mutable: Partial<NewAgentSessionRow> = { ...toAgentSessionRow(record) };
      delete mutable.id;
      delete mutable.createdAt;
      delete mutable.totalCostMicrocents;
      db.update(agentSessions).set(mutable).where(eq(agentSessions.id, record.id)).run();
    },

    recordSessionCost: (entry) => {
      // ONE transaction, TWO additive writes. `BEGIN IMMEDIATE` takes the write lock up front (never a DEFERRED
      // read→write upgrade race) and `withBusyRetry` waits out residual contention — the ADR-0064 §2.5.I convention.
      withBusyRetry(() =>
        db.transaction(
          () => {
            db.insert(sessionCosts)
              .values({
                id: entry.id, // discarded on conflict — the target is the (session_id, model) unique index
                sessionId: entry.sessionId,
                model: entry.model,
                modelCatalogId: entry.modelCatalogId ?? null,
                inputTokens: entry.inputTokens,
                outputTokens: entry.outputTokens,
                costMicrocents: entry.costMicrocents,
                callCount: 1,
                unpricedCalls: entry.priced ? 0 : 1,
                createdAt: entry.ts,
                updatedAt: entry.ts,
              })
              .onConflictDoUpdate({
                target: [sessionCosts.sessionId, sessionCosts.model],
                set: {
                  inputTokens: sql`${sessionCosts.inputTokens} + ${entry.inputTokens}`,
                  outputTokens: sql`${sessionCosts.outputTokens} + ${entry.outputTokens}`,
                  costMicrocents: sql`${sessionCosts.costMicrocents} + ${entry.costMicrocents}`,
                  callCount: sql`${sessionCosts.callCount} + 1`,
                  unpricedCalls: sql`${sessionCosts.unpricedCalls} + ${entry.priced ? 0 : 1}`,
                  updatedAt: entry.ts,
                },
              })
              .run();
            db.update(agentSessions)
              .set({
                totalCostMicrocents: sql`${agentSessions.totalCostMicrocents} + ${entry.costMicrocents}`,
                updatedAt: entry.ts,
              })
              .where(eq(agentSessions.id, entry.sessionId))
              .run();
          },
          { behavior: 'immediate' },
        ),
      );
    },

    loadSessionCosts: (sessionId) => readCostRows(sessionId),

    loadSessionCostBreakdown: (sessionId) =>
      // ONE transaction, so the rows and the total the panel prints them under come from the SAME snapshot. Two
      // independent reads on a WAL connection can straddle another process's `recordSessionCost` commit, and the
      // panel would print rows summing to more than its own total.
      withBusyRetry(() =>
        db.transaction(() => ({
          totalCostMicrocents: loadSession(sessionId)?.totalCostMicrocents ?? 0,
          rows: readCostRows(sessionId),
        })),
      ),
    loadSession,
    listSessions,
    appendMessage: (message, meta) => {
      db.insert(sessionMessages).values(toSessionMessageRow(message, meta)).run();
    },
    loadMessages,
    loadFull: (sessionId) =>
      // One read transaction so the session row and its transcript come from a SINGLE consistent snapshot.
      // Without it the two SELECTs are independent reads: a concurrent writer — another `relavium` process, or
      // a `run` sharing this `history.db` — committing an append + a session-total update BETWEEN them yields a
      // torn read (a session whose totals do not match the returned messages). In WAL mode the deferred
      // transaction pins one snapshot for both reads (2.5.I). A read-only body COMMITs a no-op. The write-side
      // `BEGIN IMMEDIATE` + `SQLITE_BUSY` retry this pairs with lands in Step 4 (ADR-0064 amendment note —
      // DB write-path concurrency).
      db.transaction(() => {
        const session = loadSession(sessionId);
        return session === undefined ? undefined : { session, messages: loadMessages(sessionId) };
      }),
  };
}
