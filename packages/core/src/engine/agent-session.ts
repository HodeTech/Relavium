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
 * Everything a session emits, envelope-less: the five `session:*` lifecycle bodies, the four dual-envelope
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
 * - `ran` — the command executed; `stdout`/`stderr` are process-arm bounded (the host applies a second injection
 *   bound before feeding them to the model as UNTRUSTED context). `exitCode` may be non-zero (a normal command
 *   failure, still `ran`).
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
      readonly truncated: boolean;
    }
  | { readonly kind: 'denied'; readonly allowlist: boolean; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'cancelled' };

/** Structural guard for the `run_command` dispatch result (a {@link ProcessResult}) — validates at the boundary
 *  rather than an unsafe cast, so a future tool-shape drift is caught, not silently mis-read. */
function isProcessResult(value: unknown): value is ProcessResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['exitCode'] === 'number' &&
    typeof v['stdout'] === 'string' &&
    typeof v['stderr'] === 'string'
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
    const toolCall: ToolCallPart = {
      type: 'tool_call',
      id: `usercmd-${(this.#userCommandSeq += 1)}`,
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
      return {
        kind: 'ran',
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: outcome.truncated,
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
      if (this.#status === 'running') this.#status = 'idle'; // a cancel() may have set 'cancelled' — don't revert it
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
      system: this.#agent.system_prompt,
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
