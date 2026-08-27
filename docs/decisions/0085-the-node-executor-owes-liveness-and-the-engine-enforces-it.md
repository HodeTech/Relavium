# ADR-0085: The node executor owes liveness, the engine enforces it, and a late dispatch is fenced

- **Status**: Accepted
- **Date**: 2026-08-25
- **Related**:
  - [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md) — the run-loop substrate, the `ExecutionHost` seam and the exactly-one-terminal invariant. **Amended here**: its Consequences claim that *"a zombie / never-terminating run is structurally impossible"* is not true of the executor seam it defines. §3 supplies the mechanism for the executor half and §6 states precisely which half remains conditional. Cancel-wins precedence, the single producer-side translation point and the monotonic `sequenceNumber` are unchanged.
  - [ADR-0082](0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md) — the per-attempt provider deadline. This is the same "an `AbortSignal` is a request, not a guarantee" argument applied one layer up, and §6's *"whichever elapses first wins"* composition rule is inherited rather than restated. Its `openDeadline` primitive is the mechanism reused here; §9 owns the packaging decision that makes reuse legal.
  - [ADR-0028](0028-workflow-resource-governance.md) — the run `timeout_ms`. Its *"bounds total wall-clock"* is defeated by the same `running === 0` gate that defeats cancel, so §3 fixes it here and not only in `CR-22`.
  - [ADR-0040](0040-node-retry-budget-above-the-chain.md) — the node-retry budget. §2's absolute node deadline is what stops an authored bound being multiplied by `retry.max`, and A.5's *"cancel disarms the pending retry"* is the arming pattern §3 follows.
  - [ADR-0074](0074-durable-conservative-budget-commitments.md) — the conservative commitment. §3 follows the abort-listener pattern its §3 established after this exact hang shipped once, and §5 keeps its money-durability barrier intact rather than cutting it short.
  - [ADR-0078](0078-ordered-durable-append-and-the-terminal-outbox.md) — the ordered append and the terminal outbox. §3's scope boundary rests on it: terminal durability is already owned there, and this ADR does not re-decide it.
  - [ADR-0045](0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) — the media-job loop. §2 weighs and rejects its `timeout → provider_unavailable` classification for this case, and §5 keeps its local-only-cancel cost-integrity position intact.
  - [ADR-0079](0079-cross-process-run-ownership-lease-and-fencing-token.md) — the run lease. §6 names the residual its release opens while a straggler is still running; the fence here is IN-process and is not that fence.
  - [ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md) — the effect journal. §5 defines the fence per journal method, and §6 names it as the only thing standing between an abandoned straggler and a duplicate external effect.
  - [ADR-0023](0023-strict-authored-yaml-validation.md) — strict authored YAML. An accepted-then-ignored field is the shape it exists to refuse.
  - [node-types.md](../reference/shared-core/node-types.md) · [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md) — the canonical homes where the `agent` node's `timeout_ms` is currently advertised as a live field.
  - [database-schema.md](../reference/shared-core/database-schema.md) — the SQLite write policy whose documented ~25 s worst case sets §3's scope boundary.
  - [error-handling.md](../standards/error-handling.md) — where `run_timeout`'s fatal classification lives.
- **Decides**: `CR-20` and `CR-23` of [phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md).

## Context

Two gaps at one seam, and they are the same gap seen from two directions.

**An authored liveness bound is silently ignored.** `AgentNodeSchema` accepts `timeout_ms`
(`packages/shared/src/node.ts:124`), [node-types.md](../reference/shared-core/node-types.md) lists it
among the `agent_config` fields, and [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md)
shows it in the normative per-field example and in three worked workflows. Nothing reads it. The value is
not even hard to reach — `AgentPlanConfig` carries the whole `AgentNode`, so it arrives at dispatch as
`vertex.config.node.timeout_ms` — it simply has no consumer. An authored field that parses and then does
nothing is the failure [ADR-0023](0023-strict-authored-yaml-validation.md)'s strict-reject posture exists to
prevent, and it is worse than a missing feature because it is the bound a user plans around.

