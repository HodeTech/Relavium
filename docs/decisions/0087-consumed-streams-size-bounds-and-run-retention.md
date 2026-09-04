# ADR-0087: A stream is bounded by whether anyone reads it; outputs and events are bounded by size; finished runs are bounded by count

- **Status**: Accepted — 2026-09-04, with the nine dated corrections recorded below (Proposed 2026-08-29; it merged unapproved, and a review refused acceptance until the corrections existed)
- **Date**: 2026-08-29
- **Decides**: `CR-32` and `CR-33` of [Phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md)
  (`W3`), plus the stream-consumption question `CR-30` uncovered and could not answer within
  [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md).
- **Refines (not reverses)**: [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md) — its
  no-drop, bounded-per-consumer, producer-await policy is kept **exactly** for every stream that has a
  consumer. §1 answers the case that policy never named: a stream that has none.
- **Related**: [ADR-0042](0042-engine-media-storage-substrate-mediastore-deinline-retention.md) (the engine references media by
  handle) · [ADR-0078](0078-ordered-durable-append-and-the-terminal-outbox.md) §6 (what `#emitDurable` owes) ·
  [ADR-0086](0086-absolute-admission-ceilings-on-authored-values.md) (the authored-value ceilings this sits
  beside) · [sse-event-schema.md](../reference/contracts/sse-event-schema.md)
- **Amends (a refinement, not a reversal)**: [ADR-0042](0042-engine-media-storage-substrate-mediastore-deinline-retention.md)
  §2 — that ADR pins `deInlineMedia` at `#emitDurable` as the sole emit-time transform; §3 below moves the
  transform for a node's OUTPUT earlier, to the node boundary, so state and log hold the same value. ADR-0042's
  own invariant (a persisted event carries handles, never bytes) is untouched, so it keeps its Status and gains
  a dated amendment note. It was listed only as *Related* while this ADR was Proposed; that undersold it.
- **Implementation**: **partial, and stated rather than implied.** §2 (the three size bounds) and §4 (count-based
  retention) shipped in `W3`. §3 (media normalised once, at the node boundary) shipped in `W5` as `CR-54` — later
  than this ADR and under a different item number, which is why the register described it as unimplemented for two
  waves. **§1 is a recorded decision with no implementation**: no consumption mode exists anywhere in the tree, and
  the `W3` live blocker it exists to fix — an un-pulled stream dropping the terminal — is still open. "Accepted"
  here means the decision is settled, not that §1 ships.

> **Correction 1 (2026-09-04) — §1 names ONE seam for two situations that do not share one, and "loud" is too
> generous.** §1 puts the consumption mode on `createRunHandle` / `createSessionHandle` as though they were
> symmetric. They are not, and the asymmetry decides how §1 gets built. **`createSessionHandle` is exported and
> a host calls it directly** — `apps/cli/src/chat/session-host.ts` constructs both of its session handles — so
> for a session §1 is implementable exactly as written, and the caller that would pass `subscribe-only` is the
> very caller whose `subscribe()`-only attachment created the problem. **`createRunHandle` is not exported and
> no host calls it**: a `RunHandle` is produced inside `WorkflowEngine.start()` / `resumeFromCheckpoint()`, and
> neither `StartInput` nor `WorkflowEngineDeps` has a field that could carry a mode. So for a run the mode has
> to reach an engine entry point (or engine construction) first, with a stated default and every in-tree caller
> named — that plumbing is §1's real cost and §1 does not mention it. A review that read the two factories as
> equivalent concluded no host calls either; half of that is wrong, and the half that is right is the half that
> needs new API. Separately, §1's Negative calls a mis-wired handle "loud (an empty iteration)": an empty
> iteration is a clean EOF, indistinguishable from a correctly-closed handle — the same silent shape §1 rejects
> everywhere else. A `subscribe-only` handle should therefore not present an iterable at all (a discriminated
> union on the handle type), or iterating one should raise a `RunLoopInvariantError` the way
> `concurrent_consumer` already does. Two independent reviews reached that second point separately.

> **Correction 2 (2026-09-04) — §1's "Unchanged in every respect" is true of the change and false as a
> guarantee.** §1 says `iterated` mode is "lossless and bounded per consumer". It is not bounded today, and this
> was measured: `whenDrained()` resolves immediately whenever `buffer.length < capacity`, without reserving the
> slot it grants, so N concurrent producers at `capacity − 1` each get permission and the buffer peaks at
> `capacity + N − 1` (11 against a ceiling of 4 with 8 producers). `#wakeDrainWaiters` reserves correctly for
> producers already parked; the un-parked fast path does not. **Accepting this ADR does not close that**, and the
> obvious fix is known to be wrong — a consume/release permit was prototyped and measured to reinstate the
> original freeze, because `agent-turn.ts` awaits readiness per chunk while `tool_call_*`, `reasoning_*`, `stop`,
> `media_*` and `tool_result` emit nothing and leak a permit each. The correct shape moves the await to the emit
> site, which revises `CR-30`'s producer-await and therefore wants its own ADR rather than an amendment to this
> one. It stays open in the `W3` residuals.

