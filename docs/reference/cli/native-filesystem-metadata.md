# Native filesystem security metadata

- **Status**: Proposed; unimplemented.
- **Owner ADR**: [ADR-0125](../../decisions/0125-file-writes-preserve-security-metadata-through-a-native-host-adapter.md).
- **Surface**: CLI host only; [prepared writes](../shared-core/tool-registry.md#proposed-prepared-writes-and-live-previews--mvp-3) and [packaging](packaging.md).

This is the canonical proposed metadata boundary for prepared replace, append
and edit. It does not certify the current mode/uid/gid-only prototype. Approval
of its owner ADR is required before native implementation or package changes.

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

## Private staging and publication

Preparation creates no directory, temporary file or writable effect. After
approval and durable admission where required, create same-filesystem private
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

New files inherit the documented destination creation policy; existing files
keep their supported policy. Missing native support is not an implicit grant
for mode-only or in-place writing. Read-only tools and CLI meta paths remain
available without eagerly loading a native write component.

## Native component and delivery

The proposed component is a first-party Rust/Node-API adapter with a TypeScript
host loader, isolated from shared/core/LLM provider interfaces. Proposed direct
Rust dependencies are `napi`/`napi-derive` (Node-API bridge), build-only
`napi-build`, POSIX-only `libc` and Windows-only `windows-sys` (OS bindings).
Use a minimal explicit feature set targeting **Node-API 8**, bounded worker
tasks and no Tokio/network/process runtime. Feature/transitive closure is
reviewed, not inferred from the direct list. Before native implementation,
record exact compatible versions/features and the Rust toolchain in
[tech-stack.md](../../tech-stack.md)'s dependency records and the native
manifest/lockfile; audit licenses, advisories, unsafe FFI and build inputs.
Additional direct dependency families need a decision rather than this
proposal's blanket approval. Native errors are converted to fixed typed host reasons.
No metadata-dependent product code is accepted before ADR-0125 acceptance.

The proposed finite build and native-execution matrix is:

| Platform | Node architecture / libc | Rust targets |
|---|---|---|
| macOS | x64 and arm64 | `x86_64-apple-darwin`, `aarch64-apple-darwin` |
| Linux | x64 and arm64, glibc and musl separately | `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl` |
| Windows | x64 and arm64, MSVC | `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc` |

This is a proposed delivery obligation, not evidence that the CLI's other
native dependencies or CI currently support every row. Establish the minimum
OS/libc deployment baselines with the existing dependency support before
building; do not bind glibc binaries only to the newest CI image. The current
four installed-consumer legs remain mandatory and do not prove this expanded
matrix. Every enabled target needs native execution and exact-artifact receipts;
cross-compilation alone is insufficient. Unavailable target support is an
explicit blocker to resolve, not permission to narrow advertised support.

Build precompiled assets and bind each asset to reviewed source, lockfile,
toolchain, target and fixed loader inventory. Preserve the public **Node
22.0.0** runtime floor and installed-user compiler-free promise; workspace
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
These inform the proposal; no native feasibility or security acceptance is claimed.

## Acceptance evidence

- Real ACL deny-write/append negatives: unchanged bytes/metadata, zero
  publication and no pre-approval staging; readable source alone is insufficient.
- Real ACL, quarantine/custom-xattr and supported flag positives on macOS;
  corresponding ACL/xattr/label profiles on Linux and descriptor/stream cases on
  Windows. Preserve or explicitly refuse, never silently drop.
- Concurrent metadata-only changes, stale/replaced identity, attribute-limit
  refusal, unavailable inspection/copy/verification and native partial failures.
- Actual private staging access controls, including a restrictive source ACL
  with mode0644 and a destination with broader default inheritance.
- New-file no-clobber race, exact prepared bytes, actual-producer cancellation,
  owned cleanup and no native metadata in any excluded sink.
- Native build/ABI/packaging and compiler-free installed-consumer tests on the
  supported targets, with no missing-target fallback or reduced existing gate.
- Fresh complete affected reviews and a separate native security sitting. A
  successful Rust build, ABI claim or TypeScript mock is not native acceptance.
