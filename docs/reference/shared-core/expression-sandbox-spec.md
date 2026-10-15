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
> `transform.transform`, and a custom `merge_fn` — are **bare JavaScript
> expressions** (not `{{ … }}`-wrapped), evaluated in this sandbox. A bare expression is **never
> string-interpolated**, and a `{{ … }}` template is **never** evaluated as JS.

## What runs here

| Node | Field | Expression role | Result |
|------|-------|-----------------|--------|
| `condition` | `expression` (evaluated **once**) | branch selector | a value matched by strict `===` against each branch's `when` (`boolean` \| `string` \| `number`); the `default` branch is taken when none matches |
| `transform` | `transform` (a **single** expression) | pure state reshape, no LLM | the (JSON-serializable) result becomes the node's whole output |
| `merge` (custom) | `merge_fn` | combine N parallel branch outputs | the merged result — any JSON-serializable value (only when `merge_strategy: custom`) |

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
| `branches` | array | **`merge_fn` only** — the branch outputs to combine, in the stable **`FanInPlanConfig.branchNodeIds` order** (never arrival/completion order; the order itself is defined by [run-plan.md §fan-in branch order](run-plan.md)). `run.outputs` is also available, so a branch may be referenced by node id. |

Rules:

- **Secrets are never injected.** The [ADR-0029(c)](../../decisions/0029-tool-policy-hardening.md)
  parse-time taint gate (1.L2) is the primary guarantee for the `secrets.*` namespace; as
  defense-in-depth the engine caller masks `secret`-typed **inputs** before evaluation — the 1.P
  `condition`/`transform`/`merge_fn` handlers replace each `secret`-typed `inputs.<name>` with its
  `{ secret: true, ref }` marker (`buildExpressionScope`), and the agent caller (1.O) filters likewise —
  so a raw secret value can never be read through `inputs.<name>`, `JSON.stringify(inputs)`, or any
  other path.
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
| `Math` | **without `Math.random`** — the sandbox deletes the `Math.random` own property and **freezes `Math`** before the expression runs (no intrinsic flag omits a single `Math` method); calling or re-adding `random` throws → `sandbox_error` |
| `JSON` | `parse` / `stringify` |
| `Map`, `Set`, `WeakMap`, `WeakSet` | `Map`/`Set` deterministic + insertion-ordered |
| `RegExp` | deterministic (catastrophic backtracking is bounded by the wall-clock cap) |
| `Reflect`, `Symbol` | pure, deterministic, and host-unreachable — present but harmless |
| `BigInt` | present, but a top-level BigInt **result** is rejected as non-serializable (JSON has no BigInt) |
| `parseInt`, `parseFloat`, `isNaN`, `isFinite` | global numeric helpers |

**Forbidden — not present in the context:** `Date`, `Math.random`, `Promise` / `async` / `await` /
`queueMicrotask` (evaluation is synchronous — pending jobs are never run), `setTimeout` /
`setInterval`, `performance`, `crypto`, `Proxy`, `WeakRef` / `FinalizationRegistry`, `Intl`,
`import` / `require` / `process`, and any ambient I/O (`fetch`, filesystem, network). (The pure
reflective globals `BaseObjects` ships — `Reflect`, `Symbol`, `WeakMap`, `WeakSet` — *are* present;
they are deterministic and reach nothing.) No custom host function is injected in v1.0 — only the
built-in pure objects above (an interpolation filter such as `read_file` is a templating-engine
concern, **not** part of this sandbox).

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
the effect journal's identities — see [effect-journal.md](effect-journal.md)) reproducible. Non-determinism is removed at the language level (no
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
- **`run.outputs` iteration follows host insertion order** (and integer-like keys reorder ascending, per
  ES). The sandbox is a pure function of the scope object, so reproducibility across checkpoint/resume
  depends on the engine (1.O) building `run.outputs` in a **canonical** (node-id-sorted / declaration)
  order — the same obligation `merge_fn`'s `branches` already meets. Sort keys explicitly for an
  order-independent merge.

