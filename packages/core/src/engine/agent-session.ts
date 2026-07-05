/**
 * `AgentSession` (1.V) — Relavium's **agent-first entry point**: an ongoing, multi-turn conversation
 * bound to **one** agent + its fallback chain, a first-class peer of a workflow run that **reuses the
 * same execution substrate** rather than a parallel implementation
 * ([ADR-0024](../../../../docs/decisions/0024-agent-first-entry-point-agentsession.md),
 * [agent-session-spec.md](../../../../docs/reference/contracts/agent-session-spec.md)). Each
 * `sendMessage` drives **one turn through the same turn core** a workflow `agent` node uses
 * ({@link runAgentTurn} — the correlation-agnostic core the `AgentRunner` (1.O) also wraps), so a
 * session's streaming, tool-call loop, and provider fallback are identical to a node's; only the entry
 * point and lifetime differ.
 *
 * **Scope (1.V).** This is the in-memory session DRIVER: the lifecycle (`start` / `sendMessage` /
 * `cancel`), the conversation accumulator, the session-wide cost total, the hard turn cap, and mapping a
 * classified {@link AgentTurnError} to a `session:turn_completed` error. It emits session events through
 * an **injected {@link SessionEventSink}** — wiring that sink onto the shared `RunEventBus` (per-session
 * `sequenceNumber` + gap/resync + a `SessionHandle`) is **1.W**; DB persistence + the durable
 * `SessionMessage` schema is **1.X**; resume is **1.Y**; the export serializer is **1.Z**. 1.V keeps the
 * transcript **in-memory** (`LlmMessage[]`, the in-flight content form) and persists nothing.
 *
 * The hard turn cap is the session's loud DoS fail-safe — distinct from `[chat].max_messages` (a
 * history-**trim** threshold that silently continues; later phases) and from the turn core's within-turn
 * `maxToolTurns` tool-loop guard. A `sendMessage` past the cap surfaces **loudly** with **no egress**:
 * `session:turn_completed` carrying `error.code: 'turn_limit'` — never a silent stop.
 */

import type {
  Agent,
  AbortSignalLike,
  AgentApprovalRequestedEvent,
  ErrorCode,
  SessionContext,
  SessionEvent,
  SessionStopReason,
  ToolPolicy,
} from '@relavium/shared';
import {
  ToolDefSchema,
  type FallbackPlanEntry,
  type LlmMessage,
  type LlmProvider,
  type ProviderId,
  type ToolDef as LlmToolDef,
} from '@relavium/llm';

import {
  ToolCancelledError,
  ToolDeniedByUserError,
  ToolDispatchError,
  ToolPolicyError,
} from '../tools/errors.js';
import type {
  ConfirmActionHook,
  ProcessResult,
  ToolCallPart,
  ToolDef,
  ToolDispatchContext,
  ToolId,
  ToolRegistry,
} from '../tools/types.js';
import {
  AgentTurnError,
  DEFAULT_AGENT_TURN_LIMITS,
  runAgentTurn,
  type AgentTurnLimits,
  type AgentTurnResult,
  type ChainCapabilities,
  type PreEgressHook,
} from './agent-turn.js';
import { BudgetPauseError } from './budget-governor.js';
import type { AbortControllerLike } from './execution-host.js';
import type { NodeStreamEvent } from './node-executor.js';
import type { SessionResumeState } from './session-resume.js';

/** The default hard turn cap when {@link SessionDeps.maxTurns} is omitted — a finite DoS fail-safe. */
export const DEFAULT_SESSION_MAX_TURNS = 50;

/** The auto-compaction trigger fraction when {@link SessionDeps.compactThreshold} is omitted (ADR-0062). */
export const DEFAULT_COMPACT_THRESHOLD = 0.8;

/**
 * The hard output cap on a compaction summary (ADR-0062) — passed as the summariser turn's `maxTokens` so the
 * preamble a compaction produces is BOUNDED (an unbounded summary could defeat compaction). It also anchors
 * the auto-compaction "projected floor" thrash guard: if `base system + kept exchange + this bound` would
 * still exceed the budget, compaction cannot help and is skipped.
 */
export const COMPACTION_MAX_SUMMARY_TOKENS = 4096;

/**
 * The context-compaction summariser system prompt (ADR-0062) — AUTHORED text, never untrusted data (the
 * conversation to summarise rides a user message, per the seam's system-is-authored rule). The invariant it
 * encodes is the product surface of `/compact`: a summary that loses these facts fails the feature. The
 * canonical description of what a summary preserves lives in chat-session.md §compaction; this is the prompt.
 */
export const COMPACTION_SYSTEM_PROMPT =
  'You are compacting a conversation to fit a smaller context window. Produce a concise, faithful summary ' +
  'of the conversation below that PRESERVES: open tasks and their current state; decisions taken and why; ' +
  'concrete code identifiers, file paths, commands, and values in play; and the user’s stated preferences ' +
  'and constraints. Omit pleasantries and redundant back-and-forth. Write it as notes for an assistant that ' +
  'will continue the conversation — not as a message to the user. Output ONLY the summary.';

/**
 * The classified result of a {@link AgentSession.compact} (ADR-0062) — a discriminated union so the host renders
 * each case explicitly. `compacted` carries the token deltas + the summary text (the host shows an inline
 * notice + an expandable summary); `nothing_to_compact` means there was ≤1 exchange to fold; `failed` is a
 * secret-free summarisation fault (the caller degrades to `/trim`); `cancelled` = an `Esc`/cancel mid-summary.
 */
export type CompactionResult =
  | {
      readonly kind: 'compacted';
      readonly reason: 'manual' | 'auto-threshold';
      readonly summary: string;
      readonly keptMessageCount: number;
      readonly tokensBefore: number;
      readonly tokensAfter: number;
      readonly summaryTokens: { readonly input: number; readonly output: number };
    }
  | { readonly kind: 'nothing_to_compact' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'cancelled' };

/**
 * The result of a {@link AgentSession.trimHistory} (ADR-0062) — a deterministic, no-LLM drop. `trimmed` carries
 * the kept/dropped counts; `nothing_to_trim` means the history was already within the bound.
 */
export type TrimResult =
  | {
      readonly kind: 'trimmed';
      readonly keptMessageCount: number;
      readonly droppedMessageCount: number;
    }
  | { readonly kind: 'nothing_to_trim'; readonly messageCount: number };

/** Distribute `Omit` across each union member so the discriminated union (and `.type` narrowing) survives. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A session lifecycle event body minus the envelope (`sessionId` / `timestamp` / `sequenceNumber`) the
 * transport stamps — the session counterpart of {@link NodeStreamEvent}. 1.V produces the body; 1.W's
 * bus wiring attaches the correlation key + the per-session monotonic sequence.
 */
export type SessionLifecycleEvent = DistributiveOmit<
  SessionEvent,
  'sessionId' | 'timestamp' | 'sequenceNumber'
>;

/**
 * The per-tool approval body (ADR-0057 EA5), envelope-less — a **session-carried** event the chat approval
 * regime emits through the sink. It is NOT a turn-core in-node event (so not in `NodeStreamEvent` / the run
 * path). The ENGINE emits it: the registry's `confirmDispatch` calls the dispatch context's
 * `emitApprovalRequested` port (which {@link AgentSession} wires to this sink, stamping the turn's `nodeId`)
 * for every governed dispatch, just before invoking the host's `ConfirmActionHook`.
 */
export type SessionApprovalStreamEvent = DistributiveOmit<
  AgentApprovalRequestedEvent,
  'runId' | 'sessionId' | 'timestamp' | 'sequenceNumber'
>;

/**
 * Everything a session emits, envelope-less: the `session:*` lifecycle/side bodies, the four dual-envelope
 * in-turn bodies the turn core produces (`agent:token` / `agent:tool_call` / `agent:tool_result` /
 * `cost:updated`), and the engine-emitted `agent:approval_requested` body (ADR-0057 EA5 — the registry's
 * `confirmDispatch` emits it via the dispatch context's `emitApprovalRequested`). The injected sink receives
 * these; 1.W routes them onto the bus.
 */
