# ADR-0106: Media publication requires bounded verified bytes

- **Status**: Accepted
- **Date**: 2026-10-12
- **Related**: [ADR-0031](0031-llm-seam-shape-amendment-multimodal-io.md), [ADR-0042](0042-engine-media-storage-substrate-mediastore-deinline-retention.md), [ADR-0043](0043-media-egress-failover-rematerialization-ssrf.md), [ADR-0044](0044-media-access-governance-read-media-save-to-cost.md), [ADR-0089](0089-media-correctness-four-boundaries.md), [ADR-0105](0105-filesystem-roots-are-invocation-grants-not-project-authority.md)

## Context

Wave 2 findings #107–#113 concern the host media pipeline. Both reference stores
accept unbounded writes, ignore `readRange` cancellation, and lack crash-temp
reclamation. Fetch does not compare declared type with response headers or bytes;
the metadata store accepts inconsistent MIME/modality tuples. W5 added streaming
and catchable-failure cleanup, which cannot clean files after process death.

Physical containment belongs to ADR-0105. This proposal decides admission,
verification, publication and temporary storage lifecycle. It requires approval
before implementation and changes exported host hooks; no vendor SDK type, new
runtime dependency, money rule or automatic provider request is introduced.

## Decision

We will publish a media-bearing durable value only after bounded byte and descriptor
admission. Self-describing formats require independent identity evidence; headerless
PCM has the explicit structural-only qualification below. All media remains untrusted.

### Bounds and evidence

Introduce independent store guards in both reference implementations. `put` adopts
the seam's existing decoded-byte inline ceilings: 256 KiB for image/audio and no
video/document. These ceilings currently apply at seam ingestion, not inside `put`.
`putStream` gains a cumulative 25 MiB object ceiling, adopting the existing default
for media-egress downloads; that default is not currently a store bound. Streaming
remains a separate publication path, including in-memory storage; it never falls
back to inline `put`. Exact capacity
succeeds, capacity + 1 refuses before excess hashing/copying/writing. Unknown lengths
are counted; Content-Length is not authority. No silent truncation or partial handle.

The initial formats are PNG, JPEG, GIF, WebP; WAV, MPEG audio, FLAC, Ogg audio,
Ogg Opus, ADTS AAC and raw 16-bit PCM; MP4 video, WebM video; and PDF. Preserve
OpenAI's chat/TTS `audio/aac`, `audio/opus`, `audio/L16` and Gemini's inline
`audio/L16` paths rather than rejecting their successful responses after billing.
Normalize only reviewed aliases
(`image/jpg`, `audio/x-wav`, `audio/x-flac`) to their canonical MIME. Unknown,
unsupported, truncated or ambiguous self-describing identity refuses. This narrows the
formats admitted by first-party media ingestion under ADR-0031; extensible seam
shapes and handle-only durable carriers remain. SVG, AVIF/HEIC, audio-only MP4/WebM
and arbitrary MIME prefixes are not implicitly admitted. AAC requires ADTS evidence;
Opus requires Ogg/Opus evidence and uses canonical `audio/opus`, with `audio/ogg`
accepted only as a compatible container declaration for an identified Ogg codec.

`audio/L16` is deliberately different: any aligned sample bytes can be interpreted
as PCM, so magic bytes cannot independently identify it. Require nonempty even-length
16-bit samples and exact declared/header agreement, preserving the existing provider
PCM representation and its separately documented sample-rate/endianness limitation.
Do not claim detected format identity, WAV conversion, resolved rate metadata or
polyglot rejection for this arm. A missing/octet-stream HTTP header is insufficient
for raw PCM; a fetched PCM body needs an explicit compatible Content-Type. Native
provider PCM uses its explicit requested/reported protocol type and structural
checks. Reject known unsupported authored output selections before provider entry,
including native format escape-hatch options; unknown responses still fail closed.
Pin both actual provider output paths and this evidence distinction in the canonical
support matrix. No paid capture is needed to exercise these compatibility controls.

Use bounded incremental signature/container checks, at most 64 KiB inspection
scratch, overflow-safe lengths and bounded structural depth/count. Skip large
non-identifying chunks while streaming; finish required tail/track checks before
publication. Generic MP4 `ftyp` or EBML alone is insufficient video-track evidence;
Ogg must identify an admitted audio codec. Refuse evidence needing unsupported
inspection rather than guessing. The implementation/support table lives in the
[provider seam](../reference/shared-core/llm-provider-seam.md), not a second ADR table.
This is format identity/structural consistency, not decoder validation, malware
scanning, polyglot elimination or instruction trust.