> **Correction 3 (2026-09-04) — §1's replay sentence is a run fact stated as a universal one.** "The durable log
> is the record a late reader replays from" holds for a RUN. It does not hold for a session: per
> [sse-event-schema.md](../reference/contracts/sse-event-schema.md), no session resume reads a stored event log —
> a session's durable state is typed rows, and transient session events (`agent:token`, `agent:reasoning`) are
> never replayed from anywhere. So a `subscribe-only` **`SessionHandle`** is live-only, and "owes nobody" rests
> entirely on subscribers attaching before production starts. That is a precondition §1 relies on without naming,
> and it deserves a test rather than an assumption.

> **Correction 4 (2026-09-04) — a terminal event is NOT measured.** §2 says "a terminal event is measured and
> never refused", and `measureDraft`'s own doc comment repeats it. `measureDraft` returns `undefined` on
> `isTerminal` **before** calling `serialisedByteLength`, so nothing is measured, nothing is reported, and the
> word describes an intention no code holds. The decision — a terminal is never refused — is correct and
> unchanged; the accurate word is **exempt**. Read as written, §2's "events are bounded by size" is also
> narrower than the title suggests: a terminal event has no size bound at all, in either direction, and any
> transitive cap on its `outputs` / `partialOutputs` / `error.message` would be a NEW bound rather than a
> restatement of this one.

> **Correction 5 (2026-09-04) — the human-gate payload is counted, not refused, and §2 does not say so.** §2 says
> "an output or state breach fails the node". On the gate-resume path the engine calls `measureNodeOutput`,
> **discards the breach**, and adds the bytes to the running total; no aggregate check runs there either. That is
> deliberate and the code states its reason (the gate is already resolved and its vertex already marked
> completed, so refusing would strand a resumed run mid-settle), but the deviation belongs in the decision rather
> than only in a comment. Its residual is narrow and real: the run-level total catches an abusive payload *at the
> next node that adds to it*, so a gate that is the run's LAST node is never checked at all. It stays open in the
> `W3` residuals.

> **Correction 6 (2026-09-04) — §2 never defines the value domain it measures.** The bound is `JSON.stringify`
> over the post-de-inline value, and `JSON.stringify` is not a measurement of arbitrary JavaScript: a `Map` or a
> `Set` serialises to `{}`, a custom `toJSON` substitutes something else entirely, and an accessor runs. So a node
> can return a large unserialisable structure, measure at two bytes, pass every bound, and put a value in
> `#states` that a checkpoint replay cannot reproduce — live and resume then disagree about the workflow state.
> Cycles, `BigInt`s and functions are already caught (`serialisedByteLength` returns `undefined` and
> `measureNodeOutput` treats it as its own breach), which makes the remaining hole narrower but not principled.
> Closing it means deciding what a node output IS — normalise and validate to one strict JSON form, measure that
> form, and store and persist that same form — which refuses shapes that run today and therefore wants its own
> decision. Recorded as a residual, not settled here.

> **Correction 7 (2026-09-04) — §3 is implemented, and by a later wave than this ADR.** §3 shipped as `W5`'s
> `CR-54`: `#pinMediaOutput` runs at the dispatch boundary, `#settleCompleted` writes the pinned value into
> `#states`, the async media-job path re-enters through the same pin, and the human-gate payload is pinned too —
> and `deInlineMedia` rewrites **every** in-flight carrier, so a `base64` source becomes a handle exactly as a
> `url` does. The `W3` residual "media is measured as a handle but RETAINED as base64" is therefore closed, and
> `size-bounds.ts`'s sentence that "`state.output` keeps the raw form only because the de-inline is
> non-mutating" is stale. One review read that stale comment as proof §3 was unimplemented and concluded the
> opposite of the truth; a comment that outlives its code is not a harmless comment.

