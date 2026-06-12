# Expression Sandbox

- **Status**: Stable
- **Canonical home**: the contract for the deterministic, resource-capped JS sandbox in `packages/core` (`@relavium/core`) that evaluates `condition` / `transform` / `merge_fn` expressions — workstream **1.AB**
- **Related**: [../../decisions/0027-expression-sandbox.md](../../decisions/0027-expression-sandbox.md) (the decision + its 2026-06-12 hardening addendum), [node-types.md](node-types.md) (the node config blocks that carry these expressions), [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md) (the authored YAML surface), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md#error-code-taxonomy) (the `sandbox_error` code), [../../standards/security-review.md](../../standards/security-review.md#expression-sandbox-condition--transform--merge_fn) (the binding invariants), [../../standards/error-handling.md](../../standards/error-handling.md) (the retryable/fatal classification), [../../decisions/0029-tool-policy-hardening.md](../../decisions/0029-tool-policy-hardening.md) (the secret-taint gate)

This page is the **one canonical home** for the expression-sandbox *contract* — the scope an
expression sees, the language surface it may use, the determinism guarantee, the resource caps, the
result rules, and the error taxonomy. The *why* (and the pinned engine decision) lives in
[ADR-0027](../../decisions/0027-expression-sandbox.md); this file is the dry reference its consumers
(the 1.AB sandbox, the 1.P node handlers, the security review, the language server) bind to. Where any
other doc names a sandbox rule it links here and never restates it.

> **Two different `{{ … }}`-vs-bare mechanisms — do not conflate them.** `{{ … }}` **string
> interpolation** (templating, owned by the [interpolation engine](../contracts/workflow-yaml-spec.md))
> is a *separate* mechanism. The values described here — `condition.expression`,
> `transform.transformations[].expression`, and a custom `merge_fn` — are **bare JavaScript
> expressions** (not `{{ … }}`-wrapped), evaluated in this sandbox. A bare expression is **never
> string-interpolated**, and a `{{ … }}` template is **never** evaluated as JS.

## What runs here

| Node | Field | Expression role | Result |
|------|-------|-----------------|--------|
| `condition` | `expression` (evaluated **once**) | branch selector | a value matched by strict `===` against each branch's `when` (`boolean` \| `string` \| `number`); the `default` branch is taken when none matches |
| `transform` | `transformations[].expression` (one per `target_key`) | pure state reshape, no LLM | the value bound to that `target_key` in the node's output object |
| `merge` (custom) | `merge_fn` | combine N parallel branch outputs | the merged object (only when `merge_strategy: custom`) |

In v1.0 the only `expression_type` is **`js`**. `jmespath` / `jsonlogic` are **reserved** (each would
add an undeclared runtime dependency) and are **rejected at parse time** (1.L) with a field-named,
actionable error — not silently treated as `js` and failed at eval. There is **no Python evaluator**
([ADR-0003](../../decisions/0003-pure-ts-engine-not-langgraph-python.md)).

## The expression scope (the one canonical binding)

Each expression is evaluated against a single **frozen, JSON-only** scope. The bindings are exactly:

| Binding | Shape | Meaning |
|---------|-------|---------|
| `inputs` | object | this node's resolved inputs (its declared `{{ … }}` references, already resolved) |
| `ctx` | object | the workflow context/variables (the eager-once frozen snapshot, per [workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md)) |
| `run.outputs` | object keyed by **node id** | completed upstream node outputs, e.g. `run.outputs["classify"].sentiment` — **never** a bare `output` |
| `branches` | array | **`merge_fn` only** — the branch outputs to combine, in **static `parallel_of` declaration order** (never arrival/completion order). `run.outputs` is also available, so a branch may be referenced by node id. |

Rules:

- **Secrets are never injected.** The [ADR-0029(c)](../../decisions/0029-tool-policy-hardening.md)
  parse-time taint gate (1.L2) is the primary guarantee; as defense-in-depth the engine caller (1.O)
  filters any secret-tainted value out of the scope before evaluation. A secret value can therefore
  never be read through `JSON.stringify(ctx)` or any other path.
