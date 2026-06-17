import { z } from 'zod';

import { AgentSchema } from './agent.js';
import { nonEmptyString, nonNegativeInt } from './common.js';
import { DurableContentPartSchema } from './content.js';
import { SessionContextSchema } from './run-event.js';

/**
 * The **durable session-persistence contracts** (agent-session-spec.md §"Session messages" /
 * §"Validation and persistence", database-schema.md §"Agent-session tables"). Authored by workstream
 * **1.X**: a session and its transcript persist directly as rows in the encrypted `history.db`
 * (`agent_sessions` + `session_messages`) — a directly-stored, append-only record, **not** an
 * event-sourced projection (ADR-0003 governs *runs*, not sessions).
 *
 * Both types are the persisted/transcript shape: a `SessionMessage` carries the **durable**
 * {@link DurableContentPart} union ([ADR-0030](../../decisions/0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md)/[ADR-0031](../../decisions/0031-llm-seam-shape-amendment-multimodal-io.md)),
 * so reasoning `signature` continuity tokens and inline media bytes are **structurally impossible**
 * here (the durable union has no `signature` field and only handle-only media). The in-flight
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

/**
 * One **append-only** transcript message (agent-session-spec.md §"Session messages"). `content` is the
 * **durable** content union — handle-only media, signature-less reasoning. Never edited or deleted; only
 * appended at the next `sequenceNumber` (monotonic per session). Lenient (not `.strict()`) so an additive
 * field stays forward-compatible — mirrors {@link SessionContextSchema} and the run-event family.
 */
export const SessionMessageSchema = z.object({
  id: nonEmptyString,
  sessionId: nonEmptyString,
  sequenceNumber: nonNegativeInt,
  role: SessionMessageRoleSchema,
  content: z.array(DurableContentPartSchema),
  /** The model that produced an assistant turn (fallback-aware) — a `model_catalog` id reference the host
   *  resolves, NOT a raw model string (mirrors the `session_messages.model_id` FK). */
  modelId: nonEmptyString.optional(),
  timestamp: isoTimestamp,
});
export type SessionMessage = z.infer<typeof SessionMessageSchema>;

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
  /** The authored `agent_ref` the session is bound to (`agent_sessions.agent_slug`). */
  agentSlug: nonEmptyString,
  /** The catalog `agents.id` this session resolved to, when the agent was a stored catalog entry. */
  agentId: nonEmptyString.optional(),
  /** Frozen agent config for reproducibility (`agent_sessions.agent_snapshot`). */
  agentSnapshot: AgentSchema.optional(),
  title: nonEmptyString.optional(),
  /** The session's configured **primary** model (resolved at start) — a `model_catalog` id reference (not a
   *  raw model string); a per-turn model may differ under fallback, recorded on each `SessionMessage.modelId`. */
  modelId: nonEmptyString.optional(),
  context: SessionContextSchema,
  status: SessionStatusSchema,
  totalInputTokens: nonNegativeInt,
  totalOutputTokens: nonNegativeInt,
  totalCostMicrocents: nonNegativeInt,
  /** Set when the session is exported to a `.relavium.yaml` (ADR-0026). */
  exportedWorkflowPath: nonEmptyString.optional(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  /** Soft-delete tombstone; absent for a live session. */
  deletedAt: isoTimestamp.optional(),
});
export type AgentSessionRecord = z.infer<typeof AgentSessionSchema>;
