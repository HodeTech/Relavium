import { z } from 'zod';

import { nonEmptyString, nonNegativeInt, positiveInt } from './common.js';
import {
  ENGINE_NODE_TYPES,
  ERROR_CODES,
  EXECUTION_MODES,
  FS_SCOPE_TIERS,
  LLM_PROVIDERS,
  MEDIA_BILLED_MODALITIES,
  SESSION_STOP_REASONS,
  STOP_REASONS,
  TOOL_ACTION_CLASSES,
} from './constants.js';
import { GateTypeSchema, TimeoutActionSchema } from './node.js';

/**
 * The run-event stream contract (sse-event-schema.md). A workflow run produces one ordered
 * stream of `RunEvent` objects (keyed by `runId`); an agent session produces a `SessionEvent`
 * stream (keyed by `sessionId`). Both share one base envelope and a monotonic `sequenceNumber`.
 * Event names are the canonical **colon-namespaced** form; events are intentionally lenient
 * (not `.strict()`) so adding an optional field stays forward-compatible.
 */

// --- The base envelope (sse-event-schema.md §"Event envelope") -------------------------------
// `timestamp` is ISO-8601 (UTC `Z` or an offset); `sequenceNumber` is monotonic per run OR per
// session. Exactly one correlation key — `runId` on a run, `sessionId` on a session — is present.

const timestampSeq = {
  timestamp: z.string().datetime({ offset: true }),
  sequenceNumber: nonNegativeInt,
};

/** A run-correlated event (`runId` required). */
const runBase = { runId: nonEmptyString, ...timestampSeq };

/** A session-correlated event (`sessionId` required). */
const sessionBase = { sessionId: nonEmptyString, ...timestampSeq };

/**
 * The dual envelope for the events that may carry EITHER correlation key: the reused conversational ones
 * (`agent:token` / `agent:reasoning` / `agent:tool_call` / `agent:tool_result` / `cost:updated`), plus
 * `agent:approval_requested` (dual at the schema level, but session-only-emitted in Phase 2.5 — the chat
 * approval regime) and `budget:estimate_committed` (ADR-0074 §2). **This spread is the definition of the set** —
 * every member is a `...dualBase` spread and nothing else, so grep it rather than trusting a hand-kept count. They carry `runId` on a run and `sessionId` on a session. A `discriminatedUnion`
 * *member* can't carry a cross-field refinement, so the "exactly one of runId / sessionId" invariant is
 * enforced at the **union** level (see `RunEventSchema`). Run-only / session-only events satisfy it by
 * construction (the other key isn't declared, so it is stripped on parse), so the check only constrains
 * these `dualBase` events.
 */
const dualBase = {
  runId: nonEmptyString.optional(),
  sessionId: nonEmptyString.optional(),
  ...timestampSeq,
};

/** The common envelope (the spec's `BaseEvent`): both correlation keys optional at the type level. */
export const BaseEventSchema = z.object({ type: z.string(), ...dualBase });
export type BaseEvent = z.infer<typeof BaseEventSchema>;

// --- Shared field schemas --------------------------------------------------------------------

export const TokensUsedSchema = z.object({
  input: nonNegativeInt,
  output: nonNegativeInt,
  // Present only when an LLM produced the tokens. A non-agent node (condition, transform,
  // merge, …) completes with input/output 0 and no model — so `model` is optional here.
  model: nonEmptyString.optional(),
});
export type TokensUsed = z.infer<typeof TokensUsedSchema>;

/**
 * A secret-typed `run:started` input, masked at emit time — the raw value is replaced with a
 * keychain/env `ref` (sse-event-schema.md §Security). Never carries the secret itself. The named
 * contract every surface renders for a masked input value.
 */
export const MaskedSecretSchema = z
  .object({ secret: z.literal(true), ref: nonEmptyString })
  .strict(); // reject any extra field so a raw secret value can never ride alongside the masked shape
export type MaskedSecret = z.infer<typeof MaskedSecretSchema>;

/** A gate decision value, shared by the resumed event and `GateDecision`. */
export const GateDecisionValueSchema = z.enum(['approved', 'rejected', 'input_provided']);
export type GateDecisionValue = z.infer<typeof GateDecisionValueSchema>;

/**
 * The closed `ErrorCode` taxonomy carried by `node:failed` / `run:failed` /
 * `session:turn_completed` (sse-event-schema.md §"Error-code taxonomy"). The retryable/fatal
 * mapping is owned by docs/standards/error-handling.md.
 */
export const ErrorCodeSchema = z.enum(ERROR_CODES);

/** The five-value LLM stop reason. Canonical home — the `@relavium/llm` seam re-exports this. */
export const StopReasonSchema = z.enum(STOP_REASONS);

/** The session turn stop reason — the five LLM values plus `aborted` (the EA7 mid-turn abort, ADR-0057). */
export const SessionStopReasonSchema = z.enum(SESSION_STOP_REASONS);

/**
 * The shared failure shape: a closed `code`, a user-safe `message`, `retryable`, and an optional,
 * secret-free `correlationId` the engine stamps at the single producer-side translation point so a
 * surface can quote it and an operator can join it to the structured internal log (reconciles
 * error-handling.md's "user-safe message plus an internal correlation id"; ADR-0036). Additive and
 * forward-compatible — an emitter may omit it.
 */
const eventErrorFields = {
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  correlationId: nonEmptyString.optional(),
};

/**
 * The workspace situation a session runs against (agent-session-spec.md). Self-contained (no
 * cross-package types), so it lands here with the `SessionEvent` union. The `SessionMessage` /
 * `AgentSession` schemas land with the agent-first sub-spine (1.V/1.X): they reference
 * `ContentPart`, which must be **owned by `@relavium/shared`** and re-exported by the seam
 * (the `StopReason` precedent above) — never imported by shared from `@relavium/llm`, which
 * would invert the package dependency.
 */
export const SessionContextSchema = z.object({
  workingDir: nonEmptyString,
  activeFile: nonEmptyString.optional(),
  selection: z
    .object({ file: nonEmptyString, startLine: nonNegativeInt, endLine: nonNegativeInt })
    .refine((sel) => sel.startLine <= sel.endLine, {
      message: 'startLine must be <= endLine',
      path: ['endLine'],
    })
    .optional(),
  gitRef: nonEmptyString.optional(),
  fsScopeTier: z.enum(FS_SCOPE_TIERS),
  variables: z.record(z.string(), z.string()).optional(),
});
export type SessionContext = z.infer<typeof SessionContextSchema>;

// --- Run events (sse-event-schema.md §"The RunEvent union") -----------------------------------

