# Review: W7 fresh-start lifetime, round 1

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`startup_r1_authority`, GPT-6.1 Sol, xhigh;
  `startup_r1_lifecycle`, GPT-6 Astra, xhigh), plus Parent's complete source,
  report/map, original-input, physical artifact and shared-tree audits.
- Subject: `e397afcb38c879ae100f58e1b384d06156700b06` through
  `15ea60214732984cb8b48142fe6e8189329ea5ad`: seven paths / eleven literal hunks.
- Outcome: changes requested. Authority independently identifies one High;
  Lifecycle finds no additional confirmed issue. Parent reproduces and corrects
  the High; a NEW complete cumulative round 2 is required.

## Confirmed finding and correction

The fresh startup root registers before host entry and correctly retains an entered
workflow lookup, acquisition or context read across terminal publication. Its first
stopped-state check nevertheless follows the workflow lookup. An injected initial clock,
elapsed-time clock or timer factory can synchronously call the supported cancellation
API. The terminal sweep then precedes the timer's returned disarm receipt, but startup
continues into a fresh lookup and leaves a work timer installed.

Parent's separate exact-head reference-host reproduction fails all three new schedules:
each observes one late lookup and one remaining work timer, with no executor call.
This is independently source-derived and Parent-runtime-confirmed; neither reviewer
runs the new probe. No real native process-retention measurement is claimed.

Startup now rechecks after synchronous host callbacks. Timeout setup refuses entry after
the elapsed-clock callback and disposes a timer receipt returned after cancellation.
Three permanent cases assert fresh timer-entry counts, zero late lookup, terminal
precedence and zero residual timers/lease. Together with the earlier eleven additions,
the cumulative increment has fourteen new cases; the two focused files pass 51 cases.
The final before-fix matrix fails three cases; separate elapsed-clock, late-receipt and
post-arm guard removals fail one, one and two cases. Exact fixed/restored matrices pass.
The first counterfactual driver's expected post-arm failure count was one rather than
two; its original failure and script are retained, corrected final controls repeat the
whole matrix, and no failed original is relabelled as a successful run.

## Independent checks and custody

Both reviewers inspect every changed path and literal hunk, the complete changed
functions and relevant unchanged contracts. Each passes three cold library builds,
strict core compilation, engine-purity compilation, scoped lint and source Vitest:
108 core files / 2,847 cases, zero skips or errors. These are private source/reference-host
checks, not compiled CLI, native SQLite, live provider, real-clock, coverage or heap proof.
Parent's earlier exact implementation root CI passes 413 files / 9,118 cases / twelve
existing skips; it is separate evidence and does not accept the unreviewed correction.

Parent reads both complete final reports and all map rationales, verifies exact Git
head/blob/archive/patch/hunk identities, every original receipt/log and 27,390 copied
inputs across 22 captured invocations. Seven prescribed checks pass per reviewer;
the remaining five Authority and three Lifecycle captures are static reads. Uncaptured
administrative reads, wrong-path failures, helper-script original-capture limits and
Lifecycle's artifact-generator Python compatibility failure stay explicitly qualified.
No retrospective reproduction is substituted for an original capture.

Parent physically inventories and read-verifies 17,556 Authority and 15,060 Lifecycle
owned regular files including self controls, 1,441/1,231 directories and 99 individual
dependency links each. Original task temporary outputs and their exact snapshots are
retained: 981 original files per reviewer, in 24/22 directories. Applied 0444/0555 modes
are verified without following or changing external dependency targets. Mode protection
guards accidental writes; it is not cryptographic immutability against the owner.

The complete shared before/after audit covers 646,973 entries with **zero differences**
in file bytes, modes, mtimes, directories, symlink targets, Git state, dependencies,
outputs and caches. Both snapshots have SHA-256
`534cc26571928252068fb88a3c9a672593f9f6d77be79d70037f29c980f2fa6f`.
Explicit freeze release at `2026-10-09T14:28:09.825775Z` precedes production corrections.

| Artifact | SHA-256 |
| --- | --- |
| Authority report | `71eb53e71cd0a7727d128baa967b2b91abc2c2f113bb5ab3a772197560a81d16` |
| Authority seal | `46a5bfcf3cd101be09c18819a63e29a0c67e11f39d91d463d5dd42123c4629d9` |
| Lifecycle report | `6649ef066520e93a5835a739872e3faff2a21a9fdf561f75196dfdcc283ef10d` |
| Lifecycle seal | `537132c17d595be094169977d588c24edd4bdaad1daea01a6ee40ffa28a46fed` |

## Remaining work

The [canonical engine mechanics](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103)
and [ADR-0103](../decisions/0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md)
remain scoped. One-shot initial clock failures do not establish recovery from a persistently
unavailable host clock. Complete scheduler/dispatch/timer/resume/pre-handle roots, MCP startup,
custom-provider descendants, final receipt health, parked clocks, public departure/primary
ACK and CLI teardown, Step 8 and final Step 12 remain open in
[the W7 plan](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md).
All six W7 items remain open (41/51 closed); PR #90 remains draft and unmerged.
No additional paid operation, credential, maintainer decision or ADR approval is pending.
