# ADR-0125: File writes preserve security metadata through a native host adapter

- **Status**: Accepted
- **Date**: 2026-11-12
- **Related**: [ADR-0006](0006-os-keychain-for-api-keys.md), [ADR-0018](0018-desktop-execution-and-rust-egress.md), [ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md), [ADR-0111](0111-cli-meta-operations-use-a-lazy-packaged-runtime.md), [ADR-0121](0121-pre-1-0-releases-publish-the-smoke-verified-package-test-tarball.md), [ADR-0011](0011-internal-llm-abstraction.md), [ADR-0019](0019-cli-node-keychain-library.md), [ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md), [ADR-0067](0067-node-supported-floor-22-reaffirm-better-sqlite3.md), [ADR-0105](0105-filesystem-roots-are-invocation-grants-not-project-authority.md), [ADR-0120](0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md), [ADR-0124](0124-inspect-retained-run-effects-before-file-preparation.md), [architectural principles](../standards/architectural-principles.md), [metadata contract](../reference/cli/native-filesystem-metadata.md), [CLI packaging](../reference/cli/packaging.md)

## Context

Prepared replace/append/edit calls need atomic publication of exactly the
reviewed bytes. A replacement inode does not automatically preserve the old
file's ACL, extended attributes or flags. The current prototype preserves
mode/uid/gid only. Node's public filesystem API does not supply the complete
metadata inspection and preservation boundary needed to prove more.

