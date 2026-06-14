/**
 * Shared helpers for the non-agent node-type handlers (1.P) — the `condition` / `transform` /
 * `fan_out` / `fan_in` / `input` / `output` arms of the dispatching `NodeExecutor`.
 *
 * Each handler is a thin `NodeExecutor` that reads its `PlanConfig`, optionally evaluates an
 * expression in the 1.AB sandbox, and returns a typed {@link NodeOutcome} — it never throws (the run
 * loop flattens any uncaught throw to a single `internal` failure, erasing the precise code). These
 * helpers centralize the three things every arm needs: building the typed `failed` outcome, building
 * the one canonical sandbox scope, and mapping a thrown `SandboxError` to its outcome.
 */

import type { ErrorCode } from '@relavium/shared';

import { SandboxError } from '../../errors.js';
import type { ExpressionScope } from '../../expression/sandbox.js';
import type { NodeExecContext, NodeOutcome } from '../node-executor.js';

/** A typed `failed` outcome — handlers RETURN this, never throw (the loop would erase the code). */
export function failed(code: ErrorCode, message: string, retryable: boolean): NodeOutcome {
  return { kind: 'failed', error: { code, message, retryable } };
}

/**
 * The cancel outcome — a deliberate cancel is a DISTINCT FATAL reason, never a retryable timeout, so
 * node retry (1.S) never re-runs a cancelled node (ADR-0036 cancel-wins; expression-sandbox-spec.md
 * §cancellation). A handler returns this when it observes `ctx.signal.aborted`.
 */
export function cancelled(): NodeOutcome {
  return failed('cancelled', 'the run was cancelled', false);
}

/**
 * The completed upstream outputs as a plain record for the sandbox scope's `run.outputs`, keyed by
 * node id in **canonical (sorted) key order** so the object's key iteration is identical across a
 * checkpoint/resume replay — a determinism obligation the sandbox cannot enforce itself
 * (expression-sandbox-spec.md §run.outputs ordering; ADR-0027). `ctx.runOutputs` holds only
 * `completed` upstream outputs, so a skipped/failed/not-yet-run producer is simply absent.
 */
export function outputsRecord(runOutputs: ReadonlyMap<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const id of [...runOutputs.keys()].sort()) {
    record[id] = runOutputs.get(id);
  }
  return record;
}

/**
 * The one canonical scope a 1.P expression sees. `branches` is supplied only for a `merge_fn`. Secrets
 * are never injected (ADR-0027) — they cannot reach a handler: `ctx` carries no secret namespace, and
 * `ctx.inputs` is the raw run inputs (a `{{ secrets.* }}` reference is rejected at parse, not here).
 * `ctx` (the workflow-context namespace) is `{}` for now — threaded once the engine resolves it,
 * mirroring the AgentRunner's `RunScope` (agent-runner.ts).
 */
export function buildExpressionScope(
  ctx: NodeExecContext,
  branches?: readonly unknown[],
): ExpressionScope {
  return {
    inputs: ctx.inputs,
    ctx: {},
    outputs: outputsRecord(ctx.runOutputs),
    ...(branches === undefined ? {} : { branches }),
  };
}

/**
 * Map a value thrown by `sandbox.evaluate` to a typed outcome. The sandbox contract guarantees it only
 * ever throws a {@link SandboxError} (which carries its own `code: 'sandbox_error'` and the
 * `retryable` flag — true only for a genuine wall-clock `timeout`). Anything else is a real bug in a
 * handler, surfaced as a non-retryable `internal` failure rather than swallowed.
 */
export function mapThrownToFailure(err: unknown): NodeOutcome {
  if (err instanceof SandboxError) {
    return failed(err.code, err.message, err.retryable);
  }
  return failed('internal', 'the node handler failed unexpectedly', false);
}
