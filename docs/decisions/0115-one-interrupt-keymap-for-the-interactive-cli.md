# ADR-0115: One interrupt keymap for the interactive CLI

- **Status**: Proposed
- **Date**: 2026-11-05
- **Related**: [ADR-0054](0054-cli-bare-invocation-interactive-home.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md), [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md), [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md), [D68](../roadmap/current.md#wave-gating-decisions), [MVP-A12](../roadmap/phases/phase-2.6-conversational-authoring.md#cli-mvp-additions--2026-11-04), [row 11b](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#proposed-implementation-increments)

## Context

Today, Ctrl-C in the interactive chat ends the session. The ink REPL runs in
raw mode, so the keystroke never reaches the kernel as SIGINT. The input
reducer maps it to `/cancel`, which aborts any in-flight turn, persists the
session and exits with code 4.

- To stop a turn but keep the session, the user has to know to press Esc.
- At a pending tool approval, Ctrl-C does nothing. The approval reducer accepts
  only unmodified answer keys, and that fail-closed rule correctly stops a
  chord from approving anything. Its side effect is that the user's most
  instinctive stop key is silently swallowed while a governed action waits.
- The Home exits on one Ctrl-C.
- Every other terminal agent the user knows interrupts the work on the first
  press and leaves on the second.

The 2026-10-19 Wave 3 ruling for row 11b made Ctrl-C at a pending approval
"map to `/cancel`": reject the approval, then end the session. On 2026-11-04
the maintainer replaced that wording with D68:

- Ctrl-C interrupts the turn.
- A second press ends the session.
- Ctrl-C at a pending approval rejects it before anything else.

The approval path is a security path (ADR-0057's fail-closed floor), so the
ordering has to be exact, not merely intuitive.

## Decision

**One interrupt keymap applies to every raw-mode interactive surface: the chat
REPL, both renderers, the in-Home chat and the Home itself.** The exact hint
texts, the arming window and the footer wording live in
[chat-session.md](../reference/cli/chat-session.md) and
[home.md](../reference/cli/home.md); this ADR does not restate them.

### 1. Ctrl-C, by state

| State | First Ctrl-C | Second Ctrl-C (while armed) |
|-------|--------------|-----------------------------|
| A tool approval is pending | Reject the approval, then interrupt the turn, then arm | End the session |
| A turn is running | Interrupt the turn (the same abort Esc performs), then arm | End the session |
| Idle, prompt text present | Clear the prompt text and do not arm | — |
| Idle, empty prompt | Arm and show the hint | End the session |
| A non-approval overlay is open (palette, picker, `@`-mention, reverse search) | Close it, as today, and do not arm | — |
| Home, no chat | Arm and show the hint | Exit the Home (code 0, as today) |

- **Arming expires.** The armed state expires after a short window, or at any
  other key. A Ctrl-C long after an interrupt therefore starts over instead of
  ending the session.
- **Ending a session works as `/cancel` does now.** The in-flight work is
  aborted, the session is persisted and resumable, and the exit code is 4. The
  in-Home chat returns to a freshly read Home instead.
- **Clearing prompt text is the one choice beyond D68's wording.** It is the
  shell convention, and it keeps one stray Ctrl-C from discarding a half-written
  prompt *and* arming an exit.

### 2. A pending approval is rejected first

When an approval is pending, the first Ctrl-C resolves it as a **user
rejection** synchronously, before the abort is signalled.

- A Ctrl-C can never approve anything.
- No abort, re-render or race can leave the decision open long enough for
  another key to answer it.
- The tool never runs.

The rejection is recorded like any other user rejection. What the model is
later told about it follows the denial-feedback amendment (D67). The
interrupted turn itself follows ADR-0095 as amended for the CR-71 residual (a
content-free interruption marker).

Esc at a pending approval keeps aborting the turn, as today. Both keys now take
the same reject-then-abort path, so the outcome cannot depend on which one was
pressed.

The reducer's rule that only unmodified keys answer an approval stays exactly as
it is. Ctrl-C is matched **before** that rule and is the only chord that resolves
an approval, and it resolves it only as a rejection.

### 3. Signals are not keystrokes

A SIGINT from outside the process (`kill -INT`, or a terminal's Ctrl-C while
raw mode is off) keeps its process-control meaning.

- **Chat sessions.** The first SIGINT ends the session cooperatively (abort, then
  persist, then code 4), and a second one force-exits. This also applies to the
  plain and `--json` chat drivers. There, the first SIGINT must reach the
  in-flight turn, not only stop reading further input (the #23 defect). Those
  drivers have no approver, so no approval can be pending.
- **Hatches.** A SIGINT that arrives while a `/scrollback` or `/edit` hatch owns
  the terminal is still dropped, as ADR-0068 records.
- **Out of scope.** `relavium run`, `gate`, `budget resume` and `agent run` keep
  their documented signal behaviour. This ADR covers interactive sessions and
  the Home.

### 4. What is superseded

This ADR replaces three things:

- The 2026-10-19 row 11b wording that Ctrl-C at a pending approval maps to
  `/cancel`.
- The chat reference's statement that Ctrl-C is equivalent to `/cancel`.
- ADR-0061's parenthetical that "Ctrl-C's `/cancel` would end" a `!` command's
  session. Under this keymap, Ctrl-C during a `!` command interrupts it as Esc
  does.

`/cancel` and `/exit` keep their meanings. ADR-0061 gets a dated amendment note
pointing here.

### Alternatives considered

- **Keep Ctrl-C as `/cancel` and make it reject a pending approval first** (the
  2026-10-19 wording). Rejected by D68. Ending the whole session is a heavy
  answer to "stop this", and the only way to keep the session would stay a key
  the user has to discover.
- **Ctrl-C at an approval rejects only, and the turn continues.** Rejected. A
  Ctrl-C asks for the work to stop. Letting the model carry on with its next
  tool after the user pressed the stop key is the wrong default. Answering `n`
  remains the way to deny one call and let the turn continue.
- **No arming window.** Rejected. A second press minutes after an interrupt
  would end a session the user meant to keep.
- **Leave the Home on a single press.** Rejected for consistency. One keymap
  means the same press count on every surface. The Home cost is one extra
  keystroke, and it has nothing unsaved to lose.

## Consequences

### Positive

- The stop key behaves the same way everywhere and never costs the user the
  session on the first press.
- A pending approval can be stopped with Ctrl-C, and it is always rejected,
  never approved.
- Signals keep a script-friendly, single-step meaning.
- The plain and `--json` drivers' first SIGINT finally reaches the in-flight
  turn.

### Negative

- Leaving a session or the Home takes two presses. The footer hint has to
  teach this.
- Ctrl-C now rejects at the approval prompt. This touches the approval path, so
  row 11b's approval-path security sitting stays.
- Raw-mode keystroke handling and signal handling diverge on purpose. Tests
  have to cover both, and the Windows console path too, where Ctrl-C delivery
  under raw mode must be verified rather than assumed.
