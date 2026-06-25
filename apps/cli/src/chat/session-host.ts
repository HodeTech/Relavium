import {
  AgentSession,
  BUILTIN_TOOLS,
  BudgetGovernor,
  RunEventBus,
  createSessionEventSink,
  createSessionHandle,
  createToolRegistry,
  type AgentDefinition,
  type SessionDeps,
  type SessionHandle,
  type ToolHost,
} from '@relavium/core';
import type { Budget, SessionContext } from '@relavium/shared';

import type { ResolvedChatConfig } from '../config/resolve.js';
import { createProviderResolver, type ProviderResolver } from '../engine/providers.js';
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
  };

  // A fresh bus per session: the sink attaches the sessionId, the bus stamps the per-session sequenceNumber,
  // and the handle scopes its stream to this sessionId (ADR-0036 one-bus-two-namespaces).
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

  const session = new AgentSession({ sessionId, agentRef: agent.id, agent, context, deps });
  const handle = createSessionHandle(bus, sessionId, () => session.cancel());
  return { session, handle, sessionId, agent, context };
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
      onWarning?.({
        spentMicrocents: event.spentMicrocents,
        limitMicrocents: event.limitMicrocents,
        thresholdPct: event.thresholdPct,
      });
      return Promise.resolve();
    },
  });
  return {
    preEgress: (info) =>
      governor.checkPreEgress(info.model, info.maxTokens, info.mediaUnitsEstimate),
    updateCost: (cumulative) => governor.updateCost(cumulative),
  };
}
