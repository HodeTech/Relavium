# Exact installed CLI package controls

These tooling runners implement Wave 3 Step 7b under
[ADR-0111](../../docs/decisions/0111-cli-meta-operations-use-a-lazy-packaged-runtime.md).
The canonical package and release contract lives in
[packaging.md](../../docs/reference/cli/packaging.md).
Step 8b adds required creation-owned native process controls to the same installed
artifact cohort. Step 8d adds installed global fatal/background/output-hook
controls; complete Step 8d acceptance remains separate. Step 9a.1 makes the producer
build an owned map-bearing candidate and finalize it before packing.

```sh
pnpm package:cli:pack /absolute/empty/artifact-directory
pnpm package:cli:consume /absolute/artifact-directory /absolute/fresh/report-directory
pnpm smoke:cli-package
pnpm check:map-controls
```

The producer (`produce.mjs`, run by `pack.mjs`) never builds in the developer's workspace.
It copies the files Git would ship, by the repository's ignore rules and the developer's
global excludes file (its Git reads no other home, global or system configuration or attributes), into a
fresh owner-only candidate tree (owner-only where POSIX modes are observable; on Windows it
inherits the temporary directory's ACL, which is not verified), refusing if the original checkout's commit, status or set of
files Git is told not to check changes during the copy (such a skip-worktree or assume-unchanged
file makes the source `dirty`), and installs the locked closure there offline, frozen and
without lifecycle scripts from the existing store. In that tree it emits the five
inlined dependency packages in order with the installed compiler, upstream maps and no
build cache. Prepack (`prepack.mjs`) performs the sole final CLI build in candidate
mode and runs the finalizer (`finalize.mjs`), which validates every consumed upstream map and every
final map, removes only the exact map-link trailers and stages maps, metafile and its hash
record in a private directory outside the artifact. The runner observes one actual
prepack build-start record and one finalization, checks the emitted graph, and
independently inspects the produced gzip/USTAR bytes. The inspector never extracts
the archive. Every JS and migration byte must match the finalized build and
canonical migrations; package metadata must match pnpm's publication transform.
Both receipt and archive validation independently pin the public `bin.relavium`
entry to `dist/index.js` and the ADR-0067 published `engines.node` floor to `>=22`.
The producer's own current Node major follows `.nvmrc`.
An exact public allowlist, checksums, modes, hashbangs, byte ceilings and negative
controls exclude links, traversal, duplicates, extra files, maps and private build
inventories. This deliberately supports the pinned packer's dialect, not general tar.

The resulting public `package-test-receipt.json` records `package_test` (Step 9a.2b; it recorded
`compiled_package_test` before the product map controls existed).
The candidate's maps are built, validated and then removed with the rest of the
private staging, also when the producer is interrupted (SIGINT, SIGTERM, SIGHUP), which
stops the build first and empties the artifact directory, even after the last build child
exited. An interrupted consumer stops its children, the bootstrap witness's included, and
removes its installation, the witness's fixtures and the installed smoke's working directory; the
installed CLI's detached native fixture targets end once the smoke worker that owns them is gone.
On POSIX `pnpm smoke:cli-package` forwards an interrupt to the producer or consumer it started
instead of ending before them, and it interrupts a stage past its deadline before it kills the
stage's process group, so the stage stops its own children; on Windows the stages receive Ctrl-C
from the shared console and a stage past its deadline is killed with its tree at once (no CI job
exercises these Windows paths). It starts no later stage after an interrupt. SIGHUP aborts and
cleans up even under `nohup`; use `setsid` or a terminal multiplexer to detach a long run. A
producer killed outright can leave its owner-only root in the temporary directory. The local
consumer installs under the temporary directory, so a shared `/tmp` is a named limit
(packaging.md). A failed
production prints only prepack's own fixed `✗ CLI …` lines and one fixed code
(`production-failure.mjs`), never a build child's captured output, which can quote a map. A
corepack-managed pnpm always runs from the developer's own corepack cache, never from the shared
temporary directory that holds the isolated homes (`corepackHome` in `process.mjs`). The finalizer
decodes every private map strictly (`source-map.mjs`). Before the receipt is written, the seal seals
the private manifest (`manifest.mjs`) and symbolicates actual packed CLI and core frames, captured
by a tooling-only preload while the CLI imports a canary into a private project
(`frame-capture.mjs`, which refuses any module that resolves outside the candidate, the keyring and
native addons in its own process, and needs Node 22.15 or later; an older producer Node refuses with
`PACKED_CLI_PRODUCER_NODE` before building), through the strictly decoded maps of the chunks those frames land in against
the matching source revision (`symbolicate.mjs`). The manifest is discarded with the staging, and
the capture's home, project and frames with the private root. The
receipt does **not** certify encrypted custody or a production release candidate (Steps 9b–9d),
and its `package_test` mode is a claim, never evidence (packaging.md says when a `ci` run backs it). An
artifact directory with a receipt, or a staging with a manifest, is never sealed again
(`PACKED_CLI_ALREADY_SEALED`), and `dist` and the tarball must still be the manifest's when the receipt
is written (`verifySealedDist`). `pnpm check:map-controls` (`map-controls.mjs` over
`map-controls-core.mjs`) runs every named negative control on product copies of one real production,
prints one JSON summary of codes and fixed lines (no absolute path, frame or map byte) and exits 1
unless every expected control ran once with its expected outcome; the required `map-controls` CI job
runs it uncached and uploads nothing. Step 9b.1's custody library (synthetic recipients only; nothing
calls it yet) builds one owner-only USTAR of the sealed staging (`container.mjs`, over the one strict
dialect in `ustar.mjs`) and encrypts it once to one pinned recipient with GnuPG ≥ 2.2.8 in fresh
isolated homes (`custody.mjs` over `gnupg.mjs`; POSIX only, since no private root qualifies on
Windows): a colon pre-check refuses missing, expired, revoked, unusable or unexpected recipients and the
secret material it can detect, the ciphertext must be SEIPDv1 with MDC and
AES-256 naming exactly the pinned subkey, an existing ciphertext is never overwritten, the plaintext
work directory is removed on every path and every refusal is a fixed `PACKED_CLI_CUSTODY_*` code.
`custody-fixtures/` holds the committed synthetic public keys; no secret key is committed. Step 9b.2 adds, again
with nothing calling it yet, the release binding receipt v1 with its validator and verified reuse
(`release-binding.mjs`, whose import closure starts no process), the scope gate and the sealer that writes the
receipt once after re-reading the ciphertext (`release-custody.mjs`), and the production recipient loader
(`release-recipient.mjs`), which refuses in Wave 3 because no recipient is committed. No private map,
metafile, manifest or per-source inventory enters the public artifact. The release workflow's
`release-guard.mjs` refuses every artifact until verified release custody exists: it
sets its exit code to 1 before it evaluates its rule (`release-guard-core.mjs`), so a rule
that returns, throws or cannot load still refuses, and no way of invoking it can skip the
refusal.

