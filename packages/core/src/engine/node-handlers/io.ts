/**
 * The `input` and `output` node handlers (1.P) — the workflow's I/O bindings.
 *
 * `input` is the entry vertex (always live): it emits the resolved run inputs, so a downstream
 * `run.outputs[<input-id>]` sees the inputs namespace (also reachable directly as `inputs.*`).
 *
 * `output` is a terminal vertex that captures its upstream's output. The run loop gathers
 * `run:completed.outputs` keyed by each `output` vertex's id from the value this handler returns. With
 * a single feeder (the canonical "one input handle" case) it captures that value verbatim; with
 * several it captures a record keyed by feeder id (sorted, for determinism). `output_format` is a
 * render hint for the surface, not applied to the captured value. See node-types.md `input`/`output`.
 */

import type { NodeExecContext, NodeExecutor, NodeOutcome } from '../node-executor.js';
import { cancelled, failed, maskSecretInputs } from './scope.js';

function runInput(ctx: NodeExecContext): NodeOutcome {
  const { config } = ctx.vertex;
  if (config.kind !== 'input') {
    return failed('internal', `the input handler received a '${config.kind}' node`, false);
  }
  if (ctx.signal.aborted) {
    return cancelled();
  }
  // Emit a snapshot of the resolved inputs with `secret`-typed values MASKED to their { secret, ref }
  // marker — this node output rides `node:completed.output` / `run:completed.outputs`, and a raw secret
  // must never reach an event payload (the engine masks `inputs` only for `run:started`).
  return { kind: 'completed', output: maskSecretInputs(ctx.inputs, ctx.secretInputNames) };
}

function runOutput(ctx: NodeExecContext): NodeOutcome {
  const { config } = ctx.vertex;
  if (config.kind !== 'output') {
    return failed('internal', `the output handler received a '${config.kind}' node`, false);
  }
  if (ctx.signal.aborted) {
    return cancelled();
  }
  const feeders = [...ctx.vertex.dependencies].sort().filter((id) => ctx.runOutputs.has(id));
  if (feeders.length === 0) {
    return { kind: 'completed', output: null };
  }
  if (feeders.length === 1) {
    const [only] = feeders;
    return { kind: 'completed', output: only === undefined ? null : ctx.runOutputs.get(only) };
  }
  const captured: Record<string, unknown> = {};
  for (const id of feeders) {
    captured[id] = ctx.runOutputs.get(id);
  }
  return { kind: 'completed', output: captured };
}

export function createInputNodeExecutor(): NodeExecutor {
  return { execute: (ctx) => Promise.resolve(runInput(ctx)) };
}

export function createOutputNodeExecutor(): NodeExecutor {
  return { execute: (ctx) => Promise.resolve(runOutput(ctx)) };
}
