# ADR-0027: Expression sandbox for `condition` / `transform` / `merge_fn`

- **Status**: Accepted
- **Date**: 2026-06-05
- **Related**: [0003-pure-ts-engine-not-langgraph-python.md](0003-pure-ts-engine-not-langgraph-python.md), [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md), [0018-desktop-execution-and-rust-egress.md](0018-desktop-execution-and-rust-egress.md), [0023-strict-authored-yaml-validation.md](0023-strict-authored-yaml-validation.md), [0029-tool-policy-hardening.md](0029-tool-policy-hardening.md), [../standards/security-review.md](../standards/security-review.md), [../reference/shared-core/node-types.md](../reference/shared-core/node-types.md), [../reference/shared-core/expression-sandbox-spec.md](../reference/shared-core/expression-sandbox-spec.md) (the canonical contract this ADR governs), [../tech-stack.md](../tech-stack.md)

## Context

`condition`, `transform`, and a custom `merge_fn` evaluate author-supplied **JavaScript
expressions** over run state ([node-types.md](../reference/shared-core/node-types.md),
[workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md)). The specs say only
"sandboxed JavaScript expression (no I/O, no ambient globals)" — they never name the **engine**, the
**allowed globals**, the **determinism** rules, or the **resource limits**. That gap is both a
security hole (untrusted-ish authored code, and expressions that may run over model/tool output) and
a correctness hole (a non-deterministic expression breaks checkpoint/resume + retry-from-node, whose
idempotency key is `runId + nodeId + retryCount`). [CLAUDE.md](../../CLAUDE.md) explicitly flags "the
JS sandbox" as security-sensitive; rule #3 forbids hand-rolling security primitives and rule #2
forbids a new runtime dependency without an ADR. The constraint that dominates the engine choice is
[ADR-0003](0003-pure-ts-engine-not-langgraph-python.md)/[ADR-0018](0018-desktop-execution-and-rust-egress.md):
`@relavium/core` has **zero platform-specific imports** and runs in Node, the **Tauri WebView**, the
VS Code host, and (Phase 2) a Bun worker.

## Decision

**Evaluate expressions in a QuickJS interpreter compiled to WebAssembly, instantiated only via the
standard `WebAssembly` global from embedded wasm bytes — never loaded via `node:fs`, `fetch`, or the
DOM.** This keeps the sandbox a pure, platform-agnostic module that runs everywhere the engine runs.
`new Function()` / `eval` / the Node `vm` module are **forbidden**, even transitionally, because none
of them is a security boundary and `isolated-vm` is a **Node-only native addon** that cannot run in
the WebView (it would break the zero-platform-import invariant).

The sandbox guarantees:

- **No ambient globals and no I/O.** Only an explicit, audited allow-list (e.g. `JSON`, `Math`
  *without* `Math.random`, pure `Array`/`Object`/`String`/`Number` operations) is injected.
- **Determinism.** Non-deterministic sources are banned — no wall-clock time source, no random
  source — so the same inputs always produce the same result and replay/resume is reproducible.
- **Resource caps.** Every evaluation runs under a CPU/instruction budget, a memory cap, and a
  wall-clock timeout; a runaway expression is terminated with a typed, secret-free error.

**The expression scope (one canonical binding).** `condition`, `transform`, and `merge_fn` values are
**bare JS expressions** — *not* `{{ … }}`-wrapped (that is string interpolation, a separate mechanism owned by
the templating engine) — evaluated against a single frozen, injected scope: `inputs` (this node's resolved
inputs), `ctx` (the workflow context/variables), and `run.outputs` (a map of **upstream node outputs keyed by
node id**, e.g. `run.outputs["classify"].sentiment`); `merge_fn` additionally receives the branch results to
combine. **Secrets are never injected** (the [ADR-0029](0029-tool-policy-hardening.md) taint rule). This is the
*only* canonical binding — `node-types.md` and `workflow-yaml-spec.md` reference `run.outputs[...]`, never a
bare `output`. A **syntactically invalid** expression surfaces as a sandbox error at evaluation (1.AB), not as
a parse-time (1.L) validation error (1.L's Zod validation does not parse JS).

In Phase 1 the authored **`expression_type` is `js` only.** `jmespath` and `jsonlogic` (named in the
draft specs) would each be an undeclared runtime dependency, so they are **reserved** — like `loop`
and `subworkflow` — and their adoption is deferred to a future ADR that ratifies their deps. The
QuickJS-wasm dependency lives in [tech-stack.md](../tech-stack.md); its exact package and version are
pinned by the 1.AB perf spike (candidate `quickjs-emscripten`).

Considered: **(A)** `isolated-vm` (V8 isolates) — *rejected*: Node-only native addon, cannot run in
the WebView, violates the zero-platform-import invariant. **(B)** the Node `vm` module / `new
Function()` — *rejected*: not a security boundary and Node-only. **(C)** drop raw JS and ship only a
restricted DSL (jmespath/jsonlogic) — *rejected for v1*: maximal safety but a breaking change to the
`js` default and a worse authoring experience; held as the reserved path. **(D, chosen)** QuickJS-wasm:
a vetted, embeddable interpreter that is a true sandbox and is platform-agnostic.

## Consequences

### Positive

- One sandbox that runs identically on every surface, with the engine staying pure TypeScript with
  zero platform imports.
- Determinism makes checkpoint/resume and retry-from-node reproducible — the sandbox is part of the
  correctness story, not just security.
- A vetted interpreter, not a hand-rolled one — consistent with the "never hand-roll security
  primitives" rule.

### Negative

- A WebAssembly interpreter adds a startup + per-evaluation performance cost versus native `eval`;
  acceptable because expressions are small and infrequent relative to LLM calls, and it must be
  validated on the hot path during Phase 1 (the sandbox is exercised by the end-to-end harness).
- `jmespath`/`jsonlogic` are advertised in early drafts but not shipped in Phase 1; the specs are
  narrowed to `js` and the others marked reserved to keep the contract honest.
- The sandbox lands on the engine's critical path (it gates the `condition`/`transform` node
  handlers), raising the cost of that milestone slice — recorded so the plan is honest about it.

