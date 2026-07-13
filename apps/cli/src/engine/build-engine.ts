import {
  BUILTIN_TOOLS,
  WorkflowEngine,
  createExpressionSandbox,
  createStandardNodeExecutor,
  createToolRegistry,
  type AgentRunnerDeps,
  type EffortGateResult,
  type ExecutionHost,
  type FsScopeTier,
  type McpCapability,
  type ToolDef,
  type ToolHost,
} from '@relavium/core';
import {
  catalogModel,
  effortTiersFor,
  type EndpointKind,
  type PricingOverlay,
} from '@relavium/llm';
import type { MediaCostEstimate, MediaSurface } from '@relavium/shared';

import { effortRejectedNote, effortUnavailableNote } from '../chat/effort-notice.js';
import { createCliHost } from './host.js';
import { createProviderResolver, type ProviderResolver } from './providers.js';
import { assembleToolEnv } from './tool-host/assemble.js';

export interface BuildEngineOptions {
  /** Override the execution host (tests use the in-memory reference). */
  readonly host?: ExecutionHost;
  /** Override the provider seam (tests inject a stub provider + dummy key). */
  readonly providers?: ProviderResolver;
  /**
   * The model → `media_surface` routing projection (2.S, ADR-0045 §1) the caller builds from the DB
   * `model_catalog` (`createModelCatalogStore(...).resolveMediaSurface`). Absent / `undefined` ⇒ every model
   * routes inline (`'chat'`), so no generative-surface model is reachable.
   */
  readonly resolveMediaSurface?: (model: string) => MediaSurface | undefined;
  /**
   * The `[defaults].media_cost_estimate` per-modality unit-count defaults (2.S/D17, ADR-0044 §3) the caller
   * resolves from config. Threads into the pre-egress media-cost governor; absent ⇒ the built-in default
   * unit estimate is used. Media still folds at 0 until a verified catalog rate lands (never fabricated).
   */
  readonly mediaCostEstimate?: MediaCostEstimate;
  /**
   * The inbound MCP wiring (2.R Step 3b) — the discovered namespaced `ToolDef`s + the `McpCapability` to route
   * `tools/call`. Absent ⇒ the registry/host carry built-ins only. The defs are composed into BOTH the registry
   * and `AgentRunnerDeps.tools` (so the granted set is surfaced to the LLM); the capability is wired onto
   * `ToolHost.mcp`. The host owns the connections' lifecycle (teardown at the run terminal) — see `run.ts`.
   */
  readonly mcp?: { readonly toolDefs: readonly ToolDef[]; readonly capability: McpCapability };
  /**
   * The workflow-run tool-environment inputs (2.5.A, ADR-0055) — when given, the shared factory wires the
   * **read+write** `fs` + `process` host arms jailed to `workspaceDir` at `fsScopeTier` (the workflow-author
   * trust model governs the run path). Absent (the in-memory unit/harness path) ⇒ a fail-closed `{}` host, so
   * a tool needing a capability is cleanly `tool_unavailable`. `run.ts` passes the launch cwd + the resolved
   * `fs_scope`. The MCP arm is merged on top below.
   */
  readonly toolEnv?: { readonly workspaceDir: string; readonly fsScopeTier: FsScopeTier };
  /**
   * The ADR-0065 §2 user-pricing overlay (2.5.G S10) — a `ReadonlyMap<modelId, ModelPricing>` the caller (`run.ts`)
   * projects from the `model_catalog` `source='user'` rows. Threaded into BOTH the workflow PRE-EGRESS governor
   * (so a user-priced model is enforced by `budget.max_cost_microcents`) AND the agent node's realized
   * `AgentRunnerDeps.resolvePrice` (so the same model's realized cost is tracked, not thrown as `UnknownModel`).
   * The USER outranks the catalog (ADR-0071 §1). Absent ⇒ an unknown model degrades cost governance
   * to `allow` loudly, unchanged.
   */
  readonly resolvePrice?: PricingOverlay;
  /**
   * Sink for a WITHHELD reasoning tier (ADR-0071 §6) — an agent authored `reasoning_effort: <tier>` that the bound
   * model does not accept, so the field is not sent. The gate replaced a loud provider 400 with a quiet no-op, and
   * on an authored workflow that no-op is the dangerous one: the run succeeds, the knob does nothing, and the bill
   * lands at the provider's default tier. `run.ts` wires this to stderr — never stdout, which `--json` owns.
   * Absent ⇒ silent (the tier is still withheld).
   */
  readonly onEffortWithheld?: (note: string) => void;
  /**
   * Sink for an UNPRICED model turn (ADR-0071 §K7) — the cost cap could not apply. `run.ts` wires it to stderr,
   * never stdout (`--json`). The governor already dedups per model. Absent ⇒ silent.
   */
  readonly onUnpriced?: (model: string, capMicrocents: number) => void;
}

