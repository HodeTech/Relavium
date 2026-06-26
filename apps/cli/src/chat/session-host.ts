import {
  AgentSession,
  BUILTIN_TOOLS,
  BudgetGovernor,
  RunEventBus,
  createSessionEventSink,
  createSessionHandle,
  createToolRegistry,
  reconstructSessionState,
  type AgentDefinition,
  type SessionDeps,
  type SessionHandle,
  type SessionResumeState,
  type ToolHost,
} from '@relavium/core';
import type { AgentSessionRecord, Budget, SessionContext, SessionMessage } from '@relavium/shared';

import type { ResolvedChatConfig } from '../config/resolve.js';
import { createProviderResolver, type ProviderResolver } from '../engine/providers.js';
import { CliError } from '../process/errors.js';
import { resolveChatAgent } from './agent-source.js';

/**
 * Assemble a ready-to-run `relavium chat` session over `@relavium/core`'s {@link AgentSession} (2.M — the
 * agent-first CLI surface, the session analogue of `engine/build-engine.ts`). It binds one agent for the
 * session lifetime (ADR-0024), wires the platform-capability {@link SessionDeps} (provider seam, tool
 * registry, the per-session event sink onto a fresh {@link RunEventBus}, the hard turn cap, and — when a
 * cost cap is configured — the ADR-0028 pre-egress governor), and returns the live session + its
 * {@link SessionHandle} stream. Persistence to `history.db` is layered on top by the session persister; the
 * `read_media` input path (`ctx.mediaRead` / `requestingScope`) is the separate D12 follow-up and is left
 * unwired here, so `read_media` stays fail-closed.
 */

export interface BuildChatSessionOptions {
  /** The resolved `[chat]` block (default model, fs scope, turn cap, cost cap). */
  readonly chat: ResolvedChatConfig;
  /** `--agent <ref>` (path or bare id); `undefined` ⇒ the built-in default agent over `[chat].default_model`. */
  readonly agentRef: string | undefined;
  /** The session working directory (the launch cwd) — the `SessionContext.workingDir` + agent-discovery root. */
  readonly cwd: string;
  /** The resolved `.relavium/` project config dir (for bare-id `--agent` discovery), or `undefined`. */
  readonly projectConfigDir: string | undefined;
  /** Wall-clock in ms (injectable for tests; `Date.now` in production) — feeds the bus + the chain clock. */
  readonly now: () => number;
  /** Process-unique id source (injectable; `randomUUID` in production) — mints the `sessionId`. */
  readonly uuid: () => string;
  /** The provider seam (injectable for tests); defaults to the env/keychain resolver, like `relavium run`. */
  readonly providers?: ProviderResolver;
  /** The tool-execution host (injectable for tests); defaults to fail-closed `{}` (capabilities are a follow-up). */
  readonly toolHost?: ToolHost;
  /**
   * Session-scoped `{{ctx.*}}` variables (plaintext, NO secrets — agent-session-spec.md §Tools). `relavium
   * agent run --input k=v` (2.Q) populates these; a bare `chat` leaves them unset.
   */
  readonly variables?: Record<string, string>;
  /**
   * Sink for an `on_exceed: 'warn'` pre-egress budget warning. A session has no `budget:warning` event in
   * its namespace, so the surface (the REPL) is the warning channel — the command wires this to surface a
   * one-line notice. Absent ⇒ a no-op (the warn stays non-blocking either way).
   */
  readonly onBudgetWarning?: (warning: ChatBudgetWarning) => void;
}

/** A pre-egress budget warning surfaced to the chat surface (`on_exceed: 'warn'`) — secret-free counts only. */
export interface ChatBudgetWarning {
  readonly spentMicrocents: number;
  readonly limitMicrocents: number;
  readonly thresholdPct: number;
}

export interface BuiltChatSession {
  readonly session: AgentSession;
  readonly handle: SessionHandle;
  readonly sessionId: string;
  /** The bound agent (resolved `--agent` or the built-in default) — its `id` is the session's `agentRef`. */
  readonly agent: AgentDefinition;
  /** The frozen session context (working dir + fs-scope tier) the session ran against. */
  readonly context: SessionContext;
}

/** The safe default filesystem tier when `[chat].fs_scope` is unset (mirrors the workflow default). */
const DEFAULT_FS_SCOPE = 'sandboxed' as const;

/** The fields {@link buildSessionRuntime} reads — the platform-capability inputs shared by a fresh + resumed session. */
type SessionRuntimeOptions = Pick<
  BuildChatSessionOptions,
  'chat' | 'now' | 'providers' | 'toolHost' | 'onBudgetWarning'
