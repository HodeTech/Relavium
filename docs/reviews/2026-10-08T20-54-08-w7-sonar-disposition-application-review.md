# Review: W7 reviewed Sonar dispositions applied

- **Type**: Security
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root`
- **Subject**: PR #90; three previously reviewed caller-scoped proposals, public API readback
- **Outcome**: Three false-positive dispositions verified; whole-wave acceptance remains open

## Applied decisions

The [Group 6 round 3 review](2026-10-08T15-45-57-w7-systematic-group-6-round-3-review.md)
and its [exact proposals](2026-10-08T15-45-57-w7-sonar-security-disposition-proposals.json)
remain historical records. This new record captures their subsequent application through
the authorised Sonar session. The repository's
[code-review procedure](../../.claude/skills/code-review/SKILL.md) supplies the durable-note
workflow. No global rule, scanner setting, source suppression or security protection changes.

| Issue | Source/caller judgment | API update time (UTC) |
| --- | --- | --- |
| `AaEF8m6AQEO5fzLFYNCw` | The CLI smoke passes its private `mkdtemp` fixture HOME to `mkdir`; no model/workflow pathname reaches the operation. | 20:44:16 |
| `AaEF8m6AQEO5fzLFYNCx` | `chmod(0700)` operates on that same owned fixture path before native DB setup. | 20:51:03 |
| `AaEVwgb4jwSJsM-Q-8VC` | The replay check and retention-smoke child pass trusted repository/tmp roots to atomic evidence allocation and a fixed SHA-derived prefix. | 20:52:47 |

The producer, CLI smoke, evidence helper, replay check and retention-smoke caller are
unchanged between the reviewed `82acfcac` and published `7adec7fb`. Parent rechecks the
actual caller, including the retention-smoke argv source, before applying each judgment.
Each comment names its prior review, source pin and caller limitation. Sharing comments
with Sonar for analyser improvement is explicitly unchecked.

These are caller-scoped static judgments. Arbitrary direct argv invocation is outside the
trusted offline caller. Canonicalisation is not a path jail or kernel boundary; a hostile
same-UID process can alter parents, records or symlinks/race the filesystem. The comments
do not claim new runtime, provider or keychain testing.

## Readback and current inventory

Each UI submission is followed by visible `False positive` confirmation. A separate public
PR-scoped API read returns all three keys as `RESOLVED`, `FALSE-POSITIVE`,
`issueStatus: FALSE_POSITIVE`, with the times above. The API quality gate is `OK`, including
security/reliability/maintainability ratings of 1, duplication 0.2% and hotspots reviewed 100%.
This is a point-in-time gate observation, not an independently attested remote analysis SHA.

The refreshed unresolved inventory contains 180 keys: the prior 175 minus these three,
plus eight newer labels. Parent individually checks their source spans against the already
independently reviewed factory; none establishes a new correctness or security defect:

| New key | Location | Adjudication |
| --- | --- | --- |
| `AaEdPh07dpxpEe9aVVuB` | `inert-data.ts:44`, S3776 | Descriptor/domain checks deliberately distinguish array metadata, brands, serializers and ordinary data. Complexity is a maintainability suggestion; the branch controls are independently reviewed. |
| `AaEdPh07dpxpEe9aVVuC` | `inert-data.ts:154`, S3776 | Iterative traversal separates active cycles, completed aliases and cap-slot exceptions without recursion; extracting solely for the metric adds no verified protection. |
| `AaEdPh4fdpxpEe9aVVuD` | `output-cap.ts:445`, S3776 | Incoming-plan validation separately checks dense array descriptors, authentic plans and metadata; these are required authority checks. |
| `AaEdPh4fdpxpEe9aVVuE` | `output-cap.ts:455`, S7749 | `0xffff_ffff` deliberately displays the 32-bit array-length limit in four-digit hexadecimal groups; spelling does not change its value. |
| `AaEdPh4fdpxpEe9aVVuF` | `output-cap.ts:513`, S3776 | Owned-graph alias detection excludes the live signal and private plan slot while distinguishing the provider-options edge. |
| `AaEdPh4fdpxpEe9aVVuG` | `output-cap.ts:689`, S3776 | Selected projection deliberately keeps sharing, option-alias preservation and generic copying separate; authority and whole-graph memo tests cover these branches. |
| `AaEdHzBS_BIn16qTDONo` | `inert-data.ts:76`, S7749 | The same deliberate 32-bit array-length spelling, with descriptor/density validation. |
| `AaEdHzBS_BIn16qTDONq` | `inert-data.ts:182`, S7755 | Last-frame indexed access is checked for absence; `.at(-1)` is an optional equivalent spelling. |

These eight labels receive no remote disposition and create no newly deferred obligation.
The [factory round 1](2026-10-08T20-28-00-w7-request-factory-round-1-review.md) and
[fresh round 2](2026-10-08T20-36-55-w7-request-factory-round-2-review.md) retain their
independent coverage and production-integration exclusions. New published source requires
its own analysis. At this observation, `7adec7fb` required CI and coverage are still running;
Step 7 implementation, Step 8, ownership/lifecycle integration and Step 12 remain open.
