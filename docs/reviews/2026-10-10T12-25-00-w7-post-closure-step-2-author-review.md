# W7 post-closure Step 2 — author verification

- **Type**: Code + Security
- **Date**: 2026-10-10
- **Reviewer(s)**: Parent `/root` (author verification, no independent review credit)
- **Subject**: CLI/DB correction increment after `d7afc20b`
- **Outcome**: implementation verified; two NEW complete independent review rounds required

Opening maintenance now forwards the existing fixed deferred-checkpoint warning to stderr.
Synchronous/rejected diagnostic failures cannot revoke a successful open, close the caller's
connection or repeat maintenance. Native SQLite evidence holds a reader, clears legacy result
bytes logically, observes the deferred warning and sensitive synthetic WAL bytes, then releases
the reader and proves the next empty opening checkpoint removes those bytes. The proposed
only-if-rows-changed optimization would break this accepted physical-erasure retry contract.

Session effect audit queries select metadata and SQL NULL rather than the stored result column.
Malformed planted legacy results are neither selected nor parsed; run readers retain real replay
results. Explicit two-process allocation execution now fails with an actionable missing-build
message instead of silently skipping. The required Turbo graph already builds this package.

Policy refusals are sanitized at their terminal boundary. Misplaced capability comments and the
warning-local shadow are corrected. The unused finalizer callback is removed: the production
driver already acknowledges input release, host departure and primary draining before calling
finalize. Existing driver integration and renderer failure/retry coverage retain that order.

Nine new permanent cases are added. Twelve focused suites pass 159 cases. Three exact-source
interventions fail six expected behavioral assertions (opening notice three, session selection
two, policy sanitization one), then restore byte-identical production sources. The first two root CI
attempts identify a missing required memory field and a control-regex lint violation in the
new test fixture; correcting both gives a green third `pnpm run ci`, including all offline smokes and formatting/fences.
These author receipts do not substitute for independent review and are not added together into
a synthetic total test count.

External evidence: `~/.codex/relavium-evidence/w7-new-review-20261010/step2-{focused,ci,ci-v2,ci-v3}.json`,
logs, `step2-causal.json` and retained expected-failure logs. Core acceptance remains scoped;
tooling/document corrections and final new gates remain open. PR #90 stays draft and unmerged.
