import {
  AgentSession,
  BUILTIN_TOOLS,
  BudgetGovernor,
  DEFAULT_AGENT_TURN_LIMITS,
  RunEventBus,
  createSessionEventSink,
  createSessionHandle,
  createToolRegistry,
  reconstructSessionState,
  type AgentDefinition,
  type SessionDeps,
  type SessionEventSink,
  type SessionHandle,
  type EffortGateResult,
  type SessionResumeState,
  type ToolDef,
  type ToolHost,
} from '@relavium/core';
import {
  catalogModel,
  effortTiersFor,
  type EndpointKind,
  type PricingOverlay,
  type ProviderId,
} from '@relavium/llm';
import type { ManagerSkippedTool, McpClient, McpServerConfig } from '@relavium/mcp';
import type {
  AgentSessionRecord,
  Budget,
  McpServerRegistration,
  ReasoningEffort,
  SessionContext,
  SessionMessage,
  ToolPolicy,
} from '@relavium/shared';

import type { ResolvedChatConfig } from '../config/resolve.js';
import { connectAgentMcp } from '../engine/mcp-servers.js';
import { createProviderResolver, type ProviderResolver } from '../engine/providers.js';
import { assembleToolEnv, clampChatTier, wiredToolIds } from '../engine/tool-host/assemble.js';
import { CliError } from '../process/errors.js';
import type { McpSecretResolver } from '../secrets/mcp-secret.js';
import { effortRejectedNote, effortUnavailableNote } from './effort-notice.js';
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
  /**
   * A pre-resolved agent to bind directly, bypassing `agentRef` resolution. `/clear` (ADR-0062 §7) passes the
   * CURRENT session's bound agent so the fresh session keeps the exact same agent with **no disk re-read** — robust
   * against an agent file edited/deleted mid-session, and the only way `chat-resume`'s snapshot agent (which has no
   * on-disk ref) can seed a fresh `/clear` session. When set, `agentRef` is ignored. Absent ⇒ resolve `agentRef`.
   */
  readonly agent?: AgentDefinition;
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
  /** The tool-execution host (injectable for tests); defaults to the full-capability chat host (chat-read-write); its writes/egress are gated by the ADR-0057 approval regime, not capability absence. */
  readonly toolHost?: ToolHost;
  /**
   * Injectable MCP connect-all (2.R) — tests pass a fake that never spawns a child; production uses the real
   * `@relavium/mcp` `startMcpClient`. Threads through to {@link connectAgentMcp} so the agent's inline stdio
   * `mcp_servers` discover their tools without a live server in the unit path.
   */
  readonly startMcpClient?: (servers: readonly McpServerConfig[]) => Promise<McpClient>;
  /**
   * Resolve a `{{secrets.<name>}}` placeholder in an MCP server `env` value (2.R Step 4, ADR-0052 §6). The
   * command wires the isolated `mcp-secret:*` keychain → `RELAVIUM_MCP_*` env chain; absent ⇒ a `{{` env value
   * is rejected loud.
   */
  readonly mcpSecretResolver?: McpSecretResolver;
  /**
   * The merged config `[[mcp_servers]]` registrations (2.R Step 4b) — resolves a by-name `{ ref }` server
   * entry on the bound agent. Absent ⇒ a `ref` entry fails loud.
   */
  readonly mcpRegistrations?: readonly McpServerRegistration[];
  /**
   * Disable inbound MCP entirely for this session — the agent's `mcp_servers` are NOT connected (no config
   * build, no spawn, no dial), so the session is fully offline. `relavium agent run --fixture` (cassette replay)
   * sets this so a recorded run never touches a real server; the cassette already carries any tool results.
   */
  readonly disableMcp?: boolean;
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
  /**
   * Sink for a WITHHELD reasoning tier (ADR-0071 §6) — the bound model does not accept the effective tier, so the
   * field is not sent. Same channel shape as {@link BuildChatSessionOptions.onBudgetWarning}: a session has no
   * event for it, so the surface is told directly and puts the sentence in the transcript's notice channel.
   * Absent ⇒ a no-op, and the tier is still withheld (never guessed at).
   */
  readonly onEffortWithheld?: (note: string) => void;
  /**
   * The ADR-0065 §2 user-pricing overlay (2.5.G S10) — a `ReadonlyMap<modelId, ModelPricing>` the command projects
   * from the `model_catalog` `source='user'` rows (via `buildUserPricing`). It flows into BOTH the pre-egress
   * governor (so a user-priced model is enforced by `[chat].max_cost_microcents`) AND `SessionDeps.resolvePrice`
   * (so the realized cost of the same model is tracked). Static `MODEL_PRICING` still wins for a known id. Absent ⇒
   * unknown models degrade cost governance to `allow` loudly, unchanged.
   */
  readonly resolvePrice?: PricingOverlay;
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
  /**
   * The bound agent — its `id` is the session's `agentRef`. This is the **ORIGINAL** resolved agent (it carries
   * `mcp_servers` but NOT the dynamically-discovered MCP tool ids), so the persisted snapshot and the
   * export-to-workflow scaffold record the author's agent — a `chat-resume` re-discovers the live tools from
   * `mcp_servers` rather than replaying a stale baked grant. The runtime session is bound to an *effective* agent
   * whose `tools` is unioned with the discovered MCP ids (2.R), constructed internally and not surfaced here.
   */
  readonly agent: AgentDefinition;
  /** The frozen session context (working dir + fs-scope tier) the session ran against. */
  readonly context: SessionContext;
  /**
   * The EFFECTIVE granted tool defs the session runs with (built-ins + discovered MCP) — the REPL derives the
   * chat-mode governed hide-set from these ([chat-mode-host.ts](chat-mode-host.ts), ADR-0057). Exposed here so
   * the fresh + resumed paths both build the mode environment from the SAME def set the registry dispatches.
   */
  readonly tools: readonly ToolDef[];
  /**
   * Push a SURFACE-originated session event onto the same per-session bus (so it shares the monotonic
   * `sequenceNumber` of the live stream). Used by the in-REPL `/export` to emit `session:exported` under
   * `--json`; the bus stamps the `sessionId`/`sequenceNumber`/`timestamp`.
   */
  readonly emitSessionEvent: SessionEventSink;
  /**
   * Tear down the session's MCP connections (2.R) — present only when the agent declared `mcp_servers`. The
   * command MUST `await` it on session teardown (its `finally`), mirroring `persister.close()`. Idempotent.
   */
  readonly closeMcp?: () => Promise<void>;
  /**
   * Tools dropped at MCP discovery (allowlist / unsupported schema / collision / unsafe id) — a non-fatal
   * diagnostic the command surfaces to the user (stderr). Empty when no MCP server is declared.
   */
  readonly mcpSkipped: readonly ManagerSkippedTool[];
}

