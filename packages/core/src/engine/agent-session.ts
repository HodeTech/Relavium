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
  ErrorCode,
  SessionContext,
  SessionEvent,
  StopReason,
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

import type { ToolDef, ToolDispatchContext, ToolRegistry } from '../tools/types.js';
import {
  AgentTurnError,
  DEFAULT_AGENT_TURN_LIMITS,
  runAgentTurn,
  type AgentTurnLimits,
  type AgentTurnResult,
  type ChainCapabilities,
  type PreEgressHook,
} from './agent-turn.js';
import type { AbortControllerLike } from './execution-host.js';
import type { NodeStreamEvent } from './node-executor.js';

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
 * Everything a session emits, envelope-less: the five `session:*` lifecycle bodies plus the four
 * dual-envelope in-turn bodies the turn core produces (`agent:token` / `agent:tool_call` /
 * `agent:tool_result` / `cost:updated`). The injected sink receives these; 1.W routes them onto the bus.
 */
export type SessionStreamEvent = SessionLifecycleEvent | NodeStreamEvent;

/** The injected emission port. 1.V emits through it; 1.W implements it over the shared `RunEventBus`. */
export type SessionEventSink = (event: SessionStreamEvent) => void;

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
  /** Turns that engaged the provider (success or failure) — the hard cap counts these. */
  #turnCount = 0;
  /** Session-wide running cost total, authoritatively stamped onto every `cost:updated`. */
  #cumulativeCostMicrocents = 0;
  #status: SessionStatus = 'created';
  /** The in-flight turn's controller, so {@link cancel} can abort it; `undefined` between turns. */
  #abort: AbortControllerLike | undefined;
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
   * Run one user turn end to end: append the user message, drive the turn core (streaming + tool loop +
   * fallback), append the assistant reply, and emit `session:turn_started` → `session:turn_completed`.
   * A turn past the hard cap is blocked **loudly** with `turn_limit` and **no egress**. A classified
   * turn failure still **completes** — with `stopReason: 'error'` and the mapped error code. Resolves
   * when the turn settles; a cancel mid-turn resolves quietly (the terminal is `session:cancelled`).
   */
  async sendMessage(text: string): Promise<void> {
    if (this.#status === 'created') {
      throw new SessionStateError('not_started', `session ${this.sessionId}: call start() first`);
    }
    if (this.#status !== 'idle') {
      throw new SessionStateError(
        'not_active',
        `session ${this.sessionId} is ${this.#status}; cannot send a message`,
      );
    }

    this.#status = 'running';
    this.#deps.emit({ type: 'session:turn_started' });

    // Hard turn cap — checked AFTER turn_started (the turn was attempted) but BEFORE any egress: the
    // blocked turn completes loudly with turn_limit and never calls a provider.
    if (this.#turnCount >= this.#maxTurns) {
      this.#status = 'idle';
      this.#emitTurnCompleted(
        'error',
        { input: 0, output: 0 },
        {
          code: 'turn_limit',
          message: `session reached its hard cap of ${this.#maxTurns} turns`,
          retryable: false,
        },
      );
      return;
    }

    this.#messages.push({ role: 'user', content: [{ type: 'text', text }] });
    const abort = this.#deps.newAbortController();
    this.#abort = abort;
    try {
      const result = await this.#runTurn(abort.signal);
      // A cancel landed mid-turn — the cancel path owns the terminal session:cancelled; stay quiet.
      if (this.#statusIs('cancelled')) return;
      this.#turnCount += 1;
      this.#messages.push({ role: 'assistant', content: [...result.content] });
      this.#emitTurnCompleted(result.stopReason, {
        input: result.usage.input,
        output: result.usage.output,
        model: result.model,
      });
    } catch (err) {
      if (this.#statusIs('cancelled')) return; // cancel-during-turn: session:cancelled is the terminal
      if (err instanceof AgentTurnError) {
        this.#turnCount += 1; // the turn engaged a provider — it counts toward the cap
        this.#emitTurnCompleted(
          'error',
          { input: 0, output: 0 },
          {
            code: err.code,
            message: err.message,
            retryable: err.retryable,
          },
        );
      } else {
        throw err; // unexpected — let it surface; the session is left in a running state for the caller
      }
    } finally {
      this.#abort = undefined;
      if (this.#statusIs('running')) this.#status = 'idle';
    }
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

  /** Build (memoized) the fallback plan and drive one turn through the shared core. */
  async #runTurn(signal: AbortSignalLike): Promise<AgentTurnResult> {
    const plan = this.#resolvePlan();
    if (!plan.ok) {
      // A host-wiring gap (a provider was not resolved) — a classified, non-retryable internal failure.
      throw new AgentTurnError('internal', plan.message, false);
    }
    const grantedToolIds = new Set(this.#agent.tools ?? []);
    const dispatchContext: Omit<ToolDispatchContext, 'signal'> = {
      nodeId: this.#agentRef,
      grantedToolIds,
      config: {}, // an agent-invoked tool carries no per-tool config block in v1.0
      toolPolicy: this.#deps.toolPolicy ?? {},
      fsScope: this.#context.fsScopeTier,
      gateApproved: false, // a chat loop provides no human gate — git_commit stays denied (parity with 1.O)
    };
    const llmTools = buildLlmTools(this.#deps.tools, grantedToolIds);
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

  /** Forward an in-turn streaming body, stamping the session-wide running total onto `cost:updated`. */
  #onTurnEmit(event: NodeStreamEvent): void {
    if (event.type === 'cost:updated') {
      this.#cumulativeCostMicrocents += event.costMicrocents;
      this.#deps.emit({ ...event, cumulativeCostMicrocents: this.#cumulativeCostMicrocents });
      return;
    }
    this.#deps.emit(event);
  }

  #emitTurnCompleted(
    stopReason: StopReason,
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

  /** Build the ordered fallback plan once: primary (maxAttempts 1, ADR-0040) + each authored fallback. */
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

/** The agent's granted tools as LLM-visible defs, validated through the seam schema (no unsafe cast). */
function buildLlmTools(defs: readonly ToolDef[], granted: ReadonlySet<string>): LlmToolDef[] {
  const out: LlmToolDef[] = [];
  for (const def of defs) {
    if (!granted.has(def.id)) continue;
    out.push(
      ToolDefSchema.parse({
        name: def.id,
        ...(def.description.length > 0 ? { description: def.description } : {}),
        parameters: def.llmVisibleParams,
      }),
    );
  }
  return out;
}
