# ADR-0093: An expression sees only what it is ordered after

- **Status**: Accepted
- **Date**: 2026-09-02
- **Related**: [0027-expression-sandbox.md](0027-expression-sandbox.md) (**must be amended by this** — §3 makes marshaling JSON-only and §6 closes the error taxonomy; both constrain the mechanism), [0023-strict-authored-yaml-validation.md](0023-strict-authored-yaml-validation.md) (the fail-loud-at-parse discipline), [../reference/shared-core/expression-sandbox-spec.md](../reference/shared-core/expression-sandbox-spec.md) (the scope binding this changes), [../reference/shared-core/run-plan.md](../reference/shared-core/run-plan.md) + [../reference/contracts/workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md) (the edge/DAG homes), [../roadmap/phases/phase-2.6.5-core-reliability-remediation.md](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md) (`CR-62`)

## Context

The DAG builder derives data edges from **template** references only (`{{ run.outputs["x"] }}` in a node's
own fields). It deliberately does **not** order a `run.outputs` read that happens inside a **JS expression** —
a `condition`, a `transform`, or a `merge_fn`. The builder's own docblock records this as intended, and a test
pins it.

The consequence is a silent wrong answer. A `condition` that runs before its producer reads `undefined` and
compares it — `undefined === 'approved'` is `false` — so the node takes the false branch and the run continues
as if the author's rule had been evaluated. It was not; it was evaluated against a value that did not exist
yet. (A *dereference* of the same missing value is loud — `undefined.x` throws a fatal sandbox error. The
silent case is specifically a comparison, which is what a `condition` is made of.)

**A mechanism an earlier draft of this ADR chose does not work, and the reason is worth recording.** That
draft narrowed the scope and then had "the engine-side scope builder" fail loudly on an out-of-closure read.
The engine cannot see such a read. [ADR-0027](0027-expression-sandbox.md) §3 makes marshaling **JSON-only** —
the host `JSON.stringify`s the scope and the VM `JSON.parse`s it, so "no live host object, getter, or
function ever" crosses — and `Proxy` is deliberately never created among the sandbox intrinsics. A property
the host omits is simply `undefined` inside the VM. **Narrowing the scope alone therefore makes the defect
more frequent, not less**: more ids are absent, and every absent id compares silently false.

So the real choice is about where a read can be OBSERVED at all: inside the VM (which needs an ADR-0027
amendment to §3's marshaling and §6's closed error taxonomy, and can only fail after the run has started), or
in the expression TEXT before the run begins.

There is a fourth, adjacent instance of the same class: `edge.ts` accepts `condition: z.string().optional()`
on an authored edge, three canonical documents describe it as gating that edge, and **nothing reads it**. An
author can write it, `.strict()` accepts it, and it does nothing.

## Decision

**An expression's `run.outputs` scope is exactly the node's transitive dependency closure, and a read outside
it fails loudly.** Two steps, in that order, because the second is only meaningful once the first has made
the boundary real.

1. **Narrow the scope.** `run.outputs` exposed to a `condition` / `transform` / `merge_fn` contains only the
   outputs of nodes the reading node **transitively depends on** in the plan. This is the scope the code's
   own comments already claim, and it is computed from the plan — a static property, available before
   dispatch, identical on a replay. It strengthens determinism, and on its own it fixes nothing: see 2.

2. **Refuse an out-of-closure read at PARSE, by a conservative scan of the expression text.** The builder
   scans a `condition` / `transform` / `merge_fn` for `run.outputs["id"]` and `run.outputs.id` accesses. A
   literal access naming a node that exists in the workflow but is **not** an ancestor of the reading node is
   a typed authoring error naming both nodes — refused before a run id exists.

   **It is a scan, not a parser, and that distinction is the decision.** It reads only literal accesses; it
   makes no attempt to follow a computed key, an aliased binding, or a value flowing through a variable. Where
   it cannot tell, **it says nothing** — it never guesses, never synthesizes an edge, and never changes the
   graph's shape. What it cannot see is caught by the narrowed scope in 1, which is why the two ship together.
   A second full grammar for the sandbox's language is exactly what this avoids: the scan's failure mode is
   silence, so it cannot drift into disagreeing with the sandbox about what an expression means.

3. **`edges[].condition` is rejected at parse.** It is accepted by the schema, read by nothing, and promised
   by three documents. An authored field that silently does nothing is the same defect as a silent `false`,
   one layer up; it is refused with a typed error and the three documents are corrected in the same change.

4. **The pinning test is rewritten, not deleted, and keeps its reasoning.** The test that pinned the silent
   behaviour records what the old contract was and why it is being replaced, so the next reader inherits the
   history rather than a bare assertion.

*Considered:* **(a)** extract dependencies from expression text and **materialize edges** — rejected: it
silently changes a workflow's shape (new edges, new ordering) from a source the author did not write as a
dependency, and it needs the read to be exhaustive to be safe. The scan chosen above deliberately only
*refuses*; it never adds an edge, so being incomplete is safe rather than wrong. **(b)** observe reads inside
the VM with injected throwing getters — rejected for this wave, though it is the only exhaustive detector: it
requires amending ADR-0027 §3 (JSON-only marshaling) and §6 (the closed error taxonomy), and it can only fail
*after* the run has started, which forfeits the "before money is spent" property `W6` is about. Recorded as
the follow-up if the scan's silence proves too permissive in practice. **(c)** narrow the scope only, and
document that an out-of-closure read is `undefined` — rejected: it is the current defect with a smaller
surface and a larger blast radius. **(d)** leave it and record — rejected: a condition evaluated against a
value that does not exist yet is a wrong answer that looks like a right one.

## Consequences

### Positive

- The common case — a literal `run.outputs["x"]` naming a non-ancestor — is refused **before the run starts**,
  which is the property `W6` exists for: found while it is still an authoring mistake, not after money is spent.
- The scope an expression sees now matches what the documentation already claimed it saw.
- Narrowing the scope strengthens [ADR-0027](0027-expression-sandbox.md)'s replay determinism: a smaller,
  plan-derived scope is identical across processes by construction.
- The fourth instance (`edges[].condition`) is closed in the same change rather than left for a reader to
  trip over after the other three are fixed.

### Negative

- **Workflows that pass today can fail after this** — at load. Any workflow whose expression literally reads
  an unrelated node's output now fails to build. That is the point, and every such run was already producing
  an answer the author did not ask for; but it is a behaviour change on authored files in the wild.
- **The scan is deliberately incomplete, and its incompleteness is silent.** A computed or aliased read of an
  unrelated output is not caught, and falls through to the narrowed scope, where it still reads `undefined`
  and still compares silently false. This ADR closes the common case and **explicitly does not close the
  class**; the exhaustive detector is alternative (b), recorded as the follow-up with its ADR-0027 cost.
  Stating that here is the point — a partial fix presented as a total one is how this defect survived.
- An authored `edges[].condition` becomes a parse error. No workflow loses working behaviour (the field never
  worked), but a file that carried it stops loading until the field is removed.
- The closure computation adds work to plan build and a scope projection per expression evaluation. Both are
  plan-derived and cacheable; the cost is bounded by graph size, not by run length.