export type SessionStreamEvent =
  | SessionLifecycleEvent
  | NodeStreamEvent
  | SessionApprovalStreamEvent;

/** The injected emission port. 1.V emits through it; 1.W implements it over the shared `RunEventBus`. */
export type SessionEventSink = (event: SessionStreamEvent) => void;

/**
 * The **reseat-less mode** projection (ADR-0057) — the engine-side, **mode-agnostic** per-turn policy a host
 * sets on the SAME session instance (no reseat, no tool-context loss). The ask / plan / accept-edits / auto
 * **enum lives in the host** (`apps/cli`, [ADR-0055](../../../../docs/decisions/0055-cli-host-capability-seam-tool-environment-factory.md)):
 * the host maps its current mode to this policy and pushes it via {@link AgentSession.setTurnPolicy}; the
 * session **snapshots it at each turn start**, so a mid-turn change applies on the next turn. Setting a policy
 * **activates the interactive-approval regime** for governed tools (the dispatch context's `approval` is
 * present), so a write/process/egress dispatch requires a `confirm` decision — fail-closed if `confirm` is
 * absent (ADR-0057 EA3). Absent (the default) ⇒ today's behavior: all granted tools advertised, no approval
 * regime (the workflow author-trust floor).
 */
export interface SessionTurnPolicy {
  /**
   * Which of the agent's granted tools to **advertise** to the model this turn (the mode advertise-filter):
   * `true` keeps the tool in the model-visible set. A tool filtered OUT is never offered, but the `confirm`
   * floor remains authoritative if the model names it anyway (best-effort filter + fail-closed gate). Absent
   * ⇒ advertise every granted tool.
   */
  readonly advertise?: (toolId: ToolId) => boolean;
  /**
   * The host's interactive per-tool approval hook ([ConfirmActionHook]{@link ConfirmActionHook}) threaded into
   * the dispatch context's approval regime. Absent **while a policy is set** ⇒ fail-closed (a governed
   * dispatch is denied — a wiring bug can't let `ask` mode write). The host's hook owns the mode policy
   * (ask denies writes, accept-edits prompts, auto auto-approves), the once/always cache, and protected paths.
   */
  readonly confirm?: ConfirmActionHook;
}

/**
 * The session's injected dependencies — **platform capabilities only**, mirroring `AgentRunnerDeps`
 * (1.O). `resolveProvider` keeps an adapter from ever being imported by core; `keyFor` / `sleep` /
 * `now` / `onAuthError` forward into the per-turn `FallbackChain`; `preEgress` is the ADR-0028 budget
 * hook (no-op default; 1.AC supplies the estimator for both entry points through the same seam).
 */
export interface SessionDeps {
  /** Resolve an authored provider id to its concrete adapter instance; `undefined` ⇒ a host-wiring gap. */
  readonly resolveProvider: (providerId: ProviderId) => LlmProvider | undefined;
  /** The shared tool registry (1.T) the agent dispatches through (ADR-0037). */
  readonly registry: ToolRegistry;
  /** The registry's tool defs — the source of the LLM-visible schema for the agent's granted tools. */
  readonly tools: readonly ToolDef[];
  /** Host credential resolver — forwarded into the chain; never logged / stored / inspected by core. */
  readonly keyFor: ChainCapabilities['keyFor'];
  /** Host delay primitive (the engine has no ambient `setTimeout`). */
  readonly sleep: ChainCapabilities['sleep'];
  /** Optional injectable clock for the chain's cooldown bookkeeping. */
  readonly now?: ChainCapabilities['now'];
  /** Optional single out-of-band credential refresh (host-owned). */
  readonly onAuthError?: ChainCapabilities['onAuthError'];
  /** Create a fresh abort controller per turn — injected so core never names the ambient global. */
  readonly newAbortController: () => AbortControllerLike;
  /** The emission port — 1.V emits session/in-turn bodies here; 1.W wires it onto the `RunEventBus`. */
  readonly emit: SessionEventSink;
  /** The workflow-wide tool policy threaded into dispatch (default `{}` ⇒ deny-all for gated tools). */
  readonly toolPolicy?: ToolPolicy;
  /** Within-turn tool-loop bounds passed to the turn core (default {@link DEFAULT_AGENT_TURN_LIMITS}). */
  readonly limits?: AgentTurnLimits;
  /** The session hard turn cap (default {@link DEFAULT_SESSION_MAX_TURNS}); 0/absent ⇒ the default. */
  readonly maxTurns?: number;
  /** Pre-egress budget hook (default no-op; 1.AC fills it — ADR-0028). */
  readonly preEgress?: PreEgressHook;
  /**
   * Feed the running session cost to a budget governor so a host that wires {@link preEgress} to
   * `BudgetGovernor.checkPreEgress` also keeps the governor's cumulative total current (ADR-0028, 1.AC).
   * Called after each `cost:updated` with the session-wide cumulative; without it the governor would stay
   * pinned at 0 and only single-call estimates would trip the cap (so a tool-looping chat would not fail
   * safe). No-op by default; the host wires it to `governor.updateCost`.
   */
  readonly updateCost?: (cumulativeCostMicrocents: number) => void;
  /**
   * Automatic context compaction (ADR-0062) — the surface-mapped form of `[chat].auto_compact`. When not
   * `false` (absent ⇒ enabled), after a turn completes the session compacts if the turn's real input tokens
   * exceed {@link SessionDeps.compactThreshold} × the serving model's context window. The host wires this from
   * config; hardcoding it here would re-orphan the config field.
   */
  readonly autoCompact?: boolean;
  /** The auto-compaction trigger fraction (`[chat].compact_threshold`; absent ⇒ {@link DEFAULT_COMPACT_THRESHOLD}). */
  readonly compactThreshold?: number;
  /**
   * The history-trim bound (`[chat].max_messages`) the auto-compaction FAILURE path degrades to (ADR-0062): a
   * summarisation fault falls back to a deterministic, zero-cost `/trim` to `maxMessages`. Absent ⇒ no
   * fallback trim (the un-compacted turn proceeds; a genuine overflow surfaces via the error taxonomy).
   */
  readonly maxMessages?: number;
}

/** Construction params: a caller-minted `sessionId`, the bound agent + its `agentRef`, the context, deps. */
export interface AgentSessionParams {
  /** Process-unique id (the caller mints it via the host id source); carried on every session event. */
  readonly sessionId: string;
  /** The agent's authored id — recorded on `session:started` and used as the in-turn event `nodeId`. */
  readonly agentRef: string;
  /** The resolved agent config the session binds for its whole lifetime (no mid-session switching). */
  readonly agent: Agent;
  /** The workspace situation the session runs against (fs-scope tier, working dir, ctx variables). */
  readonly context: SessionContext;
  readonly deps: SessionDeps;
}

type SessionStatus = 'created' | 'idle' | 'running' | 'cancelled';

/** A typed, secret-free session API-misuse error (never a raw string throw — error-handling.md). */
export class SessionStateError extends Error {
  override readonly name = 'SessionStateError';
  constructor(
    readonly code: 'not_started' | 'already_started' | 'not_active',
    message: string,
  ) {
    super(message);
  }
}

type PlanResult =
  | { readonly ok: true; readonly entries: readonly FallbackPlanEntry[] }
  | { readonly ok: false; readonly message: string };

/**
 * The classified result of a `!`-shell {@link AgentSession.runUserCommand} (ADR-0061). A discriminated union so
 * the host renders each case explicitly and no raw error escapes:
 * - `ran` — the command executed; `stdout`/`stderr` are the process-arm–bounded output (the host applies a second
 *   injection bound + its own truncation marker before feeding them to the model as UNTRUSTED context — so this
 *   type does NOT carry a `truncated` flag, which would describe a different, model-facing bounding pass over data
 *   the caller never receives). `exitCode` may be non-zero (a normal command failure, still `ran`).
 * - `denied` — refused BEFORE any side effect: `allowlist: true` ⇒ the command is not in `[chat].allowed_commands`
 *   (the host shows the actionable opt-in hint); `false` ⇒ an interactive approval reject / protected-path denial.
 * - `failed` — a transient execution/wiring fault (a spawn error, a capability gap) — `message` is secret-free.
 * - `cancelled` — the session was cancelled/aborted mid-run.
 */
