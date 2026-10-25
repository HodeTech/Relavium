# CLI Packaging Contract

- **Status**: Compiled graph, installed package and Step 8 native activation independently accepted on `development`; the Step 9a.1 candidate build and finalizer are independently accepted on `development` (2026-10-24); Step 9a.2a's strict decoder, private manifest and symbolication are independently accepted on `development` (2026-10-24); Step 9a.2b's product map controls, post-receipt rebuild refusals and `package_test` receipt are independently accepted on `development` (2026-10-24); Step 9b.1's private container, isolated GnuPG runner and encrypt-once library are independently accepted on `development` (2026-10-25; synthetic recipients only); the remaining Step 9 custody and release gates remain staged
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

Required workflows share one public tarball and a package-test receipt (mode `package_test`
since Step 9a.2b, `compiled_package_test` before it) with current `.nvmrc` Linux/macOS/Windows and exact Node 22.0.0 Linux. Each repeats
untouched-entry bootstrap controls and actual workflow, gate, budget, chat/resume,
SQLite, native-load, MCP-version and media-cleanup behavior. Their aggregate checks
all four actual success records and immutable artifact/source/origin identities.
Only public consumer summaries are uploaded; detailed support logs are excluded.
The [tooling guide](../../../tools/cli-package/README.md) describes invocation and
bounded retry evidence. These runners are implemented; required platform execution
and independent acceptance are recorded separately in the Wave 3 register.

Since Step 9a.2b the receipt records `package_test`: before writing it the producer verified its
maps and symbolicated actual packed frames (Steps 9a.1 and 9a.2a), and the `ci` workflow requires the
product map controls; an artifact is backed by them only where a successful `ci` run exists at exactly
its commit (below). Release custody remains Steps 9b–9d. Native fatal-owner integration is covered by
[Step 8 acceptance](../../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-8d-and-whole-step-8-acceptance--2026-10-17).
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
  the developer's global excludes file, as the developer's own Git finds it (also through
  command-scope `GIT_CONFIG_*` configuration) and passed explicitly; that Git reads no home,
  global or system configuration or attributes and ignores replace refs) into a fresh
  owner-only tree, and refuses if any of the three changed during the copy. A clean status is
  then confirmed byte for byte (Step 9a.2a): each copied file's Git blob id — the hash of its raw
  bytes, no filter — must equal the commit tree's entry, because line-ending conversion
  (`core.autocrlf`, the Git for Windows default) and Git's stat cache can report converted bytes as
  unchanged; a copy that differs makes the identity `dirty`, so the build is symbolicated against
  the bytes it was built from and a trusted origin refuses it. A link, as a listed file or as any parent directory of one
  below the checkout, refuses the copy, so a tracked directory replaced by an ignored link
  cannot bring in bytes from outside the checkout; so does an untracked nested repository,
  which Git lists only as its directory. Every build and install pnpm call runs in the
  private home's isolated environment (only the store discovery below also sees the
  caller's store-location variables), and a corepack-managed pnpm runs from the developer's
  own corepack cache (`COREPACK_HOME`, as corepack computes it), never from the temporary
  directory, where another local user could plant a module on its lookup path.
  Ignored output, caches, dependencies and private notes never enter it. The locked
  closure is installed there offline, frozen and with `--ignore-scripts` from the
  existing content-addressed store, which pnpm discovers in the repository with only
  `HOME`, `USERPROFILE`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `LOCALAPPDATA`, `APPDATA`,
  `PNPM_HOME`, `npm_config_store_dir` and `NPM_CONFIG_STORE_DIR` of the caller's environment. Every `@relavium/*`
  link of the CLI and the five inlined engine packages must resolve to that package inside
  the tree, no other `@relavium/*` link is admitted, and the root `node_modules` must
  resolve inside the tree too.
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
  A refusal names a fixed code and at most a fixed label or a repository-relative path that
  has passed validation: a metafile string that escapes the repository or is not a plain
  path is left out, and no map or source content is ever printed.
