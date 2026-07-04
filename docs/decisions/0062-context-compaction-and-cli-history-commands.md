# ADR-0062: Context compaction — append-only conversation summarization and the CLI history commands (`/clear` · `/trim` · `/compact`)

- **Status**: Accepted
- **Date**: 2026-07-04
- **Related**: [ADR-0024](0024-agent-first-entry-point-agentsession.md) (the session engine this extends) · [ADR-0011](0011-internal-llm-abstraction.md) + [ADR-0030](0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md) (the `LLMProvider` seam this amends) · [ADR-0028](0028-workflow-resource-governance.md) (cost governance) · [ADR-0026](0026-session-export-to-workflow.md) (export of a compacted session) · [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md) (the `Esc`/EA7 abort a summarization call reuses) · [ADR-0059](0059-cli-mid-session-model-reseat.md) (mid-session reseat, which must carry the preamble). The append-only durable-transcript invariant and the row/column shapes cited below live in [database-schema.md](../reference/contracts/database-schema.md) and [session.ts](../../packages/shared/src/session.ts); the at-rest posture (unencrypted, `0600`/keychain, single-user local) is [ADR-0050](0050-cli-history-db-at-rest-posture.md).

## Context

A long `relavium chat` / Home session grows its transcript every turn. `AgentSession`
([ADR-0024](0024-agent-first-entry-point-agentsession.md)) accumulates a cross-turn
`#messages` array (text-only `user`/`assistant`) and re-sends it in full on each turn;
nothing bounds it. Two failure modes follow: (1) the request eventually **exceeds the
model's context window** and every further turn hard-fails; (2) well before that, the user
re-pays to send a large history each turn. The `[chat].max_messages` field is defined in
[config.ts](../../packages/shared/src/config.ts) and threaded to the CLI resolver
([resolve.ts](../../apps/cli/src/config/resolve.ts) L124) but is **never consumed** — a
dead field.

Phase 2.5.F was originally scoped to ship only the **deterministic** half — `/clear`
(fresh conversation) and `/trim` (bound history by `max_messages`, no LLM call) — and to
leave **model-summarised `/compact` to Phase 3** because the engine has no summarisation
primitive. The maintainer has **removed that deferral**: we build the summarisation
primitive now, and — per an explicit scope decision — we build the **full** context-
compaction story (manual **and** automatic), not merely the manual command.