export type UserCommandOutcome =
  | {
      readonly kind: 'ran';
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: 'denied'; readonly allowlist: boolean; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'cancelled' };

/** Structural guard for the `run_command` dispatch result (a {@link ProcessResult}) — validates the FULL shape at
 *  the boundary via `in`-narrowing (no cast), so a future tool-shape drift is caught, not silently mis-read. */
function isProcessResult(value: unknown): value is ProcessResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'exitCode' in value &&
    typeof value.exitCode === 'number' &&
    'stdout' in value &&
    typeof value.stdout === 'string' &&
    'stderr' in value &&
    typeof value.stderr === 'string' &&
    'durationMs' in value &&
    typeof value.durationMs === 'number'
  );
}

/**
 * Drive a multi-turn agent conversation over the shared turn core. Construct with a caller-minted
 * `sessionId`, call {@link start} once, then {@link sendMessage} per user turn; {@link cancel} aborts an
 * in-flight turn. Events flow through the injected {@link SessionEventSink}.
 */
export class AgentSession {
  readonly sessionId: string;

  readonly #agentRef: string;
  readonly #agent: Agent;
  readonly #context: SessionContext;
  readonly #deps: SessionDeps;
  readonly #maxTurns: number;
  readonly #limits: AgentTurnLimits;

  /** The in-memory conversation (in-flight `ContentPart` form); the turn core copies it, never mutates it. */
  readonly #messages: LlmMessage[] = [];
  /**
   * Turns where a provider actually engaged — a success, or a failure whose {@link AgentTurnError.engaged} is
   * `true` (a non-skipped attempt ran). The hard cap counts ONLY these, so a pre-egress failure (no plan
   * entries, a budget refusal, a pre-flight cancel) never burns a turn the model never took.
   */
  #turnCount = 0;
  /** Session-wide running cost total, authoritatively stamped onto every `cost:updated`. */
  #cumulativeCostMicrocents = 0;
  #status: SessionStatus = 'created';
  /** The in-flight turn's controller, so {@link cancel} can abort it; `undefined` between turns. */
  #abort: AbortControllerLike | undefined;
  /**
   * The reseat-less mode policy (ADR-0057), mutated by {@link setTurnPolicy} and **snapshotted per turn**.
   * Present ⇒ the interactive-approval regime is active + the advertise-filter applies. `undefined` ⇒
   * today's behavior (all granted tools advertised, no approval regime).
   */
  #turnPolicy: SessionTurnPolicy | undefined;
  /**
   * Set by {@link abort} to mark the in-flight turn as **user-aborted** (EA7) — distinct from `cancel()`'s
   * terminal `'cancelled'` status. The `sendMessage` catch reads it to settle the turn as
   * `session:turn_completed{stopReason:'aborted'}` and keep the session alive (→ `idle`). Cleared each turn.
   */
  #abortingTurn = false;
  /** Monotonic counter for the synthetic `run_command` tool-call id of a `!`-shell dispatch ({@link runUserCommand}). */
  #userCommandSeq = 0;
  /** Memoized provider fallback plan (the agent binding is fixed for the session). */
  #plan: PlanResult | undefined;
  /**
   * The context-compaction preamble (ADR-0062) — the summary of the folded-away earlier conversation. When
   * present, {@link #runTurn} prepends it (XML-wrapped) to the agent's system prompt, so every subsequent turn
   * carries the compacted context. Set by {@link compact}, restored on {@link resume}, untouched by
   * {@link trimHistory} (a trim drops older turns without summarising — a prior compact's summary survives).
   */
  #contextPreamble: string | undefined;
  /**
   * Set on a CLEAN turn success to the settled turn's model + real input tokens, so `sendMessage` can run the
   * after-turn auto-compaction check (ADR-0062) AFTER the turn fully settles (status back to idle). Cleared
   * once consumed. Never set on an error/abort/cancel/cap path — those never auto-compact.
   */
  #autoCompactPending: { readonly model: string; readonly inputTokens: number } | undefined;

  constructor(params: AgentSessionParams) {
    this.sessionId = params.sessionId;
    this.#agentRef = params.agentRef;
    this.#agent = params.agent;
    this.#context = params.context;
    this.#deps = params.deps;
    const max = params.deps.maxTurns;
    this.#maxTurns = max === undefined || max <= 0 ? DEFAULT_SESSION_MAX_TURNS : max;
    this.#limits = params.deps.limits ?? DEFAULT_AGENT_TURN_LIMITS;
  }

  /**
   * Resume a session in a NEW process (1.Y) from its reconstructed state
   * ({@link reconstructSessionState}, built from the persisted transcript). Preloads the in-flight
   * transcript, the hard-cap turn count, and the running cost, then lands directly at `idle` **without**
   * emitting `session:started` — the session already started in the prior process; re-emitting it would
   * double a terminal-less lifecycle event. The next {@link sendMessage} continues the conversation. This
   * **replaces** {@link start}: the returned session is past `created`, so calling `start()` on it throws.
   */
  static resume(params: AgentSessionParams, state: SessionResumeState): AgentSession {
    const session = new AgentSession(params);
    session.#messages.push(...state.messages);
    session.#turnCount = state.turnCount;
    session.#cumulativeCostMicrocents = state.cumulativeCostMicrocents;
    // ADR-0062: restore the compaction preamble so a compacted session stays compacted across resume AND a
    // model reseat (which reuses this same reconstruct→resume path); without it, resume would silently
    // re-expand the folded history into the (possibly smaller-window) new model.
    session.#contextPreamble = state.contextPreamble;
    // Sync a host-wired budget governor with the carried-over spend so the FIRST resumed turn's pre-egress
    // check sees the real cumulative — not 0 — before any cost:updated fires (mirrors #onTurnEmit). Without
    // this, a resumed session's first turn could bypass a near-exhausted budget cap.
    session.#deps.updateCost?.(state.cumulativeCostMicrocents);
    session.#status = 'idle';
    return session;
  }

