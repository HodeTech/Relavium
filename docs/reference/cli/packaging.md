# CLI Packaging Contract

- **Status**: Compiled graph, installed package and Step 8 native activation independently accepted on `development`; the Step 9a.1 candidate build and finalizer are implemented, with independent acceptance pending; the remaining Step 9 map/custody and release gates remain staged
- **Date**: 2026-10-15
- **Related**: [ADR-0111](../../decisions/0111-cli-meta-operations-use-a-lazy-packaged-runtime.md), [commands.md](commands.md), [release runbook](../../runbooks/release-a-surface.md)

This is the maintainer-approved canonical design contract (2026-10-16). Wave 3
Step 7a's lazy compiled graph is independently accepted on `development` after two
new complete cumulative clean reviews and a separate security sitting. The
published release retains its historical single bundle.
Step 7b and whole Step 7 are independently accepted at `c836ffe6`, including the
same-tarball current Linux/macOS/Windows and exact Node 22.0.0 Linux consumers.
The [acceptance register](../../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-7b-and-whole-step-7-acceptance--2026-10-16)
attributes reviews, artifacts and remaining broader CI separately. Step 8 owns
native fatal integration, and Step 9 owns maps and archival custody.
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
form an explicit public allowlist. Public package validation independently pins
`bin.relavium` to `./dist/index.js` and `engines.node` to the [ADR-0067](../../decisions/0067-node-supported-floor-22-reaffirm-better-sqlite3.md)
public floor `>=22`; copying the source manifest into a receipt is insufficient. Archive
validation checks those fields against the same fixed contract. Only the entry has its source hashbang and executable mode 0755; runtime chunks
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

### Compiled graph implementation boundary — Step 7a

The bootstrap creates one invocation object before guarded imports. That object
contains the registry and one total, latched offline file-cache attempt. Actions
receive it through their context, and interactive Home receives the same object.
The native registered-owner adapters are not yet integrated; this is context and
module identity, not proof of physical owner shutdown.

Current human help/version/bare/subtree paths use the same Commander grammar as
execution. They do not load runtime services or admit filesystem directories.
Actual actions admit grants before optional catalog seeding and command runtime
loading. A finite executor map is checked against the descriptor registry;
import paths are literal, independent of model, command argument or user content.
Media maintenance has its own route. Offline agent fixtures skip cache seeding;
history, provider management and authoring paths do not seed an unused catalog.
The existing eleven DB-overlay consumers remain responsible for installing current
DB metadata; no rebuild can repeat the invocation's file-cache attempt over it.

Pure supported leaves retain their existing constructor/function identities:
shared terminal stripping and the error base, LLM secret scrubbing, and core's
tool-dispatch error base. Runtime classification remains separate from diagnostic
rendering. Step 8d implements the native coordinator before the first guarded
runtime import. Dependency/evaluation failures now reach one fixed human/JSON
diagnostic and exit 9 without loading the heavy classifier. Actual runtime
boundaries project known parser/storage/operational errors before returning to
the pure entry, preserving their existing exit meanings. The complete
177-control compiled bootstrap inventory pins both deferred entry and dispatcher
failures in both representations; installed-package binding requires the same
inventory. Step 8d adds an eighth required installed case for actual global
fatal/background/output hooks and native close-delivery ordering through the
untouched entry. Interactive restoration and deadline nonrenewal retain separate
source controls. The exact owned Node 22.0.0 experimental JSON-module warning is
retained separately from product diagnostics; unknown runtime output still fails
the diagnostic grammar and ordering controls. [Step 8d and whole Step 8 acceptance](../../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-8d-and-whole-step-8-acceptance--2026-10-17)
records cumulative reviews, separate security and actual same-artifact platforms.

The PR #95 review correction adds two installed regressions: `provider list` succeeds
without credential/network access and unknown `logs nope` refuses with exit 2 and empty
stdout. The current required inventory is ten cases; the earlier eight-case receipts keep
their historical source attribution. A changed inventory requires fresh same-artifact
consumer receipts before current-source platform acceptance is claimed.

These receipts certify one chosen archive and its exact bytes. Independent `pnpm pack`
runs can reorder package metadata and produce a different digest; the contract does not
claim independently reproducible tarballs. Retry and publication reuse the recorded candidate
rather than treating a fresh build as that same artifact.