/** The safe default filesystem tier when `[chat].fs_scope` is unset (mirrors the workflow default). */
const DEFAULT_FS_SCOPE = 'sandboxed' as const;

/** The fields {@link buildSessionRuntime} reads — the platform-capability inputs shared by a fresh + resumed session. */
type SessionRuntimeOptions = Pick<
  BuildChatSessionOptions,
  | 'chat'
  | 'now'
  | 'providers'
  | 'toolHost'
  | 'onBudgetWarning'
  | 'onEffortWithheld'
  | 'resolvePrice'
>;

/**
 * Build the per-session platform-capability runtime — a fresh `RunEventBus` (the sink attaches the sessionId,
 * the bus stamps the per-session sequenceNumber, the handle scopes its stream to it; ADR-0036
 * one-bus-two-namespaces) and the {@link SessionDeps} (provider seam, tool registry, the hard turn cap, and —
 * when a cost cap is configured — the ADR-0028 pre-egress governor). Shared by {@link buildChatSession} (fresh)
 * and {@link buildResumedChatSession} (2.N resume) so the two paths can never wire different capabilities.
 *
 * When the agent declared `mcp_servers` (2.R), the live {@link McpClient}'s namespaced `ToolDef`s are composed
 * into BOTH the registry (so dispatch can resolve them) and `deps.tools` (so the granted set is surfaced to the
 * LLM), and its `McpCapability` is wired onto `ToolHost.mcp` (so a `tools/call` routes to the owning connection)
 * — host-side static assembly with zero engine change ([ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §3).
 */
