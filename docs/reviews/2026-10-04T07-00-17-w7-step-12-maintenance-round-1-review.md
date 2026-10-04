# W7 step 12 — independent maintenance, round 1

- **Date**: 2026-10-04
- **Type**: Code
- **Reviewer(s)**: `/root/w7_step12_maintenance_round1_docs`, `/root/w7_step12_maintenance_round1_runtime`; parent `/root` verifies evidence and corrections
- **Subject**: `development`, `53cce9e3..f2fe5473`, all 25 committed maintenance paths
- **Outcome**: Changes requested; verified text corrections, fresh round 2 required

## Findings and corrections

Both reviewers independently identify one Medium source-truth defect across the
[seam](../reference/shared-core/llm-provider-seam.md),
[error standard](../standards/error-handling.md) and `llm-error.ts` comment.
An engaged call does not always hold a bounded reservation. More subtly, an allowance
can supply an admission solely to own the in-flight lifecycle of an unknown-price call,
without a numeric reservation or estimated debit. The parent independently reads the
turn settlement, governor admission and dispatch-allowance branches, including the existing
unknown-price ownership regression. All three statements are qualified by an existing
bounded reservation; actual usage, complete pricing and conservative commitment remain
separate facts. No estimate, policy, debit or runtime behaviour is introduced.

Both reviewers also verify an inherited Low contradiction in the changed
[event contract](../reference/contracts/sse-event-schema.md#security-credential-boundaries-and-sensitive-content):
the tool-call table still says “sanitized — no secrets” while its corrected Security section
restricts the protection to configured/declared fields and recognisable shapes. The parent
reads the registry sanitization branch and replaces the blanket table label with a link to
those canonical credential/content limits. Arbitrary user/model/tool content can remain sensitive.

## Scope, independent evidence and limits

The static reviewer reads every addition/removal/hunk in all 25 paths, reconciles the existing
16-document canonical landing checklist and supplies exact selected-source read depth. It
claims no whole-repository semantic read, runtime execution or new provider evidence.
Its checks resolve 1,427 local inline destinations and 183 approximate ATX anchors in 21
Markdown files, with no bad targets. Fenced, external, reference-style, HTML, render and actual
renderer-slug guarantees are excluded. Three production TypeScript token streams are unchanged;
this is a scoped lexical comparison, not a TypeScript parser proof.

The parent reads the complete 26,004-byte static report and verifies every no-follow sealed
entry: 1,200 entries, including 1,091 files totalling 21,140,451 bytes and 109 directories,
with zero links/special objects. All 1,078 source pins and independent file identities match.
Only the inventory excludes itself; root, hidden paths and complete evidence are included.

- Static report SHA256: `665212a476ca727ccd84e0b716de1d642260e7f8ccdad205db7c00559feed803`.
- Static inventory: 259,862 bytes; SHA256 `d2302f327e0392a011de2815f5bd3ebd2eaa4569b53e98336ee0c1d0f0542c3f`.

The runtime reviewer independently reads every one of the 36 changed hunks and traces the
real financial, credential/content and fixture paths. Its fresh physical Shared build, strict
DB typecheck including tests and **81 DB tests** pass. Corrupting the writer's actual input
reference fails the new retained-ref assertion; exact restoration passes the targeted fixture.
That targeted pass is not another 81-test suite. The unknown-price allowance regression is
corroborating source read, not a newly executed governor test.

The parent reads the complete 27,225-byte runtime report and verifies all 1,487 sealed entries:
1,307 files totalling 30,552,511 bytes, 172 directories, eight literal dependency links and zero
specials. Every source copy's 1,078 pins and independent identities match. The eight named
third-party manifests are pinned; complete transitive external package contents are not
inventoried. The offline/keyring guard is scoped Node protection, not an OS sandbox or a
general native/ESM guarantee. Tests run from isolated source and a fresh physical public Shared
copy, not original or previous-reviewer builds.

- Runtime report SHA256: `c5258532310c64b268597ec638d5a8bbde84acd4a48436c2f8045ad961e368b3`.
- Runtime inventory: 316,840 bytes; SHA256 `3bb2b15ac1e3cf2ca48cbb21f6553b7d8f94ad74611603a08ac73760f09d97ca`.

Both reports retain precise read depth and failed/truncated setup exclusions. The runtime
review excludes incorrect compiler/rg paths, a too-narrow esbuild bootstrap guard and an
initial audit that mistook its own temporary helpers for retained processes. The corrected
audit checks that those helpers exit; no unknown holder is killed. Early read-only calls are
not presented as an exhaustive durable shell transcript. All actual isolated source/test/check
invocations and failed logs are retained.

Both reviewers fully release future access. Their final audits report zero retained review
sessions/workers/children/SQLite handles, with scoped process/handle limits. After both releases,
the parent verifies all 1,078 original hashes/bytes/modes, exact HEAD/development and configured
clean status. Minimal-HOME filename-only local-settings status is recorded separately; that
untracked file's content is never read or copied. Sealed roots are read only for verification.

This maintenance reconciles implemented Steps 1–6/9–11, accepted supplemental ADRs and
bounded credential/content and usage/pricing contracts. It does not implement overflow
classification, measured/recovery compaction or every final landing obligation. The two
moved CLI follow-ups are closed after accepted Step 11; session budget follow-ups remain open.
The ADR-0097 addition preserves its entire historical prefix. Earlier reviews remain dated
observations and are not rewritten.

## Parent validation and next acceptance

After the four text/comment corrections, full `pnpm run ci` passes: 23 lint/typecheck/test
tasks (eight cached), seven build/format tasks (five cached), tools/DB synchronization,
seam/purity/dependency and bundle-closure checks, and compiled CLI/overflow/predecessor smokes.
Sequential `pnpm coverage` passes **327 files and 7,526 tests**, with 11 existing skips and
global line/branch/function coverage **95.88%/92.63%/96.73%**. Only this review record and
status/index links are added after those checks; they receive scoped documentation validation.
The final production/test bytes are the checked versions.

The four correction candidates change three documentation paragraphs/table entries and
one TypeScript comment. Bytes outside that comment block are identical. No new regression
test is added for prose; the existing meaningful DB fixture remains independently exercised.
The parent retains setup/read failures separately and never executes or mutates sealed roots.

A fresh complete committed-maintenance round 2 follows. Live provider captures remain the
prerequisite for Steps 7–8; whole Step 12, all six W7 register items and W7 remain open.
No PR, push, new architectural decision or verified residual deferral is authorized by this record.