export const RunStartedEventSchema = z.object({
  type: z.literal('run:started'),
  ...runBase,
  workflowId: z.string().uuid(), // FK to workflows.id (surrogate UUID), matching RunSchema — ADR-0022
  inputs: z.record(z.string(), z.unknown()), // a secret-typed input is masked at emit time as MaskedSecret ({ secret: true, ref }); a non-secret keeps its raw value
  executionMode: z.enum(EXECUTION_MODES),
});

export const NodeStartedEventSchema = z.object({
  type: z.literal('node:started'),
  ...runBase,
  nodeId: nonEmptyString,
  // The engine node type (node-types.md is the canonical taxonomy), not the authored YAML type —
  // `parallel`/`merge` have already expanded to `fan_out`/`fan_in` by the time the engine runs.
  nodeType: z.enum(ENGINE_NODE_TYPES),
  // 1-based dispatch attempt (1.S, ADR-0040). Absent ⇒ attempt 1; present + >1 ⇒ a node-retry re-dispatch,
  // so a surface distinguishes "attempt N starting" from a replay. The node may emit several of these.
  attemptNumber: positiveInt.optional(),
});

export const AgentTokenEventSchema = z.object({
  type: z.literal('agent:token'),
  ...dualBase,
  nodeId: nonEmptyString,
  token: z.string(),
  model: nonEmptyString,
});

/**
 * A streaming reasoning ("thinking") delta from an agent turn (EA6, 2.5.H — amends
 * [ADR-0036](../../docs/decisions/0036-run-loop-substrate-event-bus-and-execution-host.md); the
 * `@relavium/llm` seam already carries the reasoning chunks, so this is a pure host-emit). The reasoning
 * counterpart of `agent:token`: a **dual-envelope** event (`runId` on a run, `sessionId` on a session)
 * the correlation-agnostic turn core emits per `reasoning_delta` chunk. Carries the delta `text` + the
 * emitting `model` — never the ephemeral same-provider `signature` (a same-turn continuity token that is
 * never written to an event or log, ADR-0030). A surface renders it as a collapsible "thinking" panel; a
 * consumer that does not care ignores it forward-compatibly (an additive `type`, no `assertNever`).
 */
export const AgentReasoningEventSchema = z.object({
  type: z.literal('agent:reasoning'),
  ...dualBase,
  nodeId: nonEmptyString,
  text: z.string(),
  model: nonEmptyString,
});
export type AgentReasoningEvent = z.infer<typeof AgentReasoningEventSchema>;

export const AgentToolCallEventSchema = z.object({
  type: z.literal('agent:tool_call'),
  ...dualBase,
  nodeId: nonEmptyString,
  model: nonEmptyString, // the invoking model — attributable across a failover
  toolId: nonEmptyString,
  toolInput: z.unknown(), // sanitized — no secrets
  attemptNumber: positiveInt.optional(), // 1-based within-chain (FallbackChain) attempt — matches cost:updated
});

export const AgentToolResultEventSchema = z.object({
  type: z.literal('agent:tool_result'),
  ...dualBase,
  nodeId: nonEmptyString,
  toolId: nonEmptyString,
  success: z.boolean(),
  outputSummary: z.string(),
  attemptNumber: positiveInt.optional(), // 1-based within-chain attempt — matches cost:updated
});

/** The closed side-effecting action class a per-tool approval governs (ADR-0057 EA3). The `ToolActionClass`
 *  TYPE is owned by constants.ts (the `TOOL_ACTION_CLASSES` tuple); this is its validating schema. */
export const ToolActionClassSchema = z.enum(TOOL_ACTION_CLASSES);

/**
 * A GOVERNED tool dispatch reached the per-tool approval gate (ADR-0057 EA3/EA5) — a durable trace that the
 * governed action was gated. The engine's `confirmDispatch` emits it just before invoking the host's
 * `ConfirmActionHook`, whether that hook then PROMPTS a human (accept-edits / auto's protected-path fallback)
 * or DECIDES without one (ask/plan auto-deny, auto auto-approve) — so a `--json` consumer should read it as
 * "a governed action was gated", NOT "the user was asked N times". The registry then awaits the verdict
 * (approve ⇒ dispatch, reject ⇒ a fatal `tool_denied`). A **dual-envelope** event (`runId` on a run,
 * `sessionId` on a session) in the `agent:*` namespace, like `agent:tool_call` — in Phase 2.5 it is emitted
 * only on the chat session path (the approval regime), and the session sink carries it (not run-only, so it
 * is NOT dropped like `agent:file_patch_proposed`). The `preview` is **secret-free and display-only**: the
 * resolved target path / command / host (never a full URL+query, never a secret). `attemptNumber` is absent on
 * the session path today (the registry's `ToolApprovalRequest` carries no chain-attempt index — a cross-seam
 * concept); a `--json` consumer correlates to the following `agent:tool_call` by `sequenceNumber` proximity.
 */
export const AgentApprovalRequestedEventSchema = z.object({
  type: z.literal('agent:approval_requested'),
  ...dualBase,
  nodeId: nonEmptyString,
  toolId: nonEmptyString,
  action: ToolActionClassSchema,
  // `.strict()` (the MaskedSecretSchema precedent) makes this secret-hygiene boundary REJECT an unexpected
  // field (a stray `url` / `query` a host wiring bug might add) LOUDLY rather than silently stripping it.
  preview: z
    .object({
      path: nonEmptyString.optional(), // fs_write — the resolved target path
      command: nonEmptyString.optional(), // process — the resolved command (always non-empty: `min(1)` + join)
      host: nonEmptyString.optional(), // egress — the target host only (never the full URL / query string)
    })
    .strict(),
  attemptNumber: positiveInt.optional(), // 1-based within-chain attempt — matches cost:updated/agent:tool_call
});
export type AgentApprovalRequestedEvent = z.infer<typeof AgentApprovalRequestedEventSchema>;

/**
 * The preview field a per-tool approval action class produces — `fs_write` → path, `process` → command,
 * `egress` → host, `os` → none (a blank preview). Consumed by the union-level `superRefine` (a
 * discriminatedUnion member can't carry its own cross-field refinement) to reject an action-preview DRIFT a
 * host-wiring bug could introduce (e.g. an `egress` approval must never surface a `path`) — `.strict()` on the
 * preview already bars an UNKNOWN key; this bars a KNOWN-but-wrong-for-the-action one.
 */
const APPROVAL_PREVIEW_FIELD: Record<
  (typeof TOOL_ACTION_CLASSES)[number],
  'path' | 'command' | 'host' | undefined