**And the run cannot end while a node refuses to.** `NodeExecutor.execute(ctx)` returns an arbitrary
`Promise<NodeOutcome>` (`packages/core/src/engine/node-executor.ts:217`). `requestCancel()` sets a flag,
aborts the signal and re-enters the scheduler; `#step` then settles only when `#countRunning()` reaches
zero. An executor that ignores its signal and never settles leaves the run with no terminal, forever —
and the same gate defeats the run-level `timeout_ms`, so ADR-0028's cap is no rescue.

The two are one problem because they are bounded by one mechanism at one place. `#dispatch` is where the
engine hands control to code it does not own, and both an authored per-node bound and a post-abort cleanup
window are deadlines on that hand-off. Fixing one with a race and the other with an abort would leave the
second defeated by the first's adversary.

**The stakes are already recorded as a shipped guarantee.** ADR-0036's Consequences assert that *"a
zombie / never-terminating run is structurally impossible"*, and
[phase-1-engine-and-llm.md](../roadmap/phases/phase-1-engine-and-llm.md) repeats it as an **accepted
acceptance criterion** for a workstream marked Done. Neither is true of the seam as it stands. Phase
2.6.5 exists precisely because a claim the code does not keep is worse than a missing feature; this ADR
makes the executor half true and §6 states what the other half still depends on, rather than restoring an
unconditional claim that would be false again.

## Decision

**We will make the node-executor seam's liveness obligation explicit, and have the engine enforce it by
racing rather than by trusting** — the same move ADR-0082 made one layer down, for the same reason.

### 1. The obligation is stated at the seam, and the engine does not rely on it

`NodeExecutor.execute` MUST settle — with any `NodeOutcome`, including a failure — within the grace
window of §3 after `ctx.signal` aborts. This is written into the seam's docblock so an implementor reads
it where they implement, not only in an ADR.

Stating it is not enforcing it. The engine hard-races the awaited work, exactly as ADR-0082 §5 races a
provider call, because *"an `AbortSignal` is a request, not a guarantee"* is as true of an executor as of
a provider. Considered **stating the obligation and trusting it** (rejected: this is the position the
tree already holds implicitly, and it is the one that produced the defect) and **narrowing the seam to a
cancellable handle type** (rejected: it would change every executor's shape to buy a compile-time hint a
non-cooperative implementation still ignores at runtime — the same reasoning ADR-0082 §3 used to make the
chain verify rather than re-type the provider).

**What is raced is the DISPATCH, not the `execute()` call alone.** This distinction is load-bearing and
was wrong in this ADR's first draft. A node's wall-clock does not end when `execute()` resolves:
`#applySaveTo` runs on its return (inside `#runAttempt`), `#joinMoneyDurability` runs after `#runAttempt`
returns (inside `#dispatch`), and the retry loop's `node:retrying` backoff sits between attempts. Racing
only `execute()` would leave a node hung in `save_to`, in the money barrier, or in a backoff — still
counted `running`, still holding the run open, with the deadline already satisfied. Both timers therefore
wrap the whole `#dispatch` body.

### 2. The authored node deadline is ABSOLUTE per node, and classifies as the human gate already does

`timeout_ms` bounds the interval from the node's **first `node:started` to its node terminal** — every
attempt, every backoff, `save_to`, and the money barrier share one remaining budget. `#dispatch` already
captures `startedAtMs` before the retry loop, so the remaining time is arithmetic on state the engine
holds.

A node whose bound elapses fails with **`code: 'run_timeout'`, `retryable: false`**.

**Why absolute rather than per attempt.** A per-attempt reading multiplies: a node with
`retry: { max: 3 }` whose first two attempts fail with an ordinary retryable error and whose third times
out spends roughly three times the authored bound, and `retryable: false` does not prevent it — that flag
only stops the *timed-out* attempt from being retried. An author writing `timeout_ms: 60000` is stating
how long the node may take, not how long each of its hidden attempts may take. The absolute reading is
also the one the human gate already has (one park, one deadline) and the only one that composes cleanly
with ADR-0028's run cap.

**Why `run_timeout` rather than a new code.** This is not a new decision; it is the one the engine already
makes. `#failGateOnTimeout` settles the **human gate's** authored `timeout_ms` with exactly
`{ code: 'run_timeout', retryable: false }` on the node's own failure. Both fields are authored node-level
liveness bounds on the same schema; giving the agent node a different classification would mean two
authored `timeout_ms` fields resolving two different ways, which no author would predict.

