/**
 * Expression sandbox (1.AB) — the deterministic, resource-capped QuickJS-wasm evaluator for the bare
 * JavaScript `condition` / `transform` / `merge_fn` expressions, per
 * [ADR-0027](../../../../docs/decisions/0027-expression-sandbox.md) and its canonical contract
 * [expression-sandbox-spec.md](../../../../docs/reference/shared-core/expression-sandbox-spec.md).
 *
 * Platform-free (CLAUDE.md rule 5): the wasm is embedded in a single-file **sync** variant and
 * instantiated through the standard `WebAssembly` global — `quickjs-emscripten-core` is the pure-TS
 * bindings, and we never touch the meta-package's default `getQuickJS()` loader (it imports
 * `node:fs`). The variant's only host access is a runtime-guarded `await import("module")` that is
 * dead in the Tauri WebView, so `@relavium/core` keeps zero **static** platform imports.
 *
 * Security/determinism model (see the spec for the full contract):
 * - **The wasm VM isolation is the boundary** — the QuickJS VM runs on its own wasm heap with no host
 *   reference reachable (we inject zero host functions). The `Eval` intrinsic stays ON because
 *   `evalCode` requires it to compile; `eval`/`Function` therefore exist *inside* the VM but are
 *   harmless — they cannot escape the isolation and reach nothing a normal expression cannot (no
 *   `Date`, no `Math.random`, no `Promise`/async, no I/O — none of those capabilities exist).
 * - **Deny-by-default capabilities** — a minimal intrinsic set: `Date`/`Promise`/`Proxy`/`TypedArrays`
 *   are never created, and `Math.random` is neutralized, so the surface is deterministic and I/O-free.
 * - **JSON-only marshaling** — the scope crosses as plain JSON (host stringify → VM parse), so no live
 *   host object/getter ever enters and a `{"__proto__":…}` key lands as own data (no prototype
 *   pollution); it is deep-frozen and bound as `const` lexical names inside a strict IIFE.
 * - **Caps are non-idempotent safety nets** — quickjs exposes a wall-clock deadline (not an opcode
 *   counter), so a cap-trip surfaces as the error path, never a stable result. A fresh runtime+context
 *   is created and disposed per evaluation (full isolation; OOM-safe — a tripped runtime is discarded).
 */
import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type Intrinsics,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
  type VmCallResult,
} from 'quickjs-emscripten-core';

import { SandboxError } from '../errors.js';

/** Which authored construct the expression came from — drives the per-kind result contract. */
export type ExpressionKind = 'condition' | 'transform' | 'merge_fn';

/**
 * The one canonical scope an expression sees. `branches` is present only for `merge_fn` (the branch
 * outputs in static `parallel_of` declaration order). Secrets are never injected — the caller filters
 * any secret-tainted value out before evaluation (defense-in-depth over the 1.L2 parse-time gate).
 */
export interface ExpressionScope {
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly ctx: Readonly<Record<string, unknown>>;
  /** Completed upstream node outputs, keyed by node id — surfaced to the expression as `run.outputs`. */
  readonly outputs: Readonly<Record<string, unknown>>;
  /** `merge_fn` only — branch outputs in static declaration order (never arrival order). */
  readonly branches?: readonly unknown[];
}

/** Per-evaluation resource caps. Fixed engine constants in v1.0 (see {@link DEFAULT_SANDBOX_LIMITS}). */
export interface SandboxLimits {
  /** Wall-clock deadline per evaluation (ms). A trip is the one retryable, non-idempotent failure. */
  readonly timeoutMs: number;
  /** Heap cap per evaluation (bytes). */
  readonly memoryBytes: number;
  /** Stack cap per evaluation (bytes) — bounds recursion. */
  readonly stackBytes: number;
}

/**
 * The v1.0 fixed caps (canonical home: expression-sandbox-spec.md), confirmed by the 1.AB perf spike.
 * The 1s wall-clock budget is far above a real expression (~1ms measured) yet still stops a runaway
 * fast; it is deliberately loose enough to absorb OS scheduling jitter on a busy host — a tighter
 * budget spuriously trips a trivial eval when the process is descheduled mid-call (and a timeout is
 * the one retryable failure, so even a spurious trip is recovered by node retry).
 */
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = Object.freeze({
  timeoutMs: 1000,
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 256 * 1024,
});

