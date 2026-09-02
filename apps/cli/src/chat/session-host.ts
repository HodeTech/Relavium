import {
  type AgentDefinition,
  AgentSession,
  BudgetGovernor,
  BUILTIN_TOOLS,
  createSessionEventSink,
  createSessionHandle,
  createToolRegistry,
  DEFAULT_AGENT_TURN_LIMITS,
  type EffectCorrelation,
  type EffectDispatchPort,
  type EffortGateResult,
  reconstructSessionState,
  RunEventBus,
  type SessionDeps,
  type SessionEventSink,
  type SessionHandle,
  type SessionResumeState,
  type ToolDef,
  type ToolHost,
  unwiredEffectJournal,
} from '@relavium/core';
import {
  effortTiersFor,
  type EndpointKind,
  type PricingOverlay,
  type ProviderId,
} from '@relavium/llm';
import type { ManagerSkippedTool, McpClient, McpServerConfig } from '@relavium/mcp';
import type {
  AbortSignalLike,
  AgentSessionRecord,
  Budget,
  McpServerRegistration,
  ReasoningEffort,
  SessionContext,
  SessionMessage,
  ToolPolicy,
  MediaBilledModality,
} from '@relavium/shared';

import type { ResolvedChatConfig } from '../config/resolve.js';
import {
  connectAgentMcp,
  type ConnectAgentMcpOptions,
  type StdioConsentGate,
} from '../engine/mcp-servers.js';
import { createProviderResolver, type ProviderResolver } from '../engine/providers.js';
import { assembleToolEnv, clampChatTier, wiredToolIds } from '../engine/tool-host/assemble.js';
import { CliError } from '../process/errors.js';
import type { McpSecretResolver } from '../secrets/mcp-secret.js';
import {
  effortWithheldNote,
  reasoningWithheldByCapFor,
  unpricedModelNote,
} from './effort-notice.js';
import { resolveChatAgentSource, type ResolvedChatAgent } from './agent-source.js';
import { sanitizeUntrustedInline } from '../render/sanitize.js';
import { hostDeadlineTimer, hostSleep } from '../process/sleep.js';

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
   * The consent gate ([ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §1) —
   * threaded to {@link connectAgentMcp} so a chat session's declared stdio server is not spawned until the
   * user has agreed to it. §1 names BOTH connect paths; only `relavium run` wired it at first, which left
   * `chat`, `chat-resume`, the Home and `agent run` spawning ungated.
   */
  readonly consentGate?: StdioConsentGate;
  /** The agent artifact these servers were declared in — shown at the consent prompt (ADR-0084 §7). */
  readonly mcpArtifact?: string;
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
   * Cancels the MCP connect + discovery ([ADR-0088](../../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md)
   * §1.1). A connect can be the longest thing a session start does — up to `stdio`'s 120 s while a cold `npx`
   * resolves — so a surface that reaps children on a signal needs the connect itself to be interruptible, not
   * merely survivable.
   */
  readonly mcpConnectSignal?: AbortSignalLike;
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
   * Sink for a turn on an UNPRICED model (ADR-0071 §K7) — the cost cap could not apply to it. Same channel shape as
   * {@link BuildChatSessionOptions.onBudgetWarning}; the governor already dedups per-model, so this fires once each.
   */
  readonly onUnpriced?: (note: string) => void;
  /**
   * Sink for a WITHHELD reasoning tier (ADR-0071 §6) — the bound model does not accept the effective tier, so the
   * field is not sent. Same channel shape as {@link BuildChatSessionOptions.onBudgetWarning}: a session has no
   * event for it, so the surface is told directly and puts the sentence in the transcript's notice channel.
   * Absent ⇒ a no-op, and the tier is still withheld (never guessed at).
   */
  readonly onEffortWithheld?: (note: string) => void;
  /**
   * Sink for a **passive subscriber** that threw while handling a session event (#228) — in practice the chat
   * persister failing a durable `history.db` write after its bounded retry was exhausted. Same channel shape as
   * {@link BuildChatSessionOptions.onBudgetWarning}: the surface puts the sentence in the transcript's notice
   * channel so the user learns the turn was not saved, while the session itself continues (the reply is already
   * on screen and the in-memory transcript is intact).
   *
   * Absent ⇒ **not** a no-op, unlike the sinks above. A dropped durable write must never be silent
   * (`docs/standards/error-handling.md`), so the runtime still surfaces it out-of-band, where the process-level
   * `unhandledRejection` net in `index.ts` reports it and keeps the process alive.
   */
  readonly onListenerError?: (note: string) => void;
  /**
   * The ADR-0065 §2 user-pricing overlay (2.5.G S10) — a `ReadonlyMap<modelId, ModelPricing>` the command projects
   * from the `model_catalog` `source='user'` rows (via `buildUserPricing`). It flows into BOTH the pre-egress
   * governor (so a user-priced model is enforced by `[chat].max_cost_microcents`) AND `SessionDeps.resolvePrice`
   * (so the realized cost of the same model is tracked). The USER outranks the catalog (ADR-0071 §1). Absent ⇒
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
  /**
   * Tear the session's MCP connections down, optionally REPORTING a per-server teardown fault.
   *
   * The reporter is threaded rather than swallowed here because the caller is what owns an output channel —
   * and because without it `McpClient.close`'s own `onCloseError` (added by `#207` so a misbehaving transport
   * could be reported) had no production caller at all. It was offered by the manager, accepted by the type,
   * and reachable from nowhere.
   */
  readonly closeMcp?: (onError?: (serverId: string, cause: unknown) => void) => Promise<void>;
  /**
   * The spawned `stdio` children's pids — for a **synchronous** last-resort reap on `process.on('exit')`
   * ([ADR-0088](../../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §1.3). {@link closeMcp} is
   * async, and an exit path that cannot await it re-orphans exactly the children that obligation is about.
   */
  readonly mcpChildPids?: readonly number[];
  /**
   * The budget wiring, when the chat config declares a cap — surfaced so the caller can attach the durable
   * conservative-commitment writer once the persister exists (ADR-0074 §4), and so a surface can offer §1's
   * release. Absent when there is no cap: with nothing to enforce there is nothing to commit either.
   */
  readonly governor?: GovernorWiring;
  /**
   * Late-bind the session's durability probe (#W15-4) — the persister is created by the CALLER, after this,
   * so `preEgress`'s gate cannot take it as an argument. Same shape as `attachConservativeWriter`, and the
   * persister self-attaches through it exactly as it does for the commitment writer.
   */
  /**
   * Attach the durable effect journal (ADR-0080), late-bound because the journal is owned by the persister,
   * which is built AFTER the session — the same constraint `attachConservativeWriter` has for money.
   *
   * An effect dispatched before attachment is REFUSED loudly rather than going unrecorded, which is the
   * fail-closed direction: a silently unjournaled effect is exactly what CR-12 exists to prevent.
   */
  readonly attachEffectJournal: (
    factory: (correlation: EffectCorrelation) => EffectDispatchPort,
  ) => void;
  readonly attachDurabilityProbe: (probe: () => Error | undefined) => void;
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
  | 'onUnpriced'
  | 'onEffortWithheld'
  | 'onListenerError'
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
): {
  bus: RunEventBus;
  deps: SessionDeps;
  emit: SessionEventSink;
  host: ToolHost;
  governor: GovernorWiring | undefined;
  /**
   * Late-bind the session's durability probe (#W15-4). The persister is created by the CALLER, after this
   * runtime exists, so the gate inside `preEgress` cannot take it as an argument — the same reason
   * `attachConservativeWriter` is late-bound. Until it is attached the probe reports healthy, which is
   * correct: nothing has been persisted yet either.
   */
  /**
   * Attach the durable effect journal (ADR-0080), late-bound because the journal is owned by the persister,
   * which is built AFTER the session — the same constraint `attachConservativeWriter` has for money.
   *
   * An effect dispatched before attachment is REFUSED loudly rather than going unrecorded, which is the
   * fail-closed direction: a silently unjournaled effect is exactly what CR-12 exists to prevent.
   */
  attachEffectJournal: (factory: (correlation: EffectCorrelation) => EffectDispatchPort) => void;
  attachDurabilityProbe: (probe: () => Error | undefined) => void;
} {
  let durabilityProbe: () => Error | undefined = () => undefined;
  // #228: a passive subscriber that throws — the chat persister failing a durable `history.db` write — is
  // isolated by `deliver()` either way, so the turn itself is never broken. What was missing is where the
  // failure GOES: with no sink the bus re-throws it out-of-band, and Node kills the process on the resulting
  // unhandled rejection, asynchronously, after the reply was already on screen. Wiring the sink turns that into
  // a reported, survivable event. When the surface supplied no `onListenerError` the sink deliberately re-throws
  // rather than swallowing (no silent catch) — the process-level net in `index.ts` is the floor beneath it.
  const bus = new RunEventBus({
    now: () => new Date(opts.now()).toISOString(),
    onListenerError: (error, event) => {
      const report = opts.onListenerError;
      if (report === undefined) {
        // Rethrowing from the sink is not a shrug — `RunEventBus.#reportListenerError` catches a throwing sink
        // and routes it to `#surfaceOutOfBand`, i.e. exactly the no-sink path, which is the fallback we want.
        // Stated explicitly because "throw to fall through" reads as a bug otherwise.
        throw error;
      }
      // Bus-WIDE, not persister-specific: the renderer, the Home store and the NDJSON printer all subscribe
      // here too, so a render fault must not be reported as a database problem.
      // Redacted, not merely control-stripped: a listener fault here can be a persister write error carrying a
      // path, or an MCP/provider error carrying a key or a `Bearer` header. The surface's own writer strips
      // terminal bytes; nothing else strips secrets.
      const reason = sanitizeUntrustedInline(
        error instanceof Error ? error.message : String(error),
      );
      report(`a background handler failed while processing the ${event.type} event: ${reason}`);
    },
  });
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
    opts.onUnpriced,
  );
  // The session event sink (1.W): a draft → bus → stamped sequenceNumber/timestamp. Hoisted so a SURFACE
  // event (the in-REPL `/export`'s `session:exported`, 2.Q) can ride the same monotonic per-session counter.
  const emit = createSessionEventSink(bus, sessionId);

  // Late-bound by `attachEffectJournal`: the journal is owned by the persister, which is built AFTER the
  // session — the same constraint the commitment writer has.
  let effectJournal: ((correlation: EffectCorrelation) => EffectDispatchPort) | undefined;

  const deps: SessionDeps = {
    resolveProvider: providers.resolveProvider,
    keyFor: providers.keyFor,
    // The durable effect journal (ADR-0080), FORWARDED rather than captured: it is attached later by the
    // persister, which owns `history.db`, so resolving at call time is what lets the session be built first.
    // Before attachment the forward hits `unwiredEffectJournal()` and REFUSES — the fail-closed direction,
    // and the same posture the commitment writer takes for money.
    effects: (correlation: EffectCorrelation): EffectDispatchPort => {
      const port = effectJournal?.(correlation);
      return {
        prepare: (slot, toolId, tier, redactedArgs, targetIdempotencyKey) =>
          (port ?? unwiredEffectJournal()).prepare(
            slot,
            toolId,
            tier,
            redactedArgs,
            targetIdempotencyKey,
          ),
        settle: (slot, toolId, state, result) =>
          (port ?? unwiredEffectJournal()).settle(slot, toolId, state, result),
        discard: (slot, toolId) => (port ?? unwiredEffectJournal()).discard(slot, toolId),
      };
    },
    // ADR-0071 §6: the host projects WHICH TIERS the model accepts, not merely whether it reasons. `gpt-5.4-pro`
    // reasons and rejects `low`; the boolean this replaced said `true` and let that straight through to a 400.
    // The seam's `effortTiersFor` IS the projection — passed by reference, not re-derived, so this host cannot
    // drift from the picker that renders the same answer.
    resolveEffortTiers: effortTiersFor,
    // A budget-shaped model can accept a tier yet still have the adapter drop thinking when this turn's `max_tokens`
    // leaves no room for its budget floor (review M6). Inject the catalog-backed check so the gate SURFACES that as
    // a `capped` verdict instead of the adapter dropping it in silence.
    withheldByCap: reasoningWithheldByCapFor,
    // …and when the gate withholds, SAY SO. The engine cannot print; it hands back the verdict (which carries the
    // tiers the model would take) and the surface turns it into the one sentence every path uses.
    ...(opts.onEffortWithheld === undefined
      ? {}
      : {
          onEffortWithheld: (result: EffortGateResult, model: string) => {
            opts.onEffortWithheld?.(effortWithheldNote(result, model));
          },
        }),
    registry,
    tools,
    sleep: hostSleep,
    // ADR-0082 §6's per-attempt deadline. The controller this host already supplies for the per-turn cancel
    // doubles as the deadline's merged signal; the TIMER is what arms it.
    setTimer: hostDeadlineTimer,
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
    // ALWAYS present, cap or no cap (#W15-4). `RunEventBus` isolates listener errors, so a persister that
    // cannot write still let the turn report success — the durable transcript and the cost columns silently
    // fell behind a conversation that carried on above them. This is the gate that stops it: once the
    // persister latches a write failure, no further egress is admitted. It composes with the governor rather
    // than replacing it, and it runs FIRST — a session whose record is already lost must not spend more.
    preEgress: (info) => {
      const failure = durabilityProbe();
      if (failure !== undefined) {
        // A plain Error, deliberately: the chain classifies a `preAttempt` throw as a fatal (non-retryable)
        // turn failure and carries this MESSAGE onto the terminal, which is all this needs. Exporting the
        // turn-error class from `@relavium/core` to type it would widen a package's public API for a string.
        // The message names the state without echoing the store's own text, which can carry a path.
        throw new Error(
          'this session could not be saved, so it will not send anything further — the transcript and cost on disk are behind what you see',
          { cause: failure },
        );
      }
      return governor?.preEgress(info);
    },
    ...(governor === undefined
      ? {}
      : {
          updateCost: governor.updateCost,
          // ADR-0074 §4: resume restores BOTH totals into the same governor a fresh session uses.
          restoreConservativeCost: governor.restoreConservativeCost,
          // ADR-0074 §2's turn-boundary half — the session's equivalent of the engine's node-boundary flush.
          flushBudgetCommitments: governor.flushBudgetCommitments,
        }),
    // The realized-cost overlay (2.5.G S10, ADR-0065 §2) — so the CostTracker prices a user-priced (otherwise
    // unknown) model instead of throwing UnknownModelError. Same map the governor uses; both fill an UNKNOWN id
    // only (static MODEL_PRICING wins). Absent ⇒ unchanged (an unknown model's realized cost degrades loudly).
    ...(opts.resolvePrice === undefined ? {} : { resolvePrice: opts.resolvePrice }),
  };
  // `governor` rides out so the CALLER can attach the durable conservative-commitment writer once the persister
  // exists (ADR-0074 §4) and expose §1's release. Undefined when the chat declares no cap.
  return {
    bus,
    deps,
    emit,
    host,
    governor,
    attachDurabilityProbe: (probe) => {
      durabilityProbe = probe;
    },
    attachEffectJournal: (factory: (correlation: EffectCorrelation) => EffectDispatchPort) => {
      effectJournal = factory;
    },
  };
}