>;

/**
 * Build the per-session platform-capability runtime — a fresh `RunEventBus` (the sink attaches the sessionId,
 * the bus stamps the per-session sequenceNumber, the handle scopes its stream to it; ADR-0036
 * one-bus-two-namespaces) and the {@link SessionDeps} (provider seam, tool registry, the hard turn cap, and —
 * when a cost cap is configured — the ADR-0028 pre-egress governor). Shared by {@link buildChatSession} (fresh)
 * and {@link buildResumedChatSession} (2.N resume) so the two paths can never wire different capabilities.
 */
function buildSessionRuntime(
  opts: SessionRuntimeOptions,
  sessionId: string,
): { bus: RunEventBus; deps: SessionDeps } {
  const bus = new RunEventBus({ now: () => new Date(opts.now()).toISOString() });
  const providers = opts.providers ?? createProviderResolver();
  const registry = createToolRegistry({ tools: BUILTIN_TOOLS, host: opts.toolHost ?? {} });
  const governor = buildGovernorWiring(opts.chat, opts.onBudgetWarning);

  const deps: SessionDeps = {
    resolveProvider: providers.resolveProvider,
    keyFor: providers.keyFor,
    registry,
    tools: BUILTIN_TOOLS,
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    now: opts.now,
    // Node's AbortController satisfies the engine's structural AbortControllerLike (abort() + signal).
    newAbortController: () => new AbortController(),
    emit: createSessionEventSink(bus, sessionId),
    // No toolPolicy ⇒ the AgentSession default `{}` applies: gated tools deny-all and `run_command` is
    // disabled (empty allowedCommands). A standalone chat has no workflow allowedCommands to inherit, so
    // empty is the secure default (config-spec.md `[chat]` "empty/absent ⇒ run_command disabled").
    ...(opts.chat.maxTurns === undefined ? {} : { maxTurns: opts.chat.maxTurns }),
    ...(governor === undefined
      ? {}
      : { preEgress: governor.preEgress, updateCost: governor.updateCost }),
  };
  return { bus, deps };
}

export function buildChatSession(opts: BuildChatSessionOptions): BuiltChatSession {
  const sessionId = opts.uuid();
  const agent = resolveChatAgent(opts.agentRef, {
    cwd: opts.cwd,
    projectConfigDir: opts.projectConfigDir,
    defaultModel: opts.chat.defaultModel,
  });
  const context: SessionContext = {
    workingDir: opts.cwd,
    fsScopeTier: opts.chat.fsScope ?? DEFAULT_FS_SCOPE,
    ...(opts.variables === undefined ? {} : { variables: opts.variables }),
  };

  const { bus, deps } = buildSessionRuntime(opts, sessionId);
  const session = new AgentSession({ sessionId, agentRef: agent.id, agent, context, deps });
  const handle = createSessionHandle(bus, sessionId, () => session.cancel());
  return { session, handle, sessionId, agent, context };
}

/** A resumed session (2.N) plus the two extra facts the REPL needs: the reconstructed state + the next seq. */
export interface BuiltResumedChatSession extends BuiltChatSession {
  /** The reconstructed in-flight state the view seeds from (carried cost + prior completed-turn count). */
  readonly resumeState: SessionResumeState;
  /**
   * The first `sequenceNumber` the persister assigns to a new message — past the persisted MAX so a continued
   * session does not collide on the `(session_id, sequence_number)` UNIQUE index.
   */
  readonly nextSequenceNumber: number;
}

export interface BuildResumedChatSessionOptions {
  /** The resolved `[chat]` block (turn cap, cost cap) — applied to the resumed session's deps. */
  readonly chat: ResolvedChatConfig;
  /** The loaded session record (its frozen `agentSnapshot` + `context` rebind the session). */
  readonly record: AgentSessionRecord;
  /** The session's persisted transcript, in any order ({@link reconstructSessionState} sorts it). */
  readonly messages: readonly SessionMessage[];
  /**
   * Wall-clock in ms (injectable for tests) — feeds the bus + the chain clock. It clocks ONLY the continued
   * turn(s); the carried-over rows keep their original persisted timestamps, so a post-resume `history.db`
   * shows an expected time discontinuity at the resume boundary.
   */
  readonly now: () => number;
  /** The provider seam (injectable for tests); defaults to the env/keychain resolver. */
  readonly providers?: ProviderResolver;
  /** The tool-execution host (injectable for tests); defaults to fail-closed `{}`. */
  readonly toolHost?: ToolHost;
  /** Sink for an `on_exceed: 'warn'` pre-egress budget warning (see {@link BuildChatSessionOptions}). */
  readonly onBudgetWarning?: (warning: ChatBudgetWarning) => void;
}