- **Seal.** The seal takes the candidate root, the staging directory and the original
  checkout's identity explicitly and never resolves a repository from its own location.
  Public JS must be exactly the staged metafile's runtime outputs, byte-identical to the
  finalizer's record; the actual tarball is inspected as in Step 7b. The receipt remained
  `compiled_package_test` until Step 9a.2b flipped it to `package_test`.
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
gone. On POSIX the local `pnpm smoke:cli-package` forwards an interrupt to the producer or
consumer it started rather than ending first (on Windows they share the console and receive
Ctrl-C themselves), starts no later stage once one arrived, and exits with the signal's code after
removing its root. On POSIX a stage past its deadline is interrupted (SIGTERM) first, and its whole
process group is killed when a grace period ends or as soon as the stage exits, whichever comes first,
so it stops its own build children before the root goes; on Windows its whole tree is killed at the deadline, and its private directories go
with the check's root. These Windows interrupt and deadline paths are not exercised by any CI job:
the tooling tests run on Linux only. SIGHUP aborts and cleans up like the other two signals even
under `nohup`, which these listeners replace; detach a long local run with `setsid` or a terminal
multiplexer instead. A producer killed outright, a crash or a lost host can leave the
owner-only root in the temporary directory, and no secure erasure is claimed. The local consumer
installs the CLI under the temporary directory, so on a host whose temporary directory other
local users can write to (a shared `/tmp`), a module another user plants in its `node_modules`
could satisfy an optional `require` of the installed CLI; CI runners are single-tenant and macOS's
per-user temporary directory is not shared. This is a named limit of the local consumer, owned
by [deferred-tasks.md](../../roadmap/deferred-tasks.md#wave-3-step-9a1--recorded-low-findings-2026-10-24). "Owner-only" in this
section means mode 0700 for directories and 0600 for staged files, set — and for the staging
directory verified together with this process's uid — where POSIX modes are observable. On Windows
no mode evidence is claimed: the candidate root and staging inherit the temporary directory's ACL,
which is not verified, as the graph checks above claim no unobservable POSIX mode bits. The
private map manifest and actual packed CLI and engine symbolication are Step 9a.2a (below);
`check:map-controls` and the `package_test` receipt flip are Step 9a.2b;
recipient custody, the release state controller and the workflow graph are Steps 9b–9d.
Until those and Wave 4b's production recipient exist, the release workflow's publish job
refuses every artifact (the [Interim release guard ruling](../../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-steps-919-preflight-review-and-maintainer-rulings--2026-10-19) of 2026-10-19).

### Private manifest and symbolication implementation boundary — Step 9a.2a

Step 9a.2a (a [recorded split](../../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-9a2-preflight-decisions--2026-10-24)
of 9a.2, maintainer-approved on 2026-10-24) implements items 4 and 5 above for the package-test
producer. The receipt stayed `compiled_package_test` until 9a.2b's product map controls existed.
"Owner-only" in this section has the meaning the 9a.1 section gives it: mode 0700 or 0600 where
POSIX modes are observable; on Windows the private root inherits the temporary directory's ACL,
which is not verified. The producer needs Node 22.15 or later, whose `module.registerHooks` the
preload uses (CI's pack jobs run the `.nvmrc` major); on an older Node it refuses with
`PACKED_CLI_PRODUCER_NODE` before anything is built.

- **Strict maps.** The finalizer decodes every consumed upstream map's and every final map's
  `mappings` strictly — base64 VLQ only, no truncated or oversized value, segments of one, four or
  five fields, increasing generated columns, in-range source and name indices, no negative position —
  and requires every generated position inside the text the map was generated for and every
  original position inside its source text (a position at a line's end is a caret position). A
  violation refuses with its own code (`UPSTREAM_MAP_MAPPINGS`, `UPSTREAM_MAP_RANGE`,
  `MAP_MAPPINGS`, `MAP_RANGE`) before anything is written; a well-formed charset alone no longer
  decides, and the bundler's silent fallback for a malformed upstream map is not relied on. Node's
  built-in source map decoder is lenient, so it serves only as an independent test oracle.
- **Private manifest.** After the archive inspection the seal writes `manifest.json` into private
  staging (owner-only, never overwritten): version 1; the source commit, the commit's Git tree and
  the `dirty` flag; the package version; the build target; Node, pnpm, TypeScript, tsup and esbuild
  versions from the installed tools; SHA-256 digests of the lockfile, every package manifest and
  every build configuration with the configurations it extends; every final JS file keyed as
  `dist/<chunk>.js` with its SHA-256, its map's package-relative path (`dist/<chunk>.js.map`) and
  the staged map's SHA-256; a SHA-256 for every original source a final map names
  (repository-relative, no content); and the tarball's SHA-256. The staged maps must still be the
  bytes the finalizer recorded and each JS digest must be the tarball entry's. It holds no host path,
  credential or source text and is removed with the staging.
- **Actual frames.** The seal then runs the finalized `dist` — which the inspection has proven
  byte-equal to the tarball entry by entry — under a tooling-only `node --import` preload while it
  imports a canary workflow (`relavium import`, with its home, project and captured frames in an
  owner-only directory of the private root). The project's own `.relavium/` exists before the run,
  so the CLI's upward search for a project stops there and never adopts an ancestor's — a
  developer's real project on Windows, where the temporary directory lies below the home — and the
  run must have imported the canary into it (`CAPTURE_PROJECT`). The preload wraps the external
  `yaml` package's `parse`, records V8's structured call sites for the canary document alone,
  restores the stack formatter and limit, replaces the keyring package with a module that refuses
  every use, and makes any native addon load refuse, so the run loads no native module and reads no
  secret. Through a synchronous resolution hook that sees `require` as well as `import`, it also
  refuses any module that resolves outside the candidate, so an optional dependency the candidate
  does not install (ws's `bufferutil`, for example) can never be satisfied by a `node_modules` that
  another local user creates above it in a shared temporary directory. These refusals are installed
  in the capture process itself: a thread or subprocess the candidate starts without the preload (an
  eval Worker or a `node -e` child, for example) is not covered, and `relavium import` starts none,
  though nothing enforces that. Exactly one captured stack is required.
- **Symbolication.** Each frame inside the finalized `dist` must be a file the manifest and the
  tarball record (re-hashed after the run), its map must be the staged bytes the manifest records,
  and only a frame that lands exactly on a mapping segment counts. Five named call sites must be
  reached — three in the CLI and two in the inlined `@relavium/core`, each the one call to a named
  function inside another, and the table itself refuses fewer than two distinct core or three
  distinct CLI call sites — at the line and UTF-16 column that the matching source revision's
  syntax tree gives: for a
  clean candidate the checkout's Git objects at the recorded commit, read as the raw blob (no filter
  or text conversion) by Git without home, global or system configuration and without replace refs
  (the checkout's own configuration is still read), and for a dirty local one the candidate copy,
  both bound to the manifest's per-source digests. Wrong JS, a wrong map, permuted map sources and a
  wrong source revision therefore cannot reach the anchors. A refusal prints one fixed code
  (`PACKED_CLI_MANIFEST_*`, `PACKED_CLI_SYMBOLICATION_*`) and never a frame, path or source text, and
  no receipt is written.

The capture child is not sandboxed: it runs the candidate CLI's runtime import closure as the
producer's user, with network access, beside the private staging, confined only by its isolated
environment, its owner-only work directory and, within the capture process only, the refusal of any
module outside the candidate and the refused keyring and native modules. `relavium
import` makes no network request, but nothing enforces that. This is a named limit of the
package-test producer, owned by
[deferred-tasks.md](../../roadmap/deferred-tasks.md#wave-3-step-9a2a--recorded-low-findings-2026-10-24).

### Product map controls and the package-test receipt — Step 9a.2b

Step 9a.2b (the [preflight decisions](../../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-9a2b-preflight-decisions--2026-10-24),
maintainer-approved on 2026-10-24) closes ADR-0111's post-receipt rebuild refusal for the
package-test producer, adds the product map controls and only then flips the receipt.

- **Rebuild refusals.** A second prepack into a sealed staging refuses before any build
  (`STAGING_NOT_EMPTY`). `sealPackage` refuses with `PACKED_CLI_ALREADY_SEALED` at its entry, before
  the inspection and any capture, when a receipt already lies beside the tarball or the staging already
  holds a manifest (checked without following a link); any other extra file in the artifact directory
  keeps the public artifact check's own refusal (`PACKED_CLI_UNEXPECTED_PUBLIC_ARTIFACT`), and a receipt
  another seal wrote meanwhile refuses with the same code. The refusal is keyed on the artifact
  directory and the staging, not on the candidate's identity. Immediately before the receipt is
  written, `verifySealedDist` compares the whole `dist` inventory, every output's digest and the
  tarball's digest with the manifest just sealed (`PACKED_CLI_MANIFEST_DIST_DRIFT`,
  `PACKED_CLI_MANIFEST_TARBALL_CHANGED`), so a `dist` rebuilt or changed after the inspection refuses,
  also in a chunk whose map names no anchor source. Release-mode retry and no-rebuild rules stay with
  Steps 9c and 9d.
- **Product map controls.** `pnpm check:map-controls` (`tools/cli-package/map-controls.mjs`, an
  unconditional entry point over `map-controls-core.mjs`) runs one real package-test production at the
  checked-out commit through the producer's own ports. A half-configured CI environment refuses before
  anything is built (`PACKED_CLI_MAP_CONTROL_ORIGIN`). Inside the seal, after the baseline receipt and
  while the private staging still exists, each control corrupts one product copy — the owned candidate
  tree, or a copy of its private staging re-recorded so that only the layer under test can refuse —
  requires that control's exact refusal and restores every file it corrupted by digest (`dist` itself
  is replaced by the next build):
  - a second prepack into the sealed staging; a re-seal of the artifact directory against a copy of
    the staging without its manifest, and of the sealed staging beside a tarball copied without its
    receipt, each isolating one half of `PACKED_CLI_ALREADY_SEALED` with no capture run;
  - on every anchor-bearing chunk, wrong JS by line and by column, a map from a build one line apart
    and rotated map sources (`PACKED_CLI_SYMBOLICATION_ANCHOR_UNMAPPED`), each checked to have changed
    exactly its own chunk in the way it names, after a re-recorded unchanged copy is accepted;
  - a wrong source revision, clean (`PACKED_CLI_SYMBOLICATION_SOURCE_REVISION`) and dirty
    (`ANCHOR_UNMAPPED`);
  - a changed chunk whose map names no anchor source, and a real rebuild from a changed source, against
    the sealed manifest (`PACKED_CLI_MANIFEST_DIST_DRIFT`), after the sealed `dist` verifies; and the
    seal's own check, which refuses a chunk the run changes after the inspection, writing no receipt;
  - an upstream map that is missing, malformed (an extra `sourcesContent`, an out-of-range source
    index) or cut inside a VLQ value, each refused by the finalizer with its own fixed line after the
    bundler silently succeeded (one build, nothing finalized, staged or packed); a byte-truncated
    upstream map, which fails the bundler's own build; and a shifted but strictly valid upstream map,
    which the finalizer accepts and symbolication refuses.

  A restoration production must then seal again; its tarball digest is not compared with the
  baseline's (see deferred-tasks.md, "Two packs of one source"). Staging copies stay under the private
  staging, which the producer removes first on success, failure and interrupt; a refused control
  build's `dist`, which holds the bundler's maps, is removed at once. The developer's checkout is read,
  never written (Git may refresh its own index's stat cache), and its identity must be unchanged
  afterwards. The runner prints one JSON summary of control ids, expected and observed codes and
  prepack's fixed lines with their repository-relative subjects — never an absolute path, frame,
  position, map byte or raw child output — and exits 1 unless every expected control (seventeen, plus
  four for each anchor-bearing chunk) ran exactly once with its expected outcome. It runs in
  `pnpm run ci` right after `smoke:cli-package`, and as the required `map-controls` CI job: ubuntu, at
  most 20 minutes, read-only permissions, no remote cache credentials, no pnpm cache, no build step, no
  custom shell and no upload, inside `ci`'s needs with a guard that refuses every result except success
  (the required contexts stay `ci` and `coverage`). That job's production is a second, independent
  build that is never shipped, not a retry of the packed candidate, so ADR-0111's no-rebuild rule for a
  candidate is not touched.
- **The `package_test` receipt.** The seal and the shared receipt validator (in its check and its
  normalized record) use one constant, the earlier `compiled_package_test` is refused, and the receipt
  keeps version 1 and its twelve fields; consumers and the aggregate verify identity through that
  validator. The mode is a claim, not evidence of the map checks. The `ci` workflow at a commit
  requires the controls, but a given artifact is backed only where a successful `ci` run exists at
  exactly its commit: `pack-cli` uploads its artifact whatever the same run's `map-controls` job
  concludes, a pull request's `ci` runs at its merge commit, not its head, and a release dispatch with
  `allow_off_main` or of an intermediate commit has no `ci` run at all; a local dirty production writes
  `package_test` too. Steps 9c and 9d must therefore never read the mode as proof. `release.yml` runs
  no map controls of its own and its pack job keeps its `pnpm` dependency cache (public registry
  packages only) until Step 9d rebuilds that graph, and the interim guard refuses every
  release-workflow artifact.

The runner keeps private maps and manifests longer than the producer does, always inside the
producer's owner-only root; a runner killed outright can leave that root behind, the producer's
existing named limit, and an interrupted runner can leave its own temporary directory, which may still
hold the baseline public tarball and its receipt (see deferred-tasks.md). The CI job runs on Linux only; a local run on Windows claims no POSIX mode-bit
evidence, as above.

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

### Recipient custody implementation boundary — Step 9b.1

Step 9b.1 implements the container and the one-time encryption as a library with synthetic
controls only. It holds no production recipient, encrypts no product staging, and changes
neither `producePackage`, `sealPackage`, the package-test receipt, the interim release guard
nor either workflow; encryption in the originating job is Step 9d's, reuse, the release
binding receipt and the production loader are Step 9b.2's. Its review and acceptance are
recorded in the [Wave 3 register](../../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#proposed-implementation-increments).

- **One strict dialect.** `ustar.mjs` owns the USTAR dialect the archive inspector reads:
  regular files only, every header field fixed except the modification time, whose syntax
  alone is checked, zero owner ids and device numbers, an exact end and zero padding. The
  inspector delegates to it unchanged.
- **The private container.** `container.mjs` builds one owner-only (0600) USTAR from the
  sealed staging in its own layout: `finalized.json`, `manifest.json`, `metafile-esm.json` and
  `maps/<chunk>.js.map`, sorted, with no host path. The staging must hold exactly those records
  and the manifest's maps as regular files of at most 16 MiB each, at most 259 entries and
  128 MiB in total (the total refused before the archive is assembled). Each record must also
  be within the bound its own reader applies (`RECORD_BYTES`: `finalized.json` 1 MiB,
  `manifest.json` and `metafile-esm.json` 4 MiB), so no record exceeds the size its own
  reader accepts. Every map's digest must
  be the manifest's, and the finalizer's record must name exactly the manifest's outputs and
  maps with each map's size. The manifest records no digest for the metafile, which must parse
  as a JSON object. The written container is read back before it is returned, so a path the
  dialect's 100-byte name field cannot hold refuses (`CONTAINER_TAR_NAME`). Reading a container
  back applies the same checks, and a decrypted container
  extracted with `tar -x` is a staging the manifest reader consumes unchanged.
- **The isolated runner.** `gnupg.mjs` resolves `gpg` from absolute PATH entries only and
  refuses one older than GnuPG 2.2.8; the installation — its binary, its `gpgconf` and its
  system-wide configuration directory — is trusted. Every call runs in the C locale and an
  isolated environment, bounded by `runCommand`; every `gpg` call also runs in a fresh
  owner-only home the tool creates, with `--no-options --no-autostart --no-keyring`. GnuPG
  still reads the installation's
  `<sysconfdir>/gpg.conf` under `--no-options`, and its `[force]` options override the command
  line, so before any key is handled the installation's `gpgconf --list-dirs sysconfdir` is
  read — the one call without a home — and a `gpg.conf` or `common.conf` there refuses
  (`GPG_CONFIG`): a global configuration
  could add or hide a recipient, redirect the output or log the session key. `gpgconf` prints a
  named directory raw, ended by one newline; anything but exactly one absolute path refuses. The recipient listing (`--show-keys`) uses its own home
  and the default trust model, because GnuPG 2.4 cannot list an expired or revoked key under
  `--trust-model always` without a trust database; that home may gain only GnuPG's own
  `trustdb.gpg`. Encryption uses `--recipient-file`, `--trust-model always` (the pinned
  fingerprints and the colon pre-check are the assurance), an AES-256 preference, no
  compression and a fixed literal name, in a home that may gain only `random_seed`.
- **The recipient pre-check.** The recipient file is read bounded and copied, so the bytes
  checked are the bytes encrypted to, and pins are exactly two strings, each a 40-digit
  uppercase fingerprint (OpenPGP v4). An armored secret key refuses from its bytes; secret
  material GnuPG lists refuses as secret, and a file GnuPG cannot list refuses as unreadable.
  Secret material GnuPG neither lists nor reads, such as binary secret packets after the
  armored block, is admitted and never reaches the ciphertext, the record or a log (a named
  limit in [deferred-tasks.md](../../roadmap/deferred-tasks.md#wave-3-step-9b1--named-limits-2026-10-25)).
  The colon listing then refuses,
  in this order: secret material, a missing pinned primary, more than one listed key, a missing
  pinned subkey, revocation, expiry at the current time, unusability (invalid or disabled, no
  encryption capability, a creation time in the future, or an encryption subkey other than
  cv25519 or RSA of at least 3072 bits) and another usable encryption subkey or additional
  decryption subkey (an ADSK, which GnuPG 2.4.1 and later adds as a further recipient). GnuPG's listing
  omits a key it cannot use, such as one created in the future or one without a valid user ID,
  so such a key refuses as missing or goes uncounted; GnuPG's own refusal and the
  `KEY_CONSIDERED` and recipient checks remain the independent second layer for it.
- **Encrypt once.** `encryptOnce` refuses before any GnuPG call when the destination already
  holds `relavium-<version>-private-maps.tar.gpg`, when the destination and the owner-only
  private root overlap (compared by device and inode, so one directory reached by a second
  spelling, such as a case-insensitive variant or a bind mount of that directory, does not hide
  the overlap; containment through a bind mount of a directory inside the other is not detected,
  a [recorded limit](../../roadmap/deferred-tasks.md#wave-3-step-9b1--recorded-low-findings-2026-10-25)), or when either is missing or the root is not an owner-only
  directory of this user. No root qualifies on Windows, where modes say nothing about access
  and no ACL check exists. Success requires exit 0, exactly one
  `KEY_CONSIDERED` for the pinned primary, one `BEGIN_ENCRYPTION 2 9` (SEIPDv1 with MDC and
  AES-256; an AEAD profile refuses) before one `END_ENCRYPTION`, exactly the expected work
  files, a ciphertext within the container's size plus 64 KiB whose public-key packets name
  exactly the pinned subkey and no hidden recipient and whose file is still the bytes about to
  be published, and homes holding only what GnuPG creates. The work directory and its
  plaintext are removed before anything is published, so a failed removal publishes nothing.
  The ciphertext is then published atomically: written to a fresh sibling, then hard-linked to
  its final name, which never replaces an existing file, so a failed write never leaves a
  partial file under that name. It returns a frozen custody record: name, size, SHA-256, pins
  and GnuPG version.
- **Plaintext and diagnostics.** The plaintext container and the recipient copy exist only in
  an owner-only work directory under the caller's private root, removed on every path; an
  interrupt in the caller's `exitOnInterrupt` scope stops GnuPG and removes the root. No secure
  erasure is claimed. Every refusal is a fixed `PACKED_CLI_CUSTODY_<CODE>`, including a host
  failure (`UNEXPECTED`, or `CONTAINER_UNREADABLE` for a staging that cannot be read) and a
  work directory that cannot be removed (`CLEANUP`); GnuPG's stdout and stderr, paths and host
  error text never surface.
- **Synthetic fixtures.** `custody-fixtures/` commits armored public v4 keys under
  `fixture.invalid` for the classes GnuPG can produce — good cv25519 and RSA-3072 keys, one
  advertising AEAD, an RSA-2048 subkey, an expired primary and subkey, a revoked primary and
  subkey, a sign-only key and a key with two encryption subkeys — with their pins and a
  maintainer-only generator that is never run in CI; the other classes are covered by crafted
  listings. No secret key is committed: the decryption round trip generates one per
  run in a short owner-only home and stops its agent afterwards, and a test refuses any tracked
  PGP private-key block.
- **Where it runs.** The custody tests are part of `test:acceptance-tools`, so they run in local
  `pnpm run ci` and the four Ubuntu jobs inside `ci`'s needs, against the runner's GnuPG; they
  fail, never skip, without GnuPG ≥ 2.2.8 or with a global configuration
  ([local-dev-setup.md](../../runbooks/local-dev-setup.md)). They do not run
  on Windows: no Windows job runs `test:acceptance-tools`, the `gpg` on the image's PATH is
  Git for Windows' MSYS2 build and MSYS2's own GnuPG under `C:\msys64` is installed off PATH,
  neither exercised here, and the tests use POSIX process and permission
  tools; `encryptOnce` itself refuses there. The 2.2.8 floor is enforced by the version check
  without being exercised.

## Package-test and release modes

**Package-test mode** is required on PR/push and manual dry-run. In its isolated
uncached originating pack job, build once, inspect exact tarball, verify maps and
CLI/engine symbolication locally, then discard all private maps/manifests/metafiles.
Share only the tarball and a nonsecret package-test receipt (version 1 with mode
`package_test`; the source SHA and dirty flag; the package version; the tarball's name,
digest and size; the public file inventory and package metadata; the originating workflow
identity and the producer toolchain) with platform consumers. It needs no production recipient. GPG fixture
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
