# ADR-0123: Restored transcripts use host-recorded display text

- **Status**: Accepted
- **Date**: 2026-11-09
- **Related**: [ADR-0050](0050-cli-history-db-at-rest-posture.md), [ADR-0059](0059-cli-mid-session-model-reseat.md), [ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md), [ADR-0062](0062-context-compaction-and-cli-history-commands.md), [ADR-0081](0081-the-compaction-summary-is-untrusted-and-the-system-prompt-is-branded.md), [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md), [ADR-0096](0096-a-request-is-measured-before-it-is-sent.md), [ADR-0119](0119-an-interrupted-turn-stays-as-a-content-free-marker.md), [ADR-0122](0122-the-home-is-the-interactive-product.md), [session contract](../reference/contracts/agent-session-spec.md#proposed-user-display-text--mvp-2), [MVP-2 plan](../roadmap/phases/phase-2.6-conversational-authoring.md#mvp-2-preflight-and-execution-proposal--2026-11-09)

> **Accepted 2026-11-09.** The maintainer authorized resolving the supplied
> document-review findings, accepting the corrected contracts and proceeding with
> the four-step implementation. Acceptance settles this design, not shipping or
> completion of the required implementation reviews.

## Context

MVP-2 must repaint a resumed conversation without displaying attached file or
command-output contents. The live CLI already has two representations: expanded
user text for the model and compact text for the view. Only the expanded text is
persisted. ADR-0059's 2026-07-12 correction explicitly records that attached content
survives resume and model reseat as user text.

The plan's literal equality between the display and restored model context cannot
hold for an attachment. Reconstructing the original compact text from arbitrary
stored prose cannot reliably recover its provenance. Reusing the existing
denormalized `content` column would also violate ADR-0095: that column must match
the canonical text, and the store checks it on write and read.

The solution must preserve the existing model context, export, completed-turn
identity, compaction boundaries and at-rest posture. It must also handle older
history without rewriting it or presenting guessed display text as the original.

## Decision

**Persist the host's compact user display text separately from the model-facing
content, atomically with the completed turn. Restore the view from that display
text, while the engine continues to reconstruct its context from canonical
content.**

The optional user-row metadata and its nullable storage addition have one home in the
[database contract](../reference/shared-core/database-schema.md#proposed-user-display-storage--mvp-2).
The [session contract](../reference/contracts/agent-session-spec.md#proposed-user-display-text--mvp-2)
defines its relationship to canonical history. `SessionMessage`, model restore
and the export representation stay unchanged. No provider type, LLM seam field,
tool result, secret-input field or new dependency is introduced. A display field
is presentation data, never model instructions or filesystem authority. Normal
terminal sanitization still applies.

The CLI records display text at the existing submit boundary, before expanded
attachments can be confused with the compact prompt. All fresh, resumed, Home
and reseated sessions, including a fresh session started after `/clear`, use
that submit boundary. `/clear` itself restores no entries. A host must explicitly
supply the display form it captured before attachment expansion, including for
a plain prompt. A caller without that form leaves metadata absent; the persister
never infers it from canonical submitted text or equality of strings. Plain/JSON
drivers explicitly pass their captured input line as display text because they
perform no attachment expansion. A failed or aborted turn keeps today's
no-transcript-write behavior. MVP-4's still-Proposed ADR-0119 owns interruption
markers; if accepted, its user-row insert must atomically carry the same captured
display metadata. This ADR neither accepts nor implements ADR-0119 early.

For legacy user rows with no display metadata, show a fixed explanation that the
older prompt's display form was not stored and may contain attached context.
Hide that entire user row's original text and replace it with the fixed display
notice, rather than guessing a frame boundary or exposing an ambiguous tail.
This conservative fallback also hides ordinary legacy prompts;
the notice says why. Do not infer host provenance or safe absence of attachments
from a nonce, a syntactically valid tag or a failed pattern match. Assistant text
remains visible. Historical rows and model context remain intact.

The archive view and model restore share the existing structural history **rules**,
not an identical selected set. Archive display enumerates completed turns with
`completedSessionTurns(messages, false)` plus compatible legacy prefix/trailing
context, ignoring the drop boundary. Model reconstruction honors that boundary
through `resumableSessionMessages`; it also omits empty assistant terminal text
while retaining that exchange's user and completed-turn identity. The view keeps
an empty answer entry. Canonical [restore-display rules](../reference/cli/chat-session.md#proposed-restored-transcript-display--mvp-2)
define the archive/retained relationship and its tests. Compare retained identities
before same-role request folding with real reconstruction, accounting for the
intentional empty-terminal omission; independently check safe display substitution,
the UI cap and authored memory projection. Do not assert archive/model sequence
or raw string equality, and do not duplicate the structural parser in the UI.

The divider describes the saved context boundary, not a promise that every visible
turn will enter the next request: `memory` still controls request selection. A
summary can survive a later `/trim`; the view must distinguish summarized history
from subsequently trimmed history without presenting the summary as an authored
system instruction. Exact UI behavior belongs to [chat-session.md](../reference/cli/chat-session.md).

The approved 500-entry full-screen and 200-entry inline limits bound the restored
prefix, including restore notices, dividers and legacy placeholders. Subsequent live entries retain today's
append behavior. These are entry-count limits, not a byte bound or a claim that
the model restores only that prefix. Keep caches scoped to retained entries and
test rich assistant messages, large individual messages and a 5,000-turn archive.
No new silent content truncation is authorized by this decision.

Considered using canonical user text for repaint (rejected: reveals attached
content), recovering compact text with tag/nonce heuristics (rejected: no reliable
display provenance), and changing the model transcript to the compact form
(rejected: loses intended context and changes resume/export semantics). A separate
display field preserves both existing meanings with one additive migration.

## Consequences

### Positive

- New conversations repaint the same user-visible prompt after restart, without
  attached bodies entering the view, copy hatches or input history.
- Model context, money, tool structure and export remain governed by their existing
  contracts. Display selection is tested against actual restore behavior.
- Older archives remain usable without destructive migration or invented history.

### Negative

- Shared metadata validation and DB mapping gain an additive public field and a migration;
  both require direct boundary/upgrade tests and a resume security sitting.
- Some legacy user prompts are replaced with a clear notice. The original remains
  in the unencrypted archive under ADR-0050 and may still enter model context;
  hiding it on screen is not content redaction at rest or revocation of egress.
- Display text duplicates some user text in the existing unencrypted database.
  It must never be populated from an expanded attachment or a tool result.
- An older binary ignores the new nullable storage column and writes rows without
  display metadata; the new reader applies the conservative legacy fallback.
  No historical display value is backfilled or old migration rewritten.

## Acceptance and landing

The maintainer approved this decision on 2026-11-09. Land strict role-restricted metadata validation, atomic round-trip storage,
an additive migration, upgrade coverage and all submit paths together before
repaint consumes the new field. Update the canonical contracts in the same step.
An unreadable or invalid display-metadata result refuses interactive restoration
before host activation with a fixed diagnostic and retry/return action. It never
falls back to canonical user text. Canonical machine resume does not read this
presentation metadata and keeps its current behavior.

Exercise both renderers, initial resume versus same-terminal reseat, attachments,
legacy frame-like prose (including malformed-looking frames, never parsed to infer
display provenance), empty finals, legacy bare users,
compact then trim, each memory policy, disclosure acknowledgement and failure.
Seed no usage line for restored answers. A display-only operation must not cause
provider/MCP activity, tool re-execution or acknowledgement of an effect disclosure.

Until implementation and its required reviews pass, this ADR and its linked
accepted but unimplemented contracts do not describe shipped behavior.

## Implementation and review receipt — 2026-11-10

The approved display metadata, additive migration, separate safe projection and
Home/standalone restoration paths are implemented and independently accepted on
`development` at `cecb6191`. Four cumulative rounds resolved all verified
findings; the final complete round and separate D64 security sitting are clean.
The [step acceptance record](../roadmap/phases/phase-2.6-conversational-authoring.md#step-4-acceptance-2026-11-10)
records evidence and checkpoint gates. Earlier unimplemented wording records the
design stage; this receipt changes no decision or release rule.