  /** Open the session: emit `session:started` and move to idle. Idempotent-guarded (one start per session). */
  start(): void {
    if (this.#status !== 'created') {
      throw new SessionStateError(
        'already_started',
        `session ${this.sessionId} is already started`,
      );
    }
    this.#status = 'idle';
    this.#deps.emit({
      type: 'session:started',
      agentRef: this.#agentRef,
      model: this.#agent.model,
      context: this.#context,
    });
  }

  /**
   * Set (or clear) the **reseat-less mode policy** (ADR-0057) — the advertise-filter + the interactive
   * approval hook — on this SAME session instance. The host calls it when its mode changes (e.g. `Shift+Tab`);
   * the change is **lossless** (no reseat, no tool-context loss) and applies on the **next** turn (each
   * `sendMessage` snapshots the policy at turn start). Pass `undefined` to clear it (back to advertise-all /
   * no-approval-regime). Callable in **any** state, including mid-turn (it takes effect next turn); it is
   * **inert once `cancelled`** (a cancelled session runs no further turn, so the policy is never read again).
   */
  setTurnPolicy(policy: SessionTurnPolicy | undefined): void {
    this.#turnPolicy = policy;
  }

  /** Guard the send preconditions: the session must be started and idle (not running/cancelled/ended). */
  #assertSendable(): void {
    if (this.#status === 'created') {
      throw new SessionStateError('not_started', `session ${this.sessionId}: call start() first`);
    }
    if (this.#status !== 'idle') {
      throw new SessionStateError(
        'not_active',
        `session ${this.sessionId} is ${this.#status}; cannot send a message`,
      );
    }
  }

  /**
   * Run one user turn end to end: append the user message, drive the turn core (streaming + tool loop +
   * fallback), append the assistant reply, and emit `session:turn_started` → `session:turn_completed`.
   * A turn past the hard cap is blocked **loudly** with `turn_limit` and **no egress**. A classified
   * turn failure still **completes** — with `stopReason: 'error'` and the mapped error code. Resolves
   * when the turn settles; a cancel mid-turn resolves quietly (the terminal is `session:cancelled`).
   */
  async sendMessage(text: string): Promise<void> {
    this.#assertSendable();

    // Clear any stale EA7 abort marker BEFORE arming the turn, so an `abort()` a prior turn's synchronous
    // turn_started-emit sink set (which then took a pre-`try` early return, bypassing the `finally` reset)
    // can never leak into this turn's catch path and misclassify a real failure as an abort.
    this.#abortingTurn = false;
    this.#status = 'running';
    // Arm the abort controller BEFORE the turn_started emit. A host whose sink calls abort() synchronously
    // inside that emit must abort THIS turn's real signal — if #abort were still undefined, abort()'s
    // `#abort?.abort()` would be a no-op while still setting #abortingTurn, and a later GENUINE failure would
    // then be misclassified as `aborted`. The cancel-bail + cap block release it on their early returns.
    const abort = this.#deps.newAbortController();
    this.#abort = abort;
    this.#deps.emit({ type: 'session:turn_started' });
    // A cancel can fire SYNCHRONOUSLY inside the turn_started emit (a host whose sink calls cancel()). If it
    // did, session:cancelled is the terminal — bail before the cap block and before any egress, else we would
    // overwrite the 'cancelled' status back to 'idle' and emit a second terminal, or silently egress an
    // already-cancelled turn. (cancel() already cleared #abort.)
    if (this.#statusIs('cancelled')) return;

    // Hard turn cap — checked AFTER turn_started (the turn was attempted) but BEFORE any egress: the
    // blocked turn completes loudly with turn_limit and never calls a provider.
    if (this.#completeIfTurnCapReached()) return;

    this.#messages.push({ role: 'user', content: [{ type: 'text', text }] });
    // Snapshot the reseat-less mode policy for the whole turn (ADR-0057): a mid-turn setTurnPolicy applies
    // only on the NEXT turn, so the advertise-filter + approval regime stay consistent within this turn.
    const turnPolicy = this.#turnPolicy;
    try {
      const result = await this.#runTurn(abort.signal, turnPolicy);
      // A cancel landed mid-turn — the cancel path owns the terminal session:cancelled; stay quiet, but
      // roll the user message back so a cancelled turn leaves no dangling user turn in the transcript
      // (the "only completed exchanges" invariant — matters for 1.X persistence / 1.Z export).
      if (this.#statusIs('cancelled')) {
        this.#messages.pop();
        return;
      }
      // EA7 note: an `abort()` that lands AFTER the turn fully resolved (a late `Esc`, past the turn core's
      // last `throwIfAborted`) is a no-op — the turn already produced its reply, so it completes NORMALLY
      // (the reply is kept, the turn is counted). `abort()` interrupts an IN-FLIGHT turn only; a turn the
      // model already finished is not discarded. This success path **never reads `#abortingTurn`** — that is
      // precisely what makes a late abort structurally invisible here; the `finally` still clears the marker.
      this.#turnCount += 1;
      // Append the assistant reply to the cross-turn transcript as TEXT-ONLY. The turn core keeps the
      // within-turn tool_use/tool_result pairs internal (they never leave runAgentTurn — it returns only the
      // final, non-tool_use content), so the transcript carries no orphaned tool_use and stays protocol-valid
      // across turns. Reasoning parts are dropped here on purpose: a reasoning `signature` is a within-turn,
      // same-provider replay token (ADR-0030/0039) and must NOT span turns — a turn that failed over would
      // otherwise carry a fallback-provider signature into the next turn's primary request. Faithful
      // cross-turn tool/reasoning history is the 1.X/1.Z deferral (it needs the turn core to expose the
      // intermediate messages, which the concurrent 1.AC work currently owns in agent-turn.ts).
      if (result.text.length > 0) {
        this.#messages.push({ role: 'assistant', content: [{ type: 'text', text: result.text }] });
      }
      this.#emitTurnCompleted(result.stopReason, {
        input: result.usage.input,
        output: result.usage.output,
        model: result.model,
      });
      // ADR-0062: arm the after-turn auto-compaction check for AFTER this turn fully settles (status back to
      // idle in the `finally`). Set ONLY on this clean-success path — never on an error/abort/cancel/cap exit
      // (those return before here or from the catch, so a failed turn never triggers compaction).
      this.#autoCompactPending = { model: result.model, inputTokens: result.usage.input };
    } catch (err) {
      // The turn did not complete — roll the user message back so the transcript holds only COMPLETED
      // exchanges (no dangling user turn or two consecutive user messages) on EVERY non-completing exit,
      // including a cancel-during-turn. Nothing is pushed after the user message on a throw (the assistant
      // append is past the `await`), so the last element is always that message. This also keeps a future
      // non-AgentTurnError the session does not yet handle — e.g. a 1.AC pre-egress `BudgetPauseError` — from
      // orphaning it.
      this.#messages.pop();
      if (this.#statusIs('cancelled')) return; // cancel-during-turn: session:cancelled is the terminal
      if (this.#abortingTurn) {
        // EA7 mid-turn abort: the turn core threw on the aborted signal (an AgentTurnError 'cancelled').
        // Settle as ONE `session:turn_completed{stopReason:'aborted'}` — NO error (user-initiated, not a
        // failure) — and keep the session alive; the `finally` returns #status to idle. Count the turn
        // against the hard cap only when a provider engaged + report its real EA2 usage (consistent with
        // #settleTurnError). It is NOT `cancel()`/`session:cancelled` (which is terminal).
        const aborted = err instanceof AgentTurnError ? err : undefined;
        if (aborted?.engaged === true) this.#turnCount += 1;
        this.#emitTurnCompleted('aborted', aborted?.usage ?? { input: 0, output: 0 });
        return;
      }
      this.#settleTurnError(err); // emits the terminal by error class; RE-THROWS an unclassified error
    } finally {
      this.#abort = undefined;
      this.#abortingTurn = false; // clear the per-turn EA7 marker (no stale abort leaks into the next turn)
      if (this.#statusIs('running')) this.#status = 'idle';
    }
    // ADR-0062: run the after-turn auto-compaction check AFTER the turn has fully settled (status is now idle).
    // Only the clean-success path armed `#autoCompactPending`; every non-completing exit returned earlier, so
    // this line is unreachable on an error/abort/cancel/cap turn. Runs within `sendMessage`, so the host's
    // "turn running" indicator naturally covers the summarisation moment and the caller awaits it.
    const pending = this.#autoCompactPending;
    this.#autoCompactPending = undefined;
    if (pending !== undefined) await this.#maybeAutoCompact(pending.model, pending.inputTokens);
  }

  /**
   * The hard turn-cap gate, factored out of {@link sendMessage}. When the session has already spent its
   * `#maxTurns`, complete the just-armed turn LOUDLY with `turn_limit` and no egress, release the armed abort
   * controller (this path is an early return that skips `sendMessage`'s `finally`), and return `true` so the
   * caller bails before touching a provider. Returns `false` (turn may proceed) when under the cap.
   */
  #completeIfTurnCapReached(): boolean {
    if (this.#turnCount < this.#maxTurns) return false;
    this.#status = 'idle';
    this.#abort = undefined; // no turn ran — release the armed controller (this early return skips finally)
    this.#emitTurnCompleted(
      'error',
      { input: 0, output: 0 },
      {
        code: 'turn_limit',
        message: `session reached its hard cap of ${this.#maxTurns} turns`,
        retryable: false,
      },
    );
    return true;
  }

  /**
   * Settle a turn that ended in a throw onto a terminal `session:turn_completed`, by error class. The caller has
   * already rolled the user message back and ruled out a cancel-during-turn.
   * - A classified {@link AgentTurnError} completes with its mapped code, counting the turn against the cap ONLY
   *   when a provider engaged (see {@link AgentTurnError.engaged}) and reporting its real EA2 usage.
   * - A pre-egress {@link BudgetPauseError} completes as `budget_exceeded` (it engaged no provider → uncounted).
   * - Any other (unclassified) error completes as `internal` and is **re-thrown** so the caller still sees the bug.
   */
  #settleTurnError(err: unknown): void {
    if (err instanceof AgentTurnError) {
      // Count the turn against the cap ONLY when a provider actually engaged (a non-skipped attempt ran — an
      // explicit signal the turn core attaches). A failure BEFORE any egress (no plan entries, a pre-egress
      // budget refusal, a pre-flight cancel) must not burn a turn the model never got to take; `engaged !== true`
      // (covering an undefined from an error that bypassed the wrapper) leaves the counter untouched.
      if (err.engaged === true) this.#turnCount += 1;
      // EA2 (ADR-0055): report the turn's REAL accumulated usage when a provider engaged (the turn core attaches
      // it), not a hardcoded zero — `?? {0,0}` covers a failure that never engaged a provider.
      this.#emitTurnCompleted('error', err.usage ?? { input: 0, output: 0 }, {
        code: err.code,
        message: err.message,
        retryable: err.retryable,
      });
      return;
    }
    if (err instanceof BudgetPauseError) {
      // A session has no pause/resume gate machinery in 1.V (full session pause/resume is a deferred 1.V×1.AC
      // item), so a pre-egress `pause_for_approval` settles the turn LOUDLY as `budget_exceeded` rather than
      // escaping `sendMessage` as a raw throw — which would leave the turn with no terminal, breaking the M1
      // event contract. It engaged NO provider (the pause is pre-egress), so it does NOT count.
      this.#emitTurnCompleted(
        'error',
        { input: 0, output: 0 },
        { code: 'budget_exceeded', message: err.message, retryable: false },
      );
      return;
    }
    // An unexpected (non-classified) error — settle the turn LOUDLY first so the stream stays balanced (every
    // session:turn_started gets a terminal), then re-raise so the caller still sees the bug.
    this.#emitTurnCompleted(
      'error',
      { input: 0, output: 0 },
      {
        code: 'internal',
        message: 'the session turn failed with an unexpected error',
        retryable: false,
      },
    );
    throw err;
  }

  /**
   * Read the current status WITHOUT control-flow narrowing — `#status` can change across an `await` in
   * {@link sendMessage} (a {@link cancel} fired from the emit sink), which TS cannot model after the literal
   * `this.#status = 'running'` assignment. Routing post-await reads through a call keeps them sound.
   */
  #statusIs(status: SessionStatus): boolean {
    return this.#status === status;
  }

  /** Abort an in-flight turn (if any) and end the session, emitting `session:cancelled`. Idempotent. */
  cancel(): void {
    if (this.#status === 'cancelled') return;
    this.#status = 'cancelled';
    this.#abort?.abort();
    this.#abort = undefined;
    this.#deps.emit({ type: 'session:cancelled' });
  }

  /**
   * **Mid-turn abort** (ADR-0057 EA7) — `Esc` ends the *in-flight turn* but **keeps the session alive**
   * (unlike {@link cancel}, which is terminal). It aborts the turn's signal; the turn core then throws on
   * the abort and the `sendMessage` catch settles the turn as **one** `session:turn_completed{stopReason:
   * 'aborted'}` (no `error` — it is user-initiated, not a failure), rolls the pending user message back, and
   * returns `#status` to `idle` so the next `sendMessage` continues the conversation. A **late** abort that
   * lands after the turn already RESOLVED is a no-op — that turn completes normally (its reply is kept), so
   * a just-finished reply is never discarded. No-op unless a turn is in flight (`running`); a `cancel()`
   * already in progress wins (terminal precedence). There is **no** new session status.
   */
  abort(): void {
    if (this.#status !== 'running') return; // nothing in flight (or already terminal) — nothing to abort
    this.#abortingTurn = true;
    this.#abort?.abort();
  }

  /**
   * Build the per-dispatch {@link ToolDispatchContext} (sans `signal`) shared by {@link #runTurn} and the
   * {@link runUserCommand} `!`-shell path ([ADR-0061](../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)):
   * the granted set, the session `toolPolicy` (the `allowedCommands` allowlist), the `fsScope`, `gateApproved:
   * false`, and — under a set mode policy (ADR-0057) — the interactive-approval regime (`confirm` + the EA5
   * `agent:approval_requested` emit). Factored so the `!`-shell reuses the SAME regime VERBATIM rather than a
   * dispatch context re-assembled in `apps/cli` (the one command boundary, never a fork).
   */
  #buildDispatchContext(
    grantedToolIds: ReadonlySet<ToolId>,
    turnPolicy: SessionTurnPolicy | undefined,
  ): Omit<ToolDispatchContext, 'signal'> {
    return {
      nodeId: this.#agentRef,
      grantedToolIds,
      config: {}, // an agent-invoked tool carries no per-tool config block in v1.0
      toolPolicy: this.#deps.toolPolicy ?? {},
      fsScope: this.#context.fsScopeTier,
      gateApproved: false, // a chat loop provides no human gate — git_commit stays denied (parity with 1.O)
      // ADR-0057: a set mode policy ACTIVATES the interactive-approval regime — a governed (write/process/
      // egress) dispatch then requires the host's `confirm` decision, fail-closed when `confirm` is absent
      // (`approval: {}`). No policy ⇒ no `approval` key ⇒ the workflow author-trust floor, unchanged.
      ...(turnPolicy === undefined
        ? {}
        : {
            // No confirm hook ⇒ `approval: {}` (the fail-closed floor — a governed dispatch is denied with
            // no_approval_hook, before any emit). WITH a hook, also wire EA5: the engine emits
            // `agent:approval_requested` (stamping this turn's nodeId) through the same session sink the in-turn
            // bodies use, just before the host's confirm hook prompts — a durable observability trace of the
            // pending decision on the session / `--json` stream (ADR-0057).
            approval:
              turnPolicy.confirm === undefined
                ? {}
                : {
                    confirm: turnPolicy.confirm,
                    emitApprovalRequested: (request) => {
                      this.#deps.emit({
                        type: 'agent:approval_requested',
                        nodeId: this.#agentRef,
                        toolId: request.toolId,
                        action: request.action,
                        preview: request.preview,
                      });
                    },
                  },
          }),
    };
  }

  /**
   * Run a USER-invoked `!`-shell command (2.5.D, [ADR-0061](../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md))
   * — the additive engine method that routes the shell escape through the ONE `run_command` boundary:
   * `enforcePolicy(allowedCommands)` (the exact-match allowlist, enforced BEFORE approval) → the mode-aware
   * `confirmAction` gate → the hardened process arm (`spawn`, `shell:false`). It reuses {@link #runTurn}'s
   * dispatch-context construction VERBATIM (`this.#turnPolicy`, the session `toolPolicy`, `fsScope`,
   * `gateApproved: false`), so the `!`-shell can never diverge from the audited command sandbox. The caller
   * pre-tokenizes the line into `command` + `args` (no shell metachar expansion). The classified result is a
   * discriminated union — the host renders the output (untrusted context), the actionable allowlist-deny hint, or
   * a failure — so no raw error escapes. Callable only when the session is started + idle (a `!` never races a turn).
   */
  async runUserCommand(command: string, args: readonly string[]): Promise<UserCommandOutcome> {
    this.#assertSendable(); // started + idle — a `!` never runs concurrently with a model turn
    this.#status = 'running';
    const abort = this.#deps.newAbortController();
    this.#abort = abort; // so cancel()/abort() can interrupt a long-running command
    this.#userCommandSeq += 1; // a fresh synthetic tool-call id per `!`-command
    const toolCall: ToolCallPart = {
      type: 'tool_call',
      id: `usercmd-${this.#userCommandSeq}`,
      name: 'run_command',
      args: { command, args: [...args] },
    };
    try {
      // The user-initiated `!` GRANTS `run_command` for THIS one-off dispatch (the user typed it — the grant is
      // implicit), regardless of whether the bound agent lists it in `tools`. This never reaches the model: it is a
      // direct dispatch, not a turn, so the model's granted/advertised set is untouched. The security gate stays the
      // allowlist (`enforcePolicy`, BEFORE approval) + the mode-aware `confirmAction`, never this grant.
      const grantedToolIds = new Set<ToolId>([...(this.#agent.tools ?? []), 'run_command']);
      const outcome = await this.#deps.registry.dispatch(toolCall, {
        ...this.#buildDispatchContext(grantedToolIds, this.#turnPolicy),
        signal: abort.signal,
      });
      const result = outcome.output;
      if (!isProcessResult(result)) {
        return { kind: 'failed', message: 'run_command returned an unexpected result shape' };
      }
      // Return the process-arm–bounded stdout/stderr (the identity `output`, no `outputMapping`). NOT
      // `outcome.truncated` — that flag comes from the SEPARATE model-facing `boundForModel` pass whose bounded
      // value is discarded here, so it would describe data the caller never receives. The host re-bounds on inject.
      return {
        kind: 'ran',
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (err) {
      if (err instanceof ToolCancelledError) return { kind: 'cancelled' };
      // An allowlist MISS is a policy denial with `command_not_allowed` — the host shows the actionable
      // `[chat].allowed_commands` hint; any other `tool_denied` (an approval reject / protected path) is a plain
      // decline. Both messages are secret-free (the error classes never echo the resolved command value).
      if (err instanceof ToolPolicyError) {
        return {
          kind: 'denied',
          allowlist: err.reason === 'command_not_allowed',
          message: err.message,
        };
      }
      if (err instanceof ToolDeniedByUserError) {
        return { kind: 'denied', allowlist: false, message: err.message };
      }
      if (err instanceof ToolDispatchError) return { kind: 'failed', message: err.message };
      throw err; // an unexpected non-tool error (a wiring bug) — surface loudly, never swallow
    } finally {
      this.#abort = undefined;
      this.#abortingTurn = false; // an Esc-abort during the command set this marker — clear it (mirrors sendMessage)
      if (this.#status === 'running') this.#status = 'idle'; // a cancel() may have set 'cancelled' — don't revert it
    }
  }

  /**
   * The per-turn system prompt: the agent's authored `system_prompt`, plus — when the session has been
   * compacted (ADR-0062) — the compaction preamble, XML-wrapped for structured attention. The preamble is
   * re-derived every turn (the system prompt is rebuilt per `sendMessage`), so setting `#contextPreamble` is
   * reseat-free and applies from the next turn without a new instance.
   */
  #systemPrompt(): string {
    const base = this.#agent.system_prompt;
    if (this.#contextPreamble === undefined) return base;
    return `${base}\n\n<earlier-conversation-summary>\n${this.#contextPreamble}\n</earlier-conversation-summary>`;
  }

  /**
   * **Compact the working context** (ADR-0062, `/compact` + the auto-threshold path) — summarise the earlier
   * conversation into the {@link #contextPreamble} via the session's OWN bound model, keep the last complete
   * `user`+`assistant` exchange verbatim, and emit `session:compacted`. Append-only at the durable layer: the
   * host writes a boundary marker on the event; the engine mutates only in-memory state. Callable only when
   * started + idle. Aborting mid-summary (`cancel`/`abort`) yields `cancelled` and leaves the context
   * unchanged. The summarisation's cost is accounted via `cost:updated` (the session budget), but its
   * `agent:token`/tool events are NOT forwarded — the summary is internal context, never a transcript reply.
   */
  async compact(reason: 'manual' | 'auto-threshold' = 'manual'): Promise<CompactionResult> {
    this.#assertSendable();
    const split = splitFoldable(this.#messages);
    if (split === undefined) return { kind: 'nothing_to_compact' }; // ≤1 exchange — nothing to fold
    const plan = this.#resolvePlan();
    if (!plan.ok) return { kind: 'failed', message: plan.message };

    this.#status = 'running';
    const abort = this.#deps.newAbortController();
    this.#abort = abort;
    try {
      // Announce the compaction MOMENT (ADR-0062 §7) — emitted AFTER the nothing-to-fold / plan-resolution guards
      // (so a no-op never flashes the indicator) so the host can drive a labeled "Summarizing…" indicator while the
      // summariser LLM call runs, for both a manual `/compact` and an auto-threshold trigger. The terminal
      // `session:compacted` (success) / `session:trimmed` auto-fallback (failure→trim) ends the moment; a manual
      // failure emits no terminal, so the manual host clears the moment when `compact()` resolves. Inside the `try`
      // (like the estimate below) so nothing escapes past the `finally` that resets `#status`.
      this.#deps.emit({ type: 'session:compacting', reason });
      // Inside the `try` so a provider whose optional `estimateTokens` throws cannot escape past the `finally`
      // and leave `#status` wedged at 'running' (the seam method is provider-supplied).
      const tokensBefore = this.#estimateContextTokens();
      const result = await runAgentTurn({
        system: COMPACTION_SYSTEM_PROMPT,
        messages: [renderConversationToSummarise(this.#contextPreamble, split.foldable)],
        planEntries: plan.entries,
        chainCapabilities: this.#chainCapabilities(),
        nodeId: this.#agentRef,
        maxTokens: COMPACTION_MAX_SUMMARY_TOKENS, // bound the summary so compaction reliably reduces context
        // Forward ONLY cost:updated (budget accounting, ADR-0028) — drop agent:token/tool events so the
        // internal summary never streams into the chat transcript as a reply.
        emit: (event) => {
          if (event.type === 'cost:updated') this.#onTurnEmit(event);
        },
        signal: abort.signal,
        registry: this.#deps.registry,
        dispatchContext: this.#buildDispatchContext(new Set(), undefined),
        limits: this.#limits,
        ...(this.#deps.preEgress === undefined ? {} : { preEgress: this.#deps.preEgress }),
      });
      const summary = result.text.trim();
      if (summary.length === 0) {
        // The model returned no summary text — treat as a failure (the caller degrades to /trim) rather than
        // installing an empty preamble that would silently lose the folded context.
        return { kind: 'failed', message: 'the summarisation produced no summary text' };
      }
      this.#contextPreamble = summary;
      this.#messages.length = 0;
      this.#messages.push(...split.kept);
      const tokensAfter = this.#estimateContextTokens();
      this.#deps.emit({
        type: 'session:compacted',
        reason,
        summary,
        keptMessageCount: split.kept.length,
        tokensBefore,
        tokensAfter,
        tokensUsed: { input: result.usage.input, output: result.usage.output },
      });
      return {
        kind: 'compacted',
        reason,
        summary,
        keptMessageCount: split.kept.length,
        tokensBefore,
        tokensAfter,
        summaryTokens: { input: result.usage.input, output: result.usage.output },
      };
    } catch (err) {
      return this.#classifyCompactionError(err); // may re-throw an unclassified error (surfaced loudly)
    } finally {
      this.#abort = undefined;
      this.#abortingTurn = false;
      if (this.#statusIs('running')) this.#status = 'idle';
    }
  }

  /**
   * Map a caught {@link compact} error to a {@link CompactionResult} (factored out to keep `compact` focused on
   * the happy path, mirroring {@link #settleTurnError}). A cancel/abort (terminal `cancel()`, `ToolCancelledError`,
   * an EA7 `Esc`, or a classified `cancelled`) ⇒ `cancelled`; a classified {@link AgentTurnError} or a pre-egress
   * {@link BudgetPauseError} ⇒ `failed` (the caller degrades to `/trim`); a truly UNCLASSIFIED error is a bug and
   * is RE-THROWN so it surfaces loudly (never silently masked as an ordinary `failed`).
   */
  #classifyCompactionError(err: unknown): CompactionResult {
    if (this.#statusIs('cancelled') || err instanceof ToolCancelledError || this.#abortingTurn) {
      return { kind: 'cancelled' };
    }
    if (err instanceof AgentTurnError) {
      return err.code === 'cancelled'
        ? { kind: 'cancelled' }
        : { kind: 'failed', message: err.message };
    }
    if (err instanceof BudgetPauseError) return { kind: 'failed', message: err.message };
    throw err;
  }

  /**
   * **Deterministically trim history** to the last `maxMessages` messages (ADR-0062, `/trim`) — NO LLM call,
   * no cost. The kept slice is snapped to start on a `user` message (an orphan leading `assistant` is dropped)
   * so the next turn stays protocol-valid. Leaves {@link #contextPreamble} untouched (a trim drops older turns
   * without summarising — a prior `/compact` summary survives). Emits `session:trimmed`; the host writes a
   * summary-less boundary marker. Callable only when started + idle.
   */
  trimHistory(maxMessages: number, reason: 'manual' | 'auto-fallback' = 'manual'): TrimResult {
    this.#assertSendable();
    const kept = tailFromUserBoundary(this.#messages, maxMessages);
    const dropped = this.#messages.length - kept.length;
    if (dropped <= 0) return { kind: 'nothing_to_trim', messageCount: this.#messages.length };
    this.#messages.length = 0;
    this.#messages.push(...kept);
    this.#deps.emit({
      type: 'session:trimmed',
      reason, // `auto-fallback` when the auto-compaction summariser failed → the view surfaces it (never silent)
      keptMessageCount: kept.length,
      droppedMessageCount: dropped,
    });
    return { kind: 'trimmed', keptMessageCount: kept.length, droppedMessageCount: dropped };
  }

  /**
   * The after-turn auto-compaction gate (ADR-0062) — run from {@link sendMessage} AFTER a clean turn settles.
   * Compacts when: auto-compaction is enabled; the SERVING model's context window is known; the turn's real
   * input tokens exceed `threshold × window`; and there is more than one exchange to fold. Skips a provider
   * that manages its own context. On a summarisation failure it degrades to a deterministic `/trim` to
   * `maxMessages` (zero cost) rather than sending an ever-growing context. A no-op on every skip condition.
   */
  async #maybeAutoCompact(model: string, inputTokens: number): Promise<void> {
    if (this.#deps.autoCompact === false) return;
    if (this.#status !== 'idle') return; // a cancel/abort landed after the turn — do not compact
    const plan = this.#resolvePlan();
    if (!plan.ok) return;
    // Consult the SERVING provider (the plan entry whose model actually produced this turn under fallback), not
    // just the primary — so managesOwnContext / contextLimit reflect the model that would overflow NEXT. Both are
    // OPTIONAL, provider-supplied seam methods; a throw from either must be a non-fatal SKIP (auto-compaction is
    // best-effort) — never escape and reject `sendMessage` after the turn already completed (mirrors #estimateTokens).
    let window: number | undefined;
    try {
      const serving =
        plan.entries.find((entry) => entry.model === model)?.provider ?? plan.entries[0]?.provider;
      if (serving?.managesOwnContext?.() === true) return; // the provider bounds context itself
      window = serving?.contextLimit?.(model);
    } catch {
      return; // a throwing provider seam method → skip auto-compaction, don't crash the settled turn
    }
    if (window === undefined || window <= 0) return; // unrated/custom model — window unknown, skip auto-compaction
    const budget = window * (this.#deps.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD);
    if (inputTokens <= budget) return; // under the trigger — nothing to do
    const split = splitFoldable(this.#messages);
    if (split === undefined) return; // ≤1 exchange — nothing earlier to fold (thrash guard a)
    // ADR §5 thrash guard b: estimate the PROJECTED post-compaction floor — the BASE system prompt (NOT the
    // current preamble, which the new summary REPLACES) + the kept exchange + the bounded summary the
    // compaction will produce (`COMPACTION_MAX_SUMMARY_TOKENS`). If even that floor exceeds the budget,
    // compaction cannot help (a single oversized turn / a huge system prompt) — skip and let the overflow
    // surface via the error taxonomy, rather than paying a summariser call on every subsequent turn.
    const projectedFloor =
      this.#estimateTokens(this.#agent.system_prompt, split.kept) + COMPACTION_MAX_SUMMARY_TOKENS;
    if (projectedFloor > budget) return;

    let result: CompactionResult;
    try {
      result = await this.compact('auto-threshold');
    } catch {
      // `compact()` RE-THROWS an UNCLASSIFIED error (a bug) rather than returning `{kind:'failed'}`. Auto-compaction
      // is BEST-EFFORT and runs AFTER the turn already completed (session:turn_completed emitted), so such a throw
      // must NOT reject an otherwise-successful `sendMessage` — mirror the seam-method guard above. Treat it as a
      // failure so the deterministic /trim fallback below still bounds the next turn (ADR §5).
      result = { kind: 'failed', message: 'auto-compaction summariser threw' };
    }
    // Degrade a non-success — a `failed` summariser OR an EA7-aborted `cancelled` — to a deterministic, zero-cost
    // /trim so the next turn is bounded (never a silent overflowing resend, ADR §5). A terminal `cancel()` leaves
    // status !== 'idle', so this guard skips a dead session; a `compacted`/`nothing_to_compact` needs no fallback.
    if (
      (result.kind === 'failed' || result.kind === 'cancelled') &&
      this.#deps.maxMessages !== undefined &&
      this.#status === 'idle'
    ) {
      this.trimHistory(this.#deps.maxMessages, 'auto-fallback');
    }
  }

  /** A rough token estimate of the current working context (system-with-preamble + messages) — for the
   *  before/after deltas on `session:compacted`. Best-effort; 0 if absent. */
  #estimateContextTokens(): number {
    return this.#estimateTokens(this.#systemPrompt(), this.#messages);
  }

  /**
   * Estimate the tokens of `system + messages` via the primary provider's optional seam estimator
   * (provider-agnostic in practice). Best-effort and **never throws** — a provider-supplied `estimateTokens`
   * that throws is swallowed to 0, so an estimate can never wedge `#status`, escape `compact()`'s `finally`,
   * or crash the auto-compaction gate (the value only drives an observability delta / a thrash heuristic).
   */
  #estimateTokens(system: string, messages: readonly LlmMessage[]): number {
    const plan = this.#resolvePlan();
    if (!plan.ok) return 0;
    try {
      // Call inline (not via an extracted method reference) so `estimateTokens` stays bound to its provider.
      return plan.entries[0]?.provider.estimateTokens?.({ system, messages }) ?? 0;
    } catch {
      return 0; // a best-effort estimate — never let a throwing seam estimator break compaction
    }
  }

  /** Build (memoized) the fallback plan and drive one turn through the shared core. */
  async #runTurn(
    signal: AbortSignalLike,
    turnPolicy: SessionTurnPolicy | undefined,
  ): Promise<AgentTurnResult> {
    const plan = this.#resolvePlan();
    if (!plan.ok) {
      // A host-wiring gap (a provider was not resolved) — a classified, non-retryable internal failure.
      throw new AgentTurnError('internal', plan.message, false);
    }
    const grantedToolIds = new Set(this.#agent.tools ?? []);
    const dispatchContext = this.#buildDispatchContext(grantedToolIds, turnPolicy);
    // Advertise-filter (ADR-0057): narrow the model-visible tool set per the host's mode (best-effort; the
    // confirm floor stays authoritative). No policy / no filter ⇒ advertise every granted tool.
    const llmTools = buildLlmTools(this.#deps.tools, grantedToolIds, turnPolicy?.advertise);
    return runAgentTurn({
      system: this.#systemPrompt(),
      messages: this.#messages,
      ...(llmTools.length > 0 ? { tools: llmTools } : {}),
      planEntries: plan.entries,
      chainCapabilities: this.#chainCapabilities(),
      ...(this.#agent.temperature === undefined ? {} : { temperature: this.#agent.temperature }),
      ...(this.#agent.max_tokens === undefined ? {} : { maxTokens: this.#agent.max_tokens }),
      nodeId: this.#agentRef,
      emit: (event) => {
        this.#onTurnEmit(event);
      },
      signal,
      registry: this.#deps.registry,
      dispatchContext,
      limits: this.#limits,
      ...(this.#deps.preEgress === undefined ? {} : { preEgress: this.#deps.preEgress }),
    });
  }

  /**
   * Forward an in-turn streaming body, stamping the session-wide running total onto `cost:updated`.
   * `cost:updated.costMicrocents` is the **per-attempt increment** the turn core emits (one event per
   * non-skipped attempt, agent-turn.ts), with a `0` cumulative placeholder; summing the increments is the
   * correct running total and mirrors how the `WorkflowEngine` owns it for a run (engine.ts `#nodeEmit`:
   * `#cumulativeCostMicrocents += event.costMicrocents`). It is robust to multiple cost events per turn
   * (e.g. a fallback or a tool round-trip), so it does not depend on exactly one event per turn.
   */
  #onTurnEmit(event: NodeStreamEvent): void {
    if (event.type === 'cost:updated') {
      this.#cumulativeCostMicrocents += event.costMicrocents;
      // Keep a host-wired budget governor's running total current so its pre-egress check sees the real
      // session spend (ADR-0028) — without this the governor would stay at 0 and a tool-looping chat would
      // not fail safe.
      this.#deps.updateCost?.(this.#cumulativeCostMicrocents);
      this.#deps.emit({ ...event, cumulativeCostMicrocents: this.#cumulativeCostMicrocents });
      return;
    }
    this.#deps.emit(event);
  }

  #emitTurnCompleted(
    stopReason: SessionStopReason,
    tokensUsed: { input: number; output: number; model?: string },
    error?: { code: ErrorCode; message: string; retryable: boolean },
  ): void {
    this.#deps.emit({
      type: 'session:turn_completed',
      stopReason,
      tokensUsed,
      ...(error === undefined ? {} : { error }),
    });
  }

  /**
   * Build the ordered fallback plan once: primary (maxAttempts 1, ADR-0040) + each authored fallback.
   * Memoized — including a FAILED resolution. A failure here means a provider the agent names was never
   * wired by the host (a construction-time wiring gap, fixed configuration for the session's lifetime), so
   * retrying per turn cannot change the outcome; caching it makes every `sendMessage` fail fast and
   * identically rather than re-walking the chain each turn.
   */
  #resolvePlan(): PlanResult {
    if (this.#plan !== undefined) return this.#plan;
    const agent = this.#agent;
    const primary = this.#deps.resolveProvider(agent.provider);
    if (primary === undefined) {
      this.#plan = { ok: false, message: `no provider wired for '${agent.provider}'` };
      return this.#plan;
    }
    // The primary entry does NOT consume a node/agent retry budget — ADR-0040 makes node retry the
    // engine's ABOVE-chain budget (a session has no such loop in 1.V); the primary is a single attempt.
    const entries: FallbackPlanEntry[] = [
      { provider: primary, model: agent.model, maxAttempts: 1 },
    ];
    for (const entry of agent.fallback_chain ?? []) {
      const provider = this.#deps.resolveProvider(entry.provider);
      if (provider === undefined) {
        this.#plan = { ok: false, message: `no provider wired for fallback '${entry.provider}'` };
        return this.#plan;
      }
      entries.push({ provider, model: entry.model, maxAttempts: entry.max_attempts });
    }
    this.#plan = { ok: true, entries };
    return this.#plan;
  }

  /** Forward only the platform-level chain capabilities the host supplies (mirrors the 1.O runner). */
  #chainCapabilities(): ChainCapabilities {
    const deps = this.#deps;
    return {
      keyFor: deps.keyFor,
      sleep: deps.sleep,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.onAuthError === undefined ? {} : { onAuthError: deps.onAuthError }),
    };
  }
}

/**
 * Split the working transcript (ADR-0062) into the earlier part to FOLD into the summary and the last COMPLETE
 * `user`+`assistant` exchange to KEEP verbatim. The kept slice starts at the last `user` that is FOLLOWED by an
 * `assistant` reply — so a trailing dangling `user` (a completed-but-empty-text turn leaves one; `sendMessage`
 * only appends the assistant when `result.text` is non-empty) is never kept as a protocol-breaking LONE user;
 * it rides along at the tail of a complete exchange. `undefined` when there is no earlier turn to fold before
 * the last complete exchange (≤1 exchange — the `nothing_to_compact` / thrash-guard case).
 */
function splitFoldable(
  messages: readonly LlmMessage[],
): { readonly foldable: LlmMessage[]; readonly kept: LlmMessage[] } | undefined {
  // O(N): the kept exchange starts at the last `user` that PRECEDES the last `assistant` (any such user has an
  // assistant reply after it); a trailing dangling `user` rides along in the kept slice, never as a lone user.
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }
  let keptStart = -1;
  for (let i = lastAssistant - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      keptStart = i;
      break;
    }
  }
  if (keptStart <= 0) return undefined; // no earlier turn precedes the last complete exchange
  return { foldable: messages.slice(0, keptStart), kept: messages.slice(keptStart) };
}

/** The concatenated text of a cross-turn message (the transcript is text-only; a non-text part is skipped). */
function messageText(message: LlmMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/**
 * Render the earlier conversation (an optional prior summary preamble + the foldable turns) as ONE `user`
 * message for the summariser (ADR-0062). Untrusted conversation data rides the USER role — never the authored
 * system prompt (the seam's system-is-authored rule). Including the prior preamble is what makes re-compaction
 * fold summary-of-summary (the disclosed, accepted degradation).
 */
function renderConversationToSummarise(
  preamble: string | undefined,
  foldable: readonly LlmMessage[],
): LlmMessage {
  const parts: string[] = [];
  if (preamble !== undefined) {
    parts.push(
      `Summary of the conversation so far:\n${preamble}`,
      'The conversation then continued:',
    );
  }
  for (const message of foldable) {
    const text = messageText(message);
    if (text.length === 0) continue;
    parts.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  return { role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] };
}

/**
 * The last `maxKeep` messages, snapped to start on a `user` message so the trimmed transcript stays
 * protocol-valid (an orphan leading `assistant` — from slicing mid-exchange — is dropped; ADR-0062). It never
 * returns an EMPTY slice when there was history to keep: `maxKeep = 1` on a transcript ending in `assistant`
 * would forward-snap to empty (WIPING the whole transcript) — instead it floors at the last complete exchange
 * (the last `user` onward), so `/trim` keeps at least that exchange rather than silently erasing everything.
 */
function tailFromUserBoundary(messages: readonly LlmMessage[], maxKeep: number): LlmMessage[] {
  if (maxKeep <= 0 || messages.length === 0) return [];
  const windowStart = Math.max(0, messages.length - maxKeep);
  // Forward-snap: the first `user` at/after the window start (drops an orphan leading `assistant`). O(N).
  for (let i = windowStart; i < messages.length; i += 1) {
    if (messages[i]?.role === 'user') return messages.slice(i);
  }
  // The window held no `user` (all trailing assistants) — floor at the LAST `user` so a `/trim` never wipes the
  // transcript (the maxKeep=1-on-a-trailing-assistant case); an empty return only when there is no user at all.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return messages.slice(i);
  }
  return [];
}

/**
 * The agent's granted tools as LLM-visible defs, validated through the seam schema (no unsafe cast).
 * `advertise` is the optional mode advertise-filter (ADR-0057): a granted tool it rejects is **not** offered
 * to the model this turn (the `confirm` floor stays authoritative if the model names it anyway). Absent ⇒
 * every granted tool is advertised.
 */
function buildLlmTools(
  defs: readonly ToolDef[],
  granted: ReadonlySet<string>,
  advertise?: (toolId: string) => boolean,
): LlmToolDef[] {
  const out: LlmToolDef[] = [];
  for (const def of defs) {
    if (!granted.has(def.id)) continue;
    if (advertise !== undefined && !advertise(def.id)) continue; // mode advertise-filter (ADR-0057)
    const parsed = ToolDefSchema.safeParse({
      name: def.id,
      ...(def.description.length > 0 ? { description: def.description } : {}),
      parameters: def.llmVisibleParams,
    });
    if (!parsed.success) {
      // A registered tool carries an invalid LLM-visible schema — a host-wiring bug, not a model failure.
      // Classify it (rather than let a raw ZodError escape the turn) so it surfaces as a session error turn.
      throw new AgentTurnError(
        'internal',
        `granted tool '${def.id}' has an invalid LLM schema`,
        false,
      );
    }
    out.push(parsed.data);
  }
  return out;
}