The consumer verifies the chosen bytes before installation, installs a copy outside
the workspace, and compares every installed public file with the archive receipt.
Its temporary project also pins pnpm 9.12.3 and permits lifecycle scripts only for
the existing better-sqlite3/esbuild allowlist. Dependency installation downloads
public registry packages; runtime provider responses are synthetic and keychain API
access is refused. No workspace install, product build, repack, provider request or
credential is used by a consumer. Actual installed dependency versions and metadata
digests are recorded; a workspace resolution is never substituted.
The consumer also executes the actual installed command shim through `pnpm exec`
for `--version` and `--help`, including the generated `.cmd` entry on Windows.
Missing or broken shims and wrong output refuse; both passes are required in the
public consumer receipt independently of the direct-entry behavior cases.

Each consumer repeats the 177 untouched-entry bootstrap controls and the ten
[installed behavior cases](smoke/README.md). Detailed local reports remain in the
support directory. CI uploads **only** the bounded public `installed-consumer.json`:
source/artifact/origin/runtime identities, public file/dependency digests, and exact
successful case inventory. It does not upload transport bodies, host paths or logs.

All installed-smoke native loads and SQLite reads run in one bounded owned worker.
The cleanup owner observes actual process closure and binds the private report to
that worker PID before removing the installation. Closing a SQLite connection is
not unloading its native DLL on Windows. Success receipt/summary publication occurs
only after required installation removal; a worker or cleanup failure prevents
publication, and a secondary cleanup/diagnostic failure preserves the primary.

