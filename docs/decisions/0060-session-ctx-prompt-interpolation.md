# ADR-0060: Session `{{ctx.*}}` prompt interpolation

- **Status**: Proposed
- **Date**: 2026-06-28
- **Related**: [ADR-0024](0024-agent-first-entry-point-agentsession.md), [ADR-0027](0027-expression-sandbox.md), [ADR-0058](0058-relavium-authoring-package-and-conversational-authoring.md), [ADR-0059](0059-cli-mid-session-model-reseat.md), [phase-2.6-conversational-authoring.md](../roadmap/phases/phase-2.6-conversational-authoring.md) (2.6.D), [architectural-principles.md](../standards/architectural-principles.md)

> **Draft.** Proposed alongside the Phase 2.6 plan; to be reviewed and finalized (→ Accepted) when workstream 2.6.D begins. **Security review of the session-prompt taint path is mandatory before Accept.**

## Context

The session agent's `system_prompt` is passed to the turn core **verbatim** — there is no template
resolution — and `relavium agent run --input k=v` is consequently reserved/rejected until session-scoped
variable interpolation exists (a tracked Phase-2 engine follow-up). The conversational authoring agent
([ADR-0058](0058-relavium-authoring-package-and-conversational-authoring.md)) and the reseat path both
want session context in the prompt, so the deferral now blocks Phase 2.6. The workflow path already has a
template/interpolation engine for node prompts; the question is whether the session reuses it or a
surface-side substitute is introduced.

## Decision

**We will resolve `{{ctx.*}}` placeholders in the session `system_prompt` against session-scoped
variables inside `AgentSession` (a pure engine amendment), reusing the workflow interpolation
mechanism (`resolveTemplate`), and unblock `agent run --input`.** The interpolation is the engine's
single mechanism — we cite the [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md)
interpolation contract rather than re-implementing or restating it; this is template substitution, **not**
expression evaluation ([ADR-0027](0027-expression-sandbox.md) keeps that boundary).

**Untrusted-content invariant (security) — a value-provenance rule, not just a `caps={}` rule.** Two
sources of untrust must be kept out of the `system` position. (1) **Resolver source:** `resolveTemplate`
accepts an optional `ResolverCapabilities`; its `read_file`-style resolver would pull file content, which
the resolver-taint rules require to land **only** in `user`/`tool` positions, never `system`. Session-prompt
interpolation therefore calls `resolveTemplate` with **no `read_file` capability** (`caps = {}`) and the
**`ctx.*` namespace only**. (2) **Value provenance:** the `ctx.*` **values** themselves are not all trusted —
`agent run --input k=v` values are user-/pipeline-controlled (e.g. `--input task="$(curl evil)"`), so they
are **untrusted by provenance** even though their source is not `read_file`. The safe property is therefore
that **only trusted-literal session variables interpolate into the `system` prompt**; `--input`-derived
values are tagged untrusted and resolve **only in `user`-position** turns, never `system`. (`SessionContext`
gains a per-variable provenance/taint marker — today it is a flat record with none — so the resolver can
enforce this.) The marker is **sticky/transitive**: any `ctx.*` value copied from, merged with, or derived
from an untrusted value inherits the untrusted provenance (the most-untrusted source wins), so taint cannot
be laundered by relabeling an `--input`-derived value into a "trusted-literal" key — only variables that
originate as trusted literals (config / agent definition) are ever `system`-eligible. Secret-taint
discipline also applies: `{{ctx.*}}` carries plaintext variables only, never
secrets (those stay in the keychain and never enter a prompt). **A security review of the session-prompt
taint path is mandatory before Accept.**

Considered keeping the prompt verbatim and leaving `--input` rejected (rejected: it blocks both
conversational authoring context and the advertised `agent run --input`); and a CLI-side string replace
before the prompt reaches the engine (rejected: the engine owns interpolation — a surface-side hack would
diverge from the workflow path and break the one-mechanism / engine-purity principle).

## Consequences

### Positive

- `agent run --input` is unblocked; the session prompt can carry context for authoring and reseat; one
  interpolation mechanism across the workflow and session paths.

### Negative

- A pure engine amendment to `AgentSession` (recorded by this ADR) **plus a per-variable provenance/taint
  marker on `SessionContext`** (today a flat record) so untrusted `--input`-derived values cannot reach the
  `system` position — a real prompt-injection surface if missed. Mitigated by the value-provenance rule
  above, the existing secret-taint discipline, and a mandatory security review.
- If an operator pipes untrusted external data into `--input` (shell substitution, a CI input), those values
  still reach a `user`-position prompt — no automatic content sanitization is applied; operators piping
  untrusted values are responsible for sanitizing them (the engine guarantees only that such values never
  reach the `system` position).
