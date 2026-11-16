# ADR-0128: Content-free tool receipts ground later chat turns

- **Status**: Accepted — 2026-11-15, by the maintainer, with the independent design-review findings folded in (see the review note at the end). The runtime lands as one cohesive implementation step.
- **Date**: 2026-11-15
- **Refines**: [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md) in three places — §1's sentence that the in-memory transcript stays text-only, §4's "what the next request contains" column, and §2's CR-70 deferral, which this ADR leaves in force and does not trigger (see Context). Also [ADR-0059](0059-cli-mid-session-model-reseat.md)'s reseat disclosure and [ADR-0062](0062-context-compaction-and-cli-history-commands.md)'s summarizer input. Their other decisions remain in force; CR-70's raw-content carrying stays deferred.
- **Related**: [ADR-0050](0050-cli-history-db-at-rest-posture.md), [ADR-0081](0081-the-compaction-summary-is-untrusted-and-the-system-prompt-is-branded.md), [ADR-0096](0096-a-request-is-measured-before-it-is-sent.md), [ADR-0098](0098-a-session-effect-row-holds-no-result-and-never-replays.md), [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md), [ADR-0119](0119-an-interrupted-turn-stays-as-a-content-free-marker.md), [investigation](../analysis/chat-context-command-and-latency-2026-11-15.md), [session contract](../reference/contracts/agent-session-spec.md#content-free-action-receipts--adr-0128)

## Context

A completed session turn can successfully create and read a file, then a later
model response can deny that any earlier tool call occurred. The visible tool
rows and durable structure record the calls; the next model request retains only
the user and final assistant text. The omission is deterministic, although it
does not alone determine a model's natural-language answer.

ADR-0095 deliberately kept raw tool content out of unencrypted history and
deferred carrying. The maintainer now requests a careful context correction
without advancing MVP-4 command/denial/interruption work or MVP-5 environment and
caching capabilities. The narrow missing evidence is already retained: resolved
tool name, engine identity and recorded outcome. Delivering these facts does not
require retaining file contents, replaying provider protocol pairs or advancing
CR-70's full raw-content design from v0.2.1.

**Why this is not CR-70.** ADR-0095 §2 defers *carrying tool history into the
model's context*, and its inherited constraints (carried content lives in the
process only; a per-turn ceiling on carried rounds; unique carried ids; a
user-scoped toggle) govern carried **content**. A receipt carries none: it is a
projection of §1's durable *structure*, reduced to a closed vocabulary of built-in
tool labels and four outcome values. The "process only" constraint exists because
§1 keeps content off disk; receipts are rebuilt from exactly what §1 already puts
on disk, so a restart or reseat rebuilds the same receipts and nothing new is at
rest. §2 itself anticipates this shape: carried content does not cross a reseat,
"so the new model sees notes". The §2 trigger is therefore neither met nor
closed by this ADR, and CR-70 stays open.

No visible UI changes: tool rows on screen, history and export are untouched. The
correction changes only the model-facing request.

## Decision

**Project bounded, content-free historical tool receipts alongside
their completed turns in subsequent session requests.** Keep the working text
transcript, durable row format, export content and session-effect non-replay
contract unchanged. This is a correction of request evidence, not a new tool
grant or full-content memory facility.

