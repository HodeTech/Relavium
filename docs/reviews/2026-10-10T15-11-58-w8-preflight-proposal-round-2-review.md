# Review: W8 preflight and proposed decision, round 2

- **Type**: Code
- **Date**: 2026-10-10
- **Reviewer(s)**: Codex `/root`, `/root/w8_proposal_r2_money`, `/root/w8_proposal_r2_contracts`
- **Subject**: Complete corrected W8 documentation proposal, Proposed ADR-0104 and round-one record; `development`, base `f267bb0d4e9a4b4e2b51cb2c44ff744284d5228a`, uncommitted working tree
- **Outcome**: Changes requested — one Parent-confirmed pre-settlement crash gap corrected in the proposal; fresh cumulative review and maintainer approval required

## Coverage

Two new read-only reviewers inspected the entire cumulative proposal and relevant actual
source: money/replay/legacy/media — `/root/w8_proposal_r2_money` (`gpt-6-astra`, high);
stream/API/wire/contracts/docs — `/root/w8_proposal_r2_contracts` (`gpt-6.1-sol`, high).
The input snapshot is archived outside the repository in the W8 evidence directory;
its manifest records SHA-256 per document and the tracked diff. This is a working-tree
proposal review, not a commit-pinned implementation review.

Both reviewers accepted the proposed correction for predecessor session writes: database
mutation revisions, atomic acknowledgement, sticky taint and executable round-trip controls.
No new stream, canonical-wire, native-media or actual-money arithmetic defect was reported.

## High — settlement-only uncertainty does not cover a crash during invocation

The reviewed [ADR-0104](../decisions/0104-unknown-provider-usage-is-durable-cost-uncertainty.md)
started uncertainty persistence only at settlement while promising crash/reopen coverage
and complete-zero coverage only in the absence of a potentially billable attempt.

The contracts reviewer identified a process death after provider invocation but before
settlement. [agent-turn.ts](../../packages/core/src/engine/agent-turn.ts)'s pre-attempt
barrier only joins prior money writes. The [session persister](../../apps/cli/src/chat/persister.ts)
stages user input until completion. Current capped admissions are process-local too;
neither capped nor uncapped execution necessarily leaves current-attempt coverage.
Parent verified these paths and ADR-0074's distinction.

The money reviewer independently noticed the same boundary but classified it as an optional
clarification of ADR-0070 §3 exception 5's accepted unsettled-crash limitation, returning
zero approval-level findings. Parent chose to close the proposal gap rather than silently
infer that limitation from the broader new coverage promise. This does not mean the money
reviewer accepted a later amended design.

## Proposed correction and disposition

ADR-0104 now requires a coverage-only `cost:usage_pending` marker, acknowledged before
eligible token-provider invocation with or without a cap, and correlated authoritative
settlement. An unmatched marker remains uncertain across process death. It asserts neither
a billed call nor an amount, does not create a reservation or recover allowance, and does
not change the single ownership of actual-money writes. Skips and proven non-invocation,
idempotence, dispatch/round/failover identity, late receipts, volatile embedding limits and
bounded pending session state are explicit.

The plan now includes the durability cost and actual child-process death controls, including
uncapped sessions, capped runs, failover/summariser calls and both new-event predecessor
refusals. The ADR will add a dated ADR-0070 refinement on landing. No runtime implementation
or crash test has been performed; another fresh complete proposal review is required.

## Verification and limits

- Both reviewers ran `git diff --check` successfully. The contracts reviewer checked
  all 35 newly introduced relative links and anchors in its input.
- Parent's broader input check covered 11 changed/new Markdown files and 1,273 relative
  links: zero missing targets or heading fragments. Subsequent amendments need rechecking.
- `pnpm turbo run build` passed: 6/6 tasks, 2 cached and 4 executed. No production source
  changed. Baseline lint/typecheck/test passed with all 23 tasks cached, as qualified in
  [round 1](2026-10-10T15-06-52-w8-preflight-proposal-round-1-review.md).
- No live provider call, credential access, schema generation, dependency update, remote
  CI acceptance, production edit, permanent regression or causal mutation was performed.

## Follow-ups

Review the amended proposal cumulatively with fresh agents. Obtain maintainer approval
before dependent code. W8's three implementation obligations and all implementation
review/acceptance gates remain open.