function buildSessionRuntime(
  opts: SessionRuntimeOptions,
  sessionId: string,
  mcp: McpClient | undefined,
  context: SessionContext,
): { bus: RunEventBus; deps: SessionDeps; emit: SessionEventSink; host: ToolHost } {
  const bus = new RunEventBus({ now: () => new Date(opts.now()).toISOString() });
  const providers = opts.providers ?? createProviderResolver();
  const tools = mcp === undefined ? BUILTIN_TOOLS : [...BUILTIN_TOOLS, ...mcp.toolDefs];
  // 2.5.E (ADR-0057): the shared factory wires the FULL-CAPABILITY chat host (fs read+WRITE, process, egress,
  // os) jailed to the session's fs-scope tier. Safety rests on the mode's per-tool APPROVAL floor, not on
  // capability absence — the REPL activates the fail-closed `confirmAction` regime via `applyChatMode` (default
  // `ask` denies every governed action). Building it is pure (no I/O), so we always assemble it for the policy
  // even when a test injects its own `toolHost` (e.g. a fail-closed `{}` for a capability-gap assertion).
  const factoryEnv = assembleToolEnv({
    profile: 'chat-read-write',
    fsScopeTier: context.fsScopeTier,
    workspaceDir: context.workingDir,
  });
  const baseHost: ToolHost = opts.toolHost ?? factoryEnv.host;
  // Conditional spread ⇒ the inbound-MCP arm is a true MERGE onto fs/process, never a replace (the prior bug).
  const host: ToolHost = mcp === undefined ? baseHost : { ...baseHost, mcp: mcp.capability };
  const registry = createToolRegistry({ tools, host });
  // The chat `ToolPolicy` (ADR-0055's single source) extended with the `[chat].allowed_commands` /
  // `allowed_command_globs` `!`-shell allowlist (2.5.D, ADR-0061). Absent/empty ⇒ the factory default (`{}`) ⇒
  // `run_command` denied (the secure `empty ⇒ disabled` symmetry). Threaded into `SessionDeps.toolPolicy`, it is
  // what BOTH a model `run_command` (advertised only if the agent grants it) AND the user `!`-shell
  // (`runUserCommand`) enforce — the ONE allowlist, never a chat-specific fork.
  const chatToolPolicy: ToolPolicy = {
    ...factoryEnv.policy,
    ...(opts.chat.allowedCommands === undefined
      ? {}
      : { allowedCommands: opts.chat.allowedCommands }),
    ...(opts.chat.allowedCommandGlobs === undefined
      ? {}
      : { allowedCommandGlobs: opts.chat.allowedCommandGlobs }),
  };
  const governor = buildGovernorWiring(
    opts.chat,
    opts.onBudgetWarning,
    opts.resolvePrice,
    providers.endpointKind,
  );
  // The session event sink (1.W): a draft → bus → stamped sequenceNumber/timestamp. Hoisted so a SURFACE
  // event (the in-REPL `/export`'s `session:exported`, 2.Q) can ride the same monotonic per-session counter.
  const emit = createSessionEventSink(bus, sessionId);

  const deps: SessionDeps = {
    resolveProvider: providers.resolveProvider,
    keyFor: providers.keyFor,
    // ADR-0071 §6: the host projects WHICH TIERS the model accepts, not merely whether it reasons. `gpt-5.4-pro`
    // reasons and rejects `low`; the boolean this replaced said `true` and let that straight through to a 400.
    // The seam's `effortTiersFor` IS the projection — passed by reference, not re-derived, so this host cannot
    // drift from the picker that renders the same answer.
    resolveEffortTiers: effortTiersFor,
    // …and when the gate withholds, SAY SO. The engine cannot print; it hands back the verdict (which carries the
    // tiers the model would take) and the surface turns it into the one sentence every path uses.
    ...(opts.onEffortWithheld === undefined
      ? {}
      : {
          onEffortWithheld: (result: EffortGateResult, model: string) => {
            opts.onEffortWithheld?.(
              result.kind === 'rejected'
                ? effortRejectedNote(model, result.requested, result.accepted)
                : effortUnavailableNote(model),
            );
          },
        }),
    registry,
    tools,
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    now: opts.now,
    // Node's AbortController satisfies the engine's structural AbortControllerLike (abort() + signal).
    newAbortController: () => new AbortController(),
    emit,
    // The chat-default `ToolPolicy` comes from the factory (ADR-0055's single source), not an implicit engine
    // default: today it is `{}` (gated tools deny-all; `run_command` disabled via empty allowedCommands — a
    // standalone chat has no workflow allowedCommands to inherit, the secure default per config-spec.md `[chat]`
    // "empty/absent ⇒ run_command disabled"). Extended with the `[chat].allowed_commands` `!`-shell allowlist
    // (ADR-0061) — see `chatToolPolicy` above. A 2.5.E/ADR-0057 per-mode allowlist flows through automatically.
    toolPolicy: chatToolPolicy,
    // Interactive-surface turn bounds: recover from a host tool EXECUTION failure (a file-not-found read, a
    // transient egress error) by feeding it back to the model so it can adapt / explain, instead of ending the
    // turn with a bare `tool_failed` (ADR-0057 UX). A WORKFLOW node keeps the default (fail-fast) — this opt-in
    // rides ONLY the AgentSession chat/Home/one-shot surfaces, never the run-engine's AgentRunner.
    limits: { ...DEFAULT_AGENT_TURN_LIMITS, recoverToolFailures: true },
    ...(opts.chat.maxTurns === undefined ? {} : { maxTurns: opts.chat.maxTurns }),
    // Context compaction (ADR-0062): auto_compact / compact_threshold gate the after-turn auto-compaction, and
    // max_messages is both the `/trim` bound and the auto-compaction failure-degrade target. Absent ⇒ the
    // engine defaults (enabled / 0.8 / no fallback trim). Threaded, not hardcoded, so the config is not re-dead.
    ...(opts.chat.autoCompact === undefined ? {} : { autoCompact: opts.chat.autoCompact }),
    ...(opts.chat.compactThreshold === undefined
      ? {}
      : { compactThreshold: opts.chat.compactThreshold }),
    ...(opts.chat.maxMessages === undefined ? {} : { maxMessages: opts.chat.maxMessages }),
    ...(governor === undefined
      ? {}
      : { preEgress: governor.preEgress, updateCost: governor.updateCost }),
    // The realized-cost overlay (2.5.G S10, ADR-0065 §2) — so the CostTracker prices a user-priced (otherwise
    // unknown) model instead of throwing UnknownModelError. Same map the governor uses; both fill an UNKNOWN id
    // only (static MODEL_PRICING wins). Absent ⇒ unchanged (an unknown model's realized cost degrades loudly).
    ...(opts.resolvePrice === undefined ? {} : { resolvePrice: opts.resolvePrice }),
  };
  return { bus, deps, emit, host };
}

