# ADR-0098: A session's effect row holds no result, never replays, and discloses what did not complete

- **Status**: Accepted — 2026-09-14
- **Date**: 2026-09-14. This ADR separates `CR-97` from
  [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md), where its mechanism went through three review
  rounds, and states it as decisions, invariants and acceptance tests.
- **Implementation**: staged for `W7`. "Accepted" here means the decision is settled, not that it ships: until the `W7`
  commits land, session-scoped effect rows still retain tool results and a resumed session can still replay one.
- **Decides**: `CR-97` of [Phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md) (`W7`),
  which covers three pre-existing defects in a session's effect rows
- **Refines (not reverses)**: [ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md). Its
  exactly-once re-delivery stays for runs, and its session posture of disclosing and continuing is kept and extended
  to a case §6 (effect-journal.md §8) did not name.
- **Corrects, by dated note**: [ADR-0050](0050-cli-history-db-at-rest-posture.md), whose premise is narrowed to what
  the database actually holds
- **Related**: [effect-journal.md](../reference/shared-core/effect-journal.md) ·
  [ADR-0079](0079-cross-process-run-ownership-lease-and-fencing-token.md) (runs only; a session has no ownership
  guarantee)

## Context

The durable effect journal ([ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md)) records a
tier-3 tool call before it is dispatched and settles it afterwards. For a **run**, a committed row keeps the bounded
tool result, so a resumed node can re-deliver that result instead of repeating the call. Chat surfaces write
**session**-scoped rows too: `chat`, `chat-resume`, `agent run`, and the Home. Three defects follow, all shipping
today and all reproduced from code during the review of ADR-0095.

1. **Tool output at rest.** A session-scoped committed row stores the bounded result in `run_effects.result_json`
   (`registry.ts:240`). A session never re-dispatches a completed turn, so that result has no reader. It stays in an
   unencrypted file until a resume sweep, and a session that is never resumed keeps it indefinitely. That falsifies
   ADR-0050's premise that `history.db` "holds no credentials".
2. **Stale replay.** A session's effect identity is `{ sessionId, turn }`, and `turn` is the session's turn counter
   (`agent-session.ts:937-939`). Resume re-seeds that counter from the assistant rows *past the compaction boundary*
   (`session-resume.ts:161`, `agent-session.ts:577`). After `/compact` or `/trim` and a resume or reseat, the counter
   therefore goes backwards. A new turn then reuses a committed row's identity:
   - a same-args call **replays an earlier turn's stored result**;
   - a different-args call fails the turn.
3. **An effect from a turn that did not complete is protected only by accident.** Suppose a process dies after a
   tier-3 effect committed but before its turn persisted. That effect row is the only record the call happened; a
   session has no durable event log (`run_events.run_id` is `NOT NULL`). Today the counter re-seeds to the crashed
   turn, so a same-args repeat happens to replay the result. Fixing defect 2 removes that accident, so the
   protection has to become explicit.

**Two attempts to specify these mechanisms in ADR-0095 were wrong, and a review found each.**

- **Storing `NULL` alone made every committed session effect read as unresolved.** `blocksResume` treats a
  committed row with no retained result as blocking (`run.ts:467-471`), and the session disclosure filters with that
  predicate. Every resume would therefore have reported committed effects as never resolved.
- **Deciding "did not complete" by comparing a row's turn *index* with a *count* of completed turns was
  wrong.** The live counter also advances on an errored or aborted turn that engaged a provider
  (`agent-session.ts:788`, `:843`). Such turns persist nothing, so after one of them the index and the count never
  line up again, and every later completed turn's effects are flagged as incomplete.

## Decision

**A session's effect row keeps the fact of the call, not its result. A session never replays a result. A
session's effect identity never repeats. An effect that landed in a turn that did not complete is disclosed before
anything can repeat it.** Run-scoped rows are unchanged.

### Invariants

1. **No tool result at rest for a session.** No session-scoped `run_effects` row holds a `result_json`. That
   includes rows written before this ADR, which are cleared on the first open after the upgrade. The row keeps its
   state, tier and scrubbed-args digest, and effect-journal.md §11 already accepts that digest.
2. **A session never replays.** A session-scoped `prepare` that matches a committed row is refused, never answered
   with a stored result. On the session path such a match is a collision, and
   [effect-journal.md](../reference/shared-core/effect-journal.md) §14 already records a collision there as failing
   closed.
3. **A model-turn effect's identity never repeats.** A turn key is never reused across resume, reseat, compaction, or
   an errored, aborted or crashed turn, and a new turn's key is greater than every turn key the session has written.
   A user-invoked `!`-command's effect occupies its own slot space. It is not a model turn, and
   [effect-journal.md](../reference/shared-core/effect-journal.md) §14 already records its known limitation.
4. **A committed effect of a turn that did not complete is disclosed.** On resume, a committed session effect whose
   turn did **not** persist is listed as having landed in a turn that did not complete: it was not retried, and the
   user should check the target before sending the message again. It is not swept before it has been disclosed.
5. **A committed effect of a turn that completed is never disclosed as unresolved.** "Did not complete" is decided
   by **whether that turn persisted**, never by comparing a row's turn key with a count of turns. A committed
   `!`-command effect is never disclosed as belonging to a turn that did not complete; only an unresolved one is
   disclosed, as today.
