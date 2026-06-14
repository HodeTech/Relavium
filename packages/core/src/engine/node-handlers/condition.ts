/**
 * The `condition` node handler (1.P). Evaluates the node's `expression` ONCE in the 1.AB sandbox and
 * routes to the FIRST branch whose `when` value strictly equals (`===`, no coercion) the result, else
 * the `default`. Returns a `branch` outcome carrying exactly the selected immediate target node id —
 * the run loop skip-propagates every other dependent (engine.ts #hasLiveEdge / #propagateSkips); the
 * handler never dims a node itself. See workflow-yaml-spec.md §condition and node-types.md.
 */

import type { ExpressionSandbox } from '../../expression/sandbox.js';
import type { NodeExecContext, NodeExecutor, NodeOutcome } from '../node-executor.js';
import { buildExpressionScope, cancelled, failed, mapThrownToFailure } from './scope.js';

export interface ConditionNodeExecutorDeps {
  /** The shared, pre-loaded expression sandbox (one instance, constructed at engine-wiring time). */
  readonly sandbox: ExpressionSandbox;
}

function runCondition(ctx: NodeExecContext, deps: ConditionNodeExecutorDeps): NodeOutcome {
  const { config } = ctx.vertex;
  if (config.kind !== 'condition') {
    return failed('internal', `the condition handler received a '${config.kind}' node`, false);
  }
  // Cancel-wins: check before engaging the sandbox, and again after, so a cancel landing during a
  // long evaluation is never mis-reported as a completed branch (ADR-0036; Trap 5).
  if (ctx.signal.aborted) {
    return cancelled();
  }
  const { node } = config;
  let result: unknown;
  try {
    result = deps.sandbox.evaluate({
      expression: node.expression,
      kind: 'condition',
      scope: buildExpressionScope(ctx),
    });
  } catch (err) {
    return ctx.signal.aborted ? cancelled() : mapThrownToFailure(err);
  }
  if (ctx.signal.aborted) {
    return cancelled();
  }
  // The sandbox guarantees a condition result is boolean | string | number. Select the FIRST branch
  // whose `when` strictly equals it, else `default` — never >1 target (a duplicate `when` cannot route
  // both ways), never an empty `selected` that would silently prune the whole downstream (Trap 1).
  const match = node.branches.find((branch) => branch.when === result);
  const target = match?.target_node ?? node.default;
  if (target === undefined) {
    return failed('validation', 'the condition matched no branch and declares no default', false);
  }
  // Every branch `target_node` and `default` is materialized as a dependent of the condition vertex
  // (dag.ts wireConditionNode), so this always holds — the cross-check turns a builder regression into
  // a loud failure instead of a silent mis-route to an id the run loop cannot keep live.
  if (!ctx.vertex.dependents.includes(target)) {
    return failed(
      'internal',
      `the condition selected '${target}', which is not a downstream node`,
      false,
    );
  }
  return { kind: 'branch', selected: [target] };
}

export function createConditionNodeExecutor(deps: ConditionNodeExecutorDeps): NodeExecutor {
  return { execute: (ctx) => Promise.resolve(runCondition(ctx, deps)) };
}
