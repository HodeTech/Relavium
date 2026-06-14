/**
 * The `fan_out` node handler (1.P) — the split half of an authored `parallel` block. The spread is
 * edge-driven: the DAG builder gives every `parallel_of` member an in-edge from this vertex, so
 * completing the `fan_out` is what makes its branch dependents ready (the run loop dispatches them
 * concurrently up to `max_parallel`). A v1.0 `parallel` node carries only `parallel_of` (no per-branch
 * data to slice), so the `fan_out` produces no output of its own. See node-types.md `fan_out_config`.
 */

import type { NodeExecContext, NodeExecutor, NodeOutcome } from '../node-executor.js';
import { cancelled, failed } from './scope.js';

function runFanOut(ctx: NodeExecContext): NodeOutcome {
  const { config } = ctx.vertex;
  if (config.kind !== 'fan_out') {
    return failed('internal', `the fan_out handler received a '${config.kind}' node`, false);
  }
  if (ctx.signal.aborted) {
    return cancelled();
  }
  return { kind: 'completed', output: null };
}

export function createFanOutNodeExecutor(): NodeExecutor {
  return { execute: (ctx) => Promise.resolve(runFanOut(ctx)) };
}
