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