> **Correction 8 (2026-09-04) — §4's central premise is factually wrong; its conclusion survives without it.**
> §4 argues count-based over age-based because "an age policy needs a clock, and a clock in `packages/core` is a
> new host seam". `ExecutionHost.clock` has existed since [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md)
> and the engine reads it in a dozen places (lease expiry, gate deadlines, media-job deadlines, every event
> timestamp). An age policy would need no new seam. The decision still stands on the reasons that are true —
> determinism, no sweep, and "the last 100 runs stay addressable" being a promise a caller can reason about
> where "younger than T" depends on how busy the process was — and the same false premise is repeated in
> `engine.ts`'s retention comment, which is corrected with this note. §4 also calls the retention limit "a named
> constant" without saying where it lives: it lives in `ADMISSION_CEILINGS`, which is the wrong home — nothing
> about it is checked at admission — and moving it is a change to an exported const, so it is recorded rather
> than done here.

> **Correction 9 (2026-09-04) — §5 claims more movement than this ADR caused.** `turn_limit` carrying the
> run-level dispatch cap is [ADR-0086](0086-absolute-admission-ceilings-on-authored-values.md) §4's decision, and
> `GraphIssueKind` gained `ceiling_exceeded` for `CR-31`, also ADR-0086's item; none of this ADR's own three
> bounds produces a `GraphIssue` at all. "The two taxonomies this moved" should read as what the **wave** moved.
> The genuine contribution of §5 is the part worth keeping: an oversized durable event fails the run as
> `internal` rather than gaining an `ErrorCode` member, and a node/state breach is a typed `validation` — both
> applying [ADR-0082](0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md) §9. One
> live cross-reference knot is fixed alongside this note: `errors.ts` pointed a reader to ADR-0086 for
> `ceiling_exceeded`'s rationale, and ADR-0086 does not contain the word.

## Context

`W3` shipped three bounds. Two of them — the size limits and the retention policy — were settled as numbers in
the phase register and never recorded as decisions, so the reasoning behind them (why rejection rather than
truncation, why a terminal event is exempt, why a count rather than a clock) lived only in code comments. The
`ErrorCode` and `GraphIssue` taxonomies both moved to accommodate them. That is ADR territory by
[rule 9](../../CLAUDE.md), and a review correctly refused to merge without it.

The third is not a number but a hole, and it produced three defects in a row — each one the cure for the last:

1. `CR-30` wired ADR-0036's producer-await into the agent turn. It **deadlocked every CLI session**: no
   surface iterates `SessionHandle.events`, so the buffer filled, `whenDrained` stopped resolving, and a
   streaming reply froze mid-sentence.
2. Making `whenDrained` resolve for a never-pulled stream cured that and **reopened the unbounded buffer**
   `CR-30` exists to close.
3. Bounding the never-pulled buffer cured *that* and **dropped the terminal event**: a consumer attaching
   later received a clean EOF with no gap signal, which is exactly what ADR-0036's gap-free contract forbids.

Each fix was locally correct. The thing none of them addressed is that **the engine builds a buffered,
lossless, back-pressured stream for consumers that do not exist**. Measured across the whole repository:
`apps/cli/src/commands/drive.ts` holds the *only* `for await` over a handle's events; every other surface —
`persister.ts`, `chat-ink.tsx`, `chat.ts` (twice), `agent-run.ts`, `drive-home.tsx` — attaches with
`subscribe()`, which is a separate bus subscription that never drains the primary buffer at all.

## Decision

### 1. A handle declares whether its primary stream will be consumed, and that decides everything else

`createRunHandle` / `createSessionHandle` take an explicit **consumption mode**:

- **`iterated`** — someone will `for await` the stream. It is **lossless and bounded per consumer with a
  producer-await**, exactly as ADR-0036 decided: nothing is dropped, and a producer that outruns the consumer
  waits. Unchanged in every respect.
- **`subscribe-only`** — nobody will iterate it. There is **no primary buffer**: `push` is a no-op,
  `whenDrained` resolves immediately, and iterating the stream yields nothing.

**Nothing is dropped in either mode, and that is the point of stating the mode rather than inferring it.** A
drop is losing an event a consumer was owed. A `subscribe-only` handle owes nobody: every subscriber received
every event synchronously as it was emitted, and the durable log is the record a late reader replays from —
which is what ADR-0036 already prescribes for a late subscriber. The previous behaviour, buffering "just in
case", is what created the choice between deadlocking, growing without bound, and dropping — three bad answers
to a question that should not have been asked.

Considered **inferring the mode from whether `next()` was ever called** (rejected — that is what shipped, and
it is a race by construction: the answer changes depending on when the first pull happens relative to the
first push, which is precisely why the terminal went missing). Considered **making the subscribe path drain
the buffer** (rejected: a fan-out to N listeners through a single-consumer queue means one slow listener
throttles the run, and the queue would be pure overhead on a path that already delivers synchronously).
Considered **always keeping the terminal even over the ceiling** (rejected: it treats the symptom, and leaves
a silent `sequenceNumber` gap the consumer cannot distinguish from a clean stream).