Separate source review and OS/algorithm probes reproduced a concrete macOS
hazard on an ordinary non-root account: a readable file with an ACL denying
write/append rejected direct append, while the mode/uid/gid/temp/rename algorithm
used by the prototype succeeded and removed its ACL, quarantine and a custom
extended attribute. Node `copyFile` also lost those attributes. The tracked
[developer probe](../../tools/native-fs/metadata-policy-probe.mjs) makes that
baseline reproducible. These are OS/algorithm observations, not execution of
the complete `FsCapability`, the new adapter or Windows; the
[evidence receipt](../reference/cli/native-filesystem-metadata.md#baseline-reproduction)
keeps those limits explicit.

The historical overwrite already used temp/rename without comprehensive metadata
preservation; append retained the existing inode. That history neither grants
permission to bypass a file's write restrictions nor makes metadata loss safe.
The owner-controlled pathname-race profile concerns different actors and races;
it does not waive ACL or quarantine behavior.

Preserving atomicity and the defined access/security metadata requires an OS
boundary beyond the TypeScript host's current primitives. This decision therefore
required explicit maintainer approval for a narrowly scoped native-source/build exception,
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
  and policy wiring. This is a limited exception to the CLI TypeScript-only
  source rule (CLAUDE.md rule 1), not permission to move engine/tool policy into
  Rust or introduce an IDE/desktop surface. This narrowly
  supersedes [principle 2](../standards/architectural-principles.md#2-one-language--typescript)
  for this CLI component only; its forward note and agent guidance record the exception.
  Tauri/Rust has architectural precedent, but this checkout currently has no
  first-party Rust source/Cargo manifest; this adds that contributor toolchain.
- Use `napi`, `napi-derive` and build-only `napi-build`, with `libc` on POSIX and
  Microsoft's `windows-sys` on Windows. These direct dependency families and
  their minimal necessary feature/lockfile closure are the approved exception;
  approval is not permission to add arbitrary native dependencies. The
  [metadata contract](../reference/cli/native-filesystem-metadata.md#native-component-and-delivery)
  bounds the ABI, targets and pre-implementation pin/audit gate. Wrap OS ACL/access primitives; never implement ACL
  evaluation, security-descriptor algorithms, crypto or key handling ourselves.
  No new external runtime npm package is required by this design, but compiled
  native code and linked Rust dependencies are runtime components and are in
  the approval/review scope.
- Apply the dependency cooling/review posture in
  [principle 9a](../standards/architectural-principles.md#9a-dependency-bump-cooling-window)
  explicitly to Cargo inputs: record provenance, publish age, licenses,
  advisories, feature/transitive closure and justified exceptions before pins
  enter a native lockfile. The package.json-specific check is not evidence that
  Cargo already has this enforcement.
- Journal **every built-in `write_file` call at tier 3**, including overwrite,
  new files, empty/unchanged content and append; `edit_file` remains tier 3.
  Final bytes alone are not a receipt for inode/security-metadata publication.
  This partially supersedes ADR-0080's overwrite exclusion and ADR-0124's
  overwrite hot path. Reuse their existing journal, strict retained evidence,
  early inspection, resume gate and session non-replay; add no adapter-owned
  effect journal. No preparation/approval refusal creates a row. Once admitted,
  uncertainty remains durable and blocks resume before node execution; a valid
  committed run result may be delivered without another native write. Missing
  journal wiring refuses mutation, including embedding/test consumers.
- Preparation remains read-only: inspect a genuine source identity, capture
  the supported security metadata and ask the OS whether the effective caller
  may perform this operation's data write or append.
  A writable directory does not override a file's write/append denial. Bind
  metadata and bytes to the same observed source version and revalidate before
  publication, with an operation-appropriate, non-truncating native write/append
  admission during execution. A generic permission query alone is insufficient
  evidence that filesystem access policy permits the actual operation. Metadata
  never becomes a model-controlled authority token.
  A Node non-truncating open can supply that access check; native metadata
  capture/preservation, not unique possession of `open`, motivates this adapter.
- Existing-file publication preserves the supported owner/group/mode and
  access-control policy, plus supported extended metadata. Use platform-native
  preserving operations where their contract is sufficient; their merge/error
  flags must not permit ignoring ACL or metadata failures. Unsupported,
  unreadable, changed or unverifiable metadata refuses rather than guessing.
  The profile explicitly distinguishes caller-visible attributes, OS-managed
  changes and privileged/invisible metadata; it makes no universal claim about
  metadata the OS does not expose to the caller.
  Inability to preserve owner/group under ordinary caller credentials refuses;
  content approval does not authorize ownership normalization or dropping
  `com.apple.quarantine`/Windows `Zone.Identifier`.
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
- New files follow an OS-derived, per-platform destination creation profile,
  with parent identity/default policy, caller credentials and creation mask
  captured and revalidated. A private staging directory alone cannot supply
  destination inheritance; unsupported or detectably changed policy refuses.
  Staging is private before bytes are copied, remains inaccessible to identities
  outside the final authorized access policy and cannot overwrite a competing
  new file. Apply/verify final policy before publication; an existing restrictive
  ACL must not become a broader-readable temporary copy. Bound native work and
  retain/join actual producers across cancellation and teardown.
- Before named staging receives payload bytes, establish bounded, private
  crash-recovery evidence with pinned artifact/producer identities. Recovery
  deletes only proven orphan artifacts, preserves live/reused/unknown owners
  and never publishes or retries an uncertain operation. The canonical
  contract defines bounded discovery, ownership claims, retention boundaries
  and honest operator recovery when safe cleanup cannot be proven.
  Owner-only permissions are insufficient against same-account model tools:
  active/orphan stages and their path/object aliases must be excluded from
  model filesystem authority across hosts/processes, or placement refuses.
- The adapter owns no model tool registration, approvals, mode defaults,
  filesystem grants, read observations, database or network. It receives only
  trusted host operations after existing guards; opaque handles, raw ACLs,
  attributes and native errors remain host-local. Missing/mismatched native
  capability fails closed. Denial diagnostics contain fixed reasons only.
  Scope, symlink/hard-link, protected-path and confidentiality guards remain
  at the trusted TS/native boundary through final publication; native paths
  do not bypass them or infer grants. Metadata safety refusals are fatal,
  non-retryable and outside the closed text-edit correction vocabulary.
- Load the adapter lazily only for a policy-admitted prepared-write path or
  its owned-artifact recovery. Meta/read-only operations never require or
  eagerly load it. Missing support refuses the dependent write, not those paths.
- Preserve the current Node floor. For **this new adapter**, build
  reviewed prebuilt assets in CI and include/select them from the trusted CLI
  artifact so installing/using this component needs no compiler, install-time
  download or runtime compilation. Existing SQLite may download a prebuild or
  fall back to `node-gyp`; keyring uses optional platform npm packages. This
  stricter adapter-specific rule does not certify the entire CLI as download-
  or compiler-free. Do not search workspace/PATH for a helper or load a
  model/config-selected library.
  Extend artifact inventory, source bindings and installed-consumer proofs.
  The canonical target matrix is explicit, not a claim that today's
  four installed-consumer legs prove all architectures or libc variants.
  No advertised platform is silently removed; unsupported release targets must
  be resolved explicitly before release, not hidden by a fallback.
  The adapter is the third native component beside SQLite and keyring;
  exact-artifact consumers must prove coexistence. A dependency's extra target
  packages alone do not advertise whole-CLI support. Preserve other behavior
  outside the adapter matrix where existing dependencies work; unsupported
  prepared writes fail closed, with no mode/uid/gid-only fallback. The current
  unsafe, unaccepted prototype is not a compatibility obligation.
- This necessary foundation stays inside MVP-3 Step 2. Independent engine/UI
  work and native implementation may continue under the maintainer-approved
  corrected decision; implementation acceptance remains open. Full native and packaging checks, fresh reviews
  and a separate native security sitting precede enabling the Step 3 grant.
  Freeze each concrete metadata/publication allowlist and bounds before its
  production profile is enabled or accepted; isolated mechanism experiments
  do not themselves accept a profile.
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

> Implementation checkpoint 2026-11-12: the [Step 2 acceptance](../roadmap/phases/phase-2.6-conversational-authoring.md#mvp-3-step-2-acceptance-2026-11-12) records the implemented adapter, actual eight-target execution, Windows integration and four installed-consumer proofs, independent security sittings and passing 26-job checkpoint CI at `bc8c34b2`. The [metadata contract](../reference/cli/native-filesystem-metadata.md) retains the exact supported profiles and refusal limits. The whole-MVP-3 PR requires its own current-head CI and maintainer review; no npm publication is authorized.
