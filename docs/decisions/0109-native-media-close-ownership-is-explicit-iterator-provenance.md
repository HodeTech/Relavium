# ADR-0109: Native media close ownership is explicit iterator provenance

- **Status**: Accepted
- **Date**: 2026-10-13
- **Related**: [ADR-0011](0011-internal-llm-abstraction.md), [ADR-0042](0042-engine-media-storage-substrate-mediastore-deinline-retention.md), [ADR-0043](0043-media-egress-failover-rematerialization-ssrf.md), [ADR-0051](0051-cli-distribution-thin-bundle-private-engine.md), [ADR-0085](0085-the-node-executor-owes-liveness-and-the-engine-enforces-it.md), [ADR-0089](0089-media-correctness-four-boundaries.md), [ADR-0102](0102-a-measured-request-owns-its-inert-data-through-egress.md), [ADR-0103](0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md), [ADR-0106](0106-media-publication-requires-bounded-verified-bytes.md), [architectural principles](../standards/architectural-principles.md)

## Context

Wave 2 Step 6's first independent cumulative review found a lifecycle ambiguity in
the public `AsyncIterable<Uint8Array>` media path. An actual reference store's
verification or write failure causes `for await` to await the counted source's
`return()`. An injected source can keep that promise pending forever, preventing
the store from reaching its own file/temp cleanup. Direct store callers have the
same problem. The existing early-return test used a store that never pulled and
did not exercise implicit iterator closure inside a real store.

Simply ceasing to await return breaks a different accepted obligation. The Node
media generator currently owns actual HTTP request/response close promises in its
finally; CLI/core forward that generator directly. A loopback HTTP stream, actual
filesystem store and injected file-write failure demonstrate that unconditionally
observing return permits the operation to settle while real native close is still
outstanding. A plain iterator promise does not reveal which obligation it carries.

ADR-0106 requires refusal without partial publication and cleanup of owned work;
ADR-0085/0103 distinguish foreign asynchronous liveness from genuinely owed native
retirement. This proposal supplies their missing provenance mechanism rather than
reversing either obligation. It changes an exported, platform-neutral host lifecycle
contract; the maintainer must approve it before dependent implementation. No key,
provider call, dependency, persisted field, money rule or total download deadline
is introduced. The canonical media contract remains in the
[provider seam](../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106).

## Decision

If approved, we will use an explicit exact-iterator ownership protocol in `@relavium/shared`.
`registerNativeMediaIterator` registers a trusted constructor's iterator before it
escapes; `closeMediaIterator` synchronously initiates close, caches and returns its
acknowledgement without awaiting it. The caller chooses where to **join** that
acknowledgement. A private WeakMap binds the exact iterator to its captured original
return method/receiver and close state. It is neither an enumerable pending-work
registry nor a property, prototype, MIME or promise-based guess at native identity.
The API shape and error mapping will have their single canonical home in the seam
when this decision is accepted.

### Ownership and ordering

1. Registration is constructor-time and immutable. Duplicate registration and
   registration after helper-mediated close starts refuse with the existing
   content-free `MediaAdmissionError('source_failed')`. A trusted constructor must
   register before exposing the iterator or starting its first `next()`; registering
   an already-running iterator violates this precondition. The helper cannot inspect
   arbitrary iterator execution state and does not claim to detect that misuse.
   A helper-mediated close caches one acknowledgement before invoking caller code;
   repeated closes return that same acknowledgement, including while pending. Capturing the
   trusted return operation prevents later caller mutation from replacing the owed
   native acknowledgement. Exactly-once applies to calls through the helper, not
   arbitrary code invoking `.return()` directly. A prior direct return is not adopted
   as the helper's cached promise: the helper still invokes the captured operation
   once. A native generator's normal return queue joins any preceding retirement;
   a trusted adopted wrapper must provide the same safe repeated-close behaviour.
2. An unregistered iterator's return is requested once and its throw/rejection is
   observed without awaiting an unsettled promise; the helper returns a completed
   acknowledgement for that foreign close. For a registered iterator, the helper
   returns the cached native-close acknowledgement immediately, even while pending.
   Consumers join it at the retirement boundary, after their own cleanup. The helper
   itself performs no await. These helpers cannot preempt synchronously blocking
   JavaScript, replace existing cancellation/deadlines or make an already pending
   `next()` finite by themselves.
3. `streamMediaBytes` becomes an ordinary outer function that constructs and returns
   a private lazy generator. Before returning, it registers **that exact public
   generator object**, only for the first-party native dependency implementation.
   Registration cannot run inside the lazy generator body and does not register
   only the deeper `streamWithLiveness` iterator. Validation and transport entry
   retain their existing lazy execution points; construction opens no connection.
   Injected dependencies are unregistered by default. Direct native generator
   return retains its own actual request/response join even outside these helpers.
   The whole-buffer twin `fetchMediaBytes` continues to consume that public iterator
   under its existing size/deadline/cancellation limits and joins its native closure;
   this decision does not widen buffering or change its verification policy.
