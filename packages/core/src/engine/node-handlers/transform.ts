/**
 * The `transform` node handler (1.P). Evaluates the node's single `transform` JS expression in the
 * 1.AB sandbox; the (JSON-serializable) result becomes the node's output (run.outputs[nodeId]). No
 * LLM call, no state mutation — the sandbox deep-freezes the scope, and the handler returns a NEW
 * value rather than writing into `ctx.inputs` / `ctx.runOutputs`. See workflow-yaml-spec.md §transform.
 */

import type { ExpressionSandbox } from '../../expression/sandbox.js';
import type { NodeExecContext, NodeExecutor, NodeOutcome } from '../node-executor.js';
import { buildExpressionScope, cancelled, failed, mapThrownToFailure } from './scope.js';

export interface TransformNodeExecutorDeps {
  /** The shared, pre-loaded expression sandbox (one instance, constructed at engine-wiring time). */
  readonly sandbox: ExpressionSandbox;
}

function runTransform(ctx: NodeExecContext, deps: TransformNodeExecutorDeps): NodeOutcome {
  const { config } = ctx.vertex;
  if (config.kind !== 'transform') {
    return failed('internal', `the transform handler received a '${config.kind}' node`, false);
  }
  if (ctx.signal.aborted) {
    return cancelled();
  }
  let value: unknown;
  try {
    value = deps.sandbox.evaluate({
      expression: config.node.transform,
      kind: 'transform',
      scope: buildExpressionScope(ctx),
    });
  } catch (err) {
    return ctx.signal.aborted ? cancelled() : mapThrownToFailure(err);
  }
  if (ctx.signal.aborted) {
    return cancelled();
  }
  // The sandbox already guarantees a transform result is JSON-serializable. The node's optional
  // `output_schema` is NOT deep-validated here: deep JSON-Schema conformance needs a validator (a new
  // runtime dependency → ADR), a recorded deferral shared with the agent node (deferred-tasks.md).
  return { kind: 'completed', output: value };
}

export function createTransformNodeExecutor(deps: TransformNodeExecutorDeps): NodeExecutor {
  return { execute: (ctx) => Promise.resolve(runTransform(ctx, deps)) };
}
