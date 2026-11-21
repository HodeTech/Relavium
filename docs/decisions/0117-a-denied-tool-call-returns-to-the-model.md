# ADR-0117: A denied tool call returns to the model

- **Status**: Accepted — 2026-11-16, by the maintainer, together with ADR-0129, ADR-0130 and ADR-0131 (see the implementation note at the end).
- **Date**: 2026-11-05
- **Related**: [ADR-0029](0029-tool-policy-hardening.md), [ADR-0037](0037-engine-tool-execution-boundary.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0086](0086-absolute-admission-ceilings-on-authored-values.md), [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md), [ADR-0105](0105-filesystem-roots-are-invocation-grants-not-project-authority.md), [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md), [D67](../roadmap/current.md#wave-gating-decisions), [MVP-A10](../roadmap/phases/phase-2.6-conversational-authoring.md#cli-mvp-additions--2026-11-04)

## Context

[ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md) made a user's denial
of a tool call a typed `ToolDeniedByUserError` with the non-retryable
`tool_denied` code. "A user deny is final": the engine never retries the call.
The turn loop also treats every denial as **fatal to the turn**, so the turn
ends with `tool_denied`.

That covers:

- the user answering `[n]` or giving a typed reason;
- a mode denial (a write named in `ask`);
- a protected-path, jail or allowlist refusal.

The model never learns that the user said no. Nor does it learn why, even when
the user typed the reason, so it cannot propose another approach. The user has
to restate the request in a new turn.

The turn loop already has a bounded feedback path for correctable failures.
`unknown_tool` and `invalid_args` are fed back to the model as an `isError`
tool result. So is a recoverable host failure on the interactive surfaces
(`recoverToolFailures`). All of them draw on one `maxToolCorrections` budget
inside the `maxToolTurns` egress ceiling.

Denials were deliberately kept out of that path, and the turn loop's comment
gives the reason. Re-issuing a denied call only gets denied again. And a denial
whose text depends on the target's state would give the model a **probe
oracle**. For example, if "blocked: resolves to a private address" is fed back,
a prompt-injected model can map which hostnames resolve internally.

On 2026-11-04 the maintainer ruled (D67) that denials return to the model. This
ADR draws the line that keeps the oracle argument intact.

## Decision

**On the interactive surfaces, a denial that was decided from the call and the
session's own policy returns to the model as a fixed-text `isError` tool result.
The turn continues within the existing correction budget. Any denial that
depends on the target's state stays fatal.**

### 1. Which denials return

**Returned to the model:**

- **A user rejection.** This covers `[n]`, a rejection with a typed reason (the
  reason is the user's own words, bounded as today), and a rejection the
  user's Ctrl-C makes (ADR-0115). The Ctrl-C case also interrupts the turn, so
  the result is recorded but no further model call follows.
- **A denial decided before any side effect from the call's arguments and the
  session's policy alone:**
  - a mode denial;
  - a protected-path refusal;
  - a jail or scope-tier escape (already fed back as recoverable today);
  - a command outside the allowlist or the approval card's grants;
  - a headless "no approver" denial.

**Still fatal to the turn, as today:**

- An SSRF refusal made after name resolution.
- A confidentiality refusal whose outcome or wording could depend on whether
  the target exists.
- A process or egress failure after the side effect began.
- `tool_unavailable`.
- A cancellation. An abort is not a denial; it ends the turn as ADR-0057 and
  ADR-0115 define.

**The test for any future denial class:** it returns to the model only if its
result text is the **same for every target state**. A class that cannot meet
that stays fatal.

### 2. What the model sees

The tool result carries:

- a **fixed text per denial class**, for example "The user denied this call" or
  "Writes are not available in the current mode";
- the user's typed reason, when there is one.

It carries **no** policy contents: not the allowlist, not the configured roots,
not the protected-path list. Every text is the same whether or not the target
exists.

The exact texts live in [built-in-tools.md](../reference/shared-core/built-in-tools.md),
next to the tool contracts. This ADR does not restate them.

### 3. "A user deny is final" keeps its meaning

`tool_denied` stays non-retryable. The engine never re-executes a denied call.

Within the turn, a **repeat of an invocation the user already denied** (same
tool, same arguments) is denied again **without prompting**, with the same
fixed text. The model can propose something different, but it cannot wear the
user down by asking again.

Each returned denial draws on the `maxToolCorrections` budget, so a model that
keeps calling denied tools ends the turn as it does for any other correction
loop. The ceilings stay finite and configurable under ADR-0086.

### 4. Scope

Only the surfaces that already set `recoverToolFailures` are in scope: `relavium
chat`, the in-Home chat and the one-shot `agent run`.

A workflow agent node keeps failing fast on a denial. A workflow is an
unattended, committed artifact, so a denial there is a fault its author has to
see, not something the model should route around.

Across turns, a returned denial is remembered as any tool result is, under
[ADR-0095](0095-what-an-agent-session-remembers-across-turns.md)'s
structure-only rule. Its text is fixed, so it carries no target content.

### Alternatives considered

- **Feed back every denial, including SSRF and confidentiality refusals.**
  Rejected. This reopens the probe oracle the current rule exists to close.
- **Keep every denial fatal** (D67 option 3). Rejected. The user has to repeat
  themselves, and the user's own stated reason is thrown away.
- **Re-prompt the user on a repeated identical call.** Rejected. It turns a
  denial into a negotiation. The user already answered.

## Consequences

### Positive

- A denial becomes a conversational turn ("not that file — use the fixture
  instead") instead of a dead end. The user's typed reason finally reaches the
  model.
- The probe-oracle boundary is now a stated, testable rule: same text for every
  target state.
- The correction budget and the turn ceilings still bound the cost.

### Negative

- A model can now spend tool rounds on denied calls before giving up. That
  costs tokens within the existing budget. MVP-A11's conservative defaults keep
  the cost small.
- Each denial class has to be classified and its fixed text kept free of
  state. A new tool or a new floor needs that classification before it ships.
- The interactive and workflow paths now differ on denials, as they already
  differ on recoverable host failures.

### Implementation note — 2026-11-16

Implemented with the approval-card and mode increment
([ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md),
[ADR-0130](0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md),
[ADR-0131](0131-a-round-that-made-progress-resets-the-correction-budget.md)).

**Returned to the model now:** a user rejection (with the user's typed words), a
**mode** refusal (`plan`, with the mode's fixed label) and the headless
**unavailable** refusal. Each has one fixed text (see
[built-in-tools.md](../reference/shared-core/built-in-tools.md#refusals-that-return-to-the-model));
a repeat of an invocation the user declined in the same turn is refused without
asking again; every returned refusal draws on the correction budget, which ADR-0131
now counts as consecutive rounds in which nothing ran.

**Still fatal, by design:** a refusal that arrives after an effect was admitted or
for a saved-result delivery (the model must not retry a call whose effect identity
is already held), a revoked starting-`auto` authority (a consent boundary, not a
conversation), and the wiring faults `no_approval_hook` / `approval_error`.

**Not yet returned:** a protected-path refusal and a command outside the allowlist.
The protected-path predicate also covers credential stores, which the rule above
keeps fatal because their wording could depend on the target; separating the two
classes and designing the allowlist-miss text belong with MVP-4's `run_command`
card ([ADR-0118](0118-a-command-outside-the-allowlist-asks-instead-of-failing.md)).


> Amended 2026-11-19 (the lexical protected-path arm and the configurable limits are implemented in MVP-4 step 1; the command card is decided, implementation owed, steps 3 and 4) by [ADR-0118](0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) and [ADR-0136](0136-a-turn-asks-to-continue-at-a-checkpoint-instead-of-dying-at-a-ceiling.md): §1's "a command outside the allowlist" is realized as a command card, or as the fixed mode or *unavailable* refusal, never as a denial class that names the allowlist; the protected-path refusal that returns is the lexical directory and rc-file arm only (credential-store and post-resolution refusals stay fatal); and §3's ceilings are configurable within published bounds.

> Implemented 2026-11-19 (MVP-4 steps 3 and 4): a command outside the allowlist is a command card (or the fixed mode or *unavailable* refusal) and the `!` escape's allowlist hint is retired. The protected-path/credential-store split of §1 stays open in [deferred-tasks.md](../roadmap/deferred-tasks.md). See [ADR-0118's implementation notes](0118-a-command-outside-the-allowlist-asks-instead-of-failing.md#implementation-note--2026-11-19-mvp-4-step-4).

> Amended 2026-11-21 (the PR #101 review): the split of §1 that this note called open **is implemented** since MVP-4 step 1 (the implementation note below): the lexical arm of the protected-path refusal (`isProtectedLexicalPath`: `.git`, `.relavium`, `.ssh`, the host's stage directory, shell startup and git configuration files, and since PR #101 the XDG `~/.config/git/` directory) returns to the model with the fixed `PROTECTED_PATH_REFUSAL`, and the credential-store arm and every refusal that only resolution reveals stay fatal. The register entry is closed ([deferred-tasks.md](../roadmap/deferred-tasks.md)).

### Implementation note — 2026-11-19 (MVP-4 step 1)

The protected-path refusal now returns to the model for its **lexical arm** only (the maintainer's decision Q4, recorded in the phase document's MVP-4 preparation table): a write whose path *text* names a protected directory (`.git`, `.relavium`, `.ssh`, the host's stage directory) or a shell startup or config file. It is decided before any filesystem resolution, and the host's scratch subtree is not even inspected on that path, so the text is the same for every target state (§1's test). One fixed text, `PROTECTED_PATH_REFUSAL`, names neither the list nor the target. The credential-store arm (`.env`, `.npmrc`, `.aws`, `.docker/config.json`, credential dotfiles) and any refusal only resolution reveals (a link into a protected directory) stay fatal. `.ssh`, `.relavium` and `.gitconfig` belong to both predicates; the lexical check runs first, so a write to them returns, and that is consistent with the rule because both predicates read the path text alone. A returned refusal gives a model repeated attempts within the correction budget; each is the same refusal and teaches nothing a prior one did not, and a spelling variant that only resolution catches is still fatal — recorded as an accepted residual.

The "Not yet returned" paragraph above is superseded for the protected-path class; the allowlist miss is realized as ADR-0118 describes (a card or a fixed refusal, never a class of its own).