/**
 * Assemble a RESUMED `relavium chat` session (2.N) over `AgentSession.resume`: rebind the session's frozen
 * agent + context from the loaded record, reconstruct its in-flight state from the persisted transcript
 * ({@link reconstructSessionState} — text-only, with a trailing unanswered turn rolled back), and wire the
 * SAME platform-capability runtime a fresh session uses. The resumed session lands directly at idle and does
 * NOT re-emit `session:started`; the next `sendMessage` continues the conversation. A session with no stored
 * `agentSnapshot` cannot be rebound and is a clean invalid invocation (exit 2).
 */
export function buildResumedChatSession(
  opts: BuildResumedChatSessionOptions,
): BuiltResumedChatSession {
  const { record, messages } = opts;
  const agent = record.agentSnapshot;
  if (agent === undefined) {
    throw new CliError(
      'invalid_invocation',
      `session ${record.id} has no stored agent snapshot and cannot be resumed`,
    );
  }
  const context = record.context;
  const resumeState = reconstructSessionState(record, messages);

  const { bus, deps } = buildSessionRuntime(opts, record.id);
  const session = AgentSession.resume(
    { sessionId: record.id, agentRef: agent.id, agent, context, deps },
    resumeState,
  );
  const handle = createSessionHandle(bus, record.id, () => session.cancel());
  // Seed the persister one past the persisted MAX(sequence_number) — a fold (not `Math.max(...spread)`, which
  // would overflow the argument-count limit on a very long transcript) over the durable rows, so it is
  // order-independent and starts an empty transcript at 0 (reduce of `[]` from -1, +1 = 0). NOTE: this is a
  // single-writer assumption — the next seq is read at load time, so two concurrent resumes of the SAME
  // session would collide on the `(session_id, sequence_number)` UNIQUE index (a loud failure, not corruption).
  const nextSequenceNumber =
    messages.reduce((max, m) => (m.sequenceNumber > max ? m.sequenceNumber : max), -1) + 1;
  return { session, handle, sessionId: record.id, agent, context, resumeState, nextSequenceNumber };
}

export interface GovernorWiring {
  readonly preEgress: NonNullable<SessionDeps['preEgress']>;
  readonly updateCost: NonNullable<SessionDeps['updateCost']>;
}

/**
 * Wire the ADR-0028 pre-egress cost governor from `[chat].max_cost_microcents` / `on_exceed`. Absent or `0`
 * ⇒ **unbounded** (no governor, the common case). When a positive cap is set, `pause_for_approval` and
 * `fail` both settle a tripped turn **loudly** as `budget_exceeded` (the turn core wraps the exceeded error;
 * the interactive REPL itself is the approval gate — no session pause machinery in 1.V), and `warn` is
 * non-blocking, but instead of dropping the warning it forwards to `onWarning` (the REPL surfaces it; a
 * session has no `budget:warning` event of its own). Exported for direct unit coverage of the
 * absent/0/positive arms and the fail/pause/warn behavior.
 */
export function buildGovernorWiring(
  chat: ResolvedChatConfig,
  onWarning?: (warning: ChatBudgetWarning) => void,
): GovernorWiring | undefined {
  const cap = chat.maxCostMicrocents;
  if (cap === undefined || cap <= 0) return undefined;
  const budget: Budget = {
    max_cost_microcents: cap,
    on_exceed: chat.onExceed ?? 'pause_for_approval',
  };
  const governor = new BudgetGovernor({
    budget,
    emit: (event) => {
      // `warn` is non-blocking BY CONTRACT. A misbehaving warn surface must never reject this emit — a
      // rejection would propagate as an `internal` turn error and break sendMessage — so swallow a sync throw.
      try {
        onWarning?.({
          spentMicrocents: event.spentMicrocents,
          limitMicrocents: event.limitMicrocents,
          thresholdPct: event.thresholdPct,
        });
      } catch {
        // The warn surface is advisory; it cannot block or fail the turn.
      }
      return Promise.resolve();
    },
  });
  return {
    preEgress: (info) =>
      governor.checkPreEgress(info.model, info.maxTokens, info.mediaUnitsEstimate),
    updateCost: (cumulative) => governor.updateCost(cumulative),
  };
}