The stakes: this is the first engine capability that **mutates a session's working
context**, the first that **spends tokens the user did not directly type** (auto-
compaction), and it touches the two most-protected boundaries. It must not violate the
load-bearing invariants — `packages/core` stays platform-free (CLAUDE.md #5), **no vendor
type crosses the `@relavium/llm` seam** (CLAUDE.md #4, [ADR-0011](0011-internal-llm-abstraction.md)),
the durable transcript is **append-only** ("never edited or deleted" —
[session.ts](../../packages/shared/src/session.ts) `SessionMessageSchema`), and every
token spent is accounted to the session budget ([ADR-0028](0028-workflow-resource-governance.md)).
Getting compaction wrong corrupts a user's working context **silently** and irrecoverably
for the model — so the design is conservative: nothing is deleted, every spend is visible,
and the full transcript always survives for export/audit.

## Decision

**We will add an append-only, resume-preserving context-compaction primitive to
`AgentSession`, drive it both manually (`/compact`) and automatically (a context-window
threshold), and add the sibling history commands `/clear` and `/trim` — reviving the dead
`max_messages` field.** The summary is produced by the session's **own bound model**
(reusing the memoized `#plan`; no second model binding — [ADR-0024](0024-agent-first-entry-point-agentsession.md)).

### 1. The summary is a session-level system-prompt preamble; recent turns stay verbatim

Compaction summarises the earlier working context into one text summary stored as a
session-level `#contextPreamble: string | undefined`. `#runTurn` prepends it to the agent's
`system_prompt`, XML-wrapped for structured attention:
`system = agent.system_prompt + "\n\n<earlier-conversation-summary>\n" + preamble + "\n</earlier-conversation-summary>"`.
(`#runTurn` already builds `system` from the plain `agent.system_prompt`, so the
concatenation is a local change.)

**Recency is kept verbatim (K ≥ 1).** Compaction folds everything **except the last
complete `user`+`assistant` exchange**, which stays in `#messages` word-for-word. The
model therefore always sees the immediate turn it is mid-iteration on, not only a lossy
summary of it. This is free under the preamble model: the kept exchange is already a
clean alternating pair, so there is **no alternation hazard** (the hazard the rejected
alternative — injecting the summary as a `user`/`assistant` transcript message — would
have hit; a summary message either forces an `assistant`-first array Anthropic rejects, or
sits next to the next real `user` turn as two consecutive user messages). The kept window
is a small constant today (the last exchange); a token-budgeted window (e.g. keep the last
~25 % of the context verbatim) is a clean later refinement of the same mechanism.

### 2. Persistence: one append-only marker row, a typed nullable column, no destructive edit

On compaction the **host** persister appends **one** new `session_messages` row — a
**history-boundary marker** — at the next `sequenceNumber` (the engine mutates only its
in-memory state; see §3 for the producer/consumer split). Original rows are **never** edited
or deleted (honouring the append-only invariant; a flag-flip on existing rows is rejected
precisely because it mutates persisted rows). The marker is `role: 'system'` with the
summary text as its one `text` content part (empty for a `/trim` marker). Its boundary is
carried by a **new typed nullable column** `session_messages.compaction_dropped_through_sequence`
(a standard additive `@relavium/db` migration) surfaced as an **additive optional field**
`SessionMessage.compaction?: { droppedThroughSequence: number }` on the **lenient** (not
`.strict()`) `SessionMessageSchema`.

> **Why not a new `DurableContentPart` variant (correcting the first draft).**
> `DurableContentPartSchema` ([content.ts](../../packages/shared/src/content.ts) L626) is a
> **closed `z.discriminatedUnion`**; adding a `'compaction'` arm is *breaking to add later*
> for any older reader (exactly the hazard [ADR-0030](0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md)
> names). A row carrying an unknown durable part would fail to parse forever after (the
> transcript is append-only). A typed nullable **column** avoids this entirely: an older
> CLI simply does not read the new column and parses the marker as an inert
> `role: 'system'` text row (which resume already drops — §3). The tradeoff is honest: this
> is a **standard migration** (one nullable column, no DDL rewrite, no data change), **not**
> "no migration" as the first draft wrongly claimed; and a **downgrade** (a new `history.db`
> opened by an *older* CLI) silently loses the compaction semantics — acceptable and
> documented under the single-user local at-rest posture ([ADR-0050](0050-cli-history-db-at-rest-posture.md);
> there is no heterogeneous reader fleet). Forward compaction (new CLI, old db) is fully
> compatible.

`/trim` uses the **same** marker with an **empty** summary (a deterministic drop, no LLM
call) — one unified boundary mechanism for both commands. The full pre-compaction transcript
stays intact for `chat-export` ([ADR-0026](0026-session-export-to-workflow.md) — the
serializer treats a marker row as an inert divider, exporting the full linear transcript)
and audit.

### 3. Resume — the preamble is NOT the boundary; the producer/consumer split

`reconstructSessionState` ([session-resume.ts](../../packages/core/src/engine/session-resume.ts))
gains marker handling. Two distinct quantities, **separated** (correcting a "last-marker-wins"
conflation that would drop a summary):

- **The drop boundary** `D = max(marker.compaction.droppedThroughSequence)` across *all*
  markers (monotonic, so effectively the newest marker's). Only `user`/`assistant` rows with
  `sequenceNumber > D` are projected into `#messages` (then the existing trailing-unanswered-
  `user` rollback applies).
- **The preamble** = the summary text of the **newest marker that HAS a summary** (a
  `/compact` marker), NOT merely the newest marker. This is what makes `/trim`-after-`/compact`
  correct: a later summary-less `/trim` marker advances `D` but must **not** blank the
  preamble — the earlier `/compact` summary survives. (The middle turns the `/trim` dropped
  are gone — trim is intentionally lossy — but the older summary is preserved.)

The marker row (`role: 'system'`) is **excluded** from the `user`/`assistant` projection, so
it never replays as a message. **Producer/consumer:** the **engine** (`AgentSession`)
empties/repoints its in-memory `#messages`, sets `#contextPreamble`, and **emits**
`session:compacted`; the engine **persists nothing** (CLAUDE.md #5). The **host** persister,
subscribed to the session stream, writes the marker row on that event (parity with how it
already writes transcript rows on `session:turn_completed` and flushes cost) —
[persister.ts](../../apps/cli/src/chat/persister.ts), `SessionStore.appendMessage`.

**Reseat interaction ([ADR-0059](0059-cli-mid-session-model-reseat.md)).** Mid-session model
reseat rebuilds the session through the **same** `reconstructSessionState` → `AgentSession.resume`
path, so a compacted session **carries its preamble across a reseat** (guaranteed by the
marker handling above — without it, reseat would silently re-expand the full history into the
new model, the exact opposite of compaction). And because the auto-compaction threshold is
**per-model** (§5), the first turn after a reseat to a **smaller-window** model re-evaluates
the threshold against the new window — a transcript under the old model's limit that now
exceeds the new one auto-compacts on the next turn rather than hard-failing. Final ADR-0059
wording is reconciled with this section.

### 4. Seam amendment — `estimateTokens` / `contextLimit` / `managesOwnContext`

We add three methods to the `LlmProvider` seam
([types.ts](../../packages/llm/src/types.ts) L472), all expressed in **Relavium/Zod seam
types only** (no vendor type crosses — CLAUDE.md #4):

```ts
// additive, OPTIONAL methods (the seam's established capability-varying pattern, cf. generateMedia?)
contextLimit?(model: string): number;                    // the model's context window in tokens
managesOwnContext?(): boolean;                           // provider bounds context itself ⇒ skip compaction
estimateTokens?(input: {                                 // per-provider token estimate — a FALLBACK only
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly tools?: readonly ToolDef[];
}): number;
```

They are **optional** on the interface (so a test double or a future adapter is not forced
to implement them) but implemented by all three real adapters (Anthropic, OpenAI/DeepSeek,
Gemini): `contextLimit` returns the adapter-local `MODEL_PRICING[model].contextWindowTokens`
(the catalog lives inside `@relavium/llm`, so the adapter reads it directly — no new cross-
package import); `managesOwnContext` returns `false` for all current providers; `estimateTokens`
is a per-provider heuristic used only when there is no real usage yet.

> **Considered — a lighter amendment.** The alternative was a **single** additive
> `CapabilityFlags.managesOwnContext` flag plus deriving the context window in `packages/core`
> from the pricing catalog and driving the threshold off **real provider usage** (which the
> engine already has each turn), adding **no** seam method. Two of the reviews favoured it as
> the smaller seam surface with lower per-provider-tokenizer drift risk, and it is a defensible
> choice. The maintainer chose the **fuller method surface** here — recorded honestly — so that
> the seam carries a first-class per-provider token/context vocabulary (usable beyond
> compaction) rather than the engine reaching into the catalog. Real usage remains the
> **authoritative** trigger source (§5); `estimateTokens` is only the pre-first-turn fallback,
> which contains the tokenizer-drift concern.

### 5. Automatic compaction — real-usage trigger, guarded, cost-accounted

After a turn **completes successfully**, the engine compares the turn's **real** input-token
usage (`result.usage.input` — the same value emitted on `session:turn_completed.tokensUsed.input`,
**not** the per-attempt `cost:updated` increment) against `contextLimit(model) × threshold`.
Real usage is authoritative; `estimateTokens` is used only when no turn has completed yet.
Over the threshold ⇒ auto-run the compaction primitive **before the next turn**
(`reason: 'auto-threshold'`).

- **Config gate.** `[chat].auto_compact` (default `true`) and `[chat].compact_threshold`
  (default `0.8`, i.e. compact when the last turn already filled 80 % of the window — at which
  point the next turn would likely overflow). Both optional; strict-config
  ([ADR-0033](0033-strict-config-files-amends-0023.md)) still fails loud on a typo. The `0.8`
  default leaves headroom for the next turn's user message + reply; a window-scaled headroom
  formula (better for a 1 M-token model, where 20 % is 200 K wasted) is a documented future
  refinement, not v1.
- **Thrash / cost guards.** Auto-compaction is skipped when `#messages` holds ≤ 1 exchange
  (nothing meaningful to fold), and when the **projected** post-compaction input (system +
  preamble + kept exchange) would *still* exceed the threshold (compaction cannot help — a
  single oversized turn) — in that case the overflow is surfaced actionably rather than
  looping and burning tokens each turn. After a manual `/compact`, the next turn's input is
  small, so the auto-check is naturally a no-op (no double compaction).
- **Short-circuits.** Skipped when the model is absent from the catalog (a custom base-URL id
  — the window is unknown, so degrade to no auto-compaction; **manual `/compact` still works**,
  it needs no window) and when `managesOwnContext()` is `true`.
- **Failure path.** The summarization is itself an LLM call and can fail, time out, or be
  `Esc`-aborted (EA7, [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md)). On any non-
  success the engine **degrades to a deterministic `/trim`** (zero-cost, bounded) and the host
  shows a notice; it **never** silently sends the overflowing turn. The summarization call is
  abortable via the same `Esc`/`AbortSignal` machinery.
- **Cost is honest.** The summarization call's usage is accounted via `cost:updated` (session
  budget, [ADR-0028](0028-workflow-resource-governance.md)) and reported on `session:compacted`;
  it is **not** a `sendMessage` user turn and does **not** count against the `[chat].max_turns`
  hard cap. Auto-compaction never spends tokens invisibly (see §7 UX).

### 6. Tool-response accumulation and oversized single responses — why neither is built here

Two adjacent context problems are **out of scope** for this ADR, with reasons (so this is a
reasoned boundary, not a silent skip):

- **Cross-turn tool-call/tool-result accumulation: does not exist in this design.** The turn
  core keeps `tool_use`/`tool_result` pairs **internal to a turn**; they never enter the
  cross-turn `#messages` ([agent-session.ts](../../packages/core/src/engine/agent-session.ts)
  L428–438). There is no accumulation to summarise — building a tool-pair layer would solve a
  problem the architecture already prevents.
- **Oversized single tool responses: orthogonal, already bounded.** Externalizing a huge tool
  output to a file and returning a path is a **within-turn** output concern; Relavium already
  bounds tool output for the model (`boundForModel` / the process-arm output bound). If revisited
  it is a separate feature with its own sandbox/path review, not part of conversation compaction.

### 7. The three commands and their UX

All three land in the curated `REPL_COMMANDS` registry
([ADR-0056](0056-cli-in-app-slash-command-system-and-manifest.md)) with matching
`ReplCommandContext` capabilities (the context gains a handle onto the live `AgentSession` +
its persister, which `/compact` and `/trim` need); the `/` palette, `/help`, and the unknown-
slash hint derive from the one registry.

- **`/clear`** (`destructive`; both surfaces) — transition the current session to `'ended'`
  (still persisted + resumable), tear its persister down cleanly, and start a **fresh**
  `AgentSession` + persister under a new `sessionId`. A host-level lifecycle action (no engine
  primitive). Its notice surfaces the **old** `sessionId` + `relavium chat-resume <id>` so the
  prior conversation is discoverable, not merely theoretically recoverable.
- **`/trim [n]`** (`read`; chat-only) — deterministic: keep the last `n` messages (default
  `[chat].max_messages`), drop older, **no LLM call**. Accepting an inline `n` removes the
  config-first friction (a bare `/trim` with no `max_messages` set prints an actionable notice
  pointing at both the config key and `/compact`, never a silent no-op). When the history is
  already within the bound it says so ("already within the N-message limit — nothing to trim")
  rather than doing nothing silently. The same trim mechanism is the auto-compaction failure
  fallback (§5).
- **`/compact`** (`write`; chat-only) — model-summarised (§1), append-only (§2), cost-accounted
  (§5). It reports **both** token axes unambiguously so the user knows what they spent and what
  they gained — e.g. *"Compacted ≈14,200 conversation tokens → a 340-token summary (spent
  15,000 in + 340 out, $0.0008)."* The summary is **visible**: the transcript shows an
  expandable "compacted" boundary (the marker's summary text is already durable, §2), so a
  lossy, paid operation is inspectable, not hidden. Because the user typed `/compact`
  intentionally and the full transcript is preserved (recoverable via export), no blocking
  pre-confirm is required; a preview-then-confirm is a possible later enhancement.

**The compaction moment is a designed state.** The summariser's `agent:token`/tool events are
**not** forwarded to the transcript stream (the internal summary must never render as a chat
reply); instead the host drives a live "Summarizing conversation… · Esc to cancel" indicator
off the compaction lifecycle — for an auto-compaction the existing "turn running" indicator
naturally covers it (it runs inside `sendMessage`, before it resolves), and for a manual
`/compact` the host shows a spinner while awaiting `compact()`. On failure it shows the
degrade-to-trim notice (§5). A light **context-fullness indicator** (last input tokens ÷
window) rides the existing 2.5.C footer hint-bar, so auto-compaction is anticipated, not a
surprise. Every compaction emits an inline notice (`⟳ Context compacted — …`) on the
`session:compacted` event, never a silent context swap.

**The summarization prompt is the product.** Summary quality is the feature; the prompt is a
first-class artifact with a canonical home ([chat-session.md](../reference/cli/chat-session.md)
§ compaction). Its invariant, pinned here: the summary MUST preserve **open tasks, decisions
taken, code identifiers / file paths in play, and stated user preferences** — a summary that
loses these fails the feature. The full prompt text lives in that reference, derived once,
never restated (CLAUDE.md #8).

### Implementation scope

- **`@relavium/shared`**: `session:compacted` **and** `session:trimmed` arms on `SessionEventSchema`
  (a trim is a distinct, cost-free shape — `keptMessageCount`/`droppedMessageCount`, no `summary`, no
  `tokensUsed`); both additive to the closed live union (a `default`-arm consumer ignores an unknown arm
  forward-compatibly — there is no `assertNever` over it); optional `SessionMessage.compaction` field;
  `[chat].auto_compact` + `compact_threshold` config.
- **`@relavium/llm`**: optional `contextLimit` / `managesOwnContext` / `estimateTokens` on
  `LlmProvider`, implemented in the three real adapters.
- **`@relavium/db`**: one additive nullable column + mapper round-trip; a standard migration.
- **`@relavium/core`**: `AgentSession.compact()` / `trimHistory()`, `#contextPreamble`, the
  post-turn auto-threshold gate + guards, `#runTurn` preamble injection, `reconstructSessionState`
  marker handling (preamble ≠ boundary).
- **`apps/cli`**: persister marker write + cost flush; `/clear` / `/trim` / `/compact` in
  `REPL_COMMANDS` + `ReplCommandContext` + the chat/Home dispatch; the notice, moment-state,
  footer indicator, and expandable summary; resume + reseat e2e.

### Flow

```mermaid
sequenceDiagram
  participant U as User / REPL
  participant S as AgentSession (engine)
  participant P as LlmProvider (seam)
  participant H as Host persister
  U->>S: /compact  (or: turn completes, usage.input > limit×threshold)
  S->>P: summarize(preamble + folded #messages)  [emits agent:token → "Summarizing…"]
  alt success
    P-->>S: summary + usage
    S->>S: #contextPreamble = summary; keep last exchange in #messages
    S-->>H: session:compacted {summary, droppedCount, tokensBefore/After, cost}
    H->>H: append role:system marker row (droppedThroughSequence) + flush cost
    S-->>U: ⟳ notice + expandable summary
  else failure / Esc
    S->>S: degrade to deterministic trimHistory(max_messages)
    S-->>U: notice: summarization failed → trimmed instead
  end
  Note over S,H: resume → reconstructSessionState: preamble = newest marker WITH summary;<br/>working msgs = seq > max(droppedThroughSequence)
```

### Refined during step-1 review (implementation notes)

Clarifications surfaced by the step-1 adversarial review — refinements of this decision, not reversals:

- **The write-side boundary mapping is role-filtered (a silent-data-loss trap to avoid).** The engine is
  platform-free and owns no durable `sequenceNumber`, so `session:compacted`/`session:trimmed` carry
  `keptMessageCount` (how many trailing in-memory messages stay verbatim). The host maps it to
  `droppedThroughSequence` by walking the durable transcript **counting only real `user`/`assistant` rows —
  excluding prior `role:'system'` marker rows** — keeping the last `keptMessageCount` of them; `D` = the
  `sequenceNumber` of the last dropped real row (nothing dropped ⇒ no marker). It must **not** be derived
  from raw `MAX(sequenceNumber) − keptMessageCount` arithmetic or an unfiltered `LIMIT`: once a session has
  compacted once, an interleaved marker row makes that arithmetic off-by-one and silently drops a message
  the user meant to keep. On a resumed process the persister must seed this from `loadMessages` (role-filtered).
- **The auto-compaction threshold uses the SERVING model's window, not the primary's.** The check compares
  the last turn's real input against `contextLimit(result.model) × threshold` using **`result.model`** (the
  model that actually served the turn under fallback), not `agent.model` — else a fallback to a smaller-window
  model checks the wrong (primary's) window and defeats the safety net exactly when a session is unstable.
  `contextLimit`/`estimateTokens` must be passed the **canonical** model id `MODEL_PRICING` is keyed on.
- **Config plumbing must reach the engine.** `auto_compact` / `compact_threshold` need a `resolve.ts` read-site
  (like `maxMessages`) threaded into `SessionDeps` — not hardcoded at construction — or they re-become dead fields.
- **Unrelated to the reserved `agent:context_compacted` steering event.** The Phase-1-reserved, still-unemitted
  `agent:context_compacted` / `agent:context_cleared` are a **different** feature (a run-scoped steering channel
  whispering to an in-flight workflow `agent` node); `session:compacted` here is session-scoped history
  compaction. Different scope, trigger, and namespace — they do not share a mechanism.
- **The durable marker persists only the summary + boundary, by design.** `reason` / `tokensBefore` / `tokensAfter` /
  the summarization `tokensUsed` live on the transient `session:compacted` event (the live-moment cost UX, §7),
  not on the marker row. A historical `chat-export`/audit view recovers the summary text and boundary, not the
  "why"/"at what cost"; a richer audit column is a future add, not a v1 gap.

## Consequences

### Positive

- **A long chat no longer hard-fails at the context window** — auto-compaction bounds the
  request, `/compact` gives manual control, `/trim` gives a zero-cost deterministic bound;
  `max_messages` is no longer dead.
- **Append-only, resume-preserving, reseat-safe, audit-safe.** Nothing is deleted; the full
  transcript survives for export/audit; a compacted session stays compacted across `chat-resume`
  **and** a model reseat; the preamble is never dropped by a later `/trim`.
- **Recency is never lost to the model.** The last exchange stays verbatim (K ≥ 1); the model
  keeps the turn it is iterating on.
- **Cost is honest and the moment is visible.** Every summarization token is accounted to the
  session budget and shown; the compaction moment has a designed live state, a failure degrade,
  a footer fullness indicator, and an inspectable summary — no silent spend, no apparent freeze.
- **The seam gains a first-class token/context vocabulary** (`estimateTokens` / `contextLimit`
  / `managesOwnContext`) in Relavium/Zod types only — no vendor type crosses; `packages/core`
  stays platform-free; the summary rides the per-turn system prompt (no alternation hazard).
- **Forward-compatible persistence with no destructive change** — one additive nullable column;
  an older reader treats a marker as an inert system row.

### Negative

- **Compaction is lossy for the model's working context**, and **repeated** compaction is
  progressively lossy — a second compaction summarises the *preamble + post-compaction turns*,
  not the full original transcript, so a very long session that compacts several times produces
  progressively coarser summaries (a summary-of-a-summary lifecycle). Mitigation: the full
  transcript is always preserved durably (export/audit), the last exchange stays verbatim, and
  the summary is produced by the session's own model. Re-summarising from the full durable
  transcript, and layered (recent + deep) summaries, are documented future refinements — the
  degradation is disclosed and accepted for v1, not hidden.
- **Auto-compaction spends tokens the user did not type**, and the surviving preamble adds
  ~its-length input tokens to **every** subsequent turn. Mitigation: only at `0.8×window` (where
  the alternative is a hard failure), always accounted + visible + switchable off
  (`auto_compact = false`); the per-turn preamble cost is far below re-sending the full history.
- **Summary quality is bounded by the session's own (possibly cheap) model** — a low-quality
  summary degrades every subsequent turn. Accepted trade-off (the session is bound to one model,
  [ADR-0024](0024-agent-first-entry-point-agentsession.md); the same model best understands its
  own context); a configurable cheaper/stronger summarizer model is a documented future option.
- **A wider seam surface** (three optional methods) with **per-provider `estimateTokens` drift
  risk**. Mitigation: real usage is the authoritative trigger, so `estimateTokens` is only a
  pre-first-turn fallback; the methods are optional (non-breaking) and typed in seam types only.
  Two reviews preferred the single-flag amendment; the fuller surface is the maintainer's
  recorded choice.
- **A `@relavium/db` migration** (one nullable column) and additive `@relavium/shared`
  schema/event changes. Mitigation: additive and forward-compatible; a **downgrade** (new db,
  older CLI) loses compaction semantics — unsupported and acceptable under the single-user local
  posture ([ADR-0050](0050-cli-history-db-at-rest-posture.md)).
- **`managesOwnContext` is presently dead-`false` across all adapters.** Accepted as cheap,
  correct future-proofing that keeps the auto-compaction gate honest.
- **Roadmap reconciliation required.** Phase-2.5.F ([phase-2.5-cli-consolidation.md](../roadmap/phases/phase-2.5-cli-consolidation.md))
  still defers `/compact` to Phase 3 and forbids a stub; this ADR reverses that. The roadmap
  and its go/no-go (2.5.F acceptance; the 2.5.H "context-overflow → suggest `/trim`" hint, which
  auto-compaction now largely pre-empts) are updated in the implementing PR.
