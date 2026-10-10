# Review: W7 internal owned request factory, round 1

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/adr0102_factory_r1_binding`, `/root/adr0102_factory_r1_graph`
- **Subject**: `633c968a..44da68dc`, four internal factory paths on `development`
- **Outcome**: Approved within scope; fresh round 2 required

## Summary

Two complete independent Code/Security reviews find no material defect in the internal
factory increment. [ADR-0102](../decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md)
is Accepted, but the production adapters, chain and core do not yet consume this factory.
The ownership High, installed-SDK acceptance and W7 remain open.

## Findings

No findings from either reviewer: Blocker 0, High 0, Medium 0, Low 0. Exact frozen
candidate views retain private cap authority; mutable SDK working copies cannot inherit
it. Candidate-local cap failures, support queries, live signals and trusted derivations
retain their intended boundaries. The shared provider-options root remains complete when
it is also ordinary payload data; native cap lowering remains the sole cap authority.

## Coverage and verification

The binding reviewer used `gpt-6-astra`, xhigh effort; the graph reviewer used
`gpt-6.1-sol`, xhigh effort. Both read all four changed files and the relevant cap,
capability, type/error dependencies against Accepted ADR-0102 and ADR-0101.

- Binding review: 40/40 factory tests and sixteen additional grouped native Node controls
  pass, covering nine native-cap own-presence cases, four route/order/alias handoffs and
  three getter placements with zero execution.
- Graph review: 110/110 focused tests pass (36 inert, 40 ownership, 34 cap), with 126
  additional pinned-source assertions covering both options-root property orders,
  uncapped/discarded/surviving/undefined caps, Map/Set aliases, derivations and fixed refusals.
- Independent in-memory capture-memo, working-memo and full-options-alias removals each
  fail their corresponding control; fresh unmodified controls pass afterward.
- LLM/platform-free seam typechecks, changed-file ESLint and diff checks pass. Both
  reviewers verify unchanged source bytes at `44da68dc` and a clean working tree.

An initial ad hoc graph assertion compared a null-prototype record with an ordinary
record using strict deep equality. Its corrected retained-field assertion passes; this
was a harness error. The 20,000-container test's explicit 30-second allowance preserves
its structural assertions and does not establish a five-second latency guarantee.

Parent independently confirmed complete options-root aliases in owned and working data,
rejection of borrowed working-copy cap metadata, and native-only cap lowering. Parent
lint/typecheck/test (23 tasks) and build (six targets) pass. Eight preliminary installed-SDK
HTTP parity controls pass for four providers' generate/stream paths with null-prototype
working copies; these are preflight observations, not production integration acceptance.

Neither reviewer edited files, accessed keys/providers or private artifacts, or repeated
full repository CI/coverage or SDK transport acceptance.

## Follow-ups

Run a fresh second independent review of the complete increment before adapter, chain,
media and core integration. Exact round reuse, synchronous stream capture, admission/key
ordering, the full installed-SDK field matrix and their causal controls remain required.
