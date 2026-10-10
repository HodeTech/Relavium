# Review: W7 factory structural stress allowance, round 1

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/w7_factory_stress_r1`
- **Subject**: `85f57c81..4878e4ee`, one test file; correction `56e42850`
- **Outcome**: Changes requested; verified formatting finding corrected, fresh round 2 required

## Summary

The exact published `85f57c81` PR and push jobs both fail the factory's 15,000-layer
structural test on its default five-second allowance. The correction retains the entire
graph and assertions, adding an explicit 30-second test allowance. Independent review
finds a formatting defect, with no behavioural finding.

## Findings

**Blocker — `request-ownership.test.ts:543`: unstable argument/comment formatting.**
The first formatter pass left the comment between the callback and timeout argument.
The pinned formatter's next pass moves it after the call, so required formatting would
fail. Parent independently reproduces the mismatch and verifies that the second output
is stable. `56e42850` applies that exact output; format and diff checks pass. No graph,
assertion, timing value, global timeout or runtime source is changed by this correction.

## Coverage and verification

The fresh reviewer used `gpt-6.1-sol`, high effort, read the complete one-file diff,
CLAUDE.md, the code-review procedure and ADR-0102's structural obligation. The predecessor
already matched formatter output; the correction introduced only this formatting mismatch.
Independent `CI=true` testing passes 76 tests across ownership and inert-data suites
in 1.18 seconds. Parent separately passes all 110 ownership/inert/cap tests under `CI=true`.
These local results do not establish shared-runner timing or full CI acceptance.

The actual failed [PR job](https://github.com/HodeTech/Relavium/actions/runs/37840902095/job/113529713009)
and [push job](https://github.com/HodeTech/Relavium/actions/runs/37840892972/job/113529678664)
each report 1,304 passing LLM tests, eleven skips and this one timeout. The push records
13,469 ms for the case. These are observations, not a proven runner-contention root cause.
ADR-0102 requires nonrecursive, alias-preserving structural traversal; it claims no
five-second latency guarantee. The 15,000-layer/100-level graphs and their assertions remain intact.

The reviewer makes no edits, provider calls, key/private reads or broad CI reruns, and
excludes parallel Step 7/lifecycle edits. All findings are independently verified before
the corrective commit. Fresh complete review of this small correction remains required.
