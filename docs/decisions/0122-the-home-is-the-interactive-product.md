# ADR-0122: The Home is the interactive product; subcommands are the scripting surface

- **Status**: Accepted
- **Date**: 2026-11-08
- **Related**: [ADR-0007](0007-desktop-is-not-an-ide.md), [ADR-0024](0024-agent-first-entry-point-agentsession.md), [ADR-0026](0026-session-export-to-workflow.md), [ADR-0049](0049-cli-machine-output-contract.md), [ADR-0054](0054-cli-bare-invocation-interactive-home.md), [ADR-0056](0056-cli-in-app-slash-command-system-and-manifest.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md), [ADR-0110](0110-cli-diagnostics-and-discovery-have-explicit-compatibility.md), [ADR-0112](0112-chat-network-grants-and-onboarding-state-are-operator-owned.md), [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md), [home.md](../reference/cli/home.md), [commands.md](../reference/cli/commands.md), [accessibility.md](../reference/cli/accessibility.md), [D73](../roadmap/current.md#wave-gating-decisions), [UX benchmark](../analysis/cli-ux-benchmark-2026-11-08.md)

> **Accepted 2026-11-08.** The direction is the maintainer's ruling of 2026-11-08 (D73). The rules in the Decision
> section were settled the same day under the maintainer's delegation, from the
> [terminal agent CLI UX benchmark](../analysis/cli-ux-benchmark-2026-11-08.md) and a map of the Home's current reach.

## Context

The maintainer set the product direction on 2026-11-08: a user cannot be expected to memorise `relavium agent run`,
`relavium status`, `relavium chat` or `chat resume`. The user types `relavium` in any shell (bash, zsh, PowerShell)
and lands in the full-screen TUI, and does everything they need there, through slash commands or other in-TUI
affordances. The goal is a first-class app that is comfortable, fast, safe and efficient.

Phase 2.6 already states this goal. Its Definition of Done says "everything is manageable from the Home … no routine
task requires a shell subcommand; subcommands stay first-class for scripting/CI and are never removed", and exit
criterion 2 repeats it. The code and two Accepted ADRs still say otherwise:

- **ADR-0056's 2026-06-29 amendment** keeps `run`, `chat`, `provider`, `create`, `import` and `export` "shell-only
  (`relavium <cmd> …`); they are never run from inside a chat". [commands.md](../reference/cli/commands.md#in-repl-slash-commands)
  repeats it.
- **ADR-0054** describes the Home's strip as a "read-only display".
- **Reach today.** Of the CLI's 25 leaf subcommands, three are fully reachable from the Home (a chat with the default
  agent, `models`, `models refresh`), eight partly, and fourteen not at all (the
  [reach table](../analysis/cli-ux-benchmark-2026-11-08.md#appendix--relaviums-home-reach-on-2026-11-08)). No strip row can be opened. The Home's
  palette offers four commands. Several in-TUI messages tell the user to leave and run a shell command.

The benchmark of eleven current terminal agents (Claude Code, Codex CLI, opencode, Crush, Gemini CLI, Antigravity CLI,
Grok Build, Copilot CLI, Kimi, Kiro, Cline) shows the field converging on the same model:

- The bare command opens the interactive app.
- Management tasks have in-app forms: sessions, models, credentials, MCP, settings, init.
- Subcommands remain for scripts.

Several of them also have a landing screen: Grok Build, opencode, Crush, Copilot CLI and Cline. The benchmark
also records what full-screen costs. Codex, Claude Code and Copilot CLI all drew sustained complaints about lost
scrollback, copy and search after making it the default. Those products had to rebuild these affordances inside the
app.

## Decision

**A bare `relavium` on an interactive terminal opens the Home, and the Home is the interactive product. Every
routine task has an in-TUI form there. Subcommands remain the first-class scripting and CI surface, with their
contracts unchanged.**

### 1. Every routine task gets an in-TUI form

- A routine task is anything a user does repeatedly. Examples: start or resume a chat, connect a provider, pick a
  model, initialise a project, find a past session, run a workflow and watch it, answer a gate, read a run's status
  or logs, manage MCP servers.
- The in-TUI form is a slash command, an action on a Home row, a picker or a card.
- Each routine task's target milestone is in [current.md](../roadmap/current.md#next-work--the-cli-mvp). This ADR
  sets the rule, not the schedule. Tasks with no milestone yet (`import`, `models pricing`) are marked as such in the
  benchmark's reach table, and planning the hub milestone gives them one.
- Two kinds of command stay shell-only by design:
  - one-shot scripting commands built around a pipe: `agent run`, which reads its prompt from stdin, and every
    `--json` surface;
  - one-shot maintenance commands: `media prune-temporaries`.

### 2. One core, two surfaces

- An in-TUI form **re-hosts the same core** that the subcommand calls. It never spawns `relavium <cmd>` as a child,
  and it never re-implements the flow. Today's cores are `runOnboardingWizard`, the provider command core and the
  resume builders.
- **What stays byte-identical.** For every invocation a subcommand accepts today, its machine surface does not
  change: `--json` and plain stdout, its non-TTY behaviour and its exit codes
  ([ADR-0049](0049-cli-machine-output-contract.md)).
- **What may change.** A subcommand's grammar or its interactive TTY behaviour changes only under
  [ADR-0110](0110-cli-diagnostics-and-discovery-have-explicit-compatibility.md)'s compatibility rules. The milestone
  that changes it lists each change with its TTY, non-TTY and `--json` behaviour. For MVP-2 that list is the
  [MVP-2 plan](../roadmap/phases/phase-2.6-conversational-authoring.md#mvp-2-plan--home-first-2026-11-08)'s
  contract-change table.

### 3. ADR-0056's shell-only clause is replaced

- ADR-0056's 2026-06-29 amendment ruled that the session-starting shell commands "are never run from inside a chat".
  That clause is replaced by §2: the task is re-hosted in-TUI, and the subcommand is never invoked.
- The amendment's two-registry structure stays: `COMMAND_MANIFEST` for the shell and `REPL_COMMANDS` for slash
  commands.
- The registry rule changes. A slash command may now serve the same task as a shell command, as long as both call
  one core.
- The slash set stays alias-free, as ADR-0056 decided. A command is found by the words in its description, which
  the palette already matches.

### 4. The Home's rows become actionable

- ADR-0054's "read-only display" becomes "a keyboard-first, actionable display". A row can be focused and opened:
  resume a session; later, open a run or answer a gate.
- The strip still never mutates anything on its own. Every effect goes through the same consent and approval paths
  as its subcommand.
- The [ADR-0007](0007-desktop-is-not-an-ide.md) analogy still holds: no file tree, no editor, no embedded terminal.
  A path prompt is not a file browser.

### 5. Interactive shell entries reuse the Home's screens

An interactive subcommand on a TTY reuses the Home's screen components instead of building its own. It either opens
the Home at the matching screen, or runs the same component on its own before its host mounts. For example,
`relavium chat resume` without an id shows the session picker before the chat host mounts. Non-TTY, `--json` and CI
invocations never open the Home or these screens ([ADR-0054](0054-cli-bare-invocation-interactive-home.md)'s gate is
unchanged).

Whether the standalone interactive `relavium chat` host should itself become an entry into the Home tree is not
decided here. It is a later consolidation, decided by measuring the cost of maintaining two hosts.

### 6. In-TUI messages name in-TUI actions

- A remedy shown inside the TUI names the in-TUI action, such as `/providers` or `/resume`.
- Plain, `--json` and shell output keep naming the subcommand.
- Each milestone that adds an in-TUI form updates the messages pointing at its task.

### 7. What every new screen must satisfy

A new in-TUI screen or card is accepted only if all of the following hold:

1. **Inline parity.** It works in the inline renderer (`--no-alt-screen`), the screen-reader-friendly mode in
   [accessibility.md](../reference/cli/accessibility.md). Otherwise "no routine task needs the shell" is false for
   those users.
2. **Colour off.** It reads correctly with colour disabled. Every state that colour shows also has a glyph or a word.
3. **Small terminals.** It works at the 80×24 minimum.
4. **Overlay keys.**
   - Ctrl-C and Esc close a non-approval overlay, as overlays do today.
   - Neither key confirms or approves anything, and a confirmation card treats both as cancel.
   - These rules apply now. The full interrupt keymap ([ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md),
     Proposed, implemented in MVP-4) extends them, and a screen built before it lands adopts it then.
5. **Sanitized text.** Every untrusted string it shows (titles, paths, model text, branch names) passes the
   existing sanitize floor.
6. **Bounded work.** Lists page, and caches and repaint windows have limits.
7. **Secret-safe.** A screen that takes a secret keeps it out of React state, input history, the transcript, the
   copy hatches and error text.

### 8. Full-screen ships with its compensations

The full-screen renderer stays the default and the inline renderer stays first-class. A feature that depends on
full-screen ships together with:

- a way to scroll, search and copy the content it shows;
- a mouse-capture opt-out;
- terminal-state restoration on every exit path;
- a truthful copy result. The message says what actually happened:
  - a failed local clipboard write is reported as a failure;
  - an OSC 52 request is reported as sent to the terminal, not as copied, because a terminal can drop it without
    telling anyone.

  Today's `✓ Copied` toast claims more than OSC 52 can confirm, and MVP-2 slice 2a corrects it.

The benchmark records these as the most common failure of products that made full-screen the default.

### 9. Commands are discoverable without documentation

- **The palette.** Every in-TUI command appears in the `/` palette with a one-line description. Argument-taking
  commands show an argument hint or open a picker. A command that cannot run in the current state is shown disabled,
  with the reason.
- **Typos.** A mistyped slash command reports the nearest match. It never runs it: an auto-run fuzzy match executes
  the wrong command, a lesson Claude Code recorded.
- **Keys.** The footer hint-bar shows the current screen's most relevant keys, and `/help` lists all of them
  (2.6.E's cheat sheet). There is still no separate `/shortcuts` command (ADR-0056).

### 10. Not decided here

- **Running a workflow and answering a gate inside the Home.** The Home process would host a run's lease, signals,
  consent prompts and exit dispositions. This gets its own ADR before the milestone that builds it. That ADR also
  amends ADR-0115, which today gives no Ctrl-C rule for a run hosted in the Home.
- **The milestone order.** It lives in [current.md](../roadmap/current.md#next-work--the-cli-mvp) (D69, and D75 as
  proposed on 2026-11-08).
- **The standalone chat host's future** (§5). Until that is decided, new Home-tree commands are not listed in the
  standalone host's palette.

### Alternatives considered

- **Keep subcommands as the primary interface and the Home as a launcher.** Rejected by the maintainer. It also
  contradicts phase 2.6's own exit criterion.
- **Run subcommands from inside the TUI** (a slash that spawns `relavium <cmd>`). Rejected, the same reason
  ADR-0056's amendment gave. A child process takes over the terminal and loses the Home's state. Re-hosting the core
  avoids both problems.
- **Full-screen only, dropping the inline renderer.** Rejected. Copilot CLI removed its inline mode, and its
  still-open complaint lists lost scrollback, search and copy. The inline renderer is also the screen-reader path.
- **A single shared registry for shell and slash commands.** Not needed. The two registries describe different
  shapes (argv grammar against a live session's capabilities). The rule that matters is one core per task (§2).

## Consequences

### Positive

- A user needs one command, `relavium`, plus the palette.
- The work order follows the user's journey. First run, resume and key setup come before less frequent management
  tasks.
- Shared cores keep the shell and the TUI from drifting apart.
- The acceptance list in §7 makes accessibility, colour-off and secret safety part of every screen's definition of
  done instead of a later sweep.

### Negative

- The Home controller grows. It already has six overlays, and the standalone chat host duplicates its key routing.
  New screens should share pure folds and views, the pattern `/models` uses.
- More security-tier work moves forward. In-TUI key entry, resume and project init all touch D64's security tier.
- The run-hosting design (§10) is the largest remaining piece, and it is not yet designed.

### Documents updated with this ADR

- [commands.md](../reference/cli/commands.md#in-repl-slash-commands): the shell-only sentence is replaced.
- [home.md](../reference/cli/home.md): the strip is actionable by direction; what is actionable today is unchanged
  until the code lands.
- [chat-session.md](../reference/cli/chat-session.md): the shell-only sentence is replaced.
- [vision.md](../vision.md) and [uvp.md](../uvp.md): where they describe the CLI as a scripting surface with
  `relavium chat` as the interactive entry.
- ADR-0054 and ADR-0056 get dated notes pointing here.

The code comments that restated the old rule (`repl-commands.ts`, `manifest.ts`) are corrected in the same
change.