The [session contract](../reference/contracts/agent-session-spec.md#content-free-action-receipts--adr-0128)
owns the fields, grammar, bounds and ordering. Decisions binding its implementation:

1. Use only validated, paired structural records. A record means a call and its
   outcome were recorded; restored rows are unverified local-store claims,
   not authenticated execution provenance. Syntax/pairing validation cannot
   prove a historical registry resolution. Emit only code-owned built-in labels;
   replace every other name with a fixed label to avoid sending arbitrary
   historical text. Keep engine-form ids internal for pairing within one turn;
   render only per-turn ordinals. Render all four durable outcomes verbatim and
   never merge them: `ok` is a recorded success, without proving target identity,
   exact bytes or current filesystem state; `error` is a recorded failure that
   can be a pre-dispatch rejection or an execution failure with a partial effect,
   and does not say which; `denied` is a recorded refusal that is neither a
   standing prohibition nor permission to retry; `cancelled` leaves the execution
   state unknown. Never derive evidence from assistant prose, display labels or
   event payloads; the only live source is the typed `toolHistory` a turn returns.
2. Keep notes in user-role historical data attached to their completed turn;
   never fabricate assistant testimony or tool-protocol calls/results. Receipt
   text is host-authored from closed vocabularies, so it needs no
   `Untrusted<string>` brand: the stored name and outcome are classified into a
   closed record type at the reconstruction boundary and the original strings are
   discarded there, which is a stronger guarantee than marking a string this design
   never carries. It is placed only behind ADR-0081's role boundary. Do not
   promote names or outcomes into system authority. Receipt data cannot approve,
   repeat or authorize an operation, or satisfy a fresh-read/version requirement.
3. Apply the existing authored memory selection and completed-turn boundaries.
   Normal turns, empty finals, resume and model reseat use the same receipt
   projection. Missing historical structure means unavailable evidence, never
   proof that no call occurred. After resume, a turn with zero tool rows is
   ambiguous (no completeness marker exists) and counts as incomplete even if the
   original live instance knew it made no calls. Incompleteness is disclosed by
   **one fixed request notice**, never per turn, so a plain-chat history costs
   one fixed sentence once restored and nothing live. Failed/aborted turns remain
   excluded under the current contract; MVP-4's proposed markers remain
   independently gated.
4. Make this projection the normal behavior under existing memory policy. It
   adds no setting or raw-content toggle. CR-70's separate user-scoped toggle,
   live-content, reseat and provider-conformance decisions stay deferred.
5. Reuse the same bounded receipt projection in summarizer input. Exact receipts
   are dropped/rebased with their turns only after successful atomic compaction
   or trim; a generated summary is lossy, untrusted historical data, not an exact
   receipt archive. Preserve request measurement, four-pass fit, rollback,
   cancellation, `/trim` message units and durable boundary identity.
6. Apply **one ordered retention rule** so the correction cannot accumulate a
   second unbounded transcript and every route to a history retains the same
   records: inspect newest first within a fixed part budget; keep at most the
   newest 32 records per turn; then keep whole turn blocks newest first within
   128 records and 16,384 bytes. Overflow is eviction, never an error, and there
   is no separate cap on turn count. Derivation from stored rows degrades a bad
   or uninspected turn to incomplete and never fails a resume; only host-*supplied*
   metadata that breaks the caps is refused. Pairing and uniqueness are claimed
   only over the inspected rows of one turn; uninspected detail is unknown.
   Preserve whole records through oversized-message summarization. Measure the
   added request bytes/tokens and local projection cost before acceptance of the
   implementation.

Considered keeping text-only requests (rejected for this correction: it leaves
the reported evidence gap), retaining full raw tool content now (rejected: it
advances separately scheduled privacy/provider work), writing raw results or
paths into history (rejected: unnecessary sensitive persistence), reconstructing
synthetic protocol pairs (rejected: no actual result is available), and asking
the model to reread everything (rejected: rereading cannot prove historical
authorship and adds calls). Also considered folding `denied` and `cancelled` into
`error` (rejected: a refusal shown as a generic failure invites a retry the
policy will refuse again and blurs MVP-4's denial semantics), a per-turn
"unavailable" line for every ambiguous restored turn (rejected: it taxes every
plain-chat turn and makes a reseat show a different history than the live
instance), a cap on the number of turn blocks (rejected: a session past it could
not resume, and the record cap already bounds blocks), and an `Untrusted` brand on
receipt text (rejected: there is no free-form string to brand). Chose existing
content-free structure because it supplies the missing historical fact with a
narrow disclosure footprint.

## Consequences

### Positive

- Later requests have direct evidence of earlier recorded calls, including after
  resume/reseat, without raw tool content or a storage migration.
- The correction keeps CR-70, MVP-4 and MVP-5 in their approved schedules.
- Provider adapters receive ordinary text data; no reasoning/signature replay or
  fabricated tool pair is introduced.
- A live session that never ran a tool, and a session with no receipts and no
  incompleteness, send a request byte-identical to today's.

### Negative

- Receipts cannot identify a file path or recover earlier file contents. Keep
  that limit explicit; full raw-content continuity remains separate work.
- Added request data costs input tokens and can affect latency. A typical turn
  adds a few dozen tokens; a saturated retained payload is at most about 16 KiB,
  a few thousand tokens. Use strict caps, whole-record omission and matched
  request-size/latency checks; claim no speedup from this context correction.
- **Reach is bounded and shape-dependent.** Indicatively, with a ~140-byte turn
  wrapper and ~28 bytes per record, the 128-record cap binds first for turns of
  about four calls (roughly 32 turns of evidence) and the byte cap binds first
  for one-call turns (roughly 95). Older turns lose their receipts and are
  disclosed by the notice, not by a count. The numbers are indicative; the
  implementation measures them.
- **A turn that failed, was aborted or was fatally denied leaves no receipt even
  when a tool already ran**, and the model is not told: ADR-0098 invariant 4
  discloses it to the *user* ("check the target before sending again"), not to the
  model. This gap stays open until ADR-0119 is accepted and implemented. The
  correction does not resolve side effects it cannot see.
- **Eviction can churn a stable prompt prefix.** Dropping the oldest retained
  block rewrites an early user message, which invalidates a cached prefix from
  that point. It happens only in a saturated session; below the caps blocks are
  immutable once attached, so history stays append-only. The one-time appearance
  of the request notice also changes the head once. MVP-5's caching work must
  measure this churn and may refine the eviction step through its own decision;
  this ADR does not pre-empt it.
- A call to an MCP-discovered or custom tool renders as `other_tool`, so the
  model cannot tell which external tool ran or that it was MCP; a built-in
  `mcp_call` keeps its name. The substitution is deliberate: arbitrary names can
  carry sensitive text.
- **A new data class reaches the provider in text-only history:** which built-in
  tools were called, how many times and with what recorded outcome. It is low
  sensitivity, holds no content, and there is no user-level switch; the only way
  to omit it is `memory: none`, which also omits the transcript.
- Compaction can preserve only a generated account of dropped receipts. Label it
  as lossy and untrusted; never imply exact durable audit evidence survives it.
- A model can still contradict available evidence. Verify constructed requests
  deterministically and sample actual model behavior separately; no universal
  answer-correctness guarantee follows.

## Acceptance and landing obligations

One cohesive implementation step covers live receipt collection, strict resume
reconstruction, request projection, compaction/trim integration, disclosures and
tests. Run the maintainer's two fresh review rounds and a separate security
sitting; do not split each field or lifecycle path into its own step.

This list is the canonical acceptance set; the session contract and the
investigation link here rather than restate it. Required tests cover:

- successful create/read followed by another turn, with records attached to the
  correct turn; multiple calls with mixed outcomes; empty finals;
- **every outcome value**: `ok`, `error` (both a pre-dispatch rejection and an
  execution failure), `denied` and `cancelled` each render verbatim and none is
  folded into another; `denied` through a live refusal fixture and from restored
  rows, `cancelled` at the projection level and from restored rows because no live
  producer exists yet; a switch that fails to compile on a fifth value;
- normal, resumed and reseated evidence parity of the retained records, subject to
  the documented empty-history ambiguity;
- all memory policies, including no notice and no blocks under `none` and
  incompleteness evaluated over only the selected turns under `window`;
- **availability and the notice**: a live no-call turn adds no bytes; a restored
  zero-row turn is incomplete and produces exactly one fixed request notice no
  matter how many such turns exist; plain-chat byte/token cost measured live,
  restored and reseated against a text-only baseline;
- legacy gaps; missing/mismatched/duplicate structural identities inside one
  turn (that turn alone yields no receipts, is incomplete and the resume
  proceeds); forged matching rows and credential-like custom names/ids (only
  closed vocabulary appears in the request, history, export or any diagnostic);
- **the inspection boundary**: the same id placed on both sides of the 256-part
  per-turn boundary and across the 4,096-part operation boundary renders the
  inspected record once, makes no whole-history uniqueness claim, and marks the
  turn incomplete; the same id in two different turns renders both;
- **limits together**: exactly 32 and 33 records in one turn; exactly at and over
  the per-turn and request byte caps and the 128-record cap; a resume of 33 and
  of 50+ completed turns, and of 129 small records across turns, all under the byte
  cap, none refused and all disclosed by the notice; live, resumed and reseated
  histories retaining identical records; wrappers and notice counted in admission;
  saturated counts; host-supplied state over a cap refused as
  `invalid_resume_state`;
- request ownership and purity (no mutation of live metadata or stored rows);
- compaction success/failure/abort/cancel and trim rebasing; receipts in
  summarizer input within the measured four-pass bounds; whole records preserved
  through oversized-message truncation; overflow measurement;
- no argument/result/path/media/signature leakage into notes, history, events or
  export, and stale receipts unable to bypass fresh-read, policy, approval or
  non-replay controls.

Use real provider conformance for ordinary text projection where available;
offline scripted tests do not establish model behavior or network latency. No
paid replay is authorized by this decision.

**Landing obligations.** At acceptance (done 2026-11-15): dated forward notes in
ADR-0095 (§1, §2, §4), ADR-0059 and ADR-0062, the cross-link in the deferred-work
register, and the contract promoted from draft. CR-70 is not marked complete, its
release trigger is unchanged and MVP-4/5 are not activated. At the implementation
step:

1. **Pin the reseat disclosure** so ADR-0059's note-4 error cannot recur. The
   `/models` notice and [chat-session.md](../reference/cli/chat-session.md) must
   say, in substance: *prior tool arguments and results (including files a tool
   read) are not carried; only content-free records of tool names and outcomes
   are; text you sent, `@`-attached file contents included, is.* A notice saying
   no tool activity is carried would be false in the other direction.
2. Update the compaction summarizer prompt invariant in
   [chat-session.md](../reference/cli/chat-session.md) so a summary preserves the
   recorded tool calls and outcomes present in its input without treating them
   as instructions.
3. Update the chat-session turn-lifecycle step that says tool pairs are not
   carried into later turns to name receipts.
4. Flip the contract's implementation status when the step is accepted, and
   record the measured request-size and local-cost results.

## Review note

Three further independent design reviews read the Proposed ADR, the contract
draft and the investigation, after the two earlier cumulative design rounds and
the separate security sitting recorded in the phase register. They agreed on one gap
(the four durable outcomes, now a table) and between them raised the combined
limits, the partial-scan uniqueness claim, the zero-row notice, the 32-turn cap
that would have refused a valid 33-turn resume, imprecise ADR-0095 references,
the reseat wording, the eviction/caching interaction and several wording items.
Each was checked against the code before it was accepted or declined. Declined:
branding receipt text `Untrusted` (the closed vocabulary leaves no string to
brand; the role boundary and classify-and-discard rule replace it). Folded as
documented above, with the evidence-bearing facts verified in source:
`denied` is written today only for a refused `read_media` scope and every other
`tool_denied` ends the turn, `cancelled` has no producer in a completed turn, the
default hard turn cap is 50 with no upper limit, and the persister writes tool
rows only for turns that made calls.

## Implementation note — 2026-11-15

The step is implemented on `development`; the independent review rounds and the separate security sitting
this ADR requires are still owed, and nothing is merged or published. The measured results replace the
indicative figures in the Consequences above (the body is left as accepted):

- **Fixed text.** The outcome legend is 409 bytes and the incompleteness sentence 109 bytes (about 28 tokens).
  A history with no receipts and no gap sends a request byte-identical to the text-only one. A resumed plain-chat
  history adds exactly the 109-byte sentence once per request; the same history in the live instance adds nothing.
- **Block size.** 1 record 148 bytes, 4 records 208, 16 records 455, 32 records 791. The worst possible block
  (32 records of the longest label with the longest outcome and an omission line) is 1,232 bytes, so the
  4,096-byte per-turn cap cannot bind and is proven by a unit test rather than re-checked at runtime.
- **Reach.** The 128-record cap binds first from about two calls per turn: 107 turns of evidence for one call per
  turn (bytes bind), 64 for two, 32 for four, 16 for eight. A saturated payload is at most about 16 KiB.
- **Local cost.** Building a request and applying retention take under 0.1 ms for 1,000 completed turns;
  deriving receipts while reconstructing a resumed session costs about 1 ms for 1,000 turns of four calls each.
- Measuring found one defect in the first implementation, fixed before acceptance: the per-operation 4,096-part
  budget was spent only after a turn finished, so one turn could overshoot it by up to 254 parts.

> **Forward note 2026-11-16 — [ADR-0119](0119-an-interrupted-turn-stays-as-a-content-free-marker.md) accepted.** The
> gap this ADR leaves open for a failed, aborted or fatally refused turn closes when ADR-0119 is implemented
> (MVP-3c). Its rules for the interplay: an interrupted turn renders **one** block — this ADR's receipts block,
> then one fixed interruption sentence — and its tool names come only through this ADR's label rule (a built-in
> label or `other_tool`); it is *complete by structure* and is never `incomplete` merely for having no records;
> a degraded one gets this ADR's single request notice and no second one; an in-flight call at the interruption is
> recorded `cancelled` ("execution state unknown", defined here), making `cancelled` live for the first time.
> This ADR's text is otherwise unchanged.

## Update — 2026-11-16

ADR-0119 was accepted and implemented as MVP-3c on 2026-11-16, which closes the gap the fourth negative consequence above
names for the cases it covers: an engaged turn that ended by the abort or a classified error now keeps its recorded
calls (including a `cancelled` entry for a call in flight) and a fixed interruption note. A session-ending
cancellation, a crash, an unclassified throw, an observer or host fault, an unrecordable call and a turn before any provider
content still leave no receipt (the full list is in ADR-0119's implementation note). The correction still resolves no side effect it
cannot see.