> = { fs_write: 'path', process: 'command', egress: 'host', os: undefined };

export const AgentFilePatchProposedEventSchema = z.object({
  type: z.literal('agent:file_patch_proposed'),
  ...runBase,
  nodeId: nonEmptyString,
  // Gated — no write until the user accepts (e.g. the VS Code inline-diff review).
  // At least one patch — an empty proposal is meaningless (mirrors run:paused.gateIds).
  patches: z.array(z.object({ uri: nonEmptyString, unifiedDiff: z.string() })).min(1),
  attemptNumber: positiveInt.optional(), // 1-based within-chain attempt — matches cost:updated
});

export const CostUpdatedEventSchema = z.object({
  type: z.literal('cost:updated'),
  ...dualBase,
  nodeId: nonEmptyString,
  model: nonEmptyString,
  inputTokens: nonNegativeInt,
  outputTokens: nonNegativeInt,
  costMicrocents: nonNegativeInt, // integer micro-cents (canonical unit); from Relavium's pricing table, never the provider
  cumulativeCostMicrocents: nonNegativeInt, // integer micro-cents running total for the whole run
  // 1-based WITHIN-CHAIN (FallbackChain) attempt this cost belongs to; resets to 1 on each node-retry
  // re-dispatch. DISTINCT from node:*.attemptNumber (the node-retry dispatch index) — the two do NOT join.
  // To attribute cost to a node-retry attempt, partition the sequenceNumber-ordered stream at the
  // node:started / node:retrying boundaries; do not key by (nodeId, attemptNumber) across the two families.
  attemptNumber: positiveInt.optional(),
  // Whether this egress could be PRICED (ADR-0070 §6). ADDITIVE and OPTIONAL — an older reader ignores it.
  //
  // An unpriced model still emits this event with its REAL tokens and `costMicrocents: 0` (the CostTracker's
  // UnknownModelError is swallowed on the cost path), which makes `cost 0 + tokens > 0` ambiguous between "we could
  // not price it" and "the model is genuinely free" — an ambiguity that cannot be resolved from the event without
  // this flag. The durable `session_costs` row records it as an `unpriced_calls` COUNTER rather than a boolean,
  // because 2.6.Q can price a model MID-session, and a boolean on a per-(session, model) aggregate would become
  // meaningless the moment a row folds both priced and unpriced egresses.
  priced: z.boolean().optional(),
});
export type CostUpdatedEvent = z.infer<typeof CostUpdatedEventSchema>;

export const NodeCompletedEventSchema = z.object({
  type: z.literal('node:completed'),
  ...runBase,
  nodeId: nonEmptyString,
  output: z.unknown(),
  tokensUsed: TokensUsedSchema,
  durationMs: nonNegativeInt,
  // The run-wide cost running total AT this node boundary (integer micro-cents) — the SAME counter
  // cost:updated carries, snapshotted onto the durable node:completed so checkpoint/resume (1.R) restores a
  // run's cumulative cost across a process boundary (cost:updated itself is streamed, not persisted). Optional
  // for backward-compat with logs persisted before this field existed; the engine always populates it.
  cumulativeCostMicrocents: nonNegativeInt.optional(),
  // 1-based NODE-RETRY dispatch attempt (1.S, ADR-0040) — the same counter as node:started/node:failed.
  // Absent ⇒ attempt 1. DISTINCT from cost:updated/agent:* attemptNumber (the within-chain FallbackChain
  // index, which resets per node re-dispatch); the two counters do NOT join — see cost:updated above.
  attemptNumber: positiveInt.optional(),
  // The immediate downstream ids a `condition` kept live (its branch selection). Present ONLY for a
  // condition's branch outcome — it is the authoritative record checkpoint/resume (1.R) reconstructs
  // `selectedTargets` from, so a selected branch that was mid-flight at a crash re-runs (not skipped).
  // NOT `.min(1)`: an EMPTY `selected` is a valid outcome — a condition that routes to no branch, which
  // the engine skip-propagates across all downstream (engine.ts `#hasLiveEdge`); only the standard
  // condition handler never emits it (it fails without a default), but the engine contract allows it.
  selected: z.array(nonEmptyString).optional(),
});

export const NodeFailedEventSchema = z.object({
  type: z.literal('node:failed'),
  ...runBase,
  nodeId: nonEmptyString,
  error: z.object(eventErrorFields),
  // 1-based attempt this terminal failure belongs to (1.S, ADR-0040) — the last attempt when a node-retry
  // budget is exhausted. `node:failed` stays the single TERMINAL failure per node; per-attempt failures
  // surface as `node:retrying` (below).
  attemptNumber: positiveInt.optional(),
  // The run-wide cost running total AT this node boundary (integer micro-cents) — the SAME counter
  // cost:updated carries, snapshotted onto the durable node:failed (2.S/D-GC, ADR-0045 §5) so a billed-but-
  // failed PAID media job's realized cost survives on the durable terminal (cost:updated itself is streamed,
  // never persisted — it was the only carrier). Optional for backward-compat with logs persisted before this
  // field existed; the engine always populates it. Mirrors node:completed.cumulativeCostMicrocents.
  cumulativeCostMicrocents: nonNegativeInt.optional(),
});

/**
 * A retryable node attempt failed and the engine will re-dispatch the whole node (1.S,
 * [ADR-0040](../decisions/0040-node-retry-budget-above-the-chain.md)) — **non-terminal**: it does NOT end the
 * node (the terminal is `node:failed`, emitted only when the budget is exhausted). Carries the failed attempt's
 * error (the `NodeFailure` shape, **no** `correlationId` — that anchors the terminal failure) and the `delayMs`
 * backoff before the next attempt. Checkpoint/resume folds it as non-state-bearing (like `node:started`).
 */
export const NodeRetryingEventSchema = z.object({
  type: z.literal('node:retrying'),
  ...runBase,
  nodeId: nonEmptyString,
  /** The attempt that just failed (1-based). The next attempt is `attemptNumber + 1`. */
  attemptNumber: positiveInt,
  // Derived from the canonical `eventErrorFields` (single source of truth) minus `correlationId` — which
  // anchors only the TERMINAL failure (`node:failed`), never a per-attempt retry. Deriving keeps this in
  // lockstep if a field is later added to the shared failure shape, instead of silently drifting.
  error: z.object(eventErrorFields).omit({ correlationId: true }),
  /** The backoff delay (ms) before the next attempt is dispatched. */
  delayMs: nonNegativeInt,
});

