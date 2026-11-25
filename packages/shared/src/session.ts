import { z } from 'zod';

import { AgentSnapshotSchema } from './agent.js';
import { kebabIdSchema, nonEmptyString, nonNegativeInt } from './common.js';
import { CHAT_MODES } from './constants.js';
import { SessionContextSchema, SessionInterruptionSchema, StopReasonSchema } from './run-event.js';
import {
  SessionContentPartSchema,
  SessionToolCallPartSchema,
  SessionToolCallIdSchema,
  SessionToolNameSchema,
} from './session-content.js';

/**
 * The **durable session-persistence contracts** (agent-session-spec.md §"Session messages" /
 * §"Validation and persistence", database-schema.md §"Agent-session tables"). Authored by workstream
 * **1.X**: a session and its transcript persist directly as rows in the encrypted `history.db`
 * (`agent_sessions` + `session_messages`) — a directly-stored, append-only record, **not** an
 * event-sourced projection (ADR-0003 governs *runs*, not sessions).
 *
 * Both types are the persisted/transcript shape: a `SessionMessage` carries the session-only
 * structural content union (ADR-0095), distinct from the generic durable run/event union (ADR-0030/0031),
 * so reasoning `signature` continuity tokens and inline media bytes are **structurally impossible**
 * here (the session union refuses unknown fields and has only handle-only media). The in-flight
 * `ContentPart` form `LlmMessage` carries is **distinct by design** — the `AgentRunner` projects a
 * persisted message into `LlmMessage` at call time, never the reverse. Timestamps are ISO-8601 (the
 * host stores them as epoch-millisecond `INTEGER`s — the `@relavium/db` mapper converts at the edge).
 */

/**
 * The persisted lifecycle state of a session (database-schema.md `agent_sessions.status`). Deliberately
 * **distinct** from the `session:*` EVENT lifecycle (started / turn_started / turn_completed / cancelled /
 * exported) — this is the durable row's coarse state, the `session:*` stream is the live signal.
 */
export const SessionStatusSchema = z.enum(['active', 'idle', 'exported', 'ended']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** A session transcript role. Owned by `@relavium/shared` (includes `system`, unlike the seam's
 *  `LlmRole`, where the system prompt is a separate top-level field). */
export const SessionMessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type SessionMessageRole = z.infer<typeof SessionMessageRoleSchema>;

/** ISO-8601 with a required UTC `Z` or numeric offset (matches the run-event envelope's `timestamp`). */
const isoTimestamp = z.string().datetime({ offset: true });

/** The chat modes a record names: the one closed list (`constants.ts`), never `config.ts`'s schema (which imports this module's graph). */
const RecordedChatModeSchema = z.enum(CHAT_MODES);

/**
 * What a **record row** records ([ADR-0148](../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §6):
 * a content-free fact about the session that is not part of the conversation. A closed set of kinds, each with closed fields:
 *
 * - `mode_change`: the effective chat mode of a live, interactive session changed from `from` to `to` (never equal). Every effective change is
 *   recorded, not only the widening ones, so the record of a mode has its end as well as its start.
 * - `cost_release`: the person released the session's held conservative estimates ([ADR-0074](../../../docs/decisions/0074-durable-conservative-budget-commitments.md)
 *   §1); `microcents` is the durable amount the release cleared, read inside the release's own transaction.
 *
 * Strict at every level: an unknown kind or an extra field is refused, never stripped.
 */
export const SessionRecordSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('mode_change'),
      from: RecordedChatModeSchema,
      to: RecordedChatModeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('cost_release'),
      microcents: nonNegativeInt,
    })
    .strict(),
]);
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
/** The closed set of record kinds, derived from the schema itself (the `session_messages.record_kind` CHECK is written from it). */
export const SESSION_RECORD_KINDS: readonly SessionRecord['kind'][] =
  SessionRecordSchema.options.map((option) => option.shape.kind.value);

/**
 * One **append-only** transcript message (agent-session-spec.md §"Session messages"). `content` is the
 * session-only content union — structural tools, handle-only media, signature-less reasoning. Never edited
 * or deleted; only appended at the next sequenceNumber. Strict at the whole persistence boundary: an
 * unknown argument/result field is refused, never silently stripped (ADR-0095).
 */
