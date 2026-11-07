# ADR-0117: A denied tool call returns to the model

- **Status**: Proposed
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