/**
 * An async media-generation job was submitted to a provider; the engine now owns its
 * poll/checkpoint/resume/cancel loop (1.AG, ADR-0045 §2). **Durable** so a crash-resume RE-ATTACHES
 * (re-polls the persisted opaque `jobId`) rather than re-submitting (which would double-bill + orphan
 * the vendor job). The node parks — a NON-terminal suspension — until its terminal
 * `node:completed | node:failed | node:skipped`. Per-poll progress is transient (never persisted).
 * `jobId` is Relavium-opaque, never the vendor operation-name (ADR-0011 I1).
 */
export const MediaJobSubmittedEventSchema = z.object({
  type: z.literal('media_job:submitted'),
  ...runBase,
  nodeId: nonEmptyString,
  jobId: nonEmptyString, // the Relavium-opaque job id the engine polls (never the vendor op-name)
  provider: z.enum(LLM_PROVIDERS),
  model: nonEmptyString, // canonical model id
  modality: z.enum(MEDIA_BILLED_MODALITIES), // image | audio | video
  startedAt: z.string().datetime({ offset: true }), // ISO-8601 job-SUBMIT time (when generateMedia returned the jobId; the deadlineAt anchor), not the node-start time
  // deadlineAt = startedAt + [defaults].media_job_deadline_ms; on resume `now > deadlineAt` short-circuits a
  // doomed re-poll. An offset is allowed, so a consumer MUST compare via Date.parse, never lexicographically.
  deadlineAt: z.string().datetime({ offset: true }),
});
export type MediaJobSubmittedEvent = z.infer<typeof MediaJobSubmittedEventSchema>;

/** Why a node was skipped — `branch_not_taken` (a `condition` routed away) or `upstream_unreachable`. */
export const NodeSkippedReasonSchema = z.enum(['branch_not_taken', 'upstream_unreachable']);
export type NodeSkippedReason = z.infer<typeof NodeSkippedReasonSchema>;

/**
 * A vertex the run loop skip-propagated (a `condition` routed away from it, or every in-edge is dead
 * because an upstream was skipped/failed). Emitted so the event log is a **complete, replayable** record
 * — checkpoint/resume (1.R) reconstructs a skipped vertex from this event, and a surface can render the
 * dimmed path instead of seeing the node silently vanish.
 */
export const NodeSkippedEventSchema = z.object({
  type: z.literal('node:skipped'),
  ...runBase,
  nodeId: nonEmptyString,
  reason: NodeSkippedReasonSchema,
});

export const HumanGatePausedEventSchema = z.object({
  type: z.literal('human_gate:paused'),
  ...runBase,
  nodeId: nonEmptyString,
  gateId: nonEmptyString,
  gateType: GateTypeSchema,
  message: z.string(),
  assignee: z.string().optional(),
  timeoutMs: nonNegativeInt.optional(),
  // The on-timeout policy (present only with timeoutMs). Carried on the event so a surface can show how a
  // gate auto-resolves AND so a Phase-2 crash-resume can re-arm the timer from the persisted log (the
  // engine derives no separate gate record — execution-model.md). Absent ⇒ no timeout configured.
  timeoutAction: TimeoutActionSchema.optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});
export type HumanGatePausedEvent = z.infer<typeof HumanGatePausedEventSchema>;

export const HumanGateResumedEventSchema = z.object({
  type: z.literal('human_gate:resumed'),
  ...runBase,
  nodeId: nonEmptyString,
  decision: GateDecisionValueSchema,
  decidedBy: nonEmptyString, // user id, or 'timeout' when a gate auto-resolves on timeout
  payload: z.unknown().optional(),
});
export type HumanGateResumedEvent = z.infer<typeof HumanGateResumedEventSchema>;

/** Either human-gate event (convenience union). */
export type HumanGateEvent = HumanGatePausedEvent | HumanGateResumedEvent;

export const RunCompletedEventSchema = z.object({
  type: z.literal('run:completed'),
  ...runBase,
  outputs: z.record(z.string(), z.unknown()),
  totalTokensUsed: z.object({ input: nonNegativeInt, output: nonNegativeInt }),
  totalCostMicrocents: nonNegativeInt, // integer micro-cents closing total for the run
  durationMs: nonNegativeInt,
});

export const RunFailedEventSchema = z.object({
  type: z.literal('run:failed'),
  ...runBase,
  error: z.object({ ...eventErrorFields, nodeId: nonEmptyString.optional() }), // nodeId = root-cause node
  partialOutputs: z.record(z.string(), z.unknown()),
  // The run-wide cost running total at failure (integer micro-cents). The root-cause node's node:failed snapshots
  // the cumulative as of THAT node, but a SIBLING node's paid media job abandoned by the failure is still billed
  // provider-side and its lone estimate addend is folded only just BEFORE this terminal (ADR-0045 §5) — after that
  // node:failed was already emitted. Snapshotting the cumulative here makes that fail-cost durable (2.S/D-GC);
  // cost:updated, its only other carrier, is streamed, never persisted. Optional for backward-compat; the engine
  // always populates it. Mirrors run:cancelled.cumulativeCostMicrocents and run:completed.totalCostMicrocents.
  cumulativeCostMicrocents: nonNegativeInt.optional(),
});

export const RunCancelledEventSchema = z.object({
  type: z.literal('run:cancelled'),
  ...runBase,
  // The run-wide cost running total at cancellation (integer micro-cents). A PAID media job still pending at
  // the cancel was billed provider-side (its lone estimate addend is emitted just BEFORE this terminal,
  // ADR-0045 §5), so snapshotting the cumulative here makes that fail-cost durable (2.S/D-GC) — cost:updated,
  // its only other carrier, is streamed, never persisted. Optional for backward-compat; the engine always
  // populates it. The run-completed counterpart is run:completed.totalCostMicrocents.
  cumulativeCostMicrocents: nonNegativeInt.optional(),
});

export const RunPausedEventSchema = z.object({
  type: z.literal('run:paused'),
  ...runBase,
  // The multi-gate aggregate — gates pending while the run parks (parallel branches each gate). `0`/empty
  // when the run parks ONLY on an async media job (1.AG Section D); the engine emits `run:paused` only while
  // genuinely parked (a gate OR a media job OR BOTH — AG-A-FC-3), so ≥1 reason holds by construction.
  pendingGateCount: z.number().int().min(0),
  gateIds: z.array(nonEmptyString),
  // The async media-job park (1.AG Section D, [ADR-0045](../../docs/decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) §2):
  // node ids parked on an engine-owned `pollMediaJob` loop, reusing the gate-suspend machinery.
  pendingMediaJobNodeIds: z.array(nonEmptyString).min(1).optional(),
});

