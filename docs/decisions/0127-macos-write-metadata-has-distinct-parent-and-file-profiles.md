# ADR-0127: macOS write metadata has distinct parent and file profiles

- **Status**: Accepted
- **Date**: 2026-11-14
- **Accepted**: 2026-11-15, after the supplied reviews were reconciled under the maintainer's instruction.
- **Implementation**: Authorized and locally accepted on `development`, 2026-11-15; current-head platform/consumer/PR checks and maintainer merge remain separate gates.
- **Related**: [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md) (still Proposed), [ADR-0120](0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md), [ADR-0125](0125-file-writes-preserve-security-metadata-through-a-native-host-adapter.md), [ADR-0126](0126-native-write-admission-and-recovery-keep-explicit-lifetime-proof.md), [native metadata contract](../reference/cli/native-filesystem-metadata.md#macos-parent-and-file-attribute-profiles--adr-0127), [chat failure presentation](../reference/cli/chat-session.md#denial-guidance-design--adr-0127), [architectural principles](../standards/architectural-principles.md)

## Context

MVP-3 manual testing exposes a compatibility gap in the accepted macOS APFS
profile. The same native build accepts a clean temporary parent but refuses the
project root during read-only write preparation. The observed root has
`com.apple.macl` in addition to the supported provenance attribute. On
2026-11-14, previously created files in the reported temporary test workspace
also exposed `com.apple.lastuseddate#PS`, which the current file profile refuses.
This dated observation does not establish its presence on other files or at a
later inspection, or when or by which application either attribute was added.

The implementation uses one closed attribute allowlist for destination parents,
existing source files and new-file templates. A parent snapshot is evidence
about an object that remains in place; an existing-file snapshot supplies
metadata that must survive replacement. Treating those as the same role makes
an ordinary attributed parent unusable even though the adapter neither replaces
that parent nor needs to copy its label onto the child.

In a 2019 Catalina discussion, Apple DTS tentatively associated an observed
MACL with the questioner's inferred-consent example and called the UUID setup
an implementation detail. That observation is not a current binary-format or
inheritance specification. Apple's xattr APIs distinguish copying from safe
saving, but do not specify whether arbitrary consent labels can safely be
transplanted. Our conclusion is to avoid such transfers; it is a conservative
Relavium decision, not an Apple guarantee about MACL semantics.

On 2026-11-14, a bounded local mechanism probe found that the actual project
parent's MACL was readable and unchanged after creation of an empty temporary
child; that child exposed provenance only and was removed after measurement.
A separate synthetic `com.apple.lastuseddate#PS` value survived
`fcopyfile(COPYFILE_METADATA)` byte-for-byte without copying file content. The
[reproduction commands and dated output](../runbooks/verify-macos-write-metadata.md#mechanism-probes-recorded-2026-11-14)
retain this limited evidence. These observations do not establish end-to-end
adapter acceptance, actual user-interaction behavior, real MACL transfer support
or coverage of every macOS release.

## Decision

**Give parent inspection and replaceable-file preservation distinct closed
macOS profiles. Admit a readable, bounded parent MACL as opaque revalidation
evidence without copying it, and preserve the observed last-used attribute
exactly on files. Keep unsupported cases explicit.**

The [accepted design profile](../reference/cli/native-filesystem-metadata.md#macos-parent-and-file-attribute-profiles--adr-0127)
owns exact names, roles, limits and checks. The parent label remains on its
original directory. Its presence does not grant filesystem access, bypass an
OS check or supply a child label. New-file policy still comes from actual OS
creation in the destination parent, with no payload bytes before private
staging. A label on a source file or OS-created child is a different case:
without a supported preserving mechanism, that write still refuses. Acceptance
must prove this product limit as well as the supported parent case.

Admit the last-used name only for replaceable files, not parents. Its value is
opaque; its entire exact name, including the property suffix, stays intact.
The reference explains why Apple's `#PS` copy/save rules support preservation
of this exact name without granting authority to arbitrary attribute names.
For a new file, preserve only the value actually observed on its OS-created
empty template; never synthesize a value or copy one from the parent.

Do not parse MACL consent entries, manufacture consent, clear attributes, or
copy a parent label to a stage/target. Do not relax identity, ACL, credential,
mode, flag, version, permission, quarantine, provenance or unknown-attribute
checks. A changed, unreadable, oversized or unsupported observation refuses;
no metadata failure becomes an automatic retry or a text-edit correction.
The atomic publication, tier-3 journal, owned recovery and host-private metadata
boundaries of ADR-0125/0126 remain intact.

Runtime verification after publication is mandatory for the corrected macOS
profile. Before the joined native operation can return success, prove that the
named target is still the pinned payload object and verify its expected policy
and complete supported attribute set, together with the parent evidence. The
reference owns the exact proof and failure rules. After rename, an unavailable
or mismatched proof follows the existing possible-publication path; it cannot
become a pre-publication refusal, committed success, metadata repair or retry.
Do not substitute a test-only assertion for this runtime obligation.

Implementation acceptance requires all four operations (create, overwrite,
append and exact edit) through the CLI host under an observed OS-managed MACL
parent on real APFS, without changing that parent's label. Also require an
independent controlled create, real user interaction, attribute observation and
edit journey alongside the synthetic regression. Record additional unsupported
attributes as a product limit. Missing real evidence remains an open acceptance
gate rather than a synthetic pass or a claim of ordinary-use compatibility.

Correct the misleading chat recovery hint in the same increment because this
native refusal exposed a wrong user-facing remedy in ADR-0120's tool experience.
Under ADR-0057, mode and user rejections carry a private approval reason but the
same public `tool_denied` code as a host safety refusal. That reason is not a
typed field on the current turn-error presentation boundary. Choose one neutral
code-based hint, accepting the loss of a mode-specific shortcut in that generic
line. Keep `/mode` documented for an actual ask/plan restriction; it cannot
override a safety refusal. The [chat reference](../reference/cli/chat-session.md#denial-guidance-design--adr-0127)
owns the exact hint, fixed troubleshooting destination and safe-reason parity
across Home, standalone TUI and continuing plain chat. No message parsing,
new error code or raw native diagnostics are introduced. Pre-admission refusal
remains distinct from possible publication or unresolved effect evidence.

This is a refinement of ADR-0125's finite metadata mechanism, not a reversal of
preserve-or-refuse. The maintainer instructed acceptance after review correction
on 2026-11-15, while explicitly reserving implementation authorization. Append
a dated forward note to ADR-0125 and mark the reference as accepted design with
implementation pending; do not enable product behavior at this documentation
checkpoint. Add no dependency,
platform-specific engine import, public model capability, record format,
publication permission or Linux/Windows policy change.

Considered: clearing MACL or recommending broader OS permissions (rejected:
changes the user's security state); allowing all Apple attributes or using a
generic copy-intent decision as authority (rejected: admits unproven labels and
content-bound metadata); copying the parent label onto the child (rejected:
conflates directory consent with file creation); dropping last-used metadata
(rejected: unnecessary loss when exact preservation is available); and keeping
the current blanket refusal (rejected: blocks the observed ordinary project
workflow). In-place writes remain rejected under ADR-0125's atomicity decision.

## Consequences

### Positive

- The observed attributed project parent can support create, overwrite,
  append and edit while keeping its label intact and OS access checks active.
- A create/use/edit journey can preserve the observed last-used metadata
  instead of making the file uneditable merely because it acquired that name.
- Unsupported metadata receives honest recovery guidance without exposing
  native state or implying that auto mode can override filesystem safety.

### Negative

- File-level MACL and unlisted attributes remain unsupported. Prove refusal at
  pre-publication checks and honest uncertainty if first observed after rename;
  parent support must not be advertised as universal macOS compatibility.
- Strict parent and source comparisons may refuse concurrent OS metadata
  changes. Keep that conservative behavior; this decision grants no refresh,
  ignore-on-error or retry exception.
- Additional profile distinctions require real APFS native and host regression
  tests, fresh cumulative reviews and a separate native security sitting.
  Synthetic label fixtures alone cannot certify OS consent/inheritance behavior.
- Post-publication verification adds bounded native work and can report an
  unresolved effect after content already changed. Keep the tier-3 evidence and
  honest inspection guidance; no rollback or automatic repair is promised.

Primary references: [Apple DTS on inferred consent and MACL](https://developer.apple.com/forums/thread/124121?answerId=391281022),
[Apple's xattr intention/property definitions](https://github.com/apple-oss-distributions/copyfile/blob/main/xattr_flags.h),
[Apple's suffix and copy/save implementation](https://github.com/apple-oss-distributions/copyfile/blob/main/xattr_flags.c),
and [Apple's metadata copy interface](https://github.com/apple-oss-distributions/copyfile/blob/main/copyfile.3).

> **Amended 2026-11-15 after the maintainer-requested application comparison:**
> The [pinned source investigation](../analysis/macos-file-write-compatibility-2026-11-15.md)
> traces OpenCode 2.3.0 and Codex CLI 0.167.0 local writes to destination
> write/truncate operations rather than Relavium's private-stage replacement.
> Retaining the old inode explains why that route need not copy its ordinary
> metadata onto a replacement, but does not prove all OS-managed metadata is
> unchanged or provide the same byte-publication guarantee. Claude Code's
> inspected public docs/repository do not establish its core writer's MACL
> mechanism; do not assume parity from successful writes or configuration-file
> atomicity. Retain this decision's atomic contract, parent role correction and
> real-use evidence gates. Switching to in-place writes or an implicit fallback
> would reverse ADR-0125's chosen guarantee and needs a separate maintainer
> decision. Parent support is not universal file-MACL compatibility; an exposed
> ordinary-use limit must be reported before implementation acceptance. This
> documentation amendment does not grant the reserved implementation approval.

> **Amended 2026-11-15 after the further supplied reviews:**
> The [canonical file-role rule](../reference/cli/native-filesystem-metadata.md#macos-parent-and-file-attribute-profiles--adr-0127)
> now refuses every generic `user.*` name containing ASCII `#` before
> publication. The earlier unqualified preservation of the current prefix
> rule must not be read as admitting content-dependent, unknown or apparently
> benign property suffixes on replaceable files. Parent-only suffixed values
> remain bounded, opaque revalidation evidence, never child defaults. Exact
> quarantine preservation remains mandatory; a generic save-intent filter must
> not remove that security warning. Exact last-used admission remains separate.
>
> The post-rename size expectation is the completed pinned payload's byte
> length, proved against the reviewed output buffer before publication; it is
> not the empty template's size or the old source's size. The
> [chat diagnostic policy](../reference/cli/chat-session.md#denial-explanation-trust-and-output-policy)
> also corrects a prior assumption: `tool_denied` messages can contain an
> optional user-written rejection explanation. Preserve that experience with
> explicit diagnostic-output scope, finite redaction before producer limits
> and bounded untrusted display in Home/TUI/continuing plain, including redirected
> output. Do not call every explanation a fixed, universally secret-free host
> label. Producer redaction may change text in existing error/event fields;
> it changes no schema, approval authority or return-to-model policy.
>
> The generic hint originated in the 2.5.H `errorRecoveryHint` implementation;
> ADR-0120 is related tool-experience context, not the source of its `/mode`
> wording. The plain explanation line and public troubleshooting destination
> have explicit presentation/delivery checks. A supported before/after p50/p95
> [performance comparison](../reference/cli/native-filesystem-metadata.md#performance-evidence-before-implementation-acceptance)
> is required; no strategy is declared fastest without measurements. Reports
> of later reviewer probes remain attributed reports, not rewrites of the
> earlier author receipt. These refinements are accepted documentation only;
> implementation still waits for the maintainer's separate approval.

> **Implementation authorization — 2026-11-15:** the maintainer subsequently
> instructed "devam edelim", authorizing this corrected design's cohesive source
> increment and its planned verification/review cycle on `development`. Earlier
> approval-pending notes describe their historical documentation checkpoint.
> Authorization alone is not implementation, platform or release acceptance.

> **Implementation acceptance — 2026-11-15:** source commits `4dab2d28` and
> `b7ce337b` implement the accepted profile and diagnostic policy. Two independent
> review rounds, both verified first-round corrections, and a separate final
> security sitting are complete. The [final source checkpoint](../roadmap/phases/phase-2.6-conversational-authoring.md#adr-0127-final-local-source-acceptance-2026-11-15)
> owns executed checks, real-parent/editor observations, performance limits and
> remaining delivery gates. Earlier pending notes remain historical receipts.
