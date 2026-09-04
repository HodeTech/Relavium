# ADR-0091: `merge_strategy: first` means first DECLARED, not first to finish

- **Status**: Accepted
- **Date**: 2026-09-02
- **Related**: [0027-expression-sandbox.md](0027-expression-sandbox.md) (the expression-sandbox determinism catalog — §7 pins `branches` order for `custom` `merge_fn`; see the correction in Context), [../reference/shared-core/node-types.md](../reference/shared-core/node-types.md) (the row this corrects), [../reference/shared-core/run-plan.md](../reference/shared-core/run-plan.md) (the surface that was already right), [../reference/shared-core/expression-sandbox-spec.md](../reference/shared-core/expression-sandbox-spec.md) (the determinism guarantee race semantics would break), [../reference/contracts/workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md) (the authored surface), [../roadmap/phases/phase-2.6.5-core-reliability-remediation.md](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md) (`CR-60`)

## Context

A `merge` node's `merge_strategy: first` is documented in two incompatible ways by the project's own
canonical documents, and `CR-60` exists to make them agree.

**What the code does.** The run loop dispatches a `fan_in` only once **every** branch has settled
(`engine.ts` → `#allDepsSettled`); the handler then takes the first surviving branch in
`config.branchNodeIds` **declaration** order (`fan-in.ts`). No branch is ever cancelled or ignored — each is
dispatched and runs to completion. `dag.ts` does derive `joinStrategy: 'wait_first'` for this strategy, but
**nothing reads it**: the field exists on the plan and no code path consults it.

**What the documents say.** Four surfaces already describe this accurately — `run-plan.md` ("**`wait_first` is
executor-only in v1.0**… the engine still waits for all branches"), the `engine.ts` and `fan-in.ts` docblocks,
and a recorded entry in [deferred-tasks.md](../roadmap/deferred-tasks.md). Exactly one does not:
`node-types.md`'s merge-strategy reconciliation table says *"Take the first branch **to resolve**; ignore the
rest"*, and the same file calls `join_strategy` an "orthogonal axis" that "controls *when* the join fires" —
which is true of neither the plan nor the engine today.

**The cost of the gap is real, not cosmetic.** Because the join waits for all branches, a slow loser extends
the run's wall clock and a failing loser fails the run (the first terminal node failure sets the run's failure
and aborts its siblings) — *even when the winner has already produced its output*. An author reading the
reconciliation table has no way to predict either.

**A determinism claim in an earlier draft of this ADR was wrong, and is corrected here rather than quietly
dropped.** That draft asserted race semantics were *forbidden* by ADR-0027. They are not.
[ADR-0027](0027-expression-sandbox.md) §4 guarantees that an expression's result is "a pure function of the
**injected scope**" — a statement about the sandbox, not the scheduler — and §7 pins `branches` to static
`parallel_of` order for a **`custom` `merge_fn`**, whose input `first` does not use at all. A race for `first`
would not have to disturb either.

What is real is narrower, and it is a question rather than a prohibition: if the winner were chosen by
arrival, a replay from a checkpoint could choose a different winner unless the winning branch id were
**durably pinned** at the moment it was selected. No current ADR specifies that, so a future decision that
wants race semantics owes it — which is a precondition, not a veto.

## Decision

**`merge_strategy: first` selects the first surviving branch in declaration order, and that is the intended
behaviour — not a deferral.** The document moves; the code does not.

1. **`node-types.md`'s row is corrected** to state what happens: the first surviving branch by declaration
   order, the join waiting for every branch, and the resulting latency/cost of a slow or failing loser. The
   "orthogonal axis" sentence is corrected to say `join_strategy` is a derived plan field with no reader.

2. **The enum value stays `first`.** Renaming it (to `first_declared`) would be a breaking change to the v1.0
   authored YAML contract, requiring a `schema_version` migration for a defect that is entirely one sentence
   of documentation. The name is imprecise; the fix for imprecision is to say what it means, in the one place
   an author reads.

3. **True early-cancellation is closed FOR THIS WAVE, and stays recorded in `deferred-tasks.md` as a future
   capability behind its own ADR.** That ADR owes exactly one thing this one cannot supply: how the winning
   branch id is **durably pinned** so a replay from a checkpoint selects the same winner. It is a
   precondition, not a prohibition.

4. **`FanInPlanConfig.joinStrategy` is RENAMED, not merely annotated.** A plan field that says `wait_first`
   while the engine does `wait_all` is a false runtime contract, and the next consumer to read it and act on
   it would schedule wrongly — a comment does not stop that. It becomes `requestedJoinStrategy`, whose name
   states that it records what the strategy ASKED for rather than what the engine does. (An earlier draft
   proposed keeping it as a historical record; history belongs in this ADR and in `deferred-tasks.md`, not in
   a live type a scheduler can read.)

