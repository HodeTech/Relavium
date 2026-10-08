# Review: W7 synthetic prefilled native-stop probe, round 2

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/w7_capture_v3_round2`
- **Subject**: `88d774de..0d5ed372`, four capture paths on `development`; the single status correction in `bdd0c9c1`
- **Outcome**: Approved

## Summary

The second fresh Code/Security review accepts the bounded v3 capture increment. It does
not establish a native provider stop or close Steps 7–8. A genuine Anthropic response
carrying `model_context_window_exceeded` remains the fifth required record.

## Findings

No findings: Blocker 0, High 0, Medium 0, Low 0. Ordinary requests remain identical to
their predecessor. The fixed continuation and assistant prefix apply only to validated
Anthropic native-stop purpose; transport, output bounds and secret refusal are preserved.

## Coverage and verification

The reviewer used `gpt-6.1-sol`, high effort, read all four changed files in full (735
lines, 25 additions / eight deletions), complete prior capture records, repository guidance,
relevant standards, the runner and smoke harness, and ADR-0096's live-evidence requirements.
The single phase-plan status correction was checked against the four-fixture index and
current roadmap; no review of the entire phase plan is claimed.

- 54 committed focused tests and the actual built-command offline smoke pass.
- A fresh built-module matrix passes 432 cases: 34 admissions make exactly one fetch,
  and 398 refusals make zero. Fourteen invalid runtime-object cases also make zero fetches.
- Eighty actual native-command cases pass: 55 wire/admission/input-bound controls,
  20 response/failure/status controls and five exact authentication-header controls.
- Eight ordinary controls preserve exact v2 request parity across all four providers at
  minimum and maximum input sizes. Five explicit-purpose controls distinguish the v3
  continuation/prefix; all 13 source-to-built comparisons match.
- All four committed fixture hashes match their index. Scoped whitespace checks pass;
  the documented maximum token estimate calculates to 0.28192 USD.

Native-command controls cover fixed URLs and headers, redirect refusal, non-streaming
bodies, provider cap dialects, input and response limits, chunk bounds, split and invalid
UTF-8, malformed/missing bodies, raw and escaped credential refusal, transport errors,
timeout and SIGTERM. HTTP 200/401/429/500 controls each make one request without retry.

All additional responses were synthetic offline data. Supplemental timeout controls
shortened the timer through a test preloader; committed fake-timer tests independently
verify the configured 60-second deadline. An initial supplemental harness import assumed
root-level Zod resolution and failed; only the successful workspace-aware rerun is counted.

No network/provider/key/private-artifact access, repository edit, commit or full repository
command occurred. External prefilling documentation, private probes, invoices and Parent's
full repository checks were not independently reverified. Unrelated ownership and CLI
work were excluded.

## Follow-ups

One reviewed live probe may proceed within the renewed 2 USD authorisation. Prefilling
does not guarantee a native stop. Retain unsuitable results privately; do not substitute
synthetic evidence or infer Steps 7–8 or whole-wave acceptance from this tool review.