4. De-inlining acquires the source iterator once. Its counted wrapper initiates
   source closure by calling `closeMediaIterator(sourceIterator)` and observes its
   acknowledgement **without awaiting it in the wrapper's return**. It returns
   promptly, allowing the store to close its file/temp. The encompassing de-inline
   finally calls the same helper and joins the same cached native
   acknowledgement before settling. The counted wrapper does not inherit native
   trust merely because it wraps a registered source. Full EOF already joins the
   native generator finally and needs no redundant return. This optimisation requires
   every registered iterator to join its owned native work before reporting natural
   `done: true`, including a wrapper that ends a finite view before upstream EOF.
5. Both raw reference stores use explicit iteration on the interruption path so
   implicit foreign AsyncIteratorClose cannot block their own cleanup. A filesystem
   store closes/removes its owned temporary before awaiting any owed native close;
   an in-memory store discards unpublished blocks. Count-before-copy/hash/write,
   finish verification and publication order remain unchanged. A direct raw native
   caller still receives native-close joining; a direct foreign caller stays finite.
6. A primary typed verification/write/cancellation failure survives cleanup failure.
   A native cleanup failure without a primary failure refuses with the existing
   content-free `MediaAdmissionError('source_failed')`; it cannot create a successful partial handle. Foreign
   return diagnostics are never reflected into an event or log. Exact error mapping
   belongs in the canonical seam, without adding an engine ErrorCode.

### Trust and packaging boundary

Registration is trusted host code adopting a real lifecycle obligation, not a
security proof that arbitrary JavaScript work is physically native. A malicious
host could deliberately register never-settling work; provider JSON cannot forge
the private identity. Ordinary injected iterators remain foreign.

All first-party registration and consumption must resolve to **one loaded shared
module instance**. Private workspace packages already use their declared shared
dependency; the CLI inlines the workspace graph under ADR-0051. Acceptance must
prove identity through built package entry points and the actual CLI bundle graph,
not only source aliases. Two independently bundled shared copies are separate
ownership domains and cannot transparently interoperate under this protocol.
Do not silently bridge them through `globalThis` or `Symbol.for`.
Desktop/Tauri and VS Code hosts must prove one registration/consumption domain in
their own shipped JavaScript packaging before advertising this guarantee; CLI
inlining is not proof for those surfaces or across a WebView/process boundary.

A wrapper returning a different iterator does not transfer ownership automatically.
A trusted wrapper may register its own exact iterator only if both its captured
return and its natural terminal next establish the upstream native-retirement barrier.
A finite-view wrapper must close/join its upstream before reporting `done: true`;
return-only joining is insufficient. This is a trusted adoption obligation, not a
runtime claim that registration can inspect arbitrary wrapper code. Current CLI/core direct forwarding preserves
identity. If a future shipping surface requires transparent wrappers or multiple
shared copies, it must provide an explicit compatible bridge or revisit the
request-carried ownership alternative before claiming native-close joining there.

### Alternatives and landing

Always awaiting return reproduces the confirmed foreign cleanup hang. Never
awaiting it loses the confirmed native-close join. Timer races, generator/prototype
inference and Boolean trust flags do not supply ownership authority.

A request-carried `retainWork` callback is a sound alternative: it carries explicit
call-local ownership across wrappers and package copies. ADR-0103 already uses
behavioural invocation ownership and `continueReceipt`; ADR-0102's dated invocation
lifetime note keeps that behaviour outside inert measured request data. The callback
alternative therefore builds on an established ownership idiom. It requires changing the
host request and all forwarding sites, admission/sealing of late native work,
composition with standalone generator ownership, and a separate direct-store
contract. We prefer exact iterator provenance for the present directly forwarded
first-party graph, including direct reference-store callers. This choice accepts
the explicit packaging and wrapper obligations above rather than claiming general
cross-copy interoperability.

The two mechanisms serve different boundaries: retained-work scopes own a host
operation and its receipt delivery, while iterator provenance identifies the
specific close acknowledgement owed by a byte consumer. Provenance complements
those scopes; it does not schedule, enumerate or replace them. Its additional gain
is coverage for standalone native-generator and raw-store callers that have no
engine invocation context. Its cost is explicit wrapper adoption and a single
shared-module domain; unchanged request shape alone does not remove that cost.

On acceptance, update the existing canonical seam and affected host/store API
documentation; append dated mechanism refinements to ADR-0042/0043/0089/0103/0106 and the
Wave 2 register. Preserve historical bodies and their accepted guarantees. Add no
second native-work scheduler, platform import in shared/core or runtime dependency.

