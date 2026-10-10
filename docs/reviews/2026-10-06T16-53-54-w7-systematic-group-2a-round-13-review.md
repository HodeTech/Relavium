# W7 systematic group 2a, round 13 — cold operation ownership

- **Type**: Code
- **Date**: 2026-10-06
- **Reviewer(s)**: `/root/w7_group2a_round13_contracts`, `/root/w7_group2a_round13_runtime`; static supplement `/root/w7_group2a_round13_runtime/static_scope`; parent `/root`
- **Subject**: complete scoped review `90a5eee8..902b692a`; correction `9f35173a`
- **Outcome**: Changes requested — one independently reproduced High corrected; fresh complete round 14 required

## Finding and correction

Both fresh reviewers independently reconstruct a real session with completed history and reproduce
a cold provider resolver starting a nested `sendMessage()` while `compact()` still appears idle.
The nested turn owns its controller, but outer compaction then installs a second controller. Abort
reaches only compaction: two provider calls/controllers have abort flags `[false, true]`, and the
nested turn completes with `stop`. Real primary session-handle and passive event-bus sequences agree.
This is a supported custom-host callback boundary; the first-party CLI resolver is currently a pure
adapter lookup. No ordinary CLI billing incident or duplicate-terminal defect is claimed.

`9f35173a` rechecks the existing idle precondition after plan resolution and the terminal-cancellation
guard, before controller setup. A nested running operation retains its controller; outer compaction
throws the existing `SessionStateError/not_active`. The causal runs have one provider call/controller,
abort flag `[true]` and an `aborted` turn terminal. Cold cancellation, idle abort and warm memoization
remain intact. The canonical [session contract](../reference/contracts/agent-session-spec.md) and a
dated [ADR-0055](../decisions/0055-cli-host-capability-seam-tool-environment-factory.md) correction
describe this existing-contract repair. No new error code, capability or financial policy is introduced.

The permanent [cold-operation regression](../../packages/core/src/engine/session-cold-operation-ownership.test.ts)
retains the actual resume, provider, controller, primary/passive and terminal controls; promotion
strengthens exact ownership assertions and drains handles. The separate
[generated projection/pricing matrix](../../packages/core/src/engine/generated-projection-pricing-order.test.ts)
retains valid cache/media usage on output-projection failure, prices it once at 40 synthetic
microcents, preserves simultaneous pricing-failure precedence and distinguishes genuine transport
retry from bad-request refusal. Unused throwing generators become ordinary throwing methods for lint;
no behavioural assertion is weakened. This bounded result projection is not Proposed ADR-0102
whole measured-request ownership.

## Review coverage and verification

Contracts uses `gpt-6-astra / xhigh`; Runtime uses `gpt-6.1-sol / xhigh`. Both complete the supplied
63-path scope. Runtime's nested static reviewer reads the entire 653,746-byte / 14,290-line patch and
actual money, governor, registry, DB and CLI callers; its complete supplement is separately read by
both Runtime and parent. Static coverage is distinguished from independent runtime reproduction.
Earlier interrupted round 12 is historical qualified evidence, not a fresh acceptance substitute.

On restored production pins, Contracts passes five fresh ordered builds and strict fixtures;
35 focused files have **918 passes / one expected failing regression**. Its repaired causal run has
33 passes. Runtime passes five fresh ordered builds and strict fixtures; 37 focused files have
**1,143 passes / one reproduced failure**, comprising 1,120 pinned cases and 24 fresh cases.
Its causal candidate has 1,144 passes, then exact original source bytes are restored. The native
SQLite command-journal control is freshly executed; this does not certify physical disk erasure.
Current real money queues, actual admission and workflow final-ledger controls retain truthful usage,
writer identity and failure precedence; no additional substantiated defect is found.

The parent's 16 promoted controls against unchanged Original production have **one failure / 15
passes**: the nested turn completes with `stop` after abort. Removing only the operation check from
the separate prepared Parent likewise reproduces the failure; that Parent includes pending groups
and is not presented as the Original baseline. Corrected Parent strict compilation and all 16
controls pass. Final forced Original lint/typecheck/test passes **23 tasks, 357 files, 8,195 tests
and 12 existing skips**. Forced build passes six tasks; test isolation and diff checks pass.
The Accepted ADR-0055 byte prefix is preserved. Fresh independent corrective review is still required.

## Evidence integrity and qualifications

Both complete reports and Runtime's complete static supplement are fully read before Original
resumes. Parent independently verifies every recorded nofollow physical metadata/content/child-list
field, link/manifest field and inventory self, plus all 1,133 source pins and pre-runtime Original
receipt rows per Own, 79 literal links/manifests and 11 canonical Own targets. There are **3,526
actual physical entries**, including the two inventory files; inventories record 3,524 rows because
only each inventory self is excluded. Root child lists include inventory self. Sealed Own trees are
never executed, edited, cleaned or resealed by parent.

| Own | Inventoried rows | Actual entries | Report SHA256 | Inventory SHA256 |
| --- | ---: | ---: | --- | --- |
| Contracts | 1,765 | 1,766 | `044d0de3a5600cc9e7fdb4d2ade31816a6eb67c57b974b60835668259e0c862a` | `d6653977a3d74eb517b66725a4b78f321ddc72f47a4d5419f61e708143ff9d88` |
| Runtime | 1,759 | 1,760 | `d3c160c66133b4d8076d32662f01ccc933b8cd67a9fa97745958415a588de590` | `27f30f4d8c98d60c6562a7dcca3695f19df43962fe69a03729cfa5555e5dac68` |

Reports name exact command/read/change/preparation/proof registers. Actual main/source-worker
proofs independently deny credential/network families and resolve Own packages before source import.
Early inherited static environments, truncated reads, refused Apple/runner entries, fixture
type/import/timer failures and a failed causal preimage remain explicit. The static child initially
runs `pwd` from Original cwd without env-i, reading no Original file or application code. Some early
static heredoc bodies remain only in tool history. Parent's first schema inspection prints the full
Contracts report then fails on an assumed `rows` key; the corrected audit uses its actual `entries`
schema and passes every field. No preparation failure is called a green verification or a perfect
initial launch. Atime is not recorded; Contracts uses exact reported birthtime seconds without
invented nanosecond precision. No automatic approval rejection occurs or is bypassed.

There are no live provider calls, keychain reads, additional paid generation or whole-wave/Sonar
acceptance in this review. Round 14, ADR-0102 approval and implementation, remaining systematic
groups, live-fixture-gated Steps 7–8 and final Step 12 remain open. Draft PR #90 stays unmerged.
