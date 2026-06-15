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

import type { ErrorCode, MaskedSecret } from '@relavium/shared';

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
 *
 * **Secret invariant (load-bearing):** this does NOT re-mask — it passes node outputs through verbatim.
 * The guarantee that `run.outputs` never carries a raw `secret`-typed value rests entirely on the
 * **`input` handler masking at the ingress** (io.ts `maskSecretInputs`) and on every expression handler
 * reading inputs through {@link buildExpressionScope} (also masked). Any future node-type handler that
 * writes `ctx.inputs`-derived data into its returned output MUST mask it (`maskSecretInputs`) first, or a
 * raw secret would enter `run.outputs` here unmasked and then a `node:completed` event payload.
 */
export function outputsRecord(runOutputs: ReadonlyMap<string, unknown>): Record<string, unknown> {
  // A null-prototype record (defense-in-depth: a node id cannot be `__proto__` under the kebab grammar,
  // but a plain object would let one pollute Object.prototype) — consistent with the fan-in accumulator.
  const record: Record<string, unknown> = { __proto__: null };
  // Sort by UTF-16 code unit via an explicit comparator (NOT `localeCompare` — locale-dependent ordering
  // would break the cross-environment resume determinism this sort exists for).
  for (const id of [...runOutputs.keys()].sort(byCodeUnit)) {
    record[id] = runOutputs.get(id);
  }
  return record;
}

/** Deterministic, locale-independent string order (UTF-16 code unit) — for resume-reproducible records. */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Replace every `secret`-typed input with its {@link MaskedSecret} marker (`{ secret: true, ref }`),
 * leaving non-secret inputs untouched. The single masking point shared by the `input` node's output and
 * the expression sandbox's `inputs` namespace, so a raw secret value never leaves a handler — neither
 * into an event payload nor into a `condition`/`transform`/`merge_fn` expression (CLAUDE.md rule 6; the
 * sandbox's "secrets are never injected — the caller filters" contract).
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
 * The one canonical scope a 1.P expression sees. `branches` is supplied only for a `merge_fn`. The
 * `inputs` namespace is **secret-masked** ({@link maskSecretInputs}) so a `secret`-typed input is the
 * marker object, never the raw value — an expression that reads it cannot launder a secret into an
 * output (ADR-0027; the sandbox's "secrets are never injected" contract). `ctx` is the **resolved**
 * workflow-context namespace (`NodeExecContext.ctx`), folded once at run start by the engine and threaded
 * here, so a bare `ctx.key` read resolves — mirroring the AgentRunner's `RunScope` (agent-runner.ts).
 */
export function buildExpressionScope(
  ctx: NodeExecContext,
  branches?: readonly unknown[],
): ExpressionScope {
  return {
    inputs: maskSecretInputs(ctx.inputs, ctx.secretInputNames),
    ctx: ctx.ctx,
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
