# ADR-0116: The built-in chat agent can edit, and the starting mode is configurable

- **Status**: Accepted
- **Date**: 2026-11-05 (proposal refined 2026-11-11)
- **Related**: [ADR-0024](0024-agent-first-entry-point-agentsession.md), [ADR-0029](0029-tool-policy-hardening.md), [ADR-0033](0033-strict-config-files-amends-0023.md), [ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0063](0063-cli-config-write-contract.md), [ADR-0105](0105-filesystem-roots-are-invocation-grants-not-project-authority.md), [ADR-0112](0112-chat-network-grants-and-onboarding-state-are-operator-owned.md), [D62](../roadmap/current.md#wave-gating-decisions), [MVP-A13, MVP-A14](../roadmap/phases/phase-2.6-conversational-authoring.md#cli-mvp-additions--2026-11-04)

> **Accepted 2026-11-11 (maintainer):** verify and correct the supplied design
> findings, accept this ADR, ADR-0120, their linked contracts and the three-step
> MVP-3 plan, then continue implementation. Backward-compatibility work is not
> required for this not-yet-used development product. Design acceptance does
> not claim implementation, a security sitting or release acceptance.
> Additional related decisions: [ADR-0059](0059-cli-mid-session-model-reseat.md),
> [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md),
> [ADR-0118](0118-a-command-outside-the-allowlist-asks-instead-of-failing.md),
> [ADR-0120](0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md),
> [security standard](../standards/security-review.md).

## Context

The built-in chat agent, which serves a session that binds no `--agent`, is
granted three read-only tools: `read_file`, `list_directory` and `git_status`.
To get a write or a command, the user has to author and bind an agent YAML. In
practice "fix this test" fails on the first try for every new user.

[ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md) already makes this
safe to change. The host is bound with full capability, and a mode is a policy
layer on top of it:

| Mode | Write tools offered to the model | A governed action |
| --- | --- | --- |
| `ask` (the default) | No | Denied |
| `plan` | No | Denied |
| `accept-edits` | Yes | Prompted on every call unless explicitly covered by `[a]` |
| `auto` | Yes | Approved, except a protected-path write, which still prompts |

The fail-closed `confirmAction` floor applies in every mode. Both the filesystem
jail and the protected paths hold in every mode, `auto` included.

So the grant is not what stands between the model and the disk. The mode is,
and the grant only decides what a mode can reach.

A user who starts every session in `ask` has to press Shift+Tab at the start of
every session before an edit is possible. The critic of the 2026-11-04 reset
called that out.

A configurable starting mode raises its own question: which configuration may
set it? Project and workspace config files arrive with a cloned repository. If
a repository could start its visitors' sessions in `auto`, then cloning it would
grant approval-free writes and commands. That is the same trust error
[ADR-0112](0112-chat-network-grants-and-onboarding-state-are-operator-owned.md)
avoided for the HTTP authority and D63 avoided for remembered commands.

## Decision

**We will widen the built-in agent's grant to editing and searching, keep
`ask` as the default mode, and let the operator choose a different starting
mode. A repository's config may choose a prompting or read-only start but never `auto`.**

### 1. The default grant

The built-in agent is granted:

- **Read, search and find.** `read_file`, `list_directory`, `git_status`, and
  the MVP-3 tools `search_files` and `find_files`. None of them is governed; all
  stay inside the jail and the confidentiality floor.
- **Edit.** `write_file` and `edit_file`. Both are governed `fsWrite` tools:
  - Hidden from the model in `ask` and `plan`, and denied there by the floor if
    the model names them anyway.
  - In `accept-edits`, every call is prompted with its diff unless covered by
    an explicit `[a]` grant, rendered through the approval-preview contract that
    phase 2.6 ADR row 9 defines.
  - The existing approval scopes are unchanged. `[a]` (always, this tool, this
    session instance) remains the user's explicit choice.
- **Commands (MVP-4 / D63, outside MVP-3).** `run_command`, governed by the approval card D63's ADR
  defines. It joins the grant only when that card lands, so the default agent
  never runs a command under today's allowlist-only rule.
- **Not granted.** Egress (`http_request`, `web_search`, MCP tools) and the
  `os` arm. They stay opt-in through an explicitly bound agent and the
  operator-owned authorities that already govern them.

The grant lands only after the approval diff (MVP-3's `write_file` diff, #305).
The model is never offered a write the user cannot review.

The built-in agent's system prompt stops claiming that it cannot modify files.
It instead says that writes need the user's approval and depend on the mode.

### 2. The starting mode

- A session starts in the configured **default mode**. Absent any
  configuration, that is `ask`, as today.
- **Which config may set which mode:**
  - Project and workspace config may set `[chat].default_mode` to `ask`, `plan`
    or `accept-edits`. These deny or prompt for governed actions unless the
    operator explicitly chooses an `[a]` grant in `accept-edits`.
  - A project or workspace layer naming `auto` is a strict-config error
    ([ADR-0033](0033-strict-config-files-amends-0023.md)), reported with the
    file and the key. It is never silently downgraded.
  - Starting in `auto` is an operator choice. Only the operator-owned global
    configuration can set it, under the rules ADR-0112 set for
    operator-owned settings.
- **The starting mode is visible.** It shows in the footer from the first frame,
  as every mode does.
- **A one-time hint** tells a user who starts in `ask` that Shift+Tab changes
  the mode and that the default is configurable. It is shown once per operator.
  Whether it has been shown is recorded in the operator-owned onboarding state
  (ADR-0112), never in project files.
- **Resume, `/clear` and reseat** start in the configured default mode, read
  when the session starts. A mode is never persisted with a session. This
  keeps ADR-0057's rule that approvals and modes do not survive the session
  instance.

The exact keys, layers, error texts and hint wording live in
[config-spec.md](../reference/contracts/config-spec.md) and
[chat-session.md](../reference/cli/chat-session.md).

### 3. What does not change

- Advertising stays best-effort and `confirmAction` stays authoritative.
- The protected-path and jail floors hold in every mode, and the headless
  paths have no approver, so they stay fail-closed.
- An explicitly bound `--agent` keeps exactly the grant its YAML declares.
- `agent run` and the other non-interactive paths keep running in `ask`.

### Proposal review — 2026-11-11

These refinements were initially Proposed at the documentation/code preflight.
The acceptance receipt above includes the corrected final contract below.

- **Config authority.** The global setting belongs in the existing operator
  preferences table. Project-over-workspace-over-global precedence applies;
  allowing a project to select `accept-edits` means it may request prompting,
  even over a global read-only preference. It cannot select `auto`. Validate
  every supplied layer, including a shadowed repository `auto` value. Exact
  keys, diagnostics and authority/publication outcomes belong in the
  [proposed config contract](../reference/contracts/config-spec.md#proposed-starting-chat-mode--mvp-3).
- **An invocation ceiling.** An operator-selected `--config` can itself be
  workspace-local and model-writable (ADR-0112). Admit startup `auto` authority
  before any model/tool work. It is a revocable live authority shared by old,
  pending and replacement hosts, not an irrevocable startup boolean. Observing
  a narrower effective configured start or a config read/validation failure
  revokes startup-auto authority before replacement work, including failed or
  stale builds. Confirming a non-auto saved default revokes it immediately,
  even if persistence later fails; cancellation before confirmation does not.
  A later `auto` file value cannot restore revoked authority. Re-admission needs
  a new invocation or a deliberate trusted default-auto action. Keep this authority out
  of session snapshots, model inputs and persisted approval caches. A malformed
  or newly unauthorized setting refuses the replacement visibly; no fallback to
  a captured, more permissive startup mode. Failed/stale builds cannot publish
  a mode or widen authority.
  A host using configured `auto` checks its live admission at each dispatch's
  final gate; revocation prevents new effects through retained old hosts. An
  already-dispatched effect cannot be recalled. Explicit current-session
  `/mode auto` or Shift+Tab is a separate operator choice, neither restoring
  startup authority nor being silently revoked by a default-setting change.
- **An in-TUI default setting.** Home and both interactive chat hosts share a
  mode picker. Changing the current mode and saving a global default are
  separate, explicit actions; selecting or opening a picker saves nothing.
  Repository overrides and a save that will not change the effective start
  are shown. Existing direct `/mode <name>` and Shift+Tab retain their current
  per-turn semantics. Saving uses the typed preference writer, its existing-file
  rewrite disclosure and truthful publication/durability outcomes. The one-time
  hint is acknowledged only after visible delivery, never by background build.
- **Frozen grants stay frozen.** Resume, model reseat and `/clear` preserve the
  bound agent snapshot, including an older built-in agent's read-only grant.
  A newly started built-in session gets the new grant; matching an agent id is
  never proof that it is the built-in agent. Correct Home `/clear` to honor
  ADR-0062's existing same-agent rule, as standalone clear already does. A new
  session instance resets approval and read-evidence state.
- **Headless and protected paths.** Non-interactive/JSON chat and `agent run`
  are initialized and enforced as `ask`, regardless of preferences. The
  protected-path prompt described above is only a UX fallback: even a positive
  answer cannot override the host's hard filesystem denial. The exact
  host-issued scratch exception from ADR-0105 stays unchanged.

The [MVP-3 plan](../roadmap/phases/phase-2.6-conversational-authoring.md#mvp-3-plan--editing-search-and-reviewable-effects-2026-11-11)
owns implementation steps and acceptance. The
[chat contract](../reference/cli/chat-session.md#proposed-mvp-3-interaction-contract)
owns picker/reset behavior. Acceptance adds dated forward notes to the related
Accepted ADRs; this proposal does not silently rewrite their decisions.

### Alternatives considered

- **A second built-in "coding" agent, leaving the default read-only** (D62
  option 2). Rejected. It adds a choice before the first useful turn and
  duplicates ADR-0057's mode layer, which already separates "can reach" from
  "may do".
- **Keep the default read-only until the `/agents` picker lands** (D62 option
  3). Rejected. It pushes the most common first request past the MVP.
- **Let any config layer set any default mode.** Rejected. A cloned repository
  could then start sessions in `auto`.
- **Persist the last-used mode per project.** Rejected. A mode chosen once would
  silently become every future session's starting authority. An explicit
  setting is visible and reviewable.

## Consequences

### Positive

- "Fix this test" works in the first session: Shift+Tab to `accept-edits`, then
  review each diff. A user who wants that every time sets it once.
- A repository can request a prompting start and thereby advertise write tools,
  even over a global read-only preference. It cannot select startup `auto`,
  supply the operator's approval or override filesystem/confidentiality floors.
- Every edit the default agent makes is reviewed as a diff unless the user
  explicitly chose `[a]` or `auto`.

### Negative

- The default agent's reach grows. A prompt-injected model in `accept-edits` can
  now *propose* writes and commands, so the user's diff review becomes a
  security control. The pre-build security design sitting shared with ADR-0120
  confirms auto revocation, the live preview channel and inspectability before
  the card is built. A separate implementation security sitting tests
  that review surface: diff truncation, terminal-safe rendering, and paths
  that are not what they appear to be.
- A project that sets `auto` now fails its strict config check. Any existing
  file doing so needs the operator to move the setting.
- Some users will set `auto` globally and get approval-free sessions in every
  project. That is an explicit operator choice, visible in the footer, and the
  protected-path prompt still holds.

> Implementation checkpoint 2026-11-12: the MVP-3 built-in filesystem grant, startup-mode authority and shared current/default settings are independently accepted on `development`. The [Step 3 record](../roadmap/phases/phase-2.6-conversational-authoring.md#mvp-3-step-3-acceptance-2026-11-12) binds final source, verified review corrections and separate security evidence. Command execution remains the planned MVP-4 slice; combined checkpoint PR CI and maintainer review govern merge.
