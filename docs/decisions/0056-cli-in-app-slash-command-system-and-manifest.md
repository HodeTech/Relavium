# ADR-0056: In-app slash command system driven by a single command manifest

- **Status**: Proposed
- **Date**: 2026-06-28
- **Related**: [ADR-0049](0049-cli-machine-output-contract.md), [ADR-0047](0047-cli-framework-commander-ink-clack.md), [ADR-0054](0054-cli-bare-invocation-interactive-home.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [phase-2.5-cli-consolidation.md](../roadmap/phases/phase-2.5-cli-consolidation.md) (2.5.C), [architectural-principles.md](../standards/architectural-principles.md)

> **Draft.** Proposed alongside the Phase 2.5 plan; to be reviewed and finalized (→ Accepted) when workstream 2.5.C begins.

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
`docs/reference/cli/home.md`): per-entry `{ id, label, description, canonical, args?, effect, modeScope?,
requiresProvider? }` — where `effect` is `read | write | destructive` (destructive entries are marked and
approval-gated), `description` feeds the `--help --json` text, `args` describes subcommand arguments, and
`modeScope?` is an optional list of chat modes a command is available in (omit = all modes; used to filter
the palette in, e.g., `ask` mode). The set is deliberately **small, canonical, and alias-free**. The same
manifest also feeds `relavium --help --json`, realizing the long-noted "agent-readable command surface". The per-command
dependency wiring is extracted from the `register*` bodies into a shared dispatch module that a
`commander` action, the palette, and a slash command all call, so the three surfaces can never diverge.
The taxonomy (which slash maps to which subcommand, and how the non-interactive equivalent is preserved
for CI/scripting) is canonically homed in `docs/reference/cli/home.md` (authored in 2.5.B).

Considered keeping slash separate from `commander` (rejected: the two surfaces drift); allowing aliases
for ergonomics (rejected: the competitor anti-pattern — cognitive load and inconsistent muscle memory);
and shipping a user-defined plugin/TOML command system now (rejected: Phase 3 — the manifest is the
foundation it will build on, not a Phase 2.5 deliverable).

## Consequences

### Positive

- One discoverable, consistent, machine-readable command surface; the palette, slash help, and
  `--help --json` all derive from one source, so they cannot disagree.
- DRY wiring: a command's dependencies are assembled once and shared by every surface.

### Negative

- A one-time refactor of the `specs.ts` action wiring into the shared dispatch module — contained to
  `apps/cli`, with the existing command tests as the safety net.
- The command manifest is a new contract to maintain; mitigated by making it the *only* source for the
  three surfaces (drift is structurally impossible).