/**
 * The agent this session binds for its whole lifetime, and the FILE it came from.
 *
 * A `/clear` rebuild ([ADR-0062](../../../../docs/decisions/0062-context-compaction-and-cli-history-commands.md) §7)
 * passes the CURRENT bound agent to rebind verbatim; otherwise the ref is resolved from disk, or the built-in
 * default is built. Reusing the agent avoids a disk re-read — and its failure modes — on `/clear`.
 *
 * The artifact path travels with the agent for the consent prompt
 * ([ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §7):
 * `chat --agent ./downloaded.agent.yaml` is the imported-artifact case the gate exists for, and naming the
 * word the user typed instead of the path it resolved to answers a different question than the one asked. A
 * rebind has no file — the agent is already in memory — so it reports none rather than a stale one.
 */
function bindChatAgent(opts: BuildChatSessionOptions): ResolvedChatAgent {
  if (opts.agent !== undefined) return { agent: opts.agent, artifact: undefined };
  return resolveChatAgentSource(opts.agentRef, {
    cwd: opts.cwd,
    projectConfigDir: opts.projectConfigDir,
    defaultModel: opts.chat.defaultModel,
    // ADR-0059: the persisted `[chat].default_provider` is used verbatim for the DEFAULT agent so a
    // live-discovered id whose prefix the inference cannot place still resolves; absent ⇒ inference.
    ...(opts.chat.defaultProvider === undefined
      ? {}
      : { defaultProvider: opts.chat.defaultProvider }),
    // ADR-0066: the `[chat].reasoning_effort` default is baked onto the DEFAULT agent only (an authored
    // agent owns its own). Threaded here so a config default lights up a default-agent chat.
    ...(opts.chat.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: opts.chat.reasoningEffort }),
  });
}

