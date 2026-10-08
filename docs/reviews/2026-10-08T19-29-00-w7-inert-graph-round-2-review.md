# Review: W7 inert graph foundation, round 2

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/adr0102_inert_graph_round2`
- **Subject**: `19f56067..2f6cf065` on `development`, internal graph foundation for ADR-0102
- **Outcome**: Approved

## Summary

The fresh independent reviewer approves the corrected internal graph foundation only.
The two High findings and mutable-copy alias control gap in
[round 1](2026-10-08T19-25-00-w7-inert-graph-round-1-review.md) are resolved. This does not
close [ADR-0102](../decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md),
the measured-request ownership finding, SDK compatibility or W7.

## Findings

No new findings: Blocker 0, High 0, Medium 0, Low 0. Own-descriptor array length avoids
ordinary reads; captured intrinsic receiver probes refuse hidden boxed/native brands;
mutable copies preserve aliases without exposing or modifying owned data. Iterative
capture retains supported primitive and own-presence semantics, refuses ancestor cycles,
and does not freeze caller containers. Fixed errors retain no property, value or cause.

## Coverage and verification

The reviewer used `gpt-6-astra`, high effort, and read all three cumulative source files,
all 453 added source/test lines, the complete first-round record, its index entry, the
corrective commit and the Accepted ADR's qualifications. It read CLAUDE.md and relevant
review/type/error/testing/security rules. A combined large roadmap/context read truncated;
this record does not claim complete historical-ADR or roadmap rereading.

- Fresh focused suite: 36/36 pass.
- Additional pinned-source adversarial assertions: 55 pass with zero caller conversion/getter hooks.
- Separate in-memory length, native-brand and mutable-alias mutants each failed its control.
- LLM and platform-free seam typechecks, focused ESLint and cumulative diff check pass.
- Reviewed source matched the pinned commit before and after checks. Helper SHA-256:
  `a214eb2a9cde9cf571821f75b266fa4d0f144e54bea51e47aaf243aa7c876a82`.

Synthetic Node 22.23.1 observations for 1,001/10,001/20,001 containers were 12/111/209 ms
for capture and 11/101/205 ms for mutable copies. These support distinct-container linear
scaling, not an integrated request latency guarantee. An initial ad hoc mutant harness
crossed separately loaded modules' private array WeakSets; the reviewer corrected it to
capture and recopy within each module. The corrected run passed.

Parent full repository lint/typecheck/test (23 tasks) and build (6 targets) passed after
the fixes; the reviewer did not independently repeat full CI/build/coverage. No files were
edited, no branch switched, and no keys, network or paid calls were used. The unrelated
overflow-capture increment was excluded.

## Follow-ups

Proceed to production ownership integration: exact owned-round reuse, cap-plan binding,
call-time stream capture, media-resolver copying, installed-SDK generate/stream compatibility,
unsupported-data refusal before admission/key access and their causal negative controls.
These remain open acceptance obligations.
