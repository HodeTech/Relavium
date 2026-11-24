# ADR-0115: One interrupt keymap for the interactive CLI

- **Status**: Accepted — 2026-11-19, by the maintainer, after the revision recorded at the end and two independent document reviews. Implemented in MVP-4 step 2 (see the implementation note at the end); the D64 rigor tier and a separate security sitting apply, and the Windows evidence of §5 is collected by hand ([runbook](../runbooks/windows-interrupt-evidence.md)).
- **Date**: 2026-11-05 (revised 2026-11-19)
- **Supersedes, in part**: [ADR-0132](0132-the-model-can-ask-the-user-a-structured-question.md) §3 — one sentence only: "`Esc` and `Ctrl-C` stop the turn", which the maintainer ruled on 2026-11-16 as "`Esc` stops the turn everywhere". Inside the question card's own-answer field `Esc` now closes the field first (§3 below). Every other state keeps the ruling.
- **Amends**: [ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md) note 8 (the hint in a reason box) and the approval reject path (§2), and [ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md) (the parenthetical about `Ctrl-C` during a `!` command). The search box's `Esc` is specified in [chat-session.md](../reference/cli/chat-session.md), not in an ADR.
- **Related**: [ADR-0054](0054-cli-bare-invocation-interactive-home.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md), [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md), [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md), [ADR-0118](0118-a-command-outside-the-allowlist-asks-instead-of-failing.md), [ADR-0119](0119-an-interrupted-turn-stays-as-a-content-free-marker.md), [ADR-0122](0122-the-home-is-the-interactive-product.md), [ADR-0128](0128-content-free-tool-receipts-ground-later-chat-turns.md), [ADR-0134](0134-the-full-view-and-the-tool-details-are-one-readable-inspection-screen.md), [ADR-0136](0136-a-turn-asks-to-continue-at-a-checkpoint-instead-of-dying-at-a-ceiling.md), [D68](../roadmap/current.md#wave-gating-decisions), [MVP-A12](../roadmap/phases/phase-2.6-conversational-authoring.md#cli-mvp-additions--2026-11-04), [row 11b](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#proposed-implementation-increments)

## Context

The facts below were read from the code on 2026-11-19.

**Outside a card, `Ctrl-C` ends the session.** The ink REPL runs in raw mode, so the
keystroke reaches the input reducer instead of the kernel. The reducer maps it to
`/cancel`, which aborts any in-flight turn, persists the session and exits with code 4
(the in-Home chat returns to a freshly read Home). That includes the moment a `!`
command is running. The Home exits with code 0 on a single `Ctrl-C` or `Ctrl-D`.

**At a card, `Ctrl-C` already stops the turn, and so does `Esc`.** On an approval review
(`reduceToolReviewKey`, state kind `approval`), both keys abort the turn, keep the session
and record the pending call as cancelled, on every screen of the review: the card, the full
view, the call list, the reason box and the search box. On a details view (no approval
pending) both close the view. The `ask_user` question card stops the turn on both keys,
including inside its own-answer field. The Home forwards a synthesized `Esc` to the chat for
an approval abort. Since
[ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md) note 12
every answer to a card is a Ctrl chord and a bare letter answers nothing. The first version
of this ADR described a retired bare-letter prompt ("`Ctrl-C` does nothing", "only
unmodified keys answer"); neither is true any more.

**Inside the card's text boxes, `Esc` stops the whole turn.** A person who started to type
a reason and wants to back out of the box loses the turn and the card with it. The code
also carries a second, older reason-draft path (in the Home controller and the chat view)
whose comments say `Esc` "cancels back to the card"; the live path is the store's, which
aborts.

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
stops.** The behaviour is decided here. The hint, legend and footer *texts* live in
[chat-session.md](../reference/cli/chat-session.md) and
[home.md](../reference/cli/home.md), as one interrupt-keymap table per context that
[commands.md](../reference/cli/commands.md) and the cards' legends link to.

### 1. `Ctrl+C`, by state

| State | First `Ctrl+C` | Second `Ctrl+C` (while armed) |
|-------|----------------|-------------------------------|
| An **approval review** is open, on any screen (card, full view, call list) or with its reason box or search box open | Reject the call (§2), then interrupt the turn, then arm | End the session |
| An `ask_user` question card is open (including its own-answer field) | Stop the turn (the call is recorded as cancelled, as [ADR-0132](0132-the-model-can-ask-the-user-a-structured-question.md) §5 says), then arm | End the session |
| A continue checkpoint is open ([ADR-0136](0136-a-turn-asks-to-continue-at-a-checkpoint-instead-of-dying-at-a-ceiling.md)) | Answer "stop", then arm | End the session |
| A turn is running | Interrupt the turn (the same abort `Esc` performs), then arm | End the session |
| A `!` command is running | Interrupt it (the same abort `Esc` performs), then arm | End the session |
| Idle, prompt text present | Clear the prompt text and do not arm | — |
| Idle, empty prompt | Arm and show the hint | End the session |
| A **details view** (opened with `/details`, no approval pending) or a non-approval overlay (palette, picker, `@`-mention, reverse search, a confirmation card) is open | Close it, as today, and do not arm. A confirmation card treats `Ctrl+C` as cancel and never as confirm ([ADR-0122](0122-the-home-is-the-interactive-product.md) §7.4) | — |
| Home, no chat, loaded | Arm and show the hint | Exit the Home (code 0, as today) |
| Home, still loading | Exit at once (nothing is loaded and nothing can be lost) | — |

> Amended 2026-11-21 (the PR #101 review): on the **loaded Home with a draft** the first `Ctrl+C` arms and keeps the draft, and the second press exits, **so the draft is lost**: "nothing unsaved to lose" (the rejected-alternative paragraph below) is false there. The decision stands (one press count on every surface, a draft is never cleared by a press that also arms an exit, and `Ctrl+D` on an empty prompt still leaves at once); what changes is that the reference says the loss plainly ([home.md](../reference/cli/home.md#keymap-25b)) and the hint is the only warning. A chat's prompt differs: a draft there is cleared by the first press and nothing is armed, so leaving a chat from a draft takes three presses (clear, arm, end), as `interrupt-keymap.ts` decides.

- **Arming expires.** The armed state lasts 2 seconds, measured on a monotonic clock, and
  ends earlier at any other key. The value is one named constant. A `Ctrl+C` long after an
  interrupt therefore starts over instead of ending the session.
- **Ending a session works as `/cancel` does now.** The in-flight work is aborted, the
  session is persisted and resumable, and the exit code is 4. The in-Home chat returns to a
  freshly read Home instead.
- **Clearing prompt text is the one choice beyond D68's wording.** It is the shell
  convention, and it keeps one stray `Ctrl+C` from discarding a half-written prompt *and*
  arming an exit.
- **`Ctrl+D` keeps its meaning** (the Home exits at once; an empty chat prompt follows
  today's input reducer). This ADR does not touch it.
- **The first `Ctrl+C` at any card arms.** One rule, whatever the card: a person who
  presses `Ctrl+C` twice in a row at a card leaves, exactly as at a running turn.

### 2. A pending approval is rejected first

When an approval review is open and no text box of it is open, the first `Ctrl+C` **and
`Esc`** resolve the pending call as a **user rejection** synchronously, before the abort is
signalled.

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

`Esc` stops the turn without arming: `Esc` never arms. `Ctrl+C` arms (§1).

**What answers a card is each card's own decision.** The chords that approve are defined
where the card is: [ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md)
note 12 for the file approval card (`Ctrl+Y`, `Ctrl+G`+Enter, `Ctrl+N`, `Ctrl+R`),
[ADR-0118](0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) for the command
card's added answer, and [ADR-0136](0136-a-turn-asks-to-continue-at-a-checkpoint-instead-of-dying-at-a-ceiling.md)
for the checkpoint. This ADR fixes only what no card may do: **`Esc` and `Ctrl+C` are
matched before every answer chord and resolve an approval only as a rejection**, a bare
letter answers nothing, and the input guards (dwell, quiet gap, typeahead window, lockout)
gate affirmative answers only: a rejection is never delayed.

> Amended 2026-11-20 by [ADR-0137](0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §4: the rejection above applies where the card is the screen. On the full view and on the call list of an approval, `Esc` returns to the card and rejects nothing; `Ctrl+C` is unchanged and still rejects first. *(Implemented 2026-11-21, MVP-4 step 6: the full view returns to the card; an approval never shows the call list, so that half has nothing to apply to today and is covered at the reducer.)*

### 3. `Esc` steps back one level

`Esc` closes the innermost thing a card opened and only stops the turn when there is
nothing left to close.

| Where | `Esc` |
|---|---|
| A text box of an approval review: the reason box, the full view's search box | Close the box and return to where it opened, the typed text discarded. The call stays pending and nothing is rejected |
| The `ask_user` card's own-answer field | Close the field and return to the options, the typed text discarded. The call stays pending |
| An approval review, no box open, on the card, the full view or the call list | Reject the call and stop the turn (§2). The full view and the call list have their own way back (`[b] Back to the card`), and `Esc` there is the stop key, as the legend already says |
| An `ask_user` card, no field open | Stop the turn (the call is recorded as cancelled) |
| A details view or a non-approval overlay | Close it, as today |

A second `Esc`, now with no box open, therefore stops the turn. `Ctrl+C` inside a text box
is not "step back": it stops, as everywhere (§1).

> Amended 2026-11-20 by [ADR-0137](0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §4: the third row now reads — on the full view or the call list of an approval, no box open, `Esc` returns to the card and the call stays pending; on the card, no box open, `Esc` rejects the call and stops the turn. The reducer's tests and the host tests of the card cover the changed row (`tool-review.test.ts`, `tool-review-host.test.tsx`, `home-controller.test.ts`). *(Implemented 2026-11-21, MVP-4 step 6.)*

This reverses one sentence the maintainer ruled in
[ADR-0132](0132-the-model-can-ask-the-user-a-structured-question.md) ("`Esc` stops the
turn everywhere", 2026-11-16) for the two text boxes and the one field, on the maintainer's
decision of 2026-11-19. The ruling stands for every other state, so this ADR supersedes
that sentence in part and does not merely amend it.

### 4. Signals are not keystrokes

A SIGINT from outside the process (`kill -INT`, or a terminal's `Ctrl-C` while raw mode is
off) keeps its process-control meaning.

- **Chat sessions.** The first SIGINT ends the session cooperatively (abort, then persist,
  then code 4), and a second one force-exits. This also applies to the plain and `--json`
  chat drivers. There, the first SIGINT must reach the in-flight turn, not only stop
  reading further input (the #23 defect). **Whether it does today is not pinned by any
  test**; the implementation proves it with a test and fixes it if it does not. Those
  drivers have no approver, so no approval can be pending.

> Amended 2026-11-21: it is pinned since MVP-4 step 2, by a test in each driver (`apps/cli/src/commands/chat.test.ts`; the implementation note below). Two exit codes follow from "keeps its process-control meaning" and the reference keeps them apart: a SIGINT that reaches a **chat** (the standalone chat, and the plain and `--json` drivers) ends it with exit `4`; one that reaches the **Home** (the invocation-backed host that owns the terminal) is `128 + 2` = `130` ([home.md](../reference/cli/home.md#signal-lifecycle--exit-codes), [commands.md](../reference/cli/commands.md#exit-codes)).
- **Hatches.** A SIGINT that arrives while a `/scrollback` or `/edit` hatch owns the
  terminal is still dropped: raw mode is off for that window, so a keyboard `Ctrl-C` is a
  real SIGINT, and the handler must yield (the suspend note in
  [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md); the guard is
  `onSigintGated` in `chat-ink.tsx`).
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
- The legacy approval-prompt reducer (`reduceApprovalKey`, which answers nothing now) and
  the older reason-draft path are deleted in the increment's first step, so one path owns
  the keyboard and a second path that answers an approval cannot return. The characterization
  tests that pin what the live path does are written before the deletion.
- The interrupt hints and legends are rewritten once, in the plus spelling (`Ctrl+C`), in
  the same increment, and the question card's refusal of answer-chord tokens in model text
  (`ask-user.ts`) covers every chord a card adds.

### What this replaces

- The 2026-10-19 row 11b wording that `Ctrl-C` at a pending approval maps to `/cancel`.
- The chat reference's statement that `Ctrl-C` is equivalent to `/cancel`, and the Home
  reference's "`Ctrl-C` | clean exit | `/cancel`".
- [ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md)'s parenthetical that
  "`Ctrl-C`'s `/cancel` would end" a `!` command's session. Under this keymap, `Ctrl-C`
  during a `!` command interrupts it as `Esc` does.

`/cancel` and `/exit` keep their meanings.

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
- **`Esc` in the full view returns to the card first.** Not taken: the full view has an
  explicit way back, and changing it is outside what was decided on 2026-11-19.
  *(Taken on 2026-11-20 by [ADR-0137](0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §4.)*
- **No arming window.** Rejected. A second press minutes after an interrupt would end a
  session the user meant to keep.
- **Leave the Home on a single press.** Rejected for consistency. One keymap means the same
  press count on every surface. The Home cost is one extra keystroke, and it has nothing
  unsaved to lose.

> Amended 2026-11-21: that is not true of a Home prompt that holds a draft (see the note beneath the §1 table): the second `Ctrl+C` exits and the draft goes with the process. Kept as decided; stated in the reference.

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

- Leaving a session takes two `Ctrl+C` presses, and leaving the Home takes two (`Ctrl+D`
  still exits the Home at once). The footer hint has to teach this.
- `Ctrl+C` now rejects at the approval card and `Esc` now rejects at the card instead of
  cancelling. This touches the approval path, so row 11b's approval-path security sitting
  stays.
- Raw-mode keystroke handling and signal handling diverge on purpose. Tests have to cover
  both, and the Windows console path needs manual evidence, not an assumption.
- `Esc` inside a box and `Esc` at the card now mean different things, which the legends
  have to say.

### Landing obligations

- [chat-session.md](../reference/cli/chat-session.md): one interrupt-keymap table per
  context (replacing the "equivalent to `/cancel`" statements near the slash-command table
  and the exit-code list, and recording the search box's `Esc`); the card legends.
- [home.md](../reference/cli/home.md): the keys table, the "`Ctrl-C` is always an escape"
  line and the chat-to-Home exit rows. [commands.md](../reference/cli/commands.md): the
  exit-code 4 wording. [built-in-tools.md](../reference/shared-core/built-in-tools.md): the
  stopped-question-card lines.
- Dated amendment notes on [ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md),
  [ADR-0122](0122-the-home-is-the-interactive-product.md) §7.4,
  [ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md),
  [ADR-0132](0132-the-model-can-ask-the-user-a-structured-question.md) (superseded in part)
  and [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md).

### Revision note — 2026-11-19

The ADR was Proposed on 2026-11-05 and had not been accepted when the approval card, the
modes and the chord keys landed (ADR-0129 to ADR-0132, MVP-3b to MVP-3d). It was revised in
place, not superseded, because it was never accepted. The revisions: the context now states
what the code does today; `Esc` at a card also rejects first; `Ctrl+C` arms at every card;
`Esc` steps back one level inside the card's text boxes (the maintainer's decision of
2026-11-19), which supersedes one sentence of ADR-0132; the Home-loading and `!`-command
rows were added; the continue checkpoint of ADR-0136 is a row; the Windows acceptance
criterion was added; the per-screen behaviour of an approval review is stated once; and the
unmodified-keys paragraph was removed because it described the retired prompt. A review on
the same day corrected three attributions (the search box's `Esc` belongs to the chat
reference, not to ADR-0134) and the claim that this ADR restates no behaviour.

### Implementation note — 2026-11-19 (MVP-4 step 2)

The keymap is `apps/cli/src/render/tui/interrupt-keymap.ts`, a pure reducer over an injected monotonic clock, with one named window constant. The standalone chat (`chat-ink.tsx`) and the Home controller (`home-controller.ts`) ask it for every `Ctrl+C`; neither keeps its own table. Details the decision leaves open:

- **A card is not a context of its own in the Home.** An open approval or question implies a running turn, and the chat store settles it before the key reaches the controller (an approval as a *rejection*, §2), so the controller sees a running turn and the keymap's "work" row applies. The standalone chat passes the card result to the keymap explicitly. Both reach the same action.
- **The store returns three results**, not two: `abort` (a card was settled as a stop and the surface aborts the turn), `stop-answered` (a `Ctrl+C` that answered a checkpoint "stop", which the engine ends itself, so the surface starts the interrupt window and aborts nothing) and `handled`. Reject-first is structural: the approval is settled inside the store before it returns `abort`, and a test reads the store at the moment the surface's abort runs.
- **The Home with a draft arms and keeps the draft.** The table's "Home, loaded" row is taken literally; clearing a draft is the chat prompt's row.
- **Before a chat has activated, `Ctrl+C` ends the standalone chat's session at once**: nothing is on screen yet that could be lost, and it preserves what the key did before. The Home's chat has no such window of its own: while its first turn is being sent the state reads as work, so the first press is an interrupt that arms and the second ends the chat.
- **Any other key disarms, wherever it ends up.** The standalone chat disarms before routing, and the Home host does it in one place, `routeKeyThroughCards` (exported from `home-app.tsx` so the controller tests drive the same routing), ahead of the cards, the scroll keys and the selection dismissal; a paste is a key too, in both. The card-pipeline mouse gates now include the checkpoint card.
- **The legacy approval-prompt reducer and the older reason-draft path are deleted**: `reduceApprovalKey`, the `approve`, `reject` and `reject-with-reason` key actions, the `cancel` action (the keymap's now), the `approvalPending` parameter of `reduceChatKey`, the reason-draft state in both surfaces and the dead approval block in `ChatView`. A characterization test written before the deletion pins that no key a card leaves reaches a decision.
- **The question card's stop row** reads `Esc closes · Ctrl+C stops the turn` while its own-answer field is open, so the legend does not promise what `Esc` no longer does there. `ask_user` now refuses any `[Ctrl+<letter>]` token and `[Esc]` in model text, so a chord a later card adds needs no list change.
- **Signals.** The plain and `--json` drivers' first SIGINT reaching the in-flight turn is pinned by a test in each driver; it already held. The Windows evidence recipe is [windows-interrupt-evidence.md](../runbooks/windows-interrupt-evidence.md); the evidence itself is collected by hand and recorded in the phase register.
- **Reject-first needed a change in the engine's registry, and a test through the real session.** Settling the approval first was not enough: the surface signals the abort in the same synchronous stack, so by the time the registry's code after `await confirm()` ran the signal was already aborted, and its outer catch turned the denial into a cancellation ("execution state unknown", no repeat-denial memory, no `denied` row), which is what §2 says must not happen. The registry now keeps a `user_rejected` denial a denial when no effect was admitted and nothing was replayed, whether or not the signal has since aborted; an approve that lands after an abort still cancels, and the turn still stops at its next boundary without another model call. This was found by the security review of step 2 and is pinned by a registry test, a session-host test that drives the real store and session the way the surface does (Esc, then `abort()` in one stack), and mutation checks of both.
- **Accepted simplifications.** The busy line `Waiting for your answer · Esc stops the turn` and the question card's too-small refusal row keep naming `Esc` as the generic stop key while a box or the own-answer field may be open, where the first `Esc` only closes it; the card's own legend says the true thing, and the second `Esc` stops. The hint on a hidden card cannot say more than one row can hold.


### Implementation note — 2026-11-19 (MVP-4 step 2, after review round 2)

- **A sealed store cancels a pending approval; it no longer rejects it.** With reject-first in the registry, a teardown that sealed the store and then aborted in one stack would have recorded the open call as "the user declined", which the person never decided. The seal now cancels an open approval exactly as it cancels a question and a checkpoint.
- **The registry's exception is narrow, and tested at its edges.** It applies to a `user_rejected` denial thrown before the tool is handed the call (`!effectDispatched`, `!dispatchStarted`, `!replayHit`); a refusal after the effect slot was admitted, one thrown from inside the tool, one at a saved-result delivery (the effect was admitted in an earlier attempt), and a wiring-fault refusal (`no_approval_hook`) followed by an abort all stay cancellations.
- **Holding `Ctrl+C` counts as two presses.** The window has no minimum gap and no held-key rule, unlike an affirmative key's lockout, because a stop must never be delayed and a held repeat can only end a session that is persisted and resumable (before this ADR a single press ended it). Accepted; a held-key rule would also delay a deliberate fast double press.
- **A Ctrl+C that clears a draft also drops a pending `@` mention read** (the generation moves), so a late read cannot splice its marker back into the empty draft. Pending `@` and `!` chips stay; `Esc` at an idle prompt discards them.
- **A running turn shows that the press was heard.** While the keymap is armed on a running turn the view says `Interrupting · press Ctrl+C again to end the session`, so a turn that is slow to stop (a hung tool) is not silent.
- **`ask_user` refusal, ASCII and chord spellings.** The refusal now also rejects any short bracketed token written with `+`, a full-width `＋` or `^`, and a token that begins with a key name (`[Ctrl-Y]`, `[Escape]`), so homoglyph letters inside a `+` chord are covered. Homoglyph letters joined by `-` or a space are not; a forged legend at a question card can only prime a key that counts as typing at the next card.


### Amendment note — 2026-11-21 (PR #101 review)

- **§1, beneath the table**: a Home draft is lost on the second press (the decision stands; the reasoning "nothing to lose" did not hold, and the reference now says so). A chat from a draft takes three presses.
- **Alternatives, "Leave the Home on a single press"**: the same correction.
- **§4**: the first-SIGINT test it called unpinned exists; the Home's SIGINT exit is `130` and a chat's is `4`.

### Amendment note — 2026-11-22 (ADR-0139 and ADR-0140, MVP-8)

§1 gains the run rows of [ADR-0139](0139-a-workflow-run-is-hosted-inside-the-home.md) §5: a running leg takes two presses (the first arms, the second cancels), and a run view with no leg executing closes on one press and arms nothing. The `Ctrl+D` row narrows: while a leg executes, `Ctrl+D` on an empty prompt opens a confirmation card instead of exiting. §4's 'out of scope' sentence for a run hosted in the Home is answered by ADR-0139 §5.

### Amendment note — 2026-11-24 (PR #102 review)

§2's last sentence says the input guards (dwell, quiet gap, typeahead window, lockout) gate affirmative answers only and "a rejection is never delayed". That holds for what §2 is about, a pending **tool approval**, where the rejection resolves synchronously and ahead of every guard. It does not hold for the Home's **human gate**: there `Ctrl+N` rejects the gate, and a `rejected` decision **continues the run** (the author routes on it, [ADR-0139](0139-a-workflow-run-is-hosted-inside-the-home.md) §4), so the card holds it to the same lockout as an approval (the maintainer's ruling of 2026-11-23, recorded in ADR-0139's last note). `Esc` and `Ctrl+C` on that card still decide nothing and are never delayed, and a rejection that only denies a tool call is still never delayed. The decision of §2 stands; ADR-0139 amends this section, which its `Amends` line (§1 and §4) does not list.