export const RunTimeoutEventSchema = z.object({
  type: z.literal('run:timeout'),
  ...runBase,
  elapsedMs: nonNegativeInt,
  timeoutMs: nonNegativeInt,
});

export const BudgetWarningEventSchema = z.object({
  type: z.literal('budget:warning'),
  ...runBase,
  spentMicrocents: nonNegativeInt,
  limitMicrocents: nonNegativeInt,
  thresholdPct: z.number().int().min(0).max(100), // a whole-percent figure (e.g. 90), clamped to [0, 100]
});

export const BudgetPausedEventSchema = z.object({
  type: z.literal('budget:paused'),
  ...runBase,
  nodeId: nonEmptyString, // the agent node whose next LLM call would exceed the cap
  spentMicrocents: nonNegativeInt,
  limitMicrocents: nonNegativeInt,
  gateId: nonEmptyString, // stable id of the budget gate; required by engine.resume(runId, gateId, decision)
});

/**
 * A **conservative budget commitment** made durable ([ADR-0074](../../../docs/decisions/0074-durable-conservative-budget-commitments.md) §2).
 *
 * Emitted when a provider may already have accepted or billed a call but the response supplies no trustworthy
 * usage — a clean EOF with no terminal usage, a partial-stream failure, a cost-tracker failure. The reservation
 * is retained at its bounded estimate instead of being released, because releasing it would reopen a strict cap
 * against money that may already be owed. Persisting it is what makes that survive a crash or a resume: keeping
 * the amount only in memory means the cap reopens the moment the process dies.
 *
 * **This is an estimate, never realized spend, and the split is the whole point of the ADR.** It is deliberately
 * a new `type` rather than a field on `cost:updated`, because folding it into actual-cost reporting would present
 * an upper bound as an invoice — ADR-0074's first rejected alternative. `cost:updated`, the per-model actual-cost
 * attribution, `runs.total_cost_microcents` and `agent_sessions.total_cost_microcents` all stay realized-only
 * ([ADR-0070](../../../docs/decisions/0070-durable-per-model-session-cost-attribution.md)'s
 * `SUM(session_costs) == total_cost_microcents` invariant is therefore untouched). A surface renders this amount
 * as *estimated, possibly billed*.
 *
 * **Dual-envelope** (`runId` on a run, `sessionId` on a session): the governor is shared by workflows and
 * resumable chat, and a safety guarantee that vanished after `chat-resume` would not be a first-class cost cap.
 */
export const BudgetEstimateCommittedEventSchema = z.object({
  type: z.literal('budget:estimate_committed'),
  ...dualBase,
  /**
   * The agent node that owned the attempt. On a SESSION turn this is the agent ref — the same thing
   * `cost:updated` carries there — so realized and conservative money are attributable the same way on both
   * surfaces. Optional so a future emitter with no owning node stays legal.
   */
  nodeId: nonEmptyString.optional(),
  /**
   * 1-based WITHIN-CHAIN (`FallbackChain`) attempt — matches `cost:updated`. Without it, two commitments from
   * the SAME callback and the same failover chain are byte-identical apart from the cumulative, and on the
   * session path (no `nodeId`, no `node:retrying` boundary to partition on) the attempt identity is simply
   * unrecoverable. Realized money from a failover attempt is attributable; conservative money must be too.
   */
  attemptNumber: positiveInt.optional(),
  /** The canonical model id the uncertain attempt ran on — the per-model conservative attribution key (§4). */
  model: nonEmptyString,
  /**
   * THIS commitment's bounded amount: the reservation that was retained rather than released. **This is the
   * field checkpoint reconstruction adds up** — see {@link cumulativeConservativeMicrocents}.
   *
   * `positiveInt`, not `nonNegativeInt`: a zero commitment is meaningless and unreachable by construction
   * (`BudgetGovernor`'s `#admit` refuses `estimateMicrocents <= 0`, so every admission holds at least 1). The
   * bound has to be right on the first version — loosening later is additive, but TIGHTENING later would turn
   * every historical zero row into a known type with an invalid body, which {@link parseStoredRunEvent} is
   * required to THROW on. That is a one-way door.
   */
  estimateMicrocents: positiveInt,
  /**
   * The owner-local running total of conservative commitments after this one — a producer-side snapshot for
   * DISPLAY and cross-checking. **Not the restore source.**
   *
   * Reconstruction sums `estimateMicrocents` (less any release) instead, because a last-wins read of this
   * snapshot is order-dependent and the engine explicitly refuses to guarantee the order it would need:
   * `#emitDurable` awaits the media de-inline BEFORE `#bus.next` assigns the `sequenceNumber`, and its own
   * comment says "concurrent events have no canonical order". Under a `fan_out`, two branches committing 100
   * and 150 can land with the LOWER seq carrying the HIGHER cumulative; restoring from the last one then hands
   * already-owed money back to the cap as headroom — the exact bypass ADR-0074 exists to close.
   *
   * `Math.max` over the snapshots (the trick `node:completed.cumulativeCostMicrocents` uses) is genuinely
   * order-independent and would be correct today — each snapshot is read right after its own increment, so the
   * largest is the true total. It is not chosen because it stops being correct the moment §1's deliberate release
   * DECREASES the total. A sum of signed deltas is correct in both worlds. (`cost:updated` gets away with
   * last-wins only because it is streamed, never persisted — `checkpoint.ts` says so — so it is not the
   * precedent for a durable event.)
   */
  cumulativeConservativeMicrocents: nonNegativeInt,
});
export type BudgetEstimateCommittedEvent = z.infer<typeof BudgetEstimateCommittedEventSchema>;

/** The run-event variants, discriminated on `type` (exposed via `RunEventSchema.innerType()`). */
const RunEventUnionSchema = z.discriminatedUnion('type', [
  RunStartedEventSchema,
  NodeStartedEventSchema,
  AgentTokenEventSchema,
  AgentReasoningEventSchema,
  AgentToolCallEventSchema,
  AgentToolResultEventSchema,
  AgentApprovalRequestedEventSchema,
  AgentFilePatchProposedEventSchema,
  CostUpdatedEventSchema,
  NodeCompletedEventSchema,
  NodeFailedEventSchema,
  NodeSkippedEventSchema,
  NodeRetryingEventSchema,
  MediaJobSubmittedEventSchema,
  HumanGatePausedEventSchema,
  HumanGateResumedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunCancelledEventSchema,
  RunPausedEventSchema,
  RunTimeoutEventSchema,
  BudgetWarningEventSchema,
  BudgetPausedEventSchema,
  BudgetEstimateCommittedEventSchema,
]);

