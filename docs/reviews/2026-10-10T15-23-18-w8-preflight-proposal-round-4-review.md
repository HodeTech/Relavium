# Review: W8 preflight and proposed decision, round 4

- **Type**: Code
- **Date**: 2026-10-10
- **Reviewer(s)**: Codex `/root`, `/root/w8_proposal_r4_money`, `/root/w8_proposal_r4_contracts`
- **Subject**: Complete cumulative W8 documentation proposal, ADR-0104 and seven-step plan; `development`, base `f267bb0d4e9a4b4e2b51cb2c44ff744284d5228a`, uncommitted working tree
- **Outcome**: Approved — proposal ready for maintainer decision; ADR remains Proposed and implementation is not authorized or accepted by this review

## Coverage

Two new complete read-only reviewers inspected all thirteen input Markdown files, the full
ADR and plan, and the three historical proposal records: money/seam/replay/lifecycle —
`/root/w8_proposal_r4_money` (`gpt-6-astra`, high); stream/API/wire/contracts/docs —
`/root/w8_proposal_r4_contracts` (`gpt-6.1-sol`, high). Both compared the design to relevant
actual source and Accepted ADRs. Reviewed ADR SHA-256:
`6e54b2acecd368a010e3eece071330433fd1b05839f9015d84a98f45c2ac9106`.

## Findings

Both reviewers returned **zero confirmed findings**. The cumulative proposal is coherent
at decision level; this is not runtime acceptance.

- Stream modes preserve W7's actual-reader/receipt authority, typed misuse, terminal metadata
  and pre-handle liveness. The separately approved exact-capacity residual stays disclosed.
- CR-81 requires an independent static canonical oracle through installed SDK HTTP, safe
  exchange projection/exhaustion and three actual production-lowering mutations.
- ADR-0104 distinguishes complete, partial and missing evidence, retaining complete-only
  pricing, actual/conservative separation, native-media basis and qualified totals.
- A once-per-owner run basis covers ordinary-gate handoff before a provider call. Pending
  coverage is acknowledged before cap/no-cap egress; its identity spans dispatch, rounds and
  chain attempts. Complete settlement uses the existing actual-cost writer; other dispositions
  do not fabricate zero usage, charges or recovered allowance.
- Session mutation revisions/atomic acknowledgements preserve sticky legacy taint after
  observable predecessor writes. All three new discriminators have executable refusal
  obligations, including gate-first and pending-only prefixes, lease release, genuine legacy
  positives and tolerant display.
- Registered late receipts remain fenced and idempotent; published terminal payloads remain
  immutable. Staging must stay green and honest, or remain atomic with a concrete explanation.

## Verification and limits

Both reviewers ran `git diff --check`. The contracts reviewer validated 1,282 relative
link targets across thirteen input files, with zero missing targets; it did not independently
validate heading fragments in this round. Parent's final publication check covers the
additional review/index entry and heading fragments separately.

Parent's gates passed: lint/typecheck/test 23/23 tasks, 11 cached and 12 executed;
build 6/6 tasks, 2 cached and 4 executed. No production source changed. External preflight
source probes reproduced existing stream defects; they do not count as implementation
regressions. No paid/live calls, credentials, dependency updates, new migrations, remote CI
acceptance or causal implementation controls occurred.

## Follow-ups

Maintainer must approve [ADR-0104](../decisions/0104-unknown-provider-usage-is-durable-cost-uncertainty.md)
and the [execution plan](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md#w8-preflight-and-proposed-execution-plan--2026-10-10)
before dependent code. Each implementation step retains its own commits, two fresh cumulative
review rounds and actual regression/causal evidence. W8 remains open.