**A `subscribe-only` handle must say so at construction and cannot change its mind.** A mode that could flip
would re-create the race this replaces.

### 2. Three size bounds, at the value that reaches the durable boundary

| What | Bound | Measured on |
|---|---|---|
| One node's output | **256 KiB** | the value after media de-inlining |
| Total workflow state | **4 MiB** | every retained node output, summed |
| One durable event | **1 MiB** | the de-inlined draft |

**Rejection, never truncation.** The tool-result bound in `tools/bounding.ts` truncates and spills because a
preview of a big file is still useful to a model. A workflow output is not a preview of anything: half of one
flowing silently into the next node's template is a wrong answer that looks like a right one. An output or
state breach fails the node with a typed `validation` error naming the field, the size and the limit.

**A terminal event is measured and never refused.** A run that cannot publish its terminal is worse in every
way than one that wrote an oversized final event: the stream never closes, the lease is never released, and no
surface can tell whether the run finished. ADR-0078 §6 draws the same line for a store fault. The durable-event
breach is raised at the emit choke point where no node is in scope, so it fails the **run** through the
engine's internal backstop rather than a per-node `validation` — an asymmetry worth stating rather than
glossing.

**Three bounds and not one**, because a single shared number is either useless (set at the state limit) or
absurd (a state limit applied per node).

### 3. Media is normalised ONCE, and state holds what the log holds

Measuring an inline media part as the `media://` handle it becomes is correct — that is what reaches the
store — but it is only half of what ADR-0042 decides. **The engine references media by handle**, and retaining
raw base64 in `#states` while the durable event carries a handle means the in-memory state and the log hold
different values, and a downstream node reads bytes the record does not have.

So a produced media part is de-inlined **once, at the node boundary**, and the handle form is what the state
retains, what downstream templates read, and what the event carries. The size bound then measures the same
value everything else uses, rather than an estimate of it.

### 4. Finished runs: count-based retention, N = 100, FIFO

An engine keeps the last **100** settled runs addressable and evicts the oldest. Only a run that actually
settled is queued — a parked run, waiting on a human gate or a media job, is live work this process owns.

**Count-based rather than age-based**, and the reason is not convenience: an age policy needs a clock, and a
clock in `packages/core` is a new host seam for a bound a count expresses just as well. "The last 100 runs stay
addressable" is a promise a caller can reason about; "runs younger than T" depends on how busy the process was.
It is also deterministic, so a test asserts it rather than waiting for it.

**What eviction costs, stated rather than discovered.** A retained settled run lets `resume`/`cancel` answer
`run_already_terminal` instead of `unknown_run`, and drops `resumeFromCheckpoint`'s `run_already_active` guard.
Neither is a safety property: the terminal-checkpoint branch independently returns a closed handle, and the
run's outcome is in the durable log, which is where a surface reads a finished run's result from anyway.

### 5. The two taxonomies this moved, and why neither was widened

`turn_limit` carries the run-level dispatch cap and `internal` carries an oversized durable event. Neither got
a new `ErrorCode` member, on [ADR-0082](0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md)
§9's reasoning that a closed taxonomy every surface switches on should not gain a member for a distinction the
message already carries. `GraphIssueKind` DID gain `ceiling_exceeded`, because that union exists to let a
caller narrow on the fault class and an admission ceiling is a genuinely new class.

## Consequences

### Positive

- The stream question has one answer instead of three failed ones, and the answer removes the buffer rather
  than choosing which way it should misbehave.
- ADR-0036's no-drop guarantee becomes true again for every stream it applies to, rather than true-in-theory.
- State, downstream reads and the durable log agree about what a media output is.
- The numbers a run is judged against are in an ADR and in the canonical specs, not only in code comments.

### Negative

- **A handle's construction gains a required decision**, and a host that gets it wrong gets nothing on the
  stream rather than a slow one. Accepted: the wrong answer is loud (an empty iteration) rather than quiet
  (a freeze), and every in-tree caller knows which it is.
- **De-inlining at the node boundary moves a host round-trip earlier**, into the settle path. Accepted: it
  already happened before the durable write, and doing it once is strictly less work than doing it once and
  estimating it once.
- **A previously-completing run can now fail** on a size bound. Accepted for the reason ADR-0086 §9 gives for
  its own ceilings: the alternative is an engine with no defined behaviour at the extremes.
- **Retention is one more number that will eventually be wrong.** Accepted rather than pretended otherwise;
  it is a named constant and moving it upward is not a breaking change.
