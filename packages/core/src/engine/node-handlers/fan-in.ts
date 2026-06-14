/**
 * The `fan_in` node handler (1.P) — the merge half of an authored `parallel`/`merge` pair. The run
 * loop already schedules the join (it dispatches the `fan_in` only once every branch has SETTLED, and
 * a condition-skipped branch counts as settled so the join never hangs); this handler performs the
 * MERGE the engine deferred to it. It gathers the branch outputs in the stable `branchNodeIds` order
 * (NOT arrival order, NOT `dependencies` order) — omitting any branch absent from `runOutputs` (a
 * skipped/failed branch never produced an output) — and combines them per `merge_strategy`.
 *
 * `wait_first` (`merge_strategy: first`) is executor-only here: the engine still waits for all
 * branches, so "first" is the first by `branchNodeIds` declaration order among the settled survivors.
 * True early-cancellation of the losing branches is a deferred refinement (it needs engine-owned
 * cross-vertex cancellation) — see run-plan.md §fan-in and deferred-tasks.md.
 */

import type { ExpressionSandbox } from '../../expression/sandbox.js';
import type { NodeExecContext, NodeExecutor, NodeOutcome } from '../node-executor.js';
import { buildExpressionScope, cancelled, failed, mapThrownToFailure } from './scope.js';

export interface FanInNodeExecutorDeps {
  /** The shared, pre-loaded expression sandbox — used only for a `custom` `merge_fn`. */
  readonly sandbox: ExpressionSandbox;
}

/** The settled branch outputs in stable `branchNodeIds` order, omitting branches absent from runOutputs. */
function branchOutputs(ctx: NodeExecContext, branchNodeIds: readonly string[]): unknown[] {
  const outputs: unknown[] = [];
  for (const id of branchNodeIds) {
    if (ctx.runOutputs.has(id)) {
      outputs.push(ctx.runOutputs.get(id));
    }
  }
  return outputs;
}

/** `object_merge`: shallow-merge the branch objects, later (in branch order) winning on key collision. */
function mergeObjects(branches: readonly unknown[]): NodeOutcome {
  // A null-prototype accumulator: a branch carrying an own `__proto__`/`constructor` key lands as a
  // plain own property (no setter to trip), so a merge can never pollute Object.prototype.
  const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const branch of branches) {
    if (branch === null || typeof branch !== 'object' || Array.isArray(branch)) {
      return failed(
        'validation',
        'object_merge requires every branch output to be a JSON object',
        false,
      );
    }
    Object.assign(merged, branch);
  }
  return { kind: 'completed', output: merged };
}

function runCustomMerge(
  ctx: NodeExecContext,
  sandbox: ExpressionSandbox,
  mergeFn: string,
  branches: readonly unknown[],
): NodeOutcome {
  let value: unknown;
  try {
    value = sandbox.evaluate({
      expression: mergeFn,
      kind: 'merge_fn',
      scope: buildExpressionScope(ctx, branches),
    });
  } catch (err) {
    return ctx.signal.aborted ? cancelled() : mapThrownToFailure(err);
  }
  if (ctx.signal.aborted) {
    return cancelled();
  }
  return { kind: 'completed', output: value };
}

function runFanIn(ctx: NodeExecContext, deps: FanInNodeExecutorDeps): NodeOutcome {
  const { config } = ctx.vertex;
  if (config.kind !== 'fan_in') {
    return failed('internal', `the fan_in handler received a '${config.kind}' node`, false);
  }
  if (ctx.signal.aborted) {
    return cancelled();
  }
  const branches = branchOutputs(ctx, config.branchNodeIds);
  switch (config.mergeStrategy) {
    case 'concat':
      // An ordered array of the branch outputs (each output is one element).
      return { kind: 'completed', output: branches };
    case 'object_merge':
      return mergeObjects(branches);
    case 'first':
      // The first surviving branch by declaration order (executor-only wait_first).
      return { kind: 'completed', output: branches.length > 0 ? branches[0] : null };
    case 'custom': {
      const mergeFn = config.mergeFn ?? config.node.merge_fn;
      if (mergeFn === undefined) {
        // The workflow-level refinement guarantees `merge_fn` for `custom`; defensive belt-and-suspenders.
        return failed('validation', "merge_strategy 'custom' requires a merge_fn", false);
      }
      return runCustomMerge(ctx, deps.sandbox, mergeFn, branches);
    }
    default: {
      // Exhaustiveness guard — a future fifth merge_strategy fails loud at BOTH compile time (the
      // `never` assignment) and runtime, never silently producing an undefined merge.
      const exhaustive: never = config.mergeStrategy;
      return failed('internal', `unknown merge_strategy '${String(exhaustive)}'`, false);
    }
  }
}

export function createFanInNodeExecutor(deps: FanInNodeExecutorDeps): NodeExecutor {
  return { execute: (ctx) => Promise.resolve(runFanIn(ctx, deps)) };
}
