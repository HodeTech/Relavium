# Review: W7 raw provider/native lifetime, round 1

- **Type**: Code + Security
- **Date**: 2026-10-09
- **Reviewer(s)**: `/root/raw_producer_r1_authority`, `/root/raw_producer_r1_lifecycle`; Parent `/root`
- **Subject**: complete `97d8450a..fde3ca0c` increment, 17 paths / 38 hunks
- **Outcome**: One independently verified High corrected; fresh complete cumulative round 2 required

## Verified public-return defect and correction

Both reviewers independently obtain the actual declared private-built FallbackChain export,
read text or a confirmed stop, then call the public iterator's `return()`. A retainer refuses
only the final cleanup entry. The generator stores that failure in `finally`, but its
post-finally emission/rethrow is bypassed by abrupt return. Return incorrectly succeeds;
already confirmed stop usage receives no attempt observation. Both reviewers observe zero
records directly. Authority's initial expected-cause comparison uses deep equality; lifecycle
and Parent separately verify original identity. No paid invoice or newly reproduced shipping
ledger loss is claimed.

Parent independently reproduces the defect, moves the one refusal handler into generator
`finally`, and adds two permanent text/confirmed-stop controls. They require original refusal
identity, exactly one provider invocation/attempt, and the known usage on the stop branch.
An established provider/deadline diagnosis remains primary. Raw cleanup still enters separately;
there is no unbounded await, retry, new refund, second money authority or manufactured terminal.
A documented one-line `no-unsafe-finally` exception is intentional: this host refusal must
reject the consumer's abrupt completion after accounting. No general lint rule changes.
The [canonical seam](../reference/shared-core/llm-provider-seam.md#the-per-attempt-deadline)
and an additive [ADR-0103 note](../decisions/0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md#raw-stream-consumer-return-correction--2026-10-09)
record that boundary.

The original committed increment has 26 distinct permanent cases; this correction adds two,
for 28 (17 LLM, five Core, six CLI). Review probes and overlapping reruns are not additive.
Parent private corrected checks pass strict LLM, full LLM lint, changed formatting and the
341-file affected suite: 7,465 passes / 12 existing skips. A compiled causal removal moves the
handler back outside finally: both unchanged regressions fail, then exact byte restoration,
rebuild and rerun pass. Five library export inventories are identical after restoration.
The first Parent exploratory text fixture used a noncanonical `text` discriminator; that
exploratory branch gets no proof credit. Corrected permanent `text_delta` and stop regressions
fail on exact original HEAD before repair. The invalid fixture and initial strict/lint failures
remain retained externally; no assertion is weakened to claim a pass.

## Independent complete coverage

| Reviewer | Independent broad baseline | Additional controls | Causal outcomes |
| --- | --- | --- | --- |
| Authority, GPT-6 Astra / xhigh | 365 files; 7,985 passes, 12 skips | Six actual WorkflowEngine controls; two failing return probes | 12 removals: ten semantic kills, one survivor, one transition-latch failure without kill credit; separate repair/restoration trial |
| Lifecycle, GPT-6.1 Sol / xhigh | 374 files; 8,137 passes, 12 skips | Six actual WorkflowEngine and five native positive controls; two failing return probes | Eight mechanisms / ten executions; next-entry workflow survivor retained, built-export exact assertions kill removal |

Each reviewer independently disposes every one of the 17 paths and 38 hunks; domain emphasis
excludes none. Authority's four baselines cover LLM/Core/DB/actual CLI. Lifecycle's affected
run also covers MCP, with 14 direct checks. Both use cold private declared exports and actual
installed binaries. Native/reference matrices retain the exact lease owner/generation and
receipt heartbeat after bounded failure until raw inline/media/installed-SDK work settles;
late work adds no pin, second call, cost event or terminal. Native SQLite is in-memory actual
better-sqlite3, not disk/WAL or cross-process acceptance. SDK HTTP is offline canned input.
Native running-child faults are injected into a real child; they are not OS-generated kill
faults or remote/grandchild termination evidence.

Both individually adjudicate four S4822 labels as synchronous factory/entry-provenance false
positives. Async producer rejection is consumed by its actual observer/race; cleanup already
has a separate catch. Those judgments do not dismiss the concrete public-return High.
Parent separately [applies and reads back the four scoped dispositions](2026-10-09T02-36-20-w7-sonar-producer-disposition-review.md).
No runtime dependency, platform import into Core, SDK type leakage, request callback, body
persistence, schema/event or new financial policy is added.

## Full reports, artifact seals and Parent audit

Parent reads both complete reports: Authority 409 lines / 55,008 bytes; Lifecycle 144 lines /
28,608 bytes. They are preserved under separate unique external roots:

- Authority: `/var/folders/d2/k7c1fj3976g7_qq7113f66p00000gn/T/relavium-c1-r1-authority-8qzft6mn`.
- Lifecycle: `/var/folders/d2/k7c1fj3976g7_qq7113f66p00000gn/T/relavium-c1-r1-lifecycle-a472i02h`.

| Binding | Authority | Lifecycle |
| --- | --- | --- |
| Report SHA-256 | `989753a1195705fca14a6ce78f521e8031741dd34fbee1bb3c02dfe6c8815c42` | `12a67740d8f1ed0b8e7b31d913bb5c265b46e88802dfb790e896f1cfc49673a1` |
| Inventory SHA-256 | `c43269480d6d247ec95cf39805a39efc9067097f246b3b5ea1b6bc9e943509b1` | `9615248a8a6b9fce2aaea2c7f980ce940a3255e363990a332a05be258d93dd5a` |
| Seal SHA-256 | `ea44b133b7367fcc75bdc4b8c9c5a8d7253c97ec3910848ed392ddc7b11e8057` | `7dd053453ae35c12457a5c6f901595c5d8b21c11386e0c7d6f6fd17ddaf16f58` |
| Physical sealed entries | 5,015: 4,565 files / 313 directories / 137 links | 2,207: 1,881 files / 199 directories / 127 links |

Parent independently verifies every physical artifact hash/mode/link, exact archive originals,
all source/diff/hunk scope, command-log bindings, actual declared export restoration and causal
outcomes. Both private archives match all 1,239 committed files. Authority binds 91 command
receipts; Lifecycle has 73 directly hashed logs and 318 restored library exports. No root is
reused or artifact changed after sealing. This is application/path isolation and tamper-evident
custody, not an OS-enforced isolation claim.

The Parent true whole shared snapshot predates both agents. Its 645,495 entries match the final
snapshot byte hashes, modes, mtimes, directory entries and link targets, excluding Git metadata.
Initial SHA-256 is `3e558bca0bd418b7fa4e80c7a097e9af45ba003b990e10522ee737ea12bb5dc0`;
final is `2d680eded6cf22dc2e3d04348b1dded3776877bd7ba200c95a9a7da65fc44418`.
Root audit receipts are `/tmp/relavium-c1-r1-root-{authority,lifecycle}-audit.json` and
`/tmp/relavium-c1-r1-root-full-shared-audit.json`. Only after both full reads and all audits
pass does Parent release the shared freeze for the confirmed correction.

Qualifications remain explicit. Authority first captures runtime-entry resolution after its
baseline, not prebuild; its per-causal export manifests exclude CLI bundle equality, while
restored CLI rebuild/behavior and final generated inventory remain bound. Its first setup
traceback is unavailable. Lifecycle's original setup was stdin without a standalone script;
some large auxiliary historical reads were truncated. Its initial retry/native/strict/audit
fixture faults and first ENOENT causal finally-join limitation are retained and corrected.
Next-entry survivors and transition-latch failures get no semantic kill credit. Parent's first
Authority auditor incorrectly compares initial link JSON with an augmented final schema;
its retained v1 and corrected field projection verify all 99 actual link targets. Prior damaged
historical setup custody and overwritten aggregate logs are neither repaired nor re-credited.

## Validation boundaries and next round

Exact original-head PR run 37872795467 and push run 37872790297 have all five jobs successful:
required CI, coverage floor, Node 22, Windows and peers. These are Parent remote receipts,
not reviewer execution. Original-head root CI passes 395 files / 8,948 cases / 12 skips;
23 tasks have eight cache hits, and seven build/format tasks have five. Neither is forced
final whole-wave validation, and green jobs do not erase the verified High.

The corrected tree also passes actual `CI=true pnpm run ci`: 395 files / 8,950 passing cases /
12 existing skips, in 85.5 seconds. All 23 tasks pass (eight cached); all seven build/format
tasks pass (five cached), with all three offline smokes. These cache-qualified results are
not forced final whole-wave validation. The two additional passes are the new regressions.

The correction proceeds to a NEW complete cumulative round with new reviewers and unique
roots. This report does not accept C1. Transitive HTTP/MCP work, raw polling/media accounting,
all engine actors/generation retirement, sticky final money/effects, parked clocks, public
publication/departure and acknowledged one-pump CLI input/exit remain open. Step 8 and Step 12,
all six W7 register items and systematic ownership/lifecycle Highs remain open; 41/51 is unchanged.
All five live captures remain complete; no new paid call, keychain input or ADR approval is needed.
