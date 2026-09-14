# ADR-0097: A budget approval is an allowance, not an exemption

- **Status**: Accepted — 2026-09-14
- **Date**: 2026-09-12 (first draft) · 2026-09-14 (fifth draft). Five review rounds shaped it, and three found a way back into the loop this ADR exists to close. After the fifth, the maintainer had it restated as decisions, invariants and acceptance tests, and a short sixth round verified that form.
- **Implementation**: staged for `W7`. "Accepted" here means the decision is settled, not that it ships: until the `W7`
  commits land, an approved step still runs uncapped, and `CR-96`'s fold still invents an output after a crash.
  [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md) says so in the meantime.
- **Decides**: `CR-94` of [Phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md) in its minimum
  correct form, deferring only model binding and expiry; and `CR-96`, a pre-existing defect found while reviewing
  this ADR and reproduced (§4)
- **Refines (not reverses)**: [ADR-0028](0028-workflow-resource-governance.md) — `pause_for_approval` still reuses
  the human-gate seam and still continues the deferred call
- **Supersedes**: the 1.AC "H3" decision recorded in `engine.ts`, which let an approved step "run to completion
  uncapped"
- **Amends (a refinement, not a reversal)**: [ADR-0074](0074-durable-conservative-budget-commitments.md) §3 — an
  approved media submission records the cost of the admission it actually holds
- **Related**: [ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md) §10 (`CR-95`) ·
  [ADR-0086](0086-absolute-admission-ceilings-on-authored-values.md) ·
  [ADR-0096](0096-a-request-is-measured-before-it-is-sent.md) §6 (the input estimate)

## Context

Under `on_exceed: pause_for_approval`, approving a paused step removes the cap for that step:

```ts
const preEgress = budgetApproved ? undefined : this.#makePreEgressHook();
```

The prompt says the step will "run to completion past the cap" and names no amount. The removal was deliberate. A
per-call approval would re-pause the step, and because an approved step re-runs its turn from the start, it would
pause at the same call forever.

**The earlier drafts, and what their review established.** Three drafts of this ADR each found a new way back into
that loop, and each path was confirmed against the code:

- **`cap + A` on the run-global ledger.** Once an earlier approved step has spent more than `A − E` past the cap, a
  later step's first call can never be admitted.
- **Sizing `E` on output alone.** Input is priced at enforcement (ADR-0096 §6), so the re-run's first call can cost
  more than the allowance was sized from.
- **Re-pausing on exhaustion.** With a one-call allowance, a primary that fails leaves no room for the failover. The
  step pauses, a fresh approval grants the same amount, and the re-run fails the same way.

The review also found `CR-96` (§4), and three facts that constrain the design:

- **Node retries run inside one dispatch.** They share its dispatch id and its approval (`engine.ts:2133-2139`), so a
  retry is not a new dispatch.
- **The chain makes more than one attempt by default.** A primary with no authored `retry` makes two
  (`agent-runner.ts:935`, `:967`).
- **A workflow controls text the gate message would show.** An unpriced plan entry's model id is authored in the
  workflow, so a cloned workflow can write a sentence that mimics an amount.

## Decision

**An approval grants an allowance that belongs to the approved dispatch. The amount is shown before approval, from a
field no workflow can forge. Only that dispatch debits it, it survives a crash, and exhausting it ends the step
rather than asking again. The pre-egress check stays armed.**

### 1. The amount

`A = calls × attempts × E`. This is the figure the user approves, so it is a decision rather than an implementation
detail.

- **`E`** is the largest per-attempt estimate across the chain entries the step can call. It is computed with **the
  paused attempt's own inputs**, including its ADR-0096 `inputTokensEstimate`, and priced by the governor's own
  estimate for each entry. An entry skipped for cooldown counts. The generative route counts only its primary. An
  entry that is unpriced under a non-strict cap has no estimate, and is excluded.
- **`calls`** is `maxToolTurns + 1` when the step's turn can loop. It is **1** when it cannot: the generative route,
  an inline media-output turn (single-shot, ADR-0046), or a turn with no granted tools.
- **`attempts`** is the chain's own attempt budget for one call: the sum of `maxAttempts` over the callable entries,
  each at its effective value.
- **An estimate of 0** gives `A = 0`, which admits only zero-estimate calls.

`A` is a tranche. It covers every call exhausting its chain, priced at the plan maximum. It does **not** price the
node's `retry` budget: node retries share the dispatch and draw on the same allowance.