The declared canonical MIME must reach the fetch boundary. Replace the public
positional host media-fetch/stream arguments with one platform-neutral request
containing `url`, `mimeType`, `maxBytes` and optional `signal`; forward MIME through
`MediaEgressHooks`/de-inlining to Node fetch options. Update every first-party host
and embedding fixture in the same step. This is an explicit host-API compatibility
change; no vendor data or response object crosses it.

Normalize response Content-Type casing/parameters once. An explicit conflicting
header refuses. An absent or octet-stream header is allowed only when independent
bytes unambiguously establish the admitted declared format (excluding raw PCM).
Store-level byte
verification protects other write callers too. Refusal closes the source and leaves
no published metadata/reference. Existing connect and body-idle deadlines remain;
this proposal does not impose a new total download deadline on a progressing stream.

Validate every handle occurrence, including handle-only carriers previously passed
through unchanged: check the declared actual byte length/type and compare all
same-hash descriptors **before deduplication**. Add required
`MediaStore.validateMedia(handle, descriptor)` returning owned, validated metadata.
The filesystem implementation scans the opened bounded fd incrementally for hash/
format evidence; it must not call whole-object `get` or defeat URL ingestion's
never-whole-buffered guarantee. The in-memory implementation validates its already
bounded owned bytes. Update all first-party stores and embedding fixtures together;
an absent method refuses rather than skipping admission. Existing
scope authorization still applies; integrity admission does not create a read grant.
Previously admitted handles are not grandfathered as verified. Unsupported legacy
media can remain stored/listed, but a new media-bearing publication must pass admission
or refuse with a fixed format-only diagnostic; do not silently delete/relabel it.

`recordObject` independently validates handle syntax, canonical MIME/modality,
nonnegative safe byteLength and optional **positive** safe duration only for audio/
video, matching the durable schema. Equal known durations must agree; absent duration
may be enriched by a known duration, and absence does not overwrite known evidence.
Conflicting known tuples refuse rather than silently preserving the first value.

Separate mandatory media admission from best-effort reference retention. Add
`MediaReferencePort.admitProducedMedia` for a batch of validated descriptors before
durable append; the SQLite implementation atomically validates/records compatible
object metadata under BEGIN IMMEDIATE/busy retry, without creating run read grants.
This reserves the immutable tuple against concurrent incompatible writers. A type/
tuple conflict or admission I/O failure refuses that media-bearing value **before**
its durable publication. If append later fails, the unreferenced object metadata is
eligible for the ordinary grace GC. After append acknowledgement, run-reference
mutation remains the existing best-effort operation and cannot reclassify an already
published event. Hosts without a reference port still perform byte/descriptor
admission; injected ports must implement the admission method, not silently skip it.
This explicitly refines ADR-0042's former all-post-append metadata mechanism while
retaining its best-effort retention semantics. No caller-supplied “verified” boolean
substitutes for the actual chain. Canonical aliases agree across durable descriptors,
CAS and metadata; known counts/type cannot be laundered through one hash occurrence.

### Temporary ownership and cancellation

New filesystem temporary files are exclusive, owner-private, strictly named and
associated with the local producer process plus a random invocation identity.
Caught failure closes and removes its own temp. Publication requires completed
verification and a still-owned file; cancellation never publishes partial bytes.

Automatic temp GC uses a 24-hour minimum age, separate from published-object
reference grace. It reclaims only a recognized temp whose owner is proven absent,
then atomically claims and revalidates that same file identity before unlinking.
A live/reused PID, permission error, malformed owner, future timestamp or uncertain
liveness means retain with a bounded diagnostic. A PID that is absent proves the
old local producer cannot still write; a live PID does not prove it is the original
producer. Active slow writers are retained regardless of age. Simultaneous sweepers
cannot delete each other's claims. Claim state retains original temp/file/producer
identity and the claimant's process/nonce. A later sweeper may recover a claim only
when the claimant is proven absent, using the same conservative liveness rule; a
claim-side crash must not create a new orphan grammar that is never swept. Corrupt
or uncertain claims retain with a diagnostic. This is a local-device CAS protocol,
not a distributed/shared-network-filesystem lease.

