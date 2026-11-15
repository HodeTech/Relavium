# macOS file write compatibility across coding agents

- **Date**: 2026-11-15
- **Scope**: Read-only official documentation and pinned upstream source inspection; no model-driven writes or product implementation.
- **Related**: [ADR-0127](../decisions/0127-macos-write-metadata-has-distinct-parent-and-file-profiles.md), [ADR-0125](../decisions/0125-file-writes-preserve-security-metadata-through-a-native-host-adapter.md), [native metadata contract](../reference/cli/native-filesystem-metadata.md#macos-parent-and-file-attribute-profiles--adr-0127)

The maintainer asked why OpenCode, Codex and Claude Code can write where the
Relavium metadata profile refuses. The relevant comparison is the actual file
publication mechanism and its guarantees, not the names of the tools or modes.
This investigation informs the decision; it is not a replacement filesystem spec.

## Evidence boundary

Local version-only commands reported OpenCode `v2.3.0`, Codex CLI `0.167.0` and
Claude Code `2.1.311`. No agent prompt, provider request, credential read,
installation, update, configuration change or competitor file-writing test was
run. Those version strings identify the comparison targets, not binary/source
attestations or proof of the user's earlier successful writes.

OpenCode and Codex were traced at matching upstream release tags. The inspected
current development trees agreed on the relevant local writer behavior, but
release pins below are the primary evidence. Formatters, plugins, shell tools,
remote environments, desktop integrations and future releases can use other
paths. No universal claim about all writes in any product follows.

| Product/path | Pinned evidence | Observed mechanism | What remains unproved |
|---|---|---|---|
| OpenCode 2.3.0 local file tools | Release `v2.3.0`, commit `a6b15d33daf6ab7d35569f6d711fdb630b9f04e7` | Tool authorization and text mutation reach Node `fs.writeFile` on the destination path; the local override creates parents when missing. | Actual APFS metadata outcomes, every formatter/plugin/remote path, and arbitrary xattr preservation. |
| Codex CLI 0.167.0 `apply_patch` local backend | Release `rust-v0.167.0`, commit `086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a` | The patch layer uses the executor filesystem. Its direct backend writes through `tokio::fs::write`; its Unix no-follow backend opens a regular file, truncates it and writes through that handle. | Every Codex desktop/cloud/tool-runner backend, exact installed binary behavior and complete security-metadata preservation. |
| Claude Code | Official permissions/checkpoint docs and public repository at `14b7e6242e73bb41597a69f3fc7564d23ad429e7` | Edit/Write permission gates and file-history recovery are documented; the inspected public tree does not expose the core file-tool writer. | Whether model file writes in the local version use in-place, atomic replacement or a preserving OS mechanism. No verified per-attribute MACL guarantee was found in the inspected material. |

## OpenCode: trace the local write, not an older source layout

The current package layout differs from older examples under
`packages/opencode/src/tool`. At the pinned release,
the [write tool](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/tool/plugin/write.ts#L46)
calls `FileWrite.write`. The [edit tool](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/tool/plugin/edit.ts#L343)
constructs the replacement text after approval and calls the same commit path.
[FileWrite](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/file-write.ts#L83)
uses [FileMutation](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/file-mutation.ts#L114),
which serializes cooperating mutations and preserves the text BOM. Its
[local environment writer](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/environment/local.ts#L48)
ultimately calls `fs.writeFile(value, bytes)` without a temporary-file/rename
publication or a parent Apple-xattr allowlist in that binding. Formatting may
run afterward and must be considered separately.

Node's [write-file API and file-open flags](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromiseswritefilefile-data-options)
use the normal write/truncate behavior by default. For an existing ordinary
file, that is a content write to the existing filesystem object, rather than
substitution of a newly prepared inode. Inference: this avoids needing to copy
that object's ordinary metadata onto a replacement inode. It does not establish
that every attribute is preserved; OS-managed metadata may still change.

For a new file, the direct destination create lets the OS apply its creation
policy. The inspected binding does not refuse solely because the parent has an
Apple attribute absent from a product-specific metadata allowlist. The OS and
OpenCode's access/approval policy still decide whether the operation is allowed.

## Codex: executor abstraction, then the concrete local implementation

The pinned [patch update path](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/apply-patch/src/lib.rs#L657)
calls `ExecutorFileSystem.write_file`; stopping at that interface would not
establish how bytes are published. The
[direct local implementation](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/exec-server/src/local_file_system.rs#L656)
selects `tokio::fs::write` or its no-follow implementation. The
[Unix no-follow writer](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/exec-server/src/no_follow/unix.rs#L116)
opens relative to a parent descriptor, checks regular-file type, calls
`set_len(0)` and writes through the same handle. That path does not atomically
replace an existing inode with a private stage. Its symlink controls are a
separate property from content atomicity.

The [sandboxed filesystem](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/exec-server/src/sandboxed_file_system.rs#L170)
routes file-write requests through a helper; the
[helper dispatch](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/exec-server/src/fs_helper.rs#L314)
then uses the filesystem write interface. This is not evidence that sandboxing
is bypassed, or that every possible executor has identical internals.
[Tokio](https://docs.rs/tokio/latest/tokio/fs/fn.write.html) identifies its helper
as the asynchronous equivalent of
[Rust's file write helper](https://doc.rust-lang.org/std/fs/fn.write.html),
which creates or replaces content through a file handle.

OpenAI's [apply-patch API guide](https://developers.openai.com/api/docs/guides/tools-apply-patch)
describes model-proposed edits applied by the host, not a universal macOS
metadata/atomic-publication contract. Neither that guide nor this source trace
proves the implementation of the separate Codex app/runtime tool used in this
conversation. The scoped source result is enough to identify a real alternative,
not to claim every Codex surface solves MACL preservation in the same way.

## Claude Code: separate documented behavior from unknown internals

Anthropic's [permissions documentation](https://code.claude.com/docs/en/permissions)
describes file modification authorization, modes, working directories and
sandbox interaction. Its [checkpoint documentation](https://code.claude.com/docs/en/checkpointing)
describes tracked edits and rewind with explicit limits. Those are useful user
controls, but neither inspected page establishes an inode publication mechanism
or exact ACL/MACL/xattr preservation. A recoverable code snapshot is not, by
itself, an atomic file-write guarantee.

The [inspected official public repository](https://github.com/anthropics/claude-code/tree/14b7e6242e73bb41597a69f3fc7564d23ad429e7)
contains documentation, plugins, examples, mods and release material, rather
than the core writer source needed to make that claim. Its
[changelog](https://github.com/anthropics/claude-code/blob/14b7e6242e73bb41597a69f3fc7564d23ad429e7/CHANGELOG.md)
records an atomic-write fix for **configuration** in 1.0.45 and a Write/Edit
zero-byte/truncation fix for network/cloud-synced folders in 2.1.181. Neither
entry identifies the current ordinary-file MACL mechanism; a watcher fix after
atomic replacements also does not establish that all model edits use rename.

A [public user report in the official repository](https://github.com/anthropics/claude-code/issues/57024)
describes Tahoe/Desktop metadata-access problems. This investigation did not
reproduce or validate its diagnosis, UUID interpretation or proposed workarounds.
It is not an official guarantee, proof about current 2.1.311, or evidence that
Claude created the maintainer's project label. Do not use it to recommend
stripping attributes or changing OS privacy settings.

## What this changes for Relavium

There are two distinct comparisons. For **creation**, the observed Relavium
failure is an overly narrow parent-inspection profile before any publication.
Relying on actual OS destination creation while retaining unchanged parent
evidence addresses that local mismatch without inventing child consent. For
**editing**, the inspected OpenCode/Codex writers can retain the existing inode,
so they do not face the same cross-inode metadata-copy problem as Relavium's
accepted atomic replacement contract.

An in-place truncate/write can expose empty or partial content on interruption
or failure. That follows from its operation sequence; it is not a reproduced
failure or whole-product security assessment of either application. A durable
journal or a backup may aid diagnosis/recovery, but cannot retroactively turn
those byte writes into a single atomic rename.

| Alternative | Implication for the current decision |
|---|---|
| Keep the accepted atomic contract and correct the bounded metadata roles | Consistent with ADR-0125/0127; needs the real-host, runtime post-publication and actual-interaction evidence gates. |
| Switch to in-place writes to retain inode metadata | A real compatibility tradeoff demonstrated by upstream source, but reverses the existing atomic-publication decision and needs explicit maintainer approval of a superseding design. |
| Fall back to in-place only when metadata preservation refuses | Silently changes failure guarantees based on target state; not authorized by the current design. |
| Select a coordinated native safe-save API for file-level consent labels | Requires its own mechanism/atomicity/error/metadata proof. No such proof was obtained by observing competitors' successful writes. |

The recommendation is to retain the current atomic contract for this correction,
with the already selected parent/file distinction and honest unsupported-file
limits. This is a compatibility/guarantee choice, not evidence that Relavium is
universally safer or that another product is faulty. File-level MACL remains
outside the selected profile, so successful parent-MACL fixtures alone must not
be presented as complete parity with these applications. If the real-use gate
exposes that limit in the intended normal workflow, report it before accepting
the implementation and revisit the design with the maintainer.
