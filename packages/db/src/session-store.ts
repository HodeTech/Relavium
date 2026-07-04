import {
  AgentSessionSchema,
  SessionMessageSchema,
  type AgentSessionRecord,
  type SessionMessage,
} from '@relavium/shared';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';

import type { Db } from './client.js';
import {
  agentSessions,
  sessionMessages,
  type AgentSessionRow,
  type NewAgentSessionRow,
  type NewSessionMessageRow,
  type SessionMessageRow,
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
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costMicrocents?: number;
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
    inputTokens: meta.inputTokens ?? 0,
    outputTokens: meta.outputTokens ?? 0,
    costMicrocents: meta.costMicrocents ?? 0,
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
    db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(asc(sessionMessages.sequenceNumber))
      .all()
      .map(fromSessionMessageRow);

  return {
    createSession: (record) => {
      db.insert(agentSessions).values(toAgentSessionRow(record)).run();
    },
    updateSession: (record) => {
      // `created_at` is frozen at creation, so it (and the `id` WHERE-key) are dropped from the SET payload —
      // an update overwrites only the mutable columns (status, totals, title, context, exportedWorkflowPath,
      // deletedAt, updatedAt, …), never the creation timestamp, regardless of what the caller passes.
      const mutable: Partial<NewAgentSessionRow> = { ...toAgentSessionRow(record) };
      delete mutable.id;
      delete mutable.createdAt;
      db.update(agentSessions).set(mutable).where(eq(agentSessions.id, record.id)).run();
    },
    loadSession,
    listSessions,
    appendMessage: (message, meta) => {
      db.insert(sessionMessages).values(toSessionMessageRow(message, meta)).run();
    },
    loadMessages,
    loadFull: (sessionId) => {
      const session = loadSession(sessionId);
      return session === undefined ? undefined : { session, messages: loadMessages(sessionId) };
    },
  };
}
