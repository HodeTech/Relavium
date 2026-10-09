# Review: W7 invocation-local provider and raw-poll lifetimes, round 3

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`provider_invocation_r3_authority`, GPT-6 Astra, xhigh;
  `provider_invocation_r3_lifecycle`, GPT-6.1 Sol, xhigh), followed by Parent's independent evidence audit.
- Scope: all 28 paths / 67 cumulative hunks from `7d59de51de67f6fac05290e2140c0da049538921`
  through `f9a8ff37ee2147c6c1dff6d8310a5676dbbe5469` on `development`.
- Result: no new confirmed finding. Both complete reviews and Parent's artifact/freeze audits
  accept this provider/raw-poll increment. Whole W7 and PR #90 remain open.

Both NEW reviewers examine the complete cumulative source, tests and documentation, including
[round 2's getter correction and historical evidence limits](2026-10-09T06-33-00-w7-provider-invocation-round-2-review.md).
Each extracts the exact Git archive, cold-builds five libraries and the actual CLI, checks the
vendor seam and Core purity, and supplies a disposition for every path and hunk. Parent reads
both full reports, maps, independent fixtures and runners, then independently verifies every
physical artifact, available command/log binding, archive and exact generated-output restoration.

## Independent verification

| Evidence | Authority | Lifecycle |
| --- | --- | --- |
| Fresh independent controls | 12 pass | 13 pass |
| Broad affected selection | 204 files / 5,175 pass / 11 existing skips | 405 files / 9,043 pass / 12 existing skips |
| Distinct strictly built semantic removals | Five | Eight |
| Exact source/test/generated-output golden | 1,623 files | 1,618 files |
| Physical evidence entries | 3,244 | 3,386 |
| Receipts, including aggregate/special records | 106 | 107 |
| Full archives, including frozen Git source | 12 | 18 |
| Tracked Git files / individual dependency links | 1,260 / 79 | 1,260 / 79 |

Counts overlap and are not additive. All 57 permanent increment cases are covered. Authority's
broad run uses its preserved pre-format final fixture; final formatted bytes separately pass
strict/lint and restored controls. Lifecycle's broad run overlaps private-fixture refinement,
so it does not identify which private-fixture version loaded. Both versions have original bytes
and independent green receipts; the final exact selection passes 75/75. Shipping source stays
unchanged. These broad selections are not forced root CI or final whole-wave coverage.

The controls challenge call-time getter/receiver capture, opaque pre/post-transfer refusal,
installed SDK wire behaviour, per-invocation fetch custody, queued public return/throw, independent
raw next/return/native-close completion, speech bytes, retired Sora download and fresh media-poll
ownership. Public Core paths use reference and actual native SQLite stores. Held key/raw/child
polls retain the exact lease and heartbeat after bounded terminal delivery, then release without
late pin, cost or event-log changes. Deliberate semantic removals pass strict checks and actual
affected builds before runtime, fail their matching assertions, restore exact goldens and pass.
The poll-forwarding removal proves the missing argument assertion; the separate registry removal
proves early lease release. A selected aggregate-observer control does not separately certify
every iterator observer.

The native loopback fixtures delay safe-egress acknowledgements after genuine native close;
they do not keep an OS resource physically open. Simulated close promises and private helper
imports are distinguished from installed SDK/public engine evidence. CLI binary checks cover
boot/version/help, not full workflow/TTY departure. Application-local TMP/XDG/cache paths and
79 individual read-only dependency links are not an OS sandbox or complete process/network trace.
HOME is unchanged. No installer, nested package-manager/DB-sync run, credential action or paid
provider request supplies this review's evidence.

## Custody and qualifications

Failed Python extraction, `/tmp` alias assumptions, private-fixture strict/lint/cap expectations,
regex/doc-heading checks and preliminary audit/seal helpers remain preserved and excluded from
passing proof. Authority's initial map overstatements are corrected in its final map; original
draft bytes remain. Lifecycle's first final-audit attempt lacks nested Git outputs and receives
no reconstructed credit. Its archive receipt has binary stdout and no recorded end time; its
106 textual log pairs are distinct from that compact receipt. Authority also retains special
archive, failed-setup and actual shared-check tool-return records. Neither receipt total denotes
that many independent tests. Parent's own two preliminary authority-audit schema/path assumptions
fail before acceptance; their original helpers/output remain beside the corrected complete audit.
Earlier round custody gaps remain in their immutable historical records.

Private XDG configuration makes the pre-existing globally ignored `.claude/settings.local.json`
visible to Git. Ordinary inherited Git configuration is clean at the frozen head. Parent's
true-before/final comparison independently confirms that file and all **645,743 shared entries**
are unchanged: zero byte, mode, mtime, directory or link differences, excluding `.git`. No settings
content is displayed. Both reviewer seals remain unchanged before freeze release. Authority's
physical inventory records bytes/modes/link targets; Lifecycle additionally records mtimes.

| Bound subject | SHA-256 |
| --- | --- |
| Authority report | `9e314fcb964c57ee13291999e76e858d7e71c081478bf808333045881d42f466` |
| Authority inventory | `d961bd41cfb5d884c0e6a184aae8242d12993bb230f216761dc2057565c30635` |
| Authority seal | `4064a35b1db15573c60fb22bbcae7a522b4a8806b9bbfb46b3ea4adc976beb98` |
| Lifecycle report | `b79c7308d3d6778cb6e9806678ac2677bf2503bb5c76608e141614ffb1595c84` |
| Lifecycle inventory | `20d23b009d265131482efc3592dc58c77af446036a7ce6fbb47e32f6a1a35817` |
| Lifecycle seal | `b50c139c22b76f48838431244f43b0150692b9356d88cb0dc1a37ff2098cfd03` |
| Parent true-before whole shared snapshot | `7c36d8b3a975a51c4ed042fd013959ac43dce34b0d1e2c56c2382092eef7d3f1` |
| Parent final whole shared snapshot | `93faa2f1787b7f111a5ee7c49f3099f793e7516f24203c47bbdc270c2f946934` |

Parent separately queries PR #90 at exact head `f9a8ff37`: required CI, coverage, Node 22,
peer/Windows checks and Sonar succeed; Sourcery is skipped. The preserved query stdout SHA-256 is
`f4adcd73c02dd0ee2e930bfb6cb07a7df51b991c8452b8a9748597736c846997`.
This is current-head check status, not blanket disposition of every historical quality label.

**This scoped increment is accepted.** MCP transport/handler descendants, remaining actor and
generation retirement, sticky final effect/money disposition, original parked clocks, public
departure and acknowledged CLI teardown remain open. Official Gemini and arbitrary foreign-stream
hidden producers are not certified by this increment. Step 8 compaction/recovery, final Step 12
and all six W7 register items stay OPEN (41/51 closed); PR #90 remains draft and unmerged.
All five live records are complete; no further paid call, credential or ADR approval is needed.
