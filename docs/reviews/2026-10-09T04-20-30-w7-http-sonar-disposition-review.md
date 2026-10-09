# Review: W7 HTTP producer-entry Sonar dispositions

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`http_descendants_sonar_triage`, GPT-6.1 Sol, high),
  independent HTTP authority/lifecycle reviewers and Parent's exact source/receipt audit.
- Subject: five new S4822 labels at PR #90 source commit `db02b83cdea22bab27483f63a9eef421988795e2`.
- Outcome: five individually verified false positives applied and read back; no product patch
  or broader source-quality dismissal follows from these dispositions.

The specific `try` blocks catch synchronous factory or retainer entry failures. They preserve
the exact raw Promise and distinguish operation failure from host admission. Their async owners
await the returned Promise, race it with the existing deadline, or attach an explicit rejection
observer. Adding `await` to an entry-origin marker changes both identity and provenance;
waiting for native close before returning headers can prevent the body consumption it needs.
The [HTTP round-1 controls and Parent audits](2026-10-09T04-16-24-w7-http-descendants-round-1-review.md)
independently verify those mechanisms. They do not make every `try` around a Promise valid.

| Exact key | Source | Specific judgment / API update time (UTC) |
| --- | --- | --- |
| `AaEexd8nnmLPDGsErzRG` | `apps/cli/src/engine/tool-host/egress.ts:78` | Inner marker records synchronous factory failure; `invoke` awaits and classifies async I/O. `2026-10-09T04:11:37Z`. |
| `AaEexdbjnmLPDGsErzRC` | `packages/core/src/engine/agent-turn.ts:1138` | Inner tool-factory marker; actual registry dispatch is awaited and private refusal identity restored before recovery. `2026-10-09T04:13:07Z`. |
| `AaEexdhLnmLPDGsErzRD` | `packages/db/src/safe-egress.ts:499` | Outer retainer-entry boundary; raw work is separately consumed by awaited `Promise.race`. `2026-10-09T04:15:47Z`. |
| `AaEexdhLnmLPDGsErzRE` | `packages/db/src/safe-egress.ts:501` | Inner synchronous factory marker; later I/O rejection retains fixed network classification. `2026-10-09T04:19:25Z`. |
| `AaEexdhLnmLPDGsErzRF` | `packages/db/src/safe-egress.ts:652` | `lifetime.catch(rejectResponse)` observes async failure; abandoned headers have a separate catch after post-entry refusal. `2026-10-09T04:20:07Z`. |

Each UI action changes only the named issue. Optional external comments are not submitted;
the explicit rationale remains in this durable record and the private recommendation file.
Analyser-sharing is unchecked. No global rule, source/scanner suppression, security protection,
access grant or branch requirement changes. A mistyped address briefly reaches a public search
page; correcting the address returns to the exact issue before any disposition.

The independent triage seals its full report (`2bc84d4911ab46a2a374e5da691148b6d1b25abfbe6ef9ea7ddbd77cbc0520a1`)
and 150-file manifest (`eb16a4e8fc0eecda3cc3c114ecc5aea16523a86ddb701edce485eda160a1c7c0`).
Parent verifies every artifact and all 102 captured source files against exact Git content,
then reads every flagged entry and its async owner. Separate public PR/component-scoped API
readbacks return `RESOLVED`, `FALSE-POSITIVE`, `issueStatus: FALSE_POSITIVE` for all five keys.
PR metadata binds the analysis to exact `db02b83c`; the gate API returns `OK`, reliability,
security and maintainability ratings 1, duplication 0.2% and reviewed hotspots 100%. The
coverage condition has no actual value in that receipt; no coverage percentage is inferred.
The stale page-level gate badge is not used as updated gate proof.

The remaining 201 open code-smell labels need individual treatment. Triage identifies 100
source-quality correction candidates and qualified contract/false-positive proposals; these
are not 100 reproduced runtime faults or an approved bulk dismissal. Genuine maintainability
corrections remain part of final work. No network/provider test, credential read or new paid
call is used for this triage. A green API gate does not accept the HTTP increment, host
departure, Step 8, Step 12, all six W7 items or merge readiness; future source gets fresh analysis.