- **The scope is data-only and deeply immutable.** It is crossed into the VM as plain JSON (see
  [Marshaling & isolation](#marshaling--isolation)); each binding is installed as a non-writable,
  non-configurable property over a deep-frozen value. An expression cannot mutate the scope, and a
  mutation attempt has no cross-evaluation effect.
- **Determinism of `merge_fn`.** Because `branches` is ordered by static declaration (not arrival), a
  parallel fan-in merges to the same result regardless of which branch finishes first.

## Language surface (deny-by-default allow-list)

The VM context is built with a **minimal intrinsic set**: the non-deterministic and I/O-bearing
capabilities are simply **not created** (the one exception `BaseObjects` ships, `Math.random`, is
removed before the expression runs). Available to an expression:

| Available | Notes |
|-----------|-------|
| `Object`, `Array`, `String`, `Number`, `Boolean` | constructors + their pure prototype methods |
| `Math` | **without `Math.random`** — the sandbox deletes the `Math.random` own property before the expression runs (no intrinsic flag omits a single `Math` method); calling it throws → `sandbox_error` |
| `JSON` | `parse` / `stringify` |
| `Map`, `Set` | deterministic; insertion-ordered |
| `RegExp` | deterministic (catastrophic backtracking is bounded by the wall-clock cap) |
| `parseInt`, `parseFloat`, `isNaN`, `isFinite` | global numeric helpers |

**Forbidden — not present in the context:** `Date`, `Math.random`, `Promise` / `async` / `await` /
`queueMicrotask` (evaluation is synchronous — pending jobs are never run), `setTimeout` /
`setInterval`, `performance`, `crypto`, `Proxy` / `Reflect`, `WeakRef` / `FinalizationRegistry`,
`import` / `require` / `process`, and any ambient I/O (`fetch`, filesystem, network). No custom host
function is injected in v1.0 — only the built-in pure objects above (an interpolation filter such as
`read_file` is a templating-engine concern, **not** part of this sandbox).

> **`eval` / `Function` are present but contained — the wasm VM is the boundary, not their absence.**
> quickjs `evalCode` requires the `Eval` intrinsic to compile, so it stays enabled and `eval` / the
> `Function` constructor exist inside the VM. This is safe: the QuickJS VM runs on an isolated wasm heap
> with **no host reference reachable** (zero host functions are injected), and every capability above is
> absent — so code reached through `eval`, `Function`, or a re-acquired `(…).constructor` can read no
> clock, no RNG, no host object, do no I/O, and is bounded by the same caps. Isolation and determinism
> rest on removing the **capabilities**, not on trying to delete every reflective handle to `Function`
> (which would be fragile theater the wasm boundary already makes unnecessary).

## Determinism guarantee

**For an expression that completes within its resource caps, the result is a pure function of the
injected scope** — the same scope always yields the same value (or the same deterministic language
error). This is what keeps checkpoint/resume and retry-from-node (idempotency key
`runId + nodeId + retryCount`) reproducible. Non-determinism is removed at the language level (no
clock, no RNG, no async, no I/O — see [Language surface](#language-surface-deny-by-default-allow-list)).

The resource caps themselves are **not** part of the deterministic result — see
[Resource caps](#resource-caps). A wall-clock-timeout trip is a non-idempotent safety net that surfaces
as the error path, never as a stable value.

**Author guidance (determinism footguns):**

- Object key iteration is **insertion order** (ES2015). For an order-independent merge, sort keys
  explicitly.
- The default `Array.prototype.sort` (no comparator) is **Unicode code-point order** — deterministic.
  Locale-sensitive operations (`toLocaleString`, `Intl`, locale collation) are **discouraged**: avoid
  them in expressions whose result feeds a branch or persisted output.
- Use `Number.isNaN(x)` and `Object.is(x, y)` for `NaN` / `-0` checks; `x === NaN` is always `false`.

## Resource caps

Each evaluation runs under fixed caps. The wasm **module** is instantiated once per engine instance;
**each evaluation gets a fresh runtime + context, disposed afterward** (full isolation; OOM-safe — a
tripped runtime is discarded, never reused).

| Cap | Default (v1.0) | Enforced by | On trip |
|-----|----------------|-------------|---------|
| Wall-clock timeout | **1000 ms** | `setInterruptHandler(shouldInterruptAfterDeadline(…))`, started **after** runtime/context construction (it bounds execution, not cold setup) | `sandbox_error` — **retryable** (non-idempotent safety net) |
| Heap memory | **16 MB** | `runtime.setMemoryLimit(bytes)` | `sandbox_error` — **fatal** |
| Stack size | **256 KB** | `runtime.setMaxStackSize(bytes)` | `sandbox_error` — **fatal** |

The caps are **fixed engine constants** in v1.0 — expressions are small and infrequent relative to LLM
calls, so a trip signals a bug or a DoS attempt, not normal variation. The 1.AB perf spike measured a
real expression at **~1 ms** (cold-start ~35 ms), so the 1 s budget leaves ~1000× headroom; it is set
that loose on purpose — a tighter wall-clock budget spuriously trips a trivial eval when the host
deschedules the process mid-call, and since a timeout is the one *retryable* failure, a tighter cap
would only convert scheduling jitter into needless node retries. Author-configurable caps are a future
ADR. These numbers are the single source of truth; every surface uses them unchanged.

## Result contract

| Node | Required result | Violation |
|------|-----------------|-----------|
| `condition` | a `boolean` \| `string` \| `number`, compared to each `when` by strict `===` (no coercion) | a result outside that set, or no `when` match and no `default` → fatal `sandbox_error` ("no branch matched") |
| `transform` | a JSON-serializable value per `target_key` | a non-serializable result (function, circular, `undefined` top-level) → fatal `sandbox_error` |
| `merge_fn` | a JSON-serializable object | as `transform` |

## Error taxonomy

Every sandbox failure surfaces as the closed `ErrorCode` member **`sandbox_error`**
([sse-event-schema.md](../contracts/sse-event-schema.md#error-code-taxonomy)), carried on the canonical
`node:failed` / `run:failed` events with a user-safe message and an internal correlation id. The
retryable/fatal split (owned by [error-handling.md](../../standards/error-handling.md)) is:

| Cause | `dump()` surface (quickjs) | Classification | Rationale |
|-------|----------------------------|----------------|-----------|
| Syntax error (invalid JS) | `{ name: "SyntaxError", … }` | **fatal** | deterministic — retry repeats it |
| Runtime error (`ReferenceError`/`TypeError`: undefined var, bad property, `Math.random` call) | `{ name, message, … }` | **fatal** | deterministic |
| Non-conforming result (bad `condition` type, non-serializable `transform`/`merge_fn`) | host-side validation | **fatal** | deterministic |
| Memory cap / stack overflow | `InternalError`-class string (exact text implementation-dependent) | **fatal** | deterministic resource blow-up = author bug |
| Wall-clock timeout (interrupt) | `InternalError`-class string (`"interrupted"`) | **retryable** | non-idempotent — may pass on re-execution; bounded by the node retry budget (1.S) |

> The exact `dump()` strings are **illustrative, not a stable public API** — an OOM on a tripped runtime
> may instead surface as `"RuntimeError: memory access out of bounds"`. The sandbox classifies by
> **category** (interrupt vs OOM/stack vs a thrown error *object* carrying `name`), not by string match;
> the 1.AB perf spike records the exact strings the pinned variant emits. The classification column holds
> regardless of the literal.

**Message scrubbing (binding).** The user-facing `sandbox_error` message is the code plus a generic,
secret-free string — it **never** echoes the expression source, a variable name, a scope value, an
output, or a host stack trace. Full detail (including the raw `dump()`) goes to internal logs only,
keyed by the correlation id. This mirrors the `LlmError`-message discipline in
[security-review.md](../../standards/security-review.md).

> Syntax validity is checked at **evaluation** (1.AB), not at parse (1.L) — Zod validates the
> expression *string*, not its JS grammar. A typo'd expression parses fine and fails the first time its
> node runs; test workflows before production. (`expression_type` other than `js`, by contrast, **is**
> rejected at parse.)

## Marshaling & isolation

- **JSON-only injection.** The host serializes the scope (`JSON.stringify`) and the VM rebuilds it
  (`JSON.parse`). No live host object, getter, or function crosses the boundary, so an expression
  cannot reach a host reference. `JSON.parse` installs a `__proto__` key as an **own data property**
  (never the prototype setter), so an attacker-shaped `{"__proto__":…}` arriving via model/tool-derived
  `run.outputs` cannot poison the prototype chain.
- **Immutable global.** Each binding (`inputs`, `ctx`, `run`, and `branches` for `merge_fn`) is
  installed on the VM global as a non-writable, non-configurable property over a deep-frozen value.
- **Fresh context per evaluation.** A new runtime + context is created and disposed for each
  evaluation, so two expressions cannot observe or corrupt each other (no state bleed), and an OOM
  discards only that runtime.
- **Handle hygiene.** Every VM handle is released (`Scope` / `using` / `dispose`); a leaked handle
  aborts the runtime on disposal, so the sandbox treats a leak as a bug, not a warning.

## Instantiation (platform purity)

`@relavium/core` imports **only** `quickjs-emscripten-core` (the pure-TypeScript bindings — zero
platform imports) plus a **single-file, synchronous** variant (starting candidate
`@jitl/quickjs-singlefile-mjs-release-sync`) whose wasm is **embedded as bytes** and instantiated
through the standard `WebAssembly` global. The meta-package `quickjs-emscripten` and its default
`getQuickJS()` loader are **forbidden** — they statically import `node:fs`/`path`, breaking
`@relavium/core`'s zero-platform-imports invariant
([ADR-0003](../../decisions/0003-pure-ts-engine-not-langgraph-python.md)) at import time and failing to
load in the Tauri WebView. The exact variant + version are pinned in the `catalog:`
([tech-stack.md](../../tech-stack.md)) by the 1.AB perf spike, and the engine-deps allowlist
(`tools/engine-deps/check.mjs`) is edited in the same commit as the first import.

## Implementation home

The sandbox lives in `packages/core/src/expression/` (1.AB) and is consumed by the 1.P node handlers.
Its public surface is exported from `packages/core/src/index.ts`. Adversarial accept/reject tests
(prototype-pollution escape, `eval`/`Function` absent, `Date`/`Math.random`/`Promise` absent,
secret-in-scope yields a secret-free error, cap-trip classification, determinism over shuffled
`run.outputs` key order) are a binding part of 1.AB per
[testing.md](../../standards/testing.md#security-critical-primitive-tests).
