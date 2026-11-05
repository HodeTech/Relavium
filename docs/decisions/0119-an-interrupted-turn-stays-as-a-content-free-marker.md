# ADR-0119: An interrupted turn stays in the session as a content-free marker

- **Status**: Proposed
- **Date**: 2026-11-05
- **Related**: [ADR-0026](0026-session-export-to-workflow.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0081](0081-the-compaction-summary-is-untrusted-and-the-system-prompt-is-branded.md), [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md), [ADR-0098](0098-a-session-effect-row-holds-no-result-and-never-replays.md), [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md), [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md), [D67](../roadmap/current.md#wave-gating-decisions), [the CR-71 residual](../roadmap/deferred-tasks.md)

## Context

[ADR-0095](0095-what-an-agent-session-remembers-across-turns.md) §1 persists a
**completed** turn as content-free structure. Its rows record which tools ran,
in what order, how large their arguments and results were, and whether each
errored.

A turn that does **not** complete leaves nothing behind. That covers a turn
that fails, one ended by a fatal denial, one the user aborts (Esc, or Ctrl-C
under [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md)), and one
that hits the turn limit. In each case:

- the engine rolls back the pending user message (ADR-0057's abort clause, and
  the same path on failure);
- the persister writes no row;
- the model's next turn has no idea the request happened.

The real hazard is a turn that **dispatched tools before it died**. The edit was
applied or the command ran, and the only trace is the effect row
[ADR-0098](0098-a-session-effect-row-holds-no-result-and-never-replays.md)
discloses on the next resume. The model, asked to retry, cannot know that the
first half of the work is already done, so it can apply it twice.

ADR-0095's Negative section recorded this as a residual, and the deferred-task
ledger carries it. On 2026-11-04 the maintainer pulled it into MVP-4 (D67): the
interrupted turn stays in context as a **content-free interruption marker**.
CR-71 itself stays closed, since it shipped in W7.

Carrying prior turns' tool **content** into the model's context stays deferred
under CR-70 (ADR-0095 §2). This ADR must not carry any content.

## Decision

**A turn that ends without a completed answer stays in the session's in-memory
transcript and durable rows. It is stored as the user's message, the
content-free structure of the tools it dispatched, and one engine-authored
marker naming the outcome from a closed set.**

### 1. What is kept

**Scope.** This applies to every `AgentSession` turn whose user message the
session accepted and that ended:

- aborted by the user;
- failed (any classified error);
- denied fatally (a class ADR-0117 keeps fatal);
- at the turn limit.

A refusal before the session accepted the message, such as an invocation error
or a pre-flight refusal, adds nothing, as today.

**What is stored:**

- **The user's message**, as an ordinary user message. The rollback of the
  pending message on abort and on failure is withdrawn. This amends ADR-0057's
  abort clause.
- **The tool structure**, under ADR-0095 §1's invariants: registry-resolved
  names, engine-assigned ids, sizes and an errored flag, never arguments or
  results.
  - A call that was dispatched but whose outcome the engine never observed (it
    was interrupted mid-execution) is recorded as **outcome unknown**, not as
    succeeded or failed.
  - These statuses agree with the session's effect rows (ADR-0098).
- **One marker**, carrying:
  - a closed-set **reason**: `aborted`, `failed` with the classified error code,
    `denied`, `turn_limit`;
  - the ordered list of dispatched tool **names** with their statuses
    (`completed`, `errored`, `outcome unknown`).

  It carries no message text, no tool content and no provider error text.

**What is not stored.** Partial assistant text streamed before the end is
neither stored nor sent. It is incomplete model output, and it may be the reason
the user stopped the turn. Reasoning and signatures are dropped at the turn
boundary, as for every turn.

### 2. What the model sees

On the next request, the interrupted turn appears as the user's message followed
by the marker, rendered as a **fixed engine-authored note** from the marker's
fields.

The note sits behind
[ADR-0081](0081-the-compaction-summary-is-untrusted-and-the-system-prompt-is-branded.md)'s
role boundary. It is user-role framing that the engine writes from a closed set
of templates, never inside an assistant message and never in the system prompt.

**What the note does:** it tells the model the request was interrupted and which
tools had already run. The model can then avoid repeating an applied edit, or
check an unknown outcome before acting.

**What it does not do:** it carries no tool content, so CR-70 stays deferred,
and a tool's arguments and results still never reach a later turn.

Provider adapters may need consecutive user-role messages merged. That is
`@relavium/llm`'s concern, behind the seam. The exact message shape lives in
[agent-session-spec.md](../reference/contracts/agent-session-spec.md).

### 3. Durability and the other consumers

- **Persistence.**
  - The interrupted turn commits atomically, on its terminal
    `session:turn_completed`, like a completed turn (ADR-0095 §1 invariant 6).
  - A failed write latches, as today.
  - Resume reproduces the transcript exactly, interrupted turns included
    (invariant 4).
  - The marker is a new content-free part type with a closed reason enum,
    added to the shared schema.
- **Compaction and trim** count an interrupted turn as a turn. Boundaries stay
  turn-identified (invariant 5).
- **Reseat** carries the marker, because it has no content.
- **Export** ([ADR-0026](0026-session-export-to-workflow.md), ADR-0095 §3)
  shows an interrupted turn as interrupted, with its tool structure. Deriving a
  workflow never turns an interrupted turn into a step.
- **ADR-0095 §1** gains a dated amendment note: "a completed turn" becomes "a
  completed or interrupted turn". The no-tool-content-at-rest invariant is
  unchanged.

### Alternatives considered

- **Keep rolling back, and rely on the effect-row disclosure at resume.**
  Rejected. The model is the one that needs to know, during the live session,
  not only after a resume.
- **Keep the partial assistant text.** Rejected. It is incomplete, possibly
  wrong output that the user may have stopped on purpose. Carrying it would
  make an abort less effective as a "stop that".
- **Carry the interrupted tools' results so the model can resume the work.**
  Rejected for now. That is CR-70's content carrying, deferred with ADR-0096 §5
  to v0.2.1.
- **Put the note in an assistant message.** Rejected by ADR-0081's role
  boundary. An engine-authored assistant message would claim words the model
  never said.

## Consequences

### Positive

- A retry after an interrupted turn knows what already happened, so a
  half-applied edit is not applied twice blindly.
- The transcript is faithful: what the user asked stays visible, on screen and
  after resume, even when the answer never came.
- No tool content reaches disk or a later request. ADR-0095's at-rest invariant
  and CR-70's deferral both hold.

### Negative

- More persisted rows, and one more part type in the shared schema that every
  consumer must handle: resume, compaction, export, the coming transcript
  repaint and the Home's session views.
- A user who aborted *because* they regretted the request now has it in
  context. Removing a turn is `/rewind`'s job (2.6.E), not an abort's.
- The outcome-unknown status has to be derived faithfully from the dispatch and
  effect bookkeeping. A wrong status would mislead the model about a side
  effect, so it needs its own tests.
