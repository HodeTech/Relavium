# Review: ADR-0103 eighth proposal — local paused-run departure

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/w7_adr0103_eighth_mechanics`, `/root/w7_adr0103_eighth_contracts`; Parent `/root`
- **Subject**: [Proposed ADR-0103](../decisions/0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md), eighth candidate, against historical source `f3dd7246`
- **Outcome**: Approved for maintainer design review only; Proposed status and implementation approval gate remain

## Findings and scope

Both fresh complete static reviews establish no additional material design finding. The eighth candidate closes the preceding admitted-prepare/no-settlement gap: acknowledged, nonreplayed preparation is tracked by existing effect identity and tier before dispatch proceeds; handoff retains that observation, and only a matching committed/proven-discard acknowledgement resolves it. Remaining tier-3 preparation requires attention after the actual raw/child/entered joins. Sticky receipt failures cannot be cleared by a later success. This is a proposed mechanism, not a passed runtime acceptance case.

The full proposal is **51,290 bytes / 591 lines**, SHA-256 `59eeacff859a626fb72afa2add64cfd7826befa3340da5c6f22afd0e9d2dde57`. Publication preserves these exact reviewed bytes and the 2026-10-07 candidate date. It defines graceful engine-owned host departure for parked ordinary/budget gates and submitted media, including a terminal/fenced branch that wins during departure. Late money/effect receipts retain narrow authority, ownership is not released before required work joins, original node-deadline basis survives reattachment, and the CLI distinguishes money uncertainty with proposed exit 8. AgentSession, running crash-attempt restart policy, provider-side cancellation and a daemon remain outside this decision.

Both lanes independently read the entire proposal and relevant canonical contracts, ADR clauses, complete affected functions and direct callers. The mechanics lane covers the executable engine region and the complete tool registry. The contracts lane covers native append and CLI/output interpretation. Neither imports dependencies, executes JS/TS, exercises native SQLite/TTY/signals, makes network/provider/key calls, delegates further work or changes repository/candidate bytes. Model/effort metadata is not recoverable from these final captured task records and is not invented.

## Parent evidence audit

Parent reads both complete finalized reports: mechanics **27,723 bytes**, SHA-256 `91b82ffd43d71c2707bcc036f9cc65a42aa59902903d61fcd4ca1f58f94c5fee`; contracts **33,369 bytes**, SHA-256 `ad36892d700dd17ac063c6f95f198b98d0c1aba205fdbf1841b14a49a65a3dbf`.

Independent nofollow physical and semantic audits cover all **3,102 entries / 2,863 regular files**, both externally bound self artifacts and complete regular unions. Both Owns contain 1,169 exact source pins bound to actual historical `f3dd7246` Git bytes, with unique single-link identities disjoint from Original receipts. All recorded numeric metadata fields other than observation-only atime match, with no allocation difference. Captured environments, command bodies, read spans and whole-candidate coverage are independently authenticated before publication. Both Owns remain permanently retired; Parent executes none of their scripts and never modifies, reseals or cleans them.

One report claim is narrowed: the mechanics lane's authenticated ranges do not establish its claimed full native-append reading at lines 945–1069. The contracts lane independently displays the complete relevant 945–1184 span; Parent separately reads 945–1069. This supports proposal review while preserving the mechanics coverage qualification. Initial transcript-only/collided commands, guide-order and aggregation mistakes, one malformed capture, oversized outer displays and failed audit preparation remain explicit. Static review does not establish runtime correctness, CI acceptance or the absence of implementation defects.

## Follow-ups

**ADR-0103 remains Proposed. Maintainer approval is required before any dependent implementation**, as explicitly requested for new ADRs. The later implementation must satisfy the proposal's held-port, acknowledgement, capability, terminal/pause, effect/money and exact-fence controls, receive fresh implementation reviews and update canonical contracts with append-only ADR notes. No such implementation, accepted-status change, paid capture, W7 closure or PR approval is authorised by this review. [ADR-0102](../decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md) also remains Proposed and independently gated.