export async function buildChatSession(opts: BuildChatSessionOptions): Promise<BuiltChatSession> {
  const sessionId = opts.uuid();
  // A `/clear` rebuild (ADR-0062 §7) passes the CURRENT bound agent to rebind verbatim; otherwise resolve `agentRef`
  // from disk / the built-in default. Reusing the agent avoids a disk re-read (and its failure modes) on `/clear`.
  const agent =
    opts.agent ??
    resolveChatAgent(opts.agentRef, {
      cwd: opts.cwd,
      projectConfigDir: opts.projectConfigDir,
      defaultModel: opts.chat.defaultModel,
      // ADR-0066: the `[chat].reasoning_effort` default is baked onto the DEFAULT agent only (an authored agent
      // owns its own). Threaded here so a config default lights up a default-agent chat without a picker step.
      ...(opts.chat.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: opts.chat.reasoningEffort }),
    });
  const context: SessionContext = {
    workingDir: opts.cwd,
    // The EFFECTIVE tier (full→project clamped for the chat surface — a chat READ can exfiltrate) — the SAME value the factory
    // jails the host to, so the dispatch-context `fsScope` and the host jail stay consistent (ADR-0055), and
    // the persisted `SessionContext.fsScope` records what the session actually ran at (a resume re-reads it).
    fsScopeTier: clampChatTier(opts.chat.fsScope ?? DEFAULT_FS_SCOPE),
    ...(opts.variables === undefined ? {} : { variables: opts.variables }),
  };

  // Connect the agent's inline stdio `mcp_servers` (2.R) — fail-loud (a connect/discovery failure throws a
  // typed exit-2 CliError). `undefined` when none are declared (no client, nothing to tear down). The spawn
  // cwd is the session working dir, so a relative server path resolves against the workspace. `disableMcp`
  // (fixture/offline replay) bypasses the path entirely — no config build, no spawn, no dial.
  const mcp = opts.disableMcp
    ? undefined
    : await connectAgentMcp(agent.mcp_servers, {
        cwd: opts.cwd,
        ...(opts.startMcpClient === undefined ? {} : { startMcpClient: opts.startMcpClient }),
        ...(opts.mcpSecretResolver === undefined ? {} : { resolveSecret: opts.mcpSecretResolver }),
        ...(opts.mcpRegistrations === undefined ? {} : { registrations: opts.mcpRegistrations }),
      });

  try {
    const { bus, deps, emit, host } = buildSessionRuntime(opts, sessionId, mcp, context);
    // The session runs against the EFFECTIVE agent: its grant unioned with the discovered MCP tool ids (2.R)
    // and then narrowed by the 2.5.A advertise-filter to the tools whose ToolHost arm is actually wired (an
    // unwired tool is never offered). The ORIGINAL `agent` is what we return + persist (see {@link BuiltChatSession.agent}).
    const session = new AgentSession({
      sessionId,
      agentRef: agent.id,
      agent: narrowToWired(withMcpGrant(agent, mcp), host, deps.tools),
      context,
      deps,
    });
    const handle = createSessionHandle(bus, sessionId, () => session.cancel());
    return {
      session,
      handle,
      sessionId,
      agent,
      context,
      tools: deps.tools,
      emitSessionEvent: emit,
      mcpSkipped: mcp?.skipped ?? [],
      ...(mcp === undefined ? {} : { closeMcp: () => mcp.close() }),
    };
  } catch (err) {
    // Self-clean: a post-connect construction fault (e.g. a duplicate-id `createToolRegistry` build) must not
    // leak the just-spawned MCP children — tear them down before the failure propagates. The build is then
    // all-or-nothing: it either returns a session that OWNS `closeMcp`, or it has already closed the client.
    // Best-effort: a teardown rejection must NOT mask the original construction error (preserve the primary).
    await mcp?.close().catch(() => undefined);
    throw err;
  }
}

