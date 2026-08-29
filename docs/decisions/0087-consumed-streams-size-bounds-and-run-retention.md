# ADR-0087: A stream is bounded by whether anyone reads it; outputs and events are bounded by size; finished runs are bounded by count

- **Status**: Proposed
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