export const SessionMessageSchema = z
  .object({
    id: nonEmptyString,
    sessionId: nonEmptyString,
    sequenceNumber: nonNegativeInt,
    role: SessionMessageRoleSchema,
    content: z.array(SessionContentPartSchema),
    /** The model that produced an assistant turn (fallback-aware) — a `model_catalog` id reference the host
     *  resolves, NOT a raw model string (mirrors the `session_messages.model_id` FK). */
    modelId: nonEmptyString.optional(),
    /**
     * Present ONLY on a compaction/trim **boundary marker** row (`role: 'system'`, [ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md)).
     * Records the durable `sequenceNumber` **through which** older messages are superseded: on resume, messages
     * at/below `droppedThroughSequence` are dropped from the working context, and — when this marker carries
     * summary text (a `/compact` marker; a `/trim` marker's content is empty) — that text becomes the context
     * preamble. Absent on every normal transcript row. The mapper round-trips it via
     * the compaction_dropped_through_sequence
     * column (an older reader that lacks the column reads the marker as an inert `system` row).
     */
    compaction: z.object({ droppedThroughSequence: nonNegativeInt }).strict().optional(),
    /**
     * Present ONLY on an **interruption row** (`role: 'system'`, empty `content`,
     * [ADR-0119](../../../docs/decisions/0119-an-interrupted-turn-stays-as-a-content-free-marker.md)): the terminal row of a
     * retained aborted/failed/denied/`turn_limit` turn. A closed reason and, for `failed`, a closed `ErrorCode` —
     * stored in the `interruption_reason`/`interruption_code` columns. Never together with `compaction`.
     */
    interruption: SessionInterruptionSchema.optional(),
    /**
     * Present ONLY on a **record row** (`role: 'system'`, empty `content`, ADR-0148 §6): a content-free fact about the session —
     * an effective mode change, or a released estimate — stored in the `record_*` columns. Never together with `compaction` or
     * `interruption`. The one history projection skips it (a system row that is not an interruption), so it is never drawn, never
     * sent to a model and never part of a resumed context; it is read back only through the session store.
     */
    record: SessionRecordSchema.optional(),
    timestamp: isoTimestamp,
  })
  .strict()
  .superRefine((message, ctx) => {
    if (message.record !== undefined) {
      if (message.role !== 'system') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a record belongs to a system row' });
      }
      if (message.compaction !== undefined || message.interruption !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'a record row is not a boundary marker or an interruption',
        });
      }
      if (message.content.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a record row carries no content' });
      }
      if (message.record.kind === 'mode_change' && message.record.from === message.record.to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'a mode change names two different modes',
        });
      }
    }
    if (message.compaction !== undefined && message.role !== 'system') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a boundary marker belongs to a system row',
      });
    }
    if (message.interruption !== undefined) {
      if (message.role !== 'system') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'an interruption belongs to a system row',
        });
      }
      if (message.compaction !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'a row is a boundary marker or an interruption, never both',
        });
      }
      if (message.content.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'an interruption row carries no content',
        });
      }
    }
    if (message.role === 'tool' && message.content.some((part) => part.type !== 'tool_result')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a tool row contains only structural results',
      });
    }
    if (message.role !== 'tool' && message.content.some((part) => part.type === 'tool_result')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'structural results belong to a tool row',
      });
    }
    if (message.role !== 'assistant' && message.content.some((part) => part.type === 'tool_call')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'structural calls belong to an assistant row',
      });
    }
  });
export type SessionMessage = z.infer<typeof SessionMessageSchema>;

/** The store validates this complete denormalized input and joins every supplied projection to content. */
export const SessionMessageMetaSchema = z
  .object({
    content: z.string().optional(),
    toolCalls: z.array(SessionToolCallPartSchema).optional(),
    toolCallId: SessionToolCallIdSchema.optional(),
    name: SessionToolNameSchema.optional(),
    finishReason: StopReasonSchema.optional(),
    /** Host-captured pre-expansion user display; independent of canonical content (ADR-0123). */
    userDisplayText: z.string().optional(),
  })
  .strict();

/**
 * The **durable session record** — the domain shape of an `agent_sessions` row (agent-session-spec.md
 * §"Validation and persistence", database-schema.md §`agent_sessions`). Named `…Record` to disambiguate
 * from the `AgentSession` engine **class** (1.V). `context` freezes the {@link SessionContext} the session
 * ran against; `agentSnapshot` freezes the agent config for reproducibility. `workingDir` / `gitRef` /
 * `fsScopeTier` live inside `context` (the `@relavium/db` mapper denormalizes them onto their own columns
 * for indexing). `context.variables` is plaintext supplied by the surface — it MUST NOT carry a secret
 * (agent-session-spec.md §"Tools, secrets, and security scope"); secrets ride the keychain, never a row.
 */
export const AgentSessionSchema = z.object({
  id: nonEmptyString,
  /** The authored `agent_ref` the session is bound to (`agent_sessions.agent_slug`) — kebab-case, like every
   *  `agent.id` / `agent_ref`, so it transfers verbatim into an exported workflow's `agent_ref` (1.Z). */
  agentSlug: kebabIdSchema,
  /** The catalog `agents.id` this session resolved to, when the agent was a stored catalog entry. */
  agentId: nonEmptyString.optional(),
  /** Frozen agent config for reproducibility (`agent_sessions.agent_snapshot`). */
  agentSnapshot: AgentSnapshotSchema.optional(),
  title: nonEmptyString.optional(),
  /** The session's configured **primary** model (resolved at start) — a `model_catalog` id reference (not a
   *  raw model string); a per-turn model may differ under fallback, recorded on each `SessionMessage.modelId`. */
  modelId: nonEmptyString.optional(),
  context: SessionContextSchema,
  status: SessionStatusSchema,
  totalInputTokens: nonNegativeInt,
  totalOutputTokens: nonNegativeInt,
  totalCostMicrocents: nonNegativeInt,
  /**
   * The session's durable CONSERVATIVE total (ADR-0074 §1/§4) — money a provider may already have billed for an
   * attempt that returned no trustworthy usage.
   *
   * Strictly apart from {@link totalCostMicrocents}: an ESTIMATE, never realized spend. It consumes cap capacity
   * when a session resumes, so a crash cannot reopen a cap against money that may already be owed, but it never
   * inflates a reported cost. `.default(0)` because every session written before §4 has none, and a resumed
   * pre-§4 session must read as "nothing committed" rather than fail to parse.
   */
  totalConservativeMicrocents: nonNegativeInt.default(0),
  /** Set when the session is exported to a `.relavium.yaml` (ADR-0026). */
  exportedWorkflowPath: nonEmptyString.optional(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  /** Soft-delete tombstone; absent for a live session. */
  deletedAt: isoTimestamp.optional(),
});
export type AgentSessionRecord = z.infer<typeof AgentSessionSchema>;
