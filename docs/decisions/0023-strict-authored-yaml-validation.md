# ADR-0023: Authored workflow/agent YAML is strictly validated — unknown keys are rejected

- **Status**: Accepted
- **Date**: 2026-06-04
- **Related**: [ADR-0009](0009-git-native-workflow-yaml.md), [ADR-0020](0020-zod-runtime-schema-library.md), [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md), [agent-yaml-spec.md](../reference/contracts/agent-yaml-spec.md)

## Context

Workflow and agent definitions are **git-committed YAML the user authors by hand**
([ADR-0009](0009-git-native-workflow-yaml.md)). During Phase 0 the Zod schemas used Zod's
default `z.object` behavior, which **silently strips** unknown keys. That was documented as a
deliberate forward-compatibility choice (a newer file's added field never breaks an older
parser). A comprehensive review pushed back: for a hand-authored format that is the primary
authoring surface, silent-strip turns a **typo into a no-op** — `temprature: 0.9` is dropped
and the agent quietly runs at the default temperature, with no error. For a first-class
product whose contract is a "public API", that is a footgun, not a feature.

## Decision

**Every authored workflow/agent object schema is `.strict()`: an unknown or mistyped key is a
validation error, not a silently stripped field.** This covers the workflow document and its
body, every node type, edges, agents, and their nested authored objects (triggers, inputs,
context, tool policy, MCP refs, memory, retry, fallback entries). Cross-`schema_version`
evolution is handled by the `schema_version` literal and a migration path — not by tolerating
stray keys.

Considered alternatives:

1. **`.strict()` — reject unknown keys.** A typo fails loudly at parse time with a path to the
   offending key. *Chosen.*
2. **Keep silent-strip, document it, add a test.** Maximal forward-compat tolerance, but the
   typo footgun remains. *Rejected* for the authored surface.
3. **Strip with a warning/lint.** Catches typos without hard-failing, but needs a separate
   diagnostics channel the Phase-0 schema layer does not have, and a "valid but warned" parse
   is a muddier contract than accept/reject. *Rejected* for now.

Scope: this applies to the **authored** workflow/agent YAML only. Engine-emitted shapes (the
`RunEvent` stream, the logical `RunSchema`) and the local **config** files (`config.toml` /
`project.toml`) are deliberately left lenient — they have a different forward-compat profile
(a machine-local settings file should tolerate a key written by a newer CLI), and may be
revisited separately.

## Consequences

### Positive

- A typo or stale key in a committed workflow/agent fails at parse time with the exact path,
  instead of silently doing nothing — the single biggest authoring footgun is closed.
- The schema is now an exact, enumerated contract: what is accepted is exactly what is
  modeled, which keeps the YAML spec and the schema honest.

### Negative

- Forward-compat across `schema_version`s is now explicit work: a new optional field added in
  a later version is rejected by an older parser, so additive changes ride the
  `schema_version` + migration path rather than being silently absorbed. Accepted — the
  version literal already exists for exactly this.
- Config files keep the lenient behavior, so the codebase has two postures (authored YAML =
  strict, config = lenient); the split is intentional and documented here.
