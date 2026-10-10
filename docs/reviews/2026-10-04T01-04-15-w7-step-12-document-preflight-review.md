# W7 step 12 — independent document-maintenance preflight

- **Date**: 2026-10-04
- **Type**: Code
- **Reviewer(s)**: `/root/w7_step12_docs_restart_preflight`; parent `/root` verifies evidence and corrections
- **Subject**: `development` at `53cce9e3`, a frozen 15-overlay document draft
- **Outcome**: Changes requested; verified prose corrections prepared, post-commit review required

## Findings and corrections

The fresh static reviewer identifies two Medium inaccuracies in the candidate. The
[seam contract](../reference/shared-core/llm-provider-seam.md) makes supplied usage conditional
on pricing and assumes every engaged unpriced attempt holds an admission. The actual fallback
record retains supplied usage independently of pricing; Core retains a reservation only when
an admission exists. The parent reads those branches independently and separates usage,
fully priced cost, unpriced amounts or floors, and conservative commitment in the candidate.

The [database reference](../reference/shared-core/database-schema.md#secrets-at-the-write-boundary)
claims its DB fixture guards upstream masking transformations. That fixture supplies already-masked
placeholders directly to the pass-through writer; the fake raw value never enters it. The parent
narrows the claim to preservation of supplied placeholders, without asserting upstream redaction
or arbitrary-content secrecy.

A Low connected issue in [agent sessions](../architecture/agent-sessions.md#the-steering-channel)
says every event payload is secret-free. The directive-length rule applies to that reserved event;
other event payloads can retain sensitive content. The parent prepares a qualified sentence linked
to the [event credential/content boundary](../reference/contracts/sse-event-schema.md#security-credential-boundaries-and-sensitive-content).
This edit lies outside the reviewer's frozen 15-overlay scope.

The parent also prepares a separate DB fixture clarification: its title and comments describe
pass-through preservation, its example uses the current SELF slot `inputs.api_key`, and two
assertions check the retained `ref`. A connected [commit example](../standards/commit-style.md#examples)
is qualified to pre-content failover and supplied usage. Neither additional change is accepted
by the frozen draft review. They join the subsequent complete committed-maintenance reviews.
No new architectural policy, dependency or production behaviour is introduced.

## Independent scope and evidence

The reviewer reads all 15 complete baseline-to-candidate diffs, actual baseline guides and
selected connected source/document ranges. Its precise ledger names 65 confirmed reads and
expands the existing W7 checklist to 16 canonical paths; neither is a second normative checklist.
Large unaffected bodies, every ADR and the full repository are not claimed read. Oversized
truncated reads and failed static setup attempts are excluded and retained in the tool audit.
The report records high reasoning effort. The entire review is static standard-library Python:
no repository runtime, dependencies, SQLite client, network, keychain or paid provider call.

Scoped static checks find 849 local inline links, including 51 added-line links, with no
unresolved path or approximate generated heading anchor. Eight changed `docs/` files pass
scoped H1/frontmatter checks. These are not Markdown rendering, external/reference-style/HTML
link validation, formatter, lint, typecheck or runtime tests. The three TypeScript overlays
are comment-only; static non-comment comparison is corroborated by their full diffs.

The reviewer releases all future original, dependency, parent, prior and owned access with
no retained session, worker, child or SQLite artifact. The parent fully reads the 24,086-byte
report and 30,661-byte ledger, then verifies every sealed no-follow physical inventory entry:
**1,240 entries: 1,105 files totalling 21,220,294 bytes, 135 directories, zero links or special
objects**. The root itself, hidden paths, source, baseline and complete report artifacts are
included; only the inventory excludes itself. All 1,076 effective source pins and 15 baseline
originals match, and all 1,076 source copies have independent file identities from the original.
The parent never executes or mutates this sealed reviewer root.

- Report SHA256: `16806c84beb413cb225d41dbd2492df845494608f65a1e2150a97dfff57c3c68`.
- Inventory: 287,386 bytes; SHA256 `cca15c23eb88a188b54a2bb592a6e55c6ad1d57575ada60729b0bb887be7b42f`.
- Ledger SHA256: `57a3f22997abcc6c4a2a13e97bcc53dd48e70c61b7ad46ba6c30c1195b967421`.

## Parent checks and remaining acceptance

The parent's separate physical source copy passes **81 DB tests** and strict semantic TypeScript
for the revised fixture. Its final additional lower-comment clarification leaves every other
byte identical to that tested version. Earlier package-resolution attempts collect zero tests
because the initial parent copy is partial; those failures are excluded. The corrected run uses
complete owned source copies, an owned home/tmp/cache and source aliases, with no original project
source execution. It is not a universal network sandbox or whole-repository check.

The 18-file parent maintenance draft has 890 resolved local inline prose links across its
14 Markdown candidates. The four TypeScript candidates pass Prettier unchanged; Markdown is
excluded by the canonical ignore policy and is assessed against documentation conventions.
These candidate checks precede landing and do not replace the required repository CI/coverage
or fresh post-commit rounds.

Step 11 still awaits its separate full-step acceptance at this preflight checkpoint. Live
captures remain the prerequisite for Steps 7–8. This record closes neither Step 12 nor W7;
all six W7 register items remain open. No verified finding is scheduled for later debt.
