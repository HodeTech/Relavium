# ADR-0124: Inspect retained run effects before file preparation

- **Status**: Proposed
- **Date**: 2026-11-11
- **Related**: [ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md), [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md), [ADR-0098](0098-a-session-effect-row-holds-no-result-and-never-replays.md), [ADR-0120](0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md), [architectural principles](../standards/architectural-principles.md), [effect journal](../reference/shared-core/effect-journal.md), [prepared-write contract](../reference/shared-core/tool-registry.md#proposed-prepared-writes-and-live-previews--mvp-3)

## Context

MVP-3 requires read-only file preparation before approval and durable effect
preparation: an ordinary edit precondition refusal must create no journal row.
The existing run journal also requires a committed effect with a retained result
to return that result without executing the effect again. Sessions never replay
effects. These guarantees remain complementary.

Their current integration has a concrete crash window. A workflow agent reads
`old`, edits it to `new`, and commits the effect result; the process then crashes
before the node completion checkpoint. Resume can reproduce the same call and
effect slot. Fresh file preparation sees `new` and rejects `old` as absent, before
the journal can deliver its retained result. Reusing the previous read evidence
would violate the current-loop, reset-on-resume contract.

The current dispatch port exposes `prepare`, `settle` and `discard`. Retained
replay is returned only by `prepare`, after approval. The resume gate supplies
blocking records, not committed retained results or the previous model loop.
No existing read-only dispatch lookup resolves this ordering problem.

This is an engine/host effect-protocol refinement of ADR-0080 and ADR-0120. It
preserves their safety decisions and new-effect ordering; it does not supersede
them. The [three-step plan](../roadmap/phases/phase-2.6-conversational-authoring.md#mvp-3-plan--editing-search-and-reviewable-effects-2026-11-11)
keeps this work inside Step 2. Step 1 can be completed independently.

## Decision

**We will add a required, read-only `inspectReplay` operation to the effect
dispatch port, and consult it before preparing a journaled filesystem effect.**
The canonical effect-journal and registry references will own its exact types
and ordering after acceptance; this record states the mechanism and rationale.

- The port remains bound to the engine-owned correlation. The engine supplies
  the slot, registered tool id and the same stable, secret-safe journal argument
  projection used by durable preparation. The host applies the existing digest
  and identity matching rules. A model cannot choose a scope or manufacture a
  retained-result claim.
- A missing record returns a miss without reserving a slot or changing an
  effect row. A matching, committed **run** record with a usable retained result
  returns that recorded result. Conflicting, unresolved, corrupt or unavailable
  evidence fails closed under the existing effect error policy. Inspection
  errors are never interpreted as a miss.
- Session records never produce a replay result, including rows from older or
  malformed writers. Their duplicate/conflict and content-free reader rules
  remain. Implementations keep the existing ownership, fencing and lifetime
  checks, cancellation precedence and actual-producer retention/join rules for
  inspection I/O; the pure engine neither hashes nor accesses SQLite.
- Resolution, grants, argument/provenance validation and policy floors run
  before inspection. On a miss, the accepted read-only preparation → approval
  → durable prepare → execute sequence is unchanged. A precondition refusal
  still creates no row. Durable `prepare` keeps its atomic claim and replay
  backstop: inspection is not a reservation or a promise that a later race will
  succeed.
- A retained-result hit skips filesystem preparation and publication entirely.
  Existing mode/confirmation floors still apply wherever an approval regime is
  present. Its live projection explicitly describes delivery of a saved result
  with no new filesystem operation; it must not invent a fresh diff or ask the
  user to approve unavailable file bytes. The recorded-result path must
  structurally validate and deliver a usable retained envelope without settling
  it again. Unknown/malformed envelopes, including valid JSON with invalid
  structure, must be refused; the current decoder's `undefined` fallback is
  not evidence of usability. A valid explicitly absent value remains distinct
  from corrupt evidence.
  Post-replay projection errors retain the existing non-retryable classification.
- Only prepared, journaled dispatches need this earlier inspection. Read-only
  tools and naturally idempotent overwrite calls acquire no extra journal
  round-trip. Unrelated command/MCP behavior, event schemas and scope are not
  expanded. Rich preview/reveal data remains ephemeral and never enters the
  effect journal or session history.
- All dispatch-port implementations and test doubles implement the operation
  explicitly. The unused development product needs no older-binary adapter or
  migration. No runtime dependency, storage schema or effect tier changes.

Considered and rejected: preparing a durable claim first and discarding it on an
edit refusal, because a crash leaves false unresolved evidence and ordinary
refusals would write rows; carrying old reads/snapshots across resume, because it
weakens the accepted evidence and retention boundary; declaring edits benign or
idempotent, because exact replacement can compose or repeat; and disabling edit
replay, because it breaks the existing run-resume contract. A read-only lookup
supplies the missing information without weakening those guarantees.

## Consequences

### Positive

- A committed edit can resume after its file has already changed, without
  another read, approval of guessed bytes, or filesystem mutation.
- New operations retain their exact preparation, approval and durable-effect
  barriers. Session effects and current-loop read evidence keep their floors.
- One shared mechanism covers native prepared edits and journaled append,
  with host-owned hashing/storage and a platform-pure engine.

### Negative

- Journaled prepared calls add an indexed read and bounded digest work. Reuse
  existing projection/matching helpers, bound inputs before inspection and keep
  the lookup outside read-only and overwrite hot paths.
- Shared/core/DB/CLI port wiring and fixtures change together. Acceptance must
  exercise the real post-settle/pre-checkpoint crash window and verify retained
  replay performs zero file preparation/publication. Negative controls cover
  lookup failure, mismatched identity/digest, missing/corrupt results (including
  structurally invalid JSON envelopes), session
  non-replay, ownership loss, concurrent miss/prepare and no row on refusal.
- This additive public API and narrow replay-order exception need maintainer
  approval before Step 2 implementation. On acceptance, add dated forward notes
  to ADR-0080/0120 and update their canonical contracts; until then this is a
  proposal, not delivered behavior or an accepted implementation change.
