/**
 * The dispatching `NodeExecutor` (1.P) — the single executor the `WorkflowEngine` holds. The engine is
 * node-type-agnostic (it calls one injected executor for every vertex), so dispatch-by-type lives
 * here: each `EngineNodeType` maps to its handler, and an unregistered type returns a loud typed
 * `failed` (never a silent skip). The `agent` arm is 1.O's `createAgentNodeExecutor`; the six non-agent
 * arms are 1.P. `createStandardNodeExecutor` is the convenience that wires the full set; surfaces
 * needing custom wiring can compose their own map with `createDispatchingNodeExecutor`.
 */

import type { EngineNodeType } from '@relavium/shared';

import type { ExpressionSandbox } from '../../expression/sandbox.js';
import { type AgentRunnerDeps, createAgentNodeExecutor } from '../agent-runner.js';
import type { NodeExecutor } from '../node-executor.js';
import { createConditionNodeExecutor } from './condition.js';
import { createFanInNodeExecutor } from './fan-in.js';
import { createFanOutNodeExecutor } from './fan-out.js';
import { createHumanGateNodeExecutor, type HumanGateNodeExecutorDeps } from './human-gate.js';
import { createInputNodeExecutor, createOutputNodeExecutor } from './io.js';
import { failed } from './scope.js';
import { createTransformNodeExecutor } from './transform.js';

/** A per-engine-node-type map of handlers. A missing type fails loud at dispatch (never silent). */
export type NodeExecutorMap = Partial<Record<EngineNodeType, NodeExecutor>>;

/** Compose a per-type handler map into the one `NodeExecutor` the engine dispatches every vertex through. */
export function createDispatchingNodeExecutor(handlers: NodeExecutorMap): NodeExecutor {
  // A media job always originates from an `agent` vertex (executeGenerativeMedia, 1.AG Section D), so the
  // engine's poll delegates to the agent handler. Forward `pollMediaJob` only when an agent handler with the
  // capability is wired. The `.bind(agent)` is a no-op for behaviour today (the handler's `pollMediaJob` is an
  // arrow that closes over its `deps` and never reads `this`); it is kept as the lint-sanctioned, future-proof
  // form should that property ever become a `this`-referencing method.
  const agent = handlers.agent;
  return {
    execute(ctx) {
      const handler = handlers[ctx.vertex.type];
      if (handler === undefined) {
        return Promise.resolve(
          failed('internal', `no executor is registered for node type '${ctx.vertex.type}'`, false),
        );
      }
      return handler.execute(ctx);
    },
    ...(agent?.pollMediaJob === undefined ? {} : { pollMediaJob: agent.pollMediaJob.bind(agent) }),
  };
}

export interface StandardNodeExecutorDeps {
  /** The shared expression sandbox for `condition` / `transform` / `fan_in` (`custom`). */
  readonly sandbox: ExpressionSandbox;
  /** Agent-node wiring (provider resolution + tools). Omit to leave `agent` vertices unhandled. */
  readonly agent?: AgentRunnerDeps;
  /** Human-gate wiring (1.Q) — resolver capabilities for the gate's text templates. Defaults to none. */
  readonly humanGate?: HumanGateNodeExecutorDeps;
}

/**
 * Wire the standard executor: the six 1.P handlers, the 1.Q `human_in_the_loop` gate, plus — when `agent`
 * deps are supplied — the 1.O agent arm. The reserved `loop`/`subworkflow`/`tool` types are intentionally
 * absent — they fail loud until their workstream lands.
 */
export function createStandardNodeExecutor(deps: StandardNodeExecutorDeps): NodeExecutor {
  // Build the handler map ONCE — none of these depend on per-dispatch `ctx`. The agent arm reads
  // `ctx.preEgress` itself (agent-runner.ts), so it needs no per-call rebuild to bridge the 1.AC budget
  // hook; the six 1.P arms + the 1.Q gate are likewise stateless across dispatches.
  const handlers: NodeExecutorMap = {
    ...(deps.agent === undefined ? {} : { agent: createAgentNodeExecutor(deps.agent) }),
    condition: createConditionNodeExecutor({ sandbox: deps.sandbox }),
    transform: createTransformNodeExecutor({ sandbox: deps.sandbox }),
    fan_in: createFanInNodeExecutor({ sandbox: deps.sandbox }),
    fan_out: createFanOutNodeExecutor(),
    human_in_the_loop: createHumanGateNodeExecutor(deps.humanGate ?? {}),
    input: createInputNodeExecutor(),
    output: createOutputNodeExecutor(),
  };
  return createDispatchingNodeExecutor(handlers);
}
