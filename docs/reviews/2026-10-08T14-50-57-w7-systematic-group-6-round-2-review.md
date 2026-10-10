# W7 systematic Group 6 — recovered round 2

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/w7_group6_contracts_r2_recovered`, `/root/w7_group6_runtime_r2_recovered`
- **Subject**: PR #90, `bbe0109161a7b620d51f2b444ab0112ba7ef7607..7c29c4621023c3fdb5ddb9877a9c06afe1a43702`; six changed paths and nine textual hunks
- **Outcome**: Changes requested; two findings corrected, fresh round 3 required

## Summary

Both fresh reviewers use `gpt-6.1-sol` with `xhigh` effort. The runtime report's inherited-model wording is inaccurate; actual spawn metadata establishes the explicit selection. Its sealed report is not rewritten. Earlier interrupted round-2 agents and temporary artifacts are unavailable, so their preliminary messages are not counted as completed review evidence. This recovered pair starts from fresh physical source copies.

The committed child-process correction passes the demonstrated native failures. Both reviewers identify the same two remaining issues: missing permanent discriminating failure tests and an unregistered command in the canonical CLI paragraph. Neither demonstrates a residual provider/engine runtime defect in this correction. No Group 6, W7, step or PR acceptance is granted.

## Findings and corrections

1. **High tooling coverage gap in the static review; Medium in the runtime review.** The actual committed normal overflow smoke passes even when immediate non-rejecting error observation or the final close join is removed. Independent native controls fail under those removals, but they were not permanent CI-bound checks. [Testing](../standards/testing.md) requires a bug regression that fails without the fix.

   The private [runner](../../tools/overflow-capture/check-runner.mjs) now serves both the actual maintainer smoke and its [native failure checks](../../tools/overflow-capture/check-runner-smoke.mjs). Five permanent controls exercise native spawn refusal, readiness failure, filesystem failure and controlled setup/stdin faults on actual piped children. They check close before settlement, no unhandled rejection, original native error identity/code and primary fault preservation. Even a deliberately regressed runner is killed and joined before the check asserts, preventing orphan children. Setup/stdin sentinels establish controlled robustness, not ordinary native reachability. No package API, seam, provider request or live capture behaviour changes.

2. **Medium documentation discrepancy.** The prior paragraph names `relavium budget abort`, which has no registered subcommand or alias. Actual command registration, manifest, dispatch and forwarding consistently use `relavium budget resume <runId> --abort`. The [canonical paragraph](../reference/cli/commands.md#local-mcp-servers-need-consent) now uses that form. Only rejected budget decisions skip MCP startup; human-gate decisions retain workflow MCP consent. The dated [round-1 record](2026-10-08T13-20-40-w7-systematic-group-6-round-1-review.md) and its roadmap observation remain historical; this record supplies the correction.

## Independent coverage

Static covers all six paths/nine hunks, the private helper and all nine actual call sites, CLI registration/consent callers, relevant unchanged Group 6 leaves, and current trusted callers of the three S8707-labelled local-harness sites. Both streaming readers still validate persisted rows before filtering the exact four streaming-only event types. Arbitrary callers and hostile same-UID modification are outside the trusted-harness conclusion; no remote Sonar disposition is performed.

Runtime runs five five-case native suites: corrected head, rejecting-error mutation, missing-final-join mutation, restored head and final full-error-identity controls. The rejecting-error mutation produces one unhandled-rejection violation; missing final joining produces four premature-settlement violations. Three actual normal seventeen-child smoke runs all pass, including both mutations, establishing the lasting-coverage finding. The independent old/new synthetic duplicate-secret bytes are identical. CLI/MCP review is static here, without a repeated SQLite/MCP integration run.

## Complete Parent audit and limits

Both complete reports are read before Root changes: static **21,365 bytes**, SHA-256 `73eeb78d8caf5bc6b5a82e247acd33e204619c1e027fb912ad4c3242bee29344`; runtime **20,069 bytes**, SHA-256 `359ea357ebe6b3200ace36012cbdcc21ee76df106d8be67fd6f3f925d3a3067d`.

Physical audits verify static **1,315 entries / 1,198 regular files / 117 directories / zero links** and runtime **2,033 entries / 1,873 regular files / 159 directories / one internal workspace link**. Complete regular unions, external self-bindings, all nineteen available numeric fields, source/Git identity and copied build/dependency pins pass. Runtime has observation-only atime differences; all other fields and bytes match. Both Owns remain sealed and permanently retired. Parent neither executes nor changes them.

Semantic audits authenticate the exact actual Git correction patch, static read/scan ranges and file hashes, all 56 runtime read/span receipts, 25 command start/end pairs and nine native invocations with captured exits/output. Raw guard evidence contains seventy ready instances, 910 denial probes, 2,370 source-load events, 71 native spawn/close pairs and five controlled native spawn refusals. Source loading follows readiness/probes. Only the final five source-load events retain byte snapshots; earlier 2,365 events attest URL and ordering. Instrumentation is not an OS sandbox.

The runtime smoke copies existing built adapter/shared artifacts and zod rather than independently compiling them; it makes no source/output equivalence claim. The initial audit-helper version is reconstructed later with its exact recorded hash, not retained contemporaneously. Static receipts contain complete-file digests/ranges rather than separate span hashes or full stdout captures. Bootstrap mode omission, initial preparation/audit failures, oversized displays and bounded rereads are preserved as qualifications. Original cumulative Group 6 hunks and historical remote registries are not re-adjudicated by this narrow pair.

## Root verification and follow-ups

After all four Parent audits, the new actual `pnpm smoke:overflow-capture`, `pnpm lint:tools`, configured `pnpm typecheck:tools` and `git diff --check` pass. The configured typecheck programme does not include every MJS helper. In a fresh private copy, the same smoke/imported runner fails when error observation is changed back to a rejecting promise, and separately fails when final close joining is removed. Exact restoration passes before and after both mutations. Two incomplete Parent copy preparations are retained and excluded; the successful copy verifies the built closure and required package metadata. These are synthetic offline controls, with no provider/key access or paid call.

Full Root `pnpm run ci` also passes: **373 files / 8,398 passing tests / eleven skips**, all 23 initial tasks uncached, followed by seven build/format tasks with five cached builds and every mandatory offline smoke. Required GitHub CI at `7c29c462` passes separately. Sonar and final-head CI/coverage remain open checks. Fresh independent round 3 must review the correction and permanent controls before Group 6 acceptance. [ADR-0102](../decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md) and [ADR-0103](../decisions/0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md) remain Proposed without maintainer approval. Provider evidence, Steps 7–8/12, Group 3's lifecycle High and final W7/PR acceptance remain open.
