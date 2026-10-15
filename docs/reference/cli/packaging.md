# CLI Packaging Contract

- **Status**: Proposed — unshipped, maintainer approval required
- **Date**: 2026-10-15
- **Related**: [ADR-0111](../../decisions/0111-cli-meta-operations-use-a-lazy-packaged-runtime.md), [commands.md](commands.md), [release runbook](../../runbooks/release-a-surface.md)

This is the proposed canonical artifact/custody contract. Current single-bundle
packaging remains governed by ADR-0047/0051 until approval and implementation.
No release, production recipient setup or asset upload is performed by this document.

## Finite runtime package

One executable ESM entry and finite runtime chunks live directly in `dist/`.
Engine workspace code is inlined; declared third-party runtime dependencies stay
external. No unresolved internal package imports or second loaded authority
instance (shutdown registry, media iterator provenance) is allowed.

The build inventory lists every JS output and static/dynamic import. Compare it
with actual emitted and packed files; reject absent/escaping/extra JS, duplicate
or escaping tar entries, unbundled internal imports, undeclared external packages
and unanalyzable runtime loading unless explicitly reviewed/allowlisted.
Chunk layout must preserve real installed `../drizzle` resolution. Runtime files,
migrations, package metadata and existing documented license/changelog assets
form an explicit public allowlist. Only the entry has its source hashbang and executable mode 0755; runtime chunks
have no hashbang and mode 0644. Remove the global tsup banner before emission,
not a first-line rewrite after mapping. Validate tar modes and every output.
No source TS/tree, map, private inventory,
build metafile or sourceMappingURL may enter npm.