The emitted graph checker parses actual JavaScript and compares every loading edge
with the build inventory. It rejects missing/extra/unreachable/escaping chunks,
computed or unreviewed loaders, private external imports, undeclared dependencies
and independently duplicated input contributions. Flat chunks preserve migration
resolution. Entry-only hashbangs and actual POSIX modes are checked; Windows graph
checks explicitly do not claim unobservable POSIX mode bits. Step 7b independently
checks actual tar headers on every consumer platform.

`pnpm smoke:cli-bootstrap` runs the untouched compiled entry with native import,
application-file, network and subprocess throw witnesses in a synthetic HOME.
It covers current human meta output, pure grammar, absent absolute root refinement,
real execution admission ordering and deferred import failure. Its own negative
controls pin the witnesses, child deadline and UTF-8 output bound. The source and
compiled controls do not certify installed dependencies, complete chat turns,
minimum Node, other platforms, original-TS symbolication or release custody.

## Build, map and candidate identity

### Installed-package implementation boundary — Step 7b

The tooling producer now emits dependencies without a build cache, invokes the
sole prepack CLI build, and independently compares actual gzip/USTAR entries with
the finalized JS and canonical migrations. Its exact public allowlist and native
tar-header checks apply on every consumer platform. The consumer installs those
verified bytes outside the workspace with pinned pnpm and the existing lifecycle
allowlist, verifies installed public files, and records actual dependency versions.
It invokes the installed `node_modules/.bin/relavium` command for `--help` and
`--version` (the platform command wrapper on Windows), checking successful output.
These checks exercise the package's declared executable installation. The deeper
untouched-entry smoke remains a distinct behavioral control. A consumer success
receipt requires `installedCommand.help` and `installedCommand.version` both true.
Dependency installation uses the public registry; provider transport and keychain
API controls use synthetic data and refusals.

