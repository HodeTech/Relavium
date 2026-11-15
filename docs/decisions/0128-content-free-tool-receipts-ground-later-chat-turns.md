# ADR-0128: Content-free tool receipts ground later chat turns

- **Status**: Proposed — maintainer approval required before runtime implementation
- **Date**: 2026-11-15
- **Refines on acceptance**: [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md) §1's text-only request boundary, [ADR-0059](0059-cli-mid-session-model-reseat.md)'s reseat disclosure and [ADR-0062](0062-context-compaction-and-cli-history-commands.md)'s summarizer input. Their other decisions remain in force; CR-70's raw-content carrying stays deferred.
- **Related**: [ADR-0050](0050-cli-history-db-at-rest-posture.md), [ADR-0081](0081-the-compaction-summary-is-untrusted-and-the-system-prompt-is-branded.md), [ADR-0096](0096-a-request-is-measured-before-it-is-sent.md), [ADR-0098](0098-a-session-effect-row-holds-no-result-and-never-replays.md), [investigation](../analysis/chat-context-command-and-latency-2026-11-15.md), [session contract draft](../reference/contracts/agent-session-spec.md#proposed-content-free-action-receipts--adr-0128)

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

## Decision

**On acceptance, project bounded, content-free historical tool receipts alongside
their completed turns in subsequent session requests.** Keep the working text
transcript, durable row format, export content and session-effect non-replay
contract unchanged. This is a correction of request evidence, not a new tool
grant or full-content memory facility.

The [session contract draft](../reference/contracts/agent-session-spec.md#proposed-content-free-action-receipts--adr-0128)
owns the proposed fields, bounds and ordering. Decisions binding its implementation:

1. Use only validated, paired structural records. A record means a call and its
   outcome were recorded; `error` can include pre-dispatch refusal. `ok` means a
   recorded successful outcome, without proving target identity, exact bytes or
   current filesystem state. Never derive evidence from assistant prose, display
   labels or arbitrary event payloads.
2. Keep notes in user-role historical data attached to their completed turn;
   never fabricate assistant testimony or tool-protocol calls/results. Do not
   promote names or outcomes into system authority. Receipt data cannot approve,
   repeat or authorize an operation, or satisfy a fresh-read/version requirement.
3. Apply the existing authored memory selection and completed-turn boundaries.
   Normal turns, empty finals, resume and model reseat use the same receipt
   projection. Missing historical structure means unavailable evidence, never
   proof that no call occurred. Failed/aborted turns remain excluded under the
   current contract; MVP-4's proposed markers remain independently gated.
4. Make this projection the normal behavior under existing memory policy. It
   adds no setting or raw-content toggle. CR-70's separate user-scoped toggle,
   live-content, reseat and provider-conformance decisions stay deferred.
5. Reuse the same bounded receipt projection in summarizer input. Exact receipts
   are dropped/rebased with their turns only after successful atomic compaction
   or trim; a generated summary is lossy, untrusted historical data, not an exact
   receipt archive. Preserve request measurement, four-pass fit, rollback,
   cancellation, `/trim` message units and durable boundary identity.
6. Bound output and retained auxiliary receipt state so the correction cannot
   accumulate a second unbounded transcript. Disclose unavailable/omitted detail
   without treating absence as evidence of no activity. Measure the added request
   bytes/tokens and local projection cost before acceptance.

Considered keeping text-only requests (rejected for this correction: it leaves
the reported evidence gap), retaining full raw tool content now (rejected: it
advances separately scheduled privacy/provider work), writing raw results or
paths into history (rejected: unnecessary sensitive persistence), reconstructing
synthetic protocol pairs (rejected: no actual result is available), and asking
the model to reread everything (rejected: rereading cannot prove historical
authorship and adds calls). Chose existing content-free structure because it
supplies the missing historical fact with a narrow disclosure footprint.

## Consequences

### Positive

- Later requests have direct evidence of earlier recorded calls, including after
  resume/reseat, without raw tool content or a storage migration.
- The correction keeps CR-70, MVP-4 and MVP-5 in their approved schedules.
- Provider adapters receive ordinary text data; no reasoning/signature replay or
  fabricated tool pair is introduced.

### Negative

- Receipts cannot identify a file path or recover earlier file contents. Keep
  that limit explicit; full raw-content continuity remains separate work.
- Added request data costs input tokens and can affect latency. Use strict caps,
  whole-record omission and matched request-size/latency checks; claim no speedup
  from this context correction.
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

Required tests cover successful create/read followed by another turn; multiple
calls with mixed outcomes; empty finals; normal, resumed and reseated parity;
all memory policies; legacy gaps; missing/mismatched/duplicate structural
identities; byte/count limits and auxiliary-state eviction; request ownership;
compaction success/failure/abort and trim rebasing; overflow measurement; and
no argument/result/path/media/signature leakage into notes, history or export.
Verify stale receipts cannot bypass fresh-read, policy, approval or non-replay
controls. Use real provider conformance for ordinary text projection where
available; offline scripted tests do not establish model behavior or network
latency. No paid replay is authorized by this proposal.

On acceptance, append dated forward notes to ADR-0095/0059/0062, promote the
canonical draft, update chat/reseat disclosures and the deferred-work cross-link,
then implement. Do not mark CR-70 complete, change its release trigger or activate
MVP-4/5. Until then, the current stable text-only request contract still applies.
