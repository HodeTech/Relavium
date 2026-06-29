# ADR-0056: In-app slash command system driven by a single command manifest

- **Status**: Accepted
- **Date**: 2026-06-29
- **Related**: [ADR-0049](0049-cli-machine-output-contract.md), [ADR-0047](0047-cli-framework-commander-ink-clack.md), [ADR-0054](0054-cli-bare-invocation-interactive-home.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [phase-2.5-cli-consolidation.md](../roadmap/phases/phase-2.5-cli-consolidation.md) (2.5.C), [architectural-principles.md](../standards/architectural-principles.md)

> **Accepted (2026-06-29) at the start of workstream 2.5.C**, after a pre-implementation review tightened the
> manifest shape (dropped the redundant `canonical` flag and the speculative `requiresProvider`; gave `args` a
> concrete shape), re-anchored the manifest's canonical home from `home.md` to `commands.md` (Principle 8 — the
> manifest is a command-surface artifact, not a Home-surface one), and deferred `effect` **enforcement** + the
> `modeScope` mode values to [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md) (2.5.E).

## Context

The interactive surface today exposes only three slash commands (`/exit`, `/cancel`, `/export`), all
REPL-only, while the shell-level command grammar is inconsistent (`chat-resume` vs `agent run` vs `gate
list` vs `provider set-key` are four different shapes) and there is no machine-readable command
discovery. The Home ([ADR-0054](0054-cli-bare-invocation-interactive-home.md)) needs a discoverable
palette, and the per-command wiring is currently buried inside the `register*` action bodies
(`apps/cli/src/commands/specs.ts`), not reusable by a palette or a slash handler. Surveyed competitors
sprawl to 40–100 slash commands with heavy alias inflation (`/cost`=`/stats`=`/usage`), which hurts
discoverability — an anti-pattern to avoid.

## Decision

**We will drive `commander`, the in-app palette, and the in-REPL slash commands from one shared dispatch
table generated from a single command manifest**, defined as a Zod schema (canonically homed in
`docs/reference/cli/commands.md`; the runtime form is a **CLI-only contract in `apps/cli`**, not
`@relavium/shared` — no other surface consumes a CLI command list, and `@relavium/shared` carries the engine /
cross-surface contracts): per-entry `{ id, label, description, args?, effect, modeScope? }` — where
`description` feeds the `--help --json` text and **must match** the `commander` `.description()`; `args?`
describes the command's arguments as `{ name, type: 'string' | 'number' | 'boolean', required?, description? }[]`;
`effect` is `read | write | destructive` — a `destructive` entry is **marked** for agent discoverability, but
approval **enforcement** is defined in [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md) (workstream
2.5.E), not here; and `modeScope?` is an optional list of chat modes a command is available in (omit = all
modes), whose values (`ask` / `plan` / `accept-edits` / `auto`) are likewise defined in
[ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md). The set is deliberately **small and alias-free** —
every entry is canonical by construction, so there is no per-entry `canonical` flag. The same manifest also
feeds `relavium --help --json`, realizing the long-noted "agent-readable command surface". The per-command
dependency wiring is extracted from the `register*` bodies into a shared **dispatch module** (in `apps/cli`)
that a `commander` action, the palette, and a slash command all call, so the three surfaces can never diverge.
The taxonomy (which slash maps to which subcommand, and how the non-interactive equivalent is preserved for
CI/scripting) is canonically homed in `docs/reference/cli/commands.md` (authored in 2.5.C).

Considered keeping slash separate from `commander` (rejected: the two surfaces drift); allowing aliases
for ergonomics (rejected: the competitor anti-pattern — cognitive load and inconsistent muscle memory);
and shipping a user-defined plugin/TOML command system now (rejected: Phase 3 — the manifest is the
foundation it will build on, not a Phase 2.5 deliverable).

> **Refined by the Amendment below (2.5.C S3):** "one manifest feeds the palette" was narrowed — the heavy
> shell commands here drive `commander` + `--help --json` + the `executeCommand` dispatch table, while the
> **in-REPL** `/` palette + slash commands are a separate, curated `REPL_COMMANDS` registry. Each surface still
> has exactly one source; only the "run any shell command from inside a chat" reading was dropped.