/**
 * The MCP connect options, with every absent one OMITTED rather than passed as an explicit `undefined`.
 *
 * `exactOptionalPropertyTypes` is on, so `{ startMcpClient: undefined }` and `{}` are different types — the
 * spread-or-nothing shape is what keeps a caller that did not wire a dependency from asserting it wired one
 * to `undefined`.
 */
/**
 * Exactly the fields {@link mcpOptionsFor} reads — deliberately NOT `BuildChatSessionOptions`.
 *
 * The fresh and resumed paths carry two different option types, and the mapper has no business requiring
 * either whole. Naming the five it actually consumes is what lets both satisfy it structurally, and makes a
 * sixth option impossible to add on one path only: it has to be added here, and then both call sites see it.
 */
type McpConnectInputs = Pick<
  BuildChatSessionOptions,
  'consentGate' | 'startMcpClient' | 'mcpSecretResolver' | 'mcpRegistrations' | 'mcpConnectSignal'
>;

/**
 * The ONE mapper from build options to `connectAgentMcp` options, used by BOTH the fresh and the resumed path.
 *
 * `cwd` and `artifact` differ between them and are therefore parameters; everything else is shared. The
 * resumed path used to build this record inline, and the cost is recorded rather than guessed: a newly-added
 * `connectSignal` was wired on the fresh path and dead on the resumed one — the "wired and still dead" shape,
 * caused by exactly this duplication. A second option added tomorrow would have drifted the same way.
 */
