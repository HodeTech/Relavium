# W7 post-PR rendering correction, round 2

- **Type**: Code
- **Date**: 2026-10-04
- **Reviewer(s)**: `/root/w7_rendering_round2_runtime`, `/root/w7_rendering_round2_contracts`; parent `/root`
- **Subject**: `development`, `95137c34..d4e4fa9c`, all 24 changed paths
- **Outcome**: Approved — scoped rendering correction; whole PR and W7 remain open

## Summary

Two fresh independent reviewers accept the published-notice visibility and CI routing corrections
in `11e2575b`, together with the complete 24-path follow-up through `d4e4fa9c`. Neither finds an
additional material defect. This closes the rendering corrective group, including SR-02 and the
reproduced interactive-mode portion of SR-04. Other systematic findings, SonarCloud, measured-request
ownership and live-provider requirements remain open. The [round 1 record](2026-10-04T10-32-37-w7-rendering-round-1-review.md)
preserves the failures; the [effect-journal contract](../reference/shared-core/effect-journal.md#8-needs_attention)
owns the corrected behaviour.

## Coverage and findings

Runtime review uses `gpt-6-astra`, `xhigh`; contract review uses `gpt-6.1-sol`, `xhigh`.
Both review every scoped path in fresh physical sources: 1,089 pinned files, 79 individually named
dependency links and 11 internal links canonical to the respective Own. Clean HOME/TMP/XDG child
environments, main/worker network and native-keyring denial, exact fake-keyring resolution, five
fresh ordered package builds, internal type/runtime resolution and strict fixture types are checked.

Runtime review passes 108 permanent controls separately under `CI=true`, empty CI and
`CONTINUOUS_INTEGRATION=true`, plus 438 additional lifecycle controls. Twenty actual-Ink geometry
probes confirm the first complete notice precedes SQLite retention; six flush/close/error races,
two StrictMode/reseat probes and four acknowledgement/worker-denial controls pass. Counts overlap
existing controls and are not additions to the repository-wide count. Seven independent causal
variants remove visibility, second-flush handling, CI selection, publication ownership, Static
reseating, Home interactivity or chat interactivity; each fails and sources are restored exactly.

Contract review passes 214 permanent controls in each of the same three environments, six independent
worker/store-identity/reseat/native-stderr probes, and a restored broader pass of 16 files / 484 tests.
Four causal variants remove visibility, CI selection, publication ownership or Static reseating; each
fails and restoration passes. Both reviewers verify that raw Ctrl-Z tests exercise the supported
interactive route and actual CI plain-driver controls require stderr delivery before retention.

The parent previously passed `pnpm run ci` and sequential `pnpm coverage` on the correction:
328 files, 7,552 passing tests and 12 skips. Both GitHub workflow runs for `d4e4fa9c` finish with all
ten workflow checks green. SonarCloud remains separately red and under individual assessment.

## Evidence integrity and limits

After full release, the parent reads both complete reports and verifies every sealed record: bytes,
digests, modes, recorded metadata, literal links, directory contents, root names including the
inventory, hidden files and generated evidence. All source pins match unchanged Original HEAD with
distinct file identities; bootstraps and links/manifests remain exact. Sealed roots are never executed
or mutated. The different JSON and JSON Lines directory digest conventions are individually checked.

| Reviewer | Sealed records | Report bytes / SHA256 | Inventory bytes / SHA256 |
| --- | ---: | --- | --- |
| Runtime | 2,198 | 25,534 / `9765067b103dd7a8dcbe11a99bd8091cb44d17aa1c3e688df04e5ff815a7968e` | 568,459 / `1d64140ddf2c2cca037a1deb742e84eae27bd5df5b55bba157b93be557576fab` |
| Contracts | 2,028 | 26,561 / `58995bb8a403109061671c6a93efbe2f2e3fa812d0e15c07586b1d3c886e3898` | 727,000 / `a1d39e08788315e79a1ded7c2aab48af7016847c11c7b0205e4c936f96687c6c` |

The contract inventory excludes its own record, yielding 2,029 physical entries. A parent helper's
filename shadowing error overwrote named out-of-band receipts under a previous-review filename;
reviewer trees, bootstraps, sources and links were unaffected. The parent preserves the overwritten
receipt, fixes the helper and reconstructs named receipts from actual pre-spawn hashes and fully
verified released artifacts. Recovery is explicit rather than presented as an original receipt.
Reviewer fixture/audit setup failures and their corrections are also preserved and excluded from
passing acceptance. Neither reviewer claims live-provider capture, a physical-terminal/job-control
audit, full GitHub CI inside Own or full reading of every historical ADR body.

## Follow-ups

Proceed through the remaining systematic corrective groups with fresh reviews after every fix cycle.
The actual SDK request-ownership HIGH remains open. Steps 7–8, whole Step 12 and all six W7 register
items remain open; three genuine overflow artifacts do not establish the two missing provider records.
PR 90 remains draft and must not be merged.
