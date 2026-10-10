# Review: W8 preflight and proposed decision, round 3

- **Type**: Code
- **Date**: 2026-10-10
- **Reviewer(s)**: Codex `/root`, `/root/w8_proposal_r3_money`, `/root/w8_proposal_r3_contracts`
- **Subject**: Full W8 documentation proposal, ADR-0104 and both earlier records; `development`, base `f267bb0d4e9a4b4e2b51cb2c44ff744284d5228a`, uncommitted working tree
- **Outcome**: Changes requested — one confirmed pre-first-provider run compatibility gap corrected in the proposal; fresh cumulative review and maintainer approval required

## Coverage

Fresh complete read-only reviewers: `/root/w8_proposal_r3_money` (`gpt-6-astra`, high)
and `/root/w8_proposal_r3_contracts` (`gpt-6.1-sol`, high). Both read the entire proposal,
all current documentation changes and preceding review records against relevant source.
The input snapshot is archived outside the repository. Reviewed ADR SHA-256:
`180d70fc651b863e90271e54290e81fe5011f580310723df696ce9d00a17aacc`.

The money reviewer returned zero findings. Both accepted the pre-egress pending-coverage
correction at decision level; no implementation or runtime crash control was accepted.

## High — a newly complete run can pause before the first replay barrier

The [reviewed ADR](../decisions/0104-unknown-provider-usage-is-durable-cost-uncertainty.md)
permitted new complete-zero owners but introduced its first new discriminator only before
a token-provider invocation. A workflow may first pause at an ordinary human gate.
The contracts reviewer confirmed that this prefix contains only known predecessor events;
the old executable can resume, call without new coverage and append synthetic-zero or
usage-less accounting. Session revision protection does not protect the run log.

Parent verified the ordinary gate/checkpoint paths in [engine.ts](../../packages/core/src/engine/engine.ts)
and [ADR-0075](../decisions/0075-fail-closed-resume-on-an-unreadable-event-log.md)'s
unknown-discriminator replay rule. An unsupported old-runtime limitation alone does not
prevent a later new reader from incorrectly retaining complete coverage.

## Proposed correction and clarification

The draft now requires a content-free, once-per-owner `cost:coverage_started` basis before
complete run coverage or new-contract execution/checkpoint handoff. It covers an ordinary
gate before the first provider invocation. A prefix without the basis is unverified; legacy
history stays unverified; resume cannot reset pending/unknown history to complete zero.
All three new accounting discriminators require real predecessor refusal controls,
including the gate-first new/old/new schedule, lease release and tolerant display.

Parent also made the pending-resolution mechanism explicit: complete-usage settlement uses
the sole existing actual-cost write with invocation correlation. `cost:usage_disposition`
replaces the earlier narrower `cost:usage_unavailable` name, covering incomplete evidence,
proven non-invocation and approved official refusal without fabricating zero usage or money.
This is a proposal clarification, not an additional reviewer-confirmed defect.

## Verification and limits

- `git diff --check` passed. Reviewed input: 12 Markdown files, 1,278 relative links,
  zero missing targets or heading fragments. Accepted ADR-0087 remains byte-for-byte
  intact before its appended factual correction.
- Parent reran `pnpm turbo run lint typecheck test`: 23/23 successful, **11 cached and
  12 executed**. Build previously passed with 6/6 tasks, 2 cached and 4 executed.
- No production edits, new runtime regressions, schema generation, provider calls,
  keychain access, dependency updates or remote CI claims occurred.

## Follow-ups

Obtain fresh full cumulative review of the amended proposal, then maintainer approval
before implementation. The seven-step plan and each step's own two fresh review rounds
remain required. No W8 obligation is closed by this record.