*Considered:* **(a)** implement true `wait_first` early-cancel — rejected for this wave: it needs
engine-owned cross-vertex cancellation AND a resolution of the ADR-0027 determinism conflict, which is a
larger decision than `CR-60` scopes. **(b)** rename the enum to match the behaviour — rejected: it breaks
authored files in the wild to fix a documentation error. **(c)** leave the table and record the divergence —
rejected: the table is the one surface an author reads, and "four out of five documents are right" is not a
contract.

## Consequences

### Positive

- The five surfaces agree, and the one an author actually reads is the one that changed.
- The latency and cost of a slow or failing loser become documented behaviour rather than a surprise, and the
  acceptance test pins them — so a future change that makes them worse is caught.
- The replay question a race would raise — durably pinning the winner — is stated as the precondition on
  future work rather than discovered by whoever tries to implement it.

### Negative

- `first` remains an imprecise name for "first declared among survivors". Mitigated by the corrected row and
  by this ADR being linked from it; the alternative cost is a breaking schema migration.
- A user who wants genuine race semantics still cannot have them, and now has a document saying so rather
  than a table implying they already do. That is a downgrade in promised capability — and an upgrade in
  honesty, which is the trade `CR-60` exists to make.
- Renaming a plan field is a (small) breaking change for any out-of-tree consumer of `RunPlan`. Accepted:
  the field is derived, unread in this repo, and its current name asserts scheduling behaviour the engine
  does not implement — which is the more expensive thing to leave standing.

## Amendment — 2026-09-03: a `condition` is not a branch

**This ADR's opening line — "The document moves; the code does not" — was wrong, and a review of the
commit that implemented it found the counterexample.** The code has a second, unrelated defect in the
same selection, and no amount of documentation fixes it.

### What was found

A `merge`'s branch list is its graph predecessors. A `condition` whose `branches[].target_node` or
`default` names the merge **is** such a predecessor — and `dag.ts` deliberately rejects a *plain* edge out
of a condition ("route via `branches[].target_node` or the `<id>:<when>` handle form"), so naming the merge
that way is the **only sanctioned** way to author it, and it parses clean.

But a `condition` produces no output. It returns `{ kind: 'branch', selected }`; the engine still marks it
`completed`, so `#completedOutputs()` stores it with the value `undefined` and `branchOutputs`'s
`runOutputs.has(id)` guard is satisfied. It becomes a **phantom branch**:

| strategy | result |
| --- | --- |
| `first` | returns the phantom and **discards the real branch's output** — run completes, exit 0 |
| `concat` | a phantom leading element |
| `custom` | every authored `branches[i]` index shifted by one |
| `object_merge` | fails loudly (`validation`: every branch output must be a JSON object) |

Three strategies corrupt silently and one fails loudly; that asymmetry is why it survived. Reproduced
end-to-end against the real handlers: with the condition authored **before** the working branch the
workflow's output is `null`; move two lines in the YAML and the same graph returns the real answer.
**Authoring order alone decides whether the run is correct**, and nothing warns.

`parallel` is the only other non-producing vertex kind — its handler returns a control `output: null`.

### The decision

**A merge's branches are its OUTPUT-PRODUCING predecessors. A `condition` predecessor is a control edge:
it still gates the join — the merge waits for it, and skip-propagation still applies — but it contributes
no branch value.** `computeMergeBranchOrder` drops `condition` predecessors when it builds
`branchNodeIds`, which fixes `first`, `concat` and `custom` at their single shared origin and leaves
`object_merge`'s loud failure intact.

This is a **refinement of §1, not a reversal**: §1 already says `first` takes the first *surviving branch*,
and a vertex that produced no value was never a branch. The code did not implement §1 for this graph.

*Considered:* **(a)** refuse a `condition` whose `target_node`/`default` names a `merge`, at parse —
rejected: routing to the join on the taken path is a reasonable thing to author, the author's intent
(gate the join) is exactly what the filter delivers, and refusing it removes a capability to fix a
mis-interpretation. **(b)** give the condition a real output (e.g. the matched `when` value) so it
becomes a legitimate branch — rejected: it invents authored semantics nobody asked for, and it would put
a routing token into `concat`/`merge_fn` results. **(c)** leave it and document that a condition must not
target a merge — rejected: it is a silent wrong answer with an exit code of 0, which is the exact defect
class `W6` exists to remove; a sentence in a spec does not stop a graph from being built.

### Consequences

- A merge whose *only* predecessors are non-producing now has **zero** branches:

  | strategy | zero-branch result | before |
  | --- | --- | --- |
  | `first` | `null` | a phantom `undefined` |
  | `concat` | `[]` | `[undefined, …]` |
  | `custom` | `branches: []` | every index shifted |
  | `object_merge` | `{}` | **a loud `validation` failure** |

  **`object_merge` is the one that gets quieter, and it is called out rather than buried.** It was the
  only strategy that refused a phantom, and a zero-branch merge now succeeds with `{}` where it used to
  fail. Not refused at parse: such a merge loads today, and a parse rejection would stop a workflow from
  loading to improve a value that is meaningless under either reading. Whether a zero-branch merge should
  instead be a parse error is recorded as an open question in
  [deferred-tasks.md](../roadmap/deferred-tasks.md) rather than decided here.