/** One expression evaluation request. */
export interface EvaluateInput {
  /** The bare JS expression (not `{{ … }}`-wrapped). Its JS syntax is validated here, not at parse. */
  readonly expression: string;
  readonly kind: ExpressionKind;
  readonly scope: ExpressionScope;
  /** Override the sandbox's default caps for this evaluation (rarely needed). */
  readonly limits?: SandboxLimits;
}

/** A ready sandbox: the wasm module is loaded once; `evaluate` is synchronous. */
export interface ExpressionSandbox {
  /**
   * Evaluate one expression against its scope. Returns the (validated) result, or throws a
   * {@link SandboxError} classified by `reason` — the engine maps it to a `sandbox_error` run event.
   */
  evaluate(input: EvaluateInput): unknown;
}

/**
 * Deny-by-default capabilities. Only the audited pure intrinsics are enabled; every non-deterministic
 * or I/O-bearing capability is left off — `Date`, `Promise` (so evaluation is synchronous), `Proxy`,
 * and the typed-array/bignum families. `Eval` MUST stay enabled: quickjs `evalCode` requires the eval
 * intrinsic to compile, and removing it disables evaluation entirely. `eval`/`Function` are thus
 * reachable inside the VM but harmless — the wasm isolation is the boundary, and nothing they can run
 * reaches a host reference or a forbidden capability (`Date`/`Math.random`/async/I/O do not exist).
 */
const SANDBOX_INTRINSICS: Intrinsics = {
  BaseObjects: true,
  Eval: true,
  JSON: true,
  MapSet: true,
  RegExp: true,
  Date: false,
  Promise: false,
  Proxy: false,
  TypedArrays: false,
  StringNormalize: false,
  RegExpCompiler: false,
  // NOTE: the bignum family flags below are INERT in the pinned single-file variant (BigInt is present
  // in the VM regardless), so the sandbox rejects a top-level BigInt RESULT at validateResult instead.
  BigInt: false,
  BigFloat: false,
  BigDecimal: false,
  OperatorOverloading: false,
  BignumExt: false,
};

/**
 * Reject a pathologically deep scope before it reaches the VM. A very deeply nested literal overflows
 * the HOST stack inside `evalCode` (a raw `RangeError`, not a returned VM error) and the wasm teardown
 * then prints an alarming abort to stderr; an explicit bound keeps the failure a clean SandboxError.
 * Real run state is shallow; this only rejects adversarial input, far below the host-overflow depth.
 */
const MAX_SCOPE_DEPTH = 256;

/**
 * Reject a pathologically large expression *string* before `evalCode`. A deeply-nested expression
 * overflows the HOST stack inside the parser (a raw `RangeError` whose stack-vs-runtime classification
 * is then host-engine-specific) — this bound, the companion to {@link MAX_SCOPE_DEPTH} for the scope,
 * keeps that branch unreachable for any realistic input (a real `condition`/`transform`/`merge_fn` is
 * tens to a few hundred chars; 100 KB is orders of magnitude above any authored expression).
 */
const MAX_EXPRESSION_CHARS = 100_000;

/**
 * Load the QuickJS wasm module once per process (instantiation is the expensive step; runtimes and
 * contexts are cheap and created fresh per evaluation). Memoized so concurrent callers share it.
 */
let modulePromise: Promise<QuickJSWASMModule> | undefined;
function loadModule(): Promise<QuickJSWASMModule> {
  // Reset the cache on rejection so a transient instantiation failure (e.g. cold-start memory pressure)
  // does not poison every later call: a rejected promise is not `undefined`, so `??=` would never retry.
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant).catch((error: unknown) => {
    modulePromise = undefined;
    throw error;
  });
  return modulePromise;
}