Considered **a new `node_timeout` member of the closed `ErrorCode` union** (rejected: ADR-0082 §9 declined
to widen a taxonomy every surface switches on *"for a distinction no surface would act on differently"*,
and the gate precedent means the distinction is not even new — the union would gain a member describing a
case one of its existing members already covers). Considered **mapping to the retryable
`provider_unavailable`**, the classification ADR-0045 §3 and ADR-0082 §5 both chose for *their* timeouts
(rejected on two grounds: it names a provider fault when the provider may be uninvolved — a node deadline
can elapse inside a tool loop, a `save_to` write, or an unbounded executor — and it is retryable, which
would re-run a node whose authored bound has already expired).

`retryable: false` is therefore load-bearing, not incidental, and it is the same lever ADR-0082 §9 used to
carry a decision the `ErrorCode` could not.

**One `ErrorCode`, three sources.** `run_timeout` now covers the run cap, a gate deadline and a node
deadline. `error.nodeId` is what distinguishes them, and §9 requires the canonical event and error docs to
say so — the code was already carrying two of the three silently.

**Composition is already decided and is inherited, not restated.** ADR-0082 §6 fixed the rule: *"Against
the caller's, the node's and the run's deadlines: whichever elapses first wins."* The node deadline
therefore does not replace, extend or reset the provider attempt deadline beneath it or the run deadline
above it.

### 3. One grace window, opened by the abort signal — and it bounds the EXECUTOR wait, not terminal durability

When the run's `AbortSignal` fires — for **any** reason — a single grace timer is armed. If the run has
not settled when it elapses, the engine **stops waiting for every in-flight dispatch** and proceeds to
settle.

