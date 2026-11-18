# ADR-0126: Native write admission and recovery keep explicit lifetime proof

- **Status**: Accepted
- **Date**: 2026-11-13
- **Related**: [ADR-0125](0125-file-writes-preserve-security-metadata-through-a-native-host-adapter.md), [ADR-0124](0124-inspect-retained-run-effects-before-file-preparation.md), [ADR-0105](0105-filesystem-roots-are-invocation-grants-not-project-authority.md), [ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md), [native metadata contract](../reference/cli/native-filesystem-metadata.md), [architectural principles](../standards/architectural-principles.md)

## Context

The PR #99 review at `80e8cd88` exposes three related gaps in the native
metadata boundary. They need a coherent ownership decision before implementation,
rather than exceptions which silently discard evidence or ignore version changes.

First, Linux preparation opens an existing source for non-truncating write
access. A focused lower-layer overlayfs probe changes its ctime at that open,
without an application data write. The current snapshot then refuses the
operation. The bounded
[contributor probe](../../tools/native-fs/overlay-access-probe.mjs) makes the
OS observation reproducible in a cached digest-pinned container with no host
mounts or network. It is not execution of the complete adapter. The kernel's
[overlayfs documentation](https://docs.kernel.org/filesystems/overlayfs.html)
explains copy-up and warns that object identities and open-descriptor views
depend on the mount configuration. Ordinary preparation must remain read-only;
silently ignoring ctime or assuming two descriptors still see the same object
would weaken the existing version and policy checks.

Second, a record's held descriptor currently supplies identity evidence but
does not continuously lock the record throughout its producer's lifetime.
PID absence alone is insufficient when a private home is shared by processes
in different PID namespaces. This is a protocol concern, not a reproduced
cross-namespace deletion. Existing cleanup must continue to preserve live,
reused or uncertain producers.

Third, recovery can remove a proven stage directory and then observe a
cooperative cancellation or scan deadline before deleting its record. A later
pass cannot prove what happened from an absent pathname alone. The present
between-OS-call cancellation rule makes this avoidable interruption window
part of ordinary recovery. A process crash or I/O error remains a separate
uncertainty boundary.

The [metadata contract](../reference/cli/native-filesystem-metadata.md) owns
exact formats, profiles, bounds and platform acceptance. This proposal refines
ADR-0125's mechanisms without changing atomic publication, content approval,
the effect journal, filesystem grants or the TypeScript engine boundary. It
received maintainer approval after the supplied review findings were checked
and the required clarifications below were incorporated. This accepts the
design, not its still-required implementation/platform evidence.

## Decision

**Keep preparation non-mutating, bind live staging to a native lifetime lock,
and finish a small, proven recovery deletion sequence once it becomes
irreversible. Uncertainty stays explicit and never grants retry authority.**

### Source access and overlayfs

On Linux, preparation uses a descriptor-bound OS permission query under the
effective credentials, without opening the source for data writes. The proposed
mechanism is [faccessat2](https://man7.org/linux/man-pages/man2/access.2.html)
with effective-credential and empty-path semantics. An unavailable syscall,
unsupported flags or an unverifiable result refuses the dependent write;
there is no mode-bit/ACL emulation or real-UID fallback. This query is provisional,
not proof that the later write operation will succeed. Its kernel capability
requirement is Linux 5.8 or newer with the syscall and required flags enabled,
including under seccomp. Actual capability is checked; a kernel version string,
Node version or libc version does not prove it. Existing GNU/musl deployment
baselines remain as recorded in the canonical profile. Read/meta behavior stays
available when the dependent write capability refuses.

Actual non-truncating write/append admission remains after content approval and
the durable effect claim, before staging payload or publication. At this owned
cut, a Linux overlay source may refresh its native snapshot only after freshly
opened, no-follow descriptors prove the current named object still has the
required identity, exact reviewed original bytes, supported security policy,
owner/group/mode, other required metadata and effective credentials. Reopen the
read descriptor after possible copy-up; do not trust a held lower-layer reader
to describe the current upper-layer file. Bind the returned snapshot and all
later checks to that fresh current source.

Only ctime seconds/nanoseconds may differ across this explicit, enabled Linux
overlay admission cut. Require exact dev **and** inode equality across the
original, write and fresh read descriptors and the current named entry; changed
identity refuses even with equal bytes. Size, mtime seconds/nanoseconds, single
link/type, mode, uid/gid, supported ACL/xattrs/flags, complete original bytes and
effective credentials must still match. A ctime difference alone is never
evidence of safe copy-up. Unsupported or unprovable states refuse.
After this cut, retain strict version/policy/byte checks through publication.
No second independent refresh is allowed at a later await, after an arbitrary
failure, or as an automatic retry. This deliberately permits a new
baseline at this one admitted cut instead of promising rejection of every
otherwise semantically unchanged version transition.

The existing host-private `stageExistingMetadata` entrypoint owns this one
joined admission/staging operation. Perform prerequisite mask queries before
the last strict host comparison; calling and awaiting the native task is itself
required and is not forbidden by this rule. Native scheduling is not atomic:
the worker must repeat the original byte/version/policy proof before opening.
Make this coordinated handoff after the last strict TypeScript comparison
with the original prepared snapshot and before native staging. Pass the exact
reviewed original bytes and expected identity into the joined native operation;
the refreshed proof belongs only to that operation and its fresh current
descriptor. Preserve the original preview/read evidence. Any subsequent host
version check must use that same proven admission result, not independently
resnapshot or silently relax `equalSnapshot`. If the handoff cannot bind both
layers' subsequent checks, refuse. Exercise this complete host/native chronology,
not merely a native-only copy-up probe.

The existing macOS APFS and Windows NTFS permission/admission mechanisms remain
as specified under ADR-0125, without adopting Linux's ctime exception. macOS
still performs its effective non-truncating access checks and strict version
checks; test their APFS behavior rather than claiming that every OS-level open
has no observable effect. Preparation never performs application data writes,
creates staging payload or publishes a target. Linux specifically avoids the
copy-up-triggering write open until the admitted execution cut.

For failure/cancellation after that Linux open, unchanged target means unchanged
original content, required security policy and publication state, not absence of
all filesystem observations. Copy-up/storage and ctime may already have changed.
Do not roll those effects back by rewriting metadata or infer permission to retry.

### Producer custody

Before a recovery record becomes discoverable and before any payload bytes,
the producer acquires an exclusive, nonblocking OS lock on that exact record
and retains the owning descriptor/handle through stage, publish and release.
Use the supported native lock primitive, with explicit platform behavior;
do not implement liveness using a home-grown PID algorithm.

Producer cleanup reuses its held claim. Recovery opens its own handle and must
acquire the exclusive nonblocking claim, then independently satisfy the existing
producer-absence, owner, identity and artifact proofs. A free lock alone does
not prove death; PID absence alone does not prove release of a live producer.
Lock failure, unknown semantics or unsupported storage preserves the evidence.
This supports only the documented local, lock-coherent profiles; it does not
advertise cross-host or network-filesystem recovery.

Acquire and retain the original claim without self-relocking it during cleanup,
pending-marker inspection or handle duplication. Every claim-bearing descriptor
is atomically close-on-exec on POSIX and non-inheritable on Windows, including
raw opens and clones. Test descriptor/handle flags, child exec and original/
duplicate handle behavior. The Windows sentinel is outside bounded record bytes;
its exact range and reader bounds are frozen in the canonical protocol.

Version the record protocol and update its TypeScript inventory reader together.
An older record lacking the lifetime-lock witness cannot be treated as if its
producer followed this protocol. Preserve and report unproven old records for
operator recovery, with their protected namespace intact. Development status
does not authorize deleting potentially sensitive artifacts or manufacturing
evidence for them.

Known older records may supply identity evidence for exclusion only, without
gaining automatic-recovery eligibility. Unknown or unparseable versions must
fail the trusted inventory closed whenever their protected identities cannot
be established. Never skip them and thereby expose another producer's payload.

Activation requires a quiescent upgrade for each operator home: stop and join
all old producers, recovery processes and inventory/readers before enabling the
new protocol. Rolling coexistence and downgrade on that home are unsupported.
Keeping old evidence does not make old automatic recovery safe or stop an old
binary from operating; no new-process probe is claimed to discover every old
process across namespaces. Do not restart old binaries against the upgraded home.
Known v1 and new v2 byte layouts, strict recognition and exclusion-only behavior
belong to the canonical protocol; unknown/mismatched versions fail closed.

The platform proof must account for
[POSIX open-description lock lifetime](https://man7.org/linux/man-pages/man2/flock.2.html)
and [Windows handle-specific byte locks](https://learn.microsoft.com/en-us/windows/win32/fileio/locking-and-unlocking-byte-ranges-in-files).
In particular, reopening a record is not equivalent to reusing the producer's
existing claim, and a lock must not make the trusted inventory reader omit an
active record.

### Recovery completion and failure reporting

Keep cooperative cancellation, work/deadline checks and yielding throughout
discovery and reversible cleanup. Immediately before removing a proven empty
stage, perform the final checks and reserve the fixed remaining cleanup work.
While holding the proven parent/index/record claims, finish only parent flush,
unchanged-marker validation/removal and index flush without another cooperative
cancellation or scan-deadline refusal. Do not scan, recurse, copy payload,
publish a target or begin another candidate inside this completion section.

Suppress only cooperative cancellation/deadline exits. Retain every bounded
owner, private-policy, parent/index/record identity and path/context recheck in
its existing security order, including after directory removal, after parent
flush, and before and after marker unlink. A changed context or I/O error still
refuses and reports uncertainty. Reserve work for these proof checks as well
as the fixed cleanup calls; the section is not permission to omit them.

This narrowly refines the between-OS-call cancellation requirement. It is a
bounded number of OS operations, not a wall-clock bound on an OS call. Teardown
still retains and joins the actual producer. An OS/proof failure reports
uncertainty and preserves whatever evidence remains. If marker removal succeeds
but flushing fails, report that uncertainty rather than claiming the marker was
retained. A crash in the remaining syscall/durability gap may still require
operator-assisted recovery; an absent stage is never permission to delete an
otherwise unproven record.

Preserve fixed, closed failure categories at the native/host boundary. Possible
publication or unproven cleanup is fatal and non-retryable, with the existing
effect-needs-attention presentation instead of a mode/policy denial. Primary
failure and cleanup uncertainty must both remain represented safely. No raw
native error, path, policy value or handle enters public events or history.

The canonical failure/outcome table separately specifies claim state, caller
terminal status and attention disclosure. A post-claim admission, mask or stage
failure is not a new pre-effect discard proof: leave the tier-3 row ambiguous,
or prepared if recording the ambiguity fails, without automatic retry. User
cancellation may remain the caller's aborted terminal state. Workflow final
effect health and a separate fixed session notice after joined work disclose
unresolved effects; do not claim that every cancellation terminal itself carries
an `effect_needs_attention` error. No new durable session-event type is needed.

Considered and rejected: dropping ctime checks globally; write-opening during
preparation to materialize a lower layer; treating ENOENT as cleanup proof;
trusting PID absence or a free lock alone; silently grandfathering old records;
and abandoning an in-flight syscall to meet a timer. A durable cleanup-phase
marker can improve diagnosis but cannot eliminate the gap between a syscall and
its durable record, so it does not replace the conservative crash boundary.

### Acceptance and rollout

Before acceptance of the implementation, update the canonical metadata contract
and append an explanatory forward note to ADR-0125. Keep its other decisions
and history intact. No new dependency, Node floor, runtime download, public
model tool or release permission is introduced. ADR-0121 and the interim npm
publication guard remain pending and unchanged.

Require real Linux lower-layer overlay tests of preparation, admitted copy-up,
fresh-descriptor bytes, identity and policy changes, ACL denial, cancellation
and journal outcome. Cover syscall unavailability and strict refusal on
unsupported mount behavior. Require actual native lifetime-lock and producer/
recovery contention tests on the enabled POSIX and Windows profiles, including
simulated false PID absence and process exit. Test cancellation/deadline and
process-crash cuts around payload removal, stage removal, record removal and
flushes, plus I/O/proof failures and old records. Verify unchanged targets,
bounded work, honest retained/removed counts and no publication/retry authority.
Here unchanged excludes the explicitly allowed post-claim copy-up/ctime effects;
test failure, cancellation and process death after the access open and before
staging/publication, with honest journal and user outcomes. Include mandatory
stop-old-process rollout, old/new process incompatibility, non-inherited claims,
no self-relock, Windows reader/sentinel bounds, capability absence and changed
overlay identity. A probe record alone is not complete adapter acceptance.
Include mixed old/new/unknown records through the actual TypeScript inventory
reader, independent Windows reader/producer/recovery processes and real shared
PID-namespace homes where the enabled lock-coherent profile permits them.
Regenerate source-bound native assets and run all declared target profiles,
installed consumers, complete CI, independent reviews and a separate native
security sitting before maintainer merge review.

## Consequences

### Positive

- Read-only preparation does not cause overlay copy-up; an approved compatible
  overlay write can proceed after exact source and policy revalidation.
- Live cooperating producers have native custody evidence beyond a PID lookup.
- Cooperative interruption does not routinely strand a record after proven
  stage removal, while uncertain crashes remain conservative.
- Public outcomes distinguish an uncertain write from a harmless denial.

### Negative

- The admitted source-refresh cut is more complex and deliberately narrower than
  general filesystem support; full native tests and strict unsupported refusal
  remain required.
- Linux writes require the documented OS permission-query capability. Platforms
  lacking it keep read/meta paths and receive a fixed write refusal.
- Cancellation may wait for the small recovery completion section and any
  pending OS call. Producer joining and explicit limits remain mandatory.
- Old or crash-ambiguous evidence can still require operator recovery. Do not
  erase it to free slots or claim universal automatic cleanup.
