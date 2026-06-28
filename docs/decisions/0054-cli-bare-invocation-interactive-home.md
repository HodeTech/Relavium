# ADR-0054: Bare `relavium` invocation opens an interactive Home (TTY only), preserving the meta-op contract

- **Status**: Accepted
- **Date**: 2026-06-29
- **Related**: [home.md](../reference/cli/home.md), [ADR-0049](0049-cli-machine-output-contract.md), [ADR-0047](0047-cli-framework-commander-ink-clack.md), [ADR-0024](0024-agent-first-entry-point-agentsession.md), [ADR-0007](0007-desktop-is-not-an-ide.md), [ADR-0025](0025-agent-surface-refines-desktop-scope.md), [phase-2.5-cli-consolidation.md](../roadmap/phases/phase-2.5-cli-consolidation.md) (2.5.B), [product-constraints.md](../product-constraints.md), [architectural-principles.md](../standards/architectural-principles.md)

> **Accepted and implemented in workstream 2.5.B** (the TTY gate, the read-only management strip over `history.db`, the single-ink-tree mode machine, one SIGINT/SIGTERM lifecycle, and bracketed paste). The Home's contract is canonically homed in [home.md](../reference/cli/home.md).

## Context

Today a bare `relavium` (no subcommand) prints `program.helpInformation()` and exits `0`
(`apps/cli/src/run.ts`), and `commander` deliberately has **no default action**
(`apps/cli/src/program.ts`) — a default action would turn an unknown subcommand into a positional
argument and swallow the "unknown command" error. Every terminal-native agent CLI we surveyed
(Claude Code, Codex, opencode, Google's Antigravity `agy`) instead opens an interactive session on the
bare command; the project's agent-first stance ([ADR-0024](0024-agent-first-entry-point-agentsession.md))
wants the same "type the name → start talking" entry. But the CLI is also a CI/automation tool: the
`--json` NDJSON stream and the meta-op behaviour (help, version) are a binding contract
([ADR-0049](0049-cli-machine-output-contract.md)), and breaking it would strand scripts and pipelines.
Getting this wrong either leaves the CLI feeling second-class (today) or breaks CI silently.

## Decision

**We will open a branded, conversation-first Home from the bare `relavium` invocation, but only when
the process is genuinely interactive.** The gate is `stdoutIsTty && stdinIsTty && global.json !== true
&& !isCiEnv(io.env)`; otherwise the current `helpInformation()` + exit `0` meta-op is preserved.
The primary control is `stdoutIsTty && stdinIsTty`; the CI guard reuses the **existing `isCiEnv` helper**
(`apps/cli/src/process/output-mode.ts`) — which treats `CI=true`/`CI=1`/any truthy `CI` as CI — rather
than a bare `env.CI !== 'true'` test, so a CI runner that sets `CI=1` (some Drone/Woodpecker/custom setups)
or allocates a pseudo-TTY cannot accidentally open an interactive Home and stall the pipeline. (Earlier
text used `env.CI !== 'true'`, which would miss `CI=1`.) The remainder reads as preserved
unchanged. The gate lives in the existing bare-invocation branch of `run.ts` — **not** as a `commander`
default action, so the no-default-action decision and the unknown-command semantics stand. The gate
**reuses** the existing `stdinIsTty` field on the `io` seam (already wired for the `create` wizard) — no
new IO surface, just a new TTY-gate condition. The Home is a long-lived process mode whose own exit code
is `0`; a chat launched from within it ends with the chat exit code `4`, which the Home loop **consumes**
(never leaks). The Home's contract is canonically homed in [home.md](../reference/cli/home.md).

Considered a `commander` default action (rejected: it swallows unknown-command errors — the exact
reason `program.ts` avoids one); a separate `relavium home` subcommand (rejected: it does not meet the
"type `relavium` → Home" goal — the bare invocation is the requirement); and always opening the Home
regardless of TTY (rejected: it breaks pipes, CI, and the `--json` contract). Chose the TTY-gated
bare-branch because it adds the first-class entry while keeping every non-interactive path byte-for-byte
compatible.

The Home applies the **no-IDE-shell principle** of [ADR-0007](0007-desktop-is-not-an-ide.md) (which ADR-0007
frames for desktop, generalized by [ADR-0025](0025-agent-surface-refines-desktop-scope.md)) to the CLI **by
analogy**: management + chat only, a **read-only display** status strip with the interactive prompt below it
— no file tree, editor, or embedded terminal.

## Consequences

### Positive

- A first-class "type `relavium` → start" entry, matching user expectation and the agent-first stance.
- Fully backward-compatible: `--json`, pipes, `CI=true`, and every subcommand behave exactly as before.
- The extension point is one isolated branch in `run.ts`; the engine and `commander` wiring are untouched.

### Negative

- A new long-lived interactive process mode with its own lifecycle (the `stdinIsTty` seam already exists) —
  mitigated by a single ink tree (one `useInput` owner) and a single SIGINT/SIGTERM lifecycle covering
  Home, the in-Home chat, and MCP teardown.
- The Home's exit-code semantics (Home `0`, consumed chat `4`) add a small mapping the regression
  harness must assert; covered by the Phase 2.5 backward-compatibility exit criterion.
