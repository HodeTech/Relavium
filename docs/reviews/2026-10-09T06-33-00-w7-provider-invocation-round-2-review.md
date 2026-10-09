# Review: W7 invocation-local provider and raw-poll lifetimes, round 2

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`provider_invocation_r2_authority`, GPT-6 Astra, xhigh;
  `provider_invocation_r2_lifecycle`, GPT-6.1 Sol, xhigh), followed by Parent's complete evidence audit.
- Scope: all 27 paths / 66 cumulative hunks from `7d59de51de67f6fac05290e2140c0da049538921`
  through `4fb99b0eabcca42a859ea73d1563d72a62ae1e50` on `development`.
- Result: both reviewers independently confirm one Medium getter-acquisition finding.
  The correction and three permanent regressions pass root CI. A NEW complete cumulative
  round 3 is required; this is not scoped increment or W7 acceptance.

Both fresh reviewers inspect the complete source, test and documentation range, including
[round 1's corrections and evidence qualifications](2026-10-09T05-43-00-w7-provider-invocation-round-1-review.md).
They cold-build five private libraries and the actual CLI, exercise installed SDK and public
Core paths, preserve their final fixtures and strictly rebuild credited semantic removals.
Parent reads both complete reports, source, controls, runners and evidence maps, then independently
checks every physical artifact, command/input/log binding and source/test/generated-output restoration.

## Confirmed correction

**Medium: trusted getter refusal escaped the entry guard.** `EgressWorkScope` preserved the
method receiver after round 1, but acquired `parent.retainWork` before entering its existing
try block. A valid trusted getter throwing an opaque refusal bypassed the host-entry marker;
the public validated-fetch classifier could reflect its prototype and replace its identity.
No DNS or native connection entered. Both reviewers verify strictly built original red /
minimal correction green / restored original red. Lifecycle's stronger repeated control
observes both reflection and identity loss independently; these are the same finding.

The correction moves getter acquisition and its absent-capability return inside the existing
guard. It retains the receiver-preserving call. Three new permanent cases verify opaque
identity without reflection or producer entry, exactly one getter selection with a receiver-
dependent callback and held native descendant, and ordinary reason-only classification of
an actually entered resolver fault. This enforces the accepted
[provider lifetime contract](../reference/shared-core/llm-provider-seam.md#the-per-attempt-deadline);
it adds no authored request field, durable payload, dependency or new decision.

Parent's final lint-clean fixture passes strict CLI checks. Against original source, its
getter regression fails semantically while the other two new cases pass (14 older cases are
filtered out). Exact correction restoration passes all 40 cases across the three affected
CLI files. Original-red log SHA-256 is
`2ee0ad0d86c094a6942439caff3cb834bdb50c2cfd76c6d01aaf84972a975772`;
corrected-green log SHA-256 is
`79b6388713429348d9d093c014a9abecbd57859253bcfc5f087d6276e1d42e41`.
The code/test correction is committed as `76b56bb7`.

## Independent evidence and its limits

| Evidence | Authority | Lifecycle |
| --- | --- | --- |
| Final independent positives | 29 cases | 32 cases |
| Broad affected selection | 377 files / 8,093 pass / 12 existing skips | 396 files / 8,904 pass / 11 existing skips |
| Distinct strictly built causal removals | Seven | Fifteen |
| Additional getter correction proofs | Original / correction / restored-original sequence | Two sequences for the same finding |
| Source/test/generated-output golden | 1,621 files | 1,621 final files |
| Command/log receipts | 152 | 295 |
| Full variant archives | 17 | 37 |
| Physical evidence entries | 5,449 | 4,673 |
| Tracked archive files / individual dependency links | 1,259 / 79 | 1,259 / 79 |

Selections overlap and are not additive. The expected failing getter probe is excluded from
both broad green selections; Lifecycle's final four supplemental cases are also outside its
broad count. Its first twelve removals use a 1,619-file golden, and three later forwarding
removals use the final 1,621-file golden. Getter correction/reversal sequences are not extra
distinct removed mechanisms. Credited causal runs pass strict checks and actual affected
library/CLI builds before semantic failure, then exact restoration and green. Compile faults,
timeouts, all-skips and fixture failures receive no semantic proof credit.

Authority's four early pre-format fixture versions retain hashes but lack original bytes.
They are explicitly excluded; final 29-case fixtures, all credited variants and the restored
golden retain exact original bytes. Its extraction-helper failure and corrected SDK probe
fixture are preserved and qualified separately. Lifecycle retains its failed extraction and
helper attempts, mistaken SDK response fixture, opaque Promise-assimilation fixture and corrected
controls. A late reconstructed preparatory fixture and a runtime run after a failed strict
check earn no contemporaneous or causal credit. The final fixtures and credited causal variants
have original bytes. Parent's own preliminary audit-helper assumption failures are preserved
separately from corrected complete audits. None is represented as a shipping product finding.

Actual loopback controls delay safe-egress callbacks after native close emission; they do
not claim an OS resource stayed alive afterward. Injected held-close controls and direct internal
imports remain distinct from public SDK/Core/compiled CLI evidence. Private individual dependency
links and declared TMP/XDG/cache paths provide application isolation, not an OS sandbox or complete
process/network tracing. HOME is unchanged; no installer, paid call or nested DB-sync package-manager
invocation supplies reviewer evidence. Hidden official Gemini/foreign-stream producers and
complete CLI input/departure are outside this scoped acceptance.

## Custody and correction validation

Parent independently verifies all 5,449 authority and 4,673 lifecycle physical entries, their
447 receipts and all full archives. Its true-before/final whole shared comparison covers
645,721 entries excluding `.git`, with zero byte, mode, mtime, directory or link differences;
`development` remains clean at the frozen review head before release. Review seals remain unchanged.

| Bound subject | SHA-256 |
| --- | --- |
| Authority report | `a6ea9e1dab516a7d1b98cfb277000965b11a13a1046f977524b051656318291e` |
| Authority physical inventory | `c52bad6c6bc347bb894333d7016f906e5e4b6f1a578c11af3d510a25350a5564` |
| Authority seal | `0bff4dec34b1283b646c0460e02741dfe3eaca19a2808b9c30ba6280836393d1` |
| Lifecycle report | `4e82e2b40c0ca8a544f542a8f9272b9f048854ba8bb2f0392891805552f3afc2` |
| Lifecycle physical inventory | `035a020abf98d5f1b6c799456d06b039876601b689939cbdaa1c12307bf3b909` |
| Lifecycle seal | `2b072a88deb2d99c1f1e773bfc702c4a2b193feb3b7bb41a451ce975f6fc759f` |
| Parent true-before whole shared snapshot | `c3d00da4b287f1401feec5dfc05a30fbb23883624b2fc5ac90b3aa5fe2f146d4` |
| Parent final whole shared snapshot | `bd0068db9859f7b96cfc8c0df1f62dbdcf810c9dbdca734ed2b95aa80c4c441f` |

After correction, actual root `CI=true pnpm run ci` passes 404 files / 9,030 cases /
12 existing skips. All 23 lint/type/test and seven build/format tasks succeed; 20 and five
respectively are cached. DB sync, tool checks, seam/purity/dependency/bundle fences, actual
CLI build and all three offline smokes pass. Root log SHA-256 is
`662fd6be4849c7e9b089f1e4fae3f4d40f315d852069e6d5758d86e4f6165845`.
The first author fixture failed two lint rules; its original bytes and failed CI receipt
remain preserved. The final fixture uses an opaque Error proxy and an explicit receiver-dependent
function, passes lint without suppression, and has its own original-red/corrected-green receipts.
The increment now adds 57 permanent cases. This is cache-qualified correction validation,
not forced final whole-wave acceptance or a new exact-head remote-check claim.

A NEW complete cumulative third round follows the correction and this record. MCP, hidden
Gemini/foreign-stream producers, remaining actors/generations, sticky final money/effects,
parked clocks, public departure and acknowledged CLI teardown remain open. Step 8, Step 12
and all six W7 register items stay OPEN (41/51 closed); PR #90 stays draft and unmerged.
All five live records are complete; no further paid call, credential or maintainer approval is needed.