/**
 * Return the agent the runtime session binds: the original `agent` with its `tools` grant **unioned** with the
 * discovered MCP tool ids (2.R). Declaring an `mcp_servers` entry implicitly grants that server's discovered
 * (already `tools_allowlist`-narrowed) tools — the only coherent grant, since the namespaced ids are discovered
 * dynamically and cannot be pre-listed in `tools:` ([ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §3,
 * "the agent's `tools:` grant AND `tools_allowlist` narrow … with zero engine-interface change"). Built-ins stay
 * governed by `tools:`. Returns the agent unchanged when no MCP tools were discovered.
 */
function withMcpGrant(agent: AgentDefinition, mcp: McpClient | undefined): AgentDefinition {
  if (mcp === undefined || mcp.toolDefs.length === 0) return agent;
  const tools = [...new Set([...(agent.tools ?? []), ...mcp.toolDefs.map((def) => def.id)])];
  return { ...agent, tools };
}

/**
 * Narrow a runtime agent's `tools` grant to those whose required {@link ToolHost} arm is wired (the 2.5.A
 * advertise-filter, ADR-0055): an unwired tool is never offered to the model, so the agent's "say so plainly"
 * path applies and the model cannot call a capability that isn't there. Applied to the EFFECTIVE agent only —
 * the original (persisted/exported) agent keeps the author's full grant. The dispatch `tool_unavailable`
 * backstop (EA1) still fail-closes anything that slips through.
 */
function narrowToWired(
  agent: AgentDefinition,
  host: ToolHost,
  defs: readonly ToolDef[],
): AgentDefinition {
  return { ...agent, tools: wiredToolIds(agent.tools ?? [], host, defs) };
}