## Amended 2026-06-12 — sandbox contract hardening (the "what", alongside the "why")

> Append-only addendum ([CLAUDE.md](../../CLAUDE.md) rule 9): the QuickJS-wasm decision above
> stays **Accepted and unchanged**. A pre-implementation review of this ADR (before workstream
> **1.AB**) found the *engine choice* sound but the *contract* under-specified — and several of
> those gaps are security/correctness decisions 1.AB would otherwise default unsafely. This addendum
> pins those decisions. The exhaustive, living contract now has a single canonical home in
> [expression-sandbox-spec.md](../reference/shared-core/expression-sandbox-spec.md) (one-canonical-home,
> rule 8); this addendum records the decisions and delegates the detail to it.

**1. Instantiation strategy (platform purity).** `@relavium/core` imports **only** from
`quickjs-emscripten-core` (the pure-TypeScript bindings, zero platform imports) plus a **single-file,
synchronous** variant (starting candidate `@jitl/quickjs-singlefile-mjs-release-sync`) whose wasm is
embedded as bytes and instantiated through the standard `WebAssembly` global. The meta-package
`quickjs-emscripten` and its default `getQuickJS()` loader are **forbidden** — they statically import
`node:fs`/`path`, which breaks the zero-platform-imports invariant
([ADR-0003](0003-pure-ts-engine-not-langgraph-python.md), rule 5) at *import* time (not merely at
runtime) and fails to load in the Tauri WebView. The `tsconfig` `types: []` fence plus a CI
import-zone check enforce this statically. The exact variant + version is pinned in the `catalog:` by
the 1.AB perf spike and mirrored in [tech-stack.md](../tech-stack.md); the engine-deps allowlist
(`tools/engine-deps/check.mjs`) is edited in the **same commit** as the first import.

**2. Deny-by-default *capabilities*; the wasm VM is the boundary, not the language.** The context is
built with a **minimal intrinsic set** so the non-deterministic and I/O-bearing capabilities are never
created — `Date: false`, `Promise: false` (evaluation is **synchronous-only** — `executePendingJobs` is
never called), `Proxy`/typed-array/bignum off — and `Math.random` is deleted before the expression
runs. The `Eval` intrinsic stays **enabled** (quickjs `evalCode` requires it to compile, so disabling
it disables evaluation), which means `eval` and the `Function` constructor exist *inside* the VM — but
they are harmless: the wasm isolation is the boundary, no host reference is reachable (zero host
functions are injected), and every forbidden capability above is absent, so code reached via
`eval` / `Function` / a re-acquired `(…).constructor` can read no clock or RNG, touch no host object,
and do no I/O — and is bounded by the same caps. (Implementation correction, 2026-06-12: an earlier
draft of this item said `Eval: false`; that is technically accurate but unusable, since it disables
`evalCode` itself — the contract instead removes the *capabilities* and relies on the isolation, the
stronger and more honest guarantee.) The exhaustive allow-list and forbidden set are owned by the
reference spec.

**3. Marshaling is JSON-only; the global is immutable (prototype-pollution closed).** Scope crosses
into the VM as **plain JSON data**: the host `JSON.stringify`s `inputs`/`ctx`/`run.outputs` (and
`branches` for `merge_fn`); the VM `JSON.parse`s it — **no live host object, getter, or function ever
crosses the boundary.** `JSON.parse` materializes a `__proto__` key as an own data property (never the
prototype setter), so an attacker-shaped `{"__proto__":…}` arriving via model/tool-derived
`run.outputs` cannot poison the prototype chain. Each binding is exposed to the expression as an
immutable, deep-frozen value (Implementation note, 2026-06-12: realized as `const` **lexical** bindings
inside a strict-mode IIFE — equivalent immutability, never installed on the VM global). v1.0 injects
**zero custom host functions** — only the built-in pure objects; any future host function requires its
own ADR amendment with a no-`this`, JSON-serializable-return-only boundary.

