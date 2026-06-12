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
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  timeoutMs: 1000,
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 256 * 1024,
};

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
  BigInt: false,
  BigFloat: false,
  BigDecimal: false,
  OperatorOverloading: false,
  BignumExt: false,
};

/**
 * Load the QuickJS wasm module once per process (instantiation is the expensive step; runtimes and
 * contexts are cheap and created fresh per evaluation). Memoized so concurrent callers share it.
 */
let modulePromise: Promise<QuickJSWASMModule> | undefined;
function loadModule(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant);
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
      const limits = input.limits ?? defaultLimits;
      const program = buildProgram(input.expression, input.scope);
      const outcome = runProgram(module, program, limits);
      return validateResult(outcome.value, outcome.type, input.kind);
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
  let scopeJson: string;
  try {
    scopeJson = JSON.stringify({
      inputs: scope.inputs,
      ctx: scope.ctx,
      run: { outputs: scope.outputs },
      branches: scope.branches ?? null,
    });
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
    `  return (${expression});`,
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
 * everything. Throws a classified {@link SandboxError} on any failure.
 */
function runProgram(module: QuickJSWASMModule, program: string, limits: SandboxLimits): EvalOutcome {
  const runtime = module.newRuntime({
    memoryLimitBytes: limits.memoryBytes,
    maxStackSizeBytes: limits.stackBytes,
  });
  try {
    const context = runtime.newContext({ intrinsics: SANDBOX_INTRINSICS });
    try {
      // Start the wall-clock budget only now: it must bound the expression's EXECUTION, not the (cold)
      // runtime/context construction — counting setup would spuriously trip the cap on a trivial input.
      const deadline = Date.now() + limits.timeoutMs;
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
      const result = context.evalCode(program, 'expression.js');
      if (result.error) {
        const detail = scrubError(context, result.error);
        result.error.dispose();
        throw classifyError(detail, Date.now() >= deadline);
      }
      // The VM-side `typeof` is authoritative — `dump()` coerces a function to `{}`, which would hide a
      // non-serializable result. Capture the type, then marshal across the validated `any`→`unknown`
      // boundary (a value that cannot be marshaled — e.g. a circular object — is non-serializable).
      const type = context.typeof(result.value);
      try {
        const value = context.dump(result.value) as unknown;
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
      context.dispose();
    }
  } finally {
    disposeRuntimeQuietly(runtime);
  }
}

/** Extract a non-secret diagnostic string from a thrown VM error handle (best-effort). */
function scrubError(context: QuickJSContext, handle: QuickJSHandle): string {
  let dumped: unknown;
  try {
    dumped = context.dump(handle) as unknown;
  } catch {
    return '<unavailable>';
  }
  return errorText(dumped);
}

/** Render a dumped VM error as `Name: message` (or the raw string for an interrupt/OOM marker). */
function errorText(dumped: unknown): string {
  if (typeof dumped === 'string') {
    return dumped;
  }
  if (dumped !== null && typeof dumped === 'object') {
    const name = 'name' in dumped && typeof dumped.name === 'string' ? dumped.name : 'Error';
    const message = 'message' in dumped && typeof dumped.message === 'string' ? dumped.message : '';
    return message.length > 0 ? `${name}: ${message}` : name;
  }
  return String(dumped);
}

/**
 * Map a VM failure to a classified {@link SandboxError}. The exact quickjs strings are
 * implementation-dependent, so the host-side `deadlinePassed` signal is the primary timeout
 * indicator; everything else is matched by category. Only a timeout is retryable.
 */
function classifyError(detail: string, deadlinePassed: boolean): SandboxError {
  const text = detail.toLowerCase();
  if (deadlinePassed || text.includes('interrupted')) {
    return new SandboxError('timeout', 'the expression exceeded its time limit', { detail });
  }
  if (text.includes('out of memory') || text.includes('out of bounds')) {
    return new SandboxError('memory', 'the expression exceeded its memory limit', { detail });
  }
  if (text.includes('stack overflow')) {
    return new SandboxError('stack', 'the expression exceeded its stack limit', { detail });
  }
  if (text.startsWith('syntaxerror')) {
    return new SandboxError('syntax', 'the expression is not valid JavaScript', { detail });
  }
  return new SandboxError('runtime', 'the expression failed to evaluate', { detail });
}

/** Dispose a per-evaluation runtime, tolerating a post-OOM teardown fault on a discarded runtime. */
function disposeRuntimeQuietly(runtime: QuickJSRuntime): void {
  try {
    runtime.dispose();
  } catch {
    // A runtime tripped by the out-of-memory cap can be unstable to tear down; it is being discarded
    // and the meaningful evaluation error was already classified and thrown, so a disposal fault here
    // must not mask it. Nothing is reused after this (fresh-runtime-per-evaluation), so it is inert.
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
  // A function/symbol/undefined is not. Neither is an object `dump()` could not serialize: `dump()`
  // does not throw on a cycle — it coerces an unserializable object to a string (e.g. `"[object
  // Object]"`), so a VM-side `object` whose marshaled value is not an object is the tell.
  if (type === 'function' || type === 'symbol' || type === 'undefined') {
    throw new SandboxError('non_serializable', 'the expression must return a JSON-serializable value');
  }
  if (type === 'object' && value !== null && typeof value !== 'object') {
    throw new SandboxError('non_serializable', 'the expression returned a non-serializable value');
  }
  return value;
}
