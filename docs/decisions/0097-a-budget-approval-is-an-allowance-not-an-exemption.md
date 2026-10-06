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

> **Amended 2026-09-18 — the `W7` pre-implementation review.** A systematic review against the tree found one
> invariant that contradicts its own acceptance test, several sentences that claim more than the mechanism can
> keep, and a guarantee with no product surface. The decision is unchanged. Choices the maintainer made on
> 2026-09-18 are marked.
>
> - **"Pauses" means "pauses at round 0".** Every clause about a dispatch that holds no allowance — §2 invariants 3
>   and 7, §4 invariant 2, and the "Crash, media" and "Legacy" acceptances — holds when the over-cap call is the
>   turn's round-0 call. At round 1 or later the shipped `CR-95` guard ([ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md)
>   §10) refuses the pause and fails the step closed with `budget_exceeded`, because approving would re-fire the
>   tools the turn already ran. It follows that **the paused attempt is always a round-0 attempt**, which is what
>   `E` is sized from. Both arms are pinned: over the cap at round 0 pauses; over the cap later fails closed.
> - **A crash while the approved dispatch was running leaves no allowance.** (Maintainer, 2026-09-18.) An
>   admission lives only in memory and no row is written before egress, so an attempt that was in flight at the
>   crash can have been billed and left no record. The fold cannot see it. The resumed dispatch therefore holds no
>   allowance: its first over-cap round-0 call pauses again with a newly frozen, shown amount. That is what §4
>   invariant 2's "a charge that durable rows cannot attribute leaves no allowance" already implies, and the
>   "Crash remainder" acceptance below is SUPERSEDED by this note: where it reads "the remaining allowance is at
>   most `A` minus those charges", read "the resumed dispatch holds no allowance at all; its first over-cap round-0
>   call pauses with a newly frozen, shown amount". The rest of that bullet stands — a second crash and resume
>   restores nothing, and exhaustion fails closed. An implementation or a test written from the body alone would
>   contradict this note, so the replacement text is spelled out rather than left as "restated". The alternative, a durable pre-egress
>   "attempt admitted" row, was rejected: it adds an event type and a write plus a barrier on every attempt, to buy
>   a remainder the ADR already accepts as an under-count.
> - **The debit rule, spelled out.** A call of the approved dispatch debits its allowance at the amount admitted,
>   inside the governor's synchronous evaluate-and-admit window. When the attempt settles, the debit is reconciled
>   to the realized charge: an under-spend is refunded, an overrun is charged, a proven pre-egress release refunds
>   in full, and a conservative settle keeps the reservation. Only then is invariant 1's "plus ONE attempt's
>   realized overrun" true, and only then can a crash fold never restore allowance the live path had spent. Calls
>   of the approved dispatch that project under the cap debit too, so the live remainder and the crash fold count
>   the same rows.
> - **Invariant 2's run-wide sum is narrowed.** Spend past the cap that an ALLOWANCE admitted is bounded by the
>   sum, over approved dispatches, of each allowance plus one attempt's realized overrun. An un-approved attempt
>   admitted under the cap can still realize more than its reservation, because the estimate is a heuristic
>   ([ADR-0096](0096-a-request-is-measured-before-it-is-sent.md) §1) — that is ADR-0028's pre-existing bound, not
>   this ADR's. Only the per-dispatch form (invariant 1) is tested.
> - **`A` covers every call at the PAUSED attempt's input size.** `E` is sized from the round-0 request, and
>   ADR-0096 recomputes a larger input estimate each round, so a later round can cost more than `E` and exhaust the
>   allowance while every call stays within its chain budget. The step then fails closed, which invariants 1 and 3
>   already require; the "covers every call exhausting its chain, priced at the plan maximum" sentence is narrowed
>   to say so, and this note records the case the Negative section does not.
> - **The three ambiguous inputs of `A`.** On the generative route `attempts` is 1: it makes one submission and has
>   no chain, even though its plan entry carries a chain budget of its own (2 with no authored `retry:`, 1 with
>   one — `agent-runner.ts:961-967`). `attempts` is summed over exactly the entry set
>   `E` is taken over. `calls` is 1 when the LOWERED, advertised tool list is empty — after `CR-73`'s delegate
>   filter — not merely when no tool is granted. Each clause is pinned by a unit test on the computation.
> - **The lease's scope is money.** `CR-94`'s "money/token/attempt scope" is met as follows: the amount is
>   micro-cents, attempts and the ADR-0096 input-token estimate only SIZE it, and attempt scope is dispatch
>   ownership. No separate token or attempt bound is enforced, and none is deferred — a second approval unit the
>   user never sees would not be one they could reason about.
> - **Where the frozen amount rides.** The amount, the unrepresentable marker (mutually exclusive with it) and the
>   structured excluded-entry list are optional fields on `budget:paused` AND on `human_gate:paused` — the CLI
>   prompter only ever receives the latter — and on `human_gate:resumed`, which carries no `gateId` and so cannot
>   be joined back to its quote. `#settlePaused` writes the two pause events separately, so the fold takes the
>   amount from whichever arrived and a crash between them is pinned by a test. `GateRequest` and the checkpoint's
>   pending gate carry the same fields.
> - **The quote's provenance rides with the amount.** The stale-quote refusal above cannot be implemented from `A`
>   alone: `A` is an aggregate, so a later process cannot tell whether today's catalog would still produce it.
>   The pause therefore also freezes what the quote was computed FROM — the model ids of the entries `E` was taken
>   over and the rate basis each was priced at (the tier and the cached/non-cached rate), or a deterministic digest
>   of exactly those values. The refusal compares that against what the resuming process resolves. Without this
>   field the refusal is unimplementable and the promise would have to be withdrawn, which is why it is stated here
>   rather than left to the implementation. It is not model BINDING — the allowance still buys whatever the plan
>   runs; it is the evidence that the figure the user approved is still the figure the plan would quote.
> - **The refusals must land before the gate is claimed.** `resume()` adds the gate to `#resolvedGates`
>   synchronously before `#resolveBudgetGate` runs, so a refusal placed inside that method would leave the gate
>   claimed and every later decision an idempotent no-op — the run would strand where §2 invariant 4 promises it can
>   still be rejected. The refusal of `approved` on an unrepresentable gate, and of live `input_provided` on a
>   budget gate, therefore happen before that claim, and before `beginResume` disarms the gate's timer; the
>   cross-process path must leave no lease or registered run behind. The CLI prompter offers only Reject on an
>   unrepresentable gate, because `drive.ts` rethrows a typed `EngineStateError` as a bug. Acceptance: after a
>   refused approval, and after a refused `input_provided`, a rejection still ends the run `budget_exceeded`, and
>   the gate's timeout still fires.
> - **A non-interactive approval names the amount it approves, and `relavium budget resume` lands in `W7`.**
>   (Maintainer, 2026-09-18.) Today a budget pause can be approved only through `relavium run`'s inline prompter,
>   so a `--json` or non-TTY run cannot be approved at all, and this ADR's cross-process guarantee has no surface.
>   `W7` builds `relavium budget resume <runId> [--gate <gateId>] --approve-amount <microcents> | --abort`: the
>   amount flag must equal the frozen amount or the command refuses and prints the frozen figure, which is how
>   invariant 5's "shown before approval" holds without a question to answer. **`--gate` is what makes it
>   addressable.** `resume` takes a gateId, this ADR expects parallel vertices to hold separate allowances, and
>   `relavium gate` and `gate list` both filter budget gates out — so with two budget gates pending there is no way
>   to say which quote is being approved. With exactly one pending budget gate the command selects it; with more
>   than one it refuses and lists each gate's id and frozen amount, which is also the discovery surface those
>   commands do not provide. The command also refuses a quote whose model price no longer
>   matches, so the deferred model binding cannot silently kill an approved step — the failure mode the deferral
>   record now names. It moves out of 2.6.K's list.
> - **"The re-run's first call is always admitted" assumes an unchanged price and plan.** `A` is frozen at the
>   quote and never recomputed, so a price rise between the quote and the re-run can leave the first call over the
>   frozen amount; the step then fails closed. The `CR-94` remainder record in
>   [deferred-tasks.md](../roadmap/deferred-tasks.md) states that failure mode as the claim it narrows, and names
>   the stale-quote refusal above as its mitigation.
> - **The new exhaustion message carries no model id**, for the same reason invariant 5 keeps one out of the gate
>   message, and the open `W5` residual about model ids in budget failure messages gains a cross-reference naming
>   which budget messages `W7` added, when it lands.
>
> **Landing obligations gained.** [commands.md](../reference/cli/commands.md) — the inline gate card for a budget
> gate shows the frozen allowance and offers no input, and the `budget resume` row documents `--approve-amount` ·
> the sse-event-schema.md media rewrite keeps units-only rows as a legacy form that still resumes through the
> re-price-and-hold branch, rather than deleting the case.