/**
 * Assemble a {@link WorkflowEngine} for a CLI run: a node-backed host, the standard node executor
 * (the six non-agent handlers + the agent arm), the expression sandbox, and the `ToolHost`.
 * `host`/`providers` are injectable so tests drive a stub provider + the in-memory host.
 *
 * The `ToolHost` (2.5.A, ADR-0055): when `options.toolEnv` is given, the shared factory wires the
 * **read+write** `fs` + `process` arms jailed to the workspace at the resolved `fs_scope` (the workflow-author
 * trust model governs the run path); the inbound-MCP `McpCapability` (2.R) is then **merged** on top with a
 * conditional spread — a true merge, never a replace. The `egress` / `os` arms are **intentionally never wired
 * on this run path** — they belong only to the ADR-0057 approval-gated `chat-read-write` profile (a permanent
 * scope boundary, not a 2.5.E deferral: workflow-run egress/os is a separate author-trusted concern) — so a
 * tool needing one is cleanly `tool_unavailable`. Absent `toolEnv` (the in-memory unit/harness path) ⇒ a
 * fail-closed `{}` base host.
 */
export async function buildEngine(options: BuildEngineOptions = {}): Promise<WorkflowEngine> {
  const host = options.host ?? createCliHost();
  const providers = options.providers ?? createProviderResolver();
  const sandbox = await createExpressionSandbox();

  // Compose the inbound MCP tools (2.R Step 3b): the discovered namespaced ToolDefs join the built-ins in the
  // registry AND `AgentRunnerDeps.tools` below (so a granted MCP tool is surfaced to the LLM), and the
  // McpCapability is wired onto the registry's `ToolHost.mcp` so a `tools/call` routes to the owning connection.
  const tools =
    options.mcp === undefined ? BUILTIN_TOOLS : [...BUILTIN_TOOLS, ...options.mcp.toolDefs];
  // 2.5.A (ADR-0055): the shared factory wires the read+write fs + process arms when `toolEnv` is given;
  // absent ⇒ a fail-closed `{}` base host. The MCP arm is then MERGED with a conditional spread — a true
  // merge, never a replace (the prior bug that dropped a sibling fs/process arm once one was added).
  const baseToolHost: ToolHost =
    options.toolEnv === undefined
      ? {}
      : assembleToolEnv({
          profile: 'workflow-read-write',
          fsScopeTier: options.toolEnv.fsScopeTier,
          workspaceDir: options.toolEnv.workspaceDir,
        }).host;
  const toolHost: ToolHost =
    options.mcp === undefined ? baseToolHost : { ...baseToolHost, mcp: options.mcp.capability };
  const registry = createToolRegistry({ tools, host: toolHost });

  // The single host CAS (`host.mediaStore`) also backs the D8 failover re-materialization: resolve a durable
  // handle in a transcript message to the in-flight source a provider needs, before egress. Bound here (when a
  // store is wired) so the fallback chain stays byte-free/platform-free. `ProviderId === LlmProviderId`, so the
  // `MediaStore.resolveForEgress` signature matches `ChainCapabilities['resolveForEgress']` exactly.
  const mediaStore = host.mediaStore;
  const agent: AgentRunnerDeps = {
    resolveProvider: providers.resolveProvider,
    keyFor: providers.keyFor,
    // ADR-0071 §6: the host projects WHICH TIERS the model accepts, not merely whether it reasons. `gpt-5.4-pro`
    // reasons and rejects `low`; the boolean this replaced said `true` and let that straight through to a 400.
    // The seam's `effortTiersFor` IS the projection — passed by reference, so the workflow path and the chat path
    // gate on one function rather than on two copies of it that happen to agree today.
    resolveEffortTiers: effortTiersFor,
    // …and when it withholds, the author hears about it. See {@link BuildEngineOptions.onEffortWithheld}.
    ...(options.onEffortWithheld === undefined
      ? {}
      : {
          onEffortWithheld: (result: EffortGateResult, model: string) => {
            options.onEffortWithheld?.(
              result.kind === 'rejected'
                ? effortRejectedNote(model, result.requested, result.accepted)
                : effortUnavailableNote(model),
            );
          },
        }),
    registry,
    tools,
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    now: () => Date.now(),
    // Keep the dispatch-context `fsScope` consistent with the tier the fs host jails to (ADR-0055's
    // "three concepts, three channels"); absent ⇒ the engine default `sandboxed`.
    ...(options.toolEnv === undefined ? {} : { fsScope: options.toolEnv.fsScopeTier }),
    // The media routing/cost/egress deps (2.S) — each present only when its source is wired (`undefined` is
    // OMITTED, not assigned — the fields are `?:`, exactOptionalPropertyTypes). resolveMediaSurface routes a
    // generative model to generateMedia (ADR-0045 §1); resolveForEgress re-materializes a handle on failover
    // (D8, ADR-0043); mediaCostEstimate threads the per-modality unit defaults into the pre-egress governor (D17).
    ...(options.resolveMediaSurface === undefined
      ? {}
      : { resolveMediaSurface: options.resolveMediaSurface }),
    ...(mediaStore === undefined
      ? {}
      : { resolveForEgress: (handle, provider) => mediaStore.resolveForEgress(handle, provider) }),
    ...(options.mediaCostEstimate === undefined
      ? {}
      : { mediaCostEstimate: options.mediaCostEstimate }),
    // The user-pricing overlay for the agent node's REALIZED CostTracker (2.5.G S10, ADR-0065 §2) — so a
    // user-priced (otherwise unknown) model's realized cost is priced, not thrown as UnknownModelError.
    ...(options.resolvePrice === undefined ? {} : { resolvePrice: options.resolvePrice }),
  };

  const endpointKind = providers.endpointKind;
  return new WorkflowEngine({
    host,
    executor: createStandardNodeExecutor({ sandbox, agent, humanGate: {} }),
    // The same overlay for the workflow PRE-EGRESS budget governor (2.5.G S10) — so `budget.max_cost_microcents`
    // is enforced on a user-priced model, closing the ADR-0064 §6 cost-cap gap for the run path.
    ...(options.resolvePrice === undefined ? {} : { resolvePrice: options.resolvePrice }),
    // ADR-0071 §7: the adapter clamps an authored `max_tokens` to the model's ceiling on an OFFICIAL endpoint and
    // not on a custom one. The pre-egress estimate must make the same call, or it prices a request we never send —
    // assume official on a gateway and it under-authorizes, waving through the call the governor exists to stop.
    ...(endpointKind === undefined
      ? {}
      : {
          resolveEndpoint: (model: string): EndpointKind =>
            endpointKind(catalogModel(model)?.provider ?? 'openai'),
        }),
    // ADR-0071 §K7: a workflow turn ran on a model we could not price, so `budget.max_cost_microcents` did not
    // apply to it. `run.ts` routes this to stderr (never stdout — `--json`); `budget.strict_cost_cap` is the
    // block-instead option for a run that must not proceed unpriced.
    ...(options.onUnpriced === undefined ? {} : { onUnpriced: options.onUnpriced }),
  });
}