/** Create a ready sandbox (loads the wasm module once). The returned `evaluate` is synchronous. */
export async function createExpressionSandbox(options?: {
  limits?: SandboxLimits;
}): Promise<ExpressionSandbox> {
  const module = await loadModule();
  const defaultLimits = options?.limits ?? DEFAULT_SANDBOX_LIMITS;
  return {
    evaluate(input: EvaluateInput): unknown {
      try {
        const limits = input.limits ?? defaultLimits;
        const program = buildProgram(input.expression, input.scope);
        const outcome = runProgram(module, program, limits);
        return validateResult(outcome.value, outcome.type, input.kind);
      } catch (err) {
        // Contract guarantee: `evaluate` only ever throws a classified SandboxError. A SandboxError
        // passes through; any OTHER host throw — notably a failure constructing the runtime/context,
        // which happens before `runProgram`'s own try — is classified here rather than leaked raw.
        throw err instanceof SandboxError ? err : hostErrorToSandbox(err);
      }
    },
  };
}

/**
 * Build the single VM program: neutralize `Math.random`, JSON-parse the (double-encoded) scope into
 * a deep-frozen object, bind it as `const` lexical names, and return the author's expression. The
 * whole program runs in strict mode; the VM is the security boundary, so inlining the expression is
 * safe (it cannot reach `eval`/`Function`/`Date`/I/O — none exist).
 */
function buildProgram(expression: string, scope: ExpressionScope): string {
  if (expression.length > MAX_EXPRESSION_CHARS) {
    throw new SandboxError('syntax', 'the expression is too large to evaluate');
  }
  const envelope = {
    inputs: scope.inputs,
    ctx: scope.ctx,
    run: { outputs: scope.outputs },
    branches: scope.branches ?? null,
  };
  assertBoundedDepth(envelope);
  let scopeJson: string;
  try {
    scopeJson = JSON.stringify(envelope);
  } catch (cause) {
    // The scope itself (run state) was not serializable — an engine/caller fault, not an author bug.
    throw new SandboxError('scope', 'the expression scope could not be serialized for evaluation', {
      cause,
    });
  }
  // Double-encode: `scopeJson` is a JSON string; stringifying it again yields a safe JS string
  // literal. `JSON.parse` inside the VM rebuilds plain data — no live host reference crosses, and a
  // `__proto__` key materializes as an own data property (never the prototype setter).
  const scopeLiteral = JSON.stringify(scopeJson);
  return [
    '"use strict";',
    // No intrinsic flag omits a single Math method, so neutralize random here (it is the only
    // non-deterministic builtin BaseObjects ships): delete it, with a throwing override as a fallback.
    'try { delete Math.random; } catch (e) {}',
    'if (typeof Math.random === "function") {',
    '  Math.random = function () { throw new RangeError("Math.random is disabled in the expression sandbox"); };',
    '}',
    // Freeze Math so a re-add (Math.random = …) cannot reintroduce an entropy vector if a future change
    // ever ships a seedable builtin; Math.max/PI/floor keep working, Math.random stays absent.
    'Object.freeze(Math);',
    '(function () {',
    `  const __scope = JSON.parse(${scopeLiteral});`,
    '  const __freeze = function (v) {',
    '    if (v !== null && typeof v === "object") {',
    '      Object.freeze(v);',
    '      const keys = Object.keys(v);',
    '      for (let i = 0; i < keys.length; i++) { __freeze(v[keys[i]]); }',
    '    }',
    '    return v;',
    '  };',
    '  __freeze(__scope);',
    '  const inputs = __scope.inputs;',
    '  const ctx = __scope.ctx;',
    '  const run = __scope.run;',
    '  const branches = __scope.branches;',
    // The expression goes on its OWN line so a trailing line comment (`expr // note`) cannot comment out
    // the closing `);` (which would be a spurious SyntaxError); the `(`/`)` still parenthesize it.
    '  return (',
    expression,
    '  );',
    '})()',
  ].join('\n');
}

/** A successful evaluation: the marshaled value plus its VM-side `typeof` (the authoritative type). */
interface EvalOutcome {
  readonly value: unknown;
  readonly type: string;
}

/**
 * Run the program in a fresh runtime+context under the caps, marshal the result out, and dispose
 * everything. Throws a classified {@link SandboxError} on any failure — including a host-side throw
 * that escapes the VM bridge (a deep scope/expression overflowing the host stack inside `evalCode`).
 */
