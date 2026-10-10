# Review: W8 preflight and proposed decision, round 1

- **Type**: Code
- **Date**: 2026-10-10
- **Reviewer(s)**: Codex `/root`, `/root/w8_stream_preflight`, `/root/w8_usage_preflight`, `/root/w8_wire_preflight`, `/root/w8_proposal_r1_money`, `/root/w8_proposal_r1_contracts`
- **Subject**: W8 preflight and Proposed ADR-0104; `development`, base `f267bb0d4e9a4b4e2b51cb2c44ff744284d5228a`, uncommitted documentation proposal
- **Outcome**: Changes requested — one confirmed proposal High corrected in the working draft; fresh cumulative review and maintainer approval required

## Summary

W8 has three open obligations: ADR-0087 §1's unpulled stream loss, CR-81's canonical
request oracle and CR-82's unknown usage. CR-80 is already closed. The proposed
[seven-step plan](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md#w8-preflight-and-proposed-execution-plan--2026-10-10)
retains W7's reader/receipt authority and the existing exact-capacity residual. No
production code, schema or fixture has changed; no implementation acceptance is claimed.

CR-82 needs an explicit compatibility decision. [Proposed ADR-0104](../decisions/0104-unknown-provider-usage-is-durable-cost-uncertainty.md)
proposes one usage-evidence value, complete-only pricing, durable uncertainty without
a cap, additive coverage and qualified totals. The first proposal review found that
protecting run replay and documenting old session display did not protect old session writes.

## Coverage

- Three read-only source preflights: stream/lifecycle — `/root/w8_stream_preflight`
  (`gpt-6-astra`, high); usage/accounting — `/root/w8_usage_preflight`
  (`gpt-6.1-sol`, high); request conformance — `/root/w8_wire_preflight`
  (`gpt-6.1-sol`, high).
- Two new read-only proposal reviewers: money/replay/legacy/media —
  `/root/w8_proposal_r1_money` (`gpt-6-astra`, high); stream/API/canonical-wire/docs —
  `/root/w8_proposal_r1_contracts` (`gpt-6.1-sol`, high). Both reviewed the full ADR,
  plan and all nine documentation changes, comparing the proposed obligations to source.
- Relevant Accepted ADRs, canonical seam/event/runner/session/database contracts,
  CLI projections, repository skills and standards. This is scoped preflight,
  not a repeat acceptance audit of every historical W7 claim.

## Findings and disposition

### High — predecessor session writes can leave new coverage falsely complete

The initial ADR only described an old executable's inability to display coverage.
[session-store.ts](../../packages/db/src/session-store.ts) updates legacy money/call
columns without future coverage metadata. [session-resume.ts](../../packages/core/src/engine/session-resume.ts)
has no executable-version refusal. A new complete-zero owner can therefore receive
an old writer's synthetic-zero call and later appear complete/free to the new reader.
One-time legacy migration and preserved conservative columns do not prevent that schedule.

Parent verified the cited writer/resume paths. The working proposal now requires
DB-maintained mutation revisions, atomic new-writer acknowledgements, sticky legacy
taint and actual new/old/new executable controls. It explicitly disclaims old-runtime
budget enforcement and calls for which an old executable left no durable trace.
This is a proposed correction; the mechanism is not implemented or runtime-tested.

### Factual correction — parked readiness does not reserve queue capacity either

The earlier ADR-0087 correction already disclosed immediate readiness overshoot, but
incorrectly described parked producer wakes as capacity-reserving. Parent's actual-source
probe confirmed both: capacity 4 with eight immediate producers reached depth 11;
capacity 2 with six parked producers and two immediate pulls woke three and reached
depth 3. The appended [ADR-0087 correction](../decisions/0087-consumed-streams-size-bounds-and-run-retention.md#w8-preflight-correction--2026-10-10)
and live deferred register now state both schedules. This does not close or expand
the existing separately approved capacity residual.

### Documentation corrections and optional strengthening

The LLM README no longer calls shipped adapters future work. The testing standard
qualifies response seeds, syntax-only replay and live-smoke coverage. The event contract
links to the shipped public departure result. The phase's obsolete item count is corrected.
Future evidence/schema definitions remain unlanded while ADR-0104 is Proposed.

The contracts reviewer reported no confirmed proposal blocker. Its optional credential
projection clarification was adopted: stored expected exchanges must exclude auth headers
and credential URL fields, with planted-secret rejection controls.

## Verification and limits

- `git diff --check` passed. Reviewer checked relative link file targets in all nine docs;
  full final proposal link/anchor validation remains a publication check.
- Parent ran `pnpm turbo run lint typecheck test`: exit 0, 23/23 successful, **all 23 cached**.
  This establishes available baseline gates, not fresh execution of the replayed tests.
- Parent transpiled the actual queue source in memory and ran three external probes:
  unpulled terminal loss, immediate-producer overshoot and parked-producer overshoot.
  They reproduced the existing defects; they are not permanent regressions or causal
  implementation acceptance. Logs/scripts are outside the repository under the W8 evidence directory.
- No live provider call, keychain access, dependency update, production edit, paid capture,
  implementation test or remote CI acceptance occurred.

## Follow-ups

Obtain fresh cumulative reviews of the corrected proposal, then maintainer approval
of ADR-0104 and the plan before dependent implementation. Each implementation step
still requires its own commits, two fresh complete review rounds and actual acceptance evidence.