### 2. Invariants of the allowance

1. **Bounded, and the bound is the one shown.** An approved dispatch's spend past the cap never exceeds `A` plus one
   attempt's realized overrun beyond its reservation. The enforced amount is exactly the frozen amount shown. It is
   carried durably on the pause, on the pending gate and on the approval, and never recomputed.
2. **Only its owner debits it.** Only the approved dispatch, together with its node retries, draws on its allowance.
   No sibling does, and no straggler attempt from an earlier, abandoned dispatch of the same vertex does. Total spend
   past the cap is bounded by the sum, over approved dispatches, of each allowance plus one attempt's realized
   overrun. The allowance answers only a cap pause. It never admits a call that another verdict refused, such as
   `strict_cost_cap` on an unpriced model or modality.
3. **No loop.** The re-run's first call is always admitted. A dispatch that **holds** an allowance never pauses
   again: exhaustion fails the step closed, together with any node retries it had left, and the message says the
   *approved allowance* was exhausted. A dispatch that holds **no** allowance is not an approved dispatch: a
   crash-recovered one whose remainder cannot be established (§4), or one resumed from a legacy approval. Its first
   over-cap call is a fresh cap pause with a newly frozen, shown amount. That is not a loop, because the new
   allowance is not reduced by charges from before its own approval.
4. **An amount that cannot be represented cannot be approved.** When `E` or `A` is not a safe integer, the pause says
   so explicitly, and that marker is distinct from a legacy pause with no amount. `resume` refuses `approved` on such
   a gate, writes no durable event, and does not re-pause. The gate can only be rejected.
5. **No workflow-controlled text is shown as part of the approval.** The gate message carries no model id. Excluded
   unpriced entries travel as a structured field, and a surface renders them quoted, truncated and escaped. The amount
   is rendered from its own field, inside the confirmation question itself.
6. **Media.** An approved media submission records `acceptedCostMicrocents` from the admission it holds.
7. **State from before this ADR grants no allowance.** Approving a legacy budget gate, which carries no amount,
   grants no allowance. The re-dispatch runs under the cap, and its first over-cap call pauses with a frozen, shown
   amount before any spend past the cap. A durable approval written before this ADR restores no allowance on resume.

### 3. Deferred

The lease's two remaining properties — **binding the allowance to the model it was quoted for**, and **an expiry** —
are recorded in [deferred-tasks.md](../roadmap/deferred-tasks.md). The trigger is the first surface where an approval
can be exercised after the model or its price has changed, such as an approval queue that outlives a catalog refresh.

### 4. `CR-96`: a decided budget gate survives a crash, and the checkpoint stops inventing an output

**Shipping today, independent of this ADR, and reproduced.** The checkpoint fold marks the node of every resolved
gate `completed`, with the output `{ decision }` (`checkpoint.ts:458-461`). On a budget gate that node is the agent
itself. A crash between the decision and the agent's own terminal therefore resumes the agent as complete, with an
invented output that downstream nodes read as its answer.

**Invariants.**

1. **A decided budget gate never produces a completed agent with an invented output.**
2. **Approved.** The agent re-runs with a remaining allowance of at most `A` minus every charge the node may have
   incurred since the approval. A charge that durable rows cannot attribute to the node leaves **no** allowance; the
   dispatch then pauses again, or runs under the cap if its restored projection allows. A synchronous generation's
   cost is one such charge, because it is only streamed.
3. **Rejected.** The resumed run fails with `budget_exceeded` and dispatches nothing.
4. **`input_provided` on a budget gate** is refused at `resume` on the live path, with a typed error and no durable
   event. In a log written before this ADR it counts as rejected.
5. **A duplicate decision stays a no-op.**

### Implementation notes (non-normative)

These are traps the reviews found in the mechanisms earlier drafts specified.

- **Seeding does not fail a run.** Seeding a checkpoint with a failed node does not set the run's failure
  (`engine.ts:1263-1268`), so a run left in that state still ends `run:completed`.
- **`#resolveBudgetGate` accepts `approved` unconditionally today** (`engine.ts:1728-1740`).
- **Media approval has a special case.** The media path's `budgetApproved ? {} : …` branch skips the accepted cost,
  and [sse-event-schema.md](../reference/contracts/sse-event-schema.md) describes that as normal.
