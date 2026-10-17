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

import { byCodeUnit, type ErrorCode, type MaskedSecret } from '@relavium/shared';

import { SandboxError, WorkflowContextError } from '../../errors.js';
import {
  createWorkflowContextProjection,
  ownSecretInputNames,
} from '../../interpolation/provenance.js';
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
 * The completed outputs of this node's **transitive dependency closure**, as a plain record for the
 * sandbox scope's `run.outputs`, keyed by node id in **canonical (sorted) key order** so the object's key
 * iteration is identical across a checkpoint/resume replay — a determinism obligation the sandbox cannot
 * enforce itself (expression-sandbox-spec.md §run.outputs ordering; ADR-0027). A node in the closure that
 * is skipped, failed, or not yet run is simply absent.
 *
 * **The closure, not the whole completed map** ([ADR-0093](../../../../docs/decisions/0093-an-expression-sees-only-what-it-is-ordered-after.md)
 * §1). `ctx.runOutputs` holds every completed node in the run, and this docblock used to call them
 * "upstream" — they were not. An expression could read a node it is not ordered after, which in practice
 * meant reading a producer that had not run yet and comparing against `undefined`: `undefined === 'x'` is
 * `false`, so a `condition` took the false branch and the run continued as though the author's rule had
 * been evaluated.
 *
 * Narrowing on its own does **not** fix that — it makes more ids absent, and an absent id still compares
 * silently false. It draws the boundary that dag.ts's parse-time scan then enforces, and it makes the
 * scope a static, plan-derived property that is identical on a replay by construction.
 *
 * This projection preserves upstream outputs verbatim; it does not scrub historical or arbitrary
 * sensitive content. Newly declared secret inputs/context are excluded by buildExpressionScope and
 * the VM provenance boundary. The input handler separately preserves display markers. Trusted custom
 * executors and previously persisted outputs remain outside that exclusion guarantee (ADR-0113).
 */
export function outputsRecord(
  runOutputs: ReadonlyMap<string, unknown>,
  ancestors: readonly string[],
): Record<string, unknown> {
  // A null-prototype record (defense-in-depth: a node id cannot be `__proto__` under the kebab grammar,
  // but a plain object would let one pollute Object.prototype) — consistent with the fan-in accumulator.
  const record: Record<string, unknown> = { __proto__: null };
  // Iterate the CLOSURE, not the completed map: this is the projection, not a filter over everything.
  // `ancestors` arrives already sorted by code unit from the builder; re-sorted here anyway so the record's
  // key order is this function's own guarantee rather than a caller's, and because `localeCompare` ordering
  // anywhere on this path would break the cross-environment resume determinism the sort exists for.
  for (const id of [...ancestors].sort(byCodeUnit)) {
    // A node in the closure that has not completed (or was skipped) is simply absent — the same shape as
    // before, since `runOutputs` only ever held completed outputs.
    if (runOutputs.has(id)) {
      record[id] = runOutputs.get(id);
    }
  }
  return record;
}

/**
 * Deterministic, locale-independent string order — re-exported from `@relavium/shared` so this package's
 * handlers keep their existing import while the RULE has one home. There were three copies of it, and they
 * have to agree: each fixes the key order of something a resumed run rebuilds.
 */
export { byCodeUnit };

/**
 * Replace every declared secret input with its display/input-node MaskedSecret marker. Expressions
 * use buildExpressionScope's separate denied-key protocol; these markers are not VM values.
 */
export function maskSecretInputs(
  inputs: Readonly<Record<string, unknown>>,
  secretInputNames: ReadonlySet<string>,
): Record<string, unknown> {
  // A null-prototype record: an input name MAY be `__proto__` (the input-name grammar is `[A-Za-z0-9_-]+`,
  // which permits `_`), so a plain object would let `masked['__proto__'] = …` pollute Object.prototype.
  const masked: Record<string, unknown> = { __proto__: null };
  for (const [key, value] of Object.entries(inputs)) {
    masked[key] = secretInputNames.has(key)
      ? ({ secret: true, ref: `inputs.${key}` } satisfies MaskedSecret)
      : value;
  }
  return masked;
}

/**
 * The canonical expression scope owns the clean context projection and secret-input membership.
 * Present denied inputs become private null placeholders without reading their raw values; the VM
 * replaces those slots with denied accessors. Omitted optional inputs remain absent. Branch outputs
 * and transitive upstream outputs retain their existing semantics.
 */
export function buildExpressionScope(
  ctx: NodeExecContext,
  branches?: readonly unknown[],
): ExpressionScope {
  const names = ownSecretInputNames(ctx.secretInputNames);
  const inputs: Record<string, unknown> = { __proto__: null };
  for (const key of Object.keys(ctx.inputs)) {
    // Do not read a denied value, including a caller accessor. Null is private transport only.
    inputs[key] = names.secretInputNames.has(key) ? null : ctx.inputs[key];
  }
  return {
    inputs: Object.freeze(inputs),
    deniedInputNames: names.deniedInputNames,
    ctx: createWorkflowContextProjection(ctx.ctx),
    outputs: outputsRecord(ctx.runOutputs, ctx.vertex.ancestors),
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
  if (err instanceof WorkflowContextError) return failed(err.code, err.message, err.retryable);
  if (err instanceof SandboxError) {
    return failed(err.code, err.message, err.retryable);
  }
  return failed('internal', 'the node handler failed unexpectedly', false);
}