function mcpOptionsFor(
  opts: McpConnectInputs,
  mcpArtifact: string | undefined,
  cwd: string,
): ConnectAgentMcpOptions {
  return {
    cwd,
    ...(opts.consentGate === undefined ? {} : { consentGate: opts.consentGate }),
    // The caller's label wins (`agent run` names the ref the user typed); otherwise the path the agent was
    // actually read from — §7's "declared in <file>" for the imported-artifact case.
    ...(mcpArtifact === undefined ? {} : { artifact: mcpArtifact }),
    ...(opts.startMcpClient === undefined ? {} : { startMcpClient: opts.startMcpClient }),
    ...(opts.mcpSecretResolver === undefined ? {} : { resolveSecret: opts.mcpSecretResolver }),
    ...(opts.mcpRegistrations === undefined ? {} : { registrations: opts.mcpRegistrations }),
    ...(opts.mcpConnectSignal === undefined ? {} : { connectSignal: opts.mcpConnectSignal }),
  };
}

export async function buildChatSession(opts: BuildChatSessionOptions): Promise<BuiltChatSession> {
  const sessionId = opts.uuid();
  const { agent, artifact } = bindChatAgent(opts);
  const mcpArtifact = opts.mcpArtifact ?? artifact;
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
    : await connectAgentMcp(agent.mcp_servers, mcpOptionsFor(opts, mcpArtifact, opts.cwd));

  try {
    const { bus, deps, emit, host, governor, attachDurabilityProbe, attachEffectJournal } =
      buildSessionRuntime(opts, sessionId, mcp, context);
    // The session runs against the EFFECTIVE agent: its grant unioned with the discovered MCP tool ids (2.R)
    // and then narrowed by the 2.5.A advertise-filter to the tools whose ToolHost arm is actually wired (an
    // unwired tool is never offered). The ORIGINAL `agent` is what we return + persist (see {@link BuiltChatSession.agent}).
    // **The producer-await knob, late-bound (`CR-30`, ADR-0036).** The handle is created FROM the session
    // (it closes over `session.cancel()`), so the session cannot hold it at construction. `whenReady` is
    // only ever called during a turn, long after both exist, so a thunk that reads this slot is safe — and
    // it resolves immediately while the slot is still empty, which is the correct answer for "no consumer
    // has attached yet".
    const attached: { handle?: SessionHandle } = {};
    const whenReady = (): Promise<void> =>
      attached.handle?.whenConsumersReady() ?? Promise.resolve();
    const session = new AgentSession({
      sessionId,
      agentRef: agent.id,
      agent: narrowToWired(withMcpGrant(agent, mcp), host, deps.tools),
      context,
      deps: { ...deps, whenReady },
    });
    const handle = createSessionHandle(bus, sessionId, () => session.cancel());
    attached.handle = handle;
    return {
      session,
      handle,
      sessionId,
      agent,
      context,
      tools: deps.tools,
      emitSessionEvent: emit,
      mcpSkipped: mcp?.skipped ?? [],
      ...(mcp === undefined
        ? {}
        : {
            closeMcp: (onError?: (id: string, cause: unknown) => void) => mcp.close(onError),
            mcpChildPids: mcp.childPids,
          }),
      attachDurabilityProbe,
      attachEffectJournal,
      ...(governor === undefined ? {} : { governor }),
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
  /** Unpriced-model notice (ADR-0071 §K7) — see {@link BuildChatSessionOptions.onUnpriced}. */
  readonly onUnpriced?: (note: string) => void;
  /**
   * Sink for a throwing passive subscriber (#228) — see {@link BuildChatSessionOptions.onListenerError}.
   * A RESUMED session is the HIGHEST-contention surface for it: two `chat-resume` processes on one session
   * write the same `history.db` rows concurrently (#227).
   */
  readonly onListenerError?: (note: string) => void;
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
  /**
   * Injectable MCP connect-all (2.R; see {@link BuildChatSessionOptions.startMcpClient}).
   *
   * **The `signal` parameter is not decoration.** This declared a ONE-argument function while the fresh
   * path's declared two, and TypeScript accepts a shorter parameter list — so the resumed path's contract
   * silently said "there is no connect signal here" while the runtime passed one anyway. That is the same
   * shape as the dropped `open: () =>` closure ADR-0088 §1.3 records: a signal that type-checks its way out
   * of existing. Kept identical to the fresh declaration so the two paths cannot disagree again.
   */
  readonly startMcpClient?: (
    servers: readonly McpServerConfig[],
    signal?: AbortSignalLike,
  ) => Promise<McpClient>;
  /**
   * The consent gate ([ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §1) —
   * threaded to {@link connectAgentMcp} so a chat session's declared stdio server is not spawned until the
   * user has agreed to it. §1 names BOTH connect paths; only `relavium run` wired it at first, which left
   * `chat`, `chat-resume`, the Home and `agent run` spawning ungated.
   */
  readonly consentGate?: StdioConsentGate;
  /** The agent artifact these servers were declared in — shown at the consent prompt (ADR-0084 §7). */
  readonly mcpArtifact?: string;
  /** Resolve `{{secrets.<name>}}` in an MCP server `env` (2.R Step 4; see {@link BuildChatSessionOptions.mcpSecretResolver}). */
  readonly mcpSecretResolver?: McpSecretResolver;
  /** Config `[[mcp_servers]]` registrations for by-name `ref` resolution (2.R Step 4b; see {@link BuildChatSessionOptions.mcpRegistrations}). */
  readonly mcpRegistrations?: readonly McpServerRegistration[];
  /**
   * Cancels the MCP connect + discovery ([ADR-0088](../../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md)
   * §1.1). A connect can be the longest thing a session start does — up to `stdio`'s 120 s while a cold `npx`
   * resolves — so a surface that reaps children on a signal needs the connect itself to be interruptible, not
   * merely survivable.
   */
  readonly mcpConnectSignal?: AbortSignalLike;
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
  // Through the SHARED mapper, with this path's two differences passed in — rather than a second inline copy
  // of the same record. The copy is how `connectSignal` came to be wired on one path and dead on the other.
  //
  // The artifact label is the SESSION, not a file. A resume runs the agent SNAPSHOT frozen at session start,
  // so the file the agent originally came from may have changed or be gone — naming it would tell the user to
  // go review bytes that are not what is about to run (ADR-0084 §7).
  const mcp = await connectAgentMcp(
    agent.mcp_servers,
    mcpOptionsFor(opts, opts.mcpArtifact ?? `resumed session ${record.id}`, context.workingDir),
  );

  try {
    const { bus, deps, emit, host, governor, attachDurabilityProbe, attachEffectJournal } =
      buildSessionRuntime(opts, record.id, mcp, context);
    // The same late-bound producer-await slot as the fresh-session path (`CR-30`), declared again because
    // this is a separate function. A resumed session streams exactly like a new one, so leaving it out
    // would have shipped the bound on one of the two ways a chat starts.
    const attached: { handle?: SessionHandle } = {};
    const session = AgentSession.resume(
      {
        sessionId: record.id,
        agentRef: agent.id,
        agent: narrowToWired(withMcpGrant(agent, mcp), host, deps.tools),
        context,
        deps: {
          ...deps,
          whenReady: () => attached.handle?.whenConsumersReady() ?? Promise.resolve(),
        },
      },
      resumeState,
    );
    const handle = createSessionHandle(bus, record.id, () => session.cancel());
    attached.handle = handle;
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
      ...(mcp === undefined
        ? {}
        : {
            closeMcp: (onError?: (id: string, cause: unknown) => void) => mcp.close(onError),
            mcpChildPids: mcp.childPids,
          }),
      attachDurabilityProbe,
      attachEffectJournal,
      ...(governor === undefined ? {} : { governor }),
    };
  } catch (err) {
    // Self-clean: a post-connect fault must not leak the just-spawned MCP children (see {@link buildChatSession}).
    // Best-effort: a teardown rejection must NOT mask the original resume error (preserve the primary).
    await mcp?.close().catch(() => undefined);
    throw err;
  }
}

/** One conservative budget commitment to persist for this session (ADR-0074 §2/§4). */
export interface SessionConservativeCommitment {
  /** The RAW provider model string — the per-model attribution key `session_costs` is keyed on. */
  readonly model: string;
  /** THIS commitment's amount, never a running cumulative. The store adds it to the row AND the aggregate. */
  readonly estimateMicrocents: number;
}

export interface GovernorWiring {
  readonly preEgress: NonNullable<SessionDeps['preEgress']>;
  readonly updateCost: NonNullable<SessionDeps['updateCost']>;
  /** Seed the conservative total on `chat-resume` (ADR-0074 §4) — see `AgentSession.resume`. */
  readonly restoreConservativeCost: NonNullable<SessionDeps['restoreConservativeCost']>;
  /** Await the conservative-commitment durability barrier at a turn boundary (ADR-0074 §2). */
  readonly flushBudgetCommitments: NonNullable<SessionDeps['flushBudgetCommitments']>;
  /**
   * Late-bind the durable writer for conservative commitments (ADR-0074 §4).
   *
   * Late because it cannot be otherwise: the persister needs the session's handle, id, agent and context, all of
   * which only exist AFTER `buildChatSession` returns — and the governor is built inside it. Rather than reorder
   * a construction sequence whose teardown-on-failure ordering is load-bearing, the caller attaches the writer
   * the moment the persister exists.
   *
   * A commitment made before attachment is NOT silently dropped: the governor's emit rejects, which its own
   * barrier turns into a `CommitmentDurabilityError` and a sticky `conservativeDurabilityBroken`. It should never
   * happen — no turn can run before the persister is built — and if it ever does we learn, rather than losing
   * money quietly.
   */
  readonly attachConservativeWriter: (
    write: (commitment: SessionConservativeCommitment) => Promise<void>,
  ) => void;
  /**
   * ADR-0074 §1's escape hatch, now that the total is persisted: clear the conservative commitments by an
   * explicit user decision. Returns what was released.
   *
   * A chat is the long-lived owner §1's harm sentence names — "a single usage-less response would permanently
   * shrink a long-lived chat's cap with no way out" — so persisting the total WITHOUT this would create exactly
   * the failure §1 rejects. It is only ever called from a surface acting on the user's choice, never from a
   * heuristic: "what is forbidden is the system silently deciding the estimate was wrong."
   */
  readonly releaseConservativeCommitments: () => number;
  /** The session's conservative total, and whether its durability is known-broken — what a surface renders. */
  readonly conservativeState: () => { microcents: number; durabilityBroken: boolean };
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
  onUnpriced?: (note: string) => void,
): GovernorWiring | undefined {
  const cap = chat.maxCostMicrocents;
  if (cap === undefined || cap <= 0) return undefined;
  const budget: Budget = {
    max_cost_microcents: cap,
    on_exceed: chat.onExceed ?? 'pause_for_approval',
    // ADR-0071 §K7: refuse a turn on a model we cannot price, instead of the silent degrade-to-allow. Default off.
    ...(chat.strictCostCap ? { strict_cost_cap: true } : {}),
  };
  // Late-bound by `attachConservativeWriter` — see its doc for why it cannot be a constructor argument.
  let writeCommitment: ((c: SessionConservativeCommitment) => Promise<void>) | undefined;
  const governor = new BudgetGovernor({
    budget,
    // The ADR-0065 §2 user-pricing overlay — so the PRE-EGRESS estimate can price a user-priced (otherwise
    // unknown) model and enforce the cost cap on it. Omit ⇒ an unknown model degrades to `allow` loudly.
    ...(resolvePrice === undefined ? {} : { resolvePrice }),
    // ADR-0071 §7: the adapter clamps an authored `max_tokens` to the model's ceiling on an OFFICIAL endpoint and
    // not on a custom one. The estimate must make the same call — assume official on a gateway and it lands BELOW
    // what the wire can spend, so the governor under-authorizes and waves through the call it exists to stop.
    // Keyed on the ROUTING provider the governor threads per attempt, not the model's catalog provider — a custom
    // gateway serving another provider's model id would otherwise be mis-read as official and under-clamped (M2).
    ...(endpointKind === undefined ? {} : { resolveEndpoint: endpointKind }),
    // ADR-0071 §K7: a turn ran on a model we could not price, so the cap did not apply to it. Say so, once — a cost
    // cap that silently does not apply is a false sense of safety. `strict_cost_cap` is the block-instead option.
    ...(onUnpriced === undefined
      ? {}
      : {
          onUnpriced: (
            model: string,
            capMicrocents: number,
            modalities?: readonly MediaBilledModality[],
          ) =>
            onUnpriced(
              unpricedModelNote(model, capMicrocents, '[chat] strict_cost_cap', modalities),
            ),
        }),
    emit: (event) => {
      if (event.type === 'budget:estimate_committed') {
        // ADR-0074 §2 on the SESSION surface, and the promise this returns IS the durability the governor's
        // barrier awaits — which is why the write is called directly rather than pushed onto the bus. A bus
        // delivery would resolve whether or not anything reached disk, turning the barrier into theatre.
        if (writeCommitment === undefined) {
          // Unreachable in practice (no turn runs before the persister is built), and deliberately loud rather
          // than a silent `Promise.resolve()`: a dropped commitment is money the cap will forget across a resume.
          return Promise.reject(
            new Error(
              'a conservative commitment was made before the session persister was attached',
            ),
          );
        }
        return writeCommitment({
          model: event.model,
          estimateMicrocents: event.estimateMicrocents,
        });
      }
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
      governor.checkPreEgress(info.model, info.maxTokens, info.mediaUnitsEstimate, info.provider),
    updateCost: (cumulative) => governor.updateCost(cumulative),
    restoreConservativeCost: (microcents) => governor.restoreConservativeCost(microcents),
    flushBudgetCommitments: () => governor.flushCommitments(),
    attachConservativeWriter: (write) => {
      writeCommitment = write;
    },
    // ADR-0074 §1's escape hatch, shipped in the SAME change that persists the total — deliberately, because
    // persisting without it is the indefinite block §1 explicitly rejects on exactly this surface.
    releaseConservativeCommitments: () => governor.releaseConservativeCommitments(),
    conservativeState: () => ({
      microcents: governor.conservativeCostMicrocents,
      durabilityBroken: governor.conservativeDurabilityBroken,
    }),
  };
}
