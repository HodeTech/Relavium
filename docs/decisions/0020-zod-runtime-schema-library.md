# ADR-0020: Zod as the runtime schema and validation library

- **Status**: Accepted
- **Date**: 2026-06-04
- **Related**: [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md), [0003-pure-ts-engine-not-langgraph-python.md](0003-pure-ts-engine-not-langgraph-python.md), [../tech-stack.md](../tech-stack.md), [../reference/contracts/workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md), [../project-structure.md](../project-structure.md)

## Context

`@relavium/shared` is the single source of truth for every contract — workflow/agent
YAML, the run-event union, the run record, and config ([project-structure.md](../project-structure.md)).
These contracts must do double duty: be **inferred TypeScript types** the whole monorepo
codes against, *and* be **runtime validators** at every trust boundary the engine ingests
untrusted data from (a parsed `.relavium.yaml`, an IPC payload, a provider response, a
config file). CLAUDE.md rule 1 forbids `any` and mandates `unknown` + a guard at
boundaries; the standards repeatedly require "parse with a Zod schema at the edge, then
trust inside the core."

Doing this by hand — keeping a TypeScript `interface` and a separate runtime validator in
sync for ~30 schemas — is exactly the drift the project's "one canonical home" rule exists
to prevent. So the contract layer needs **one** library that derives the type *from* the
validator (or vice versa). [tech-stack.md](../tech-stack.md) already lists Zod under
"Schemas / types", and the Phase-0 plan names it as `@relavium/shared`'s sole runtime
dependency — but a runtime dependency requires an ADR (CLAUDE.md rule 2), and none existed.
This ADR records and authorizes that choice and its drivers.

## Decision

**`@relavium/shared` uses Zod (`zod`, pinned in [tech-stack.md](../tech-stack.md) via the
pnpm catalog) as its schema-and-validation library, and it is the package's only runtime
dependency.** Schemas are authored in Zod; the inferred TS types are derived with
`z.infer`, so the type and the validator can never diverge. Untrusted input is parsed with
the relevant schema at the boundary and trusted thereafter.

Considered options:

1. **Zod** — TypeScript-first, type *inferred from* the schema (no drift), zero runtime
   dependencies of its own, discriminated unions + refinements for the cross-field rules
   the contracts need, MIT, very widely adopted and actively maintained. *Chosen.*
2. **Hand-rolled validators + separate `interface`s** — no dependency, but doubles every
   contract and invites exactly the type↔validator drift the package exists to eliminate.
   *Rejected.*
3. **TypeBox / `io-ts` / `valibot`** — all viable schema libraries. TypeBox centres on
   JSON-Schema/AJV (useful later for MCP tool schemas, but heavier for the inferred-type
   ergonomics we want everywhere); `io-ts` carries an `fp-ts` idiom that is foreign to the
   rest of the codebase; `valibot` is leaner but less battle-tested and ecosystem-thin for
   our needs. *Rejected for the contract layer*, though nothing here precludes using a
   JSON-Schema tool **inside** a specific seam (e.g. validating MCP tool schemas) where
   that format is the native one.

This is consistent with the engineering principles ([0003](0003-pure-ts-engine-not-langgraph-python.md),
[0011](0011-internal-llm-abstraction.md)): one language (TypeScript), a small vetted
dependency we wrap behind our own canonical schemas rather than a framework that owns our
control flow. Zod is a *library* (data in, validated data out), not a framework, so it
does not compromise the build-in-house posture.

**Compatibility / maintenance.** Pinned to Zod 3.x in [tech-stack.md](../tech-stack.md); a
move to Zod 4 is a deliberate, tested version bump (the schemas already prefer the
forward-compatible two-argument `z.record(key, value)` form). Zod has no transitive runtime
dependencies, so it adds no supply-chain surface beyond itself. It runs in every host the
engine runs in (Node, the Tauri WebView, the VS Code extension host, the Phase-2 Bun API),
preserving the engine's zero-platform-imports guarantee.

## Consequences

### Positive

- One artifact per contract: the Zod schema **is** the validator and the source of the
  inferred type — no hand-maintained `interface` to drift from the runtime check.
- Real boundary safety: YAML, IPC, provider responses, and config are parsed with a schema
  at the edge, satisfying the `unknown`-at-boundaries rule without `any`.
- Cross-field contract rules (discriminated node/trigger unions, `merge_fn`-requires-custom,
  id uniqueness, transport-specific MCP fields) are expressed and enforced in the schema.
- `@relavium/shared` stays minimal — `zod` is its **only** runtime dependency.

### Negative

- A runtime dependency in the contract package that every other package transitively
  pulls in; mitigated by Zod being dependency-free, MIT, and widely maintained, and by the
  schemas being the package's entire reason to exist.
- Zod's inference has compile-time cost on very large schemas and some sharp edges (e.g.
  discriminated-union members may not carry refinements); handled by keeping cross-object
  rules in a parent `superRefine` rather than per-variant.
- A future major (Zod 4) is a coordinated bump; bounded by pinning the version centrally in
  [tech-stack.md](../tech-stack.md) and by the conformance the schema test-suite provides.