A failed worker emits one bounded synthetic-test diagnostic on stderr after its
cleanup and private report write. The projection identifies failed canonical cases
and selected native-close facts without copying report paths, environment, argv,
transcripts or raw child output. Failure-text fields use one fixed private-detail
label, including assertion headers and nested reason/cleanup fields; arbitrary
first-line text is never public. Canonical case IDs and bounded native codes,
signals, identities and close observations remain available. The original raw
primary stays in the existing private report. It remains failure evidence: the parent still joins
the worker and removes its installation, and no success receipt is published.
An unavailable diagnostic sink does not replace the original failure.

The native-edge witness also forwards the actual `process.kill` receiver,
arguments, return and throwable unchanged while recording bounded monotonic time,
creation-owned target identity and own-data native errno. A passive
`uncaughtExceptionMonitor` records occurrence without handling the event or
inspecting exception text. Journal/clock/descriptor failure never masks the native
outcome; missing, failed, duplicate or nonterminal completion evidence refuses
the control. The failed-worker projection admits only its fixed diagnostic fields.
These observations improve failure attribution and never classify a native refusal
as harmless. Fault-free nonbootstrap cases still require 0/1 and one completed turn.
The Darwin injected-error control additionally recognizes only the fully observed
same-owned-group sequence: successful SIGKILL, EPERM/-1, actual target close, then
ESRCH/-3 and delivered close. That failure outcome requires exact infrastructure 9,
one fixed `cli_internal` diagnostic and **zero** completed turns. Missing/incomplete
evidence, a foreign group, another fault/mode, or unexplained 9 refuses. All original
readiness, actual-close, descendant absence, sibling survival, watchdog, timing,
cleanup and forbidden-service assertions still execute. A historical failed run
cannot acquire these unexecuted postconditions retrospectively; fresh execution is
required. This tests correct failure classification, not an ordinary successful
turn or the unverified kernel cause of EPERM.

Required PR/push consumers use current `.nvmrc` Linux/macOS/Windows and exact Node
22.0.0 Linux. The aggregate reinspects the tarball and requires all four unique
matching receipts plus successful pack/matrix jobs. Missing, failed, skipped,
cancelled, duplicate, wrong-runtime or mismatched evidence refuses. The required
`ci` job also checks the aggregate's success under `always()`.
CI pack, consumer and aggregate jobs clear inherited remote-cache credentials.
The aggregate explicitly checks pack and matrix outcomes before artifact downloads,
so a failed pack cannot turn an absent artifact name into an unrelated layout error.

Artifacts are named by originating run and pack attempt. A failed-consumer retry
reuses that original tarball and preserves successful same-artifact receipts; it
may replace only its own latest smoke receipt. Consumer attempt identities must
fall between the original pack and current aggregate attempts. The workflow's
same-run artifact handoff and job dependencies supply provenance; JSON claims
alone do not authenticate an arbitrary external artifact. Release smoke uses the
same consumer, while release reservation/archive/retry custody remains Step 9.

Local runs retain their actual runtime/platform and a local origin. They cannot
be promoted to one of the four required CI legs. The test suites include native
child timeout/output/cleanup controls, corrupted archives, receipt omissions,
origin/runtime mismatches and workflow mutations. Neither a local pass nor a
synthetic aggregate fixture is remote platform execution evidence.

`smoke:cli-package` is the local full-CI counterpart: it owns and cleans one fresh
candidate plus one actual-host consumer. Required GitHub jobs separately own the
same-artifact four-platform matrix; they do not run this local wrapper or rebuild
in a consumer.
