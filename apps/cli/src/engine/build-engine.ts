import {
  BUILTIN_TOOLS,
  WorkflowEngine,
  createExpressionSandbox,
  createStandardNodeExecutor,
  createToolRegistry,
  type AgentRunnerDeps,
  type ExecutionHost,
  type McpCapability,
  type ToolDef,
  type ToolHost,
} from '@relavium/core';
import type { MediaCostEstimate, MediaSurface } from '@relavium/shared';

import { createCliHost } from './host.js';
import { createProviderResolver, type ProviderResolver } from './providers.js';

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
}

/**
 * Assemble a {@link WorkflowEngine} for a CLI run: a node-backed host, the standard node executor
 * (the six non-agent handlers + the agent arm), the expression sandbox, and a **fail-closed**
 * `ToolHost`. `host`/`providers` are injectable so tests drive a stub provider + the in-memory host.
 *
 * The `ToolHost` carries only what is explicitly wired: when `options.mcp` is present (2.R Step 3b) it
 * gets the `McpCapability` (so a granted MCP tool can `tools/call`); otherwise it is `{}` — every
 * capability (fs / process / egress / …) absent, so a built-in tool that needs one is cleanly
 * "unavailable" rather than an insecure stub. Wiring the remaining capabilities (with a dedicated
 * security review; egress SSRF is already deferred per deferred-tasks/§2.S) is a follow-up workstream.
 */
export async function buildEngine(options: BuildEngineOptions = {}): Promise<WorkflowEngine> {
  const host = options.host ?? createCliHost();
  const providers = options.providers ?? createProviderResolver();
  const sandbox = await createExpressionSandbox();

  // Compose the inbound MCP tools (2.R Step 3b): the discovered namespaced ToolDefs join the built-ins in the
  // registry AND `AgentRunnerDeps.tools` below (so a granted MCP tool is surfaced to the LLM), and the
  // McpCapability is wired onto the registry's `ToolHost.mcp` so a `tools/call` routes to the owning connection.
  // Absent ⇒ built-ins only + a fail-closed `{}` host (the engine's pre-2.R posture, unchanged).
  const tools =
    options.mcp === undefined ? BUILTIN_TOOLS : [...BUILTIN_TOOLS, ...options.mcp.toolDefs];
  const toolHost: ToolHost = options.mcp === undefined ? {} : { mcp: options.mcp.capability };
  const registry = createToolRegistry({ tools, host: toolHost });

  // The single host CAS (`host.mediaStore`) also backs the D8 failover re-materialization: resolve a durable
  // handle in a transcript message to the in-flight source a provider needs, before egress. Bound here (when a
  // store is wired) so the fallback chain stays byte-free/platform-free. `ProviderId === LlmProviderId`, so the
  // `MediaStore.resolveForEgress` signature matches `ChainCapabilities['resolveForEgress']` exactly.
  const mediaStore = host.mediaStore;
  const agent: AgentRunnerDeps = {
    resolveProvider: providers.resolveProvider,
    keyFor: providers.keyFor,
    registry,
    tools,
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    now: () => Date.now(),
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
  };

  return new WorkflowEngine({
    host,
    executor: createStandardNodeExecutor({ sandbox, agent, humanGate: {} }),
  });
}
