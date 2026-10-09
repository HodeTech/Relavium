# Review: W7 Sonar producer-entry dispositions

- **Type**: Code + Security
- **Date**: 2026-10-09
- **Reviewer(s)**: `/root`; independent `/root/raw_producer_r1_authority`, `/root/raw_producer_r1_lifecycle`
- **Subject**: four S4822 labels at PR #90 exact `fde3ca0c`
- **Outcome**: Four scoped false positives applied and separately read back; the genuine public-return High requires correction

Each reviewer and Parent inspect the specific source and producer/observer controls.
The four try blocks deliberately catch synchronous factory or retainer invocation faults;
they do not purport to consume asynchronous Promise rejection. Returning exact raw work is
required by [ADR-0103](../decisions/0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md).
Awaiting or replacing that Promise can alter lifetime identity and fault provenance. The
concrete abrupt-generator-return defect remains a separate confirmed finding in
[raw-provider round 1](2026-10-09T02-36-10-w7-raw-producer-round-1-review.md).

| Sonar key | Exact source | Individual disposition / API update time (UTC) |
| --- | --- | --- |
| `AaEeaMTt58487nkWg4Bb` | `agent-turn.ts:1380` | Inner synchronous factory marker preserves provider origin; `2026-10-09T02:23:35Z`. |
| `AaEeaMnT58487nkWg4Bc` | `fallback-chain.ts:1463` | Outer synchronous retainer boundary distinguishes exact factory-origin throw; `2026-10-09T02:24:56Z`. |
| `AaEeaMnT58487nkWg4Bd` | `fallback-chain.ts:1465` | Inner factory marker intentionally leaves later rejection provider-origin; `2026-10-09T02:26:13Z`. |
| `AaEeaMnT58487nkWg4Be` | `fallback-chain.ts:1485` | Cleanup async rejection already has `closing.catch`; sync entry refusal stays distinct and cleanup unbounded await is forbidden; `2026-10-09T02:27:40Z`. |

Parent follows the [code-review durable-note procedure](../../.claude/skills/code-review/SKILL.md)
and the earlier [observer disposition precedent](2026-10-08T21-49-00-w7-sonar-observer-disposition-review.md),
applying each issue-specific judgment through the existing authorised Sonar UI session.
Each explanatory comment is specific to that boundary. Sharing comments with Sonar for
analyser improvement is explicitly unchecked. No global rule, source/scanner suppression,
security protection, access grant or branch requirement changes.

Visible UI confirms each False positive state. Separate public PR-scoped API reads independently
return `RESOLVED`, `FALSE-POSITIVE`, `issueStatus: FALSE_POSITIVE` for each exact key.
The gate API after all four returns `OK`: reliability/security/maintainability ratings 1,
duplication 0.2%, reviewed hotspots 100%. Initial empty API selections omitted component scope;
those results are retained and never credited as successful readback. Correct PR/component
scope produces the explicit records. The separate API unresolved inventory is 201; the separate GitHub exact-head Sonar check
is completed/success. These receipts are separate observations, not inferred from UI status
or historical review.

These decisions do not accept the new provider/native increment, certify coverage percentages,
erase the verified High, or close Step 8/12/W7. Changed future source requires fresh analysis.