- **A workflow whose output today comes from the phantom will change its output.** That is the point;
  every such run was already returning a value the author did not ask for.
- `branchNodeIds` is no longer "the merge's predecessors", so the canonical description in
  [run-plan.md](../reference/shared-core/run-plan.md) §fan-in branch order gains the producer rule.

### Correction — 2026-09-03 (same day, after the review of the implementing commit)

**Two claims in the amendment above were wrong, and the fix that shipped with it was incomplete in one
direction and a regression in another.** Recorded here rather than silently rewritten, because the shape
of the error is the point: each was a confident statement with a plausible argument and no test behind it.

1. **"`condition` is the entire class" was false**, and it was false because the wrong graph was tested.
   An *explicit edge* from a `parallel` to a node outside its `parallel_of` is indeed refused at parse —
   that much was checked. But `parallel_of: [work, join]` names the merge **inside** `parallel_of`, and
   the builder materializes that fan-out edge itself, so it never reaches that validator. A `parallel`
   completes with a control `null`, so `first` returned `null` and discarded the real branch, exit 0 —
   the exact corruption the amendment claimed to have closed, through the path it declared impossible.
   The rule is now a **positive list** (`producesValue`) with a `never` exhaustiveness guard: a ninth node
   type cannot reopen this in silence the way a `!== 'condition'` denylist could.

2. **Filtering before the paired-parallel search reordered branches unrelated to the defect.** A
   `parallel_of` listing a condition alongside real branches no longer satisfied
   `every(m => predSet.has(m))`, so the pairing was lost and the survivors fell back from `parallel_of`
   order to authored order. Measured on `parallel_of: [cond, c, b]`: survivors came out `[b, c]` where the
   author declared `[c, b]` — a wrong `concat` result and a wrong `merge_fn` index produced by the fix
   rather than by the bug. Pairing is a question about the authored **graph**; producer-ness is a separate
   question about the **result**. The filter now runs after the ordering decision.

3. **The `output` handler had the identical defect and was not touched.** `runOutput` derived its feeders
   from `dependencies` filtered by `runOutputs.has(id)`, which a completed `condition` satisfies with the
   value `undefined`. A condition routed straight at an `output` therefore counted as a second feeder and
   flipped the documented single-feeder **verbatim** capture into a keyed wrapper — `{ work: 'WORK' }`
   instead of `'WORK'`, with a phantom `cond: undefined` that `JSON.stringify` dropped without a trace, so
   the wrapper looked deliberate. The builder now pins `OutputPlanConfig.feederNodeIds` exactly as it pins
   a merge's `branchNodeIds`, from the same `producesValue` rule — one rule, two consumers.

Each of the three is pinned by a test that was break-verified against the specific mutation it exists to
catch, and a fourth pins that the condition stays a **dependency** — dropped from the value list, not from
the graph — because over-correcting here would let a join fire on a path that had not been decided.

### Correction — 2026-09-03 (third pass): the pairing search, ranked rather than first-match

The round that reviewed the correction above found that **the fix for §2 reintroduced §2's defect through
the opposite door**, and the pair of failures is more instructive than either alone.

- §2's fix moved the pairing search onto the **unfiltered** predecessors. That let a `parallel` supplying
  **no value** win the pairing — two parallels feeding one merge, one fanning out guard `condition`s and
  one the real work: the guard parallel matched first, every real branch fell into `extras`, and the
  survivors came out in authored order again. Measured: `concat` returned `["B","C"]` where the author
  declared `[c, b]`, exit 0.
- Separately, `p.parallel_of.every(m => preds.has(m))` can **never** hold when `parallel_of` names the
  merge itself — a merge is not its own predecessor — so the very shape the previous correction
  established as reachable lost its pairing and fell to authored order too.

Taking the first structural match was the common cause: it answers a question about the authored **graph**
while the ordering it produces is applied to the **value** list. The search now **ranks candidates by how
many value-producing predecessors they cover**, ties broken by authored order (so the previous
authored-first behaviour is preserved wherever coverage is equal), a candidate covering nothing can never
pair, and the merge's own id is exempt from the membership test and dropped from the ordered list
explicitly — `producesValue('merge')` is true, so the value filter would otherwise make a merge a branch
of itself. Ranking also repairs a pre-existing weakness neither version caused: a `parallel_of` that is a
strict **subset** of another's used to out-rank the exact match purely by being authored first.

**One further silent wrong answer, adjacent and now closed.** `parallel_of` had no uniqueness constraint,
and the builder copies it verbatim into `branchNodeIds` — so a duplicated member put the branch's output
into a `concat` array **twice** and shifted every `merge_fn` index after it, while the dependency graph
de-duplicated and the node ran once, so nothing else disagreed. Refused at parse alongside the other
authored-duplicate checks; `parallel_of: [a, a]` has no reading that means anything.