/** The pre-refinement union value — the input every cross-field refinement helper below receives. */
type RunEventUnion = z.infer<typeof RunEventUnionSchema>;

/**
 * The **exactly one of `runId` / `sessionId`** correlation-key invariant (sse-event-schema.md §"Correlation
 * key"). Run-only / session-only events satisfy it by construction — a stray opposite key is stripped by their
 * `z.object` before this refine runs (the deliberate non-strict, forward-compatible posture). The `dualBase`
 * events (every `...dualBase` member — see its definition above) declare both keys as optional, so
 * this is where neither/both is rejected.
 */
function refineCorrelationKey(event: RunEventUnion, ctx: z.RefinementCtx): void {
  const hasRunId = 'runId' in event && event.runId !== undefined;
  const hasSessionId = 'sessionId' in event && event.sessionId !== undefined;
  if (hasRunId === hasSessionId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'exactly one of runId / sessionId must be present',
      path: [hasRunId ? 'sessionId' : 'runId'],
    });
  }
}

/**
 * A conservative commitment's cumulative total must already INCLUDE it (ADR-0074 §2).
 *
 * It holds by construction — the producer reads the counter after adding this commitment to it — and that is
 * precisely why it is worth pinning: the single most likely bug at the emit site is reading the counter BEFORE
 * the `+=`. That mistake emits a first commitment as `{ estimate: 500, cumulative: 0 }`, restores 0 on resume,
 * hands 500 micro-cents of already-owed money back to the cap as headroom, and nothing else anywhere complains.
 * A structural cross-field check a `discriminatedUnion` member cannot carry — the `refineRunPaused` precedent.
 */
function refineBudgetEstimateCommitted(event: RunEventUnion, ctx: z.RefinementCtx): void {
  if (
    event.type === 'budget:estimate_committed' &&
    event.cumulativeConservativeMicrocents < event.estimateMicrocents
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'cumulativeConservativeMicrocents must already include estimateMicrocents (read the counter AFTER adding this commitment)',
      path: ['cumulativeConservativeMicrocents'],
    });
  }
}

/** A gate's on-timeout policy only has meaning when a timeout is configured. */
function refineHumanGateTimeout(event: RunEventUnion, ctx: z.RefinementCtx): void {
  if (
    event.type === 'human_gate:paused' &&
    event.timeoutAction !== undefined &&
    event.timeoutMs === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'timeoutAction is only valid when timeoutMs is also present',
      path: ['timeoutAction'],
    });
  }
}

/**
 * The two `run:paused` structural invariants the relaxed member constraints (a media-only park has 0 gates)
 * dropped: a pause carries ≥1 reason (a gate OR a media job — 1.AG Section D), and `pendingGateCount` agrees
 * with `gateIds.length` (a consumer that reads the aggregate count must not diverge from the list it pairs
 * with). The engine never emits a malformed one; this rejects it.
 */
function refineRunPaused(event: RunEventUnion, ctx: z.RefinementCtx): void {
  if (event.type !== 'run:paused') return;
  if (event.gateIds.length === 0 && (event.pendingMediaJobNodeIds?.length ?? 0) === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'run:paused must carry at least one suspension reason (a gate or a media job)',
      path: ['gateIds'],
    });
  }
  if (event.pendingGateCount !== event.gateIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'run:paused pendingGateCount must equal gateIds.length',
      path: ['pendingGateCount'],
    });
  }
}

/**
 * `deadlineAt = startedAt + media_job_deadline_ms` by construction, so deadlineAt < startedAt is a malformed
 * durable event that would invert the resume `now > deadlineAt` short-circuit. Compare via Date.parse (an
 * offset is allowed, so never lexically).
 */
function refineMediaJobDeadline(event: RunEventUnion, ctx: z.RefinementCtx): void {
  if (
    event.type === 'media_job:submitted' &&
    Date.parse(event.deadlineAt) < Date.parse(event.startedAt)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'media_job:submitted deadlineAt must be >= startedAt',
      path: ['deadlineAt'],
    });
  }
}

/**
 * Bind an approval preview to its action class (ADR-0057 EA5). Two rules:
 *  1. DRIFT — a preview may carry ONLY the field its action produces (see {@link APPROVAL_PREVIEW_FIELD}); an
 *     `egress` approval must never surface a `path`, etc. (`.strict()` on the preview already bars an UNKNOWN
 *     key; this bars a KNOWN-but-wrong-for-the-action one.)
 *  2. MISSING — `fs_write` and `process` ALWAYS resolve their target before the gate (the registry's
 *     `previewFor` sets `path`/`command` from a mandatory policy target), so a BLANK preview there is a
 *     host-wiring bug — reject it. `egress` is exempt (its `host` is legitimately absent for `mcp_call` /
 *     `web_search`, a valid blank preview), and `os` carries no target field at all.
 */
function refineApprovalPreview(event: RunEventUnion, ctx: z.RefinementCtx): void {
  if (event.type !== 'agent:approval_requested') return;
  const allowed = APPROVAL_PREVIEW_FIELD[event.action];
  for (const key of ['path', 'command', 'host'] as const) {
    if (key !== allowed && event.preview[key] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `preview.${key} is not valid for a ${event.action} approval`,
        path: ['preview', key],
      });
    }
  }
  if (
    (event.action === 'fs_write' || event.action === 'process') &&
    allowed !== undefined &&
    event.preview[allowed] === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `a ${event.action} approval requires preview.${allowed}`,
      path: ['preview', allowed],
    });
  }
}

/**
 * The full run-event schema every surface consumes: the discriminated union plus the cross-field invariants a
 * `discriminatedUnion` member cannot carry (a member-level `.refine()` would make it a ZodEffects and break the
 * union). Each concern lives in its own named helper above; this composes them so the schema stays a thin,
 * readable pipeline.
 */
export const RunEventSchema = RunEventUnionSchema.superRefine((event, ctx) => {
  refineCorrelationKey(event, ctx);
  refineHumanGateTimeout(event, ctx);
  refineRunPaused(event, ctx);
  refineMediaJobDeadline(event, ctx);
  refineApprovalPreview(event, ctx);
  refineBudgetEstimateCommitted(event, ctx);
});
export type RunEvent = z.infer<typeof RunEventSchema>;

// --- Session events (sse-event-schema.md §"Session event namespace") --------------------------

export const SessionStartedEventSchema = z.object({
  type: z.literal('session:started'),
  ...sessionBase,
  agentRef: nonEmptyString,
  model: nonEmptyString,
  context: SessionContextSchema,
});

