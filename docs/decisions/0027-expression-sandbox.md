# ADR-0027: Expression sandbox for `condition` / `transform` / `merge_fn`

- **Status**: Accepted
- **Date**: 2026-06-05
- **Related**: [0003-pure-ts-engine-not-langgraph-python.md](0003-pure-ts-engine-not-langgraph-python.md), [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md), [0018-desktop-execution-and-rust-egress.md](0018-desktop-execution-and-rust-egress.md), [0023-strict-authored-yaml-validation.md](0023-strict-authored-yaml-validation.md), [../standards/security-review.md](../standards/security-review.md), [../reference/shared-core/node-types.md](../reference/shared-core/node-types.md), [../tech-stack.md](../tech-stack.md)

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