**The scope boundary, stated precisely, because the first draft of this ADR got it wrong.** The window
bounds how long the engine waits on *the executor*. It does **not** bound how long the terminal takes to
become durable, and it must not be read as "a terminal within 10 s". Terminal durability is owned by
ADR-0078 — the ordered append, the `uncertain` result and the outbox — and a single `persistEvent` has a
documented worst case of **~25 s** under sustained contention (five attempts × a 5 s `busy_timeout`, per
[database-schema.md](../reference/shared-core/database-schema.md#concurrency--transaction-behavior)). A
grace window shorter than one legitimate durable write is correct for what it bounds and would be absurd
as a bound on settling. Two different seams, two different budgets; conflating them is what produced the
error.

**The trigger fires before the diagnostic write, not after it.** `#onRunTimeout` currently awaits its
durable `run:timeout` event *and then* sets `#failure` and aborts. A store that never settles therefore
means the abort never happens and this window never arms — the liveness fix defeated by the very path it
exists to rescue. The order is inverted: set `#failure`, abort, then emit the diagnostic. The event is a
record of a decision already taken, so nothing is lost by writing it second.

**If no `#failure` is set when the window elapses, the forced terminal carries
`{ code: 'run_timeout', retryable: false }`.** The run-timeout path is exactly this case — it aborts
because the cap expired — and leaving "the existing `#failure`" to be read as possibly-absent would ship a
terminal with an undefined cause. Otherwise the terminal is the one the run was already heading for:
`run:cancelled` when cancelling, else `run:failed` carrying the existing `#failure`. No new terminal, no
new `ErrorCode`, no new event. ADR-0036's cancel-wins precedence decides the first, and `#step`'s own
branches already encode both. Considered **a distinct `executor_unresponsive` code** (rejected: it
collides with cancel-wins — a forced terminal after a user cancel must still say `cancelled` — and
ADR-0079 declined a `run:fenced` terminal for the same widening cost).

**The trigger is the signal itself**, registered **unconditionally** once in the constructor, not per-call
at each of the eleven `#abort.abort()` sites. This engine has already had this exact bug once and already
chose this exact shape to fix it: ADR-0074 §3's hold-release listener sits in the same constructor under a
comment stating the hazard in the words this ADR is about — a suspended `checkPreEgress` *"keeps its node
counted as `running`, so `#step` never reaches `#countRunning() === 0` and the run never emits a terminal
— an unkillable run"* — registered on the abort signal *"ONCE here, so no future abort site can forget
it."* That listener bounds **one** cause; this section bounds the class, including causes nobody has
enumerated yet. (One difference worth stating: ADR-0074's listener is nested inside the
`plan.budget !== undefined` branch, so an unbudgeted run never gets it. The grace listener must not be
conditional on anything.)

Considered **arming it only in `requestCancel`** (rejected: it is the narrowest reading of `CR-23`'s title
and leaves ADR-0028's run `timeout_ms` still defeated by a hung executor, so the same defect survives
under a different name). Considered **an always-on per-dispatch watchdog** (rejected: it duplicates §2's
authored bound and would fire on legitimately long nodes nobody asked to stop).

**The window is `10_000` ms, fixed, and cannot be disabled.** It is stated here rather than only in a
constant because a default is part of a decision, and ADR-0082 §6 set that precedent. The shape is not new
to this codebase either: `FORCE_TEARDOWN_MS` (`apps/cli/src/render/tui/tui-constants.ts`) already bounds
how long a TUI teardown waits for a hung MCP child, under a docblock stating the same principle — *"The
teardown still runs to completion in the background; only the UI/exit is bounded."*

The value follows from what the window is *for*: cooperative unwinding after the executor has already been
told to stop — flushing a stream, closing an iterator, returning a failure. Considered **2 000 ms**,
matching `FORCE_TEARDOWN_MS` (rejected: a teardown waits on a child-process close, while a dispatch may be
mid-`await` on an in-flight provider stream that ADR-0082 gives up to 120 s; 2 s would abandon
well-behaved work that was seconds from returning). Considered **30 000 ms** (rejected: half a minute
after a cancel reads as a hang, which is the experience this ADR exists to remove). Considered
**host-injectable** (rejected for now: `attemptTimeoutMs` is already plumbed as an injectable and no host
sets it, so a second unused knob buys configurability nobody has asked for — and ADR-0082 §6's refusal to
allow a disabling value applies with equal force, since "unbounded" is the state being removed).

### 4. An abandoned node gets a node terminal, because the log must not lie by omission

Each vertex still `running` when the grace elapses is settled `node:failed` with
`{ code: 'cancelled', retryable: false }` **before** the run terminal, so the durable log has no
`node:started` without a partner and `step_executions` is consistent.

The message is fixed text, not free prose, because `cancelled` alone would read as *"the user cancelled
this node"* when what happened is that the engine stopped waiting:
**`the node did not settle within the grace period after the run was aborted; the engine stopped waiting`**.
Considered **a distinct code** to carry that nuance (rejected on §2's grounds — the union should not gain a
member for a distinction no surface branches on) and **leaving the `node:started` dangling** (rejected: it
is cheapest, but nothing in the tree flags a dangling start — neither `createAppendAudit` nor
`checkDurableTruth` has a rule for it — so the gap would be invisible to the very oracles built to catch
this class).

### 5. A generation fence, and its validity rule is per vertex

**The predicate, stated exactly, because "a monotonic generation" is ambiguous under `max_parallel` and
the ambiguity is not resolvable by an implementer's taste.** A run-wide "current generation" would make
sibling `B`'s dispatch invalidate sibling `A`'s legitimate in-flight work; a run-epoch counter cannot
distinguish dispatch `N` from `N+1` of the *same* vertex, which is the case that motivated a token at all.
So:

- The run holds a monotonic `nextDispatchId` and a map `activeDispatchByVertex: Map<vertexId, dispatchId>`.
- Each `#dispatch` takes the next id and claims its vertex's slot; a re-dispatch of the same vertex
  replaces **only that vertex's** entry.
- A write is admitted only when the run has not settled **and** the writing dispatch's id equals its
  vertex's current entry.
- When the §3 grace elapses, every entry is cleared **atomically, before any await**, so no straggler can
  slip a write in between the decision and the settle.

Node *state* is already fenced — `#onOutcome` returns early on `#settled`. The gap is that this is one
boolean on one path. The fence covers five points, and each gets its own assertion in §8:

1. `#onOutcome` — already latched; the token subsumes the boolean.
2. `#nodeEmit`'s `cost:updated` fold — currently unguarded, and it mutates `#cumulativeCostMicrocents` and
   pushes to every subscriber after the terminal has reported the total.
3. `#applySaveTo` — currently unguarded, and it writes bytes to the user's filesystem on the executor's
   return, before `#onOutcome` is reached at all.
4. The effect-journal port — per method, below.
5. The money port — per method, below.

**The effect journal, per method.** `EffectDispatchPort` is `prepare` / `settle` / `discard`, and a blanket
"refuse a stale write" would resurrect the exact defect `PR83-04` fixed — a row stuck `prepared` forever,
reported as `needs_attention` for an effect that actually completed.

| Method | Stale dispatch | Why |
|---|---|---|
| `prepare` | **refused** | The effect has not left the process. Refusing it is the whole point: an abandoned dispatch must not start new external work. |
| `settle` | **allowed** | The effect already left the process under a valid claim. Refusing its receipt would leave a durable row lying about an effect that completed. |
| `discard` | **allowed** | It releases a `prepared` claim on a proven non-dispatch; refusing it strands the row exactly as refusing `settle` would. |

**The money port, per method.** ADR-0045 §5's local-only-cancel caveat and `#emitMediaJobCost` already
chose *record the money anyway* for a provider that billed, and reversing that here to gain symmetry would
trade a settled cost-integrity position for a tidier rule. So a ledger write for a charge **already
incurred** completes, stale or not. What the fence does refuse is the **run-total fold and its delivered
event** (point 2): a straggler may not change a total the terminal has already reported. The two are
separable — the ledger is per-attempt truth, the fold is run-wide presentation — and separating them is
what lets both invariants hold.

Considered **a second boolean latch** (rejected: it cannot distinguish dispatch `N` from `N+1` of the same
vertex, and the budget-approved re-dispatch produces exactly that). Considered **exposing the token on
`NodeExecContext`** so the executor can self-check (rejected as a *replacement*: a non-cooperative executor
ignores a token exactly as it ignores a signal; enforcement belongs on the engine's side of the boundary).

### 6. What is NOT guaranteed, said plainly

ADR-0082 §5's sentence applies unchanged one layer up: **the guarantee is run liveness with respect to the
executor, not resource termination.** An abandoned executor's work may continue in the background — it may
still reach a provider, a tool or an MCP server. What is bounded is how long the *run* waits for it.

Three residuals follow, each named rather than implied:

- **The host persistence seam is not bounded by this ADR.** `RunStore.persistEvent` is `Promise`-typed, and
  `#emitDurable` catches a rejection but simply awaits a promise that never settles. A store that hangs
  forever still hangs the run, and no timer here changes that. The SQLite store is bounded and fail-loud
  (~25 s, then it rethrows), so this is not reachable on the shipping host; it is reachable on a
  hypothetical async or cloud store. **This is the half of ADR-0036's claim that stays conditional**, and
  it is recorded as a follow-up rather than fixed here, because bounding a durable write raises a question
  this ADR must not answer in passing: what a run may do when it cannot learn whether its own write landed.
- `#settle` releases the run lease (ADR-0079), so another process may take the run over while this
  process's abandoned executor is still running. **ADR-0080's effect journal is the only thing standing
  between that and a duplicate external effect**, and it is sufficient exactly to the tier it claims —
  tier 3 effects remain `needs_attention`, not exactly-once.
- **`AgentSession` is unchanged by this ADR.** It already emits its terminal immediately and abandons the
  in-flight turn, which is the behaviour §3 gives the workflow engine — but the asymmetry is deliberate and
  already correct, so no session code changes: a session terminal makes no claim about node completion,
  whereas `run:completed` carries `outputs` and `totalCostMicrocents` that a straggler could still change.
  That is why the workflow side needs a fence and the session side does not.

### 7. No executor quarantine — and the accepted risk is stated, not assumed away

`CR-23` names quarantine as part of its fix. We decline it, and record the real reasoning rather than a
convenient one.

Two arguments that would be wrong. It is **not** true that quarantine has nothing to attach to: ten
factories return a `NodeExecutor` and each lives as a distinct object in the dispatcher's `handlers` map.
And it is **not** true that `retryable: false` removes the need entirely — that flag stops the same node
being re-dispatched *within its run*, but `WorkflowEngine` holds one `#executor` across a `#runs` map and
accepts repeated `start()` calls, so a later run enters the same handler object.

**The real position is an accepted risk with a stated trigger.** On the only host that exists, the CLI
runs one workflow per process and exits, so an abandoned dispatch outlives the run by at most the process.
There is therefore no observed accumulation to bound, and every quarantine design needs things no evidence
yet supports: a lift policy, a refusal `ErrorCode`, and an observability story — and silently refusing
every `agent` node because one hung once is a worse product than a slow one. Considered **per-run**
(rejected: redundant with §2's `retryable: false` within a run, and blind to the cross-run case that is the
real one). Considered **per-`(engine, node type)`** (rejected *for now*, not on principle — it is the shape
that would fit).

**The trigger for revisiting is named so it is not left to memory: the first long-lived host that drives
more than one run through one `WorkflowEngine`** — the desktop app or the VS Code extension, neither of
which has any source today. That host must either add a quarantine or measure that accumulation is
harmless; this ADR does not license it to assume the latter. Recorded 2026-08-27 in
[deferred-tasks.md](../roadmap/deferred-tasks.md) under "Phase 2.6.5 `W2` residuals", with this ADR as its
reference.

### 8. Acceptance

Driven through fake executors and the manual timer, because the whole item is about not trusting the
implementation.

**The authored node deadline (`CR-20`)**

1. An agent node with `timeout_ms` whose executor never settles fails `run_timeout`, `retryable: false`,
   within the deadline — asserted on the *armed duration*, not merely on the firing.
2. A node that settles inside its bound is unaffected and its timer is disarmed — proven by the armed
   count, on the success path as well as the failure path.
3. A node with no `timeout_ms` arms no node timer.
4. **The bound is absolute across attempts**: a node with `retry: { max: 3 }` whose attempts fail with an
   ordinary retryable error consumes ONE `timeout_ms` in total, not one per attempt — the test that would
   go red under a per-attempt reading.
5. A node whose `execute()` returns inside the bound but whose `save_to` hangs still times out — and the
   same for a hanging money barrier. These are the two tests that would pass for a race around
   `execute()` alone.
6. A run cancel landing during a node deadline classifies `cancelled`, not `run_timeout` — cancel-wins,
   asserted against the contract rather than fake-timer callback order.
7. The node deadline and the run deadline compose by earliest-expiry (ADR-0082 §6), proven with both armed
   and the shorter one firing.

**The grace window and the forced terminal (`CR-23`)**

8. A never-settling executor produces **exactly one** terminal after the grace window, on cancel.
9. The same on a run `timeout_ms`, **including when the `run:timeout` persist itself never settles** — the
   ordering fix in §3, and the case a cancel-only reading misses entirely.
10. Every abandoned vertex has a `node:failed` carrying §4's fixed message before the run terminal; no
    `node:started` is left without a partner. Asserted with several parallel abandoned nodes, not one.
11. A forced terminal with no prior `#failure` carries `run_timeout`, never an undefined cause.
12. The grace timer is disarmed on a normal settle, on `abandon()`, and on a fenced settle — proven by the
    armed count, so a clean run leaves no timer holding the event loop open.

**The generation fence (§5)** — one assertion per point, none folded together:

13. Two parallel siblings: `B`'s dispatch does **not** stale `A`'s, and both write normally.
14. The same vertex re-dispatched: the older dispatch's writes are refused, the newer's admitted.
15. A stale dispatch's `cost:updated` changes neither `cumulativeCostMicrocents` nor what any subscriber
    receives.
16. A stale dispatch's `save_to` does not write.
17. A stale `prepare` is refused; a stale `settle` and a stale `discard` are **admitted** — the paired test
    that stops a fix for one from re-creating `PR83-04`'s stranded row.
18. A ledger write for an already-incurred charge completes when stale; the run-total fold does not.

**Mutation discipline.** Per the phase's working discipline each of the above is confirmed to FAIL with its
production change reverted, and the mutation is confirmed to have landed before the red is trusted.

### 9. Landing obligations

These land with the implementation, not after it:

- **The deadline primitive gets one home.** `openDeadline` currently lives in
  `packages/llm/src/attempt-deadline.ts`, is not exported from that package's `index.ts`, and
  `packages/llm/package.json` exposes only `.` and `./adapters` — so `@relavium/core` cannot reach it
  through any supported path, and a node deadline importing from the LLM package would be the wrong
  layering besides. It moves to `@relavium/shared` (where `AbortSignalLike` already lives, and where the
  duplicated `AbortControllerLike` definitions in `@relavium/llm` and `@relavium/core` can converge);
  `@relavium/llm` re-exports it and keeps `DEFAULT_ATTEMPT_TIMEOUT_MS`, which is an LLM-specific default.
- ADR-0036 gains a dated **Amended by** note recording that its "structurally impossible" claim rests on a
  mechanism that did not exist until this ADR, and that §6 names the half still conditional on the store
  seam. ADRs are append-only; the original text stays. **Landed 2026-08-27** — ahead of the implementation,
  because deferring it is what left ADR-0036 silently wrong for a reader following CLAUDE.md's own
  numerical reading order, and every sibling amendment (ADR-0074, ADR-0078, ADR-0079, ADR-0083) added its
  reciprocal note at acceptance.
- [phase-1-engine-and-llm.md](../roadmap/phases/phase-1-engine-and-llm.md)'s 1.N acceptance criterion is
  corrected where it repeats the same claim as shipped.
- [node-types.md](../reference/shared-core/node-types.md) and
  [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md) state what the `agent` node's
  `timeout_ms` now does, that it is absolute across retries, and what error it produces.
- [sse-event-schema.md](../reference/contracts/sse-event-schema.md) records that `run_timeout` is carried
  by three distinct causes — the run cap, a gate deadline and a node deadline — and that `error.nodeId`
  distinguishes them. [error-handling.md](../standards/error-handling.md) gains the same sentence where it
  classifies the code.
- [execution-model.md](../architecture/execution-model.md) names all three `timeout_ms` sites, not two, and
  its "Failure and recovery" idempotency-key sentence is brought in line with ADR-0080's tiered contract.
- The phase document's decision register points `CR-20` and `CR-23` at this ADR, and
  [deferred-tasks.md](../roadmap/deferred-tasks.md) records §7's quarantine trigger and §6's store-liveness
  follow-up. **Landed 2026-08-27**, for the reason a review had to point out: §7 below already asserted the
  recording in the present tense while this list still carried it as pending and the file had never been
  touched — a claim reading as shipped inside the ADR that exists to remove exactly that.

## Consequences

### Positive

- The exactly-one-terminal invariant becomes a **liveness** property with respect to the executor, which is
  what `relavium run` needs to be safe to script, and §6 says exactly what it still rests on rather than
  restoring an unconditional claim.
- An authored `timeout_ms` on an agent node does what the reference documents already promise, closing a
  false claim rather than deleting a field — and it means one node-worth of time, not one per hidden retry.
- ADR-0028's run `timeout_ms` becomes enforceable against a hung node, and its own trigger path stops
  depending on a durable write completing first.
- Money, files and effects gain a fence whose rule is stated per method, so closing one hole cannot open
  `PR83-04`'s.
- One mechanism at one place covers both items, so a future reader finds the liveness story together rather
  than deducing it from two.

### Negative

- **A forced terminal can end a run whose node was merely slow to unwind.** Mitigated by the window being a
  cleanup window rather than a work deadline — a node that needs longer to *work* has `timeout_ms` and the
  run cap for that — and by §4's node terminal, which names the abandoned vertex instead of leaving the log
  silent.
- **The abandoned executor keeps running**, and on a long-lived host §7 accepts that its work can
  accumulate across runs. Stated with a named revisit trigger rather than mitigated.
- **`run_timeout` now names three things**, so the code is narrower than its meaning. Mitigated by
  `error.nodeId` and by §9's doc obligation, and preferred over widening a closed taxonomy every surface
  switches on.
- **Two new one-shot `work` timers join the run loop** — the node deadline and the post-abort grace window
  — alongside the existing run timeout, gate timeout, retry backoff and media-job poll. Mitigated by
  reusing the one injected `setTimer` port, so they are disarmed and counted by the same harness as the
  rest.
- **The fence adds a check to five hot-path sites and a per-vertex map to the run.** The cost is a
  comparison and one small map; the alternative is four unguarded mutation points, one of which writes to
  the user's filesystem.
