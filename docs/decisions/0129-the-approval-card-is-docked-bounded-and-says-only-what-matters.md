# ADR-0129: The approval card is docked, bounded and says only what matters

- **Status**: Accepted — 2026-11-16, by the maintainer (the placement, the reject/abort semantics and the sequencing were decided after the survey recorded in [the analysis](../analysis/approval-card-and-chat-modes-2026-11-16.md)). Reviews and a separate security sitting on the approval path are owed; see the acceptance note.
- **Date**: 2026-11-16
- **Amends**: [ADR-0120](0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md) §3 and its 2026-11-11 review notes (**presentation only**: where the card sits, how much it says, and the line-ending notation), the [MVP-3 interaction contract](../reference/cli/chat-session.md#mvp-3-interaction-contract) (the list of what the card names), and [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md)'s key legend.
- **Related**: [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md), [ADR-0122](0122-the-home-is-the-interactive-product.md), [ADR-0130](0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md)

## Context

The card that stands between a model's write and the disk is the one place the
product asks the person to decide, and today it reads like a diagnostic dump.

- **It replaces the conversation.** While an approval waits, the transcript is
  hidden (`ChatView hidden`) and a review screen takes its place. The person is
  asked to decide about a message they can no longer see.
- **It says more than it matters.** A 17-line new file costs about eleven lines of
  chrome — `tool write_file`, `action fs_write`, `0 masked spans`, `endings empty →
  lf`, `Inspection requirements met.`, three separate key lines — around four lines
  of content. At 120×40 the same four lines appear; the space is not used.
- **It is noisy in the common case.** Every line ends in `<LF>`, although
  ADR-0120 asks for a token only where an ending *differs*.
- **Its keys are unclear.** `Esc/Ctrl-C abort` stops the whole turn but does not
  say so; `[a] always for named tool (session)` is jargon for "every write of this
  kind until you quit".

Nine of the ten products surveyed keep the conversation visible while they ask:
the card is docked beside the input, sized to the terminal, and the full diff is
one key away. The tenth shows a centred modal and is the one its users complain
hides the context they need to decide.

## Decision

**Dock the card where the input is, let the transcript stay, size the card to the
terminal, and put only what the person needs on it.** Everything ADR-0120 and the
interaction contract require *for safety* stays; what changes is placement,
proportion and wording.

### 1. Placement

While an approval waits, the card is shown **in the live region, in place of the
composer**. The transcript viewport stays on screen above it, shrinking to make
room. The details and call-list screens (`[v]`, `/details`) remain full-screen
views reached on demand: they are where the whole change is read, and they keep
the key set and behaviour ADR-0120 gave them.

Inline (no alternate screen) renders the card below the already-printed
transcript; nothing there was ever hidden.

### 2. Size

The card takes at most three fifths of the terminal's rows and never so many that
fewer than eight transcript rows remain. At the 80×24 floor that is twelve rows. Inside that budget the diff body
uses every row it can, so a short change is shown whole and a long one is cut with
an exact count. The 80×24 floor, the "clipped mandatory content disables
affirmatives" rule and the exact-frame acknowledgement are unchanged.

### 3. What the card says

Always:

- the **effect and target** in one line — `Create merhaba.md`, `Edit src/app.ts`,
  `Overwrite notes.txt` — with `+added −removed · N bytes` at the right edge;
- the **diff body**: a line-number gutter, a `+`/`−`/space sign, the escaped text,
  coloured when colour is on (additions green, removals red, context dim) and
  legible with colour off;
- when the body is cut: `… N more lines`, with the exact omitted counts the
  contract already requires, and `[v] full diff`;
- the **answer keys**, on one line, and one more line naming what Esc does.

Only when they apply — each in its own warning line, placed directly above the
keys where the eye lands:

- masked values in the change (count and the `[v]` → `[r]` inspection they require);
- a changed or mixed line-ending convention;
- a shortened target (omitted byte count and the inspection it requires);
- an invisible or ambiguous code point that the escape rule rendered.

A clean change carries none of these lines. A zero is not displayed as a fact.
This amends the contract's phrase "the card names … mask counts, line-ending
changes": it names them **when non-zero**, and the full view always lists the
counts.

### 4. Line endings

A line shows `<LF>` or `<CRLF>` only when its ending differs from the rest of its
side or from the other side, as ADR-0120 already says. A nonempty file's
unterminated last line keeps `<EOF:NO_NEWLINE>`. A change *to* line endings
therefore still cannot look unchanged, and a CRLF file still cannot look like its
LF twin; an ordinary all-LF file simply stops printing a token per line.

### 5. Keys and their words

The keys are unchanged: `y`, `a`, `n`, `c`, `v`, Esc and Ctrl-C. Their labels are:

```
[y] Allow  [a] Allow all file edits this session  [n] Deny  [c] Deny + reason  [v] Full diff
Esc stops the turn
```

`[a]` names the scope by tool (`file writes`, `file edits`); a tool without a
friendly phrase says `<tool> calls`. It is omitted when the answer is not
cacheable. `[n]` and `[c]` deny and **continue** the turn (ADR-0117); Esc and
Ctrl-C **stop** it. The third line of the old legend ("Approval cannot override
protected-path or permission denials") moves to the full view.

### 6. The turn says it is waiting for the person

An open card is the person's time, not the turn's. While a card is open:

- the card opens with a rule labelled `Approval needed`, in the warning colour where colour is on, so it
  reads as a question the turn is blocked on;
- the busy line reads `Waiting for your answer <time> · Esc stops the turn`, never `Working…`;
- the answer keys are coloured (allow green, deny red, the others cyan, `Esc` yellow) with the words dim;
- the turn's elapsed time **excludes** the wait, and the completed turn's footer shows the active time and the
  wait separately — `1m02s · 3m56s waiting for you` — so a turn that waited on a card is not read as a slow one.

The wait is display state kept in the view model (`approvalWaitMs`, `approvalSinceMs`); no event or history
field carries it.

### 7. Unchanged

The pure review state machine and projection, the visible-escape alphabet, the
mask-reveal gate, the measured-frame acknowledgement, the resource limits, the
below-80×24 refusal, the single keyboard owner, the clipboard rules and the
"a write is never silent" transcript row are not touched.

## Alternatives considered

- **A centred modal.** Rejected: it covers the conversation, which is the
  complaint.
- **Keep the takeover and polish it.** Rejected: the polish would not return the
  context, and the card is the part people see every time.
- **Put the diff in the transcript and ask below it.** Rejected for now: the
  inspection model of ADR-0120 is bound to the card's own page and acknowledged
  frame; moving the diff would reopen that proof.
- **A split (side-by-side) diff on wide terminals.** Deferred; the unified body
  composes with the same projection and can follow.
- **An input grace period before the first key counts.** Not needed: affirmative
  input already requires the exact acknowledged frame, and coalesced input cannot
  approve unseen content.

## Consequences

### Positive

- The person decides with the conversation in view, and the common change fits on
  the card.
- The card's chrome shrinks to what changes the decision, so a warning, when
  there is one, is the only unusual thing on it.
- Every safety rule the card enforced still holds.

### Negative

- **The set of "mandatory card content" changes**, and with it what the
  acknowledged frame must contain. That is the item for the security sitting: that
  every disclosure the contract requires is either always shown or shown whenever
  it is non-zero, that the omitted-count line cannot be cut by the budget, and that
  the controls line is never the row that is dropped.
- A shorter card shows fewer diff lines at the smallest size than the old card
  showed at the largest. The omitted count and `[v]` are the mitigation, and the
  body grows with the terminal.
- Tests and snapshots that pinned the old legend and chrome change with it.

### Acceptance note — 2026-11-16

Accepted with ADR-0117, ADR-0130 and ADR-0131 as one increment (MVP-3b) ahead of
MVP-4. ADR-0119 is a separate increment (MVP-3c) with its own acceptance. The implementation, two review rounds with no blocker/high/medium finding
and a separate security sitting (D64: an approval path) are owed before it is
accepted. A terminal-bell notification for a card that waits while the terminal
is unfocused is recorded as a follow-up, not decided here.
