# ADR-0115: One interrupt keymap for the interactive CLI

- **Status**: Proposed — revised 2026-11-19 (see the revision note at the end). Awaiting the maintainer's acceptance.
- **Date**: 2026-11-05 (revised 2026-11-19)
- **Related**: [ADR-0054](0054-cli-bare-invocation-interactive-home.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md), [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md), [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md), [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md), [ADR-0119](0119-an-interrupted-turn-stays-as-a-content-free-marker.md), [ADR-0122](0122-the-home-is-the-interactive-product.md), [ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md), [ADR-0132](0132-the-model-can-ask-the-user-a-structured-question.md), [ADR-0134](0134-the-full-view-and-the-tool-details-are-one-readable-inspection-screen.md), [ADR-0136](0136-a-turn-asks-to-continue-at-a-checkpoint-instead-of-dying-at-a-ceiling.md), [D68](../roadmap/current.md#wave-gating-decisions), [MVP-A12](../roadmap/phases/phase-2.6-conversational-authoring.md#cli-mvp-additions--2026-11-04), [row 11b](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#proposed-implementation-increments)
- **Amends**: [ADR-0132](0132-the-model-can-ask-the-user-a-structured-question.md) §3 (the sentence "`Esc` and `Ctrl-C` stop the turn" now has an exception inside the card's own text field, §3 below), [ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md) note 8 and [ADR-0134](0134-the-full-view-and-the-tool-details-are-one-readable-inspection-screen.md) §5 (the same exception for the reason box and the full view's search box), and [ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md) (the parenthetical about `Ctrl-C` during a `!` command).

## Context

The facts below were read from the code on 2026-11-19.

**Outside a card, `Ctrl-C` ends the session.** The ink REPL runs in raw mode, so the
keystroke reaches the input reducer instead of the kernel. The reducer maps it to
`/cancel`, which aborts any in-flight turn, persists the session and exits with code 4
(the in-Home chat returns to a freshly read Home). That includes the moment a `!`
command is running. The Home exits with code 0 on a single `Ctrl-C` or `Ctrl-D`.

**At a card, `Ctrl-C` already stops the turn, and so does `Esc`.** `reduceToolReviewKey`
treats the two keys alike on an approval card: the turn is aborted, the session is kept,
and the pending call is recorded as cancelled. The `ask_user` question card does the
same. The Home forwards a synthesized `Esc` to the chat for an approval abort. Since
[ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md) note 12
every answer to a card is a Ctrl chord (`Ctrl+Y`, `Ctrl+G`+Enter, `Ctrl+N`, `Ctrl+R`) and
a bare letter answers nothing. The first version of this ADR described a retired
bare-letter prompt ("`Ctrl-C` does nothing", "only unmodified keys answer"); neither is
true any more.

**Inside the card's text boxes, `Esc` stops the whole turn.** The reason box, the full
view's search box and the question card's own-answer field are all text fields, and
`Esc` in any of them aborts the turn. A person who started to type a reason and wants to
back out of the box loses the turn and the card with it.

**Everywhere else, the user's instinct is the opposite.** Every terminal agent they know
interrupts the work on the first `Ctrl-C` and leaves on the second.

[D68](../roadmap/current.md#wave-gating-decisions) (2026-11-04) set the intent:

- `Ctrl-C` interrupts the turn.
- A second press ends the session.
- `Ctrl-C` at a pending approval rejects it before anything else.

The approval path is a security path, so the ordering has to be exact, not merely
intuitive.

## Decision

**One interrupt keymap applies to every raw-mode interactive surface: the chat REPL, both
renderers, the in-Home chat and the Home itself. `Esc` steps back one level; `Ctrl+C`
stops.** The exact hint texts, the arming window and the footer wording live in
[chat-session.md](../reference/cli/chat-session.md) and
[home.md](../reference/cli/home.md), in one interrupt-keymap table per context; this ADR
does not restate them. Both files, [commands.md](../reference/cli/commands.md) and the
cards' legends link to that table.

### 1. `Ctrl+C`, by state

| State | First `Ctrl+C` | Second `Ctrl+C` (while armed) |
|-------|----------------|-------------------------------|
| An approval card is open (card, full view, call list, reason box or search box) | Reject the call (§2), then interrupt the turn, then arm | End the session |
| An `ask_user` question card is open (including its own-answer field) | Stop the turn (the call is recorded as cancelled, as [ADR-0132](0132-the-model-can-ask-the-user-a-structured-question.md) §5 says), then arm | End the session |
| A continue checkpoint is open ([ADR-0136](0136-a-turn-asks-to-continue-at-a-checkpoint-instead-of-dying-at-a-ceiling.md)) | Answer "stop", then arm | End the session |
| A turn is running | Interrupt the turn (the same abort `Esc` performs), then arm | End the session |
| A `!` command is running | Interrupt it (the same abort `Esc` performs), then arm | End the session |
| Idle, prompt text present | Clear the prompt text and do not arm | — |
| Idle, empty prompt | Arm and show the hint | End the session |
| A non-approval overlay is open (palette, picker, `@`-mention, reverse search, a confirmation card) | Close it, as today, and do not arm. A confirmation card treats `Ctrl+C` as cancel and never as confirm ([ADR-0122](0122-the-home-is-the-interactive-product.md) §7.4) | — |
| Home, no chat, loaded | Arm and show the hint | Exit the Home (code 0, as today) |
| Home, still loading | Exit at once (nothing is loaded and nothing can be lost) | — |

- **Arming expires.** The armed state lasts 2 seconds, measured on a monotonic clock, and
  ends earlier at any other key. The value is one named constant. A `Ctrl+C` long after an
  interrupt therefore starts over instead of ending the session.
- **Ending a session works as `/cancel` does now.** The in-flight work is aborted, the
  session is persisted and resumable, and the exit code is 4. The in-Home chat returns to a
  freshly read Home instead.
- **Clearing prompt text is the one choice beyond D68's wording.** It is the shell
  convention, and it keeps one stray `Ctrl+C` from discarding a half-written prompt *and*
  arming an exit.
- **`Ctrl+D` keeps its meaning** (the Home exits; an empty chat prompt follows today's
  input reducer). This ADR does not touch it.
- **The first `Ctrl+C` at any card arms.** One rule, whatever the card: a person who
  presses `Ctrl+C` twice in a row at a card leaves, exactly as at a running turn.

### 2. A pending approval is rejected first

When an approval is pending, the first `Ctrl+C` **and `Esc`** resolve it as a **user
rejection** synchronously, before the abort is signalled.

- A `Ctrl+C` or `Esc` can never approve anything.
- No abort, re-render or race can leave the decision open long enough for another key to
  answer it.
- The tool never runs, and the call is recorded as **rejected by the user**, which is true:
  today the same keys record it as cancelled, "execution state unknown"
  ([ADR-0128](0128-content-free-tool-receipts-ground-later-chat-turns.md)), a claim the
  rejection does not need to make.
- Because the abort follows at once, the rejection result is recorded but no further model
  call follows ([ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md) §1). The
  interrupted turn itself follows [ADR-0119](0119-an-interrupted-turn-stays-as-a-content-free-marker.md)
  (a content-free interruption marker).

`Esc` at the card stops the turn without arming: `Esc` never arms. `Ctrl+C` arms (§1).

The chord rule of [ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md)
note 12 stays exactly as it is: only `Ctrl+Y`, `Ctrl+G`+Enter, `Ctrl+N` and `Ctrl+R` answer
a card, and a bare letter answers nothing. `Esc` and `Ctrl+C` are matched **before** the
answer chords and resolve an approval only as a rejection. The input guards
(dwell, quiet gap, typeahead window, lockout) gate affirmative answers only; a rejection is
never delayed.

### 3. `Esc` steps back one level

`Esc` closes the innermost thing a card opened and only stops the turn when there is
nothing left to close.

- **A text box inside a card** — the approval card's reason box, the full view's search
  box, the `ask_user` card's own-answer field: `Esc` closes the box and returns to the
  card with the typed text discarded. The call stays pending and nothing is rejected. A
  second `Esc`, now at the card, rejects and stops (§2).
- **A card with no box open:** `Esc` rejects (approval) or stops (question) and stops the
  turn, without arming.
- **The full view and the details screens are not boxes.** `Esc` in an approval's full
  view still stops the turn as the legend says, because the full view has its own way back
  (`[b] Back to the card`); `Esc` in a details or call-list screen still closes the view.
  This ADR does not change either.
- `Ctrl+C` inside a text box is not "step back": it stops, as everywhere (§1).

This reverses one sentence the maintainer ruled in
[ADR-0132](0132-the-model-can-ask-the-user-a-structured-question.md) ("`Esc` stops the
turn everywhere", 2026-11-16) for the three text fields only, on the maintainer's decision
of 2026-11-19. The ruling stands for every other state.

### 4. Signals are not keystrokes

A SIGINT from outside the process (`kill -INT`, or a terminal's `Ctrl-C` while raw mode is
off) keeps its process-control meaning.

- **Chat sessions.** The first SIGINT ends the session cooperatively (abort, then persist,
  then code 4), and a second one force-exits. This also applies to the plain and `--json`
  chat drivers. There, the first SIGINT must reach the in-flight turn, not only stop
  reading further input (the #23 defect). **Whether it does today is not pinned by any
  test**; the implementation proves it with a test and fixes it if it does not. Those
  drivers have no approver, so no approval can be pending.
- **Hatches.** A SIGINT that arrives while a `/scrollback` or `/edit` hatch owns the
  terminal is still dropped, as [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md)
  records.
- **Out of scope.** `relavium run`, `gate`, `budget resume` and `agent run` keep their
  documented signal behaviour. This ADR covers interactive sessions and the Home. A run
  hosted inside the Home is the later run-hosting ADR's
  ([ADR-0122](0122-the-home-is-the-interactive-product.md) §10), which amends this one.

### 5. Acceptance criteria

- The keymap lives in one pure reducer, `interrupt-keymap.ts`, fed an injected monotonic
  clock, and every surface calls it. A table-driven test covers every row of §1 and §3.
- Reject-first is proven at the store: a `Ctrl+C` and an `Esc` at a pending approval settle
  the approval as a rejection **before** the abort is signalled, and a mutation that swaps
  the order fails a test.
- The plain and `--json` first-SIGINT behaviour of §4 is pinned by a test.
- **Windows.** A raw-mode `Ctrl-C` must arrive as a key, reject and arm, in Windows
  Terminal and in the legacy console. CI cannot cover it (the required Windows job is
  headless, and a pseudo-terminal harness would be a new dependency that needs its own
  ADR), so it is recorded as manual evidence on a Windows machine before the increment's
  final round. If a raw-mode console delivers it as SIGINT instead, §4's cooperative path
  applies there and the fact is recorded.
- The legacy bare-letter approval reducer is deleted (the increment's first step), so a
  second path that answers an approval cannot return.
- The interrupt hints and legends are rewritten once, in the plus spelling (`Ctrl+C`), in
  the same increment.

### Alternatives considered

- **Keep `Ctrl-C` as `/cancel` and make it reject a pending approval first** (the
  2026-10-19 wording). Rejected by D68. Ending the whole session is a heavy answer to "stop
  this", and the only way to keep the session would stay a key the user has to discover.
- **`Ctrl-C` at an approval rejects only, and the turn continues.** Rejected. A `Ctrl-C`
  asks for the work to stop. Letting the model carry on with its next tool after the user
  pressed the stop key is the wrong default. `Ctrl+N` remains the way to deny one call and
  let the turn continue.
- **`Esc` at a card keeps recording the call as cancelled.** Rejected. The call never ran;
  "rejected by the user" is the true record and the one a later turn can explain.
- **`Esc` stops the turn inside text boxes, as today.** Rejected on 2026-11-19: it makes
  backing out of a typed reason cost the turn. The price is one extra `Esc` to stop from
  inside a box.
- **No arming window.** Rejected. A second press minutes after an interrupt would end a
  session the user meant to keep.
- **Leave the Home on a single press.** Rejected for consistency. One keymap means the same
  press count on every surface. The Home cost is one extra keystroke, and it has nothing
  unsaved to lose.

## Consequences

### Positive

- The stop key behaves the same way everywhere and never costs the user the session on the
  first press.
- A pending approval can be stopped with `Ctrl+C` or `Esc`, and it is always rejected,
  never approved, and recorded truthfully.
- Backing out of a typed reason no longer loses the turn.
- Signals keep a script-friendly, single-step meaning.
- The plain and `--json` drivers' first SIGINT finally has a test.

### Negative

- Leaving a session or the Home takes two presses. The footer hint has to teach this.
- `Ctrl+C` now rejects at the approval card and `Esc` now rejects at the card instead of
  cancelling. This touches the approval path, so row 11b's approval-path security sitting
  stays.
- Raw-mode keystroke handling and signal handling diverge on purpose. Tests have to cover
  both, and the Windows console path needs manual evidence, not an assumption.
- `Esc` inside a box and `Esc` at the card now mean different things, which the legends
  have to say.

### Revision note — 2026-11-19

The ADR was Proposed on 2026-11-05 and had not been accepted when the approval card, the
modes and the chord keys landed (ADR-0129 to ADR-0132, MVP-3b to MVP-3d). It was revised in
place, not superseded, because it was never accepted. The revisions: the context now states
what the code does today; `Esc` at a card also rejects first; `Ctrl+C` arms at every card;
`Esc` steps back one level inside the card's text boxes (the maintainer's decision of
2026-11-19); the Home-loading and `!`-command rows were added; the continue checkpoint of
ADR-0136 is a row; the Windows acceptance criterion was added; and the unmodified-keys
paragraph was removed because it described the retired prompt.
