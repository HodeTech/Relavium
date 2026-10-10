# W7 systematic group 3, round 3 — cancellation owns teardown and queued gates

- **Type**: Code
- **Date**: 2026-10-06
- **Reviewer(s)**: `/root/w7_group3_round3_contracts`, `/root/w7_group3_round3_runtime`; parent `/root`
- **Subject**: complete operator correction `ad825fb1..be96ea47`, 38 changed paths
- **Outcome**: Changes requested; two independently verified Highs corrected, fresh complete round 4 required

## Findings and correction

Runtime independently verifies a queued-prompt High: cancelling the first card, including an
observed OS SIGINT, still opens a second queued card. The actual cancellation terminal can be
acknowledged while the command remains parked on that extra prompt, retaining its database.
Genuine approval of all two budget gates and the ordinary human gate remains a passing control.

Both reviewers independently verify a teardown High: after an acknowledged pause, breaking a
`for await` closes the primary subscription before asynchronous renderer finalization. A signal
still accepted during unmount starts actual cancellation, but the command closes native SQLite
before the held terminal append is acknowledged. The late writer fails; replay remains paused,
its lease remains, and actual Ink publishes a single stale paused summary. Contracts' initial
short probe does not establish a writer exception or retained lease; its tightened writer-entered
probe and Runtime's actual writer observations establish those consequences separately.

`94948cd4` centralizes idempotent cancellation for prompt-null and SIGINT, suppresses later queued
prompts, and retains a manual primary event iterator through finalization. Actual SIGINT counting
is separate from the cancellation latch. Ink awaits cancellation settlement after unmount and
before its one persistent summary, including a rejected unmount wait. A fallback driver drain
retains resources for renderers that omit or ignore this callback. Signal ownership ends before
the iterator is closed. Terminal outcome, durable acknowledgement and lease cleanup keep their
existing authority; there is no new financial policy, durable schema, timeout or error code.
The [canonical command contract](../reference/cli/commands.md#relavium-budget-resume) owns the
operator guarantee.

## Verification

Contracts (`gpt-6-astra / xhigh`) finishes five fresh ordered builds and strict fixtures. Its
26-file focus has **724 passes and one finding failure**: all 716 permanent controls pass, with
eight passes and one failure among nine new cases. Runtime (`gpt-6.1-sol / xhigh`) finishes the
same build/strict requirements; its 26-file focus has **721 passes and four finding failures**,
including all 716 permanent controls and five of nine independent cases. Narrow causal controls
pass, but Contracts' teardown-only prototype is explicitly not a complete truthful-summary fix.
Exact production pins are restored before final reviewer builds.

In a separate unsealed source copy, the parent independently reproduces **13 passes and seven
finding failures** among 20 fresh cases. The complete correction plus 41 inherited controls passes
**61 cases**. Eleven promoted-shaped regressions have **four passes and seven expected failures**
against pinned prior production, then all eleven pass with the correction. Nine native command
cases cover queued cancellation, genuine approvals, stable pauses, actual OS signals, held native
terminal acknowledgements, actual Ink and custom finalizers with and without the barrier. Two
independent actual Ink controls require no early summary, one truthful settled summary and
preservation of a rejecting unmount's original error.

Corrected Original forced lint/typecheck/test passes **23 tasks, 366 files, 8,261 tests and 12
existing skips** under `CI=true`. Six forced build tasks, test isolation, source format and
`git diff --check` pass. Four self-OS-SIGINT cases are explicitly skipped on Windows, where
cooperative self-signal delivery is unavailable; other new native controls still run there.
No new Windows result is claimed. The last full check follows that platform qualification.

## Evidence integrity and qualifications

Before Original resumes, both complete reports, all 38 semantic dispositions per reviewer, four
complete new fixtures and preparation/proof supplements are read. No child agents or child
supplements exist. The parent independently verifies every actual recorded nofollow metadata,
content, sorted child-list, literal/resolved link, target/manifest, inventory self, source pin
and pre-runtime Original receipt field. Each Own has **1,146 restored source pins**, 79 named
links and 11 canonical Own targets; regular identities are unique, single-linked and disjoint
from Original. All **3,797 actual physical entries** and **3,349 externally bound artifact tuples**
match. Sealed Owns remain permanently retired and are never executed, edited, cleaned or resealed.

| Own | Inventory rows | Actual entries | Report SHA256 | Inventory SHA256 |
| --- | ---: | ---: | --- | --- |
| Contracts | 1,910 | 1,911 | `7d47c37eda195fb165d60d309c1448f8ef840fe27e7baa9f46cf4354d88b7336` | `fd5d2f8ef2a3f8ed448e3ed6a84222fa88980348e020a887f89437f2b6470748` |
| Runtime | 1,885 | 1,886 | `544f28ba95222d1c4bd4dd212e6e68b6eaee32c6136c67f7eb39ff910d9f0e6e` | `3cf9d838d5bb7c962a74b605c5239806c2296e913692c16a3ccaf54e65d3449c` |

Contracts independently exercises 84 actual invocations: 28 mains and 56 source workers;
eight extra bootstraps have preload-only coverage. Runtime independently exercises 69:
32 mains and 37 source workers. Final focus runs each have one main, 26 source workers and
three existing native helper mains. Contracts' new signal probe uses `process.emit`; Runtime's
new probes observe actual self-OS-SIGINT delivery. Actual Ink means its production renderer/store
and summary, with mount/unmount waits injected; no real-TTY claim is made. CJS/explicit ESM
coverage is qualified separately; neither reviewer proves adversarial-loader or kernel containment.
All changed scenarios and relevant callers are read, while unrelated large inherited test bodies
are qualified rather than claimed fully reread.

Initial dist-only cleanup, omitted literal-glob fixtures, unacknowledged signal readiness,
preparation schema/environment issues and parent truncated/schema-guess reads remain recorded.
Corrected fresh builds, explicit focus, full-span reads and exhaustive actual-schema audits supply
the stated evidence; failures are not retroactively certified. The parent's runtime copy is new
and unsealed; copied reviewer fixtures are inert inputs, not execution of sealed Owns.

Group 3 stays open until fresh complete round 4 accepts the entire delta and all corrections.
[Round 2](2026-10-06T19-25-33-w7-systematic-group-3-round-2-review.md) remains historical evidence.
ADR-0102 is Proposed and unimplemented. Groups 4–6, three-of-five live captures, Steps 7–8/12,
current Sonar, W7 and draft PR #90 remain open. No key read, live call or additional paid
provider generation occurs.
