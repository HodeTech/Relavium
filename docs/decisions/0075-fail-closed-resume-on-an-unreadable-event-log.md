# ADR-0075: A resume fails closed on an unreadable event log (amends ADR-0074 §5)

- **Status**: Accepted
- **Date**: 2026-08-09
- **Related**: [ADR-0074](0074-durable-conservative-budget-commitments.md) §5 (the tolerant read this amends), [ADR-0050](0050-cli-history-db-at-rest-posture.md) (durability-first posture), [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md) (durable run events), [ADR-0045](0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) (async media re-attach), and [sse-event-schema.md](../reference/contracts/sse-event-schema.md) (the canonical event contract, incl. §Forward-compatibility).

## Context

[ADR-0074](0074-durable-conservative-budget-commitments.md) §5 made the stored-event read boundary **tolerant**: an unknown event `type` is dropped, a known type with an invalid body still fails loud. That decision was right, and it fixed a real doc↔code contradiction — `sse-event-schema.md` had always promised that adding a new event type is not a breaking change "provided consumers ignore unknown `type`s", while all three schema unions actually threw.

One read is not like the others. **`checkpointer.ts` builds resumable state from what the read returns**, and a resume does not display a log — it decides what work still has to happen. An older binary that drops a row it cannot interpret has no way to know whether that row was a node terminal, an async job submission, a gate decision, or a cost commitment. So it can re-run a node that already completed, re-submit a media job the provider has already billed, re-ask a gate the user already answered, or resume against a cap that has forgotten money that was already owed.

The mitigation that shipped with §5 is real but narrower than it looks: the read returns the skipped rows' authoritative `seq` values, and the checkpointer folds them into the sequence high-water mark. That prevents a resumed run colliding on `UNIQUE(run_id, seq)`. **It does not restore lost state.** A run that resumes with a hole in its fold is not a run that reports an error — it is a run that quietly does the wrong work.

§5 considered exactly this and rejected it, in one sentence, for three reasons. Each is answered below, because reversing part of a decision without engaging its stated reasoning is how a corpus stops being trustworthy.

There is also a forcing function. The per-attempt realized-cost ledger (`#W15-1`) will add a **new durable event type**. The moment it ships, an older binary reading such a log lands on precisely this path — so the policy governing that path has to be settled first, exactly as §5 settled the tolerant read before the event that needed it.

## Decision

**A read that feeds a REPLAY fails closed when any row was skipped; a read that feeds a DISPLAY stays tolerant.**

Concretely: the resume path asks for the log through a distinct entry point that refuses when `skipped` is non-empty, reporting that a newer Relavium is required and naming the rows. `logs`, `status`, `gate list` and the Home keep §5's tolerant read unchanged — they were, and remain, the surfaces where a user goes to find out which run is broken.

Considered and rejected:

- **Classify events as state-bearing vs. observational, and tolerate only the latter** (the alternative weighed alongside the chosen one). It reads as the more precise option and is the less honest one: the classification would be written from *today's* knowledge, and the whole problem is an event this binary has never seen. An older binary cannot ask whether an unknown discriminant is state-bearing; the only safe default for an unclassifiable row is to refuse, which collapses back to this decision plus a table that can only ever be wrong in the dangerous direction.
- **Version-gate the log** — refuse a downgrade whenever a run carries anything newer. This is what §5 rejected, and it is still rejected, for §5's first reason: it needs a durable version marker the schema deliberately does not have.
- **Leave it as is and rely on the high-water mark.** It prevents a write collision, not a wrong decision; see Context.

### Why the session path needs no counterpart

ADR-0074 §5 applied the tolerant read to the session union too, because `budget:estimate_committed` is
dual-envelope — so the obvious question is whether `chat-resume` needs the same refusal. It does not, and the
reason is structural rather than a judgement call: **no session resume reads a stored event log.** Session
events are never persisted at all (the run store rejects one that reaches it); a session's durable state is
typed ROWS — `session_messages`, `agent_sessions`, `session_costs` — and `chat-resume` reconstructs from those
through `loadFull`, where a row that does not parse already fails loudly under its own schema. The tolerant
session union exists so a dual-envelope event can be READ, not so a session can be replayed past a hole.

If a session-side event replay is ever introduced, it inherits this decision and must take the strict entry
point. Said here because "the session half was simply forgotten" is the reading this section exists to rule
out.

### Answering §5's three reasons

1. *"It needs a durable version marker the schema deliberately does not have."* **It does not, and this is the fact that changed.** The resume path never needs to know which version wrote the row, or that a version boundary exists at all — only that *this* binary could not read *some* row. `skipped.length > 0` is that signal, and it already exists: the `RunEventLog` shape that returns it shipped with §5's own implementation. The marker is **derived at read time, not stored** — so the schema keeps its "versioned by additive evolution, not a version field" property intact.

2. *"It converts a recoverable read into a hard failure."* True, and accepted — **scoped**. It converts exactly one read into a hard failure, and leaves recoverable every read a user reaches while diagnosing. The recovery §5 wanted to preserve is the ability to look at a damaged run; that is untouched. What is now refused is continuing to execute one.

3. *"It would leave the documented ignore-unknown promise unfulfilled."* The promise in `sse-event-schema.md` §Forward-compatibility is addressed to **consumers of the event stream** — the surfaces that render it — and it stays fulfilled for every one of them. A resume is not a consumer of a stream; it is a reconstruction of authoritative state, and it is the one caller for which "ignore what you do not understand" is not a safe instruction. The spec is amended to say so rather than left to imply the opposite.

## Consequences

### Positive

- A resume can no longer silently re-run completed work, re-submit an already-billed media job, or re-ask an answered gate because a row was written by a newer binary.
- The refusal is actionable and specific: it names the run, the count, and the leading `seq` values, and the remedy — upgrade — is one the user can actually perform. Compare the failure it replaces, which produced no message at all.
- `#W15-1`'s new event type can ship without a hidden downgrade hazard, because the degradation is now defined rather than emergent.
- The signal is derived, so no schema change, no version column, and no migration.

### Negative

- **A newer binary's purely observational event blocks an older binary's resume.** A `run:started` written by a future Relavium with an added `agent:thought` row is refused even though nothing state-bearing was lost. This is deliberate — see the rejected classification alternative — and the cost is bounded by the remedy being an upgrade rather than data recovery. Mitigation: the message says which rows, so a user can see it is a version gap and not corruption.
- **A user who cannot upgrade cannot resume that run.** The run is not lost — every read-only surface still shows it, and its outputs and costs remain readable. Mitigation: that asymmetry is the point, and the message states it, so the user is not left guessing whether the data is gone.
- **Two read entry points where there was one**, and a future caller could pick the tolerant one for a replay — the type system cannot prevent it, since both return readable events. Mitigation: the strict entry point is the one named for replay, both docblocks carry the constraint, and `checkpointer.test.ts` pins that the resume path refuses a log with a skipped row. That pins today's caller, not tomorrow's; a reviewer, not a compiler, is what catches a new one.
