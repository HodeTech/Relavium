# ADR-0118: A command outside the allowlist asks instead of failing

- **Status**: Proposed
- **Date**: 2026-11-05
- **Related**: [ADR-0029](0029-tool-policy-hardening.md) (a), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md), [ADR-0063](0063-cli-config-write-contract.md), [ADR-0112](0112-chat-network-grants-and-onboarding-state-are-operator-owned.md), [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md), [ADR-0116](0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md), [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md), [D63](../roadmap/current.md#wave-gating-decisions), [MVP-A15](../roadmap/phases/phase-2.6-conversational-authoring.md#cli-mvp-additions--2026-11-04)

## Context

In a chat session, `run_command`, both the model's tool and the user's `!`
escape, passes two gates in order:

1. **The allowlist.** `enforcePolicy` checks the `[chat]` allowlist: exact
   full-command strings ([ADR-0029](0029-tool-policy-hardening.md) (a)) plus
   opt-in globs.
2. **The mode.** If the allowlist admits the command, the mode-aware
   `confirmAction` applies (ADR-0057): denied in `ask` and `plan`, prompted in
   `accept-edits`, approved in `auto`.

The allowlist defaults to empty, which disables commands. That is a sound
floor, and `run_command` has no argument confidentiality floor, so `!cat .env`
shows why. In practice it is a wall:

- A command the user did not list in advance cannot run at all, even with the
  user watching and willing to approve it.
- The refusal hint asks the user to edit a config file and restart.
- [ADR-0116](0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md)
  gives the built-in agent `run_command` "under D63", so this has to change
  before that grant can mean anything.

The allowlist lives in project and workspace config. Those files arrive with a
repository, so anything persisted there authorizes every future clone. The
critic of the 2026-11-04 reset flagged exactly this risk for a "remember this
command" choice. A repository's allowlist can already pre-approve commands for
`auto` today; this ADR records that exposure without widening it.

## Decision

**A command that is not pre-approved shows a typed approval card instead of
being refused. "Remember" is stored in operator-owned configuration keyed by the
project root, never in repository files. `auto` never runs a command that is
not pre-approved.**

### 1. Pre-approval and the card

**A command is pre-approved** when either of these holds:

- it matches the effective `[chat]` allowlist, exactly or by glob, with today's
  layering;
- it matches a **remembered grant** for the current project root (§2).

**Outcomes by mode:**

| | `ask` / `plan` | `accept-edits` | `auto` |
| --- | --- | --- | --- |
| Pre-approved | Denied | Prompted with a plain approval | Runs |
| Approved earlier in this session (§1, "Session") | Denied | Runs | Runs |
| Anything else | Denied | **Card** | **Card** |

**The card shows the command exactly.** It shows:

- the argv, one argument per element, so spaces and quotes are unambiguous;
- the working directory;
- why the command is not pre-approved.

Everything is terminal-safe text. The card never offers an approving answer for
a command it does not show in full. A command too long for the screen must be
expanded before it can be approved.

**The card's answers:**

- **Once.** This invocation only.
- **Session.** This exact command string for the rest of this session
  instance. It is held in memory and not persisted, like ADR-0057's `[a]`.
- **Remember.** Persist an exact-string grant for this project root (§2).
- **Deny**, with an optional typed reason. A denial returns to the model under
  [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md).
- **Ctrl-C and Esc** reject the card, then interrupt the turn, as
  [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md) defines.

Only unmodified keys answer the card, as with every approval (ADR-0057).

**`accept-edits` keeps prompting for pre-approved commands.** A config
allowlist or a remembered grant removes the *card*, not the user's per-call
consent. Only an explicit "Session" answer, given in this session, removes the
prompt there. This keeps a repository's allowlist from turning `accept-edits`
into silent execution.

**The `!` escape uses the same card and the same table.** The user typed the
command, but a typo or a pasted line runs with the same authority. The card is
cheap, and one rule for both paths is easier to reason about than two.

**Headless paths stay fail-closed.** `agent run`, plain, `--json` and every
path without an approver cannot show a card, so a command that is not
pre-approved is denied. That denial returns to the model under ADR-0117.

### 2. Remembered grants are operator-owned

- **Where they are stored.** A remembered grant goes into the operator-owned
  global configuration (the trust class
  [ADR-0112](0112-chat-network-grants-and-onboarding-state-are-operator-owned.md)
  set). It is keyed by the session's **canonical project root**: the resolved
  real path, so two paths to one tree share grants and a fresh clone elsewhere
  shares none.
- **How they are written.** Through the
  [ADR-0063](0063-cli-config-write-contract.md) write primitive: parse, set,
  re-validate, write atomically. It is secret-incapable by construction. No
  project, workspace or agent file is ever written.
- **What a grant contains.** Only an exact command string, never a glob. "Remember
  `npm test`" never authorizes `npm test -- --exec=…`.
- **Bounds.** Grants are bounded per root and in total. Reading them is strict:
  a malformed grant file is a visible configuration error, never a silent
  allow.
- **How grants are revoked.** By editing the operator config. The 2.6.G
  permission-management view lists and removes them; its UI belongs to that
  workstream.

The exact keys, bounds and file layout live in
[config-spec.md](../reference/contracts/config-spec.md). The card's rendering
contract lives with the approval-preview contract (phase 2.6 ADR row 9).

### 3. What this amends

- **ADR-0061.** The `!` escape's "allowlist before approval, refused otherwise"
  becomes §1's table. Hardened spawn (`shell: false`, literal argv), the
  command jail and the busy and abort affordances are unchanged.
- **ADR-0029 (a).** Unchanged in substance. Allowlist entries and remembered
  grants match exact strings, and globs stay opt-in and config-authored.
- **ADR-0063.** Gains a second operator-owned write target: remembered command
  grants.
- **Workflow `run_command`.** Unchanged. A workflow's allowlist stays the only
  authority there, with no card and no remembered grants. A workflow runs
  unattended.

Each amended ADR gets a dated amendment note pointing here when this is
accepted.

### Alternatives considered

- **Keep the allowlist wall and add an `/allow <command>` writer** (D63 option
  2). Rejected. The user still cannot approve a command in the moment, and the
  natural place for such a writer is the repository file this ADR must avoid.
- **Store "remember" in the project's `[chat]` allowlist.** Rejected. Every clone
  would inherit the grant: one user's consent would become every visitor's
  authority.
- **Let `auto` approve any command.** Rejected. `run_command` has no argument
  confidentiality floor, so an approval-free arbitrary command is an
  approval-free exfiltration path for a prompt-injected model.
- **Keep the card out of `!`.** Rejected. Two command paths with different
  consent rules are harder to reason about. The cost of one card is small.

## Consequences

### Positive

- A command the user is willing to run can run, with the exact argv on screen.
  The config edit and restart are no longer needed.
- A remembered grant serves one operator on one tree and never travels with the
  repository.
- `auto` keeps a hard edge: only pre-approved commands run without a prompt.
- A headless path still never runs anything it was not configured to run.

### Negative

- More approval prompts in `accept-edits`, by design. A user who trusts a
  command for the session answers "Session" once.
- A repository's own allowlist still pre-approves commands for `auto`, as it
  does today. This ADR does not widen that, but it does not remove it either.
  The security sitting has to examine it, and closing it would be a separate
  decision.
- Operator config gains a growing, per-root grant list. It needs bounds, strict
  parsing and a revocation view (2.6.G).
- The card is a new approval surface. It needs the approval-path security
  sitting D63 requires: exact rendering, no hidden affirmative key, and no
  truncated approval.
