# ADR-0129: The approval card is docked, bounded and says only what matters

- **Status**: Accepted — 2026-11-16, by the maintainer (the placement, the reject/abort semantics and the sequencing were decided after the survey recorded in [the analysis](../analysis/approval-card-and-chat-modes-2026-11-16.md)). The D64 round and the separate security sittings on the approval path ran on 2026-11-17 (see notes 6–11 below and the [phase register](../roadmap/phases/phase-2.6-conversational-authoring.md#pr-99-independent-review-corrections-2026-11-17)); the maintainer's acceptance is owed.
- **Date**: 2026-11-16
- **Amended by**: [ADR-0134](0134-the-full-view-and-the-tool-details-are-one-readable-inspection-screen.md) §1 — the details and call-list screens no longer "keep the key set and behaviour ADR-0120 gave them". The card is unchanged.
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

## Amendments — 2026-11-17 (PR #99 review)

1. **The target the card shows is projected into what the title row can draw.** §3's shortened-target warning and its inspection gate worked on a projection of `columns − 2`, while the title row also spends the longest verb and a space (`Overwrite `, 10 columns). At 80 columns a long path therefore lost its end behind a `…` with no warning and `[y] Allow` unlocked (reproduced at 71, 78 and 120 characters for an overwrite; the threshold is the row width minus the verb). The projection now reserves that room (`CARD_VERB_COLUMNS`, derived from the verb set) and, conservatively, the 7-column `target ` label the card strips: capacity at 80 columns is 2 × 61 = 122 characters, and beyond it the shortened-target warning and the lock engage.
2. **The lock sentence is shown only before inspection.** §3's "Allow stays locked until you do" follows the lock itself: once the person has inspected, the warning keeps the fact (the bytes omitted; the masked-value count) and drops the sentence.
3. **`[n]` is accepted while the review cannot be shown.** §7's exact-frame acknowledgement gates every answer that grants something; a plain deny grants nothing, so `n` on an approval review resolves a deny (the turn continues) even when the frame is unreadable (an unreadable identity, a terminal under 80×24). `y`, `a` and `c` stay gated. The hints say "Esc stops the turn" (§5), not "cancels", and no longer offer `[v]`/`[p]` for an unreadable identity.
4. **The line-ending warning follows the file's convention, not its last line.** A final line with no terminator no longer makes an otherwise uniform file `mixed`; a file that genuinely mixes LF and CRLF still does. The contract is `ToolFileEndings` in `docs/reference/shared-core/tool-registry.md`.
5. **The review document is built once per frozen preview.** The preview event, the card and the details view share one document (each diff side is secret-scanned once); a `plan`-mode preview, which can only be refused, builds none. Before this, a one-line edit of a 4 MiB file cost about 1.3 s per build.
6. **The card opens on the change, and a partial view earns no session-wide grant.** The card's body started at the top of the file, so an edit whose first change lay below the card's budget (the reproduction: line 80 of a 100-line file, 7 rows at 80×24, 19 at 120×40) showed only unchanged leading lines, with the change as a count, while `[y] Allow` and `[a] Allow all … this session` were offered. §2's "a short change is shown whole" assumed a body that equals the change. The card now opens on the first changed line with up to three lines of context above it (the full view still starts at line 1). If any changed line is not drawn — a second change beyond the budget, or a large new file — the card says `⚠ N changed lines not shown — press [v] for the full diff.` and offers no `[a]`: the same principle as ADR-0130 §1's rule that a blank preview earns no `always`. `[y]` and `[n]` stay, and the full view keeps `[a]`.
7. **A shortened target is locked from the first frame.** The lock was derived from an inspection record that only exists after a frame is acknowledged, so the first frame — and the first frame after a narrowing resize — showed "Target shortened" with `[y] Allow` offered (the keys could not resolve yet, but the card said otherwise). The lock is now derived from the page the card draws.
8. **Hints and labels tell the truth.** In a reason capture or a full-view search with the frame hidden `n` is text, so the hint there says only that Esc stops the turn; the full view's legends say "stops the turn", not "abort". The line-ending warning appears only for a changed convention, a `mixed` side, or a final newline added or removed — not for an identical CRLF pair.
9. **An input guard IS needed (security sittings).** §Alternatives rejected a grace period because "coalesced input cannot approve unseen content". Type-ahead, a double tap and a held key are not coalesced input: a flushed frame proves the bytes were drawn, not that a person could read them. Reproduced: typing the next instruction while the turn ran, with the card opening after the first key, approved with `always` on the third key (`please also add tests` → `a`); a second `y` 100–300 ms after the first approved the next card 45–246 ms after it appeared; a held key approved a card 11–86 ms after it was shown. A first guard (a 400 ms dwell and a 300 ms quiet gap) was not enough: a 40 WPM typist approved with `always` in 9 of 24 simulated trials, and a held key whose OS repeat delay is above about 420 ms approved the next card. Timing alone cannot tell a deliberate press from typing, so the guard is layered. An affirmative key (`y`, or the first `a`) counts only if (1) the card has been on screen for 400 ms, counted from its acknowledged frame (a new card, a resize, a screen change or any state change restarts it); (2) the previous key of any kind is at least 300 ms old; (3) no *foreign* key — one that is not a card action: text typed into the composer while the turn ran, a key the card ignores, or text typed into a search, a reason box or a question card's own answer (the Enter that submits it included) — arrived in the previous 1.5 s; and (4) no card was resolved by a key in the previous 2 s, a lockout that slides: an affirmative key arriving inside it extends it, so a key held with a slow repeat rate must be released for 2 s. The session-wide `[a]` takes two steps: the first `a` only shows `Press Enter to allow all … this session · any other key cancels`, and **Enter** 0.8–5 s later with no other key between grants. (A second `a` was the first design and failed a third sitting: a word starting `aa` typed at ordinary speed, or one held `a`, completed it in 8–10 of 20 jittered trials.) A refused key is consumed with no effect and the card says why, once (`Keys were typed just before this answer — wait a moment, then press again.` or `This card opened right after your last answer — wait, then press again.`). Deny and navigation are never delayed, so a typed-ahead `n` still denies. The guard uses a monotonic clock, so a wall-clock step changes nothing. Simulated typing at 300, 200 and 130 ms per key (40 trials each) now yields no approval of any kind. **Residual:** a `y` that is the first key after 1.5 s with no other key cannot be told from a deliberate press and counts (one write), and so does a lone `a` followed by Enter 0.8–5 s later with nothing between (for instance a one-letter message). The question card keeps its own 250 ms guard.
10. **"A partial view earns no session-wide grant" holds on every screen.** Amendment 6 withheld `[a]` only on the card. In the full view the first page can show fewer changed lines than the card, and a clipped `run_command` argument vector (which is what runs) showed no warning, yet both offered `[a]`. `[a]` — the key and the legend, on the card and in the full view — is now offered only while the page drawn shows every changed line (a diff; a page that starts partway through a changed line does not) or all of the call's content (no diff); a clipped call without a diff shows `⚠ N lines of this call are not shown — press [v] for the full view.`
11. **When parent directories are created the card names the canonical path.** §3's "effect and target" named the lexical path: with `notes -> .github` and no `.github/workflows`, a write of `notes/workflows/release.yml` was shown as that and created `.github/workflows/release.yml`. The card now names the deepest existing real ancestor joined with the remaining names; the scope, protected and credential floors run on that path; and execute refuses (`stale_file`, nothing published) if the final target differs, and re-checks each parent right before it is created.
12. **Every answer key is a Ctrl chord (2026-11-17, maintainer).** The guard of notes 9–11 made a bare `y` or `a` hard to press by accident, not impossible: a `y` that is the first key after 1.5 s without another key cannot be told from a deliberate press, and neither can a lone `a` followed by Enter. The realistic case is not an accident of timing but of content: the model asks a question in its text, the person types `yes …` while the turn runs, the card opens during the pause and the `y` approves a write. No timing layer can separate typing from a decision when the answer is a letter. The answers are therefore keys typing cannot produce: **`Ctrl+Y`** allow once, **`Ctrl+G`** ask for the session-wide grant (still confirmed by Enter, never by a second chord), **`Ctrl+N`** deny, **`Ctrl+R`** deny with a reason. A bare letter answers nothing and counts as a foreign key (typing evidence), so an affirmative chord pressed within 1.5 s of typing is still refused (the card says why, once). The precedent is the question card ([ADR-0132](0132-the-model-can-ask-the-user-a-structured-question.md): `s` became `Ctrl+S` after a manual test showed the collision with free text). `Ctrl+A` is deliberately not used (the readline line-start key and the GNU screen prefix); `Ctrl+N` needs no visible frame, as `n` did (note 3). The dwell, quiet gap, typeahead window, lockout and the Enter confirmation are unchanged: the guards that gate an answer did not change, the keys that answer did (a bare letter lost its power; `Ctrl+Y`, and `Ctrl+G` followed by Enter, gained it). Other terminal coding agents, read from their source on 2026-11-17: one answers with a highlighted option and Enter and has open reports of typed-ahead keys approving a prompt; one answers with bare letters but does not show the prompt until its composer has been idle for one second; two use a list and Enter, and one of those asks twice before an "always". The card's key rows spell the chords (`[Ctrl+Y] Allow   [Ctrl+G] Allow all … this session` / `[Ctrl+N] Deny   [Ctrl+R] Deny + reason   [v] Full diff   Esc stops the turn`); the unreachable bare-letter reducer in `chat-input.ts` now answers nothing; `ask_user` refuses the new key tokens anywhere in model text, as it already refused `[y]`. This note supersedes the key spellings in the text above and in [ADR-0130](0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md); the older ADRs that name `[y]`/`[a]`/`[n]` keep them as history.
13. **Chord note: the security sitting of 2026-11-17 (no blocker, high or medium).** A separate read-only sitting attacked note 12 with probes through the real Ink parser: every bare key (printable ASCII, digits, Enter, Tab, arrows, paste forms) answers nothing with every guard off; no terminal reply, output sequence or clipboard content produces an answer chord while a paste listener is mounted (it always is, on both surfaces), and with the guards the chord path is not weaker than the bare-letter path was. Four lows are recorded in `deferred-tasks.md`: `Ctrl+G` is the abort reflex of Emacs-style editors (it only asks; Enter must follow 0.8–5 s later); a terminal left in xterm `modifyOtherKeys` mode delivers Ctrl+letter in a form Ink does not read as a chord, so every chord is ignored and only Esc answers (fail-closed); the question-text refusal catches the exact `[Ctrl+Y]`-style tokens but not look-alikes (full-width brackets, `<Ctrl+Y>`), which are harmless because a question card answers no approval; and a held chord's refusal note says "typed". The sitting also corrected two sentences of note 12 above.

14. **Later changes (2026-11-19; decided, implemented in MVP-4 steps 2 and 4; and on 2026-11-21 in step 6 `Esc` on the full view returns to the card, [ADR-0137](0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §4).** [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md): `Esc` and `Ctrl+C` at the card reject the call (recorded as rejected, not cancelled) before the turn is stopped, `Ctrl+C` arms the exit window, and `Esc` inside the reason box or the full view's search box closes the box instead of stopping the turn (note 8's hint changes with it). [ADR-0118](0118-a-command-outside-the-allowlist-asks-instead-of-failing.md): the command card adds one answer chord, `Ctrl+O` then Enter (Remember), and the full set stays chords typing cannot produce.

15. **Implemented (2026-11-19, MVP-4 step 2).** Note 14's `Esc`/`Ctrl+C` rejection and the box-closing `Esc` are in, with the reason box's hint now `Enter denies and continues · Esc closes this box · Ctrl+C stops the turn` and the full view's search state naming its own two keys. Making the rejection reach the *record* needed one change in the registry, recorded in [ADR-0115's implementation note](0115-one-interrupt-keymap-for-the-interactive-cli.md#implementation-note--2026-11-19-mvp-4-step-2): a rejection decided before any effect stays a denial when the abort follows it in the same tick. The continue checkpoint reuses this card's input guards for its `Ctrl+Y` ([ADR-0136's second implementation note](0136-a-turn-asks-to-continue-at-a-checkpoint-instead-of-dying-at-a-ceiling.md#implementation-note--2026-11-19-mvp-4-step-2)). One residual is recorded, not changed: a `Ctrl+Y` held from before the card, on a key-repeat slower than the 300 ms quiet gap, can pass every guard after the card has been up for a few seconds (the same for the checkpoint); it needs an accessibility key-repeat setting and a key held for seconds, and any fix trades against a person who is merely a little early, so it is the maintainer's call and is in the deferred-tasks register.

16. **Implemented (2026-11-19, MVP-4 step 4): the command card adds one answer chord.** A command's card (ADR-0118 §1, [command-permissions.md](../reference/cli/command-permissions.md#the-command-card)) offers `Ctrl+O`, then Enter, to remember the exact command for the project, beside note 12's four chords. It reuses every guard of notes 9 to 11 unchanged (dwell, quiet gap, typeahead window, lockout) and the session grant's two-step rule: the first `Ctrl+O` only asks, only Enter 0.8 to 5 s later with no other key between grants, and a second `Ctrl+O`, a `Ctrl+G`, typed text or a held key cancels. It exists only on a card whose facts offer it, so on every other card it is a key the card owns and ignores. A command too long for the title rows is a shortened target, so every approving answer stays locked behind the full view, as note 7 already does for a path; the session and remember answers are additionally withheld while the page does not show the whole command (notes 6 and 10).
