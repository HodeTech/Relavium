# W7 systematic group 3, round 5 — pause finalization is still attached work

- **Type**: Code
- **Date**: 2026-10-06
- **Reviewer(s)**: `/root/w7_group3_round5_contracts`, `/root/w7_group3_round5_runtime`; parent `/root`
- **Subject**: complete operator correction `ad825fb1..8e13771c`, 47 changed paths
- **Outcome**: Changes requested; one verified High remains open, two Medium corrections committed

## Findings and disposition

**High — voluntary paused finalization can race an authored gate terminal.** Contracts uses actual
`runCommand`, native SQLite, the real engine and Ink's summary store with an injected unmount wait.
An authored timer that rejects or autoapproves during that wait leaves exit 3 and a paused summary
after the durable run has failed or completed. Holding the real terminal append also permits SQLite
to close beneath that writer; its later write fails and the run lease remains. A delivered pause
does not establish that the engine's producers have stopped. Parent independently reproduces four
failures among five native controls, including a held earlier `node:failed` append before any terminal
can be published. The stable-pause control passes. These callbacks belong to the actual authored
timer; the tests do not claim physical wall-clock expiry or a real terminal device.

This is not repaired by inspecting emitted terminals alone. The unpublished node-write case needs
an engine-owned local departure/join contract, while unconditionally waiting for a terminal hangs
a genuine resumable pause. ADR-0103 is being drafted and independently reviewed; no new lifecycle
decision or dependent implementation is approved. The existing cancellation regressions remain
valid within their tested scope. The broader paused-finalization claim is qualified in the
[command contract](../reference/cli/commands.md#relavium-budget-resume) and a dated
[ADR-0097 note](../decisions/0097-a-budget-approval-is-an-allowance-not-an-exemption.md).

**Medium — the CI timeout-card test samples the wrong completion phase.** Both reviewers independently
verify that terminal ACK/publication and a single correct summary can precede actual asynchronous
host media cleanup. Fixed event-loop turns cannot establish command completion. `fa884a92` waits
for the actual command under a cleared watchdog while the obsolete prompt stays held. An additional
control holds and then executes the real host media sweep, requiring SQLite to stay open until that
cleanup completes. This changes the test oracle, not the product's terminal authority.

**Medium — status JSON documentation denies its existing safe exclusion strings.** Contracts verifies
that `allowance.excludedEntries` is already the same redacted, quoted, escaped and truncated
display-only projection. `fa884a92` describes that optional field and adds five real SQLite/status
JSON controls for zero, positive, unpriced, unrepresentable and legacy allowances. Exact decoded
shape and absence of priced-model, endpoint, rate-basis and secret data are required. There is no
new raw quote disclosure or amount authority. The commit also applies the ordinary-array Sonar
length assertion recommendation in a Clack regression; no hostile-value matcher is rewritten.

## Verification and causal limits

Contracts (`gpt-6-astra / xhigh`) executes all 29 supplied files and 752 supplied cases, then finishes
with **31 files / 765 cases: 762 passes and three High finding failures**, including 13 new controls.
Its five-package clean builds and strict fixture compile pass. A partial emitted-terminal selector
causal still fails the held writer and is explicitly not a complete correction.

Runtime (`gpt-6.1-sol / xhigh`) finishes **32 files / 769 passing cases**, including 17 new controls,
after five clean ordered builds and strict compilation with actual inclusion proof. Its native
command, real quote, engine, SQLite and Ink controls independently establish the wrong test phase.
Actual installed Clack confirmations and text use synthetic streams with raw-mode, keypress and
resize release checks. Removing the prompt abort race, claimed-timeout guard or non-cached rate
identity breaks the corresponding supported-path controls; all production pins are restored.
Runtime does not exercise the High's voluntary unmount race, so its pass is not contrary evidence.

Parent's separate unsealed copy passes 26 corrected lifecycle/Clack tests and 22 JSON/status cases,
with strict compilation. At `fa884a92`, forced Original lint/typecheck/test under `CI=true` passes
**23 tasks, 369 files, 8,292 tests and 12 existing skips**; test isolation, four-file formatting and
`git diff --check` pass. No production source or build output changes in this narrow correction;
the prior six-build result remains historical. Remote CI, coverage and current Sonar are not
certified by these local results. Five existing genuine self-OS-SIGINT controls retain their
specific Windows skip; the newly added cleanup and JSON cases are not platform-skipped.

## Evidence integrity and qualifications

Both complete reports, all 47 dispositions per reviewer, both complete static-child supplements,
all five new reviewer fixture bodies and preparation/causal/proof qualifications are read. Exact
command/environment and read registers are fully parsed and independently correlated. The runtime
static child reads only bounded changed CLI context and misses the status JSON paragraph; that
qualification is retained rather than claiming a clean whole-document verdict. Unrelated inherited
test bodies may be execution-only; all changed cases and new bodies are separately accounted for.

Before Original resumes, parent independently verifies every actual recorded nofollow metadata,
file content, sorted directory-child tuple, literal/resolved link, target/manifest, source pin and
Original receipt field. Each Own restores **1,153 unique single-linked source pins**, 79 named links
and 11 canonical Own targets. All **3,565 actual entries** and **3,077 externally bound regular-file
tuples** match, including separately bound inventory self metadata. Both Owns and all children
permanently cease all access; sealed Owns are never executed, changed or resealed.

| Own | Actual entries | Regular tuples | Report SHA256 | Inventory SHA256 |
| --- | ---: | ---: | --- | --- |
| Contracts | 1,777 | 1,531 | `ba7d1432f1d647cbaf0202dbcb0a6f5d9be0087e20664d368a25a5d21d89fd49` | `ca4096ae4ba5776eaa53a6e725c286e89ef470173acac3de1567d836cfb40c24` |
| Runtime | 1,788 | 1,546 | `2ee462bbe55331bd6783bec089fa7ae2899e0f2b9c1e0b3206f5e0823283f59e` | `8084177cfdd56670d22421e51cea2ea7b6bc360d6248e30a89a2b518986f12eb` |

Contracts' independent records cover 21 runner mains, 66 source workers and six native helper
mains, with 36 denials and 11 Own resolutions each. Runtime covers 31 mains, 81 workers and six
native helpers, with 42 denials and 11 Own resolutions each. Helpers receive the exact recorded
sterile environment and independent proof before source import, including the first focus; extra
preloads are separate evidence. These are exercised JavaScript guards, not kernel isolation or
a standalone ESM-keyring proof. Fixture typing, cached-rate oracle, Clack comment shape, source
filter preparation, partial reads and harmless parent schema/path discovery failures remain
qualified. Authored callback and synthetic input tests do not establish real TTY or clock expiry.

Group 3 remains **changes requested**, not accepted. Fresh narrow reviews follow the Medium/test
correction; whole-Group-3 acceptance requires the High's approved decision and verified implementation.
ADR-0102 is still Proposed and unimplemented. Independent Groups 4–6 may proceed after this evidence
audit while that new decision is reviewed; each still needs its own checks, commits and fresh rounds.
Three-of-five live captures, Steps 7–8/12, current Sonar, W7 and draft PR #90 remain open. No key read,
live call or additional paid generation occurs.
