# Budget replay compatibility check

`pnpm smoke:budget-replay` is the offline downgrade acceptance check for
[ADR-0100](../../docs/decisions/0100-budget-authorization-is-durable-state-with-a-replay-barrier.md).
It is part of `pnpm run ci` and the required GitHub CI job. The canonical authorization contract is
[sse-event-schema.md](../../docs/reference/contracts/sse-event-schema.md).

The check freezes the actual predecessor at
`1b3f8d70c05c9152043dcc476eaa1afaaa87381d`, snapshots the current production
sources, and executes each version in a separate Node worker. The predecessor
first produces a genuine legacy budget pause and a historical `input_provided` decision prefix.
The current checkpoint, admitted engine and both strict discovery stores read the latter as a
fatal budget rejection, retaining its original bytes and producing no agent output or egress.
The current engine then produces
12 durable pause/decision prefixes, including its decisions of that legacy gate.
The predecessor's actual parser, SQLite strict reader, CLI checkpointer and
engine entry must refuse every prefix before execution registration, scheduling,
credential resolution or egress. Its exact acquired lease must be released. A
legacy budget rejection and an ordinary human-gate approval are positive controls.
Tolerant display is tested separately and never supplies a replay checkpoint. The parent independently
asserts the exact twelve unique `(label, cut)` pairs, exactly matching producer capture metadata in every
completed predecessor refusal, zero egress and both named completed positive controls. Eleven mutation
controls remove/duplicate/change coverage or acceptance evidence and must be refused; unchanged actual
worker evidence remains a positive control. Worker stdout counts alone cannot certify coverage.

`frozen/pre-w7-source.tar.gz` contains the original source, package metadata,
lockfile, SQLite migrations and source manifest. Its SHA256 is
`cf980edd6d4d8a8652fa236c1c0d46055249fe59944ec284a120aea19c6b10bb`;
the source manifest's SHA256 is
`cb3361e5c0f75d427ee936ba43beba871acacbc117729df7820dbb7aa5ec229b`.
Both are verified before any frozen source runs. Every one of the 143 manifest files is also checked
against the actual Git blob at the pinned baseline commit, using `git --no-replace-objects cat-file`
and the manifest byte/hash inventory. An archive and self-declared digest changed together cannot
certify a different predecessor. The pinned commit must be available locally. CI checks out full
history (`fetch-depth: 0`) and explicitly fetches the canonical exact SHA during setup when absent,
including main-based or post-squash branches. If origin no longer retains that object, setup fails
with its exact pin; no different baseline is accepted. The offline command never fetches implicitly
and refuses a missing baseline before allocating/extracting an evidence tree. The loader also verifies each
source it loads and forbids mixing versions or resolving workspace source/dist.
It transpiles TypeScript for execution; normal CI owns typechecking.

`frozen/dependencies.json.gz` pins 180 package roots and 12,000 portable files,
including every installed declared dependency, peer and optional edge. All versions
are present in the immutable predecessor lockfile. Its SHA256 is
`7cce53b58c5eade131f59dcce426519980b9cdc27644d9fbade5087b625bd529`.
The original 93 roots' portable bytes are retained; the 2026-10-03 review correction
extends their metadata closure to installed peers rather than changing their versions.
The 296 edges record exact target roots, two Node builtins and 29 absent optional
edges. Multiple versions have distinct identities; a name alone is not a join key.

`frozen/dependency-bytes.bin.gz` ships those portable bytes in the exact package/file order of the
existing pins. Its 20,143,535 compressed bytes have SHA256
`807644e6f71d153f7bfa4e0f47a3304f851391ee40ad18635ded1468a8fc5c49`.
The decompressed payload is a fixed `relavium-budget-replay-dependencies-v1\n` header followed by
112,929,534 file bytes; its full 112,929,573 bytes have SHA256
`e37029d0ea9fdfbae33a97e2fce68a260bb2ad1af2ce867d6b28f2f9abcedd53`.
Compressed size/digest, bounded decompression, full payload size/digest and every per-file
size/hash are checked before a worker starts. There are no names or lengths trusted from the
binary stream; the already-pinned manifest is the only index. Truncation and trailing bytes fail.

The check reconstructs the archived metadata/files and all explicit dependency links inside its
owned tree, including Drizzle's SQLite peer. It verifies actual lookup in that copied graph. A redirected edge or a newly resolving
optional package is refused. Both the ESM loader and CommonJS `module.require` check
the resolved file against the copied byte inventory and its issuer-specific frozen edge before loading it;
neither accepts a switch to a different already-pinned version. Root imports and same-package
relative imports are bound too. Declared lookup edges, including absent optionals, are rechecked
before package execution so `require.resolve` cannot silently acquire a previously absent optional.
Neither runtime accepts
an arbitrary `node_modules` path. CommonJS uses the public `module.require` and
`createRequire.resolve` APIs, including in the loader thread, without a private loader
hook or a newer Node minimum. `NODE_PATH` is empty in workers.

The locally compiled `better-sqlite3/build/Release/better_sqlite3.node` is the explicit
platform exception to portable matching. Its package version and source are pinned;
its actual binary is copied, hashed for the invocation and checked at runtime. The
archived baseline lockfile is immutable. The current repository lockfile can evolve;
the check verifies the archived lockfile and reads portable packages only from the shipped byte
archive. Ordinary installed portable dependency updates, removals, changed peers or newly present
optionals do not change this predecessor. Only the matching installed `better-sqlite3` native
package/version is required for the current platform; its binary is intentionally invocation-specific.
The check never installs packages or resolves dependencies over the network. Native updates must
retain that explicit baseline platform exception; neither source, portable bytes nor pins are refreshed.
Git and tar are invoked by absolute standard OS installation paths, not an inherited PATH entry.

