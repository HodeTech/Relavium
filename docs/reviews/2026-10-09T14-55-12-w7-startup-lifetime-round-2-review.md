# Review: W7 fresh-start lifetime, round 2

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`startup_r2_authority`, GPT-6.1 Sol, xhigh;
  `startup_r2_lifecycle`, GPT-6 Astra, xhigh), plus Parent's complete source,
  report/map, original-input, physical artifact and shared-tree audits.
- Subject: `e397afcb38c879ae100f58e1b384d06156700b06` through
  `5d44b13b0af137b12e797d8110338d6b41691773`: ten paths / sixteen literal hunks.
- Outcome: accepted within this cumulative fresh-start/interpolation scope.
  Both NEW independent reviewers find zero confirmed issues. Whole-host/W7 work remains open.

## Independent scope and result

Each reviewer examines all ten paths and all sixteen hunks, including the original
startup/resolver changes, permanent tests, synchronous clock/timer correction,
canonical mechanics, append-only ADR/phase notes and round-1 record. Neither inherits
the first-round verdict or partitions the scope. Each retains separate per-path and
per-hunk read scope, rationale, disposition and original identity metadata in concordant
JSON/Markdown maps. Complete changed functions and relevant ownership, writer,
retirement, heartbeat, cancellation, host and interpolation continuations are read;
unrelated bodies of the large engine/roadmap are not claimed wholly deep-read.

Each independently passes all seven prescribed checks: cold shared/LLM/core builds,
strict core, core purity, scoped TypeScript lint and the full offline core suite:
**108 files / 2,850 passing cases / no skips**. The suite includes nine startup and
42 resolver cases: fourteen cumulative additions and 51 cases in the two focused files.
No reviewer writes source, tests or probes, runs mutants, installs dependencies,
uses credentials/network, or runs shared-tree commands. Root CI, coverage and native
process/SQLite checks are not independently rerun by these reviewers.

The correction keeps startup owned before host entry, refuses fresh continuation
after synchronous or awaited cancellation, disposes a late timer receipt, and retains
an already entered acquisition's exact returned fence for cleanup. Retirement remains
outside the startup root it joins. Resolver guards distinguish a refused second read
from refused final text; positive sequential reads remain functional. These mechanics
are described in the [canonical engine architecture](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103).

## Evidence custody and qualifications

Original external evidence is under
`/Users/cemililik/.codex/relavium-evidence/w7-host-start-r2-20261009T143405Z`.
Parent reads both complete reports and every map rationale, then verifies exact Git
base/head/patch/blob/archive identities, all ten head snapshots, sixteen literal hunks,
private source bytes, all original manifests/logs/wrappers and 99 individual dependency
links per reviewer (eleven workspace links remapped privately). Parent physically verifies
**34 original captures / 42,364 copied eligible input files**. The two failed Authority
captures are administrative reads; all fourteen prescribed product checks pass.

Authority's physical inventory contains 28,841 regular files including three separately
bound self-controls, 2,387 directories and 99 links; Lifecycle's contains 18,832 regular
files, 1,547 directories and 99 links. Each also has 981 original temporary files,
with 33 and 25 temporary directories respectively. Parent inventories and rereads the
owned regular bytes, exact link targets and original temporary outputs, applies verified
0444/0555 protection without following dependency targets, and separately binds the
inventory controls. This is permission protection, not cryptographic owner immutability.

| Reviewer | Final report SHA-256 | Parent seal SHA-256 |
| --- | --- | --- |
| Authority | `bd8972ae0cf8dd1991aed5cf5e6ca49423279624b609af0799ab8c6fe14cd8a5` | `8d5724cdfcf7abb54f8381a2439f0e9bfc58839692a08356ff4b6e00962aa997` |
| Lifecycle | `8eb4d383bdf12e656cf3f16e7ac01e6c67009b8754cd174c390077a758434569` | `eab384ada56142d7d933033f506cd2bc9dbbe55f7e6a928df5e8857a1b0afaa0` |

Authority retains two failed guessed-path reads and separate corrected reads. Lifecycle
retains a wrong-file read, a rejected nonexistent cwd and a wrong-key artifact-readback
helper, with corrected reads separately attributed. Direct administrative outcomes are
not reconstructed as runner captures. External helper originals and capture limits remain
explicit. Lifecycle withdraws a cancel-plus-throw hypothesis after synchronous scheduler
source reasoning; no probe ran and no runtime finding is claimed.

The post-start-append guard remains source-reasoned rather than individually forced.
Parent's prior corrected before/fixed/mutation controls remain attributed Parent evidence,
including discarded invalid fixtures and the original wrong expected mutant count.
One-shot clock failures do not prove recovery from a permanently unavailable clock.
Reference-host controls do not become native SQLite, OS timer, heap or compiled CLI proof.

The complete **647,041-entry** shared-tree before/after comparison has zero differences;
both snapshots hash to `8e91d8faebae9367cd9fe938ef5c0af0f8ee1d1d08fe0fc75904c32a251684d5`.
HEAD and clean status stay unchanged. Explicit freeze release occurs at
`2026-10-09T14:55:12.541688+00:00`, before this acceptance documentation is written.
Parent's earlier exact-input root CI for the correction passes 413 files / 9,121 cases /
12 existing skips, 23 tasks (12 cached) and seven build/format tasks (five cached),
including compiled CLI and the three offline smokes. It is neither fresh coverage nor
final whole-wave acceptance. The next scheduler prototype is outside this frozen scope
and remains private, with its failing integration checks still under investigation.

## Remaining work

This accepts only fresh startup/interpolation lifetime integration. Scheduler/dispatch/
timer/resume/pre-handle roots, complete MCP startup, custom-provider descendants, final
receipt health, parked clocks, public departure/primary acknowledgement and acknowledged
CLI teardown remain open, as do Step 8 compaction/recovery and final Step 12. All six W7
register items remain OPEN (41/51 closed); PR #90 stays draft and unmerged. No additional
paid call, credential, user decision or ADR approval is pending.
