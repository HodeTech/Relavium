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

### Wave 2 implementation checkpoint — 2026-10-12

Step 6 implements this decision on `development`. The
[canonical seam](../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106)
now specifies the finite admitted/refused profiles, structural-only PCM qualification,
required host request/validation ports and content-free errors; the
[database reference](../reference/shared-core/database-schema.md#media-metadata-admission)
specifies atomic immutable metadata admission. Physical temporary ownership and explicit
offline maintenance are specified in the
[built-in tools contract](../reference/shared-core/built-in-tools.md#physical-media-storage-and-limits).
Author checks are not independent acceptance: the
[Step 6 register](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#step-6-media-implementation-checkpoint--2026-10-12)
retains the pending causal, cumulative-review and platform gates. This checkpoint does
not close the wave or expand decoder, hostile-same-user jail or CR-53 range claims.

### Native media close ownership — 2026-10-13

Accepted [ADR-0109](0109-native-media-close-ownership-is-explicit-iterator-provenance.md)
refines interruption at the media byte-consumer boundary. Exact private iterator
provenance separates foreign return observation from trusted native retirement.
Store-owned cleanup precedes native acknowledgement joining; counted wrappers
initiate without blocking store cleanup and their enclosing scope joins afterward.
Natural EOF, deliberate wrapper adoption and the single loaded-module boundary
are explicit in the [canonical media lifecycle contract](../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106).
Existing host work/receipt ownership and whole-buffer limits remain in force.
Implementation, packaging and cumulative review gates remain separate from this
decision approval; this note does not accept Step 6 or close Wave 2.

### Second cumulative implementation review — 2026-10-13

Independent review reproduced two violations of the accepted identity/agreement
contract: later WebM/MP4 declarations could replace contradictory identity, and
Node's normalized HTTP headers discarded duplicate Content-Type fields before
media admission. Implementation now refuses repeated identity declarations within
their owners and preserves original Content-Type multiplicity through the native
port. The [canonical seam](../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106)
owns the exact profile and compatibility details. Fragmentation, real-store and
native HTTP regressions accompany separate causal removals. These corrections do
not expand decoder guarantees, introduce a new media type or accept Step 6.

### Exact temporary claim identity correction — 2026-10-13

The native Windows gate returned a malformed-claim refusal where its unchanged
replacement-file control required identity-change retention. The log did not
record its native identity values. A separate controlled production writer/reader
probe nevertheless reproduced a concrete inconsistency: numeric device/inode
fields above the safe-integer ceiling could be written into a claim that recovery
would permanently reject. Some large values also failed numeric radix round-trip.
Treating that result as an acceptable test alternative would hide an orphan path.

New claims use a distinct exact-native identity version; historical unsafe numeric
claims remain conservatively retained. The
[physical storage contract](../reference/shared-core/built-in-tools.md#physical-media-storage-and-limits)
owns the version, bounds, compatibility and revalidation rules. The implementation
preserves the producer/liveness/age/one-link/root floors and adds controlled actual
writer-to-interruption-to-recovery tests, including distinct exact values that
collapse to the same Number. These portable numerical controls do not assert a
measured NTFS inode or replace the native Windows rerun. Causal removal, fresh
cumulative review and publication gates remain open; this correction does not
accept Step 6 or broaden the filesystem jail guarantee.

### Native video output selector correction — 2026-10-13

The fourth cumulative implementation review reproduced an omitted video namespace
in the shared separate-endpoint output-selector check. Three unsupported native
video fields reached the installed SDK's synthetic job-creation POST instead of
refusing before entry. The selector check now inspects the request's actual
modality, preserving the unspecified format and supported size controls. The
[canonical seam](../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106)
owns the exact refusal boundary. Named regression failures precede the repair;
the separate physical removal and fresh cumulative acceptance rounds remain gates.
This fulfils the existing decision without extending the admitted media profiles.

### Whole-buffer borrowed-byte ownership correction — 2026-10-13

The fifth cumulative implementation review independently reproduced ordinary
Buffer reuse in the supported injected whole-buffer transport. Its subtype
`slice` retained an alias, so later producer reuse changed already admitted bytes
before aggregation. The whole-buffer collector now takes an intrinsic typed-array
copy before the next pull. A plain typed-array control and separate Buffer/subclass
regressions preserve the exact original bytes, independent final recognition and
disposal. The [canonical seam](../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106)
owns this existing ownership obligation. The default Node HTTP implementation was
not observed reusing chunks; this correction covers the supported injected port
without asserting universal hostile-JavaScript containment. Physical removal,
fresh cumulative reviews and publication gates remain required for Step 6.

### Configured response-byte accounting correction — 2026-10-13

The sixth cumulative implementation review reproduced a lower configured download
limit bypass through genuine injected Uint8Array/Buffer chunks with an inert own
`length` property. The independent media-object ceiling remained intact. The
shared host reader now counts intrinsic bytes before copying or yielding; its
buffered twin also owns admitted chunks before producer reuse. This fulfils the
existing per-response bound and ownership obligation, whose canonical description
is in the [seam](../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106).
Exact-capacity, cumulative-overflow, non-evaluated getter, borrowed-byte and public
media-path regressions are retained. It does not assert that ordinary native HTTP
chunks override their length, or extend the approved JavaScript containment scope.
Named removal controls and new complete cumulative reviews remain acceptance gates.

### Step 6 implementation acceptance — 2026-10-13

The dependent implementation is independently accepted on `development` at
`0b025416`: two NEW clean complete cumulative rounds, current physical evidence
and all nine published CI jobs pass. The
[Step 6 acceptance register](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#step-6-acceptance--2026-10-13)
joins the repairs, evidence and finite ownership/profile limits. Step 7 and Step 8
whole-wave certification/publication remain separate; this note does not close Wave 2.


### Wave 2 implementation landing — 2026-10-13

The applicable Wave 2 implementation is accepted on `development`. The
[closing register](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-2-closing-register--2026-10-13)
joins the per-item disposition, two NEW clean complete whole-wave review rounds,
security sittings, exact-source gates and preserved limits. Earlier dated pending
checkpoints remain historical. This landing does not claim a merge, future header
activation, full M/N lifecycle or removal of approved residuals.

### Recovery cleanup accounting correction — 2026-10-13

The first post-publication push at `84a2fddb` exposed a real cooperating-recovery
accounting race. A recovery that retained a live peer could win the final empty
claim-directory removal yet report retention; its peer could classify the resulting
absence as I/O. The whole claim was gone with neither process counting removal.
The original native concurrency assertion correctly refused this result.

The existing one-candidate reporting contract is implemented at the successful
final directory removal. A normally completed recovery that wins that operation
counts the claim once; only after its own identity-checked marker removal may a
losing recovery classify raw or normalized missing-directory evidence as contention.
Pinned-root revocation, earlier ownership checks and substantive I/O failures remain
refusals. No new deletion authority, liveness rule or minimum age is introduced.
The [canonical maintenance contract](../reference/shared-core/built-in-tools.md#physical-media-storage-and-limits)
owns these reporting semantics. Two deterministic native-process schedules cover
loss before directory validation and at rmdir; listing tests separately distinguish
normalized absence from I/O. Two independent mechanism removals require both race
witnesses and complete restoration. Independent correction review and exact-head
publication gates remain separate from the earlier whole-wave evidence.

### OpusTags compatibility correction — 2026-10-13

Maintainer review of PR #94 at `395fbf95` reproduced rejection of otherwise valid
OpusTags padding through the recognizer, store and installed OpenAI SDK publication
path. The accepted bounded Opus profile follows RFC 7845 §5.2: after the required
vendor/count/comment fields are complete, padding and arbitrary binary tails are
legal. Their editor-preservation bit does not change ingestion validity. This
restores the existing profile rather than adding a codec or mapping family.

The [canonical media profile](../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106)
owns the exact framing and limits. CRC, continuation, packet/object/count limits,
EOS, MIME agreement and Vorbis framing remain required. Fragmented byte/page,
both-store exact-byte and actual installed-SDK/CAS/SQLite publication controls
must distinguish legal tails from malformed required fields. The
[PR #94 correction register](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#pr-94-systematic-review-corrections--2026-10-13)
owns independent correction acceptance and fresh publication evidence; earlier
checkpoint checks do not certify this repair.

### FLAC inter-frame consistency correction — 2026-10-13

Maintainer review of PR #94 at `395fbf95` reproduced publication of CRC-valid,
correctly numbered FLAC with a nonfinal block below the STREAMINFO minimum and
with inconsistent fixed-strategy block sizes. These are framing constraints,
independent of decoding samples or checking STREAMINFO MD5. Their enforcement
restores the accepted structural-consistency guarantee.

The [canonical media profile](../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106)
owns the exact nonfinal/final distinction. A successor makes the previous completed
frame nonfinal; bounded scalar state can then enforce minimum and fixed-size
consistency while preserving a legal shorter final frame and singleton. Variable
strategy remains distinct. This adds no decoder, buffering, codec or unrelated
requirement that declared bounds be attained.

Fragmented, independently checksummed refusal/acceptance pairs and real-store
publication controls must distinguish each guard from the other checks. Separate
single-site removals cover minimum, fixed nonfinal equality and fixed final growth
so one guard cannot hide another's absence. The
[PR #94 correction register](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#pr-94-systematic-review-corrections--2026-10-13)
owns the new independent review and final corrected-source publication gates.

### Predictor framing and media-contract clarification — 2026-10-13

The subsequent PR #94 review found a residual-partition equality gap and missing
permanent predictor/residual coverage. Independent fixed/LPC/Rice/escape byte vectors
and immutable published examples now distinguish legal framing from malformed
partition geometry. The same review exposed missing mandatory PADDING/APPLICATION
structure checks. These restore the accepted structural-consistency boundary;
opaque metadata payloads and decoded samples remain outside its guarantees. The
[canonical media profile](../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106)
owns the exact supported framing and limits. Each new guard requires its own
named removal witness, with real-store and durable-publication controls.

The canonical contract also now states the existing separate-endpoint native
selector refusal precisely, including recognized values and explicit undefined,
and lists only retention reasons actually produced by automatic sweeping. No
format override authority, codec, buffer ceiling or maintenance-error reason
changes. Independent cumulative review and current-head publication remain
separate gates; earlier acceptance does not certify these corrections.

### Generated-result bound integration correction — 2026-10-15

The maintainer reproduced large valid generated images and completed base64 video
being refused after successful provider work. Applying request-input ceilings to
all result carriers contradicted the existing generated-result exception and the
separate streaming path chosen above. The [canonical publication contract](../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106)
and [carrier contract](../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106)
now distinguish ingress/direct-put limits from bounded generated-result storage.
No format, object ceiling, host authority or money rule is expanded. Optional
small-only host compatibility is retained without retrying a failed stream through
a whole-buffer fallback. Regressions cover actual installed SDK/executor/engine
publication through both stores; their review and execution acceptance is recorded
separately from this correction.

### Vorbis bit-framing integration correction — 2026-10-15

The maintainer supplied an independently native-decodable Vorbis body that the
final-byte low-bit heuristic refused. Setup framing is bit-packed: locating that
flag requires bounded structural traversal, rather than assuming byte alignment.
The existing finite-format decision now reaches the actual flag while retaining
packet, page CRC, continuation, EOF and object bounds. The
[canonical format profile](../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106)
owns the exact traversal, retained-memory and decoder limitations. No new codec,
decoder, public API or dependency is introduced.

Independent fixtures pin all eight framing-bit positions to freshly native-decoded
bodies and exercise both real stores' put, streaming and de-inline paths. Separate
controls reject an extended MP4 size zero while preserving the original EOF size
form; FLAC's already-admitted unknown sample total is stated accurately. These
repairs do not claim decoded samples for arbitrary classified media. New source
review and corrected-head execution remain separate acceptance gates.

### Exact-owned marker acquisition cleanup — 2026-10-15

Maintainer review reproduced a native-close failure after marker fstat that lost
the acquired identity and left a live maintenance marker behind. Maintenance and
recovery acquisition now retain the captured identity through close and post-close
admission. Failure cleanup retires only the known original regular one-link marker
under its original pinned root; recovery also requires its exact claim directory.
An unsuccessful recovery acquisition leaves directory removal and its count to a
later normal recovery. Unknown identities, replacements and revoked roots remain
conservative, and secondary cleanup failure cannot replace the primary diagnosis.

The [canonical storage contract](../reference/shared-core/built-in-tools.md#physical-media-storage-and-limits)
owns those conditions and the unchanged fail-closed treatment of unknown maintenance
prefixes. Native-fd controls inject failure only after actual close, distinguish
foreign/replaced ownership and verify subsequent publication/recovery. Fixed typed
read cancellation preserves native read/close acknowledgement and content-free
diagnostics. No automatic unknown-owner recovery or broader deletion authority is
introduced; source review and final execution remain separate acceptance gates.

### Inert snapshot collection-property correction — 2026-10-15

Maintainer review reproduced loss of inert own data on Map/Set values: intrinsic
entries were copied, then traversal skipped the collection's remaining properties.
The same branch omitted nested media and aliases that must participate in preflight.
A separate descriptor rule incorrectly reserved every field named `length` for the
array-specific nonconfigurable treatment. Both corrections preserve the existing
supported graph rather than introducing a serializer or a broader object domain.

The [canonical publication contract](../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106)
owns the supported/refused domain, collection iterator exception, own-property and
alias semantics. Media-free Date, RegExp, custom-class and executable values already
refuse; the permanent controls now make that compatibility boundary explicit. The
request-data domain in [ADR-0102](0102-a-measured-request-owns-its-inert-data-through-egress.md)
remains separate; its JSON-oriented Map/Set treatment and cycle policy do not replace
publication's intrinsic-entry ownership.

Metadata admission needs owned primitive descriptors, while the engine already owns
the de-inlined graph. Its existing synchronous collector can therefore validate and
capture those descriptors during a visited traversal without a second whole-graph
clone. Unsafe standalone callers still receive the same fixed refusals, and no cache,
new public bypass or caller reference crosses the metadata await. Collection-property,
supported-domain, standalone-admission and held-metadata-port regressions accompany
this correction. Their independent review and execution acceptance remain separate
from the earlier published source and physical evidence.

### Fixed admission-error reconstruction — 2026-10-15

The fixed, content-free diagnostic policy also applies when a compatible bundle
uses another `MediaAdmissionError` constructor or a caller mutates an exception's
message. The existing exported class now reconstructs a fresh local error from
own data name and canonical closed code fields; foreign messages, causes and
getters supply no diagnostic text. This is classification only, without provenance,
authorization or a bridge between native-iterator ownership domains.

Publication reflection faults always become fresh `unsafe_value` refusals, even
when a trap throws a recognized admission error. Pure descriptor/MIME and conflict
refusals retain their reasons after complete unsafe-value preflight. The engine's
pin classifier similarly reads inert own egress codes under a reflection guard,
keeps cancellation first, and contains prototype faults with fixed internal wording.
These corrections preserve the existing error codes and iterator constraints;
new regression execution and independent source review remain separate gates.

### Engine-local pin-error capture correction — 2026-10-15

The first cumulative increment-4 review found a remaining prototype-only
`NodeMediaPinError` pass-through. Root reproduced host-supplied private text in
actual delivered and in-memory persisted engine failures; a forged retryable
policy also repeated a synthetic node under its authored retry configuration.
These probes do not claim paid provider, native SQLite or remote-JSON execution.

Only finite engine-authored diagnostic factories now register immutable failure
fields in a private weak map, bound to the originating node. Constructor calls,
prototype shapes and mutable public fields grant no capture. Reconstruction and
the dispatch catch read that private capture; a wrong-node rethrow refuses without
reinterpreting mutable fields. Existing part-limit messages and ceilings remain,
and all classified pin failures are nonretryable. Cancellation still wins first.
This is diagnostic classification, without changing media or iterator authority.

New actual-engine host/executor and internal-helper controls accompany the repair.
The earlier source round is not clean; two NEW complete cumulative source rounds
and corrected-head publication are required after this fix. Their actual verdicts
and execution remain owned by PR #94 and its correction register.


### Wave 2 merge landing — 2026-10-15

The applicable Wave 2 implementation and maintainer corrections merged to `main`
as PR #94 (`ab08209e`). The [merge checkpoint](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-2-merge-checkpoint--2026-10-15)
joins final reviewed source `4cdfe011`, review scopes, execution evidence and preserved
limits. Earlier pending/unmerged notes are historical; this landing adds no decision,
future feature, deferral or claim of merge-commit execution.

### Exact native identity correction — 2026-10-25

The 2026-10-13 correction made the persisted claim token exact but left every live comparison
on numbers: the root pin, file snapshots and the owned-file check that guards deletion, the
read's descriptor stats, the publish handle, and the sweep's claim-directory, child, marker
and moved-blob checks; `nativeFile` read a bigint but compared it through `Number()`. Each now
compares exact bigint device and inode, each read from a single stat; the file and directory
checks share one projection, in which `nlink`, `size` and `mtimeMs` keep their number values
(`mtimeMs` by Node's own formula). Node fills bigint stats from a signed array, so a 64-bit file
ID with its top bit set read negative: `nativeFile`'s Number cross-check refused it, and the
claim token would have too, retaining such a temporary forever. The token now encodes the
unsigned value;
every other value keeps a byte-identical token, so persisted claims stay compatible. The
[physical storage contract](../reference/shared-core/built-in-tools.md#physical-media-storage-and-limits)
owns the rules. Permanent causal controls and the
[NI checkpoint](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-ni-implementation-checkpoint--2026-10-25)
own the proof and its gates. The cooperative root/path floor is unchanged.
