# W7 ADR-0102/0103 maintainer follow-up — round 2

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/adr0102_maintainer_followup_r2`, `/root/adr0103_maintainer_followup_r2`; parent `/root`
- **Subject**: complete Proposed ADR-0102/0103 and cumulative `080b002d..6254a6fa`
- **Outcome**: Approved — static clarification review only; both ADRs remain Proposed pending maintainer approval

## Summary

Two fresh independent reviewers read both complete proposals and the full cumulative revision.
Neither reports a new material finding. Parent reads both full reports and verifies their source
claims. The [round-1 SDK feasibility High](2026-10-08T18-21-45-w7-adr-0102-0103-maintainer-round-1-review.md)
is closed **at decision level**: the new Proposed own-key refusal removes the non-cap input that
would reach the installed Gemini SDK's unsafe destination merge. It is not an implemented runtime
fix, maintainer decision or SDK compatibility certificate.

The decision remains solely in [ADR-0102](../decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md)
and [ADR-0103](../decisions/0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md).
Their accepted dependencies are unchanged; clarifications are dated and implementation forward
notes remain approval-gated.

## Findings

No new material finding. Both reviewers verify that the non-cap key refusal explicitly qualifies
the earlier preservation promise and associated tests, keeps cap capture separate, forbids silent
data deletion and identifies migration/approval requirements. Other retained-domain SDK parity,
prototype observations and causal controls remain required. Ownership remains broader than the
unchanged measured subset.

Both verify that real primary-delivery observation corresponds to the shipping queue's two delivery
sites. Gap/abandonment cannot become fictitious consumption; checkpoint-local admission invents no
event. Actor/receipt/deadline registration independently vetoes a paused claim. Terminal-free
detachment qualifies only the old execution's local iterable. Exact-fence receipts, terminal-write
refusal, sticky money/effect disposition, parked-node timing and independent primary consumption
remain consistent across the complete lifecycle proposal.

## Coverage and limits

| Reviewer | Model / effort | Coverage |
| --- | --- | --- |
| Ownership | `gpt-6-astra` / `high` | Complete ADR-0102/0103 and cumulative diff; estimator/cap/native-plan boundary, Gemini adapter and installed SDK generate/stream preparation. |
| Lifecycle | `gpt-6.1-sol` / `high` | Complete ADR-0103/0102 and cumulative diff; accepted lifecycle/stream/deadline ADRs, engine/handle/queue/receipt/checkpoint/tool/CLI paths and canonical contracts. |

Background reads are selective. No exhaustive historical-corpus or sealed-Own/physical-inventory
claim is made. Both reviewers are read-only and perform no tests, provider requests, credentials/
keychain or private local-settings access. Their complete reports distinguish source reachability
from unexecuted SDK HTTP and native lifecycle controls.

Parent verifies both Proposed statuses, all 634 relative links/anchors across the seven touched
Markdown files and the doc-only scope. Prettier and diff
checks pass; lint/typecheck/test passes **23 cached tasks**. No fresh runtime execution, coverage or
final remote-CI result is inferred from those pre-commit checks. Implementation acceptance remains
outstanding.

## Provider prerequisite supplied during this review

The maintainer reports Free Tier and supplies a **Gemini 3.1 Flash Lite** quota row: RPM 15,
input TPM 250,000 and RPD 500, with current usage zero. This is supplied metadata, not an authenticated
project inspection or the quota of the previously probed Gemini 3.5 model.

Google's [model reference](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite) gives
that model an input window of 1,048,576 tokens. The supplied TPM allowance is smaller than the single
request needed to exceed it. Under Google's [quota rules](https://ai.google.dev/gemini-api/docs/rate-limits),
the present same-request overflow plan exceeds that allowance; waiting or splitting the request
does not increase its single-request allowance or produce the same overflow. This is a planning
inference consistent with the earlier captured free-tier 429, not a new provider result. Higher-tier
limits must be checked for the actual chosen model; Paid Tier 1 is not a guarantee. Billing changes
and a new capture plan require separate authorization within the maintainer's spending constraint.

## Follow-ups

Explicit approval remains required for ADR-0102, including the additional non-cap `__proto__`
compatibility narrowing, and ADR-0103's lifecycle/CLI decision. Only then can dependent implementation,
actual SDK/native controls and independent implementation reviews proceed. The implementation Highs,
missing Gemini/Anthropic artifacts, Steps 7–8/12, three unapplied Sonar security dispositions and W7/PR
merge acceptance remain open. No additional paid call, key read, billing change, Sonar disposition
or runtime edit occurs in this follow-up.
