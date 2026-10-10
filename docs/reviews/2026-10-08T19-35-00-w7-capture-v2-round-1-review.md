# Review: W7 bounded native-stop capture and Gemini evidence, round 1

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/w7_capture_v2_round1`
- **Subject**: `2f6cf065..6f8dca65` on `development`
- **Outcome**: Changes requested

## Summary

One Medium documentation finding is confirmed and corrected. The capture implementation
has no independently verified security or correctness finding; fresh cumulative review is
required before the larger paid probe.

## Findings

The live [roadmap summary](../roadmap/current.md) still said three artifacts and missing Gemini
evidence. The latest approval checkpoint also described two missing records and no newly
authorised call. The committed exact Gemini body and fixture index establish four artifacts.
The Parent updates the live summary and appends a dated execution/evidence correction to both
roadmap homes, preserving the historical approval checkpoint.

## Coverage and verification

The fresh reviewer used `gpt-6.1-sol`, high effort, and read all six changed files in full,
review guidance, the runbook/tool README, ADR-0096 and relevant standards.

- 54 focused capture tests pass.
- The actual built-runner offline smoke passes.
- An additional 72-case provider/purpose/cap matrix passes: 12 admitted, 60 refused,
  with zero fetch calls on every refusal.
- A read-only in-memory predecessor control confirms that `2f6cf065` refuses the 16,384-token
  native-stop probe, head admits it, and both refuse an ordinary capture at that cap.
- All four committed fixture SHA-256 values match their index.

The existing fixed endpoints, one-fetch/no-retry/no-redirect policy, absolute deadline,
response bounds and cancellation cleanup remain intact. Runtime construction revalidates
purpose and output bounds. The runbook's approximately 0.282 USD maximum Haiku token estimate
matches its stated [published rates](https://platform.claude.com/docs/en/about-claude/pricing).
No new dependency, unsafe cast, vendor/platform leak or secret persistence path is introduced.

The reviewer did not inspect private artifacts or keys, perform live calls, verify an invoice,
or edit files. Independent tests do not establish Anthropic native-stop behaviour. Parent
previously ran the full lint/typecheck/test/build and offline smoke successfully for this
increment; this review does not independently repeat whole-wave CI or coverage.

## Follow-ups

Fresh round 2 reviews the cumulative capture and documentation corrections. Only after it
passes may a separately bounded, manually selected probe run under the existing 2 USD
authorisation. Four fixtures alone do not accept Steps 7–8, and no missing provider evidence
is replaced by synthetic test data.
