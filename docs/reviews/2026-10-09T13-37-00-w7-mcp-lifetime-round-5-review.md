# Review: W7 MCP transport and protocol lifetimes, round 5

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`mcp_authority_r5`, GPT-6.1 Sol, xhigh;
  `mcp_lifecycle_r5`, GPT-6 Astra, xhigh), plus Parent's complete report,
  source-map, artifact and shared-tree audits.
- Subject: complete cumulative MCP increment, `8e3818b66732add45e13ca0f12d3296e24a01d81`
  through `99c46bbd3a4a249023206930b6ba88edbeb90a19`: 38 paths / 70 literal hunks.
- Outcome: both fresh reviews report zero new confirmed findings. The scoped
  transport/handler/CLI-fetch increment is accepted after five cumulative rounds.

## Scoped acceptance

Both reviewers independently inspect every changed path and hunk, all new implementations
and tests, relevant unchanged contracts and installed SDK source. They re-evaluate the
earlier corrections rather than inherit their verdicts. Completed HTTP control references
are released only on their exact complete work acknowledgement; independently pending
send/body/native-close work remains retained. The seven reference-count controls do not
measure native heap, GC or a remote network leak.

Each reviewer independently passes the five cold shared/llm/core/db/mcp builds, strict
MCP/CLI typechecks, lint of all 26 changed TypeScript paths and the prescribed offline
suite: 18 files / 268 passing cases, zero skipped. The cumulative increment contains
77 added permanent cases. CLI proof is source Vitest using rebuilt private libraries,
not compiled CLI execution. The five native controls run on macOS; synthetic held close
acknowledgements and the 12-case reference/native-store producer matrix retain their
precise boundaries. Neither reviewer runs new probes, mutations, root CI or coverage.
Earlier before-fix controls and root CI/coverage remain separately attributed historical
evidence in [round 4](2026-10-09T12-58-01-w7-mcp-lifetime-round-4-review.md).

## Evidence and qualifications

Parent reads both complete reports and Markdown maps, verifies their JSON counterparts,
all 38 frozen head files and all 70 literal Git hunks, every original runner receipt/log
and copied input, every retained installed-dependency snapshot and all individual aliases.
Authority has nine original project runs / 11,187 copied inputs. Lifecycle has the same
nine project checks plus nine administrative search/map runs / 22,374 copied inputs;
its first context search fails on a nonexistent path and receives no semantic credit.
All nine prescribed checks pass for each reviewer without repeats.

Parent verifies all 13,993 Authority and 25,454 Lifecycle inventoried regular files,
their three self-controlled files each, 1,231/2,107 owned read-only directories and
99 symlinks each. Each reviewer also retains 983 task-owned temporary files and exact
snapshots; their 25/34 temporary directories are protected. Read-only modes guard
accidental writes; they are not cryptographic immutability against their owner.

Some early administrative source displays lack complete original physical stdout/argv
receipts. Both reports explicitly distinguish tool-transcript records, later exact source
copies and labelled reproductions from original process capture. Every project check has
its original capture. Parent's preliminary schema/path audit failures are retained and
receive no project or semantic credit.

Parent identifies four factual map-attribution errors in Lifecycle's sealed original:
deadline observation wording, stdio imports, direct test assertions versus PID consequences,
and sequential client/owner close awaits. A separate preserved correction synchronizes
both complete maps and qualifies the report; it changes no source, test, original seal or
verdict. Parent verifies its exact diff, bindings, protected inventory and all unchanged
map/head/hunk identity before acceptance.

The whole shared-tree comparison covers 646,773 entries. All regular file bytes, modes
and mtimes, all symlink targets, source, outputs, caches, dependencies and Git files match;
the branch and head remain clean. One difference remains: the `.git` directory mtime.
Parent ran plain `git status` at resumed-turn entry; an optional index-lock refresh is a
plausible cause, not a process-attributed filesystem trace. Both original snapshots and
that qualification are preserved. This is not an identical-tree or zero-metadata-change
claim; no timestamp is restored to manufacture one. The reviewed source is unchanged.
Explicit freeze release precedes subsequent development-source edits.

| Artifact | SHA-256 |
| --- | --- |
| Authority report | `35126a35bb63babb586b8a4d61f8091bda7911bd796e26f5ad055571cf914d16` |
| Authority seal | `a7c73e7de1f5e8a943d5d7dcbb226f99e5182de4ec983baee82e58235b150180` |
| Lifecycle original seal | `e01c59b1f6b7e6c9a456120ae497e5c5af9afc9421f1ebbe2b89231d4f2d9045` |
| Lifecycle corrected report | `ebe1bcef0667b82fc09dfe9047577df576c5ad95ebbe50f58be3fe5846262f89` |
| Lifecycle attribution-correction seal | `afd7503654968128c418ab12fd7aa6d864b89220f57bac84bd9afc4020b09fd1` |
| Shared true-before snapshot | `26d4113842cef9d2ae0686c229f1f9130089077c7b57a9616b3dd6243755f721` |
| Shared after snapshot, with qualified directory mtime | `d1110a82ebb4aa910526759056cea2057f4a51b078152859b0cea55957746302` |

## Remaining work

The [canonical MCP contract](../reference/shared-core/mcp-integration.md#invocation-and-transport-lifetimes)
continues to separate bounded caller results from actual producer acknowledgement.
[ADR-0103](../decisions/0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md)
and [the W7 plan](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md) retain
complete manager startup/all-engine actor ownership, custom-provider descendants, sticky
final receipt health, parked clocks, public departure and acknowledged CLI teardown as
open. Step 8 atomic compaction/recovery, final Step 12 and all six W7 register items remain
open (41/51 closed). Current required CI and coverage are green; Sonar dispositions and
final whole-wave gates remain open. PR #90 remains draft and unmerged. No additional
paid operation, credential or ADR approval is pending.
