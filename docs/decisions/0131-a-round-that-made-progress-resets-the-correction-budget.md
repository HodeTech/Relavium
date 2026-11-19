# ADR-0131: A round that made progress resets the correction budget, and a line range past the end of a file is clipped

- **Status**: Accepted — 2026-11-16, by the maintainer, as part of the increment recorded in [ADR-0130](0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md). Reviews are owed with that increment.
- **Date**: 2026-11-16
- **Amends**: [ADR-0086](0086-absolute-admission-ceilings-on-authored-values.md) (the sentence that the correction sub-budget is monotonic, in the `AgentTurnLimits` contract), [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md) §3 (each returned denial draws on the budget), and the MVP-3 file-read contract in [built-in-tools.md](../reference/shared-core/built-in-tools.md) (the rule that an out-of-file line range is refused).
- **Related**: [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0120](0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md), [ADR-0119](0119-an-interrupted-turn-stays-as-a-content-free-marker.md)

## Context

A long review turn ran for 3 min 50 s and about 590 000 input tokens. It then
ended with `tool_failed`, and the model, asked what had failed, answered that no
tool had been called. Two causes were separable from the unrelated loss of the
turn itself (ADR-0119).

- **The budget counted slips, not stalls.** `maxToolCorrections` (3) was a
  *monotonic* count of rounds that contained any correctable failure. "A genuine
  tool round never resets it." A turn that read thirty files could therefore die
  on its fourth unrelated slip, however much it had accomplished in between.
- **A harmless overshoot was a failure.** `read_file` refused a line range whose
  end lay beyond the last line of the file. A model that asks for "lines 1100 to
  1300" of a 1 277-line file asked for something sensible and got an error that
  spent a correction round and said nothing about how long the file is.

## Decision

### 1. The budget counts consecutive rounds in which nothing ran

`maxToolCorrections` becomes the number of **consecutive** tool rounds in which
**no call ran to a result** (every call in the round threw a correctable error).
A round in which at least one call succeeded, and any round with no failure at
all, resets it to zero. The default stays 3 and stays finite and configurable
(MVP-A11).

This can only shorten a turn, as before: the egress ceiling is `maxToolTurns`, not
this count, so the DoS bound is unchanged. A model that keeps failing every round
still ends the turn after the same three rounds. What changes is that a model
that is making progress is no longer penalised for unrelated slips.

A returned denial (ADR-0117) is a correctable failure and counts the same way: a
model that calls a refused tool, is told no, and calls another refused tool ends
the turn on the third consecutive round, while one that adapts and succeeds does
not.

### 2. A line range's end is clipped to the end of the file

`read_file` with `unit: lines` returns the lines from `start` through
`min(end, last line)`. The result's `range` reports the lines **actually
delivered**; when the request was clipped it also carries `requestedEnd`, so the
model sees both what it asked for and what it got, plus the file's total line
count in the existing size field.

- A **start** past the last line is still an error, and its message now names the
  file's line count ("start line 1300 is past the end of the file, which has 1277
  lines") so the next call can be right. The count is about a file the model could
  already read in full.
- The edit-evidence rule is unchanged: observed ranges are the bytes **delivered**
  (`startByte`/`endByte`), so a clipped read proves exactly the lines it
  returned.
- Byte ranges keep their strict rule: an end past the file's size is refused.
  Bytes are an expert interface and a clipped byte range could cut a code point.

### 3. A failed turn says what failed

The footer for `tool_failed` names the number of calls that failed in the turn and
the tools they came from, from the live tool rows the transcript already holds. It
adds no data to events or history, and it contains no argument or result text.

## Alternatives considered

- **Raise the constant.** Rejected. It lengthens the stall a model may burn and
  still kills the productive turn at some larger arbitrary slip.
- **Do not count `invalid_args`/not-found at all.** Rejected. A model that loops on
  a failing call must still end the turn; counting stalls is what bounds it.
- **Refuse, but include the line count in the message.** Rejected for the end of
  a range: it spends a model round to learn what the host already knows.

## Consequences

### Positive

- A productive turn survives an unrelated slip; an unproductive one still ends in
  three rounds.
- The most common range mistake costs nothing and the rarer one is self-correcting.

### Negative

- **The sub-budget's contract changes**, and tests that pinned "accumulates across
  interleaved genuine rounds" were rewritten to pin the consecutive rule.
- A model may now see a result shorter than it asked for. `requestedEnd` and the
  reported range make that explicit; a model that ignores it reasons from
  fewer lines than it believes. The read-before-edit rule still limits an edit to
  what was delivered.

## Amendment — 2026-11-19

§1 says a model that keeps failing "ends the turn after the same three rounds" and "on the third consecutive round". The code counts the budget as exceeded when the count passes it (`next > maxToolCorrections`), so with the default 3 the model is given three corrections and the **fourth** consecutive round in which no call ran to a result ends the turn with `tool_failed`. The code was right and the wording was off by one; behaviour is unchanged. [ADR-0136](0136-a-turn-asks-to-continue-at-a-checkpoint-instead-of-dying-at-a-ceiling.md) makes the budget configurable (`[chat].max_tool_corrections`, 1 to 10) and states the rule in those terms.