The lightweight entry imports only pure flag/descriptor/diagnostic/owner substrate.
Runtime modules load under the early fault boundary. Native witnesses and static
reachability prove meta operations do not touch config/cache/DB/keychain/MCP/UI.
Meta parsing retains pure grammar/count/size/absolute-root checks, but does not
stat/admit root directories: `--help --allow-fs-root <absent-absolute-root>` now
succeeds without granting authority. Real execution still admits first.
Descriptor grammar and JSON help belong to [commands.md](commands.md#proposed-wave-3-cli-compatibility).
The lazy dispatcher owns one invocation-local `seedFileCatalogOnce()` gate after
filesystem admission and before first pricing/model access. Its callers share the
same guard across Home/new/resume/clear/reseat. Preserve current DB overlays in
run, gate quote/execution, chat fresh/resume/clear/reseat, Home fresh/resume,
standalone agent and models; these eleven current call sites are an audit
inventory, not eleven new seeds. Empty/torn DB cannot erase fallback, current DB
tail wins, offline agent fixture and media no-cache exceptions remain.

One registry instance passes through the chunk graph; no global-symbol bridge
silently replaces existing private-module provenance.

## Build, map and candidate identity

1. Build inlined dependencies fresh in an isolated candidate job with external
   TypeScript maps and no inline source contents. Ordinary workspace builds stay
   map-free. Disable build-cache read **and write**, including Turbo local/remote,
   Actions build caches and later broad capture; force alone is insufficient.
   In the owned fresh checkout, clean dependency dist/incremental files, then run
   installed tsc with `--sourceMap true --inlineSources false --incremental false`
   against each existing tsconfig.build.json in order shared → llm → core → db →
   mcp. For example `pnpm --dir packages/shared exec tsc -p tsconfig.build.json
   --sourceMap true --inlineSources false --incremental false`, then the remaining
   packages in that order. This bypasses Turbo cache entirely; do not alter ordinary
   map-free scripts/config defaults or install a different compiler/bundler.
   Keep current package exports, engine purity and SDK seam.
2. Invoke `pnpm pack` once. Prepack owns the sole final CLI build, clean output,
   minification, splitting, migration copy, map chaining and closure checks.
   Candidate-mode prepack explicitly enables tsup sourcemap/splitting with external
   maps and sourcesContent=false; force-running a map-free config is insufficient.
   Release builds dependencies beforehand, not CLI then CLI again in prepack.
3. One finalizer inside prepack inventories consumed upstream JS/maps and every
   emitted JS/map. Refuse missing/malformed upstream maps: bundler success may
   otherwise silently map engine frames to compiled JS. Validate and rewrite map
   source paths to repository-relative original TS identities; reject unsupported
   sourceRoot/absolute/URL/escaping paths and preserve mappings/names. Assert absent
   sourcesContent. Remove only expected final tsup map-link trailers without moving
   executable code lines. Stage maps/metafile owner-only outside npm, verify closure
   and public file/mode inventory, then hash. No transform/banner/minifier/JS write
   is permitted afterward.
4. Inspect the produced tarball. Compare each packed JS byte digest and migration
   inventory with finalized files; reject prohibited entries independently of the
   package files-list. Only now seal its private map manifest.
5. Symbolication loads the matching source revision separately and maps actual
   packed CLI and engine frames to expected TypeScript lines/columns. Verify wrong
   JS/map/source and missing upstream map refusal. A decrypt round trip alone
   does not certify mappings.

Upstream/final maps, private manifests, metafiles and staging may leave the
candidate job only inside ciphertext; exclude them from every artifact, cache,
diagnostic and failure upload. Package/dependency-download caching may include
only already-public dependencies, never this build output. A synthetic planted
map/cache marker must fail the public-output inventory; changing the exclusion
or enabling a candidate build-cache write must break that causal control.
[GitHub cache access](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
is not a private archive boundary.

The **private map manifest** is versioned JSON inside the encrypted archive:
source commit/tree, package version, Node/pnpm/TypeScript/tsup/esbuild versions,
target, lock/config hashes, each final JS/map path+SHA-256 pair, and tarball SHA-256.
No host absolute paths, credentials or embedded source are stored.

The **public binding receipt** is versioned JSON beside ciphertext: source SHA,
package version, tarball/ciphertext SHA-256, recipient primary and encryption-subkey
fingerprints, toolchain/config/lock identity, and originating trusted workflow/run/
attempt identity. It contains neither maps nor private per-source inventory.
Use SHA-256 for file identity, not a homemade signature/provenance protocol.
Check originating identity against the trusted CI service/run and real tag/source;
a self-declared JSON field alone does not authenticate its producer.

A **release candidate** comprises exact tarball, original ciphertext and release binding receipt.
Package version plus source SHA identifies the intended candidate; a different
candidate for that version refuses instead of silently superseding it.
The finalized JS/map receipt is sealed locally before encryption; the binding
receipt is sealed after ciphertext exists. These are distinct, named artifacts.

## Recipient custody

The maintainer selected encrypted CI archival. GnuPG is release tooling, never a
runtime dependency. Use an isolated public-only home/keyring/config, no ambient
keyring, automatic discovery or unexpected recipients. Pin maintainer-confirmed
primary and encryption-capable subkey fingerprints. Refuse missing, expired,
revoked or unusable recipients using machine-readable status; check subprocess
exit, bounded output and exact produced asset. Private keys never enter repo/CI.

Encrypt the archive once; OpenPGP session-key randomness is expected
([RFC 9580](https://www.rfc-editor.org/rfc/rfc9580.html#section-2.1)).
Retain original ciphertext before retryable upload. Temporary plaintext is cleaned
on all paths without claiming secure erasure. Diagnostics are fixed and never
print content/key data. Synthetic controls use synthetic maps only; a public
fixture private key may never decrypt a product archive.

Production setup requires confirmed recipient, offline recovery/decryption check
and backup ownership before an actual release. Rotation is a reviewed public-key
update for future candidates; preserve historical fingerprint/decryption capability
for supported versions. Existing public ciphertext cannot be recalled by revocation.
This wave creates no automatic deletion policy or production key.

## Package-test and release modes

**Package-test mode** is required on PR/push and manual dry-run. In its isolated
uncached originating pack job, build once, inspect exact tarball, verify maps and
CLI/engine symbolication locally, then discard all private maps/manifests/metafiles.
Share only the tarball and a nonsecret package-test receipt (version, mode
package_test, source SHA, package version, tarball digest and originating workflow
identity) with platform consumers. It needs no production recipient. GPG fixture
controls remain separate and use synthetic map payloads only.

A package-test artifact is never promoted to a release candidate after private
maps are discarded. A trusted-tag release makes its own fresh candidate once,
then obeys no-rebuild/no-re-encryption retry rules. This is a distinct release
build identity, not a replacement for an existing same-version release candidate.

**Release mode** runs only for the real trusted pushed tag. A permissioned discovery
job first retrieves original candidates and reserves a fresh identity as described
below. Only a verified `fresh` route enters build/pack/encryption with the confirmed
production recipient in the isolated originating job **before any handoff**.
`reuse` downloads exact prior bytes and invokes no build, pack, finalizer or GPG.
Required custody failure never downgrades to package-test mode or fixture keys.
Both modes run the same tarball smoke and local map checks. Self-declared mode or
receipt strings do not confer release authority.

## Archive, retry and publication

Top-level workflow permissions are `{}`; each job lists its minimum capabilities.
Release jobs require real pushed `v*` tag, package-version equality and main ancestry.
PR/fork/manual workflow_dispatch, even against a tag or off-main override, cannot
mutate Releases or publish. Use separate dry-run concurrency; release-candidate
writers serialize by version, never run/attempt ID, and recheck remote identity
immediately before mutation. Repository defaults or immutable Release settings are
not relied on; the workflow enforces no overwrite even when immutability is off.

| Job in strict dependency order | Permission / responsibility |
|---|---|
| Admission | Contents read; validate actual event/tag/source/version/main ancestry |
| Discovery/reservation | Contents write for draft visibility/reservation, Actions read for cross-run artifact retrieval; no install/build/npm credentials |
| Pack or reuse | Contents read; fresh alone builds/packs/encrypts once; reuse consumes discovery's verified staged original bytes |
| Exact-tarball smoke | Contents read; every required OS/minimum-runtime leg uses the chosen digest |
| Archive | Contents write after smoke; verify candidate, upload absent matching assets only, download/verify all three |
| npm publish | Contents read plus existing id-token provenance permission; needs smoke **and archive**, consumes verified tarball/public archive receipt; never edits Releases |
| Release finalization | Contents write after successful or verified already-complete npm publication; recheck assets/npm identity, then publish matching draft |

Discovery paginates drafts/published Releases and originating trusted release
workflow runs/attempts/artifacts. Draft lookup must use its authorized API/listing;
a read-only tag lookup's 404 is not proof of absence. Verify source/run/attempt
against GitHub metadata and the trusted tag-only workflow source. Artifact names
and receipt fields alone are insufficient. API permission/transient/pagination or
history uncertainty returns failure/recovery_required, never fresh. Cross-run
retrieval occurs in this Actions-read job; pass only verified public candidate
assets onward. Retain original origin identity on retry.

The [Releases API](https://docs.github.com/en/rest/releases/releases#list-releases)
limits draft listings to push-capable callers;
[cross-run artifact API access](https://docs.github.com/en/rest/actions/artifacts)
requires Actions read. These API capabilities are explicit job requirements,
not authority inferred from public repository visibility.

Before first build, discovery creates a draft reservation for version/source and
originating candidate attempt. No prior Release/reservation or candidate-producing
attempt may exist for the fresh route. This small public durable record makes an
interrupted build or expired staging distinguishable from a fresh version. An
incomplete reservation with no recoverable complete candidate requires explicit
manual recovery; the same job rerun does not silently build again. Collision,
inaccessible/ambiguous/deleted history or an unrelated existing Release refuses.
No production reservation/mutation occurs in Wave 3's offline controls.

After smoke, archive stores exact tarball, original ciphertext and release binding
receipt as per-version Release assets, downloading to verify all digests. It passes
tarball plus public archive receipt (version/source/three digests/Release identity)
to publish, so the read-only publish job need not retrieve a hidden draft. Publish
rechecks that binding and npm version integrity: equal existing bytes mean
publication complete, different bytes refuse. Finalization owns the later draft
transition; it cannot run on publication failure. Failed npm leaves the draft
candidate recoverable; failed finalization retries without publication/build/GPG.

| Durable state | Permitted action |
|---|---|
| Proven absent history/candidate, new reservation recorded | One fresh build/pack/encryption for its original attempt |
| Complete trusted original staging | Retrieve/verify and reuse; rerun smoke, no rebuild or encryption |
| Complete matching draft/published assets | Retrieve/verify; no build/encryption/overwrite |
| Partial assets plus trusted complete original staging | Verify present assets; add only absent matching bytes |
| npm already contains equal candidate | Verified publication completion; finalize matching Release if needed |
| npm publication failed or finalizer failed | Resume the applicable downstream jobs using the same complete candidate |
| Incomplete reservation, missing asset/ciphertext, expired/inaccessible staging, conflicting bytes or ambiguous origin | Fail with manual recovery; never manufacture a replacement candidate |

Support failed-jobs, all-jobs and cross-run retries through that same discovery
route **before any build step**. A missing source artifact cannot be compensated by
re-encryption. Retain tarball/ciphertext/receipt for every supported release beyond
Actions expiry, including npm failures. No automatic asset deletion/replacement.
Public Release is not private storage; only ciphertext restricts debugging payload.

Test the same state controller behind injected GitHub/npm API ports with synthetic
identities and a permission-enforcing fake service. Cover read-only hidden draft,
Actions-read denial, pagination, 403 versus 404, reservation/interruption, all durable
states, every rerun mode and npm timeout-after-success. Assert build/pack/GPG/npm
call counts and unchanged conflicting bytes. Static workflow controls verify
predicates, permission minima, concurrency, dependency graph and required CI
aggregation. A dispatch dry-run cannot substitute for these release-mode controls.
No live tag/upload/publication or production key is required for Wave 3; real
production token/custody configuration remains separately attributed Wave 4b work.

Required PR/push gates pack once and all supported OS consumers install that same
digest. Add the packed aggregate to required ci.needs **and** its success checks
under always(); missing/skipped/cancelled pack or platform legs fail the gate.
Include a packed runtime consumer at **Node 22.0.0**, separate from the
workspace install floor at 22.13, plus current .nvmrc on macOS/Linux/Windows.
If the pinned runtime closure fails the public floor, resolve the compatibility
decision explicitly before acceptance. Reuse the same smoke in release CI.
Controls cover actual run/chat/migrations/native load/MCP version/CAS/iterator
identity and early import failure without real keychain/provider calls. A real
installed chat control drives prompt → AgentSession turn → assistant output →
SQLite persistence → clean end/resume using an external test transport hook and
throw witnesses for network/keychain. Assert actual dispatch count and persisted/
output markers. Do not invent a shipped chat --fixture flag, replace the inlined
implementation under test or call an empty EOF run chat acceptance. Hook feasibility
and cross-platform execution must be proven during implementation.

Wave 3 implements this path with offline/API-fake controls and a dedicated
crypto/CI-custody security sitting. Actual production configuration/publication
belongs to Wave 4b and fails closed if custody is missing. Required final whole-wave
checks repeat exact-artifact evidence after later CLI/DB changes.

At Step 9 landing update the release runbook's currently accurate single-bundle
procedure to this graph, modes/recovery and symbolication; do not relabel historical
single-bundle evidence as testing this design. Before whole-wave acceptance merge
this Proposed contract into implemented reference status and remove stale proposal
banners only for actually accepted mechanisms.
