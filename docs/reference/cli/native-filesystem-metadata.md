# Native filesystem security metadata

- **Status**: Accepted design; native implementation in progress, acceptance open.
- **Owner ADR**: [ADR-0125](../../decisions/0125-file-writes-preserve-security-metadata-through-a-native-host-adapter.md).
- **Surface**: CLI host only; [prepared writes](../shared-core/tool-registry.md#proposed-prepared-writes-and-live-previews--mvp-3) and [packaging](packaging.md).

This is the canonical accepted metadata boundary for prepared replace, append
and edit. It does not certify the historical mode/uid/gid-only prototype. The maintainer authorized the corrected decision after supplied review
findings were verified; native implementation/profile acceptance remains open.

## Authority and lifetime

The TypeScript host retains scope/confidentiality guards, exact UTF-8 snapshots,
read-before-edit evidence, approvals and effect correlation. The native adapter
wraps OS metadata/access/publication primitives only. No generic filesystem,
command, network or keychain capability is exposed to the model or core engine.
Model arguments cannot create native handles or substitute metadata snapshots.

Prepare binds bytes, canonical identity and supported metadata to one source.
It queries operation-specific rights under the effective credentials used by
the actual operation, tied to the same source identity. A POSIX real-UID
`access()` check or a bare Windows `AccessCheck` result is not, by itself, proof
of filesystem data-write/append access. During admitted execution, require
operation-appropriate non-truncating source access under those credentials and
recheck the source/policy near publication, including relevant read-only flags
and mandatory access policy. Directory rename authority alone is insufficient.
The existing owner-controlled check-to-publication race limit remains; this is
not a new filesystem compare-and-swap guarantee. Metadata failure before effect admission is a
fatal, fixed-reason safety refusal, not a correctable text-edit precondition or
a new reason in ADR-0120's closed correction vocabulary. The current policies
and cancellation precedence remain. Uncertainty after dispatch uses the existing
non-retryable journal/error ladder, never a metadata-reset retry.

All built-in `write_file` calls, including new-file creation, overwrite,
byte-identical/empty replacements and append, and all `edit_file` calls use
tier-3 durable preparation under ADR-0125. Their effect row precedes directory
creation, staging, metadata application and publication. This replaces the
historical overwrite exclusion in the [journal predicate](../shared-core/effect-journal.md#3-what-is-journaled)
and makes prepared overwrites eligible for ADR-0124 inspection. Missing journal
wiring refuses mutation. No row is created for a read-only preparation refusal
or approval denial. After possible dispatch, an unresolved row blocks resume
before provider/node execution; `retryable: false` alone is not crash evidence.
Only usable committed run evidence may replay, without native preparation,
publication or a second settlement. Session rows never replay. No migration can
invent evidence for a historical unjournaled crash.

Keep the TS host's lexical/canonical scope, protected/confidentiality, symlink
and hard-link guards through publication. Native descriptors do not bypass
those guards or widen authority. Node can perform a non-truncating write/append
open; that alone cannot capture/copy ACLs, xattrs or flags or prove every later
write-time access decision. Native safety failures at the preparation cut are
fixed-diagnostic fatal/non-retryable errors, never new correctable edit reasons.

Snapshot metadata and native handles are ephemeral and bounded. No ACL/xattr
value, security descriptor, native path-bearing error or handle enters preview,
history/effects, durable events, export or logs. Native operations remain owned
by the actual producer until they settle; cancellation cannot detach copying or
publication. Release is one-shot/idempotent under the owning operation.

## Required platform profiles

These are acceptance requirements for the adapter, not statements that every
OS/filesystem combination is already supported. Freeze the exact native
mechanism/attribute allowlists and bounds in this home before source acceptance.
Unknown or unsupported caller-visible security metadata is refused by default.

| Profile | Required policy | Mechanism to validate |
|---|---|---|
| macOS ordinary local regular text files | Preserve owner/group/mode, effective ACL and supported xattrs including quarantine; respect write/append denial and relevant file flags. Bind/recheck metadata. Distinguish OS-managed provenance and content-bound metadata from opaque attributes. | Descriptor-bound system inspection/access checks and `fcopyfile` metadata controls with verification; unsupported flags/attributes or failed preservation refuse. Never treat Node `copyFile` as equivalent. |
| Linux ordinary regular text files | Preserve owner/group/mode, POSIX access ACL and supported opaque user/security attributes under an explicit namespace profile; respect actual write rights and relevant inode flags. Integrity/capability or otherwise unsupported protected attributes refuse. | OS access, ACL/xattr/flag mechanisms via established bindings; no in-house ACL evaluator or mode-bit inference of ACL absence. Read/copy/verification failure refuses. |
| Windows ordinary regular text files | Preserve the defined owner/group/DACL and supported named-stream/attribute policy; respect caller data-write/append rights, not merely parent delete rights. Separate privileged SACL/audit/integrity metadata from the caller-visible profile. | Native security inspection and private staging. `ReplaceFileW` is a candidate, not a selected atomic primitive: validate its DACL/stream merge and partial-failure behavior against the publication contract. Never enable ignore-ACL/ignore-merge fallbacks. |

`com.apple.quarantine` and Windows `Zone.Identifier` (Mark-of-the-Web) are named
preserve-or-refuse requirements, not optional members of an unspecified list.
Content approval does not authorize removing/unblocking them. Actual attributed
inputs, stream bytes and metadata-only changes need native positive/negative
controls. Apple `fcopyfile` is a mechanism candidate, not proof that a particular
flag preserves quarantine. Do not use `COPYFILE_CLONE` without the required ACL
preservation path, or assume cloning proves the other metadata policies.

Verify owner/group preservation under ordinary non-root credentials. If the
effective caller cannot restore the required owner/group, or verification finds
a different policy, refuse before publication; never ignore `chown` failure or
normalize ownership to the staging creator. No elevated helper is introduced.

The scope is the documented caller-visible and platform-publication profile.
It cannot prove absence of privileged metadata the OS withholds. Do not claim
universal preservation of invisible attributes or security policy outside those
profiles. Linux xattr enumeration can omit attributes inaccessible to the
caller; an empty list is not evidence of global absence. Unsupported enumeration,
`ENOTSUP`, access errors and failed verification are not an empty supported
profile. If available OS evidence cannot establish a supported operation,
refuse. On Windows, define how conflicting named streams are handled:
`ReplaceFileW`'s preservation of streams absent from the replacement does not
prove equality of arbitrary conflicting streams or of the whole security
descriptor. A privileged SACL or integrity label must not be promised preserved
merely because a DACL operation succeeded.

Special/privilege-bearing mode bits, integrity/content-bound attributes and
filesystem-specific transformations require explicit supported behavior or
refusal. Do not blindly copy an old integrity assertion onto changed bytes.
OS-managed timestamps/version/provenance may legitimately change; identify
those exceptions explicitly rather than presenting byte equality as meaning
equivalence. Existing owner-controlled path-race limits remain, with no new
claim of isolation from a hostile process running as the same user.

## New-file creation policy

Within each enabled profile, a new file's final access/security policy must be
equivalent to the OS creating it directly in the actual destination parent
under the operation's effective credentials, creation mode and captured umask.
The default file mode is `0666` before OS inheritance/masking; `createDirs`
uses the host's documented directory creation mode. Private staging's own
parent or a later `chmod` is not evidence of that equivalence. The OS derives
ACL inheritance; Relavium does not implement its own ACL evaluator/merger.

Read-only preparation pins the nearest existing parent/ancestor identity and
observable creation-policy inputs. Recheck before creating staged artifacts,
after any admitted parent creation, and immediately before final publication.
Bind the final parent and policy when missing parents are created, retaining
the original ancestor/credential/mask expectations. Detectable identity/default
policy or creation-mask changes refuse; unsupported/unverifiable inheritance
refuses rather than silently losing or broadening legitimate access.

| Profile | Required OS-derived inputs and control |
|---|---|
| Linux | Actual parent's default ACL, group/setgid and supported filesystem/mount/label semantics, effective uid/groups, requested mode and umask. Compare with direct kernel creation on the same supported profile. Creating with `0600` and then chmod is insufficient where an inherited ACL was filtered at creation. `O_TMPFILE` in the destination parent is an unnamed candidate, conditional on filesystem support, non-root publication and exact policy proof. |
| macOS | Actual parent's inheritable ACL, owner/group and supported flags/attributes, effective credentials and creation mask. A descriptor-bound/private staging mechanism must reproduce the OS-derived destination policy; copied staging-directory defaults are insufficient. |
| Windows | Actual parent's inheritable descriptor and group/owner policy, effective token, supported attributes/integrity profile and creation flags. Use native descriptor derivation/creation mechanisms, not a hand-built DACL. Prove the policy against direct `CreateFileW` creation for the supported profile. |

These are closed-profile obligations, not a claim to observe hidden or dynamic
name-dependent mandatory policy. Unsupported policy transformations refuse.
Existing owner-controlled check-to-publication race limits remain; no atomic
compare-and-swap of directory policy or process credentials is promised.
Native controls cover different default ACLs, setgid/group inheritance, umasks,
supported labels and parent-policy-only changes, including `createDirs`.

## Private staging and publication

Preparation creates no directory, temporary file or writable effect. After
approval and durable admission for every model file write, create same-filesystem private
staging using OS-enforced owner-only access before writing payload bytes.
An original ACL-restricted mode0644 file must not yield a broadly readable
temporary copy. A private staging directory may contain the file while final
access metadata is installed; its identity/cleanup belong to the operation.

Recheck source identity, bytes and supported metadata before publication. Apply
and verify final access policy through OS mechanisms. Errors before publication
refuse without changing the destination. Each enabled native primitive must
preserve atomic replacement and no-clobber creation's existing byte contract,
including its documented failure cases. Windows `ReplaceFileW` can return errors
with the original path moved or absent; testing success alone is insufficient.
Do not enable it merely by classifying those known incompatible namespace
outcomes as uncertainty. Select a sufficient mechanism/profile or keep that
platform's write acceptance blocked and seek a decision if the contract must
change. Unanticipated possibly changed state after dispatch is non-retryable
uncertainty, retained through the existing journal/error ladder with owned
recovery; it is never a precondition miss or blind retry. Cleanup removes only
pinned owned entries and reports uncertainty for unproven entries.

New files follow the creation-policy section above; existing files
keep their supported policy. Missing native support is not an implicit grant
for mode-only or in-place writing. Read-only tools and CLI meta paths remain
available without eagerly loading a native write component.

## Crash staging ownership and recovery

Prefer an OS-private unnamed staging primitive where its publication/policy
contract is proven. Named staging needs host-owned recovery evidence before
payload bytes are written; ordinary `finally` cleanup is insufficient.

Use an owner-private, versioned index under the explicit operator home's
`.relavium/fs-staging-v1/`, isolated from model file authority. Records contain
only a bounded staging locator, parent/directory/file native identities,
owner uid/SID, producer PID/nonce and protocol/cleanup state. Do not persist
final target names, payload, preview, ACL/xattr values or process-local handles.
The staging locator itself reveals its parent location: it is private local
operational recovery metadata, outside `history.db`, effects, events, exports
and logs, not a secret-free product display value. It grants cleanup of proven
owned artifacts only, never a new model filesystem root or publication authority.

After the durable effect claim, reserve the private index record exclusively;
create the private stage and empty payload, capture their identities and durably
publish the pinned record before copying bytes. Use the platform's supported
file/directory flush sequence. A crash before pinning cannot leave payload
bytes; an unproven empty entry is preserved for operator recovery. This index
is an artifact-ownership inventory, not a second effect journal. Publication
uncertainty is resolved only by the existing effect gate, never by finding a
temporary file or comparing final bytes.

Owner-only permissions do not isolate a model using the same OS account.
Reserve the staging namespace and hard-deny every model filesystem operation
on active and orphan stage directories/artifacts, including lexical/canonical
aliases, directory enumeration/descent, ranged/glob reads, search/find,
mentions/resolver reads, writes and output-target consumers. Identity guards
must also reject opened-object/hard-link aliases to staged payloads. Keep this
exclusion through cleanup, across concurrent hosts and separate Relavium
processes; an instance-local hidden-name convention is insufficient. Establish
the trusted protected namespace/identity evidence before payload creation,
with the private index outside model authority. A missing/incomplete guard may
not silently omit another producer's stage. If a placement/profile cannot
provide this boundary with bounded trustworthy evidence, refuse named staging
there or use a proven unnamed mechanism. Prove both positive ordinary-file
access and negative active/orphan/alias access through actual model-capability
consumers. This does not claim sandboxing of an independently authorized OS
process or a hostile same-user process under ADR-0105.

Bound the inventory to 128 records, each at most 16 KiB, and a recovery pass to
128 records/2 MiB of record data, eight immediate children per stage and no
recursive descent. Check cancellation/yield and a two-second cooperative scan
budget between OS operations; retain/join an actual native producer that has
not settled. Exhaustion or a full/uncertain inventory emits a fixed diagnostic
and cannot evict evidence or silently allocate untracked named staging.

Validate private index ownership/permissions and regular link-free records.
Claim cleanup exclusively, then revalidate the marker, parent/stage identities,
owner, producer liveness and each exact owned regular single-link artifact before
deletion. Remove only those artifacts and a proven empty owned stage. Preserve
live or reused PIDs, inaccessible/unknown liveness, malformed/unrecognized
records, identity changes, links and unproven entries. A dead cleanup claimant
requires the same evidence before another claimant can recover its claim.
Never remove final targets or user-created parent directories via this inventory.

Interactive/session startup may inspect the bounded index and report a fixed
pending-recovery fact without loading the native write component; meta paths
do not perform that scan. Actual automatic reclamation runs under the first
approved, durably admitted write's owned native lifetime, before its new staged
payload. Read-only use need not load the addon. If no write occurs, or ownership
cannot be proven, retained artifacts are reported rather than declared removed;
explicit operator recovery inspects the private index and removes only artifacts
whose ownership/liveness can be independently established. Document this local
recovery procedure before source acceptance; it never authorizes auto-publication,
effect retry or blind recursive deletion.

Kill real producers before/after index pinning, during payload copy and metadata
application, after publication and before effect settlement/checkpoint. On next
use, prove bounded discovery, no live/unknown-owner deletion, orphan cleanup and
the independent journal resume refusal/replay outcomes. Process-kill evidence
does not certify machine-power-loss durability; OS flush guarantees and any
actual power-loss evidence must be attributed separately.


### Private inventory protocol and claims

The implementation uses a closed binary protocol, not JSON or an extensible
metadata document. The explicit operator home is pinned and revalidated with
its `.relavium/` parent and `fs-staging-v1/` directory. Native placement verifies
operator ownership and the profile's private directory/file policy. The
TypeScript reader checks pinned path/object identity, regular single-link
records and the protocol. On Windows it follows the explicit operator-home
ACL trust boundary in [ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md):
Node mode bits do not prove a private Windows ACL. Native creation and
revalidation must establish that policy before placement is enabled.

Only these index entries are recognized; `nonce` is exactly 32 lowercase
hexadecimal characters:

| Entry | Meaning and reader behavior |
|---|---|
| `inventory.lock` | Permanent empty allocation-lock file; never an ownership receipt. |
| `<nonce>.reserved` | Empty exclusive reservation before pinning. No payload is authorized. |
| `<nonce>.prepare` | At most 16 KiB of uncommitted record data. Partial writes are expected; no payload is authorized. |
| `<nonce>.record` | Complete immutable pinned record. Supplies stage-directory and payload Node identities for model-authority exclusion. |

A partial `.prepare` or ordinary `.reserved` state must not deny otherwise
ordinary reads merely because its producer is concurrent. Such entries still
require trusted names, private regular single-link objects and bounded sizes.
Unknown entries, unsafe objects and malformed committed records fail closed.
The permanent stage-path prefix is excluded before empty stage creation;
transient records never waive that exclusion.

All integers below are unsigned little-endian. Strings contain exactly the
specified number of UTF-8 bytes, without a terminator; no trailing bytes or
additional fields are accepted.

| Byte offset | Field |
|---|---|
| 0 | Eight ASCII bytes `RVSTG001` |
| 8 | State byte `1` (pinned), followed by seven zero bytes |
| 16 | Four-byte producer PID, in `1..2147483647` |
| 20 | Two-byte owner length, in `1..184` |
| 22 | Two-byte stage-locator length, in `1..4096` |
| 24 | The 32 ASCII nonce bytes matching the entry name |
| 56 | Owner: decimal effective UID on POSIX, SID on Windows |
| After owner | Absolute normalized stage locator with basename `.relavium-fs-stage-v1.<pid>.<nonce>` |
| After locator | Three 40-byte identities, in destination-parent, stage-directory, payload order |

Each identity contains an eight-byte native volume value, a 16-byte native
object ID, an eight-byte Node `dev` witness and an eight-byte Node `ino`
witness. Native cleanup compares full identities; the read-only Node guard
uses its separately proven witnesses. Record length is exactly
`176 + ownerLength + locatorLength`. There are no final-target names, payload
bytes, policy values or durable handles in this format.

Allocation and recovery count at most 128 distinct nonces and 385 directory
entries (three transition entries per nonce plus the allocation lock), at most
16 KiB per entry and 2 MiB of aggregate record data. Recovery inspects at most
eight immediate stage children and never descends recursively. Cancellation
and the two-second cooperative budget are checked between operations; they do
not interrupt an outstanding OS call or authorize detaching its producer.

Pinning flushes the empty payload, stage directory and destination parent and
publishes the flushed prepared record by rename to `.record`, followed by the
index-directory flush, before any payload copy. Index hierarchy creation also
flushes its containing directories. The empty reservation can then be removed.
During the live operation, the host adopts the exclusively created directory
and empty payload immediately, retaining their handles and full identities.
Normal pre-pin cancellation/error cleanup can remove those exact empty
artifacts and its reservation after revalidation, including its owned partial
prepared marker or a completed marker rename whose directory flush failed.
Unexpected children, links, changed identities or missing proof preserve the
artifacts. These ephemeral handles are never persisted: a crash before pinning
still leaves unproven empty entries for operator recovery, and their names
alone do not establish cleanup ownership.

Allocation holds an exclusive nonblocking kernel lock on `inventory.lock`;
recovery also claims the exact pinned record before checking and deleting its
artifacts. POSIX uses `flock(LOCK_EX | LOCK_NB)`. Windows uses `LockFile` on one
byte at offset 16385, beyond the bounded record data, so a cleanup claim does
not lock the reader's record bytes. These are cooperating-process claims, not
protection from independently authorized hostile OS processes. See the
[Apple flock manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html),
[Linux flock manual](https://man7.org/linux/man-pages/man2/flock.2.html) and
[Microsoft LockFile contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfile).
A dead claimant leaves no persistent claim token to steal; the kernel releases
its lock. Failure to acquire a claim preserves evidence and does not force
unlocking or deleting the lock file.

### Explicit operator recovery procedure

This procedure is local maintenance by the operator, outside model file
authority. Automatic cleanup remains restricted to the first already-approved,
durably admitted write's joined native lifetime. Do not manufacture a write or
approve unwanted content merely to trigger cleanup. The host-private addon's
`recoverMetadataStaging(home, cancellation)` entrypoint reuses the bounded
native recovery routine and accepts only the explicit operator home. It
returns `{ removed, retained }` counts and has no publication operation or
arbitrary deletion target. This is an explicit operator maintenance path,
not a model tool or a new public CLI command. Its local Node bridge has been
exercised; exact-artifact and cross-platform invocation remain acceptance gates.

1. Stop known Relavium sessions, workflow runs and host processes using this
   operator home through their normal shutdown path. Wait for their owned work
   to settle. Do not kill a PID merely because a record names it: it may have
   been reused by another application. Keep the private index and stages in
   place, and keep their namespace excluded from model tools.
2. Inspect only this home's immediate `fs-staging-v1/` entries using trusted
   local read-only tooling, subject to the protocol and discovery bounds
   above. Keep locators and records local; do not paste them into model tools,
   public issues or product logs. Stop on excess entries/data, malformed
   records, unsafe ownership/policy, links or changed home/index identity.
   Renaming the index, deleting it or changing permissions to bypass the scan
   does not resolve retained artifacts.
3. Separate complete pinned records from reservations and prepared fragments.
   An empty stage, recognizable name, old timestamp or matching content is not
   ownership proof. Preserve every entry lacking full pinned identities unless
   independent, contemporaneous native ownership evidence supplies the missing
   proof. Without that evidence, leave it in place for maintainer-assisted
   recovery; a zero-length reservation does not make recursive deletion safe.
4. For a pinned candidate, a trusted native inspection must prove the record's
   operator UID/SID, current exact parent/directory/payload identities,
   unchanged marker and private directories. Inspect no more than eight
   immediate children. The only removable payload is the exact regular,
   operator-owned, single-link `payload` object identified by the record.
   Preserve unexpected children, aliases, identity differences and objects
   whose owner or policy cannot be checked. On Windows, retain both the full
   128-bit native file identity and the Node witness; a pathname, Node mode or
   shortened file index is insufficient.
5. Establish that the producer is absent and claim cleanup exclusively before
   revalidating the proof. POSIX requires native `kill(pid, 0)` to fail with
   `ESRCH`; permission denial and other errors are unknown. Windows requires
   the checked process-absence/exit result. Live/reused PIDs, inaccessible
   processes and uncertain results remain preserved. Recheck liveness and all
   identities immediately before deletion. Use the native maintenance entrypoint
   below for this claim-and-delete sequence. If the installed component is
   unavailable or refuses, preserve the evidence for maintainer-assisted
   recovery rather than substituting an unchecked shell deletion.
6. Once the bounded native checks and exclusive claim succeed, remove only the
   proven payload, flush its directory, remove the proven empty owned stage,
   and flush its parent. Remove the unchanged pinned record and flush the
   index only after artifact cleanup is proven. Preserve the record after
   unproven aliases, unexpected entries or incomplete cleanup. Never remove a
   final target, a user-created parent or the permanent allocation lock.
7. Inspect again within the same bounds and report retained entries honestly.
   Artifact cleanup does not settle an effect, prove publication or permit a
   run retry/resume. Preserve the independent journal's unresolved row and
   follow the [effect-resume gate](../shared-core/effect-journal.md) even when
   no stage remains.

For a trusted current installation, save the following operator program as
`recover-fs-staging.mjs` and run it with Node 22 or newer. Supply the absolute
path of that installation's `dist/native-fs/loader.cjs` and the actual operator
home. A source checkout uses its verified
`apps/cli/native/fs-metadata/runtime/loader.cjs` instead. Select the trusted
installation explicitly; do not locate a shim from a model-selected workspace.
The fixed shim verifies its asset inventory. This does not install, download
or compile a component.

```js
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';

try {
  const [loaderPath, home, ...extra] = process.argv.slice(2);
  if (!loaderPath || !home || extra.length || !isAbsolute(loaderPath) || !isAbsolute(home)) {
    throw new Error('invalid maintenance arguments');
  }
  const { loadFsMetadataAddon } = createRequire(import.meta.url)(loaderPath);
  const addon = loadFsMetadataAddon();
  const cancellation = addon.createWriteCancellation();
  const cancel = () => addon.cancelWrite(cancellation);
  process.on('SIGINT', cancel);
  try {
    const report = await addon.recoverMetadataStaging(home, cancellation);
    if (
      !Number.isInteger(report.removed) || report.removed < 0 ||
      !Number.isInteger(report.retained) || report.retained < 0 ||
      report.removed + report.retained > 128
    ) throw new Error('invalid maintenance result');
    console.log(JSON.stringify({ removed: report.removed, retained: report.retained }));
  } finally {
    process.off('SIGINT', cancel);
  }
} catch {
  process.stderr.write('Filesystem staging recovery could not be completed.\n');
  process.exitCode = 1;
}
```

```text
node recover-fs-staging.mjs "/absolute/installation/dist/native-fs/loader.cjs" "/absolute/operator-home"
```

Wait for the program to exit, including after Ctrl-C. A retained count is not
permission to remove those entries manually. Partial safe cleanup may precede
a refusal; the fixed error does not assert that nothing changed. Unknown
ownership and malformed/pre-pin evidence still require the proof and
maintainer-assisted handling described above. This program never resolves an
effect-journal `needs_attention` state or authorizes re-execution.

On 2026-11-12 the exact program above was exercised on non-root macOS arm64,
Node 22.23.1, using the verified source-runtime shim. A safely absent index
returned zero counts without creating a directory or lock. A non-private
ancestor returned the fixed refusal while preserving its mode and contents.
The addon's separate killed-producer controls exercise actual pinned orphan
removal. Installed-artifact and cross-target program execution remain open;
the absent-state control alone is not proof of artifact deletion.

### Staging implementation evidence scope

The current `stage_index` Rust tests run on macOS with the actual
`MacosProfile`, real files, OS locks and subprocesses; they do not substitute a
mock `Profile`. The killed-child case exercises the native index producer
before pinning and after pinned payload creation, waits for the killed child,
and verifies conservative pre-pin retention and pinned orphan cleanup. Other
cases cover capacity, binary validation, live producers, hard links, foreign
children, changed home/marker identity, cancellation and exclusive claims.
A 140-cycle reservation/directory/empty-payload cancellation case verifies that
normal pre-pin cleanup does not consume the 128-record inventory; partial and
renamed-marker cases exercise handle-bound cleanup after simulated pre-pin
failures. Real-flush fixture lifetimes are serialized within this test module
to keep its stress case from consuming another case's fixed cooperative scan
budget. The TypeScript inventory tests use explicitly synthetic binary records and
exercise ordinary access plus negative stage/alias access through model
filesystem consumers.

Those receipts prove the exercised index algorithm and macOS mechanisms. They
are not full Node-API prepared-write, journal/resume, metadata-application or
publication crash receipts; they do not establish Linux/Windows private-policy
behavior, all supported architecture/libc targets or machine-power-loss
durability. Each enabled profile still needs the native lifecycle and
exact-artifact evidence required below.

## Native component and delivery

The selected component is a first-party Rust/Node-API adapter with a TypeScript
host loader, isolated from shared/core/LLM provider interfaces. Approved direct
Rust dependencies are `napi`/`napi-derive` (Node-API bridge), build-only
`napi-build`, POSIX-only `libc` and Windows-only `windows-sys` (OS bindings).
Use a minimal explicit feature set targeting **Node-API 8**, bounded worker
tasks and no Tokio/network/process runtime. Feature/transitive closure is
reviewed, not inferred from the direct list. Before native implementation,
record exact compatible versions/features and the Rust toolchain in
[tech-stack.md](../../tech-stack.md)'s dependency records and the native
manifest/lockfile; audit licenses, advisories, unsafe FFI and build inputs.
Apply principle 9a's default publish-age review posture explicitly to direct
and transitive crates, with recorded provenance and any justified exception.
Node-API 8 is a conservative sufficient ABI choice; Node-API 9 also supports
Node 22.0.0. Do not claim version 9 raises that floor; version 10 requires a
newer 22.x runtime. ABI compatibility still needs exact-floor execution.
Additional direct dependency families need a decision rather than this
decision's blanket approval. Native errors are converted to fixed typed host reasons.
No metadata-dependent product code is accepted before ADR-0125 acceptance.

The required finite build and native-execution matrix is:

| Platform | Node architecture / libc | Rust targets |
|---|---|---|
| macOS | x64 and arm64 | `x86_64-apple-darwin`, `aarch64-apple-darwin` |
| Linux | x64 and arm64, glibc and musl separately | `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl` |
| Windows | x64 and arm64, MSVC | `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc` |

This is a delivery obligation, not evidence that the CLI's other
native dependencies or CI currently support every row. Establish the minimum
OS/libc deployment baselines with the existing dependency support before
building; do not bind glibc binaries only to the newest CI image. The current
four installed-consumer legs (`current-linux`, `current-macos`,
`current-windows` at the repository's current Node, and `minimum-linux` at exact
Node 22.0.0) remain mandatory and do not prove this expanded
matrix. Every enabled target needs native execution and exact-artifact receipts;
cross-compilation alone is insufficient. Unavailable target support is an
explicit blocker to resolve, not permission to narrow advertised support.

This is the new adapter's eight-target obligation, not a retrospective whole-CLI
architecture list. Keyring also publishes FreeBSD x64, Windows ia32 and Linux
arm/riscv packages; that dependency catalog alone does not certify CLI support.
Do not introduce a new eager addon gate on existing meta/read-only behavior
outside this matrix where the CLI's other dependencies work. An unavailable
adapter refuses the requested prepared write. SQLite, keyring and this adapter
are three native components: exact-artifact consumers must exercise coexistence,
without claiming that keyring availability proves SQLite or adapter availability.

Build precompiled assets and bind each asset to reviewed source, lockfile,
toolchain, target and fixed loader inventory. Preserve the public **Node
22.0.0** runtime floor; this adapter must add no installed-user compiler or
install/runtime download requirement. Existing `better-sqlite3` uses
`prebuild-install || node-gyp rebuild --release`; keyring uses optional native
npm packages. No CLI-wide no-download/no-compile proof is claimed. The stricter
bundled-asset choice for this first-party component keeps its selected bytes
inside the source-bound CLI artifact rather than another install-time fetch.
Workspace
installation's separate Node 22.13.0 floor must not replace that proof. Bundle trusted
assets in the CLI artifact, select only from fixed platform identifiers and
reject missing/mismatched assets. Never search PATH/workspace, honor a model
library path, compile/download at runtime, or silently narrow release support.
Native contributor setup and CI are distinct from user installation. Extend
the [packaging contract](packaging.md) on acceptance, including exact-artifact
installed consumers and ABI/native-execution evidence.

Primary mechanism boundaries: [Node-API ABI/version support](https://nodejs.org/api/n-api.html),
[bridge feature declarations](https://github.com/napi-rs/napi-rs/blob/main/crates/napi/Cargo.toml),
[Microsoft replacement semantics](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)
and [Linux xattr enumeration](https://man7.org/linux/man-pages/man2/listxattr.2.html).
These inform the decision; no native feasibility or security acceptance is claimed.

## Initial dependency audit

On 2026-11-12, two reviewers independently checked the exact registry versions,
checksums, publish dates, yanked status and licenses in the initial
[Cargo lockfile](../../../apps/cli/native/fs-metadata/Cargo.lock). Its SHA-256 is
`dd5b3adef08c0efa68c91cc733a50f7163afa751cb6cf4c3035da65c41ad7a63`.
The [manifest](../../../apps/cli/native/fs-metadata/Cargo.toml) and
[toolchain file](../../../apps/cli/native/fs-metadata/rust-toolchain.toml) own
the exact direct pins, target features and compiler choice. The bridge uses
Node-API 8 with default features disabled; the resolved all-target closure has
no Tokio or futures runtime. The Windows-only `napi-sys` dynamic symbol loader
uses the current process, not a model-selected library.
The `windows-sys` threading and security-authorization features were added to
the reviewed binding set for effective-token, file-security and SID operations;
they add no crate family or lockfile entry.

All 19 registry entries were unyanked and more than 14 days old at review.
Their license expressions are MIT, Apache-2.0, ISC and Unicode-3.0 variants;
the exact expressions and checksums are those reported by crates.io for the
locked versions. A batch query to OSV for every exact crate/version returned
no matches. This is an advisory-database observation, not proof of the absence
of vulnerabilities or a substitute for native source and unsafe-FFI review.
Crates.io identifies the bridge and build crates with the napi-rs repository,
`libc` with rust-lang/libc, and `windows-sys` with microsoft/windows-rs. The
lockfile and this receipt must be re-reviewed together on any dependency change.
The bundled [third-party notices](../../../apps/cli/native/fs-metadata/THIRD_PARTY_NOTICES.txt)
include the actual license and copyright texts from the locked crate archives;
where napi-rs archives omit the repository license, the notices identify the
exact archive-recorded source commit and retrieved license hash. The initial
notices SHA-256 is `d510559e31131e1d8a45eb7f9e6b4414d65a4d8fa58e2d2fadaa87f6f1fb1553`.

The initial local build exposed only a protocol-version stub. On macOS arm64,
isolated tests of a private metadata-copy helper reapplied captured quarantine
bytes and checked one synthetic deny-ACL fixture. These are mechanism probes,
not filesystem-profile, ABI, publication or packaging acceptance on any target.

## Baseline reproduction

Run `node tools/native-fs/metadata-policy-probe.mjs` from the repository root
on non-root macOS. The [tracked developer probe](../../../tools/native-fs/metadata-policy-probe.mjs)
uses fresh private fixtures and fixed OS-tool argv, cleans its own tree and
reports booleans, not native paths or raw metadata. It deliberately exercises
historical Node algorithms, not `FsCapability`, the new adapter or Windows.

On 2026-11-12, root independently reran it on macOS arm64, Node 22.23.1,
libuv 1.52.1, non-root uid 501. Fixture verification, direct-append denial and
exact replacement bytes passed. Replacement and separate `copyFile` each
dropped the deny ACL, quarantine and custom xattr (`true` for all six drop
observations). No successful flags test, other filesystem, complete-host test
or native adapter acceptance is inferred. The original inline probes were
temporary OS/algorithm experiments; this tracked script supplies reproducibility.

## Acceptance evidence

- Real ACL deny-write/append negatives: unchanged bytes/metadata, zero
  publication and no pre-approval staging; readable source alone is insufficient.
- Real ACL, quarantine/custom-xattr and supported flag positives on macOS;
  corresponding ACL/xattr/label profiles on Linux and descriptor/stream cases on
  Windows, including `Zone.Identifier`. Preserve or explicitly refuse, never silently drop.
- Concurrent metadata-only changes, stale/replaced identity, attribute-limit
  refusal, unavailable inspection/copy/verification and native partial failures.
- Actual private staging access controls, including a restrictive source ACL
  with mode0644 and a destination with broader default inheritance.
- New-file no-clobber race, exact prepared bytes, actual-producer cancellation,
  owned cleanup and no native metadata in any excluded sink.
- All overwrite/new/append/edit durable claim/publication/settlement crash cuts;
  prepared/ambiguous rows stop provider/node execution, valid committed evidence
  replays without another native preparation/publication, sessions never replay.
- OS-derived new-file policy equivalence and parent-policy-only changes, plus
  killed-stage recovery, bounded inventory exhaustion, concurrent cleanup claims
  and live/reused/unknown-owner preservation under ordinary non-root credentials.
- Native build/ABI/packaging, three-component coexistence and adapter-specific
  no-compile/no-extra-download installed-consumer tests on the
  supported targets, with no missing-target fallback or reduced existing gate.
- Fresh complete affected reviews and a separate native security sitting. A
  successful Rust build, ABI claim or TypeScript mock is not native acceptance.

## macOS local APFS implementation profile — integration acceptance pending

The draft macOS profile admits local APFS volumes whose descriptor-bound volume
capabilities explicitly report extended-security support. It refuses other
filesystems and any failed or unsupported inspection. Source access is proved
with a nontruncating effective `O_WRONLY` or `O_APPEND` open; source identity,
size, version, owner, group, mode, flags, ACL and attributes are rechecked.
An absent ACL is accepted only when the volume capability is supported and
`fstatx_np`/`filesec_query_property` report no ACL; an unreadable or unsupported
ACL is never treated as empty. ACL representations are opaque and bounded to
64 KiB; the OS applies them without an in-house ACL evaluator.

The exact attribute allowlist is `com.apple.quarantine`,
`com.apple.provenance`, and nonempty names under `user.*`. Values are preserved
and verified byte-for-byte, including provenance: inability to reproduce it
refuses. Unknown Apple or other namespaces, including content-bound metadata,
refuse. Enumeration is bounded to 16 KiB of names, 128 attributes, 64 KiB per
value and 1 MiB of names and values in total. Only `UF_NODUMP` and `UF_HIDDEN`
are supported flags; immutable, append-only, compressed, restricted and unknown
flags refuse. Private directory owner, mode and ACL checks remain mandatory even
when those two benign flags are present.

The profile copies OS metadata into the pinned empty stage, restores supported
flags with descriptor-bound `fchflags` when necessary, reapplies quarantine and
verifies the exact source and stage policy after content writing. It does not
restore old mtime or ctime after writing new content. New-file security policy
comes from an empty `0666` template created in the actual parent and moved into
the private stage before bytes. The parent policy, effective credentials and
creation mask are rechecked; `getumask` is used when available, otherwise the
trusted CLI owns and joins a fixed child mask query. The target mode is never
derived from the private directory. Local macOS controls exercised both supported
flags with ACL, quarantine and two opaque `user.*` values through actual
publication, and refused immutable, append-only, unknown flags and unknown
attribute namespaces. These controls do not certify untested filesystems,
system MAC policy, SACLs, other targets or the remaining acceptance gates.
Apple documents the relevant [file flags and `fchflags`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fchflags.2.html)
and [descriptor-bound metadata copying](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/copyfile_state_set.3.html).

## POSIX creation-mask boundary

The draft macOS and Linux profiles refuse during read-only parent preparation
when the effective umask masks any owner permission (`mask & 0700 != 0`). This
keeps private index and stage creation from producing inaccessible artifacts.
It is a closed profile refusal, not a change to the parent process's umask.
For admitted masks, the destination template is created by the kernel with mode
`0666` in the actual parent; private staging permissions do not substitute for
that inherited policy. Local macOS child-process controls exercised `0022`,
`0077` and `0002` against direct creation, including inherited ACLs, and
confirmed that `0777` refuses before private-stage creation. The same owned
child mask and default-ACL matrix passed as a non-root user in the Linux arm64
glibc 2.28 and musl 1.2.5 containers. These local controls do not establish the
required platform-matrix acceptance.

The native producer pins an empty indexed stage before applying existing-file
metadata. Test-only barriers stop an owned child during metadata application or
after half the payload; the parent kills and joins that child, checks the
unchanged old target or absent new target, and invokes actual native recovery.
These native-unit cuts passed locally on macOS arm64 and as a non-root user in
Linux arm64 glibc 2.28 and musl 1.2.5 containers. They complement the separate
WorkflowEngine claim/publication/settlement crash tests; they are not a
mid-native whole-workflow crash test. The barriers and their environment
lookups are excluded from release builds. Windows native execution and the
remaining platform acceptance matrix remain required.

## Linux local implementation profile — integration acceptance pending

The candidate profile in `src/linux.rs` is descriptor-bound and limited to
local ext4, XFS and overlayfs. Network filesystems, unsupported inode-flag
queries and unknown filesystem types refuse. The interface is internal to the
native component; this section does not enable a model capability or certify
the complete producer, recovery, Node ABI or CLI artifact.

- Preserve uid/gid, ordinary mode bits, kernel POSIX access ACL bytes,
  `security.selinux` and opaque `user.*` attributes. Parent policy also captures
  the kernel default ACL and setgid/group state. Special/privilege-bearing
  regular-file mode bits and all other observed attribute namespaces refuse.
  `security.capability`, `security.ima` and `security.evm` are explicit refusal
  cases. Inaccessible privileged attributes are not claimed absent.
- Bound enumeration to 64 KiB of names, 128 attributes, 64 KiB per value and
  1 MiB of names/values in aggregate. Explicit known-policy reads distinguish
  `ENODATA` from access or unsupported inspection; an empty enumerated list is
  not an ACL-absence proof. The kernel interprets/applies ACLs; no ACL evaluator
  is implemented in Relavium.
- Preserve `SYNC`, `NODUMP`, `NOATIME` and `NOCOW`; apply these only to an empty
  stage before payload and verify afterward. Extent layout and indexed-directory
  flags are OS-managed exceptions. Observe parent `DIRSYNC` as creation policy.
  Immutable/append-only flags deny replacement, including append implemented
  by replacement; all remaining observed flags refuse. Old mtime/ctime are
  not copied onto the new bytes.
- Actual `O_WRONLY`/`O_APPEND` opens without truncation prove effective source
  admission, bound to its descriptor identity/version. Recheck source policy,
  uid/gid/supplementary groups and mask. Read the mask from bounded
  `/proc/self/status`, without temporarily changing the process-wide mask.
- Derive new-file policy by kernel creation of an **empty** reserved-name file
  directly in the real parent at requested mode `0666`, then move that same
  inode into private staging before payload. Compare its OS-derived policy
  after the move and after content writing; revalidate the actual parent and
  credentials/mask around derivation and publication. Private staging's own
  inherited policy never substitutes for the destination's policy.
- Use descriptor-relative `renameat` for replacement and the Linux
  `renameat2(RENAME_NOREPLACE)` syscall for creation. The direct libc syscall
  binding also serves musl, which has no corresponding libc wrapper at the
  selected floor. No link/unlink emulation or in-place fallback is used.
  A racing target remains intact; unanticipated publication errors retain
  uncertainty through the existing effect journal.

Six source-profile tests exercise exact ACL/custom-xattr/NODUMP preservation,
effective write/append denial, metadata-only changes, real-parent default ACL
inheritance, new-file success/no-clobber and linked-stage/privilege-bit refusal.
Initial native arm64 execution on both selected GNU and musl images used
Rust 1.98.0 and ordinary non-root users. This is OS-profile test evidence, not
eight-target, native-producer, power-loss or installed-consumer acceptance.

Primary behavior references: [kernel ACL inheritance and mode correspondence](https://man7.org/linux/man-pages/man5/acl.5.html),
[xattr enumeration visibility](https://man7.org/linux/man-pages/man2/listxattr.2.html),
[inode flags](https://man7.org/linux/man-pages/man2/ioctl_iflags.2.html),
[non-mutating Linux mask observation](https://man7.org/linux/man-pages/man5/proc_pid_status.5.html)
and [atomic replacement/no-replace semantics](https://man7.org/linux/man-pages/man2/rename.2.html).

## Windows local NTFS implementation profile — native execution pending

The first Windows implementation is confined to fixed local NTFS volumes with
persistent ACLs and named streams. It does not enable a Node-API write profile
until real Windows native/ABI/installed-consumer execution and the separate
security gate pass. A Rust Windows cross-target type check supplies no OS or
publication receipt. Filesystems, remote shares, reparse objects, multiple hard
links and unsupported attribute/metadata observations refuse.

The closed caller-visible policy is owner SID, primary-group SID, DACL bytes
and protection/automatic-inheritance controls. It inspects the caller-readable
mandatory-label descriptor and refuses an explicit label; privileged audit
SACLs and labels withheld by Windows are outside the preservation claim. It
uses the filesystem-specific `GetSecurityInfo`/`SetSecurityInfo` APIs, not
`SetKernelObjectSecurity` (which Microsoft explicitly excludes for filesystem
objects). A required owner/group assignment that ordinary credentials cannot
perform refuses. DACL copying must pass exact native policy comparison before
and after payload copying; unsupported inheritance transformations refuse.
No ACE permission evaluator or inheritance merger is implemented.

Supported file attributes are archive, hidden, system, not-content-indexed and
the normal-file marker. Read-only, compression, encryption, sparse, reparse,
recall/offline, integrity/pinning and all other flags refuse. Archive marking,
creation/access/write/change timestamps, the replacement inode/file ID, USN
journal entries and filesystem allocation are OS-managed publication effects;
the profile does not promise to reproduce them. Source write/change time,
size, identity, attributes, policy, streams and effective-token identity are
rechecked before publication. `ReOpenFile` requests `FILE_WRITE_DATA` for
replace/edit or `FILE_APPEND_DATA` for append against the captured object,
without truncation. Parent delete authority cannot substitute for this check.

A bounded `BackupRead` inventory processes at most eight headers, names of at
most 512 bytes and a single `Zone.Identifier:$DATA` stream of at most 64 KiB.
The unnamed data stream is skipped with the OS stream seek operation. Unknown
ADS, extended-attribute records, object-ID/property/reparse/other backup stream
types, unsupported stream flags, incomplete enumeration and oversized metadata
refuse. `Zone.Identifier` bytes are copied exactly to a fresh stream on the
pinned stage, then enumerated and compared; there is no merge/conflict rule.
Security descriptors are bounded to 64 KiB and normalized native paths to
32,767 UTF-16 code units. Every failure crossing the host boundary is a fixed
reason, never a stream name/value, SID/ACL, path-bearing native error or handle.

Staging directories are created with an OS-built, protected sole-current-user
DACL and verified through their opened identities before payloads exist.
Private files inherit that sole-user policy and are verified before copying.
For new-file inheritance, Windows creates a fresh empty file directly in the
actual destination parent with default security attributes, then one
handle-bound, same-volume rename moves that same empty inode into the private
stage. The inherited policy is captured and compared before payload and after
copying. The common producer must reserve/protect both staging names and pin
recovery ownership before any payload; these hooks alone do not establish the
cross-process model-authority exclusion or crash-recovery contract.

Publication dispatches exactly one
`SetFileInformationByHandle(FileRenameInfoEx)` operation, using the pinned
stage handle, destination-parent handle and a validated single basename.
Existing-file publication uses only replace-if-exists plus POSIX semantics;
new-file publication sets no replacement flag. There is no `ReplaceFileW`,
backup-name dance, unlink/copy sequence, ignore-readonly/ignore-ACL flag,
in-place fallback or automatic retry. A failed dispatched operation remains
possibly-published in the durable effect ladder. That classification does not
certify compatibility: real Windows controls must establish unchanged old
bytes/namespace for the selected mechanism's documented failures before the
profile is enabled, including competing new-file creation, read-only and
directory targets and sharing/permission failures. Open old handles must retain
the old object on successful replacement. Power-loss durability is a separate
claim and is not established by these API selections.

The module includes Windows-only positive/negative controls for ACL denial of
write and append, owner/group/DACL and Mark-of-the-Web preservation, exact new
bytes, unknown/oversized streams, metadata-only and parent-policy changes,
comparison with direct OS new-file inheritance, no-clobber and selected
publication failures. On 2026-11-12 its source and test bodies typechecked with
Rust 1.98.0 for `x86_64-pc-windows-gnu` in an isolated harness using the locked
`windows-sys` version/features. Those tests have not run on Windows at this
receipt. The complete addon's local Windows cross check stopped at napi-build's
required Windows `libnode.dll`; no complete Windows bridge build is claimed.
`FILE_ID_INFO` supplies the native 128-bit identity; the separate Node guard
witness uses the NTFS volume serial and 64-bit file index. Compare it with actual
Node bigint `stat`/`fstat` on both supported Node floors before enabling it.

Primary mechanism sources: [file security and creation/inheritance](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights),
[SetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo),
[SetKernelObjectSecurity's filesystem exclusion](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-setkernelobjectsecurity),
[handle-bound rename structure/flags](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information),
[BackupRead](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-backupread),
[BackupSeek](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-backupseek),
and [libuv's Windows stat assignment](https://github.com/libuv/libuv/blob/v1.52.1/src/win/fs.c).
They justify the mechanism candidates and closed bounds, not profile acceptance.