/**
 * Return the bound agent for a mid-session model SWITCH ([ADR-0059](../../../../docs/decisions/0059-cli-mid-session-model-reseat.md)):
 * the snapshot with `model`/`provider` swapped to the picked pair and the original `fallback_chain` DROPPED (it
 * belonged to the old model; the resumed instance builds its own default plan for the new model, exactly as a fresh
 * session on it would). Operates on a fresh copy — never mutates the input. Shared by the standalone `chat` reseat
 * (`buildReseatWiring`) and the in-Home chat reseat (`driveHome`) so the swap rule has ONE home.
 *
 * `reasoningEffort` ([ADR-0066](../../../../docs/decisions/0066-normalized-reasoning-effort-control.md)) rides the
 * picker's effort sub-step: a defined tier is bound onto the swapped agent; `undefined` DROPS any prior
 * `reasoning_effort` (a non-reasoning target can't use one, and the picker only omits it for such a target), so the
 * new binding never carries a stale tier from the old model.
 */
export function swapAgentModel(
  agent: AgentDefinition,
  modelId: string,
  provider: ProviderId,
  reasoningEffort?: ReasoningEffort,
): AgentDefinition {
  // A fresh copy, then `delete` the optional `fallback_chain` (removes the key entirely — never an explicit
  // `undefined` under exactOptionalPropertyTypes — and mutates only this copy, never the loaded record).
  const next: AgentDefinition = { ...agent, model: modelId, provider };
  delete next.fallback_chain;
  // Bind the picked tier, or drop any prior one (same `delete` discipline — never an explicit `undefined`).
  if (reasoningEffort === undefined) delete next.reasoning_effort;
  else next.reasoning_effort = reasoningEffort;
  return next;
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
  /**
   * Sink for a WITHHELD reasoning tier (ADR-0071 §6) — see {@link BuildChatSessionOptions.onEffortWithheld}. A
   * RESUMED session is where a stale tier is likeliest: the snapshot carries the tier the agent was authored
   * with, and the catalog may have moved under it since.
   */
  readonly onEffortWithheld?: (note: string) => void;
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
  /** The tool-execution host (injectable for tests); defaults to the full-capability chat host (chat-read-write); its writes/egress are gated by the ADR-0057 approval regime, not capability absence. */
  readonly toolHost?: ToolHost;
  /** Injectable MCP connect-all (2.R; see {@link BuildChatSessionOptions.startMcpClient}). */
  readonly startMcpClient?: (servers: readonly McpServerConfig[]) => Promise<McpClient>;
  /** Resolve `{{secrets.<name>}}` in an MCP server `env` (2.R Step 4; see {@link BuildChatSessionOptions.mcpSecretResolver}). */
  readonly mcpSecretResolver?: McpSecretResolver;
  /** Config `[[mcp_servers]]` registrations for by-name `ref` resolution (2.R Step 4b; see {@link BuildChatSessionOptions.mcpRegistrations}). */
  readonly mcpRegistrations?: readonly McpServerRegistration[];
  /** Sink for an `on_exceed: 'warn'` pre-egress budget warning (see {@link BuildChatSessionOptions}). */
  readonly onBudgetWarning?: (warning: ChatBudgetWarning) => void;
  /** The ADR-0065 §2 user-pricing overlay (2.5.G S10; see {@link BuildChatSessionOptions.resolvePrice}) — so a
   *  resumed session enforces + tracks a user-priced model exactly like a fresh one. */
  readonly resolvePrice?: PricingOverlay;
}

/**
 * Assemble a RESUMED `relavium chat` session (2.N) over `AgentSession.resume`: rebind the session's frozen
 * agent + context from the loaded record, reconstruct its in-flight state from the persisted transcript
 * ({@link reconstructSessionState} — text-only, with a trailing unanswered turn rolled back), and wire the
 * SAME platform-capability runtime a fresh session uses. The resumed session lands directly at idle and does
 * NOT re-emit `session:started`; the next `sendMessage` continues the conversation. A session with no stored
 * `agentSnapshot` cannot be rebound and is a clean invalid invocation (exit 2).
 */