- **Only the cap's own verdict may be overridden.** The governor has more verdicts than allow and pause, and the
  allowance applies to the cap pause alone.
- **Debiting must not open a gap.** It has to happen in the governor's existing synchronous evaluate-and-admit window,
  or a sibling can be admitted in between.
- **The CLI prompts through the gate message today** (`drive.ts`'s inline gate resolution), so §2 invariant 5 changes
  what it renders.

### Scope

Run path only. A session does not yet handle a budget pause at all; that is tracked for 2.6.K.

### Alternatives

Considered **`cap + A` on the run-global ledger** (rejected: it loops). Considered **sizing `E` without the input
term** (rejected: it loops). Considered **re-pausing on exhaustion** (rejected: it loops through failover).
Considered **a snapshot anchor in memory** (rejected by the maintainer). Considered **the full lease now** (the
maintainer chose the minimum correct form). Considered **pricing node retries into `A`** (rejected: it multiplies an
already large figure by up to ten, for a case where failing closed is the honest answer). Considered **reading the
amount from the message** (rejected: the workflow controls text in it).

## Consequences

### Positive

- An approved step's spend is bounded, and the user sees the bound before approving, from a field the workflow cannot
  forge.
- The loop is closed at every path the reviews found.
- A crash after any budget decision neither invents an output nor loses the decision.
- "Before each LLM call the engine checks the cap" is true again.

### Negative

- **A step that needs more than `A` fails** where it used to finish. That includes a step whose node retries exhaust
  it. Accepted: that is the bound working, and the message says so.
- **`A` can be large**, because every call may exhaust its chain at the plan's most expensive entry. Accepted: it is
  shown, it is bounded by ADR-0086's ceilings, and pricing lower lets a failover fail.
- **Crash recovery may under-count the remaining allowance.** Accepted: that errs toward stopping.

### Acceptance

- **No loop, from an earlier overspend.** An approved node ends over the cap, and a cheaper node then pauses; that
  node's approval issues its first call.
- **No loop, from priced input.** With input priced, a re-run's first call is admitted by an allowance sized from the
  paused attempt.
- **No loop, from failover.** On the default plan, an approved single-call step whose primary fails both attempts and
  whose fallback succeeds completes under its allowance. An exhausted allowance fails the step closed, and neither it
  nor its node retries pause again.
- **Isolation.** Two parallel approved vertices draw from separate allowances. While an approved dispatch holds unspent
  allowance, an un-approved parallel sibling whose call projects over the cap still pauses and debits nothing from it,
  and a straggler attempt from an abandoned dispatch of the same vertex is refused the allowance.
- **Crash remainder.** Approve, let the re-run settle attributable attempts, crash, and resume: the remaining allowance
  is at most `A` minus those charges. A second crash and resume does not restore it, and exhaustion then fails closed.
- **Legacy.** Approving a legacy `budget:paused` with no amount admits no call past the cap without a frozen, shown
  amount.
- **Crash, approved.** A durable approval, a crash, and a resume through a sibling human gate re-runs the agent, which
  never outputs `{ decision: 'approved' }`.
- **Crash, rejected.** A durable rejection, a crash, and a resume through a sibling human gate end `run:failed` with
  `budget_exceeded`.
- **Crash, media.** An approved step that may have made a synchronous generation before a crash resumes with no
  allowance, and its first over-cap call pauses with a newly frozen amount.
- **Live `input_provided`.** `resume` refuses `input_provided` on a budget gate.
- **Cross-process.** An approval from another process enforces the amount frozen on the pending gate.
- **Strict cap.** The allowance never admits a `strict_cost_cap` refusal.
- **Unrepresentable amount.** `resume` refuses `approved` on a gate marked unrepresentable, and nothing pauses again.
- **A forged amount.** A fallback entry whose model id contains a sentence stating a small amount does not appear in
  the gate message. It is rendered escaped and truncated, and the only amount in the confirmation question is the
  field's.

### Landing obligations

- **Dated notes**: ADR-0028 and ADR-0074.
- **Records**: the `CR-94` register row, the [deferred-tasks.md](../roadmap/deferred-tasks.md) note saying no
  maintainer call was made, and a new register item `CR-96`.
- **Canonical docs**: [sse-event-schema.md](../reference/contracts/sse-event-schema.md) (the pause and approval
  fields, and the media sentence) and [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md).
- **Code**: remove the H3 comments in `engine.ts`, and change what the CLI gate prompter renders.
