# macOS file write compatibility and publication tradeoffs

- **Date**: 2026-11-15
- **Status**: Technical design analysis; not a replacement filesystem contract.
- **Editorial revision**: Product comparisons, names and source pins removed at the maintainer's request; local conclusions and guarantee limits retained.
- **Related**: [ADR-0127](../decisions/0127-macos-write-metadata-has-distinct-parent-and-file-profiles.md), [ADR-0125](../decisions/0125-file-writes-preserve-security-metadata-through-a-native-host-adapter.md), [native metadata contract](../reference/cli/native-filesystem-metadata.md#macos-parent-and-file-attribute-profiles--adr-0127)

## Local problem and evidence boundary

Relavium's preparation refused ordinary new files under a macOS directory with
an OS-managed parent attribute absent from the original role profile. Existing
file edits have a separate concern: atomic replacement publishes a new inode,
so preserving admitted metadata requires deliberate capture, application and
proof. Successful writing by another application cannot establish Relavium's
atomicity or exact metadata guarantees. No comparative binary or hosted-model
performance claim is retained here.

## Mechanisms and their limits

A direct destination create lets the OS apply destination creation policy. A
write/truncate to an existing open file retains its filesystem object, avoiding
a cross-inode metadata copy. That does not prove that every OS-managed attribute
remains unchanged. Node's [write-file API and file-open flags](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromiseswritefilefile-data-options)
describe its default write/truncate behavior.

An in-place truncate/write may expose empty or partial content after interruption
or failure. A backup or journal may aid recovery; neither makes that byte-writing
sequence a single atomic replacement. Symlink controls, approval, snapshot undo
and atomic publication are distinct properties and need separate proof.

Relavium selected private staging and atomic publication under ADR-0125. Correcting
parent inspection independently from file metadata preservation addresses the
observed creation refusal without manufacturing or transferring consent labels.
The [role contract](../reference/cli/native-filesystem-metadata.md#macos-parent-and-file-attribute-profiles--adr-0127)
owns the supported attributes, bounds and runtime proof.

| Alternative | Implication |
|---|---|
| Retain atomic publication and correct parent/file roles | ADR-0127's chosen correction; needs real-host, actual-user and post-publication evidence. |
| Switch to in-place writes | Retains the old inode, but reverses the accepted byte-publication guarantee and requires a separate decision. |
| Fall back to in-place when metadata refuses | Silently varies the failure guarantee with target metadata; not authorized. |
| Adopt a coordinated native safe-save API for file-level consent | Requires its own mechanism, atomicity, error and metadata proof; ordinary successful writes do not supply that evidence. |

## Retained conclusion

Keep the accepted atomic contract, the bounded parent/file distinction and
honest unsupported-file limits. A supported parent-MACL fixture does not prove
universal file-MACL compatibility. The actual-user interaction and native
post-publication checks remain necessary. Neither stripping attributes nor
changing OS privacy settings follows from this investigation.

The [local acceptance checkpoint](../roadmap/phases/phase-2.6-conversational-authoring.md#adr-0127-final-local-source-acceptance-2026-11-15)
owns implementation evidence and current-head limitations; this analysis does
not replace it.