The second PR #95 review adds these executable/engine pins and installed-command
controls. Prior receipts, including `a5a5d45e`-era evidence, retain their historical
source and schema attribution; they do not prove the new controls. Corrected-source
same-archive platform execution and independent acceptance remain pending in the
[second correction register](../../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#pr-95-second-systematic-review-corrections--2026-10-18).

Installed native smoke and SQLite reads run in an owned bounded child. The
installation cleanup owner joins actual child closure before removing the tree;
a connection close alone does not unload a Windows native module. Required
removal precedes success receipt/summary publication. Worker or cleanup failure
prevents publication, and secondary cleanup/diagnostic failure preserves the
primary outcome. Private worker identity stays outside public receipts.

Required workflows share one public tarball and a `compiled_package_test` receipt
with current `.nvmrc` Linux/macOS/Windows and exact Node 22.0.0 Linux. Each repeats
untouched-entry bootstrap controls and actual workflow, gate, budget, chat/resume,
SQLite, native-load, MCP-version and media-cleanup behavior. Their aggregate checks
all four actual success records and immutable artifact/source/origin identities.
Only public consumer summaries are uploaded; detailed support logs are excluded.
The [tooling guide](../../../tools/cli-package/README.md) describes invocation and
bounded retry evidence. These runners are implemented; required platform execution
and independent acceptance are recorded separately in the Wave 3 register.

This intermediate receipt does not claim the full map-bearing package-test mode
below. Original-TypeScript symbolication, private staging and release custody
remain Step 9. Native fatal-owner integration is covered by [Step 8 acceptance](../../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-8d-and-whole-step-8-acceptance--2026-10-17).
No intermediate local result closes Step 9 or certifies a release.

### Candidate finalization — Step 9

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
fingerprints, toolchain/config/lock identity, nonsecret originating map-check
completion status, and originating trusted workflow/run/attempt identity. It
contains neither maps nor private per-source inventory.
Use SHA-256 for file identity, not a homemade signature/provenance protocol.
Check originating identity against the trusted CI service/run and real tag/source;
a self-declared JSON field alone does not authenticate its producer.

A **release candidate** comprises exact tarball, original ciphertext and release binding receipt.
Package version plus source SHA identifies the intended candidate; a different
candidate for that version refuses instead of silently superseding it.
The finalized JS/map receipt is sealed locally before encryption; the binding
receipt is sealed after ciphertext exists. These are distinct, named artifacts.

### Candidate build and finalizer implementation boundary — Step 9a.1

Step 9a.1 implements items 1–3 above and the producer half of item 4. This section
describes the implemented mechanism; independent acceptance is recorded in the
[Wave 3 register](../../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#proposed-implementation-increments).

- **Owned candidate tree.** `pnpm package:cli:pack` never builds in the developer's
  workspace. It records the original checkout's commit, full porcelain status and the
  tracked files Git is told not to check (skip-worktree or assume-unchanged, which make
  the identity `dirty` whatever their bytes), copies every file Git would ship (tracked
  plus untracked-but-not-ignored, minus deletions, by the repository's ignore rules and
  the developer's global excludes file, passed explicitly; that Git reads no home, global
  or system configuration and ignores replace refs) into a fresh owner-only tree, and refuses if any of the three
  changed during the copy. A link, as a listed file or as any parent directory of one
  below the checkout, refuses the copy, so a tracked directory replaced by an ignored link
  cannot bring in bytes from outside the checkout; so does an untracked nested repository,
  which Git lists only as its directory. Every build and install pnpm call runs in the
  private home's isolated environment (only the store discovery below also sees the
  caller's store-location variables), and a corepack-managed pnpm runs from the developer's
  own corepack cache (`COREPACK_HOME`, as corepack computes it), never from the temporary
  directory, where another local user could plant a module on its lookup path.
  Ignored output, caches, dependencies and private notes never enter it. The locked
  closure is installed there offline, frozen and with `--ignore-scripts` from the
  existing content-addressed store, discovered with pnpm's store-location variables
  only, and every `@relavium/*` link of the CLI and the five inlined engine packages must
  resolve inside the tree.
- **Fresh upstream maps.** The five engine packages compile in order with the installed
  compiler's `--sourceMap true --inlineSources false --incremental false` overrides after
  their `dist` and incremental files are removed. No Turbo or other build cache is
  invoked, and a Turbo directory, `*.tsbuildinfo` or `node_modules/.cache` left in the
  tree refuses before the seal. Ordinary builds keep their explicit `sourceMap: false`.
- **Sole prepack build.** `prepack` is the tooling orchestrator
  `tools/cli-package/prepack.mjs`, which runs the installed tsup once. Without a staging
  directory it then runs the ordinary closure guard, as before. The CLI configuration
  emits external maps with `sourcesContent` disabled whenever
  `RELAVIUM_CLI_CANDIDATE_STAGING` is defined; prepack first refuses unless it names an
  absolute, canonical, empty directory outside the candidate (both compared by the real
  paths and letter case the filesystem stores), owner-only where POSIX modes are
  observable, and then runs the finalizer in place of the ordinary guard. That guard
  refuses any map a build outside prepack leaves in `dist`.
- **Finalizer.** Before any write it accounts for every emitted file (each runtime JS
  output paired with exactly one map, plus the metafile, nothing else). It validates every
  consumed upstream tsc map: exact terminal map link, version 3, matching `file`, empty
  `sourceRoot`, no embedded sources, and only that package's existing original
  TypeScript; its mappings may be empty only when the module's types all erase, which tsc
  emits as exactly `export {};`. It validates every final map:
  version 3, no embedded sources or unreviewed fields, and sources resolving to existing
  `apps/cli/src` or engine `src` TypeScript that equal exactly the original sources of
  the inputs contributing bytes to that output, so a bundler fallback to compiled JS
  refuses. A code-splitting facade with no contributing input must have an empty map.
  It removes only tsup's exact terminal `//# sourceMappingURL=<name>.map` trailer and
  requires the remaining bytes to equal the size esbuild recorded. Then it stages the
  rewritten maps (repository-relative sources; mappings and names unchanged) and the
  metafile owner-only outside the package, re-runs the finite closure and the
  migration-copy check on the finalized files, and only then hashes into a private record.
- **Seal.** The seal takes the candidate root, the staging directory and the original
  checkout's identity explicitly and never resolves a repository from its own location.
  Public JS must be exactly the staged metafile's runtime outputs, byte-identical to the
  finalizer's record; the actual tarball is inspected as in Step 7b. The receipt remains
  `compiled_package_test`.
- **Ordinary map-free control.** The ordinary closure guard refuses any map, map link or
  unreviewed file in `dist`, and the five build configurations and the CLI configuration
  are pinned map-free outside a named candidate.

Private maps, the metafile, the hash record and the candidate tree are removed when the
producer succeeds, fails or is interrupted (SIGINT, SIGTERM, SIGHUP); an interrupt also stops
the build's child processes and empties the artifact directory, which was empty at the start,
before the producer exits with the signal's code — also when it arrives after the build's last
child exited, during the seal or the final removal. A failed production prints only prepack's own
fixed `✗ CLI …` lines and one fixed code, never a build child's captured output, which can quote a
malformed map. A step of an interrupt's cleanup that fails leaves one fixed line, never a path,
and the producer still exits with the signal's code. An interrupted consumer likewise stops its
child processes, including the bootstrap witness's, and removes its installation, the witness's
fixtures and the installed smoke's working directory; the native fixture targets the installed CLI
starts in their own process groups end on their own once the smoke worker that owns their case is
gone. The local `pnpm smoke:cli-package` forwards an interrupt to the producer or consumer it started
rather than ending first, starts no later stage once one arrived, and exits with the signal's
code after removing its root; a stage past its deadline is interrupted (SIGTERM) first and killed
only after a grace period, so it stops its own build children before the root goes. A producer killed outright, a crash or a lost host can leave the
owner-only root in the temporary directory, and no secure erasure is claimed. "Owner-only" in this
section means mode 0700 for directories and 0600 for staged files, set — and for the staging
directory verified together with this process's uid — where POSIX modes are observable. On Windows
no mode evidence is claimed: the candidate root and staging inherit the temporary directory's ACL,
which is not verified, as the graph checks above claim no unobservable POSIX mode bits. The
private map manifest, actual packed CLI and engine symbolication, `check:map-controls` and the `package_test` receipt flip are Step 9a.2;
recipient custody, the release state controller and the workflow graph are Steps 9b–9d.
Until those and Wave 4b's production recipient exist, the release workflow's publish job
refuses every artifact (the [Interim release guard ruling](../../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-steps-919-preflight-review-and-maintainer-rulings--2026-10-19) of 2026-10-19).

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
Fresh originating builds in both modes run local map/symbolication checks before
sealing their receipt. Release reuse has no plaintext maps or decryption key: it
validates the original trusted successful pack identity, map-check completion
evidence and exact candidate digests, and reruns tarball smoke. It does not claim
fresh symbolication. Missing original map-check evidence refuses; self-declared
receipt fields alone do not prove it.

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

Every fresh build requires successful permissioned discovery/reservation in the
**same current run attempt**. A native failed-jobs rerun skips successful upstream
jobs: therefore pack must compare the discovery attempt with its current attempt
before any fresh build. Stale fresh output refuses without building, packing or
encrypting, with rerun-all/manual-recovery instructions. Do not assume GitHub
automatically reruns discovery or give pack Release-write authority.

| Retry mode | Supported route |
|---|---|
| Failed jobs downstream of a successful pack | Revalidate original complete candidate/binding and resume smoke/archive/publish/finalize; no fresh build or local map-check claim |
| Failed pack with a prior reuse route | Retrieve/verify the same original candidate; no build/GPG; missing staging refuses |
| Failed pack with stale fresh output | Refuse before build; rerun-all reaches discovery, and incomplete reservation still requires manual recovery |
| All jobs or new trusted release run | Re-execute permissioned discovery before pack; reuse complete original bytes or refuse lost/incomplete reservation |

Same-run transfer may use Actions' existing artifact runtime capability; cross-run
retrieval remains in the Actions-read discovery owner. Archive/finalize recheck
remote state with their own custody permissions on every retry. No downstream job
can interpret stale fresh output as authority to rebuild. A missing source artifact
cannot be compensated by re-encryption. Retain tarball/ciphertext/receipt for every
supported release beyond
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
this approved design contract into implemented reference status and remove stale proposal
banners only for actually accepted mechanisms.
