# Review: W7 bounded native-stop capture and Gemini evidence, round 2

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/w7_capture_v2_round2`
- **Subject**: Capture increment `2f6cf065..6f8dca65` and documentation correction `a36580b7`
- **Outcome**: Approved

## Summary

The fresh cumulative Code/Security review accepts this scoped capture increment. The stale
roadmap finding from [round 1](2026-10-08T19-40-00-w7-capture-v2-round-1-review.md) is resolved.
This permits the explicitly selected bounded probe under the existing maintainer authorisation;
it does not accept missing provider evidence or Steps 7–8.

## Findings

No findings: Blocker 0, High 0, Medium 0, Low 0. Runtime validation retains the 4,096-token
ordinary limit and admits 16,384 only for Anthropic's explicit native-stop purpose. Fixed
endpoints, synthetic input, one-fetch/no-retry/no-redirect policy, deadlines, response bounds,
privacy refusal and destination handling remain intact.

## Coverage and verification

The reviewer used `gpt-6-astra`, high effort, and read the full capture implementation, tests,
CLI runner, runbook, tool README, four fixtures/index, first-round record and cumulative
documentation corrections. Unrelated graph and CLI changes were excluded.

- 54 committed focused tests pass.
- The actual built-command offline smoke passes.
- An independent 112-case runtime matrix passes: 23 admitted, 89 refused; all refusals
  make zero fetch calls and each admission makes exactly one.
- An in-memory predecessor control distinguishes only the explicitly expanded purpose.
- All four fixture SHA-256 values match their index.
- Arithmetic confirms 0.207287 USD for the reported probe usage, and 0.28192 USD for
  200K input plus 16,384 output at the documented rates.

No new dependency, unsafe cast, vendor-seam leak or engine platform import is introduced.
Historical roadmap checkpoints and the current four-of-five boundary are consistent.
The reviewer performed no network/key/private-artifact access, live call, repository edit
or commit. Full repository checks and invoice verification remain Parent/whole-wave obligations.

## Follow-ups

Run at most the separately bounded selected probe with a free count calibration, then inspect
its real stop reason and usage. Retain an unsuitable result privately. Only a genuine
`model_context_window_exceeded` response completes the five-artifact prerequisite.