function runProgram(
  module: QuickJSWASMModule,
  program: string,
  limits: SandboxLimits,
): EvalOutcome {
  const runtime = module.newRuntime({
    memoryLimitBytes: limits.memoryBytes,
    maxStackSizeBytes: limits.stackBytes,
  });
  let context: QuickJSContext | undefined;
  let succeeded = false;
  try {
    context = runtime.newContext({ intrinsics: SANDBOX_INTRINSICS });
    // Start the wall-clock budget only now: it must bound the expression's EXECUTION, not the (cold)
    // runtime/context construction — counting setup would spuriously trip the cap on a trivial input.
    const deadline = Date.now() + limits.timeoutMs;
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));

    let result: VmCallResult<QuickJSHandle>;
    try {
      result = context.evalCode(program, 'expression.js');
    } catch (cause) {
      // A pathologically deep scope/expression can overflow the HOST stack inside evalCode and throw a
      // raw host error instead of returning result.error; convert it so EVERY failure is a SandboxError.
      throw hostErrorToSandbox(cause);
    }
    if (result.error) {
      const dumped = safeDump(context, result.error);
      result.error.dispose();
      throw classifyError(dumped, Date.now() >= deadline);
    }
    // The VM-side `typeof` is authoritative — `dump()` coerces a function to `{}`, hiding a
    // non-serializable result. Capture it, then marshal across the validated `any`→`unknown` boundary.
    const type = context.typeof(result.value);
    try {
      const value = context.dump(result.value) as unknown;
      succeeded = true;
      return { value, type };
    } catch (cause) {
      throw new SandboxError(
        'non_serializable',
        'the expression returned a value that could not be marshaled',
        { cause },
      );
    } finally {
      result.value.dispose();
    }
  } finally {
    // On the SUCCESS path a disposal fault (a leaked handle) is a real bug and surfaces as a
    // SandboxError; on a failure/OOM path it is swallowed so it cannot mask the already-thrown error.
    disposeQuietly(context, runtime, !succeeded);
  }
}

/** Walk the scope iteratively (no host recursion) and reject a pathologically deep value (SEC). */
function assertBoundedDepth(root: unknown): void {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  for (;;) {
    const item = stack.pop();
    if (item === undefined) {
      return;
    }
    const { node, depth } = item;
    if (node === null || typeof node !== 'object') {
      continue;
    }
    if (depth > MAX_SCOPE_DEPTH) {
      throw new SandboxError('scope', 'the expression scope is nested too deeply to evaluate');
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      stack.push({ node: value, depth: depth + 1 });
    }
  }
}

/**
 * Convert a host-side throw that escaped the VM into a classified, fatal {@link SandboxError}.
 * Exported for the same-package unit test only (NOT re-exported from the package `index.ts`): the host
 * arm of `evaluate`'s boundary catch (a failure constructing the runtime/context) is otherwise
 * impractical to reach from a black-box test.
 */
export function hostErrorToSandbox(cause: unknown): SandboxError {
  if (cause instanceof SandboxError) {
    return cause;
  }
  const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  const lower = detail.toLowerCase();
  if (lower.includes('call stack') || lower.includes('stack size')) {
    return new SandboxError('stack', 'the expression exceeded its stack limit', { detail, cause });
  }
  return new SandboxError('runtime', 'the expression failed to evaluate', { detail, cause });
}

/** Best-effort dump of a thrown VM error handle — the value, for classification + a non-secret detail. */
function safeDump(context: QuickJSContext, handle: QuickJSHandle): unknown {
  try {
    return context.dump(handle) as unknown;
  } catch {
    return '<unavailable>';
  }
}

/**
 * Map a VM failure to a classified {@link SandboxError}. The genuine wall-clock interrupt is the ONLY
 * retryable reason, and it is uniquely identified by BOTH the host-side deadline (un-spoofable from
 * the VM) AND the engine-emitted `InternalError: interrupted` marker — a user cannot forge both:
 * running long enough to pass the deadline trips the real interrupt first, and any error thrown before
 * the deadline has `deadlinePassed === false`. This closes the author-message spoof (a thrown
 * `Error("…interrupted…")` is never a timeout) AND the timing race (a deterministic error that merely
 * outlasts the deadline is fatal, not retryable). Everything else is keyed on the error's NAME (a
 * thrown Error's message is author-controlled): `InternalError` is an engine limit; any other name is
 * a deterministic, fatal runtime fault.
 */