**4. Determinism catalog + the wall-clock/idempotency resolution.** The guarantee is restated
precisely: **for an expression that completes within its resource caps, the result is a pure function
of the injected scope.** Non-determinism is removed at the language level — no `Date`, no
`Math.random`, no `Promise`/async, no ambient I/O, no `performance`/`crypto` (none are created); sort
without a comparator is code-point ordered (deterministic), and locale-sensitive output
(`toLocaleString`/`Intl`) is discouraged in author guidance. **Resolving the timeout tension:**
quickjs-emscripten exposes a **wall-clock deadline interrupt, not an opcode counter**, so the resource
caps (timeout, memory, stack) are **non-idempotent safety nets, never a result** — a cap-trip always
surfaces as the error path (item 6), never as a stable boolean/value. A *successful* evaluation stays
reproducible across checkpoint/resume; a cap-trip re-executes under the node retry budget (1.S).

**5. Resource-cap defaults (fixed in v1.0).** Per evaluation: **1000 ms** wall-clock timeout (Implementation
correction, 2026-06-12: an earlier draft said 100 ms; raised to 1000 ms because 100 ms spuriously trips a
trivial eval when the host deschedules the process mid-call — a timeout is the one retryable failure, so a
tight cap only manufactures needless node retries), **16 MB** heap and **256 KB** stack (both via the
`newRuntime({ memoryLimitBytes, maxStackSizeBytes })` options, not the named setters). The wasm module is
instantiated **once**
per engine instance; **each evaluation gets a fresh runtime + context, disposed after** — full
isolation between expressions, and OOM-safe (a tripped runtime is discarded, not reused). Caps are
**fixed engine constants** in v1.0 (expressions are small and infrequent; configurability is a future
ADR). The 1.AB perf spike measured a real expression at ~1 ms, so the 1 s budget is ~1000× headroom —
deliberately loose so OS scheduling jitter on a busy host cannot spuriously trip a trivial eval (a
timeout is the one retryable failure, so a tight cap would only manufacture needless node retries), and
it is started **after** the cold runtime/context construction so setup time is not charged against it.
The numbers are owned by the reference spec so every surface shares one source of truth.

**6. Error taxonomy (closed `sandbox_error` code).** Every sandbox failure surfaces as the closed
`ErrorCode` member `sandbox_error` ([sse-event-schema.md](../reference/contracts/sse-event-schema.md#error-code-taxonomy)),
classified per [error-handling.md](../standards/error-handling.md): a syntax error, a runtime
Reference/TypeError, a memory/stack overflow, and a non-conforming result (a `condition` result not in
`{boolean,string,number}`, or a `transform`/`merge_fn` result that is not JSON-serializable) are
**deterministic → fatal**; only the **wall-clock-timeout safety-net trip is retryable** (it may pass on
re-execution), bounded by the node retry budget. Messages are **scrubbed to the code + a generic,
secret-free string** — never the expression source, a variable name, a scope value, or a host stack
(full detail to internal logs only), matching the `LlmError`-message discipline
([security-review.md](../standards/security-review.md)).

**7. Result contract.** `condition` results are compared to `when` values by strict `===` (no
coercion; `when ∈ {boolean,string,number}`). `transform`/`merge_fn` results must be JSON-serializable
(a non-serializable result is a fatal `sandbox_error`). `merge_fn` additionally receives `branches` —
an **array in static `parallel_of` declaration order** (never arrival/completion order) — so a parallel
fan-in merges deterministically.

**8. Secret defense-in-depth.** The [ADR-0029(c)](0029-tool-policy-hardening.md) parse-time taint gate
(1.L2) remains the primary guarantee that no secret reaches an expression scope. As defense-in-depth,
the engine caller (1.O) **filters any secret-tainted value out of the injected scope** before
evaluation, and the scrubbed-error rule (item 6) ensures a sandbox failure cannot echo a secret even if
one slipped through. (Re-tainting a secret-derived node output into `run.outputs` is the 1.O
obligation; see [phase-1 §1.O](../roadmap/phases/phase-1-engine-and-llm.md).)

**9. The perf spike is an implementation acceptance gate, not a decision gate.** The QuickJS-wasm
choice is settled and is **not** conditional on perf data. The 1.AB spike measures cold-start, per-eval
latency, per-eval RSS, and **per-surface bundle-size impact** (the embedded wasm adds to the Tauri /
CLI / VS Code bundles) against recorded thresholds, and runs the dependency-provenance / Leakwatch pass
on the pinned variant. It cannot reopen the engine choice.
