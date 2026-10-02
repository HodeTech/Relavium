# Review: W7 ADR-0101 mechanism revision, round 2

- **Type**: Code
- **Date**: 2026-10-02 (timestamp in Europe/Istanbul)
- **Reviewer(s)**: `/root/w7_adr0101_round2_integrity`, `/root/w7_adr0101_round2_contracts`
- **Subject**: `development`, complete Proposed ADR-0101 at `2b628e1a`
- **Outcome**: Approved for proposal completeness; maintainer decision pending

## Summary

Two fresh independent reviewers accepted the complete revised proposal, including the
[round 1](2026-10-02T15-09-58-w7-adr-0101-revision-round-1-review.md) correction, with no verified
actionable finding. Integrity/mechanics used `gpt-6-astra` at max effort; contracts used
`gpt-6.1-sol` at xhigh effort. The parent passed required workspace checks (23 tasks) and clean-tree
full `pnpm run ci` at `2b628e1a`.

## Findings and acceptance

No remaining draft finding was verified. Reviewers independently checked the original maintainer
findings and all related decisions against current source:

- Required cap projection, actual endpoint identity and prepared-plan forwarding cover both chain
  paths, turn/host/durability wrappers and the object-based governor entry.
- Separate rate-only pricing preserves the resolved native cap/envelope without another clamp or
  falsely changing official routing to custom. Final monetary refusal/allowance tests are required.
- One cap plan expands ADR-0096's helper and is consumed by adapters. Mapped caps, native evidence
  and reservation remain distinct; existing thinking controls retain their inputs.
- Measured plans reach the matching first main candidate and every required summariser candidate.
  Materialisation, admission and credential waits cannot silently replace a relied-upon plan;
  replacement repeats dependent measurement under existing entry-point rules. Main-turn rules for an
  oversized floor or failed compaction and permitted trim outcomes remain intact.
- Allowance `E` rebinds the paused raw inputs per candidate, including cooldown entries. Raw options
  remain ephemeral; frozen amount/provenance, dispatch ownership and ADR-0100 ordering stay intact.
- All six related ADRs have explicit future dated qualifications. The unauthored-4,096 acceptance,
  hook premise, summariser authored cap, generative zero-text branch and direct-custom factory
  classification are reconciled without adding a YAML native-options feature.

## Limits and next gate

This is a static architecture/documentation review, not implementation acceptance. Reviewers read
the full proposal, prior record, related ADRs and applicable current cap, adapter, chain, governor,
runner/session/host and mutable-catalog code. They made no edits, runtime tests, provider calls,
network requests or probe artifacts. Future parity, mutation, forwarding and monetary regressions
remain mandatory implementation obligations; CI passing does not prove those unimplemented paths.

The revised proposal has been presented to the maintainer for approval. ADR-0101 remains Proposed
and its dependent step 6 implementation is unstarted. Steps 1–5 remain closed; all six W7 register
items remain open. After approval, implementation follows the already-approved per-step commit and
fresh-review cycle.
