import {
  AgentSessionSchema,
  SessionMessageSchema,
  type AgentSessionRecord,
  type SessionMessage,
} from '@relavium/shared';
import { asc, eq } from 'drizzle-orm';

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
 * desktop / CLI open the encrypted `history.db` and wire this store; the per-turn `AgentSession`→store
 * wiring + cross-restart resume are the later sub-spine (1.Y / 1.AA).
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
    const row = db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
    return row === undefined ? undefined : fromAgentSessionRow(row);
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