> **Cancellation (v1.0).** `evaluate` is **synchronous** and a real expression runs ~1 ms, so a run
> `CANCEL` is bounded by the wall-clock cap rather than threaded as an `AbortSignal`. Threading a
> signal into the sandbox is deferred to when 1.P/1.N wire it into the run loop; at that point a
> cancel must be a **distinct fatal reason** checked *before* the timeout path (a deliberate cancel is
> never a retryable timeout).

## Resource caps

Each evaluation runs under fixed caps. The wasm **module** is instantiated once per engine instance;
**each evaluation gets a fresh runtime + context, disposed afterward** (full isolation; OOM-safe — a
tripped runtime is discarded, never reused).

| Cap | Default (v1.0) | Enforced by | On trip |
|-----|----------------|-------------|---------|
| Wall-clock timeout | **1000 ms** | `setInterruptHandler(shouldInterruptAfterDeadline(…))`, started **after** runtime/context construction (it bounds execution, not cold setup) | `sandbox_error` — **retryable** (non-idempotent safety net) |
| Heap memory | **16 MB** | `module.newRuntime({ memoryLimitBytes })` | `sandbox_error` — **fatal** |
| Stack size | **256 KB** | `module.newRuntime({ maxStackSizeBytes })` | `sandbox_error` — **fatal** |

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
| `condition` | a `boolean` \| `string` \| `number`, compared to each `when` by strict `===` (no coercion) | a result outside that set → fatal `sandbox_error` (`result_type`). *(No-`when`-match-and-no-`default` is the **1.P condition handler's** concern when it applies the result — not the sandbox.)* |
| `transform` | a single JSON-serializable result (the node's whole output) | a function, symbol, top-level `undefined`, top-level **`BigInt`**, a top-level **boxed primitive** (`new String`/`new Number`/`new Boolean`), or circular result → fatal `sandbox_error` (`non_serializable`) |
| `merge_fn` | a JSON-serializable object | as `transform` |

> **Lossy JSON coercion (author guidance).** A `transform`/`merge_fn` result is taken as
> JSON-serializable, so standard `JSON.stringify` lossy cases apply: `Map`/`Set` → `{}`,
> `NaN`/`Infinity`/`-Infinity` → `null`, `-0` → `0`. These **pass** validation (they *are*
> JSON-serializable) but lose information — return plain JSON values to avoid surprise. A top-level
> `BigInt`, by contrast, is **rejected** (`JSON.stringify` throws on it — it is not serializable).
>
> **Boxed primitives are rejected (deliberate over-rejection).** A top-level `new String("x")` /
> `new Number(1)` / `new Boolean(true)` is rejected as `non_serializable` even though it round-trips
> through `JSON.stringify` cleanly. The host validator keys on the **VM-side `typeof`** (which is
> `'object'` for a wrapper) while the marshaled value is a host primitive, and treats that
> object-vs-primitive mismatch as the tell of a non-marshalable result. The contract is therefore
> slightly stricter than raw JSON-serializability: **return a plain primitive**, never a wrapper.
>
> **Unsettled `run.outputs` reads.** A JS-expression `run.outputs["x"]` read is still **not** wired as a
> dependency edge by the DAG builder — only `{{ … }}` template references are. Since
> [ADR-0093](../../decisions/0093-an-expression-sees-only-what-it-is-ordered-after.md) two rules bound the
> consequence: the injected `run.outputs` contains only the reading node's **transitive dependency closure**,
> and the builder **refuses at parse** a literal `run.outputs["id"]` / `run.outputs.id` access naming a
> node that is not an ancestor. The scan is conservative by design — literal accesses only, silent where it
> cannot tell, and it never synthesizes an edge.
>
> **The residue, stated rather than implied closed:** a read the scan cannot confidently resolve — a computed key, an aliased binding, an identifier escape, or any expression whose literals it cannot lex — is not
> caught by the scan, falls through to the narrowed scope, and still compares against `undefined`. Order such
> producers with an explicit edge. Exhaustive detection needs VM-side observation, which ADR-0093 records as
> the follow-up. *(This sentence added "together with the ADR-0027 §3/§6 amendments it would require" until 2026-09-04. ADR-0093's own correction records that the objection does not apply to an accessor defined VM-SIDE, after `JSON.parse`: nothing live crosses the boundary, marshaling stays JSON-only and `Proxy` stays off. The real cost is that it can only fail AFTER the run has started.)*

## Error taxonomy

Every sandbox failure surfaces as the closed `ErrorCode` member **`sandbox_error`**
([sse-event-schema.md](../contracts/sse-event-schema.md#error-code-taxonomy)), carried on the canonical
`node:failed` / `run:failed` events with a user-safe message and an internal correlation id. The
retryable/fatal split (owned by [error-handling.md](../../standards/error-handling.md)) is:

| Cause | `dump()` surface (quickjs) | `reason` | Classification |
|-------|----------------------------|----------|----------------|
| Syntax error (invalid JS) | object `{ name: "SyntaxError" }` | `syntax` | **fatal** — deterministic |
| Runtime error (`ReferenceError`/`TypeError`/a thrown `Error`: undefined var, bad property, `Math.random` call) | object `{ name, message }` | `runtime` | **fatal** — deterministic |
| Non-conforming result (bad `condition` type; non-serializable `transform`/`merge_fn`) | host-side validation | `result_type` / `non_serializable` | **fatal** — deterministic |
| Memory / resource limit (out of memory, string too long) | object `{ name: "InternalError" }` | `memory` | **fatal** |
| Stack overflow | object `{ name: "InternalError", message: "stack overflow" }` | `stack` | **fatal** |
| Injected scope not serializable (engine/caller fault, before VM eval) | host-side `JSON.stringify` throw, or a too-deep scope | `scope` | **fatal** |
| Wall-clock timeout (the genuine interrupt) | `{ name: "InternalError", message: "interrupted" }` **and** the host deadline passed | `timeout` | **retryable** — non-idempotent; bounded by the node retry budget (1.S) |

> **Classification is by error `name` + the host-side deadline — never an author-controlled message.**
> The only retryable reason, `timeout`, requires BOTH the engine-emitted `InternalError: interrupted`
> marker AND the host deadline having passed; a user can forge neither in combination (running long
> enough to pass the deadline trips the real interrupt first, and anything thrown earlier has
> `deadlinePassed === false`). So a thrown `Error("…interrupted…")` is a fatal `runtime`, and a
> deterministic error that merely outlasts the deadline is fatal, not retryable. The exact quickjs
> strings are implementation-dependent; the perf spike records what the pinned variant emits.

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
- **Immutable, lexically-bound scope.** The parsed scope is **deep-frozen** (recursive `Object.freeze`)
  and exposed as `const` lexical bindings (`inputs`, `ctx`, `run`, and `branches` for `merge_fn`) inside
  a strict-mode IIFE — it is never installed on the VM global, and a write to a binding throws. A
  pathologically deep scope is rejected (`scope`) before injection (it would overflow the host stack
  inside `evalCode`).
- **Fresh context per evaluation.** A new runtime + context is created and disposed for each
  evaluation, so two expressions cannot observe or corrupt each other (no state bleed), and an OOM
  discards only that runtime.
- **Handle hygiene.** Every VM handle is released via explicit `dispose()`; a leaked handle aborts the
  runtime on disposal, so the sandbox treats a leak as a bug — surfaced as a `sandbox_error` on the
  success path — not a silent warning.

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
(prototype-pollution escape, `eval`/`Function` **present-but-VM-isolated** — they exist inside the wasm
VM because the `Eval` intrinsic must stay on for `evalCode` to compile, yet reach no host reference or
forbidden capability — `Date`/`Math.random`/`Promise` absent, secret-in-scope yields a secret-free
error, cap-trip classification, determinism over shuffled `run.outputs` key order) are a binding part of 1.AB per
[testing.md](../../standards/testing.md#security-critical-primitive-tests-direct-negative-case).

## Proposed Wave 3 secret context boundary

**Approved design, unshipped — 2026-10-16.** [ADR-0113](../../decisions/0113-secret-derived-context-keeps-provenance-at-public-sinks.md)
was approved by the maintainer, including deliberate replacement of direct secret-input
expression markers. Display/run-start/input-node markers remain unchanged.

### Owned provenance and consumers

One WorkflowContextProjection owns values: Readonly<Record<string, string>> (clean
keys only), deniedKeys: readonly string[] and orderedKeys: readonly string[].
Copy/freeze all three and detach record prototypes. orderedKeys is the original
Object.keys(resolved) order, not a new lexical sort. Validate unique well-formed
keys and that orderedKeys is exactly the disjoint union of clean and denied keys.
Reconstruct scope data/accessors in this full order, preserving existing context
declaration order and ECMAScript integer-key enumeration. Separate clean/denied
lists alone cannot recover their original interleaving. One pure factory qualifies
resolved context using the existing
linear taint graph. Required execution/preparation ctx becomes this projection;
the exported trusted raw resolver contract stays unchanged. Missing/malformed
projection uses existing validation ErrorCode with fixed content-free message,
never an implicit clean default. Shape checks do not detect a dishonest embedding.

Derive secret-input membership once from that same admitted workflow. Own its
backing data; expose a ReadonlySet-compatible membership/iteration facade without
Set mutation methods and an immutable ordered denied-name array from the same
factory. Facade callbacks/iterators must never expose the mutable backing Set
(including forEach’s third argument). Copy caller-provided names at embedding
entry: Object.freeze(new Set())
or a live caller Set is insufficient. Every fresh/resume/preparation producer uses
that same authority, rather than recomputing a mutable set at resume.

- resolvePublicTemplate uses the existing reference lexer, rejecting denied ctx
  **and direct secret input** references before filters/defaults. Existing
  InterpolationError reason secret_reference maps to non-retryable validation.
  This is required for manually constructed workflow objects as well as parsed
  YAML; parser refusal alone is insufficient. Agent/human text and budget prompt
  preparation use this same consumer; preparation has no VM-only metadata.
- ExpressionScope requires the context projection and explicit immutable
  deniedInputNames; clean embeddings provide explicit empty metadata. Scope
  construction omits raw secret inputs and supplies clean values plus denied
  names. Preserve actual input own-key order/presence: present denied keys use
  private null placeholders which become accessors before author code. For an
  omitted optional secret input, create **no property/accessor**: ordinary
  undefined, hasOwn/in and all own-key/descriptor observations retain baseline
  absence. Compute VM denied keys as present admitted keys intersected with owned
  secret membership; public-template refusal still uses declaration membership.
  Never introduce secret defaults or relax required-input admission. Placeholders are
  transport data, never readable expression values or display markers. Trusted
  NodeExecContext.inputs
  remains raw; input-node/public display continues using maskSecretInputs.
- QuickJS rebuilds frozen null-prototype scope records and denied accessors with
  only the present denied input keys specified above; context uses its full
  ordered projection. Clean values and key-only enumeration remain
  usable. Scope metadata validation precedes serialization; no newly projected
  raw denied input/context bytes enter the VM.

### Private evaluation and finite denial

Author code runs in a separate strict lexical function receiving only the frozen
public pack. Bind inputs/ctx/run/branches as const, outside the private latch and
captured serializer closure. Capture needed intrinsics before authored execution.
When a denied accessor body runs it sets the private sticky latch before throwing.
Perform all authored result serialization before the final latch check; ordinary
caught access, getters and toJSON cannot clear an already-set latch.

This is **not** universal attempted-access detection. A stack/resource exception
before the accessor body may be caught without setting the latch; the installed
QuickJS intake reproduces it. Successful clean fallback then carries no raw denied
value because none was supplied. Pin that finite semantic limitation separately
from ordinary caught-read denial. Uncaught resource/abort/timeout retains its
existing disposition; do not mislabel it successful denial. Confidentiality rests
on raw-value exclusion, not on the latch.

Observed denial yields SandboxError.reason secret_context under existing
code sandbox_error, retryable=false, fixed message “secret-derived values are
unavailable to expressions”, with no source/value detail or cause. Only this
private denial arm is independent of authored error name/message; existing ordinary
error classification remains. Historical/arbitrary authored SandboxError.detail
is private potentially sensitive text, never a universally safe diagnostic.

ADR-0093's alternative (b) concerned before-money-spent dependency ordering and
keeps its literal parse scan. These accessors address runtime privacy/semantic
diagnosis; they do not reverse that ordering choice or add a host function.

### Primitive transport and result parity

Versioned private control arms are success, failure or denied. The success arm
contains trusted original VM typeof, a primitive payloadJson string, and a closed
number tag where needed; no authored object is embedded in the outer envelope.
Serialize the author result at most once, finish any author-controlled access,
then check the latch. Serialize the null-prototype control envelope using captured
intrinsics and return it as a primitive string. Later envelope serialization must
not call another authored toJSON/getter. Host checks VM typeof, extracts getString,
parses/strictly validates the private arm and decodes the payload. Never dump a
prototype-bearing VM object after latch validation. Author values cannot select an
outer arm. Malformed transport is fixed sandbox failure, not success or secret proof.

Bound the full transport's UTF-8 bytes by the evaluation's active memoryBytes,
with cheap length precheck before the bounded byte count; default resource limits
remain those above. No independent unbounded host parse/dump is permitted. An
oversized transport is a fixed non-retryable resource failure, not truncated data.

Preserve actual evaluate/validateResult semantics, separately from eventual JSON
persistence. Installed baseline controls confirm:

| Result | condition | transform / merge_fn |
|---|---|---|
| Boolean/string/finite number | Preserve exact value | Preserve exact value |
| Top-level NaN, ±Infinity, -0 | Preserve numeric value/sign with private nan/positive_infinity/negative_infinity/negative_zero tags | Same; later JSON persistence keeps its existing normalization |
| Object/array/null, including Map/Set | result_type failure | Existing JSON object semantics; Map/Set becomes {}; cycles fail |
| Boxed primitive or object whose toJSON becomes non-null scalar | result_type failure | Existing non_serializable failure; do not silently accept JSON-normalized scalar |
| Undefined/function/symbol/bigint | result_type failure | non_serializable failure |

For object results, preserve nested omission/null/boxed behavior and the existing
null-result exception; successful JSON serialization alone does not override the
original VM type checks. Pin stateful toJSON call count and no second author
serialization, numeric tags and every result arm in real installed QuickJS tests.
For omitted optional secret inputs also pin Object.keys, own-property names and
descriptors, hasOwn/in, Reflect.ownKeys where supported, and direct undefined
comparison. A supplied secret must actually trigger denial; declared-secret text
references still refuse. Do not certify absence by enumerable keys alone.
Changes needed beyond this parity require an explicit decision, not an accidental
transport side effect.

The [runner](agent-runner.md#proposed-wave-3-qualified-context-consumers) owns
producer migration; [tool provenance](tool-registry.md#proposed-wave-3-http-authority-and-secret-provenance)
records unsupported mapping separately. Actual engine/SQLite controls scan
run_events.payload_json, step_executions.output_json and runs.output_json with
successful clean persisted positives. Previously stored outputs/detail can contain
sensitive data and may be replayed; this change neither scrubs history nor certifies
legacy run.outputs secret-free. Update current at-rest/recovery guidance and three
stale scope/error comments during landing, without rewriting Accepted ADR history.
