# Review: W7 dispatch attempt correlation, round 4

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`dispatch_r4_authority`, GPT-6.1 Sol, xhigh;
  `dispatch_r4_lifecycle`, GPT-6 Astra, xhigh), plus Parent's source, artifact and freeze audits.
- Subject: `522fb8c9beff820004c72e0243d7868da7546474` through
  `9dc165d91e5e1c120d825ac345ac19571c1f75a0`: fifteen paths / twenty-nine literal hunks.
- Outcome: changes required for one confirmed High with two attempt-correlation schedules.
  The correction requires NEW complete cumulative review; this verdict does not accept it.

## Confirmed finding and correction

Lifecycle independently discovers both source paths. Authority corroborates after disclosure;
all runtime reproduction, correction and removal controls belong to Parent.

A host fault while arming backoff after retry 2 or 3 escapes the dispatch loop. Its detached
catch calls the common failed-settlement helper without an attempt; the implicit default 1
therefore publishes the only node terminal against the wrong entered start. Separately,
a retry-2 budget pause followed by approval enters a new first start. Holding that append,
cancelling and firing grace can use the still-stale attempt 2 map instead of new attempt 1.
Both schedules preserve a single terminal and the run cause but violate node-attempt identity.
They do not establish extra spending, effect duplication or corruption of provider counters.

Parent requires an explicit attempt at all four helper callers. Readiness and initial refusal
pass 1; the detached catch forwards the latest entered attempt. The scheduler resets the
basis synchronously immediately before a new first-start append. The existing retry capture
and settled-terminal preservation remain intact. Mechanics belong in the
[canonical engine architecture](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103),
not a second retry or persistence contract.

Five new permanent cases cover host backoff faults after attempts 1/2/3, the live four-attempt
control, and approved redispatch held through grace. The final sixteen-case causal matrix
uses identical formatted test bytes: original three fail/thirteen pass; fixed/restored sixteen
pass; detached forwarding replaced with 1 gives two fail/fourteen pass; first-start reset
removed gives one fail/fifteen pass. All original logs are read completely and 6,290 physical
input copies verified. Initial candidate equality also rejected a canonical extra correlationId;
that incidental failure is retained and qualified before the final partial-match assertion.

Final private strict core, scoped lint and full core pass: 117 files / 2,884 cases, no skips
or unhandled errors. Parent verifies all 3,774 corresponding physical input copies. These
reference-host controls do not replace fresh review, native/CLI or whole-wave acceptance.

## Complete review and evidence custody

Both reviewers inspect every path and literal hunk plus relevant actual callers/continuations;
no partition or inherited acceptance. Each passes seven original checks: sequential cold
shared/LLM/core builds, strict core, core purity, scoped lint and full offline core:
115 files / 2,879 cases, no skips or unhandled errors. These are the rejected frozen-head
counts, not the later corrected source's counts.

Parent reads both complete reports, full rendered maps and all thirty path/fifty-eight hunk
rationales, original logs and source-context records. JSON metadata and exact Markdown
concordance are mechanically verified; corrected Lifecycle JSON rationales are directly reread.
Parent verifies fourteen original captures / 17,626 physical input copies, 1,292 archive files
per reviewer, exact Git/head/patch identities and 99 links each (eleven local workspace remaps).
Protected inventories contain 11,459 Authority / 11,460 Lifecycle regular files, 916 directories
and 99 links each; each original temporary inventory has 981 files / nineteen directories.
Every regular byte/link target and actual 0444/0555 mode is checked without traversing
external dependency targets. The owner can reverse mode protection.

| Reviewer | Report SHA-256 | Parent seal SHA-256 |
| --- | --- | --- |
| Authority | `b8fb40528c7ea361ae02a3758d98ad48d4f3d5532d8e6b771b30cf7e273bc3bd` | `72b78d5485958eac706b4d9b3ae024403a64715425dc8b4bb3f0a8076a0c6ede` |
| Lifecycle | `bf67635edf577900de02f0ce041b33845d328f11c7e36e328fae0e4c20d612b7` | `7a4ed21066e6f0dc238caec9a1313407d845bb28102943ec12dfcf471d3efbe6` |

Evidence root: `/Users/cemililik/.codex/relavium-evidence/w7-dispatch-corrections-r4-20261009T184459Z`.
Parent controls: `w7-scheduler-readiness-r2-20261009T154612Z/parent-dispatch`, in
`dispatch-correlation-control-summary.json`, `dispatch-correlation-parent-audit.json`
and `dispatch-correlation-validation-audit.json`.

Parent catches a pre-seal Lifecycle map attribution error: round 1 accepted with zero findings;
rounds 2/3 rejected. The reviewer corrects only its report/maps/validation artifacts and fully
rereads them before a new DONE. Historical source records and original runtime captures are
unchanged. Administrative read/audit failures remain qualified. A broad Parent filename
inventory was truncated and grants no omitted-content proof. The first landing script guessed
`## Reviews` instead of the actual `## Records` index heading and stopped after copying the
verified implementation/new record/architecture; no index, roadmap or ADR write had occurred.
The remaining edit anchors are validated together before writing. A doc checker first
counted an existing fenced template heading, then correctly found the phase note
needed `../../` relative links; those links are repaired after the original root CI finishes.
No production/test/config bytes change after that CI. Final docs receive their own link/
append-only/whitespace checks; CI is not mislabelled as testing later documentation bytes.
No retrospective receipt is invented.

The entire 647,505-entry shared tree has zero byte, mode, mtime or link changes. Before/after
SHA-256: `2481a526174987e1566205b266c0ad6d39109b2a92732c259df133a4630a442d`.
Explicit freeze release: `2026-10-09T19:10:39.474325+00:00`, before main-source correction.

## Required remaining work

NEW complete cumulative reviews must inspect this correction with all preceding dispatch
changes and twenty-two permanent cases. Complete actor roots must integrate with shipping
host departure; the broader prototype's original 38 CLI failures remain unaccepted. MCP
startup/custom-provider descendants, final money/effect receipt health, parked clocks,
primary/input/host ACK and CLI teardown, Step 8 and final Step 12 remain required within W7.
All six W7 items stay OPEN (41/51), draft PR #90 is unmerged, and no paid call, credential,
maintainer decision or ADR approval is pending. This correction defers no W7 work.
