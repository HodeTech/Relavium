# W7 systematic group 2a, round 1

- **Type**: Code
- **Date**: 2026-10-04
- **Reviewer(s)**: `/root/w7_group2a_round1_runtime`, `/root/w7_group2a_round1_contracts`; parent `/root`
- **Subject**: `development`, `90a5eee8..885bffc9`, all six changed paths
- **Outcome**: Changes requested; one new High and one Low corrected, fresh round 2 required

## Summary

Two independent reviewers inspect the complete cap-refusal, structural tool-recording,
native-JSON portability and approved default-failover correction. The intended repairs
have meaningful causal evidence, but both reproduce a new session-accounting regression.
The parent corrects it in `13d3c0fe` and the normalizer comment in `7839647f`.
Fresh complete round 2 must assess those corrections before this group closes.
The separate measured-request ownership High remains open under
[Proposed ADR-0102](../decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md).

## Findings and correction

**High — successful-tool observer failure loses engagement and real terminal usage.**
Moving observer emission outside registry dispatch recovery permits a raw exception to
bypass the [turn accumulator](../../packages/core/src/engine/agent-turn.ts). A real
[AgentSession](../../packages/core/src/engine/agent-session.ts) then reports zero tokens
for billed work and accepts another provider call despite `maxTurns: 1`. Both successful
observer sites reproduce this; the runtime reviewer additionally crosses read/effect tools.
Reversing only the agent-turn production hunk restores real usage and blocks the second call.
That broad catch is a causal control, not the final repair: it revives the structural bug.

The correction classifies only successful-tool observer exceptions with a fixed, nonretryable
`internal` message. The existing EA2 wrapper attaches authoritative engagement and accumulated
usage. Registry failures retain their separate recovery boundary, cancellation wins, no private
observer cause enters events, and neither a duplicate call nor a later effect runs.
[Six permanent actual-session controls](../../packages/core/src/engine/session-tool-observer.test.ts)
cover both observer sites, read/effect accounting, the hard cap and cancellation. Before the
repair, four controls demonstrate excess provider/credential calls; after it, all six pass.
An initial fixture omitted required `system_prompt` and collected no tests; it is retained
as a failed setup attempt and contributes no defect verification.

**Low — normalizer comment omits typed local cap refusal.** The
[fallback normalizer](../../packages/llm/src/fallback-chain.ts) comment now describes its fatal
`bad_request` arm as well as provider errors and unknown throws. No runtime behaviour changes.

## Coverage and integrity

Runtime uses `gpt-6-astra`, `ultra`; contracts uses `gpt-6.1-sol`, `xhigh`. Each receives a fresh
physical source with 1,094 pinned files, 79 named links and 11 internal canonical Own targets.
Both read every changed mechanism and relevant callers/contracts, run 248 permanent tests,
and add separate guarded boundary, effect, privacy and cancellation controls. The runtime
reviewer's earlier direct-observer probes missed the downstream session consequence; its final
report explicitly supersedes the initial clean draft with independently verified HEAD/base/HEAD
session evidence. The contracts reviewer also records its corrected private fixture/type errors.
Neither reviewer claims a complete semantic read of all historical ADRs or older test bodies.

Each runtime denies native credentials and live network in the main process and every worker,
proves Own package resolution, and builds shared, llm, core, db and mcp in order before tests.
Exact source/link restoration and all bootstrap pins pass before full release. After reading
both complete final reports, the parent verifies **every** sealed entry, all source pins,
79 literal targets/manifests and 11 internal targets against unchanged `885bffc9`. Neither
sealed root is executed or mutated. Original source freeze ends after both checks pass.
The parent's initial inventory validator schema assumptions fail explicitly; corrected validators
compute the released directory and symlink conventions and then exhaustively pass.

| Reviewer | Sealed records | Report bytes / SHA256 | Inventory bytes / SHA256 |
| --- | ---: | --- | --- |
| Runtime | 1,802 | 52,464 / `2cad587e7f3fc894386c25c305d84847a20528bdd38084ec12b45877cd98b93b` | 373,862 / `164e38baf6f1c42934e05e9a4302d98883f14d13a253456c7add826c03760b2a` |
| Contracts | 1,811 | 17,767 / `33c4182d6067196b17ac92afd23fe797316d165301420e8ba089d42b33d4aeb7` | 405,499 / `b46737302ed2a2dfe65bf48d5538b23359fa1a99754683c48356bc9546f081ea` |

## Follow-ups

Parent correction checks pass: 359 focused tests; forced root lint/typecheck/test, 23 tasks,
330 files, 7,569 passing tests and 12 skips; forced build, six tasks; standards and diff checks.
The first full run finds the new async-generator fixture's missing await; its corrected full
rerun passes. These checks support the parent repair and do not substitute for fresh review.
No live call is authorized or made. ADR-0102 approval and ownership implementation, remaining
systematic groups, Steps 7–8, whole Step 12, Sonar adjudication and PR acceptance remain open.