## Acceptance obligations

1. Actual filesystem and memory stores reject invalid media with a controlled,
   unregistered pending return. Assert the original typed error, one helper close,
   no published handle and completed owned-file/temp cleanup. Release and join
   every foreign test gate in finally; a timeout is not proof of the mechanism.
2. Actual loopback HTTP plus actual filesystem write failure after a valid sample:
   hold real request/response close acknowledgement, prove owned file cleanup while
   de-inlining remains pending, then release/join both closes and preserve the
   original I/O failure. Include direct raw native-store and direct native iterator
   abandonment controls. Removing native registration/join must break the witness.
3. Cache the same pending acknowledgement on repeated/re-entrant helper closes;
   reject duplicate registration and late promotion. Prove the first-party constructor
   registers before the first pull without eager validation/network entry, and cover
   direct return before helper close without duplicating native retirement.
   Cover unstarted lazy streams, EOF, early-return stores, injected dependencies,
   iterator property/prototype spoofing, unrelated wrappers and deliberate trusted
   wrapper adoption. A real upstream native stream with held close must keep an
   adopted finite-view wrapper's natural EOF and publication pending until closure;
   removing that EOF join must break the named regression. Primary failures are not
   masked or reflected with raw content.
4. Built workspace entry points and the actual CLI bundle establish one registration/
   consumption domain. A deliberately separate shared instance demonstrates the
   documented unsupported cross-copy boundary. Shipping surfaces do not silently
   advertise joining across it.
5. Each guard's removal breaks its named permanent regression in the existing
   [bounded causal inventory](../../tools/causal-controls/README.md), with media controls
   in [the filesystem family](../../tools/fs-policy-controls/README.md). Full affected gates and two NEW clean complete cumulative Step 6
   review rounds remain required after the last material fix. This proposal's
   approval or review does not accept Step 6 or close Wave 2.

## Consequences

### Positive

- Foreign asynchronous return cannot strand a store's owned cleanup.
- Real native work remains joined before publication/refusal settles.
- The existing media request shape and pure engine remain unchanged.

### Negative

- A new exported lifecycle protocol requires first-party and embedding migration;
  document trusted opt-in and validate real native failure paths before publication.
- Private identity requires one module domain and deliberate wrapper adoption;
  test shipped packaging and refuse unsupported interoperability claims.
- Trusted owned work can legitimately delay retirement; retain existing cancellation
  and native lifecycle mechanisms without pretending to preempt host JavaScript.

### Maintainer approval — 2026-10-13

The maintainer explicitly approved this clarified decision and its dependent
implementation after the two NEW clean complete cumulative proposal rounds.
The earlier conditional wording records the proposal history. Implementation,
native and packaging evidence, the complete causal inventory and two NEW clean
complete cumulative Step 6 review rounds remain required; approval does not
accept Step 6 or close Wave 2.

### Return-diagnostic observation correction — 2026-10-13

The third complete cumulative implementation review reproduced a missed rejection:
an ordinary genuine rejected Promise with a throwing own `then` accessor survived
the former `Promise.resolve(returned).then(...)` path without any observer on the
original Promise. The helper's foreign acknowledgement completed, but Node still
reported the original private rejection. An overridden own method and a genuine
cross-realm Promise require the same protection. This is an implementation defect
against the existing observation obligation, not a change to ownership authority.

The implementation now uses a captured intrinsic continuation for genuine Promise
settlement and guarded normal assimilation for other thenables. Its supported
JavaScript boundary retains ordinary constructor/species behaviour; it does not
claim universal containment of deliberately sabotaged continuation construction
or rejecting work independently created by caller code. The
[canonical lifecycle contract](../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106)
owns this qualification and exact mapping. Isolated diagnostic children exercise
actual runtime unhandled-rejection observation, foreign/native acknowledgement,
and real store/de-inline refusal without pre-catching the original rejection.
Named assertion-based removal, exact restoration, fresh cumulative implementation
reviews and complete publication gates remain Step 6 obligations.

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

### Failure-only consumer cleanup clarification — 2026-10-13

The subsequent PR #94 review found redundant close-only branches in the de-inline
and reference-store consumers. They can interrupt before EOF only after a primary
failure; simplifying their failure-preserving cleanup does not change the native
acknowledgement or local-cleanup ordering. The shared helper still refuses a native
close-only failure, including a yielding generator whose finally throws on return.
The [canonical lifecycle contract](../reference/shared-core/llm-provider-seam.md#bounded-verified-media-publication-adr-0106)
distinguishes these reachable cases. Existing foreign-finite, native-join and
cleanup-order removal controls retain their witnesses; this clarification neither
weakens the accepted guarantee nor claims current-head publication acceptance.