> Amended 2026-10-02 — [ADR-0100](0100-budget-authorization-is-durable-state-with-a-replay-barrier.md),
> accepted by the maintainer, refines the durable mechanism without changing allowance policy.
> `budget:authorization` records the authoritative pause/decision before companion publication or approved
> redispatch, behind an explicitly observed durability/ownership barrier. W7 budget companions join by
> `(runId, nodeId, gateId)`; newly emitted `human_gate:resumed` budget companions carry `gateId`, qualifying
> the 2026-09-18 missing-key limitation. Legacy missing-key rows use exactly one then-outstanding gate and
> its recorded budget identity. Corrupt durable conflicts refuse; repeated API decisions remain no-ops.
> The authoritative pause also preserves any existing absolute gate deadline. The predecessor's strict
> replay refuses the new state-bearing event. Implementation is staged in `W7`; historical bodies are unchanged.

> Amended 2026-10-02 — [ADR-0101](0101-configured-output-estimates-apply-only-when-the-wire-is-uncapped.md),
> accepted by the maintainer, refines `E`'s output reservation/pricing: rebind the paused attempt's
> raw canonical/native cap inputs separately to each eligible model/provider/actual endpoint,
> including cooldown entries, and price the resolved reservation without another catalog clamp.
> Never reuse one dialect's resolved number for another or persist arbitrary native options. The
> frozen amount/provenance, dispatch ownership and ADR-0100 authorization ordering stay unchanged.
> Implementation is staged in W7. The historical body remains unchanged.

