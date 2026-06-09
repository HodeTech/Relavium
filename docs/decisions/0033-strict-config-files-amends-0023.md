# ADR-0033: Local config files are strictly validated too (amends ADR-0023's config-scope carve-out)

- **Status**: Accepted
- **Date**: 2026-06-09
- **Related**: [0023-strict-authored-yaml-validation.md](0023-strict-authored-yaml-validation.md) (**this ADR amends its config-scope carve-out** — append-only; ADR-0023 is unchanged in history), [0020-zod-runtime-schema-library.md](0020-zod-runtime-schema-library.md), [0024-agent-first-entry-point-agentsession.md](0024-agent-first-entry-point-agentsession.md) (the `[chat]` block), [../reference/contracts/config-spec.md](../reference/contracts/config-spec.md) (the canonical config contract this reconciles with).

## Context

[ADR-0023](0023-strict-authored-yaml-validation.md) made the **authored workflow/agent YAML** schemas
`.strict()` (a mistyped key fails loudly instead of being silently stripped), and in its *Scope* section
**explicitly carved out the local config files** (`config.toml` / `project.toml` / `workspace.toml`),
leaving them **lenient** on a forward-compat argument ("a machine-local settings file should tolerate a
key written by a newer CLI"), noting the split "may be revisited separately."

Two things made that carve-out the wrong default, and a later maintainer decision (recorded in
[deferred-tasks.md](../roadmap/deferred-tasks.md), "config-schema strictness parity", S5 = fail loud)
reversed it in code — but **without an ADR**, leaving an Accepted ADR (0023) contradicted by the
shipped schemas and by the canonical config contract:

1. **The typo footgun ADR-0023 closed for authored YAML applies equally to committed config.** A
   silently-dropped `update_channnel` or `defaul_model` in a git-committed `config.toml` is the same
   "valid-but-wrong, no error" failure mode — arguably worse, because config governs keys, models, and
   cost caps. The user authors and commits these files by hand, exactly like workflow YAML.
2. **`config-spec.md` already treats config as a stable, versioned, public contract** where "breaking
   changes require a migration path, never a silent reinterpretation of existing keys." Silent-strip is
   a silent reinterpretation; it contradicts the config contract. So ADR-0023's config carve-out and
   `config-spec.md` had been in tension since before this was implemented.

## Decision

**The local config schemas are `.strict()` too, on the same footing as authored YAML — reversing only
the config-scope carve-out of [ADR-0023](0023-strict-authored-yaml-validation.md).** A typo or stale key
in a committed `config.toml` / `project.toml` / `workspace.toml` (including the nested `preferences` /
`defaults` objects, the `[chat]` block, and `[[mcp_servers]]` registrations) is a parse-time validation
error with a path to the offending key, not a silently stripped field.

ADR-0023's authored-YAML decision is **unchanged**; this ADR amends (does not supersede) it by extending
the same posture to config and removing the "config left lenient" exception. The `RunEvent` stream and
the logical `RunSchema` (engine-emitted shapes) **remain lenient** — that part of ADR-0023's scope is
intentional and untouched.

Considered: keep config lenient (ADR-0023 status quo) — rejected: re-opens the typo footgun on a
hand-authored, committed, cost-governing file and contradicts `config-spec.md`. Strip-with-warning —
rejected for the same reasons ADR-0023 rejected it for authored YAML (no diagnostics channel; a
"valid-but-warned" parse is a muddier contract than accept/reject).

## Consequences

### Positive

- A typo or stale key in a committed config file fails loudly at parse with the exact path — the same
  footgun closed for authored YAML is now closed for config; the config schema is an exact, enumerated
  contract, consistent with `config-spec.md`.
- One posture across authored YAML **and** config (both strict); only engine-emitted shapes stay lenient.
  The codebase no longer has an undocumented authored-vs-config split.

### Negative

- Forward-compat across config versions is now explicit work: a config key added by a newer CLI is
  rejected by an older parser, rather than silently tolerated. This is the same trade-off ADR-0023
  accepted for authored YAML — handled by the versioned config contract + a migration path
  (`config-spec.md`), and a loud failure on a machine-local file the user controls is preferable to a
  silently-dropped setting. (This is the exact forward-compat tolerance ADR-0023's carve-out had chosen
  to keep; this ADR consciously trades it for fail-loud, reconciling with `config-spec.md`.)