## Consequences

### Positive

- Each surface has exactly one source — `COMMAND_MANIFEST` for `commander` + `--help --json` + the
  `executeCommand` dispatch table, and (per the amendment) `REPL_COMMANDS` for the in-REPL palette / slash —
  so a command can never disagree across the surfaces that show it.
- DRY wiring: a command's dependencies are assembled once and shared by every surface.

### Negative

- A one-time refactor of the `specs.ts` action wiring into the shared dispatch module — contained to
  `apps/cli`, with the existing command tests as the safety net.
- Two small registries to maintain (the shell `COMMAND_MANIFEST` + the curated `REPL_COMMANDS`); mitigated by
  each being the *only* source for its surfaces (drift is structurally impossible) and no command living in both.

## Amendment — 2026-06-29 (curated in-REPL command set, workstream 2.5.C S3)

When 2.5.C S3 began, the maintainer chose the **curated REPL command** model: the in-REPL `/` palette + slash
commands surface only the commands that make sense in a live REPL — **lifecycle** (`/exit`, `/cancel`, `/export`)
and **info/discovery** (`/help`, and — landing in later S-steps — `/shortcuts`, `/cost`, `/workflows`, `/doctor`,
`/clear`). The heavy, session-starting **shell** commands (`run`, `chat`, `provider`, `create`, `import`,
`export`) stay shell-only (`relavium <cmd> …`); they are never run from inside a chat, which would take over the
terminal and is the wrong ergonomics (the model every terminal-native agent CLI converges on).

This **refines** the original decision's "one manifest feeds the palette". A REPL command has a fundamentally
different shape than a shell command — its handler runs over the live session's lifecycle capabilities (a
`ReplCommandContext`: exit / cancel / export / open-the-palette), not a `CommandInput` + the durable stores — so
the two are realized as **two purpose-built registries**, not one list with a discriminator:

- `apps/cli/src/commands/manifest.ts` `COMMAND_MANIFEST` — the **shell** surface (commander + `--help --json` +
  the `executeCommand` dispatch table). Unchanged from S1/S2.
- `apps/cli/src/commands/repl-commands.ts` `REPL_COMMANDS` — the **curated in-REPL** surface (the `/` palette,
  the slash commands, the `/help` list, and the unknown-slash hint all derive from it).

The decision's actual goal — **no cross-surface divergence** — still holds: every command has exactly one
definition, and no command appears in both registries (a shell command is never an in-REPL slash, and vice
versa). The "single source per surface" guarantee is preserved; only the unrealistic "run any shell command from
inside a chat" reading is dropped.

## Implementation note — 2026-06-29 (S5–S6 refinements during the per-step review loop)

Two refinements emerged during implementation; each is recorded in the canonical reference homes
([commands.md](../reference/cli/commands.md), [chat-session.md](../reference/cli/chat-session.md)). The ADR's
core decision — the slash registry, the palette, the manifest, and the `--help --json` contract — is unchanged.

- **`/doctor --deep`'s MCP tier is read-only (S5 — a dedicated security-review decision).** The plan above
  (`--deep`: "MCP connectivity") implied a fresh connect. The adversarial security pass found that exploitable:
  the probe connected **every** config `[[mcp_servers]]` registration — including ones no agent references —
  turning `/doctor --deep` into an arbitrary-local-process-spawn primitive from an imported `project.toml`, and
  could orphan a spawned child on a timeout+exit window. The `--deep` MCP tier is therefore **read-only**: it
  REPORTS the live session's already-connected status (the bound agent's authorized servers + the tools the
  manager dropped), never a fresh connect/spawn. The session already proves connectivity within the documented
  on-demand model; the probe only reports it.
- **`/shortcuts` was dropped (S6).** The "info/discovery" list named a `/shortcuts` command; it was not built.
  The context-aware footer hint-bar (surfacing `/ for commands` at an empty prompt) plus the palette's own nav
  hints (`↑/↓ · Enter · Esc`) make the keymap discoverable in context, so a separate static-reference command is
  redundant.
