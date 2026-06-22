import {
  BUILTIN_TOOLS,
  WorkflowEngine,
  createExpressionSandbox,
  createStandardNodeExecutor,
  createToolRegistry,
  type AgentRunnerDeps,
  type ExecutionHost,
} from '@relavium/core';

import { createCliHost } from './host.js';
import { createProviderResolver, type ProviderResolver } from './providers.js';

export interface BuildEngineOptions {
  /** Override the execution host (tests use the in-memory reference). */
  readonly host?: ExecutionHost;
  /** Override the provider seam (tests inject a stub provider + dummy key). */
  readonly providers?: ProviderResolver;
}

/**
 * Assemble a {@link WorkflowEngine} for a CLI run: a node-backed host, the standard node executor
 * (the six non-agent handlers + the agent arm), the expression sandbox, and a **fail-closed**
 * `ToolHost`. `host`/`providers` are injectable so tests drive a stub provider + the in-memory host.
 *
 * The `ToolHost` is `{}` — every capability (fs / process / egress / …) is absent, so a built-in
 * tool that needs one is cleanly "unavailable" rather than an insecure stub. Wiring those
 * capabilities (with a dedicated security review; egress SSRF is already deferred per
 * deferred-tasks/§2.S) is a follow-up workstream, not 2.D.
 */
export async function buildEngine(options: BuildEngineOptions = {}): Promise<WorkflowEngine> {
  const host = options.host ?? createCliHost();
  const providers = options.providers ?? createProviderResolver();
  const sandbox = await createExpressionSandbox();

  const registry = createToolRegistry({ tools: BUILTIN_TOOLS, host: {} });

  const agent: AgentRunnerDeps = {
    resolveProvider: providers.resolveProvider,
    keyFor: providers.keyFor,
    registry,
    tools: BUILTIN_TOOLS,
    sleep: (ms) =>
      new Promise((resolveSleep) => {
        setTimeout(resolveSleep, ms);
      }),
    now: () => Date.now(),
  };

  return new WorkflowEngine({
    host,
    executor: createStandardNodeExecutor({ sandbox, agent, humanGate: {} }),
  });
}
