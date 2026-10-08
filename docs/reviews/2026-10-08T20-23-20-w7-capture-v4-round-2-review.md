# Review: W7 bounded native-stop deadline, round 2

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/w7_capture_v4_round2`
- **Subject**: `44da68dc..b111a72f`, four capture paths; round-1 record/index at `345039b4`
- **Outcome**: Approved

## Summary

The second fresh Code/Security review accepts the bounded v4 deadline correction. One
explicit live probe may proceed within the renewed 2 USD limit. Offline approval does
not establish the missing native provider response, an invoice or Steps 7–8 acceptance.

## Findings

No findings: Blocker 0, High 0, Medium 0, Low 0. Purpose validation, one absolute response
deadline, cancellation and cleanup preserve their boundaries. Ordinary captures keep
60 seconds; only the validated Anthropic native-stop purpose gets 180 seconds.

## Coverage and verification

The reviewer used `gpt-6.1-sol`, high effort, reviewed the complete four-path increment,
surrounding runner/shared deadline, tooling README, ADR-0096 and the complete first record.

- 67 focused tests and the existing native-command offline smoke pass.
- Thirty-six additional actual-command synthetic controls pass: ordinary provider parity,
  stalled headers, delayed/dribbled bodies, late probe success versus ordinary timeout,
  cancellation, chunk/byte limits, invalid UTF-8, decoded duplicate-member secrets,
  transport-error privacy, destination replacement, argument refusal, existing destination
  and stalled stdin.
- Native controls record exact 60,000/180,000-ms timer inputs while scaling execution to
  80/240 ms. Header/body progress never replaces the deadline. Transport abort, timer
  disposal and signal-handler removal are observed; uncooperative body cancellation
  does not hold completion. No real three-minute test is claimed.
- Sixteen invalid runtime controls refuse before controller/timer/fetch creation. Five
  valid purpose/cap controls preserve the two deadline bounds independently of output size.
- Four fixture hashes match their index. Diff whitespace checks pass and the tree is unchanged.

Fixed endpoints, request/prefix, caps, one fetch, no retries, safe diagnostics and v4
provenance are preserved. No dependency, seam, engine-purity or unsafe-type change occurs.
The reviewer independently checked official prefilling/context-stop documentation, Haiku
rates and the potential billing of a client timeout; the [runbook](../runbooks/capture-provider-overflow.md)
links those sources. Its unsuitable v3 result and four-of-five evidence boundary remain honest.

No provider calls, key access, private-artifact reads, source edits or full repository
reruns occurred. Temporary synthetic harness files were removed. Unrelated factory and
CLI work and invoices were excluded.

## Follow-ups

Retain the timeout's full maximum charge reservation. Inspect any new real artifact in
full before accepting its bytes; only `model_context_window_exceeded` completes the fifth
record. Unsuitable results remain private and introduce no automatic paid retry.
