# Review: W7 internal owned request factory, round 2

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/adr0102_factory_r2_authority`, `/root/adr0102_factory_r2_graph`
- **Subject**: `633c968a..44da68dc`, four factory paths; round-1 record/index at `beebcc94`
- **Outcome**: Approved within scope

## Summary

Two fresh complete Code/Security reviews accept the internal request factory, following
[round 1](2026-10-08T20-28-00-w7-request-factory-round-1-review.md). Production adapters,
chain/media handoffs and core measured-round reuse remain separate implementation and
acceptance obligations under [ADR-0102](../decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md).
This record does not close the ownership High or W7.

## Findings

Both reviewers report no findings: Blocker 0, High 0, Medium 0, Low 0. Exact candidate
authority, original/native-control binding, generic graph semantics, exceptional cap slots,
candidate-local failures, support queries, signals and trusted derivations retain the
Accepted decision's boundaries. Working copies preserve ordinary aliases while carrying
no private accepted-view authority. The existing shallow production helper is excluded
from this internal increment and must be replaced during integration.

## Coverage and verification

The authority reviewer used `gpt-6-astra`, xhigh effort; the graph reviewer used
`gpt-6.1-sol`, xhigh effort. Both read every change in all four paths, the complete
round-1 record/index, Accepted ADR-0102's latest qualifications, ADR-0101 and relevant
capability/type/error dependencies. Authority review also checked ADR-0096/0097 requirements.

- Both fresh focused runs pass 110/110 tests: 36 inert, 40 ownership, 34 cap.
- Authority: sixty pinned-source adversarial case groups pass. Eight route combinations,
  twelve native bindings, six unsupported-data cases, ten generic traversal cases, eight
  options-root aliases, ten metadata cases and six failure/derivation/critical groups are covered.
- Authority: four separate in-memory removals of selected-route binding, native own-presence,
  original-control eligibility and genuine-plan authentication each fail the intended control;
  all four original controls pass afterward.
- Graph: 620 additional pinned-source assertions pass, covering descriptor/native-brand,
  deep/shared graph, present undefined/nonfinite values, Map/Set, aliases, exceptional slots,
  candidate failure and trusted-overlay behaviour.
- Graph: separate capture-memo, working-memo and complete-options-alias removals each fail
  their matching control; unmodified controls pass afterward.
- Scoped ESLint and diff checks pass; graph review also passes both LLM typechecks.

Authority's initial harness syntax error was corrected. Its first route mutant also retained
a different-model refusal, so the control was narrowed to two providers sharing one model;
it then independently detected the removed selected-outcome check. Neither was a product defect.

Both reviewers verify all four source/test paths byte-identical to `44da68dc`. Output-cap
SHA-256 remains `917b26b8831fbb0a53c301560d453a3335068cc02b5e56e9ccd3de482da6c533`.
Pinned modules were transpiled/mutated only in memory; authority retained existing shared
runtime artifacts as dependencies. Unrelated capture/docs and concurrent Step 7 changes
were excluded. No shared files, provider/key/private artifacts or local settings were touched.
Full CI, coverage and installed-SDK transport acceptance were not repeated by either reviewer.

## Follow-ups

Proceed automatically to actual adapter/chain/core integration after the independent Step 7
classifier increment releases its overlapping files. Validate plans on exact frozen views
before making one alias-preserving SDK working copy. Complete the generate/stream field and
mutation matrix, call-time stream ownership, copied media results, exact measured-round reuse,
refusal ordering and separate causal controls; then run fresh review rounds on that integration.
