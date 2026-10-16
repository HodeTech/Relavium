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

Each expression receives a single frozen scope rebuilt from **JSON-only transport**; denied
values become VM-owned accessors before authored execution. The bindings are exactly:

| Binding | Shape | Meaning |
|---------|-------|---------|
| `inputs` | object | admitted run inputs; supplied declared secret slots are denied accessors, while omitted optional inputs remain absent |
| `ctx` | object | the eager-once context projection: clean strings and denied accessors in original key order; see [secret context boundary](#secret-context-boundary) |
| `run.outputs` | object keyed by **node id** | completed upstream node outputs, e.g. `run.outputs["classify"].sentiment` — **never** a bare `output` |
| `branches` | array | **`merge_fn` only** — the branch outputs to combine, in the stable **`FanInPlanConfig.branchNodeIds` order** (never arrival/completion order; the order itself is defined by [run-plan.md §fan-in branch order](run-plan.md)). `run.outputs` is also available, so a branch may be referenced by node id. |

Rules:

- **Newly projected declared secrets are never injected.** The engine excludes raw declared
  secret inputs and secret-derived context strings before scope serialization. A supplied secret
  input or denied context read runs a VM-owned accessor; an observed read fails with
  `secret_context`, including ordinary caught reads and serialization-time reads. Direct expression
  inputs no longer expose `{ secret: true, ref }` display markers. Omitted optional secret inputs
  remain absent. Key-only enumeration is allowed; see the [finite denial contract](#private-evaluation-and-finite-denial).
  This is declared-source provenance, not value scanning: arbitrary literals and historical
  `run.outputs` are outside that guarantee.
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
| `merge_fn` | the same result contract as `transform` | as `transform` |

> **Lossy JSON coercion (author guidance).** A `transform`/`merge_fn` result is taken as
> JSON-serializable, so nested standard `JSON.stringify` lossy cases apply: `Map`/`Set` → `{}`,
> `NaN`/`Infinity`/`-Infinity` → `null`, `-0` → `0`. Top-level numeric values instead retain
> their exact value/sign at `evaluate`; later JSON persistence retains its existing normalization.
> A top-level `BigInt` is **rejected**. See [result parity](#primitive-transport-and-result-parity).
>
> **Boxed primitives are rejected (deliberate over-rejection).** A top-level `new String("x")` /
> `new Number(1)` / `new Boolean(true)` is rejected as `non_serializable` even though it round-trips
> through `JSON.stringify` cleanly. The host validator keys on the **VM-side `typeof`** (which is
> `'object'` for a wrapper) while the marshaled value is a host primitive, and treats that
> object-vs-primitive mismatch as the tell of a non-marshalable result. An object whose `toJSON`
> returns a non-null scalar is refused for the same reason; the existing null-result exception
> remains. The contract is therefore slightly stricter than raw JSON-serializability:
> **return a plain primitive**, never a wrapper.
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

| Cause | Classification evidence | `reason` | Classification |
|-------|----------------------------|----------|----------------|
| Syntax error (invalid JS) | object `{ name: "SyntaxError" }` | `syntax` | **fatal** — deterministic |
| Runtime error (`ReferenceError`/`TypeError`/a thrown `Error`: undefined var, bad property, `Math.random` call) | object `{ name, message }` | `runtime` | **fatal** — deterministic |
| Non-conforming result (bad `condition` type; non-serializable `transform`/`merge_fn`) | host-side validation | `result_type` / `non_serializable` | **fatal** — deterministic |
| Memory / resource limit (out of memory, string too long) | object `{ name: "InternalError" }` | `memory` | **fatal** |
| Stack overflow | object `{ name: "InternalError", message: "stack overflow" }` | `stack` | **fatal** |
| Injected scope not serializable or required provenance missing/invalid (engine/caller fault, before VM eval) | host-side validation / serialization / depth admission | `scope` | **fatal** |
| Observed denied input/context accessor | private denied transport arm, never an authored error name/message | `secret_context` | **fatal**, fixed diagnostic without detail/cause |
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
output, or a host stack trace. Ordinary `SandboxError.detail` can contain authored error text and
is private potentially sensitive data; do not render it or treat it as universally safe to log.
The `secret_context` arm contains no detail or cause. This mirrors the `LlmError`-message discipline in
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
- **Immutable, lexically-bound scope.** The VM rebuilds frozen null-prototype records from the
  parsed JSON and installs denied accessors before authored execution. Scope bindings (`inputs`,
  `ctx`, `run`, and `branches` for `merge_fn`) are `const` in a separate strict lexical function,
  outside the private latch/serializer environment. They are never installed on the VM global,
  and a write to a binding throws. A
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

<a id="proposed-wave-3-secret-context-boundary"></a>

## Secret context boundary

**Implementation contract — 2026-10-16.** This section describes the current Step 3 source
under [ADR-0113](../../decisions/0113-secret-derived-context-keeps-provenance-at-public-sinks.md).
Implementation acceptance and independent review gates remain pending in the
[Wave 3 register](../../roadmap/current.md#wave-3--clear-the-ground).

### Owned provenance and consumers

`WorkflowContextProjection` contains `values: Readonly<Record<string, string>>` (clean keys
only), `deniedKeys: readonly string[]` and `orderedKeys: readonly string[]`. Its factory
copies/freezes all three and detaches the value record's prototype. Keys must be referenceable
identifiers, denied/ordered keys unique, and `orderedKeys` exactly the disjoint union of clean
and denied keys. The full order is the original `Object.keys(resolved)` order, preserving
context declaration order and ECMAScript integer-key enumeration rather than sorting.
Denied context values are absent from this projection.

`createWorkflowProvenance` computes one authority from the existing linear declared-source
taint graph per admitted workflow. It owns both a `ReadonlySet`-compatible secret-input
membership facade and an immutable ordered `deniedInputNames` array. The facade has no Set
mutation methods; its callbacks and iterators do not expose the mutable backing Set, including
`forEach`'s third argument. `ownSecretInputNames` copies embedding-supplied membership;
`Object.freeze(new Set())` or retaining a caller's live Set would not provide that ownership.
Shape validation cannot detect a dishonest trusted embedding's fabricated provenance.

The authority also snapshots/freezes the context definition array and its key/value entries
before analysis. Engine resolution consumes that same `contextSource`, including across
awaited capabilities and same-process resume. A caller mutation after `start()` cannot make
resolution consume a different context definition from the one whose taint was analysed.
The trusted raw resolver remains compatible with full workflows and accepts a minimal
read-only context source; only engine resolution chooses the owned invocation source.

Execution/preparation require this projection and owned membership. Missing or malformed
metadata at an engine/public-template boundary raises fixed, content-free
`WorkflowContextError` (`validation`, non-retryable). Direct `ExpressionSandbox.evaluate`
converts that metadata failure to fixed `SandboxError.reason: scope`, preserving its guarantee
to throw only `SandboxError`. Clean embeddings supply an explicit empty-denial projection
and explicit `deniedInputNames`, never an implicit clean default.

`resolvePublicTemplate` uses the existing reference lexer to inspect the **entire** template
before resolving any reference or invoking any filter/capability. It refuses denied `ctx`
references and direct declared secret-input references, including optional secrets absent
from the input map, before a `default` can replace them. The fixed `InterpolationError`
reason `secret_reference` maps to non-retryable `validation`. This applies to hand-constructed
workflow objects as well as parsed YAML. The [runner contract](agent-runner.md#qualified-context-consumers)
owns actual fresh/resume/preparation producers and text consumers; preparation has no
sandbox-only field. The exported trusted raw `resolveContext` contract stays unchanged.

`ExpressionScope.ctx` is the required projection, with explicit `deniedInputNames`. Scope
construction excludes raw secret inputs, preserving actual input own-key order/presence.
Present denied input keys use private null transport placeholders which become frozen VM-owned
accessors before authored code. Omitted optional secret inputs get **no** property/accessor:
`undefined`, `hasOwn`/`in`, own keys and descriptors retain baseline absence. VM denied input
keys are present admitted keys intersected with owned declaration membership. Placeholders are
never readable expression values or display markers. Required-input admission and the ban
on secret defaults remain unchanged; trusted `NodeExecContext.inputs` remains raw, while
run-start/input-node/display masking retains its existing marker contract.

### Private evaluation and finite denial

QuickJS reconstructs frozen null-prototype scope records, using the full context key order
and only present denied input keys. Authored code runs in a separate strict lexical function
receiving only the frozen public pack, with `const` scope bindings. Trusted intrinsics are
captured before authored execution. A denied accessor sets the private sticky latch before
throwing; ordinary caught reads, returned getters and `toJSON` reads cannot clear it.

This is **finite observed-access detection**. A stack/resource exception before the accessor
body can be caught without setting the latch. The installed-VM regression's exhausted-stack
case returns its authored clean fallback string `"SWALLOWED"`; the ordinary caught-read case
instead produces `secret_context`. That successful fallback carries no raw denied value because
none was supplied; it is not a denial outcome. An uncaught
pre-accessor resource failure keeps its ordinary classification. Confidentiality rests on
raw-value exclusion, not universal detection of every attempted read. A serialization interrupt
has the separate baseline result disposition below.

When the private serialization closure completes with an observed denial, it produces
`SandboxError.reason: secret_context`, existing `code: sandbox_error`,
`retryable: false`, and the fixed message “secret-derived values are unavailable to expressions”,
without source/value detail or cause. Only this private denial arm is independent of authored
error names/messages; ordinary error classification remains unchanged.

ADR-0093's parse scan still protects before-money-spent dependency ordering. These VM-side
accessors diagnose runtime privacy reads; they add no host function and do not reverse that
scheduling decision.

### Primitive transport and result parity

One evaluation uses **two native calls in the same VM under the original deadline**. The first
evaluates authored code and returns only a private VM-owned serialization closure. The second
invokes that closure to serialize the captured authored result at most once, then performs the
final latch check. No successful authored object is dumped across the bridge. A completed closure's
observed denial wins over a caught serialization error. A serialization failure without denial,
or a native serialization interrupt that prevents completion of the closure, preserves baseline
disposition: `result_type` for `condition`, `non_serializable` for `transform`/`merge_fn`.
The native interrupt does not receive a new deadline or become a successful denial observation.

Top-level result conversion retains the installed bridge's supplemental `name`, `message`,
`stack`, `fileName` and `lineNumber` fields, including inherited/non-enumerable fields when
the serialized result does not supply a value. The original result's JSON traversal completes
first, retaining its getter order and invoking its `toJSON` once. Missing diagnostic fields
are then read in the native fixed order; all supplemental getters finish before supplemental
values are serialized. These authored conversions occur before the final latch check.
Subsequent encoding uses detached JSON records/arrays without authored prototypes or callbacks.
Nested Error values retain ordinary JSON semantics. Stack strings
describe the current VM wrapper; their internal frame text is not a stable cross-version value.
Ordinary thrown values use the same VM-owned conversion and fallback-text semantics before
the unchanged host classifier. Their bounded JSON payload is private error transport, never
an authored control arm. A VM-owned immutable Boolean distinguishes failed evaluation from
successful-result serialization if the native closure cannot complete; it grants no extra time.

The versioned private transport has closed `success`, `failure` and `denied` arms. Success
contains the trusted original VM `typeof`, a primitive `payloadJson` string and, where needed,
a closed number tag. The null-prototype outer envelope contains only trusted primitive metadata
and that string, so its later serialization cannot execute an authored getter or `toJSON`.
The host checks VM type, calls `getString`, parses/strictly validates the private arm and decodes
the payload. Author values cannot select the outer arm. Malformed transport is a fixed sandbox
failure, never success or evidence of secrecy.

The full transport's UTF-8 byte count is bounded by the evaluation's active `memoryBytes`,
with a cheap character-length precheck before bounded byte counting and host parsing.
Oversize transport raises a fixed non-retryable `memory` failure without truncation. Default
resource limits remain unchanged; no unbounded host object dump/parse is introduced.

| Result | `condition` | `transform` / `merge_fn` |
|---|---|---|
| Boolean/string/finite number | Preserve exact value | Preserve exact value |
| Top-level NaN, ±Infinity, -0 | Preserve numeric value/sign using private tags | Same; later JSON persistence keeps existing normalization |
| Object/array/null, including Map/Set | `result_type` | Existing JSON object semantics; Map/Set → `{}`; cycles fail |
| Top-level Error / Error subclass | `result_type` | Retain enumerable data plus supplemental diagnostic fields; nested Errors keep ordinary JSON semantics |
| Boxed primitive or object whose `toJSON` returns a non-null scalar | `result_type` | `non_serializable` |
| Undefined/function/symbol/bigint | `result_type` | `non_serializable` |

Nested omission/null/boxed behavior and the existing null-result exception remain unchanged.
Successful JSON serialization alone does not override original VM type checks. A stateful
`toJSON` runs once, with no second authored serialization after the final latch check.

The [tool provenance boundary](tool-registry.md#secret-argument-provenance) records the unsupported
mapping path separately. This projection does not rewrite history or certify replayed
`run.outputs` or private error detail as secret-free; the current
[at-rest/recovery guidance](database-schema.md#historical-output-and-error-data) owns that limit.