function classifyError(dumped: unknown, deadlinePassed: boolean): SandboxError {
  const detail = errorText(dumped);
  const name = errorName(dumped);
  const message = errorMessage(dumped).toLowerCase();
  if (deadlinePassed && name === 'InternalError' && message.includes('interrupted')) {
    return new SandboxError('timeout', 'the expression exceeded its time limit', { detail });
  }
  if (name === 'SyntaxError') {
    return new SandboxError('syntax', 'the expression is not valid JavaScript', { detail });
  }
  if (name === 'InternalError') {
    // An engine-emitted limit/abort, always fatal. A stack overflow is reported distinctly; every other
    // engine limit (out of memory, string too long, a spoofed/forged 'interrupted' before the deadline,
    // …) is the 'memory'/resource class — fatal either way, never the retryable 'timeout'.
    return message.includes('stack overflow')
      ? new SandboxError('stack', 'the expression exceeded its stack limit', { detail })
      : new SandboxError('memory', 'the expression exceeded a resource limit', { detail });
  }
  return new SandboxError('runtime', 'the expression failed to evaluate', { detail });
}

/** Render a dumped VM error as `Name: message` (a non-secret diagnostic for the internal `detail`). */
function errorText(dumped: unknown): string {
  const name = errorName(dumped);
  const message = errorMessage(dumped);
  if (name.length > 0) {
    return message.length > 0 ? `${name}: ${message}` : name;
  }
  return message.length > 0 ? message : String(dumped);
}

/** The thrown value's `name`, or '' if it is not an object carrying a string `name`. */
function errorName(dumped: unknown): string {
  if (
    dumped !== null &&
    typeof dumped === 'object' &&
    'name' in dumped &&
    typeof dumped.name === 'string'
  ) {
    return dumped.name;
  }
  return '';
}

/** The thrown value's `message` (the string itself for a bare string marker), or ''. */
function errorMessage(dumped: unknown): string {
  if (typeof dumped === 'string') {
    return dumped;
  }
  if (
    dumped !== null &&
    typeof dumped === 'object' &&
    'message' in dumped &&
    typeof dumped.message === 'string'
  ) {
    return dumped.message;
  }
  return '';
}

/**
 * Dispose the per-evaluation context + runtime. `swallow` is true on a failure/OOM path (a tripped
 * runtime can be unstable to tear down, and the real evaluation error was already thrown, so a
 * disposal fault must not mask it); on the success path it is false, so a leaked-handle abort — a real
 * bug — surfaces as a SandboxError instead of being silently swallowed.
 */
function disposeQuietly(
  context: QuickJSContext | undefined,
  runtime: QuickJSRuntime,
  swallow: boolean,
): void {
  try {
    try {
      context?.dispose();
    } finally {
      runtime.dispose();
    }
  } catch (cause) {
    if (!swallow) {
      throw new SandboxError('runtime', 'a sandbox resource leaked on disposal', { cause });
    }
  }
}

/** Enforce the per-kind result contract (spec §Result contract), keyed on the VM-side type. */
function validateResult(value: unknown, type: string, kind: ExpressionKind): unknown {
  if (kind === 'condition') {
    if (type !== 'boolean' && type !== 'string' && type !== 'number') {
      throw new SandboxError(
        'result_type',
        'a condition expression must evaluate to a boolean, string, or number',
      );
    }
    return value;
  }
  // transform | merge_fn — the result becomes persisted node output, so it must be JSON-serializable.
  // Reject a top-level function/symbol/undefined/bigint by type (a bigint would crash a downstream
  // JSON.stringify), and an object `dump()` could not serialize: it does not throw on a cycle — it
  // coerces an unserializable object to a string, so a VM-side `object` whose marshaled value is not an
  // object is the tell. (Map/Set→{} and NaN/Infinity→null follow JSON.stringify semantics — see the
  // spec author guidance.)
  if (type === 'function' || type === 'symbol' || type === 'undefined' || type === 'bigint') {
    throw new SandboxError(
      'non_serializable',
      'the expression must return a JSON-serializable value',
    );
  }
  if (type === 'object' && value !== null && typeof value !== 'object') {
    throw new SandboxError('non_serializable', 'the expression returned a non-serializable value');
  }
  return value;
}