export async function buildResumedChatSession(
  opts: BuildResumedChatSessionOptions,
): Promise<BuiltResumedChatSession> {
  const { record, messages } = opts;
  const agent = record.agentSnapshot;
  if (agent === undefined) {
    throw new CliError(
      'invalid_invocation',
      `session ${record.id} has no stored agent snapshot and cannot be resumed`,
    );
  }
  // Clamp the restored fs-scope tier to the host-allowed ceiling (full→project for the chat surface),
  // mirroring buildChatSession — so a PRE-2.5.A session persisted with a broader `full` scope resumes at the tier
  // the host actually jails to, keeping the dispatch context, the host jail, and the persisted record consistent.
  const context: SessionContext = {
    ...record.context,
    fsScopeTier: clampChatTier(record.context.fsScopeTier),
  };
  const resumeState = reconstructSessionState(record, messages);

  // Re-discover the frozen agent's `mcp_servers` fresh each resume (2.R) — the snapshot stored the author's
  // agent, NOT a baked tool grant, so a server whose tool set changed is picked up correctly. The spawn cwd is
  // the session's frozen working dir. Connect last (after the sync reconstruct/validate) so a reconstruct fault
  // never leaks an opened connection.
  const mcp = await connectAgentMcp(agent.mcp_servers, {
    cwd: context.workingDir,
    ...(opts.startMcpClient === undefined ? {} : { startMcpClient: opts.startMcpClient }),
    ...(opts.mcpSecretResolver === undefined ? {} : { resolveSecret: opts.mcpSecretResolver }),
    ...(opts.mcpRegistrations === undefined ? {} : { registrations: opts.mcpRegistrations }),
  });

  try {
    const { bus, deps, emit, host } = buildSessionRuntime(opts, record.id, mcp, context);
    const session = AgentSession.resume(
      {
        sessionId: record.id,
        agentRef: agent.id,
        agent: narrowToWired(withMcpGrant(agent, mcp), host, deps.tools),
        context,
        deps,
      },
      resumeState,
    );
    const handle = createSessionHandle(bus, record.id, () => session.cancel());
    // Seed the persister one past the persisted MAX(sequence_number) — a fold (not `Math.max(...spread)`, which
    // would overflow the argument-count limit on a very long transcript) over the durable rows, so it is
    // order-independent and starts an empty transcript at 0 (reduce of `[]` from -1, +1 = 0). NOTE: this is a
    // single-writer assumption — the next seq is read at load time, so two concurrent resumes of the SAME
    // session would collide on the `(session_id, sequence_number)` UNIQUE index (a loud failure, not corruption).
    const nextSequenceNumber = messages.reduce((max, m) => Math.max(max, m.sequenceNumber), -1) + 1;
    return {
      session,
      handle,
      sessionId: record.id,
      agent,
      context,
      tools: deps.tools,
      emitSessionEvent: emit,
      resumeState,
      nextSequenceNumber,
      mcpSkipped: mcp?.skipped ?? [],
      ...(mcp === undefined ? {} : { closeMcp: () => mcp.close() }),
    };
  } catch (err) {
    // Self-clean: a post-connect fault must not leak the just-spawned MCP children (see {@link buildChatSession}).
    // Best-effort: a teardown rejection must NOT mask the original resume error (preserve the primary).
    await mcp?.close().catch(() => undefined);
    throw err;
  }
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
  resolvePrice?: PricingOverlay,
  endpointKind?: (id: ProviderId) => EndpointKind,
): GovernorWiring | undefined {
  const cap = chat.maxCostMicrocents;
  if (cap === undefined || cap <= 0) return undefined;
  const budget: Budget = {
    max_cost_microcents: cap,
    on_exceed: chat.onExceed ?? 'pause_for_approval',
  };
  const governor = new BudgetGovernor({
    budget,
    // The ADR-0065 §2 user-pricing overlay — so the PRE-EGRESS estimate can price a user-priced (otherwise
    // unknown) model and enforce the cost cap on it. Omit ⇒ an unknown model degrades to `allow` loudly.
    ...(resolvePrice === undefined ? {} : { resolvePrice }),
    // ADR-0071 §7: the adapter clamps an authored `max_tokens` to the model's ceiling on an OFFICIAL endpoint and
    // not on a custom one. The estimate must make the same call — assume official on a gateway and it lands BELOW
    // what the wire can spend, so the governor under-authorizes and waves through the call it exists to stop.
    ...(endpointKind === undefined
      ? {}
      : { resolveEndpoint: (model: string) => endpointKind(catalogModel(model)?.provider ?? 'openai') }),
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
