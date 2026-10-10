# W7 systematic group 3, round 4 — gate UI follows terminal authority

- **Type**: Code
- **Date**: 2026-10-06
- **Reviewer(s)**: `/root/w7_group3_round4_contracts`, `/root/w7_group3_round4_runtime`; parent `/root`
- **Subject**: complete operator correction `ad825fb1..14302351`, 42 changed paths
- **Outcome**: Changes requested; two verified Highs corrected, fresh complete round 5 required

## Findings and correction

Contracts independently verifies that genuine budget rejection opens a second queued card after
the actual `run:failed/budget_exceeded` acknowledgement. The command remains unresolved with native
SQLite open until unnecessary input arrives. Real authorization, eventual terminal, lease cleanup
and summary remain correct; this finding does not establish additional spend or writer corruption.

Runtime independently verifies that cancellation or an acknowledged authored ordinary-gate timeout
during Ink suspension still opens a stale card. An acknowledged timeout while production Clack's
first confirmation is pending also cannot dismiss that card. All five cases retain the command,
database and summary until dismissal. Eventual terminal, exit, writer, lease and summary are correct.
The pending-card direct await is inherited; no regression-origin claim is made for that phase.

`9a62d665` observes emitted rejection/terminal authority solely to suppress stale UI, rechecks after
suspension, and aborts the scoped pending card. Clack receives that signal for every confirmation
and text route, discards late answers and avoids opening a pre-aborted card. The driver also races
an injected prompter that ignores the signal; the primary iterator retains terminal outcome,
durability and cleanup authority. Rejection is inferred from the emitted budget authorization,
never merely from `engine.resume` returning: that return can be an idempotent no-op after a competing
approval. A genuine ordinary-human rejection still continues. No financial policy, timeout,
durable schema, dependency or public package API changes. The
[canonical command contract](../reference/cli/commands.md#relavium-budget-resume) owns the guarantee.

## Verification

Contracts (`gpt-6-astra / xhigh`) completes two fresh ordered five-package build sets and strict
compilation of its three new fixtures. Its final explicit 29-file focus has **742 passes and one
finding failure**, including all 727 supplied controls. Runtime (`gpt-6.1-sol / xhigh`) completes
fresh ordered builds and strict compilation of its two fixtures; its final 28-file focus has
**738 passes and five finding failures**, including all 727 supplied controls. Narrow causal
controls pass and exact production pins are restored. Runtime's pre-card diagnostic remains
explicitly incomplete when the pending-card case is added.

In a separate new unsealed copy, the parent reproduces **26 passes and six expected failures**
among the 32 independent cases, then all 32 pass with the complete correction. The 25 permanent
regressions have **nine passes and 16 expected failures** against exact pinned production, then
all 25 pass. Together with 78 existing controls, the corrected combined focus passes **135 cases**.
Native controls use actual command, quote, engine, SQLite and Ink store/summary paths. Additional
real Clack confirmation and text controls use synthetic streams and require raw mode, keypress
and resize cleanup on abort. Other controls cover every signal-forwarding route, late answers,
pre-aborted entry, genuine approvals/rejections and a winning real approval followed by a losing
rejection. There is no real-terminal-device claim.

Final Original forced lint/typecheck/test passes **23 tasks, 369 files, 8,286 tests and 12 existing
skips** under `CI=true`; six forced builds, test isolation, six-file format and `git diff --check`
pass. Five new genuine self-OS-SIGINT cases are explicitly skipped on Windows; other new native
and Clack controls remain enabled. No new Windows result is claimed. The initial Turbo invocation
rejects incompatible `--force`/`--cache` flags before task launch. A subsequent new-fixture generator
lint failure is corrected by awaiting its actual held pause-writer barrier; the final full check
follows that correction, without lint suppression or arbitrary delay.

## Evidence integrity and qualifications

Both complete reports, all 42 semantic dispositions per reviewer, five complete new fixture
bodies, preparation and causal qualifications are read. Giant repeated proof/environment registers
are independently checked by machine, with semantic qualifications read separately; truncated
initial combined output is supplemented. No child supplements exist. Before Original resumes,
the parent independently verifies every actual recorded nofollow physical metadata, content,
sorted directory-child list, literal/resolved link, target/manifest, source pin and Original receipt
field. Each Own has **1,149 restored source pins**, 79 named links and 11 canonical Own targets,
with unique single-linked source identities disjoint from Original. All **3,745 actual physical
entries** and **3,260 externally bound regular-file tuples** match. Complete artifact tables and
inventory self-metadata are independently bound; sealed Owns remain permanently retired.

| Own | Inventory rows | Actual entries | Report SHA256 | Inventory SHA256 |
| --- | ---: | ---: | --- | --- |
| Contracts | 1,848 | 1,849 | `65aa25e588b61b9424586deb1dc5d3cc1031c05f518777aa78692db41e84c2b6` | `eaca275c37da4fb23bcc6d828021c1e0d0d5bf242310f4c42e36dcbfb4c3503a` |
| Runtime | 1,895 | 1,896 | `be4664dee29ea0043e31248104255e876d06ea8c1fcd5242b2802a92b3f0c61a` | `c8ab9a89817fe4e7f9105e7cd9871375e8f7e76158887546c00c7ea55dd03785` |

Contracts' final independent probes cover one main, 29 source workers and three native helpers,
with 19 denials and 11 Own resolutions each. Runtime's final probes cover one runner main, 28
source workers and three native helper mains, with 36 denials and 11 Own resolutions each.
Extra preload-only bootstraps are separately qualified. Earlier SQLite helper spawns omit the
guard environment and are **not retroactively certified**; the final exact helper wrapper adds
sterile Own environment and independent pre-source proof. Neither review claims kernel or hostile
loader containment. Authored timeout controls invoke the actual already-armed timer callback;
they do not claim wall-clock expiry. Default real Ink mounts and injected mount waits are identified
separately. Repeated default mounts emit a before-exit listener warning; measured native database,
lease, SIGINT and timer cleanup is not a blanket process-resource certificate. Preparation locale,
fixture, build and schema-discovery misses remain qualified in their registers.

Group 3 stays open until fresh complete round 5 accepts the entire delta and all corrections.
[Round 3](2026-10-06T20-13-20-w7-systematic-group-3-round-3-review.md) remains historical evidence.
ADR-0102 is Proposed and unimplemented. Groups 4–6, three-of-five live captures, Steps 7–8/12,
current Sonar, W7 and draft PR #90 remain open. No key read, live call or additional paid generation occurs.
