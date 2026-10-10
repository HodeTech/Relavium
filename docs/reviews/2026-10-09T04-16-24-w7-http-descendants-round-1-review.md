# Review: W7 HTTP descendant lifetimes, round 1

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`http_descendants_r1_authority`, GPT-6 Astra, xhigh;
  `http_descendants_r1_lifecycle`, GPT-6.1 Sol, xhigh), followed by Parent's complete report,
  source, control, restoration and shared-tree audits.
- Scope: all 22 paths / 38 hunks from `1544ced154454c85bb3fe94fa1ee3702a18bf347`
  through `db02b83cdea22bab27483f63a9eef421988795e2` on `development`, including the
  separate [earlier custody correction](2026-10-09T03-42-30-w7-raw-producer-custody-correction-review.md).
- Result: zero verified findings in this HTTP scope. Round 1 passes; a second fresh complete
  cumulative round remains required. This does not accept host departure, Step 8 or W7.

Both reviewers cover every changed source, test, canonical contract and status hunk. They
independently challenge execution-only authority, forged preparation, synchronous factory
failure versus host refusal, opaque cause identity, raw DNS/body retention, native request/incoming
close acknowledgement, standalone compatibility and fence/heartbeat retirement. No product
correction is proposed. Parent reads both entire reports and their actual controls. Its first
audit incorrectly required the literal `AssertionError` in a valid Node reference-equality
diagnosis; the corrected audit verifies the explicit assertion. The failed audit script remains
preserved and grants no product finding. A documentation patch with a nonexistent append context
is also rejected without changing main; the corrected patch does not rewrite historical records.

## Evidence and causal verification

| Dimension | Authority reviewer | Lifecycle reviewer |
| --- | --- | --- |
| Unique private archive | `relavium-c2-r1-authority-wg9_qlg7` | `relavium-c2-r1-lifecycle-yabwqosy` |
| Final affected baseline | 320 files / 6,438 passed / one existing skip | 320 files / 6,438 passed / one existing skip |
| Additional baseline | Fixture conformance: 8 files / 108 passed / 11 existing skips | Initial uncached full suite: 398 files / 8,973 passed / 12 existing skips |
| Independent positive cases | 15 plus one separate receipt-registry case | 23: eight real native, eight engine lifecycle, seven captured-turn cases |
| Accepted causal evidence | 13 distinct strictly compiling removals | 19 compiling attempts: 17 red runs, two original survivors; 16 distinct proven mechanisms |
| Actual restored output files | 355 across five libraries, CLI dist and copied migrations | Same 355 files; 364 entries when output directories are included |
| Complete source restoration | 1,246 tracked files compared with frozen HEAD | 1,354 original archive entries including directories; all tracked bytes/modes restored |
| Parent physical evidence audit | 3,891 entries and 227 command/log receipts | 3,484 entries and 119 command/log receipts |

These overlapping selections are not additive product-test totals. The 23 new permanent cases
are included in the affected baseline. Every credited removal compiles, fails its unchanged
selected control, restores the actual source/test bytes and modes, rebuilds its changed boundary
and passes again. Parent verifies every bound log and per-episode source/test/output ledger.
Repeated removals do not become new mechanisms.

Public Core registry/builtins and DB transport controls are separate from the explicitly internal
compiled captured-turn and HostWorkRegistry controls. Actual engine/runner/registry/CLI-host
controls on reference and real SQLite stores prove that held DNS, credential, body or native
close retains the original fence/heartbeat after bounded terminal. A successor cannot acquire
until genuine completion; late results add no provider invocation, event/cost or durable delivery.

Native localhost finite, held-body, abrupt, overflow and closed-port controls distinguish headers,
error and dispose from completion. Delaying delivery of actual request/incoming close events
proves both ACK orders, not that an OS socket remains open after physical close emission.
Pooled successful sockets remain host infrastructure; no remote HTTPS or paid-provider proof
is inferred. Both archives cold-build five declared private exports and the actual CLI bundle.
True prebuild Node probes fail at missing private dist targets. CLI source factories use built
libraries; they are not public CLI exports. Authority also runs the built offline transform
(`doubled: 42`, contiguous events) with an isolated home preload; lifecycle verifies version,
build and closure. Neither claims a compiled binary HTTP workflow or TTY acknowledgement.

## Rejected attempts and custody limits

Authority retains initial Python-scanner, control syntax/import and WASM-guard failures. Its
first registration control throws before signalling entry, and its first broad CLI mutation
selection emits secondary reflection/unhandled diagnostics: no clean causal credit. Corrected
separately named controls fail explicit admission/count assertions and restore green. Lifecycle
retains the noncanonical stream fixture whose eight cases time out before the intended barrier.
Its two natural-order mutants survive and earn no credit; fresh explicit-order controls prove
the same removals. Secondary test-abandonment rejections are not extra findings. Removing the
native abandoned-header observer causes a genuine unhandled rejection and is a semantic control.

Parent verifies 79 individually declared links per unique archive, private workspace targets,
target package hashes, physical inventories, direct installed tools, Git source identity and
actual rebuilt outputs. No whole node_modules/pnpm-store link, source alias, install, Turbo or
package-manager command supplies this proof. The nested DB-sync helper is deliberately not run;
no schema changes occur here. Explicit environment overrides are retained, not every inherited
variable. No full subprocess/syscall/network trace exists. Lifecycle's first broad baseline
precedes detailed child-helper inspection, so no retrospective preinspection assurance is claimed.
Application isolation is not an OS sandbox or Internet block; missing receipts remain missing.

Parent's true before-agent shared inventory has SHA-256
`efb920bb471d33c978d96b1b2c8c9be75e01af72d13e67e6d67101c9f90f34de`.
Both reviewers and Parent independently compare all 645,604 original entries with zero byte,
size, mode, mtime, directory or symlink differences, excluding only `.git`. Main is clean at
the exact reviewed HEAD; freeze release follows both full report reads and successful audits.

| Sealed artifact | SHA-256 |
| --- | --- |
| Authority full report | `8f341e6d7b698a88f7eed8e87c895e4c2c559076402929d78bbc854ab590aad9` |
| Authority physical inventory | `11ce9cdaa9ccd75fcda309e1460b3f0151b8c5f61dbfc342b8db11c8a99c0e0c` |
| Authority seal | `55b86e821d133c83db16b378586469a584c05918532685d11f690fbe25e25636` |
| Lifecycle full report | `5ebb0f6398af478ec13cbb0bb8c1f8d1013a5fdda61464b16b52a6d0cf3859f7` |
| Lifecycle external inventory | `0f9dd3eca9000b288f7e02ea02ece54f678a63218b9d1962a27275910038b8d5` |
| Lifecycle external seal | `858ec7770fa6105315ed7a0b612f85e439022b4e6ca0c9420aaa670982783acf` |

## Remaining acceptance

Exact `db02b83c` PR/push CI succeeds, including required tests, coverage floor, Node 22,
Windows and peers. Sonar's five new reliability labels have separate current-head triage;
their remote disposition is not this review's acceptance. Broader maintainability findings
remain individual work. Parent's root CI is cache-qualified, not a forced whole-wave pass.

Two new complete cumulative reviewers follow. Transitive MCP/custom-provider sends/readers,
raw poll/media accounting, all actors/generations, sticky final money/effect health, parked
clocks, public departure, acknowledged CLI teardown, Step 8 and whole Step 12 remain open under
[ADR-0103](../decisions/0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md).
All six W7 register items remain open; PR #90 remains draft and unmerged.
