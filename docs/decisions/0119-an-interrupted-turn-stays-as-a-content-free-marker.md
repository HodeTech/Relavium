# ADR-0119: An interrupted turn stays in the session as a content-free marker

- **Status**: Accepted — 2026-11-16, by the maintainer, after a twelve-finding design review (every finding is dispositioned [below](#review-disposition--2026-11-16)). **The implementation, two independent review rounds with no blocker/high/medium finding, and a separate security sitting on the resume path (D64) are owed**; this ADR accepts the design, not the code.
- **Date**: 2026-11-05 (revised 2026-11-06 after the PR #97 review; **revised 2026-11-16** after the twelve-finding review)
- **Refines**: [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md) §1 (a turn is identified by row structure; its terminal row may now be an *interruption row*, which needs one migration — see §2) and §4 (an interrupted turn takes one `window` slot); amends [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md)'s abort clause (the rollback is withdrawn for the retained cases below).
- **Related**: [ADR-0026](0026-session-export-to-workflow.md), [ADR-0081](0081-the-compaction-summary-is-untrusted-and-the-system-prompt-is-branded.md), [ADR-0098](0098-a-session-effect-row-holds-no-result-and-never-replays.md), [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md) (**not a dependency**, §1), [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md), [ADR-0123](0123-restored-transcripts-use-host-recorded-display-text.md), [ADR-0128](0128-content-free-tool-receipts-ground-later-chat-turns.md), [ADR-0131](0131-a-round-that-made-progress-resets-the-correction-budget.md), [D67](../roadmap/current.md#wave-gating-decisions)

## Context

[ADR-0095](0095-what-an-agent-session-remembers-across-turns.md) §1 persists a **completed** turn as
content-free structure: which tools ran, in what order, how large their arguments and results were, and
whether each errored.

A turn that does **not** complete leaves nothing behind. That covers a turn that fails, one ended by a fatal
denial, one the user aborts (`Esc` today), and one that exhausts the tool-round limit. In each case:

- the engine rolls back the pending user message (ADR-0057's abort clause, and the same path on failure);
- the persister writes no row;
- the model's next turn has no idea the request happened.

The real hazard is a turn that **dispatched tools before it ended**. The edit was applied or the command ran,
and the only trace is the effect row [ADR-0098](0098-a-session-effect-row-holds-no-result-and-never-replays.md)
discloses on the next resume. The model, asked to retry, cannot know the first half of the work is done, so it
can apply it twice. A real session lost a 3 min 50 s, 590 000-token turn to `tool_failed` and the model then
answered that no tool had been called; ADR-0131 makes that failure rarer, but the forgetting is this ADR's.

ADR-0095's Negative section recorded the residual (CR-71's remainder), and on 2026-11-04 the maintainer pulled it
into the CLI MVP (D67). It is scheduled as its own increment ahead of MVP-4 (**MVP-3c**), not inside MVP-4.

> **MVP-2 compatibility note — 2026-11-09.** Accepted
> [ADR-0123](0123-restored-transcripts-use-host-recorded-display-text.md) introduces separate host-recorded user
> display metadata. Every interrupted user-row insert carries the captured display metadata **in the same
> transaction**, under the existing
> [role-restricted storage contract](../reference/shared-core/database-schema.md#proposed-user-display-storage--mvp-2).
> No completed-success-only restriction is added to that metadata.

## Decision

**A turn that the session accepted, in which a provider engaged, and that ends without a completed answer in one
of the ways listed in §1, stays in the session. It is stored as the user's message, the content-free structure of
the tools it dispatched, and one *interruption row* naming the outcome from a closed set. The model sees it as a
fixed engine-authored note, built from the same projection as ADR-0128's receipts.**

### 1. What is retained, and what is not

**Retained** when the session accepted the user message **and a provider engaged** (the predicate the hard turn
cap already uses, so a retained turn and a counted turn are the same set), and the turn ended by:

| The turn ended by | `reason` | `code` stored |
|---|---|---|
| the turn-level abort (`stopReason: 'aborted'`, no error — today `Esc`; ADR-0115's first Ctrl-C is the same event, so this ADR has **no dependency on ADR-0115**) | `aborted` | — |
| a classified error `tool_denied` (the denials ADR-0117 keeps fatal) | `denied` | — |
| a classified error `turn_limit` raised by the **within-turn** `maxToolTurns` guard | `turn_limit` | — |
| any other classified error | `failed` | the error's code, from the closed `ErrorCode` taxonomy |

**Not retained — today's rollback stays:**

- **Session-ending cancellation** (`/cancel`, a first SIGINT/SIGTERM that ends the session, `session:cancelled`).
  `cancel()` is terminal and emits no `session:turn_completed`; the persister's only action is to end the
  session. Making it write an interrupted turn would add a second terminal to a turn. ADR-0098's effect-row
  disclosure at the next resume is the trace for work dispatched in such a turn. (ADR-0115 keeps this path
  consistent: its first Ctrl-C is the turn abort above; only the second press ends the session.)
- **Process death** (crash, `kill -9`, power loss). Nothing is emitted. A user row with structural rows and **no
  terminal row** is a *crash remnant*: it keeps ADR-0095's rule (a new user message abandons it; a trailing one
  is rolled back). The word "died" in earlier drafts meant the turn *ended*, not the process.
- **An unclassified throw** (`internal` from something that is not an `AgentTurnError`). The turn cannot vouch
  for its tool list, so it is not retained.
- **A refusal before the session accepted the message** — an invocation error, a pre-flight refusal, and the
  **session's hard turn cap** (`turn_limit` raised before the message is accepted). These add nothing, as today.
- **A turn in which no provider engaged** (a pre-egress budget refusal, a pre-flight abort).

The reasons are exactly four and the codes exactly the `ErrorCode` taxonomy; nothing else can be stored.

### 2. What is stored

A retained turn is persisted as the same rows as a completed turn up to its terminal row:

`user → (assistant(tool_call) → tool)* → system(interruption)`

- **The terminal row is a `role: 'system'` row with empty `content` and a typed `interruption` field.** It is not
  an assistant message (ADR-0081 forbids an engine note inside one) and not a user message (it would break
  ADR-0095's turn identity). `role: 'system'` here is a storage encoding only, exactly as for the compaction marker.
- **The user row** carries ADR-0123's display metadata in the same transaction.
- **The tool structure is the ADR-0095 §1 structure, unchanged.** Names are the registry-resolved ones, ids are
  engine-assigned, sizes are byte counts. **Only dispatched calls are recorded.** A call in flight when the turn
  ended is recorded with outcome **`cancelled`** and `resultBytes: 0` — ADR-0128 already defines `cancelled` as
  "execution state unknown", and this is its first live producer. Calls the model requested that never started
  are not recorded.
- **Not stored:** partial assistant text (incomplete, possibly wrong, possibly why the user stopped), reasoning
  and signatures (dropped at the turn boundary as for every turn), arguments, results, provider error text.

**The channel.** The turn core's single catch already attaches `usage`/`engaged` to the `AgentTurnError` in place.
It attaches the **settled tool history** there too (`AgentTurnError.toolHistory`), and records the `cancelled`
entry for an in-flight call before it rethrows. `AgentSession` then emits
`session:turn_completed` with the additive, content-free `toolHistory` (already carried for a successful turn)
**and a new additive `interruption: { reason, code? }`** set exactly when the engine retained the turn. The
persister writes the interruption row **iff the event carries `interruption`** — it never re-derives the
predicate, so the engine and the store cannot disagree. `SessionToolHistoryEntrySchema` is unchanged: a pair is
still a pair, and a `cancelled` result already exists in its outcome enum.

**The shape.** `SessionMessage` gains
`interruption?: { reason: 'aborted' | 'failed' | 'denied' | 'turn_limit'; code?: ErrorCode }` (strict), valid
**only on a `role: 'system'` row**, never together with `compaction`, with `code` present **iff** `reason` is
`failed`. The database stores it in two nullable columns (`interruption_reason`, `interruption_code`) with
`CHECK` constraints for the closed sets; **one migration**. ADR-0095 §1's sentence "no migration is needed" is
amended: the interruption row is the one structural element that needs a column, because a closed, typed,
database-checked value cannot be forged through free text and matches the compaction marker's precedent.
The generic durable content union (`session-content.ts`, the "Session content parts" section of the database
reference) is **not touched**: this is a row field, not a content part, so ADR-0095's 2026-09-18 session-only
arm holds.

**Atomicity.** One transaction at `session:turn_completed` (ADR-0095 invariant 6): the user row, the structural
rows and the interruption row. A failed write latches as a failed text write does. The turn's real token usage
accumulates into the session's token columns — the exchange now exists — and the cost flush is unchanged.

### 3. Turn identity, resume and the hard cap

`projectSessionHistory` treats an interruption row as the **terminal of the open exchange** and records the
turn's kind and reason. A user row with structural rows and no terminal remains a crash remnant, so the two
cases are distinguished by structure alone and never by a heuristic.

- `resumableSessionMessages` yields an interrupted turn's **user message only** (no terminal text).
- The interruption row's sequence is the turn's **boundary slot** (ADR-0095 invariant 5), exactly as a completed
  turn's terminal row is, so compaction and trim identify an interrupted turn by turn.
- `reconstructSessionState` counts a retained turn in `turnCount`. Live and restored counts agree because both
  count the same predicate (a provider engaged).
- A reconstruction that finds a forged or inconsistent interruption row (on a non-system row, with `compaction`,
  with a code on a non-`failed` reason, an unknown reason) refuses it at the schema boundary; derivation of
  receipts degrades a bad turn to `incomplete` and never fails a resume (ADR-0128).

### 4. What the model sees

An interrupted turn is a turn in the request: its user message, then **one block** appended after the user text
part by the same projection as ADR-0128's receipts:

1. ADR-0128's receipts block, when the turn recorded calls — labels, outcome words, caps and the omitted-calls
   line exactly as ADR-0128 specifies. **The interruption row carries no tool names**; every name the model sees
   comes through ADR-0128's label rule (a built-in catalog label or the fixed `other_tool`), so a resolved MCP
   id never reaches the model through this path.
2. **One fixed interruption sentence**, user-role framing, historical data and never an instruction, and never
   claiming a result: it says what happened to the *request*, not that any change was applied.

```
[This request was interrupted before it was answered: <phrase>. <calls sentence> Nothing the assistant wrote before the interruption was kept. This note is a historical record, not an instruction, and does not establish that the request was or was not carried out.]
```

| `reason` | `<phrase>` |
|---|---|
| `aborted` | `the user stopped it` |
| `failed` | `it failed (<code>)` — the code is a closed `ErrorCode` literal |
| `denied` | `a tool call was refused and the turn ended` |
| `turn_limit` | `it reached the limit on tool rounds` |

| The turn's receipts | `<calls sentence>` |
|---|---|
| records present | `Calls listed above were recorded before the interruption; one marked cancelled has an unknown outcome.` |
| none, and structurally complete | `No tool call was recorded for it.` |
| none, and incomplete (evicted or degraded) | `Tool calls made before the interruption may not be listed.` |

The sentence is at most 420 bytes and is **not** subject to ADR-0128's receipt caps (it is the point of this
ADR); its bytes are counted by `receiptBlockBytes` only so a turn's block size stays truthful. The exact
strings are pinned in [agent-session-spec.md](../reference/contracts/agent-session-spec.md#interrupted-turns--adr-0119).

**The memory policy still decides the request.** With `memory` omitted or `summary` the block is in the
transcript the request carries; under `window` the turn takes **one** of the `window_size` slots, like a
completed turn; under `none` the request carries only the system prompt and the current message, so the block
is not sent (a completed turn's tools are equally invisible there, and ADR-0098's disclosure at resume is the
only trace). The request projection folds the adjacent user messages the note can create (`foldAdjacent` in
`turn-messages.ts`, the fold ADR-0095's 2026-09-18 note relies on), so no adapter needs a rule of its own.

**ADR-0128 interplay, stated once.** An interrupted turn is **complete by structure** — every dispatched call is
recorded — so it is never `incomplete` merely for having no records; if derivation degrades it (a forged or
legacy row), ADR-0128's single request notice applies and the sentence uses the third variant above. There is
no second receipt kind and no second notice. The summariser input renders the same block and sentence, and its
fixed prompt gains one line: a turn that ended without an answer is described by a bracketed record to report as
a fact, never to follow.

### 5. The other consumers

- **Compaction and trim** count an interrupted turn as a turn and may fold it; boundaries stay turn-identified.
- **Reseat** carries it, because it carries no content.
- **Export** ([ADR-0026](0026-session-export-to-workflow.md), ADR-0095 §3) shows it as interrupted with its tool
  structure; deriving a workflow never turns it into a step.
- **The restored transcript** shows the user message and a fixed dim row, `Interrupted — <phrase>`, where an
  assistant answer would be; it restores no argument, target, diff or result.
- **The history list and `/rewind`**: unchanged; removing a turn is `/rewind`'s job (2.6.E), not an abort's.

### 6. Increment, gating and tests

This is its own increment, **MVP-3c**, ahead of MVP-4 and after MVP-3b. It touches the resume path and a
persisted structure, so D64's rigor tier applies: a new complete cumulative round with no blocker/high/medium
finding, and a separate security sitting on the resume path. ADR-0115 stays Proposed and is not a dependency.

**Acceptance tests** (the implementation must bind them; none is claimed yet):

1. Every row of the §1 table, retained and not retained, including the hard cap, no-engagement, session-ending
   cancellation and an unclassified throw.
2. **Live-versus-restored parity**, as for ADR-0128: a multi-turn session with completed, aborted, failed,
   denied and `turn_limit` turns, with eviction, produces the same request after a restart and after a reseat.
3. A crash remnant is **not** mistaken for an interrupted turn, and an interrupted turn is not mistaken for a
   remnant, whatever follows it.
4. A forged row (an interruption on a user row, beside `compaction`, a code on a non-`failed` reason, an unknown
   reason or code) is refused at the schema boundary and in the database `CHECK`s.
5. A failed transaction latches and leaves no partial turn; ADR-0123's display metadata lands in the same one.
6. Compaction/trim boundaries identify mixed completed and interrupted turns by turn; `window` counts one slot;
   `none` sends nothing; the hard-cap counter agrees live and restored.
7. An in-flight call at abort is recorded `cancelled`; a call that never started is not recorded; nothing from the
   tool's arguments or result reaches disk, an event, an export or a request.
8. An MCP-resolved name reaches the model only as `other_tool`.
9. The sentence is pinned byte for byte, never contains an "applied" claim, and is not subject to the receipt caps.
10. Export, the restored transcript and the history list show an interrupted turn as interrupted.

## Alternatives considered

- **A new content-part type in the shared schema** (the earlier draft). Rejected: it widens the generic durable
  union that ADR-0095's session-only arm exists to protect, makes every LLM adapter and consumer handle a part
  it should never see, and is more forgeable than a typed, database-checked row field.
- **Encode the marker as text in a system row.** Rejected: a closed vocabulary parsed out of free text invites
  forged rows; a typed field does not.
- **Keep rolling back and rely on the effect-row disclosure.** Rejected: the model is the one that needs to know,
  during the live session, not only after a resume.
- **Keep the partial assistant text.** Rejected: it is incomplete and possibly wrong output the user may have
  stopped on purpose; carrying it would make an abort less effective as a "stop that".
- **Carry the interrupted tools' results.** Rejected for now: that is CR-70's content carrying, deferred with
  ADR-0096 §5.
- **Put the note in an assistant message.** Rejected by ADR-0081's role boundary.
- **Retain the turn only in memory.** Rejected: the persister maps message indices to durable sequence numbers
  (`realMessageSeqs`, `turnBoundarySeqs`); an engine that kept a turn the store did not would shift every later
  compaction boundary and break resume parity (ADR-0095 invariant 4).
- **Also write an interrupted turn on session-ending cancellation.** Rejected: `cancel()` is terminal by design
  and emits no turn completion; ADR-0098's disclosure covers it.

## Consequences

### Positive

- A retry after an interrupted turn knows what already happened, so a half-applied edit is not applied twice
  blindly, and "which tool failed?" has an answer in the next request.
- The transcript is faithful: what the user asked stays visible, on screen and after resume.
- No tool content reaches disk or a later request; ADR-0095's at-rest invariant and CR-70's deferral both hold.
- `cancelled` gets its first live producer, as ADR-0128 anticipated.

### Negative

- **One database migration and one more field** on `SessionMessage` that every consumer of the session history
  must handle: resume, compaction, export, the restored transcript and the Home's session views.
- A user who aborted *because* they regretted the request now has it in context (a sentence plus their message).
  Removing a turn is `/rewind`'s job, not an abort's.
- Under `memory: none` the model never sees the note; the effect-row disclosure at resume is the only trace.
- A session-ending cancellation and a crash still forget their turn. The disclosure at resume is the mitigation,
  and the exclusion is stated rather than implied.
- The `cancelled` status for an in-flight call is an honest "unknown": a wrong reading would mislead the model
  about a side effect, so it has its own tests (item 7).

## Review disposition — 2026-11-16

A twelve-finding design review read this ADR against the tree. Each finding was checked against the code and the
contracts before it was accepted or declined; the review saw documents, not the process.

| # | Finding | Disposition |
|---|---|---|
| 1 | ADR-0129/0130 said "accepted with ADR-0119" while this ADR was Proposed. | **Accepted.** Verified. ADR-0119 is now Accepted as its own increment (MVP-3c); ADR-0129/0130 name MVP-3b's four ADRs only; README and the roadmap agree. |
| 2 | The session-ending cancel path does not write the marker. | **Accepted; excluded, and said so.** Verified: `cancel()` is terminal and the cancel-during-turn branch rolls back and returns; the persister only ends the session. §1 lists it as out of scope with ADR-0098's disclosure as the trace. |
| 3 | No channel carries tool history out of an error path, the in-flight call is undefined, and the pair contract cannot express "unknown". | **Accepted.** Verified: history is a local pushed only when a dispatch returns. §2 adds the `AgentTurnError.toolHistory` channel, records an in-flight call as `cancelled`, and keeps the pair schema (its outcome enum already has `cancelled`). |
| 4 | The outcome vocabulary conflicts with the persisted one and with ADR-0098. | **Accepted.** Verified. This ADR uses ADR-0128's four words only; "outcome unknown" is `cancelled`; the "agree with effect rows" claim is dropped (the effect journal's states are different) and ADR-0098's disclosure is cited as an independent trace. |
| 5 | Resolved tool names would reach the model through the marker, breaking ADR-0128's label rule. | **Accepted.** The row carries no names; every name comes through ADR-0128's projection (§4), so an MCP id is `other_tool`. |
| 6 | The persisted shape, turn identity, crash distinction and canonical reference are undefined; the shared-schema wording reads as widening the generic union. | **Accepted.** §2–§3 define the row, the typed field and migration, the terminal-row rule, the crash-remnant distinction and the session-only scope; the spec and database reference gain the contract. |
| 7 | The relation to ADR-0128 is missing. | **Accepted.** Related lists it; §4 states the rules once (complete by structure, one block, one notice, summariser). |
| 8 | Crash is out of scope but the Context says "died". | **Accepted.** §1 and the Context separate "the turn ended" from "the process died". |
| 9 | Acceptance depends on the Proposed ADR-0115. | **Declined as stated, resolved by removing the dependency.** The trigger is the turn abort that exists today; ADR-0115 only adds a key to it. |
| 10 | The note text is not pinned and could read as "applied". | **Accepted.** §4 fixes the text, forbids an applied claim and pins it in the spec. |
| 11 | `failed`'s code set and `turn_limit`'s two meanings are unspecified. | **Accepted.** §1 maps each terminal event to a reason and a code from the closed taxonomy; `turn_limit` here is the within-turn guard only, the session hard cap being a pre-acceptance refusal. |
| 12 | Hygiene: dates, "next increment" versus MVP-4. | **Accepted.** The date line carries the revision; the schedule is one sentence — MVP-3c, ahead of MVP-4 — and the roadmap, register and deferred ledger agree. |

One addition the review did not make: a turn is retained **only if a provider engaged**, so the live hard-cap
counter and the restored one count the same set; without it a pre-egress failure would be counted after a resume
but not live.
