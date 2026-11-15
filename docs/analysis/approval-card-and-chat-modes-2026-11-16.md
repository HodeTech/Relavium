# The approval card and the chat modes — what they do today, and what comparable agents do

- **Date**: 2026-11-16
- **Status**: Analysis that informed [ADR-0129](../decisions/0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md), [ADR-0130](../decisions/0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md), [ADR-0131](../decisions/0131-a-round-that-made-progress-resets-the-correction-budget.md) and the acceptance of [ADR-0117](../decisions/0117-a-denied-tool-call-returns-to-the-model.md).
- **Local source**: `development` after `b2dff860`; measurements are from the real view code rendered through the component harness at 80×24 and 120×40, and from the maintainer's own session history (structural columns only — no message content).
- **Documentation direction**: per the [maintainer's 2026-11-15 direction](README.md#maintainer-documentation-direction--2026-11-15), the surveyed agents are not named or linked. Findings are stated as technical patterns and Relavium requirements.

## What prompted this

Two things a maintainer saw in a real session.

1. **The approval card was a different, text-heavy screen.** When a write waited for
   consent, the conversation disappeared and a review screen replaced it.
2. **The default mode refused a write instead of asking.** The model tried to create a
   file in `ask`, the call was refused, the turn ended with a `tool_denied` error
   row and a help URL, and the user had to know to press Shift+Tab.

A third observation in the same sitting widened the scope: a 3 min 50 s turn ended in
`tool_failed`, and the model, asked what had failed, answered that no tool had been
called. That case is analysed under *The turn that vanished* below.

## What the card did (measured)

For a new 17-line file at 80×24, the old card spent about eleven rows on chrome around four rows
of content:

```
Review tool operation / tool write_file / action fs_write / target merhaba.md /
17 changed lines · 468 changed bytes · 0 masked spans / New file · endings empty → lf /
+1 …<LF> +2 …<LF> +3 …<LF> +4 …<LF> / 13 hidden lines · 391 hidden bytes · masked view /
Inspection requirements met. / [v] full view · [c] reason to deny /
[y] once · [a] always for named tool (session) · [n] deny · Esc/Ctrl-C abort /
Approval cannot override protected-path or permission denials.
```

- The conversation was hidden (`ChatView hidden`) for the whole time the card was open.
- At 120×40 the same four lines were shown: the body was capped at four rows whatever the terminal.
- `<LF>` followed every line, although ADR-0120 asked for an ending token only where a line's
  ending *differs*. The projection printed it unconditionally.
- `Esc/Ctrl-C abort` stopped the whole turn and did not say so; `[a] always for named tool` is
  jargon for "every write of this kind until you quit".

## What the modes did

| Mode | Advertised | A governed action | Note |
|---|---|---|---|
| `ask` (default) | read-only tools | refused; the turn ended with `tool_denied` | never asked |
| `plan` | read-only tools | refused; the turn ended with `tool_denied` | **identical to `ask`** — one shared branch in the filter and the hook |
| `accept-edits` | all | a card every time | the opposite of what the name means elsewhere |
| `auto` | all | approved | unchanged |

The model could still name a hidden tool: the registry gates by the grant, not by the
advertised list, so the confirm floor reached it and refused with a fixed string.

## The survey

Ten terminal and IDE coding agents, read from primary sources (official docs, source code, release
notes, issue trackers) in November 2026. Layouts were reconstructed from source and docs; none was
run. Two are closed-source and were read from documentation only. Where a fact could not be verified
it is not used here.

### Placement, size and content of the approval prompt

- **The conversation stays visible.** Nine of ten keep it on screen while they ask: the prompt is
  docked beside the input, inline in the transcript or a bottom panel. The tenth shows a centred
  modal and is the one whose users report that it hides the context needed to decide.
- **Height is bounded and adaptive.** Observed budgets run from a fixed 7–14 rows or about 38 % of the
  terminal, through "at most half or 80 %", to a 15-row cap with a full-screen toggle. A long body is
  cut with an explicit marker and a key to expand it; one product tests that the options and the
  cancel hint stay visible at 40×7.
- **The change is on the card, or one key away.** Products that showed only a path on the card, or lost
  the diff in an upgrade, drew complaints; products that open the diff first or keep the hunk beside
  the buttons did not. A multi-file change reviewed one file at a time was a repeated gap.
- **Risk sits next to the question.** Warnings directly above the options, a default focus that moves
  to *deny* on a flagged call, and exact-command defaults for dangerous commands. False positives
  are reported to train users to ignore the cue.
- **Keys.** Single-letter answers, number keys, and a visible key legend are common; click-to-answer
  caused accidental approvals in one product. Several guard the first keystroke (an input quiet period,
  or no key counts until the frame was shown).

### What "no", "escape" and "always" do

- **Three behaviours for a refusal.** *No* ends the turn; *no with a comment* continues; *escape*
  aborts and clears the queue. Products disagree, and users trip on it. The consistent winners
  separate "deny and continue, optionally with a reason" from "stop the turn", and say which is which.
- **"Always" is where the damage is.** Silent promotion of one answer to a mode flip, a durable rule that
  covers every edit in a project with no list or revoke, an exact-command key that makes every
  invocation prompt again, and a global "always approve" row that is pre-selected were each reported
  as a defect. Good designs name the scope in the label, narrow it with a key, persist outside the
  repository and keep file-edit grants session-only.
- **Queued input must never answer a card.** A queued message approving a command that needed approval
  is a reported bug class.

### How read-only and planning modes refuse

- **Hide the tools; answer a stray call with a message.** Read-only modes remove write tools from the
  model's list and answer a call that names one anyway with a message that says what is allowed and
  lets the turn continue. A mode that is called read-only but *prompts* was reported as a naming mismatch.
- **Shell is the hole.** A blacklist for shell in a plan mode is bypassable with an interpreter one-liner;
  products either say it is best-effort or restrict the tool.
- **Defaults prompt.** The default mode of nearly every product asks before a write or a command.

### Prompt fatigue (evidence reported by the survey, not independently re-verified)

One vendor states that users accept 93 % of manual prompts; another that a sandbox cut prompts by 84 %.
An interview-and-survey study (N = 107) reported that a third of developers had become less careful and
a fifth approved by default, with scrutiny concentrated on write/delete/escalation; the advice was to
show reversibility and to let a user reject one action without rejecting the whole approach. A second
study found that user-written rules cut prompts but also blocked fewer overreaching actions. No controlled
comparison of inline versus modal prompts was found.

## The turn that vanished

Structural session data (roles, counts, timestamps, token totals — no content) for the failing session:

- The failed turn was billed (590 387 input / 54 009 output tokens) but **none of its messages was
  stored**; the session's first stored message is the follow-up question. `rollbackPendingUser`
  removes the user message and every message of a turn that errors.
- The follow-up request therefore carried only the system prompt, the tool schemas and the question
  (2 261 input tokens). "No tool call was made in this conversation" was true of what the model could see.
- The turn died on a correction budget that had counted **four** failing rounds in a turn of about nine,
  each an unrelated slip. At least one was `read_file` with a line range ending past the file's last line
  (the host refused out-of-file ranges), and the footer said only "a tool call failed".

Hence ADR-0131 (consecutive no-progress rounds; clip a range's end; name the failed tools) and, separately,
ADR-0119, which keeps the turn in the session. ADR-0119 was revised after a twelve-finding design review and
Accepted the same day as its own increment (MVP-3c); it cannot be a live-only change, because the persister
maps message indices to durable sequence numbers.

## What was adopted, and what was not

| Pattern | Decision |
|---|---|
| Keep the conversation visible; dock the card | Adopted (ADR-0129 §1) |
| Size to the terminal; cut with exact counts; never drop the controls | Adopted (ADR-0129 §2) |
| One-word effect, then target; colour; line numbers | Adopted (ADR-0129 §3) |
| Risk lines only when they apply, above the keys | Adopted (ADR-0129 §3) |
| Deny-and-continue vs stop-the-turn, labelled | Adopted (ADR-0129 §5, ADR-0117) |
| `ask` prompts, read-only mode refuses with a message that returns | Adopted (ADR-0130) |
| Auto-accept of file edits as its own tier | Adopted as `accept-edits` (ADR-0130) |
| Hide governed tools when no one can answer | Adopted (ADR-0130 §4) |
| Narrow-the-scope key and an editable "always" pattern | **Not now** — worth doing with MVP-4's command card, where prefixes matter |
| Terminal bell / notification when a card waits unfocused | **Follow-up** |
| Side-by-side diff on wide terminals | **Follow-up** — the unified body composes with the same projection |
| Classifier or reviewer agent for auto-approval | **Not adopted** — a separate trust decision, not a presentation change |
| An input quiet period before the first key counts | **Not needed** — affirmative input already requires the exact acknowledged frame |
| Sandbox-first design to cut prompts | **Out of scope**; recorded as a direction for the command capability |

## Limits of this analysis

Layouts are reconstructed from source and documentation, not observed. Two products are closed-source.
Numbers quoted from vendors or studies are the sources' own and were not re-measured. The survey did not
test how any card behaves under adversarial Unicode, which Relavium's own tests do.