All extraction, snapshots, logs, loader traces, SQLite databases, caches and
temporary files go into one exclusive external `relavium-budget-replay-*`
directory printed by the command. Its `OWNER.json` identifies the canonical repository and parent
PID. Each invocation atomically acquires its own directory; no shared initialization marker can
leave concurrent or interrupted runs stuck. On success or failure, `completion.json` publishes the
completed state after workers close. The current invocation plus the newest two other completed
invocations for that exact repository are retained; older completed owned evidence is pruned.
Active/interrupted evidence, foreign owners, redirected paths and malformed records are excluded
from the completed scan. Retirement atomically moves an older candidate into a fresh private
`relavium-budget-replay-retirement-*` directory outside the completed namespace, then verifies
the claimed directory identity and exact owner/completion records before deleting it. A changed
claim is preserved in that private directory and finalization fails; it is never restored over a
successor or recursively deleted. These checks cover post-scan pathname/owner changes. They are
not a kernel security boundary against a same-user process that can also mutate a private claim.
Interrupted and unexpectedly claimed evidence is intentionally not automatically reclaimed.
A finalization error fails a
successful check; when the check already failed, it reports a separate fixed diagnostic and preserves
that primary failure. Every stage/retention evidence writer is attempted without replacing the
first worker/readiness failure; evidence-only failures remain observable. Fixed secondary diagnostics
use synchronous descriptor writes, so a closed pipe cannot emit an asynchronous error later.
The worker-close promise observes `close` even after native spawn failure. Failed spawns retain
an honest null PID and never publish completion before that observation. No old source or
test is extracted into the repository or normal Vitest collection. Dependencies are
physical owned copies with individual links inside physical `node_modules` directories.
Seventeen permanent graph/runtime controls distinguish installed portable drift from immutable
archive tampering, truncation/trailing bytes, post-preflight unpinned and pinned-to-pinned resolution,
root-import/byte drift and positive/restored two-version graphs. Seven provenance controls refuse
forged blob/digest/path/baseline identities and changed source plus a matching self-declared digest,
then prove the unchanged 143-file baseline. Those interventions use a separate writable source copy;
they never modify the extracted predecessor, whose archived files can be read-only. Eight retention controls cover bounded sequential and
ten concurrent completions, future timestamps, active/interrupted/foreign/redirected records,
current-owner refusal and direct-child ownership. Seven additional finalization cases, grouped into
three results, preserve Error/primitive primary failures and a failed diagnostic sink while surfacing
finalization-only failures. Fourteen additional production-caller controls cover six stage write
faults, ten genuinely failed retention children, a native failed spawn, three real closed-stderr
pipes retaining `Error`/`undefined`/`null`, and three post-scan owner/physical replacement claims.
The completed replacement deliberately reuses the same owner/completion bytes and proves that
directory identity is required. These controls execute the actual helpers/callers; they do not
mirror their implementations. The ESM control uses the actual production loader
with an inert, pinned TypeScript stand-in; it loads no TS source and is separate from the
real predecessor/source/dependency acceptance workers.
Their probe code cannot run its inert marker on a rejected load. Workers have
45-second deadlines and their exit records are retained; SQLite connections close
in `finally`. Providers and key resolution are refusing injected doubles, and
network fetch is forbidden. No live key or keychain access is involved.

This check proves the downgrade boundary for its captured current sources. The
core runtime suites separately prove allowance exhaustion, quote refusal, crash
identity, deadline, effect preflight and acknowledgement races. Compatibility
evidence alone does not constitute whole-W7 acceptance.

## Provenance and packaging verification

The 143 source files, including package metadata and the baseline lockfile, are verified against
Git objects at the exact predecessor SHA. The 180-root portable dependency inventory and captured
file bytes are reviewed, digest-pinned evidence. Membership of their package keys in that Git-anchored
lockfile verifies version/graph correspondence; it does **not** prove the extracted files came from
a registry tarball with that lockfile's integrity value. File digests are not tarball integrity values.
The native SQLite binary is the separately disclosed invocation-specific platform exception. These
boundaries do not provide an external supply-chain attestation for all executable dependency bytes.

Read-only verification preserves the committed archives. Decompress `dependencies.json.gz` as JSON;
walk `packages` in recorded array order and each root's `files` in recorded array order. After the
literal `relavium-budget-replay-dependencies-v1\n` header, consume exactly each file's declared byte
count from the decompressed binary archive and verify its SHA-256, with no trailing bytes. Verify
compressed/decompressed digests and bounded sizes as `check.mjs` does. Extract the source tarball
only into an exclusive temporary directory, verify every manifest byte/hash and compare with the
pinned Git blobs before execution. `pnpm smoke:budget-replay` performs these checks offline using
physical owned copies and retains the invocation's manifests, inventory, guard results and logs.

The original source-tar member metadata and compression flags were not recorded as a byte-identical
regeneration recipe. This procedure verifies the existing immutable artifacts; it does not claim
that rebuilding tar/gzip output recreates their compressed bytes. Do not refresh archives, manifests
or digests to accommodate a current dependency update. A deliberate new predecessor requires its own
reviewed compatibility decision rather than silently replacing this one.
