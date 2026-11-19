# ADR-0130: Chat modes say what they do — `ask` asks, `plan` reads, `accept-edits` accepts

- **Status**: Accepted — 2026-11-16, by the maintainer (decisions taken after the approval-card and mode survey). The D64 round and the separate security sittings ran on 2026-11-17 (see notes 5–7 at the end and the [phase register](../roadmap/phases/phase-2.6-conversational-authoring.md#pr-99-independent-review-corrections-2026-11-17)); the maintainer's acceptance is owed.
- **Date**: 2026-11-16
- **Amends**: [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md) (the meaning of three of the four modes and of the default), [ADR-0116](0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md) (the wording "hidden in ask/plan, per-call diff approval in accept-edits"), and the D62 ruling's grant sentence.
- **Related**: [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md), [ADR-0118](0118-a-command-outside-the-allowlist-asks-instead-of-failing.md), [ADR-0120](0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md), [ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md)

## Context

The four modes shipped in 2.5.E have names that do not match what they do.

- **`ask` is not "ask".** It hides every write tool from the model and refuses any
  write that arrives anyway. Nothing is ever put in front of the person. A user
  who types "write a poem to merhaba.md" in the default mode gets a refusal and a
  turn that ends in a `tool_denied` error, and has to know to press Shift+Tab.
- **`plan` is `ask`.** Both modes share one branch in the advertise-filter and one
  in the approval hook. Only the one-line description differs.
- **`accept-edits` prompts on every write.** Everywhere else the term means the
  opposite: edits are accepted without a card.

A survey of ten terminal and IDE coding agents found that the default mode of
nearly all of them puts a previewed card in front of the person before a write or
a command. A separate read-only mode removes the write tools or refuses a call
with a message that names what is allowed, and the turn goes on. The one product
whose read-only preset still asked was reported as a naming mismatch by its
users. A mode that is called one thing and does another is the cheapest source of
distrust in a consent system.

## Decision

**Keep the four names and the Shift+Tab cycle. Change what `ask`, `plan` and
`accept-edits` do so each name is true.**

| Mode | The model is offered | A governed action (write, command, network, ambient OS) |
|---|---|---|
| `ask` (default) | every granted tool | **a card, every time** — `[y]` once · `[a]` always for this tool this session · `[n]` deny · `[c]` deny with a reason |
| `plan` | read-only tools only *(see the note below)* | **refused with a fixed message that returns to the model** (ADR-0117); nothing is asked, nothing changes |
| `accept-edits` | every granted tool | a **file edit inside the workspace is applied without a card**; every other class still gets a card |
| `auto` | every granted tool | approved for granted actions; unchanged |

### 1. `ask` is the default and the card is the control

`ask` is what `accept-edits` was. The approval cache, the "blank preview earns no
`always`" rule and the saved-result rule are unchanged. `DEFAULT_CHAT_MODE` and
`[chat].default_mode`'s default stay `ask`. The change is in what the word means.

### 2. `plan` is the read-only mode, and a refusal is a conversation

Write tools are hidden from the model, as `ask` hid them. A call that names one
anyway is refused with a **mode** refusal: a fixed text plus the mode's own label
(`plan mode is read-only`), never anything about the target. ADR-0117 returns it
to the model, so the model explains what it would do and the turn ends in an
answer instead of an error.

### 3. `accept-edits` accepts file edits, and nothing else

In `accept-edits` a governed action of class `fs_write` is approved without a
card. Three things still ask:

- an action of any other class (`process`, `egress`, `os`);
- a **protected path** — the same fallback prompt `auto` already has, never
  cacheable;
- a delivered **saved result** (ADR-0120's saved-result card), which is not a new
  edit and never earns a grant.

**A write is never silent.** The transcript row keeps the target and the diff
statistics, exactly as ADR-0120 requires for `auto`. The ordinary scope, jail,
metadata and protected-path floors apply before and after the mode decides; no
mode escapes them.

### 4. With nobody to ask, nothing is offered

A plain, `--json` or one-shot surface has no one who can press `[y]`. The
effective mode there stays `ask` — as ADR-0116 already states — but the governed
tools are **hidden from the model**, exactly as in `plan`, and a call that names
one anyway is refused with the **unavailable** text. The model never sees a tool
it cannot use, and no approval request is published that nothing could answer.

### 5. Wording that moves with the meanings

The default agent's system prompt, `/mode`'s descriptions, the `!`-shell deny
hint, the starting-mode hint, the chat contract's mode table and the denial
runbook say what the table above says. The persisted values and the schema
enumeration are unchanged: no migration, and no configured `default_mode` changes
spelling. A person who configured `default_mode = "ask"` expecting a read-only
start now starts in the prompting mode, which is the intended default; one who
wants the old behaviour configures `plan`.

## Alternatives considered

- **Rename the modes** (`read-only`, `prompt`, `edits`, `auto`). Rejected. The
  names are already in the footer, the cycle, the picker, the config, the docs and
  muscle memory, and a rename changes none of the behaviour the survey flagged.
  Making the existing words true is smaller and safer.
- **Keep `ask` read-only and add a fifth mode.** Rejected. It keeps the default
  that produces the dead end, and it adds a mode to the cycle.
- **Fold `plan` into `ask`.** Rejected. A read-only mode is a real need, and the
  planning flow that will give `plan` more to do (propose, approve, switch) has no
  other natural home.
- **Auto-approve edits everywhere, with undo.** Rejected for this milestone. It
  would remove the card from the default path; the project keeps a previewed
  consent for writes until an undo mechanism exists.

## Consequences

### Positive

- The default path works: the model tries a write, the person sees the diff and
  answers, and the turn goes on.
- Each mode name is true. `accept-edits` reaches the tier it always implied — edits
  go through, commands and the network still ask.
- `plan` stops being a duplicate and gains the refusal-returns-to-the-model
  behaviour that makes a read-only mode usable.
- A headless run no longer publishes approval requests it can never answer.

### Negative

- **The default now permits a write on a single keypress.** The card, its diff and
  the ADR-0120 inspection rules are therefore the control; ADR-0129 keeps them
  intact and puts them where the person can see the conversation they are
  deciding about. This is why the change carries a security sitting.
- `accept-edits` removes a card that existed. A prompt-injected write inside the
  workspace now lands without a card in that mode. The row, the scope and
  protected-path floors, the native-write proof and the effect journal remain; the
  cost of that tier is the person's choice to select it, and it is not the default.
- The D62 ruling's sentence and ADR-0116's wording describe the old table and are
  amended by this ADR; the starting-mode hint and tests that pin the old meanings
  change with it.

### Acceptance note — 2026-11-16

Accepted together with ADR-0117, ADR-0129 and ADR-0131 as one
increment (MVP-3b) ahead of MVP-4. ADR-0119 is a separate increment (MVP-3c). The implementation, two independent review rounds with
no blocker/high/medium finding (D64), and a separate security sitting on the
approval path are owed before the increment is accepted. The first two decisions
(the mode table and the `ask` default) were taken by the maintainer after the
survey recorded in
[the approval-card and mode analysis](../analysis/approval-card-and-chat-modes-2026-11-16.md).

> Amended 2026-11-16: [ADR-0132](0132-the-model-can-ask-the-user-a-structured-question.md) refines the `plan` row. `plan` hides the
> **governed** tools; `ask_user` is not governed, so a `plan` session on a surface with a person at it is also offered `ask_user`, and its
> card opens in every mode. Nothing else in this ADR changes.

## Amendments — 2026-11-17 (PR #99 review)

1. **A repository config layer cannot choose `accept-edits`.** §3 made it cardless for workspace file edits, which a cloned repository must not be able to select for the operator; see the amendment to [ADR-0116](0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md).
2. **§3's "a protected path still asks" is not reached for `write_file` or `edit_file`.** Prepare runs before the approval hook and refuses a protected path with the same predicate the hook uses (`isProtectedTarget`), so the person gets a denial with no card and no payload exposure (pinned for `auto` and `write_file` by the `session-host` protected-file end-to-end test; the same prepare-first order of the registry applies to every mode and to `edit_file`). The fallback prompt in `chat-mode.ts` is defensive code that is not reached; the `/mode` description says protected paths are refused.
3. **"Inside the workspace" in §3 means "inside a root the operator authorised".** The code approves any `fs_write` the fs scope admits, which includes a root granted with `--allow-fs-root`. Asking for a target outside the workspace is a possible hardening and is not done.
4. **§4's "no approval request is published that nothing could answer" means no governed tool is advertised to a one-shot `agent run`.** `agent run` now passes `interactive: false`, so the advertise filter applies. The `agent:approval_requested` trace event stays the audit record of every gated governed dispatch and is not suppressed.
5. **A `[a]` grant outlives a mode change and covers every call of that tool.** The cache is per tool id for the session: a call whose preview is blank, or whose target differs, is covered by a grant the person gave for that tool earlier, in any mode (an `[a]` given in `ask` also applies in `accept-edits` to a command or a request). §1's rule that a blank preview earns no `always` stops a blank call from **creating** a grant, not from using one. `/clear`, a `/models` reseat and a resumed session start with an empty cache.
6. **`buildTurnPolicy` fails closed by itself.** With no approver (`canAsk === false`) `accept-edits` and `auto` degrade to `ask` inside the function — the callers (`applyChatMode`, `createChatModeControl`) also coerce, but an exported function must not depend on that.
7. **Shift+Tab does nothing while a turn runs.** The engine takes the turn policy once, when a turn starts (ADR-0057's "consistent within the turn"), so a mode applied mid-turn cannot reach the running turn: the footer showed `ask` while that turn's later writes were still approved without a card. While a turn runs Shift+Tab now changes nothing and shows `Mode changes apply between turns — Esc stops the running turn.`; the choke point is `createChatModeControl.onModeChange`, which both the chat and the Home use. Esc remains the brake.
8. **The answer keys are Ctrl chords (2026-11-17).** The mode table's `[y]`, `[a]`, `[n]` and `[c]` are now `Ctrl+Y`, `Ctrl+G` (then Enter), `Ctrl+N` and `Ctrl+R`, because a letter typed while a turn runs is typing, not a decision; see [ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md) note 12. Nothing else about the modes changes.

9. **The command row (2026-11-19).** [ADR-0118](0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §1 adds `run_command` to the table: a card in `ask` and `accept-edits` for any command (the command card when it is not pre-approved), a fixed mode refusal in `plan`, and in `auto` only a pre-approved command runs without a card. Nothing else in this ADR changes.