> Implementation checkpoint 2026-10-03 — W7 Steps 9–10 implement the frozen quote, dispatch-owned
> debit and acknowledged authorization protocol. The actual prepared first request and whole current
> quote are checked before claim; every attempt retains governance. Checkpoint/restart restores neither
> an allowance nor an invented agent output. Actual runner crash/race, sibling, deadline and effect
> controls pass, as does the actual-predecessor downgrade check. Step 10's formal reviews and Step 11's
> safe CLI confirmation/discovery remain pending. The historical implementation snippet below is preserved.

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

## Implementation foundation — 2026-10-02, W7 step 9

The pure quote and governor-owned dispatch debit/reconciliation are staged. One rate-only kernel
prices paused/current input, resolved output and media from one price lookup and returns a frozen
scalar basis. Quotes retain every effective priced/excluded candidate and distinguish zero, unpriced
and unsafe arithmetic. The full basis comparison also detects a newly priced exclusion or a newly
supplied media rate at zero volume when A does not change. Heterogeneous candidates consume original
construction cap inputs, with the current attempt's once-captured plan reused.

An opaque live token isolates governor/node/dispatch ownership. All owned calls debit, including
under-cap calls; one in-flight slot covers reconciliation and host callbacks. Under-spend/proven
release refunds, conservative settlement retains, overrun debits, and consumed positive allowances
fail later admission closed. A naturally zero allowance preserves ordinary free/unpriced policy
until an actual positive charge or forced exhaustion closes it. A later known actual after unknown E
is charged without inventing a pre-egress reservation. Sibling reservations remain global; straggler
actuals cannot refund a successor. None of these enforcement details changes the accepted policy.