export const SessionTurnStartedEventSchema = z.object({
  type: z.literal('session:turn_started'),
  ...sessionBase,
});

export const SessionTurnCompletedEventSchema = z.object({
  type: z.literal('session:turn_completed'),
  ...sessionBase,
  // The session superset of `StopReason` — the five LLM values plus `aborted` (the EA7 mid-turn abort: the
  // turn ends but the session stays alive, ADR-0057). `aborted` carries NO `error` (it is user-initiated,
  // not a failure); a failed turn uses `stopReason: 'error'` + the `error` field.
  stopReason: SessionStopReasonSchema,
  tokensUsed: TokensUsedSchema,
  // A failed turn (provider error, rate limit, cancellation) still completes — with an error.
  error: z.object(eventErrorFields).optional(),
});

export const SessionCancelledEventSchema = z.object({
  type: z.literal('session:cancelled'),
  ...sessionBase,
});

export const SessionExportedEventSchema = z.object({
  type: z.literal('session:exported'),
  ...sessionBase,
  workflowPath: nonEmptyString,
});

/**
 * Context compaction STARTED ([ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md) §7,
 * amending [ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)) — the engine began
 * summarising the working context (a `/compact` or an auto-threshold trigger) and the summariser LLM call is now in
 * flight. Emitted at the START of `compact()` (after the nothing-to-fold / plan-resolution guards), and paired with
 * a terminal `session:compacted` (success) / `session:trimmed` `auto-fallback` (summariser failed) / a silent
 * settle (a manual `/compact` that failed — the host clears the moment when `compact()` resolves). The host drives a
 * labeled "Summarizing…" moment off it so a paid, multi-second operation is never an apparently-frozen pause. It
 * carries no counts — the token deltas ride the terminal `session:compacted`; it is purely the moment's START.
 */
export const SessionCompactingEventSchema = z.object({
  type: z.literal('session:compacting'),
  ...sessionBase,
  reason: z.enum(['manual', 'auto-threshold']),
});

/**
 * Context compaction applied ([ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md)) —
 * the engine summarised the earlier working context into `summary` and now feeds it as a system-prompt
 * preamble; the host writes the append-only boundary marker row on this event. `keptMessageCount` is how many
 * trailing in-memory messages the engine RETAINED verbatim (the host maps it to the durable
 * `droppedThroughSequence`). `tokensUsed` is the summarization call's REAL usage — accounted to the session
 * budget (ADR-0028); it is NOT a user turn and does not count against `max_turns`.
 */
export const SessionCompactedEventSchema = z.object({
  type: z.literal('session:compacted'),
  ...sessionBase,
  reason: z.enum(['manual', 'auto-threshold']),
  summary: nonEmptyString,
  keptMessageCount: nonNegativeInt,
  tokensBefore: nonNegativeInt,
  tokensAfter: nonNegativeInt,
  tokensUsed: TokensUsedSchema,
});

/**
 * Deterministic history trim applied ([ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md)) —
 * the engine dropped older messages with NO LLM call (revives `[chat].max_messages`); the host writes a
 * summary-less boundary marker. `keptMessageCount` (the host maps it to the durable boundary) +
 * `droppedMessageCount` are the deterministic counts. No `tokensUsed` — a trim spends nothing.
 */
export const SessionTrimmedEventSchema = z.object({
  type: z.literal('session:trimmed'),
  ...sessionBase,
  // `manual` = the `/trim` command (the surface notices its own result); `auto-fallback` = the deterministic
  // trim the engine degrades to when an auto-compaction summariser FAILS — the view surfaces this one so the
  // fallback is never silent (ADR-0062 §5). Symmetric with `session:compacted.reason`.
  reason: z.enum(['manual', 'auto-fallback']),
  keptMessageCount: nonNegativeInt,
  droppedMessageCount: nonNegativeInt,
});

/**
 * The `session:*` lifecycle events. Within a turn a session also reuses the dual-envelope events
 * above (`agent:token` / `agent:reasoning` / `agent:tool_call` / `agent:tool_result` / `cost:updated`) plus,
 * on the chat approval path, `agent:approval_requested` (ADR-0057) — all carried with `sessionId` — so the
 * complete session stream is this union plus those. Adding an arm is additive; a consumer with a `default` arm
 * ignores an unknown event forward-compatibly (there is no `assertNever` over this union — a new arm is a
 * silent no-op for existing consumers until each opts in, ADR-0062).
 */
