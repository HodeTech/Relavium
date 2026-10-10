# Review: W7 bounded native-stop deadline, round 1

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/w7_capture_v4_round1`
- **Subject**: `44da68dc..b111a72f`, four capture paths on `development`
- **Outcome**: Approved

## Summary

The first fresh Code/Security review accepts the scoped v4 deadline correction. A second
fresh review remains required before one explicitly chosen live probe. The fifth genuine
fixture, Steps 7–8 and whole-wave acceptance remain open.

## Findings

No findings: Blocker 0, High 0, Medium 0, Low 0. Runtime validation precedes controller,
timer and egress. Only validated Anthropic native-stop purpose gets 180 seconds; ordinary
captures and stdin retain their separate 60-second bounds. One response deadline covers
headers and every body read without renewal.

## Coverage and verification

The reviewer used `gpt-6.1-sol`, high effort, read the complete four-file diff and surrounding
runner/deadline seams, repository guidance, relevant standards and prior capture records.
Review completed at 2026-10-08 20:17:30 UTC on `b111a72f`.

- 67 focused tests and the existing native-command offline smoke pass.
- Twelve additional native-command controls pass: five stalled-header cases, five delayed
  headers with dribbled bodies, a late successful probe and a forged Gemini purpose.
- The harness records exact 60,000/180,000-ms timer inputs while scaling native execution
  to 50/150 ms. It does not claim a real three-minute wait. Valid controls make one synthetic
  fetch, abort transport and clear timers; stalled bodies cancel once without awaiting
  uncooperative cancellation.
- Fifteen invalid/forged runtime controls refuse before controller, timer or fetch creation;
  a valid 64-token Anthropic native-stop probe selects 180,000 ms.
- The four committed fixture bodies/hashes match their index. Diff whitespace checks pass.

Fixed endpoints, synthetic request/prefix, output/input/response limits, secret refusal,
safe diagnostics and no retries are preserved. Documentation retains the unsuitable empty
v3 timeout result and makes no native-stop, completion or invoice guarantee. No new dependency,
unsafe cast, SDK seam leak or platform-boundary change is introduced.

No provider calls, key access, private-artifact reads or repository edits occurred. Temporary
synthetic harness files were removed. Full repository checks and unrelated factory/CLI work
were excluded; Parent's restored 23-task gate and six builds are separate implementation evidence.

## Follow-ups

Fresh round 2 must cover this cumulative increment before a paid call. Keep the timeout's
maximum charge reserved and the renewed 2 USD authorisation intact; only a suitable genuine
response can establish native context-stop evidence.