This foundation does not activate from the legacy H3 boolean. Step 10 still owns authoritative
persistence, observed acknowledgement, checkpoint correction, pre-claim refusal, predecessor replay
barriers and live/cross-process activation; Step 11 owns safe confirmation. The current canonical
implementation boundary is the [runner contract](../reference/shared-core/agent-runner.md#dispatch-allowance-foundation).

## W7 step 9 financial review correction — 2026-10-03

Fresh committed-step review reproduced an orphaned text admission after unsafe actual
settlement and refunded generative admissions after post-provider pricing loss/failure. The
callers now retain safe E and finish the owned slot before propagating an accounting failure;
unpriced synchronous media retains E while preserving its explicit unpriced outcome. Known
zero/underspend, proven pre-egress release, already settled event-sink failures and async
ownership transfer keep their distinct behaviour. This repairs integration with the foundation
without changing A, eligibility, strict refusal or the Step 10 authorization boundary. E remains
a conservative commitment, never a fabricated actual.

## W7 step 9 transferred-admission review correction — 2026-10-03

The second fresh review reproduced a transferred async admission refunded after pricing loss
or left in flight after an accounting fault. The actual engine consumer now conserves safe
E and closes its slot before handling the terminal, without granting new authority or turning
E into actual spend. Per-job terminal guards prevent an exception from abandoning other jobs
or timer/lease/stream cleanup. Reentrant callbacks cannot bill twice, and known-zero/actual
reconciliation and cancellation/earlier-failure precedence remain intact. This is a caller
integration repair to the existing foundation; Step 10 still owns durable activation and
process-local allowance lifetime wiring.

## W7 step 9 earlier consumer gaps and durable totals — 2026-10-03

The third full-step review found paid admissions orphaned on park/poll host faults and a
stale terminal total on reentrant pricing cancellation. The engine now captures ownership
before fallible parking, conserves unsettled E before the poll backstop removes a job, and
joins active accounting before terminal totals while retaining immediate abort and the
early duplicate guard. Parent controls also cover cancellation during park/timer callbacks.
No allowance amount, eligibility or strict-cap rule changes; all repairs stay within the
foundation's actual/conservative distinction. Step 10 still owns authoritative durable
activation, acknowledgement, replay and native process-lifetime wiring.

## W7 step 10 historical-input correction — 2026-10-03

The second independent review produced a genuine pre-ADR budget `input_provided` record
with the archived engine. Section 4 invariant 4 requires this historical decision to count as
rejection; the first Shared reducer instead called it corrupt, aborting checkpoint replay and
aggregate interruption discovery in both stores. Only a recorded legacy budget gate with no
native authority, frozen quote or supplied approval amount receives this normalization. Its
payload never becomes agent output or spending authority. Live input refusal and native/frozen
corruption checks are unchanged. The [predecessor check](../../tools/budget-replay-compat/README.md)
now generates that exact old-producer prefix and exercises the current checkpoint, admitted
engine and both discovery stores. Historical ADR bodies remain intact.


## W7 step 11 CLI implementation checkpoint — 2026-10-03

Step 10 is accepted after eight independent review rounds. Step 11 now transports the selected
recorded gate and exact scalar amount through `relavium budget resume`; the engine remains the
single authority for quote validation, ownership and debit. The canonical flags, status projection,
inline legacy compatibility, secret stdin, frozen MCP grant and signal lifecycle live in
[the CLI command reference](../reference/cli/commands.md#relavium-budget-resume).

Invalid amounts and unapprovable quotes refuse before credentials, secret input or MCP connection.
An abort constructs no credential factory or MCP client. Matching authority/companions share a raw
run/node/gate display identity; redacted labels and the bounded warning tail cannot establish it.
Compiled-process smoke checks run offline against public built packages and native SQLite, including
an actual stdio child interrupted before ownership. They prove refusal/status/abort and cleanup,
not paid SDK egress or keychain access. Native approved-resume tests inject providers and verify
real engine authority, debit, secret/MCP grants and durable rows.

Required full CI and sequential coverage exit 0 (327 files, 7,506 passing tests, 11 existing skips).
Step 11's implementation commit and fresh independent reviews precede its closure. Steps 7–8 still
require separate maintainer live captures; no new decision or dependency is introduced here.


## W7 step 11 interruption and display correction — 2026-10-03

The first full-step review reproduced Ctrl-C swallowed while native SQLite retried an approval
append, a missing no-MCP preparation guard, and an old identified companion clearing a newer
budget notice. Cancellation now reaches known passive resumes and active engine/handle ownership;
passive cancellation neither schedules nor arms execution timers, and exact-fence confirmation
still precedes terminal writes. A late acknowledged approval stays durable, with no later dispatch.
The display removes an identified notice by its full raw run/node/gate identity; no-id historical
companions keep their node-scoped compatibility projection. Current request/price validation occurs
before the gate claim, after the run lease is acquired. These repairs implement the existing
cancellation, ownership and companion invariants without a new allowance, lease or clock policy.

Canonical behaviour is in [the command reference](../reference/cli/commands.md#relavium-budget-resume)
and [the preparation contract](../reference/shared-core/agent-runner.md#preparing-and-resuming-a-budget-dispatch).
Fresh complete-Step-11 review follows the correction commit; Steps 7–8 still require live captures.


## W7 step 11 native signal and terminal uncertainty correction — 2026-10-03

The second full-step review reproduces an OS signal queued during a successful native decision
write reaching Node only after approved egress. The CLI host now yields two check phases across
a poll turn after a successful decided authorization or human-decision companion append, before
Core observes its acknowledgement. Cancellation reaches the existing passive/active path; the
already committed row remains durable. This scheduling stays at the Node host boundary and adds
no Core platform import, acknowledgement rollback or allowance policy.

A delivered terminal whose durable append fails retains the existing terminal-outbox/exit-5
outcome. Only nonterminal uncertainty takes the ownership-refusal path; a real successor remains
fenced. The diagnostic no longer falsely denies an earlier recorded approval. These are repairs
of the existing cancellation, durability and ownership decisions, not a new architecture decision.
Canonical behaviour remains in [the command reference](../reference/cli/commands.md#relavium-budget-resume)
and [the preparation contract](../reference/shared-core/agent-runner.md#preparing-and-resuming-a-budget-dispatch).
[The second review record](../reviews/2026-10-03T21-01-16-w7-step-11-round-2-review.md) qualifies native
signal evidence, exact restoration, seven permanent controls and green full CI/coverage.
Fresh full-Step-11 round 3 precedes closure; live Steps 7–8 remain pending.

### 2026-10-04 — Step 11 full independent acceptance

Two fresh reviewers accept the complete CLI surface and both corrective rounds in
`28ba80db..53cce9e3`, with no new verified finding. All changed permanent suites and separate
native/passive/process controls pass. The parent verifies both full reports and every sealed
inventory entry before accepting the step. Interrupted earlier runs are excluded; signal,
platform and inherited secret-stdin bounds remain as stated in the canonical CLI contract.
See [Step 11 round 3](../reviews/2026-10-04T01-17-23-w7-step-11-round-3-review.md). This is a dated
implementation acceptance, not a policy change or closure of whole W7/Steps 7–8.

## Implementation correction — 2026-10-06, W7 systematic operator review

The CLI now projects the structured excluded candidates into budget prompts, plain/TUI notices,
human status and ambiguous resume discovery. Only the excluded model identifier is disclosed,
after secret redaction, inline sanitization, truncation and quoting. Priced model/rate provenance
does not enter the approval card; the confirmation still binds exclusively to the frozen scalar
amount, including zero. Matching pause companions do not repeat an exclusion notice.

Cross-process approval checks recorded priced quantities against a read-only current price view
before secret input, credential-resolver construction or MCP connection. A matching early price
check grants nothing: the engine still prepares the actual request and validates the complete
current quote before claiming the gate. Human and budget resume construct their resolvers from
the command's existing database connection. A resolved ordinary human gate is not evidence for
a budget-command no-op; derived checkpoints retain the resolved budget identities separately.

An inline stale/invalid budget approval returns the existing paused outcome while preserving the
pending gate, instead of waiting indefinitely for an event the parked run cannot emit. If a gate
deadline's automatic approval is refused, the engine uses the existing `run_timeout` failure path;
it does not leave a timerless gate pending or override the refusal. A competing completed decision
or terminal outcome is retained. These enforce the existing allowance and deadline contracts and
add no approval unit, expiry policy, error code or request-ownership decision. The canonical
[command contract](../reference/cli/commands.md#relavium-budget-resume) and
[execution model](../architecture/execution-model.md#4-human-gate) describe the operator behaviour.

## Implementation correction — 2026-10-06, independent operator review races

The first systematic operator correction exposed two acknowledgement races. A budget decision
already claimed synchronously keeps its pending row until the authorization append is acknowledged.
A late refused timeout approval or queued timeout rejection must check that claim before attempting
the timeout failure path; a pending row alone is not evidence that the decision is still available.
The original human approval or rejection therefore retains both its durable authorization and its
runtime outcome while acknowledgement is held.

After an invalid inline approval, the CLI stops prompting and consumes the actual aggregate pause
through its durable acknowledgement before releasing the database and cooperative-cancel handler.
It does not synthesize a pause from the gate companion or close native SQLite while an aggregate
pause write is outstanding. A concurrent cancellation or other terminal retains its actual result.
The canonical [command contract](../reference/cli/commands.md#relavium-budget-resume) and
[execution model](../architecture/execution-model.md#4-human-gate) record these barriers. Independent
held-acknowledgement and delayed-native-write regressions require the existing claim and ordered
delivery guarantees; no new decision, timeout policy, error code or durable schema is introduced.

## Implementation correction — 2026-10-06, cancellation outranks a queued pause

The second independent operator review narrows the earlier cancellation promise: consuming a real
acknowledged aggregate pause is sufficient for a refused inline approval only while cancellation
has not started. SIGINT during the held pause append must keep the command consuming the ordered
stream through the acknowledged `run:cancelled` terminal before releasing native SQLite and its
cooperative-cancel handler. It returns the existing failed/cancelled exit rather than the paused
exit. Native controls hold both actual writes and verify command lifetime, durable replay and
lease cleanup, alongside genuine approval, rejection and ordinary gates. This enforces existing
cancellation and durability authority; no new decision, financial policy or schema is introduced.
See the [second review record](../reviews/2026-10-06T19-25-33-w7-systematic-group-3-round-2-review.md) and
[canonical command contract](../reference/cli/commands.md#relavium-budget-resume).

## Implementation correction — 2026-10-06, cancellation owns queued gates and teardown

The third independent operator review verifies that prompt dismissal must latch the same
cancellation state as SIGINT, suppressing every later queued inline card. It also verifies that
an acknowledged pause does not end cancellation ownership during asynchronous renderer unmount:
the command retains its primary subscription and native database until the actual terminal is
durably acknowledged. Ink settles that terminal before publishing its single persistent summary;
renderers without this summary barrier still retain command resources. Actual SIGINT counting is
separate from prompt cancellation, and signal ownership ends before closing the subscription.
Native held-writer and actual Ink regressions enforce these existing cancellation, outcome and
durability guarantees, with genuine approval and stable paused controls. No new financial policy,
wire schema or decision is introduced. See the [third review record](../reviews/2026-10-06T20-13-20-w7-systematic-group-3-round-3-review.md) and
[canonical command contract](../reference/cli/commands.md#relavium-budget-resume).

## Implementation correction — 2026-10-06, terminal authority ends stale cards

The fourth independent operator review verifies that a genuine emitted budget rejection must
suppress later queued cards while the primary iterator drains the actual failed terminal. It
also verifies cancellation and authored terminal arrival across live-view suspension and an
already pending card. The private prompter forwards scoped cancellation to Clack, while the
driver dismisses stale UI and retains primary outcome, acknowledgement and cleanup authority.
Rejection follows the emitted authorization rather than successful `resume` return, which can
be an idempotent no-op after a competing approval. Ordinary human-gate rejection still continues.
Native command and actual Clack synthetic-input regressions enforce these existing guarantees;
no new financial policy, timeout, durable schema or decision is introduced. See the
[fourth review record](../reviews/2026-10-06T20-57-47-w7-systematic-group-3-round-4-review.md) and
[canonical command contract](../reference/cli/commands.md#relavium-budget-resume).

## Implementation qualification — 2026-10-06, voluntary paused departure remains open

The fifth independent operator review narrows the preceding teardown notes to their verified
cancellation/card phases. An authored gate rejection or autoapproval during voluntary paused Ink
finalization can advance the durable run while the command still reports paused. A held earlier
node/terminal append can also outlive native SQLite closure; consuming emitted events alone cannot
join that unpublished producer. This High remains open and requires an explicitly reviewed and
maintainer-approved engine departure decision. No safe general pause handoff, lifecycle change or
dependent implementation is accepted by this note. The cancellation regressions retain their
tested scope. The [fifth review record](../reviews/2026-10-06T21-43-24-w7-systematic-group-3-round-5-review.md) and
[canonical command contract](../reference/cli/commands.md#relavium-budget-resume) record the limits.