export const SessionEventSchema = z.discriminatedUnion('type', [
  SessionStartedEventSchema,
  SessionTurnStartedEventSchema,
  SessionTurnCompletedEventSchema,
  SessionCancelledEventSchema,
  SessionExportedEventSchema,
  SessionCompactingEventSchema,
  SessionCompactedEventSchema,
  SessionTrimmedEventSchema,
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type SessionCompactingEvent = z.infer<typeof SessionCompactingEventSchema>;
export type SessionCompactedEvent = z.infer<typeof SessionCompactedEventSchema>;
export type SessionTrimmedEvent = z.infer<typeof SessionTrimmedEventSchema>;

/**
 * The combined event the shared `RunEventBus` carries — the `run:*`/`node:*` family **and** the
 * `session:*` family on **one** bus (ADR-0036 "one bus, two namespaces"). A `z.union` (not a flat
 * discriminated union) so each family keeps its own refinements — notably `RunEventSchema`'s correlation-key
 * cross-check and its `dualBase` members (the reused `agent:*`/`cost:updated` events plus
 * `agent:approval_requested` and `budget:estimate_committed`, which carry `sessionId` when session-emitted and
 * `runId` on a run); a
 * `session:*` lifecycle event matches the `SessionEventSchema` arm. This is the single validation gate the
 * bus parses against; the per-correlation-key `sequenceNumber` is assigned there.
 */
export const RunOrSessionEventSchema = z.union([RunEventSchema, SessionEventSchema]);
export type RunOrSessionEvent = RunEvent | SessionEvent;

// Per-variant inferred types, for consumers that handle a specific event. NOTE: this block is the
// rest of the per-variant exports — a few (CostUpdatedEvent, the HumanGate* events, SessionContext)
// are exported inline next to their schemas above; this trailing block is NOT the exhaustive set.
export type RunStartedEvent = z.infer<typeof RunStartedEventSchema>;
export type NodeStartedEvent = z.infer<typeof NodeStartedEventSchema>;
export type AgentTokenEvent = z.infer<typeof AgentTokenEventSchema>;
export type AgentToolCallEvent = z.infer<typeof AgentToolCallEventSchema>;
export type AgentToolResultEvent = z.infer<typeof AgentToolResultEventSchema>;
export type AgentFilePatchProposedEvent = z.infer<typeof AgentFilePatchProposedEventSchema>;
export type NodeCompletedEvent = z.infer<typeof NodeCompletedEventSchema>;
export type NodeFailedEvent = z.infer<typeof NodeFailedEventSchema>;
export type NodeSkippedEvent = z.infer<typeof NodeSkippedEventSchema>;
export type NodeRetryingEvent = z.infer<typeof NodeRetryingEventSchema>;
export type RunCompletedEvent = z.infer<typeof RunCompletedEventSchema>;
export type RunFailedEvent = z.infer<typeof RunFailedEventSchema>;
export type RunCancelledEvent = z.infer<typeof RunCancelledEventSchema>;
export type RunPausedEvent = z.infer<typeof RunPausedEventSchema>;
export type RunTimeoutEvent = z.infer<typeof RunTimeoutEventSchema>;
export type BudgetWarningEvent = z.infer<typeof BudgetWarningEventSchema>;
export type BudgetPausedEvent = z.infer<typeof BudgetPausedEventSchema>;
export type SessionStartedEvent = z.infer<typeof SessionStartedEventSchema>;
export type SessionTurnStartedEvent = z.infer<typeof SessionTurnStartedEventSchema>;
export type SessionTurnCompletedEvent = z.infer<typeof SessionTurnCompletedEventSchema>;
export type SessionCancelledEvent = z.infer<typeof SessionCancelledEventSchema>;
export type SessionExportedEvent = z.infer<typeof SessionExportedEventSchema>;

/** The decision applied to resume a human gate (`engine.resume(runId, gateId, decision)`). */
export const GateDecisionSchema = z.object({
  decision: GateDecisionValueSchema,
  decidedBy: nonEmptyString, // user id, or 'timeout' when a gate auto-resolves on timeout
  payload: z.unknown().optional(),
  comment: z.string().optional(),
});
export type GateDecision = z.infer<typeof GateDecisionSchema>;

/**
 * The forward-compatible READ of a stored run event (ADR-0074 §5).
 *
 * `RunEventSchema` is a `z.discriminatedUnion('type', …)`, so it **throws** on a `type` it does not know —
 * and `SessionEventSchema` and the `RunOrSessionEventSchema` union over both behave the same way. That
 * contradicts this contract's own promise: [sse-event-schema.md](../../../docs/reference/contracts/sse-event-schema.md)
 * §Forward-compatibility states that adding a new event `type` — or a new optional field on an existing one — is
 * "always v1.0-legal and never a breaking change, **provided consumers ignore unknown `type`s and unknown
 * fields**". Until ADR-0074, no consumer did the first half — so one row written by a newer binary made an entire
 * run unreadable to an older one, rather than partially understood. (The second half already held: Zod object
 * schemas strip unknown keys by default, which is what lets a newer binary add a field like ADR-0074 §3's
 * `media_job:submitted.units` without breaking this reader.)
 *
 * The rule is one distinction, and it is the whole of §5:
 *
 * - an **unknown discriminator** is a newer writer ⇒ `undefined`, and the caller drops the row;
 * - a **known `type` with an unparseable body** is corruption ⇒ **throws**, because
 *   [ADR-0050](../../../docs/decisions/0050-cli-history-db-at-rest-posture.md)'s durability-first posture must
 *   never silently swallow a damaged row.
 *
 * Deliberately READ-only. Every WRITE-side parse (the bus's producer gate, `persistEvent`'s validate-on-the-way-in,
 * the engine's own construction) stays strict: a producer emitting a `type` the schema does not know is our bug,
 * not forward evolution, and tolerating it there would hide exactly the drift the gate exists to catch.
 *
 * There is no `parseStoredSessionEvent` twin because there is nothing for it to read: `run_events` is the only
 * table that stores serialized events, and a session's history persists as message rows, not as `SessionEvent`s.
 * `RunOrSessionEventSchema` is parsed in exactly one place — the bus's producer gate — which is a write. Should a
 * stored-session-event or dual-envelope read ever appear, it needs this same treatment before it ships, for the
 * same reason: the tolerant read has to precede the first new `type` on the wire, or the log becomes a one-way door.
 */
export function parseStoredRunEvent(candidate: unknown): RunEvent | undefined {
  const parsed = RunEventSchema.safeParse(candidate);
  if (parsed.success) {
    return parsed.data;
  }
  if (isUnknownDiscriminator(parsed.error, candidate)) {
    return undefined;
  }
  throw parsed.error;
}

/**
 * Whether `error` says exactly one thing: "`type` is a value I do not recognize".
 *
 * **Only the last condition is currently falsifiable, and it is the one that matters.** Zod raises the same
 * `invalid_union_discriminator` for `type: undefined` as it does for `type: 'some:future_event'` — but those are
 * opposites. No writer of ours has ever omitted `type`, so a row missing it is damaged and must throw; only a
 * non-empty string can be a newer writer's event name. That check is what separates the two.
 *
 * The first three are defensive. A `z.discriminatedUnion` aborts on the discriminator, so today an unrecognized
 * `type` *always* yields exactly one issue, coded `invalid_union_discriminator`, anchored at `['type']` — there is
 * no input that reaches this function and fails one of them. They are kept because each pins an assumption that a
 * future edit could break silently: a nested discriminated union inside a variant's body would report the same code
 * at a *deeper* path, and a Zod upgrade could start reporting body issues alongside the discriminator. Losing an
 * assumption there means silently dropping a damaged row, so they are cheap insurance — not live guards.
 *
 * **This helper does NOT generalize to `RunOrSessionEventSchema`.** That is a `z.union` of two discriminated
 * unions, and a `z.union` reports an unknown `type` as a single `invalid_union` issue at the ROOT — not
 * `invalid_union_discriminator` at `['type']`. Pointing this function at it would reject every forward-written row
 * while looking correct. A dual-envelope read needs its own arm-level distinction.
 */
function isUnknownDiscriminator(error: z.ZodError, candidate: unknown): boolean {
  const [issue, ...rest] = error.issues;
  if (issue === undefined || rest.length > 0) return false;
  if (issue.code !== z.ZodIssueCode.invalid_union_discriminator) return false;
  if (issue.path.length !== 1 || issue.path[0] !== 'type') return false;
  // Cast-free narrowing (the shape `content.ts` and `media-deinline.ts` use), so no `as` sits at this boundary.
  if (typeof candidate !== 'object' || candidate === null || !('type' in candidate)) return false;
  const type: unknown = candidate.type;
  return typeof type === 'string' && type.length > 0;
}
