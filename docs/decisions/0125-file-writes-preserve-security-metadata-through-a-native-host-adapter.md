# ADR-0125: File writes preserve security metadata through a native host adapter

- **Status**: Proposed
- **Date**: 2026-11-12
- **Related**: [ADR-0011](0011-internal-llm-abstraction.md), [ADR-0019](0019-cli-node-keychain-library.md), [ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md), [ADR-0067](0067-node-supported-floor-22-reaffirm-better-sqlite3.md), [ADR-0105](0105-filesystem-roots-are-invocation-grants-not-project-authority.md), [ADR-0120](0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md), [ADR-0124](0124-inspect-retained-run-effects-before-file-preparation.md), [architectural principles](../standards/architectural-principles.md), [metadata contract](../reference/cli/native-filesystem-metadata.md), [CLI packaging](../reference/cli/packaging.md)

## Context

Prepared replace/append/edit calls need atomic publication of exactly the
reviewed bytes. A replacement inode does not automatically preserve the old
file's ACL, extended attributes or flags. The current prototype preserves
mode/uid/gid only. Node's public filesystem API does not supply the complete
metadata inspection and preservation boundary needed to prove more.

A separate source/security audit reproduced a concrete macOS regression on an
ordinary non-root account: a readable file with an ACL denying write/append
rejected the old in-place append, while the replacement prototype succeeded and
removed its ACL. It also removed quarantine and a custom extended attribute.
Node `copyFile` lost ACL/xattr state in the same experiment. These are actual
macOS observations, not claims about every filesystem or Windows execution.

The historical overwrite already used temp/rename without comprehensive metadata
preservation; append retained the existing inode. That history neither grants
permission to bypass a file's write restrictions nor makes metadata loss safe.
The owner-controlled pathname-race profile concerns different actors and races;
it does not waive ACL or quarantine behavior.

Preserving atomicity and the defined access/security metadata requires an OS
boundary beyond the TypeScript host's current primitives. This proposal therefore
needs explicit approval for a narrowly scoped native-source/build exception,
new compiled runtime component and its dependency/packaging work. It is not an
implementation-only clarification of ADR-0120.

## Decision

**Prepared filesystem writes will preserve the defined source security metadata.
Unsupported operations are refused before publication. A small first-party
Rust/Node-API host adapter will wrap established OS inspection, access-check and
replacement mechanisms. There is no metadata-reset or in-place fallback.**

The canonical metadata contract owns the precise supported profiles and gates;
the following decisions bound its implementation:

- Keep the shared/core engine and LLM provider seam platform-pure TypeScript.
  Native code belongs solely to a CLI host component, with TypeScript loading
  and policy wiring. This is a limited exception to the repository's
  TypeScript-only source rule, not permission to move engine/tool policy into
  Rust or introduce an IDE/desktop surface. On acceptance, this narrowly
  supersedes [principle 2](../standards/architectural-principles.md#2-one-language--typescript)
  for this CLI component only; append its forward note and update agent guidance.
- Use `napi`, `napi-derive` and build-only `napi-build`, with `libc` on POSIX and
  Microsoft's `windows-sys` on Windows. These direct dependency families and
  their minimal necessary feature/lockfile closure are the proposed exception;
  approval is not permission to add arbitrary native dependencies. The
  [metadata contract](../reference/cli/native-filesystem-metadata.md#native-component-and-delivery)
  bounds the ABI, targets and pre-implementation pin/audit gate. Wrap OS ACL/access primitives; never implement ACL
  evaluation, security-descriptor algorithms, crypto or key handling ourselves.
  No new external runtime npm package is required by this design, but compiled
  native code and linked Rust dependencies are runtime components and are in
  the approval/review scope.
- Preparation remains read-only: inspect a genuine source identity, capture
  the supported security metadata and ask the OS whether the effective caller
  may perform this operation's data write or append.
  A writable directory does not override a file's write/append denial. Bind
  metadata and bytes to the same observed source version and revalidate before
  publication, with an operation-appropriate, non-truncating native write/append
  admission during execution. A generic permission query alone is insufficient
  evidence that filesystem access policy permits the actual operation. Metadata
  never becomes a model-controlled authority token.
- Existing-file publication preserves the supported owner/group/mode and
  access-control policy, plus supported extended metadata. Use platform-native
  preserving operations where their contract is sufficient; their merge/error
  flags must not permit ignoring ACL or metadata failures. Unsupported,
  unreadable, changed or unverifiable metadata refuses rather than guessing.
  The profile explicitly distinguishes caller-visible attributes, OS-managed
  changes and privileged/invisible metadata; it makes no universal claim about
  metadata the OS does not expose to the caller.
- Preserve the accepted atomic byte-publication contract on every enabled
  filesystem profile. A preserving API is only a candidate until its success
  and error semantics meet that contract. In particular, Windows `ReplaceFileW`
  documents partial namespace failures: it is not an unconditional atomicity
  proof. Distinguish safe pre-publication refusal from possibly changed state
  after dispatch; the latter is non-retryable uncertainty with owned recovery,
  never a miss, harmless refusal or automatic retry. Uncertainty reporting does
  not authorize an otherwise incompatible publication primitive. A platform
  whose primitive cannot meet the contract remains blocked; weakening the
  atomicity promise requires a separate maintainer decision.
- New files follow the destination's documented creation/inheritance profile.
  Staging is private before bytes are copied, remains inaccessible to identities
  outside the final authorized access policy and cannot overwrite a competing
  new file. Apply/verify final policy before publication; an existing restrictive
  ACL must not become a broader-readable temporary copy. Bound native work and
  retain/join actual producers across cancellation and teardown.
- The adapter owns no model tool registration, approvals, mode defaults,
  filesystem grants, read observations, database or network. It receives only
  trusted host operations after existing guards; opaque handles, raw ACLs,
  attributes and native errors remain host-local. Missing/mismatched native
  capability fails closed. Denial diagnostics contain fixed reasons only.
- Preserve the current Node floor and compiler-free installed CLI. Build
  reviewed prebuilt assets in CI and include/select them from the trusted CLI
  artifact; do not download or compile native code during installation/runtime,
  search workspace/PATH for a helper, or load a model/config-selected library.
  Extend artifact inventory, source bindings and installed-consumer proofs.
  The canonical proposed target matrix is explicit, not a claim that today's
  four installed-consumer legs prove all architectures or libc variants.
  No advertised platform is silently removed; unsupported release targets must
  be resolved explicitly before release, not hidden by a fallback.
- This necessary foundation stays inside MVP-3 Step 2. Independent engine/UI
  work can continue, but native metadata-dependent implementation and acceptance
  wait for maintainer approval. Full native and packaging checks, fresh reviews
  and a separate native security sitting precede enabling the Step 3 grant.
  The npm release guard and final PR/maintainer merge boundary remain unchanged.

Considered and rejected: documenting silent mode/uid/gid-only loss (does not
prevent the reproduced ACL bypass); blind Node `copyFile` (does not preserve
the observed metadata); returning to in-place writes (weakens the accepted
atomic byte-publication contract); silently refusing all existing-file edits
(does not deliver MVP-3); and ad hoc shell/ACL parsing (adds tool/locale/identity
ambiguities without a reliable preserving boundary). A restricted profile with
real native inspection is possible, but still needs a native component and may
reject ordinary attributed files. The chosen adapter preserves the defined
ordinary-file profiles and refuses unsupported cases explicitly.

## Consequences

### Positive

- An approved content change does not silently waive the file's existing access
  restrictions or discard supported quarantine/attribute state.
- Atomic publication, exact prepared bytes and existing journal/approval floors
  remain; permission denial is not bypassed through directory rename authority.
- Platform policy remains at the host edge, using OS mechanisms with bounded
  lifetimes and independently testable failures.

### Negative

- A first-party native source/build/distribution surface is added. Rust/Cargo
  and platform build tools are contributor/CI prerequisites, not installed-user
  prerequisites. Pin and audit the bridge/bindings, isolate unsafe FFI, and
  extend source-bound native artifact checks rather than assuming ABI stability
  proves functionality or target support.
- Security metadata differs by OS/filesystem. Closed profiles, refusal on
  unsupported observations and actual native positive/negative controls bound
  the promise; no universal metadata or hostile-same-user isolation is claimed.
- Some protected, integrity-bound or unsupported attributed files must be
  refused. Those are explicit safety refusals, not permission to drop metadata
  or a silent downgrade to in-place editing.
- Step 2 grows to include native packaging and tests. The three product steps
  stay cohesive, with native/backend/UI authoring and review partitions. No
  feature is marked accepted merely because the TypeScript prototype passes.

Primary feasibility references: [Node-API](https://nodejs.org/api/n-api.html),
[napi-rs build/distribution guidance](https://napi.rs/docs/introduction/getting-started),
[Apple copyfile/fcopyfile](https://raw.githubusercontent.com/apple-oss-distributions/copyfile/main/copyfile.3),
and [Microsoft ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew).
These support the available mechanisms, not acceptance of an unimplemented
adapter or of an untested native target.