Legacy ownerless root/shard temp formats are not automatically presumed abandoned.
Add `relavium media prune-temporaries --legacy-offline --force` for explicit
maintenance after all old producers are stopped. Refuse if a new-protocol producer
is live; the flags acknowledge quiescence of older binaries, which have no owner
records to inspect. Limit deletion to the exact historical temp grammars inside the
pinned CAS root; never recursive suffix deletion or symlink following. Normal
invocations need neither maintenance nor destructive confirmation. Report counts
and fixed reasons, without paths or bytes, in human/JSON output.

`get`, `readRange` and `resolveForEgress` enforce the 25 MiB ceiling on the actual
opened regular-file descriptor before allocation and cumulatively while reading,
including old-layout/mixed-version oversized blobs. Oversized legacy objects refuse
without full materialization or automatic deletion. `readRange` honors pre-abort
and cancellation during native I/O in both stores, retaining actual-size range
bounds and hash integrity verification. Whole-object backing reads
remain the existing CR-53 residual; this change does not claim streaming range
delivery or close the separately owned `read_media` activation work.

### Alternatives and landing

Rejected upstream-only bounds (public store bypass), MIME from extensions/headers
alone (untrusted evidence), accepting unknown formats as generic bytes (false type
claim), age-only deletion (can remove a live writer), and a total write deadline
solely to make GC easier (changes the accepted progressing-download policy).
Use the host's crypto/TLS/filesystem primitives; do not add a decoder dependency or
pretend the bounded classifier is a full media decoder.

On acceptance update the existing seam/media contract, built-in tools, CLI commands
and database schema reference; add dated refinements to ADR-0031/0042/0043/0044/0089.
The exact MIME/limit/error and maintenance API definitions have those canonical homes.

## Acceptance obligations

1. Both stores independently enforce exact/+1 inline and stream bounds, including
   oversized first chunks, cumulative overflow and refusal without a published handle.
2. Native fetch fixtures pin declared/header/body agreement, missing header, aliases,
   fragmented signatures, invalid/truncated/ambiguous formats and late container
   metadata. A consumer-pull observation proves no whole-object buffering on the
   filesystem stream path; in-memory accumulation remains bounded by the object cap.
3. Actual engine→admission→append→SQLite controls pin handle-only evidence, incompatible
   descriptors within one payload and an existing incompatible row. Rejected admission
   leaves no successful media-bearing append/reference. Direct metadata tests cover
   zero/fractional/non-audio-video durations and missing/known enrichment. Operational
   post-append retention failure stays best effort; normal resurrection still works.
4. Real child-process death leaves a recognized temp that aged GC reclaims; an equally
   aged live slow writer survives. Two processes/sweepers, PID reuse/uncertainty,
   both legacy layouts and the explicit offline path have native controls. Kill a
   sweeper after claim/before unlink and prove a second sweeper recovers the claim.
5. Refusal/cancellation/iterator abandonment closes and joins owned resources without
   publishing a partial object. Range cancellation tests exercise both reference stores.
   Native old-layout oversized blobs with tiny requested ranges refuse before full
   allocation. Actual OpenAI AAC/Opus/PCM and Gemini PCM fixtures remain supported;
   unsupported authored output selections make zero provider calls.
6. Removal of each bound, verifier, ownership and signal guard breaks the associated
   permanent regression. Windows, required CI/coverage and independent path-jail /
   secrets-at-rest reviews validate their actual platform-scoped claims.

## Consequences

### Positive

- Handles describe complete, bounded media with honest type evidence.
- Crash leftovers have a safe automatic path; old files have an explicit maintenance path.
- Host/metadata boundaries defend themselves without duplicating SSRF or money policy.

### Negative

- Unsupported formats now refuse at ingestion; publish the support matrix and
  actionable format-only errors, and require evidence before expanding it.
- Container validation and ownership add complexity; keep recognizers bounded and
  pin mechanisms with independently authored bytes and native failure controls.
- Owner uncertainty conservatively retains temp files; report it rather than claiming
  successful reclamation. Legacy maintenance requires an explicit offline assertion.

### Maintainer acceptance — 2026-10-12

The maintainer approved the revised decision and the eight-step Wave 2 execution
plan after the ten-comment intake and two fresh independent cumulative proposal
reviews. Dependent implementation is authorised on `development`; acceptance of
this decision does not certify unimplemented mechanisms or close the wave.
