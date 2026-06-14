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
import { createInputNodeExecutor, createOutputNodeExecutor } from './io.js';
import { failed } from './scope.js';
import { createTransformNodeExecutor } from './transform.js';

/** A per-engine-node-type map of handlers. A missing type fails loud at dispatch (never silent). */
export type NodeExecutorMap = Partial<Record<EngineNodeType, NodeExecutor>>;

/** Compose a per-type handler map into the one `NodeExecutor` the engine dispatches every vertex through. */
export function createDispatchingNodeExecutor(handlers: NodeExecutorMap): NodeExecutor {
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
  };
}

export interface StandardNodeExecutorDeps {
  /** The shared expression sandbox for `condition` / `transform` / `fan_in` (`custom`). */
  readonly sandbox: ExpressionSandbox;
  /** Agent-node wiring (provider resolution + tools). Omit to leave `agent` vertices unhandled. */
  readonly agent?: AgentRunnerDeps;
}

/**
 * Wire the standard executor: the six 1.P handlers plus, when `agent` deps are supplied, the 1.O agent
 * arm. `human_in_the_loop` (1.Q) and the reserved `loop`/`subworkflow`/`tool` types are intentionally
 * absent — they fail loud until their workstream lands.
 */
export function createStandardNodeExecutor(deps: StandardNodeExecutorDeps): NodeExecutor {
  return createDispatchingNodeExecutor({
    ...(deps.agent === undefined ? {} : { agent: createAgentNodeExecutor(deps.agent) }),
    condition: createConditionNodeExecutor({ sandbox: deps.sandbox }),
    transform: createTransformNodeExecutor({ sandbox: deps.sandbox }),
    fan_in: createFanInNodeExecutor({ sandbox: deps.sandbox }),
    fan_out: createFanOutNodeExecutor(),
    input: createInputNodeExecutor(),
    output: createOutputNodeExecutor(),
  });
}
