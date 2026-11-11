# ADR-0124: Inspect retained run effects before file preparation

- **Status**: Accepted
- **Date**: 2026-11-11 (proposal refined 2026-11-12 after supplied reviews)
- **Related**: [ADR-0075](0075-fail-closed-resume-on-an-unreadable-event-log.md), [ADR-0079](0079-cross-process-run-ownership-lease-and-fencing-token.md), [ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md), [ADR-0083](0083-input-admission-and-a-resume-that-verifies-its-own-identity.md), [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md), [ADR-0098](0098-a-session-effect-row-holds-no-result-and-never-replays.md), [ADR-0120](0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md), [architectural principles](../standards/architectural-principles.md), [effect journal](../reference/shared-core/effect-journal.md#retained-evidence-and-early-inspection--mvp-3), [prepared-write contract](../reference/shared-core/tool-registry.md#proposed-prepared-writes-and-live-previews--mvp-3)

> **Accepted 2026-11-12 (maintainer):** the maintainer directed verification and
> correction of the supplied reviews, then acceptance and continued implementation.
> The corrected design and public-contract expansion are approved together;
> the [review disposition](../roadmap/phases/phase-2.6-conversational-authoring.md#adr-0124-review-and-design-acceptance-2026-11-12)
> records the source-backed decisions and separate corrected-design review.
> This is design acceptance, not delivered Step 2 behavior or its later security sitting.

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
No existing read-only dispatch lookup resolves this ordering problem. This is a
conditional replay mechanism: a regenerated model response need not reproduce
the old call, order or arguments. It is not a deterministic tool-loop restore.

Review also verified two inherited gaps in the claimed replay contract. The
resume gate accepts any defined JSON result rather than a usable envelope, so
an invalid result can pass before a model that never reproduces the old call.
Dispatch compares only mapping presence, not its actual configuration. The
latter is a public-registry defect, not a demonstrated current CLI YAML-edit
exploit: production callers do not presently supply `outputMapping`, and frozen
workflow verification already rejects covered workflow drift. Both gaps belong
in this replay change rather than being preserved by a second entry point.

This is an engine/host effect-protocol refinement of ADR-0080 and ADR-0120. It
preserves their safety decisions and new-effect ordering; it does not supersede
them. The [three-step plan](../roadmap/phases/phase-2.6-conversational-authoring.md#mvp-3-plan--editing-search-and-reviewable-effects-2026-11-11)
keeps this work inside Step 2. Step 1 can be completed independently.

## Decision

**We will add a required, read-only `inspectReplay` operation before preparation
of journaled filesystem effects, and require usable, mapping-bound retained
evidence at both resume and replay enforcement points.** The linked canonical
effect-journal and registry references own the precise types and ordering;
this record states the mechanism and rationale.

- The port remains bound to the engine-owned correlation. The engine supplies
  the slot, registered tool id and the same stable, secret-safe journal argument
  projection used by durable preparation. The host applies the existing digest
  and identity matching rules. A model cannot choose a scope or manufacture a
  retained-result claim.
- A proven missing record returns a miss without reserving a slot or changing
  a row. Only a matching committed **run** record with a usable retained result
  returns a replay. Every other present record conflicts. Unavailable storage
  is an error, never proof of absence; the canonical error ladder explicitly
  disables model recovery and node retries for inspection faults.
- Session records never produce a replay result, including rows from older or
  malformed writers. Missing session identity means miss; an existing identity
  conflicts without reading or parsing its result column. A normal content-free
  session row is not corrupt, and is still not permission to replay or dispatch
  it again. Implementations keep the existing ownership, fencing and lifetime
  checks, cancellation precedence and actual-producer retention/join rules for
  inspection I/O; the pure engine neither hashes nor accesses SQLite.
- Resolution, grants, argument/provenance validation, policy floors and stable
  journal projection all precede inspection. Reject unsettled/colliding
  projections before the lookup, and reuse that projection at durable prepare.
  A trusted first-party prepared-operation declaration plus a journaled tier
  identifies this path; tool names or external metadata do not confer it.
  On a miss, read-only preparation → approval → durable prepare → execute remains.
  A precondition refusal creates no row. Atomic prepare keeps its claim/replay
  race backstop; inspection is not a reservation.
- A retained-result hit skips filesystem preparation and publication entirely.
  An active approval regime still requires its hook and current mode decision,
  using an explicit saved-result delivery preview with no fresh diff or claimed
  file bytes to approve. Denial and cancellation retain their existing floors;
  author-trusted workflows acquire no interactive approver. The actual-dispatch
  `beforeDispatch` hook remains skipped on replay, as today; inspection has its
  own ownership/lifetime checks. This is no bypass of grants, provenance or
  policy. No second settle/discard occurs. Mark the completed-effect replay
  phase before envelope consumption so later faults cannot become retryable.
- One strict platform-pure retained-envelope schema/decoder lives in shared,
  used by SQLite, the in-memory journal, the node resume predicate and both
  replay entry points. A malformed/unknown envelope blocks node scheduling as
  `effect_needs_attention` even when the model never reproduces the old call.
  A valid explicitly absent value remains usable; a manufactured `undefined`
  fallback, arbitrary bare JSON or contradictory presence tags do not.
- The new envelope binds the exact configured mapping declaration, including
  absent versus configured-empty, independently of its recorded mapped result.
  Replay compares validated declarations structurally, ignoring key order; it
  never recomputes mapping from a truncated preview. This stores no resolved
  secret values. Older results without sufficient envelope/mapping evidence
  fail closed; no migration, inferred mapping or legacy decoder is required.
  The node gate checks structural usability; exact current mapping/argument
  matching remains a dispatch check, not a promise about model regeneration.
- Only prepared, journaled dispatches need this earlier inspection. Read-only
  tools and naturally idempotent overwrite calls acquire no extra journal
  round-trip. Unrelated command/MCP behavior, event schemas and scope are not
  expanded. Rich preview/reveal data remains ephemeral and never enters the
  effect journal or session history.
- All implementations, including the unwired port, engine fence, receipt-health
  observation, CLI durability wrapper and test doubles, forward/implement it
  explicitly. Read inspection creates no pending effect-health claim and cannot
  detach its actual producer on cancellation. No runtime dependency, table DDL
  or effect tier changes; the stored-envelope encoding does change.

Considered and rejected: preparing a durable claim first and discarding it on an
edit refusal, because a crash leaves false unresolved evidence and ordinary
refusals would write rows; carrying old reads/snapshots across resume, because it
weakens the accepted evidence and retention boundary; declaring edits benign or
idempotent, because exact replacement can compose or repeat; disabling edit
replay, because it breaks the run-resume contract; skipping active confirmation,
because delivery is not authority to weaken the existing gate; and accepting
legacy or presence-only mapping evidence, because it cannot prove the answer
the current caller requests. A read-only lookup supplies the missing information.

## Consequences

### Positive

- When the same correlation/slot/tool, journal arguments and mapping recur, a
  committed edit's saved result can be delivered without file preparation or
  publication, even though the edit already changed the source. No guarantee
  is made that a model reproduces that call, or that logical edits are exactly
  once when it chooses different calls, order or arguments.
- New operations retain their exact preparation, approval and durable-effect
  barriers. Session effects and current-loop read evidence keep their floors.
- One shared mechanism covers native prepared edits and journaled append,
  with host-owned hashing/storage and a platform-pure engine.

### Negative

- Journaled prepared calls add an indexed read and host-side hashing of the
  already computed stable projection. Reuse the projection and digest/matching
  helpers, bound inputs first, and keep read/overwrite hot paths outside it.
- Shared/core/DB/CLI port wiring and fixtures change together. Acceptance must
  exercise the real post-settle/pre-checkpoint crash window and verify retained
  replay performs zero file preparation/publication. Negative controls cover
  lookup failure, mismatched identity/digest, malformed/unknown envelopes before
  any node execution, legitimate absent values, same-presence mapping changes,
  mapping key-order equivalence, session non-replay, ownership loss, concurrent
  miss/prepare, different regenerated call sequences and no row on refusal.
- Shared/core/DB/public exports and fixtures change coherently inside Step 2.
  The unused development product needs no compatibility adapter. Acceptance
  requires the expanded public contract and dated ADR-0080/0120 forward notes,
  effect-journal §4/§7, registry, three-step plan and current roadmap updates.
  This accepted design remains unimplemented; design and implementation acceptance
  must not be conflated.

> Partially superseded 2026-11-12 by [ADR-0125](0125-file-writes-preserve-security-metadata-through-a-native-host-adapter.md):
> all built-in `write_file` operations now require tier-3 durability, including
> overwrite and new files. Prepared overwrite/new-file calls therefore use this
> ADR's early inspection as well; the earlier overwrite-hot-path exclusion no
> longer applies. Read-only tools remain outside journaling. Strict retained
> evidence, current confirmation, conditional model-call identity and session
> non-replay are unchanged. The canonical [journal predicate](../reference/shared-core/effect-journal.md#3-what-is-journaled)
> owns the ruling; this note does not claim implementation acceptance.
