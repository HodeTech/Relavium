# Native filesystem security metadata

- **Status**: Accepted design; native implementation unimplemented.
- **Owner ADR**: [ADR-0125](../../decisions/0125-file-writes-preserve-security-metadata-through-a-native-host-adapter.md).
- **Surface**: CLI host only; [prepared writes](../shared-core/tool-registry.md#proposed-prepared-writes-and-live-previews--mvp-3) and [packaging](packaging.md).

This is the canonical accepted metadata boundary for prepared replace, append
and edit. It does not certify the current mode/uid/gid-only prototype. The maintainer authorized the corrected decision after supplied review
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
