/**
 * The `transform` node handler (1.P). Evaluates the node's single `transform` JS expression in the
 * 1.AB sandbox; the (JSON-serializable) result becomes the node's output (run.outputs[nodeId]). No
 * LLM call, no state mutation — the sandbox deep-freezes the scope, and the handler returns a NEW
 * value rather than writing into `ctx.inputs` / `ctx.runOutputs`. See workflow-yaml-spec.md §transform.
 */

import type { ExpressionSandbox } from '../../expression/sandbox.js';
import type { NodeExecContext, NodeExecutor, NodeOutcome } from '../node-executor.js';
import { outputSchemaMiss } from '../../output-schema.js';
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
  // The sandbox already guarantees a transform result is JSON-serializable; `output_schema` adds
  // CONFORMANCE on top ([ADR-0092](../../../../docs/decisions/0092-output-schema-is-validated-by-the-compiler-we-already-own.md)
  // §4). This comment used to say deep validation needed a new runtime dependency and cite a deferral —
  // it did not: the project already owned a JSON-Schema→Zod compiler at the MCP boundary, one package
  // away, and the deferral outlived the reason for it.
  //
  // The schema was compiled and accepted at PARSE, so a miss here is the transform's result failing the
  // author's own contract, not a bad schema. The message names nothing (ADR-0092 §5).
  const { output_schema: outputSchema } = config.node;
  const miss = outputSchema === undefined ? undefined : outputSchemaMiss(outputSchema, value);
  if (miss !== undefined) {
    return failed(miss.code, `transform node '${config.node.id}': ${miss.message}`, false);
  }
  return { kind: 'completed', output: value };
}

export function createTransformNodeExecutor(deps: TransformNodeExecutorDeps): NodeExecutor {
  return { execute: (ctx) => Promise.resolve(runTransform(ctx, deps)) };
}