6. **Run-scoped behaviour is unchanged.** A run's committed rows keep their result, a run replays as ADR-0080 §2b decides (effect-journal.md §4), and `blocksResume` keeps its meaning for runs.
7. **Rows written before the upgrade are disclosed conservatively.** A committed session row written before this ADR
   cannot always be attributed to a turn from durable data. Such a row is disclosed once, on the first resume after
   the upgrade, as possibly belonging to a turn that did not complete, and it is not swept before that disclosure.
   Invariant 5 applies to rows written after the upgrade.

### What ADR-0050's premise becomes

After this ADR, a session's transcript, its export
([ADR-0095](0095-what-an-agent-session-remembers-across-turns.md)) and its effect rows hold no tool result. A
session effect row keeps a SHA-256 digest of the scrubbed argument projection until the sweep. `history.db` still
holds the bounded result of a committed tier-3 **run** effect until that run's terminal sweep. That is ADR-0080's
deliberate cost, and the dated note on ADR-0050 says so rather than claiming the premise is true everywhere.

### Implementation notes (non-normative)

These are traps found in the mechanisms earlier drafts specified. An implementation may satisfy the invariants
another way, but must not fall into these.

- **`NULL` means "cannot re-deliver" to the store.** A committed row with no result is refused rather than replayed
  (`effect-journal-store.ts:169-180`). That makes `NULL` a better carrier for invariant 1 than a content-free
  envelope, which would still be a retained result and would be replayed as if it were one.
- **`blocksResume` must not decide what a *session* discloses.** For a run, a committed row with no result blocks
  resume on purpose: it covers the window where a settle landed but `node:completed` did not.
- **A turn key and a completed-turn count are different number spaces.** An errored or aborted engaged turn advances
  the key without persisting, and a crash advances it past a turn that never persisted. Deciding completion
  requires knowing which turn keys persisted.
- **The platform-free engine cannot read `run_effects`.** Any value derived from the journal — the highest turn key
  written, or the set of keys that persisted — is supplied by the host.
- **The current sweep is called with a completed-turn count** (`chat.ts:803`, `effect-retention.ts:39-47`). Any bound
  it uses must respect invariants 4 and 5.
- **The effect journal already records the tool-call id.** Its `attempt_json` carries it (`registry.ts:601`), and its
  scope carries the turn key (`session:<id>:<turn>`). With ADR-0095's engine-assigned ids, a persisted turn can be
  joined to its effect rows without a new column.

### Alternatives

Considered **a content-free envelope in `result_json`**, the maintainer's original wording. It was replaced by
`NULL`, which serves the same intent: a colliding `prepare` would replay an envelope as if it were a result.
Considered **keeping replay for sessions** (rejected: the replayed result can belong to an earlier turn, which is
defect 2). Considered **persisting the turn counter on the session row** (not required: the invariants can be met
from what the host reads, and a migration is an implementation choice rather than a decision). Considered **sweeping
by the monotonic key** (rejected: it deletes the only record of a turn that did not complete, before anyone is told).

## Consequences

### Positive

- A session's effect rows stop holding tool output, including rows written before the upgrade.
- A resumed or reseated session can no longer replay an earlier turn's result, or fail a turn on a stale identity.
- The protection for an effect from a crashed turn is explicit and disclosed, where before it held only by
  accident.

### Negative

- **A repeated call after a crash is no longer silently deduplicated.** It is disclosed, and the user decides.
  Accepted: that is the session posture effect-journal.md §8 already chose, now applied to a case it did not name.
- **Two concurrent resumes of one session still collide.** They fail closed, as today.

### Acceptance

- **No result at rest.** A session-scoped tier-3 effect whose output contains a secret-shaped token leaves no
  `result_json`. After the upgrade, no pre-existing session-scoped row holds one.
- **No replay.** A session-scoped `prepare` that matches a committed row is refused.
- **A monotonic key.** After `/compact` and `chat-resume`, after a reseat, and after an aborted engaged turn, an
  identical tool call dispatches normally, and its row's turn key is greater than every earlier one.
- **A crash is disclosed.** A crash after a tier-3 effect committed, before its turn persisted, then `chat-resume`:
  the effect is disclosed, and its row survives that resume's sweep.
- **No false disclosure.** An aborted engaged turn, then a completed turn with a committed tier-3 effect, then
  `chat-resume`: nothing is disclosed. On the next resume after a crash, a later completed turn's effect is not
  disclosed either.
- **An errored or aborted turn is disclosed.** An errored engaged turn whose tier-3 effect committed, then a completed
  turn, then `chat-resume`: the errored turn's effect is disclosed, its row survives that resume's sweep, and the
  completed turn's effect is not disclosed. The same holds, separately, for an Esc-aborted turn.
- **`!`-commands.** A `!`-command, exit, `chat-resume`: nothing is disclosed. A `!`-command, followed by a model turn
  calling `run_command` with the same arguments, dispatches normally.
- **Legacy rows.** A database from before the upgrade, holding a committed session row: the first open clears its
  result, and the first resume discloses it once. A later resume does not.
- **Runs unchanged.** A run's committed row still replays on resume, and its resume gate still blocks on a committed
  row with no result.

### Landing obligations

- **Dated notes**: ADR-0050 and ADR-0080.
- **Canonical docs**: [effect-journal.md](../reference/shared-core/effect-journal.md) §§8, 9 and 14 — the session
  disclosure predicate, the sweep bound, and "a session never replays".
- **Records**: a new register item, `CR-97`.
