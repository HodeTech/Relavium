# Agent Session Specification

- **Status**: Stable
- **Validated by**: the `AgentSessionSchema` / `SessionMessageSchema` / `SessionContextSchema` Zod definitions in `@relavium/shared` — `SessionContextSchema` lands with the event union (1.L.0); `SessionMessageSchema` / `AgentSessionSchema` land with the agent-first sub-spine (1.V/1.X), as they reference the shared-owned `ContentPart`
- **Canonical home**: the runtime contract for an `AgentSession` — its lifecycle, message shape, context, and export-to-workflow contract
- **Related**: [workflow-yaml-spec.md](workflow-yaml-spec.md), [agent-yaml-spec.md](agent-yaml-spec.md), [config-spec.md](config-spec.md), [sse-event-schema.md](sse-event-schema.md) (the `session:*` event namespace), [../shared-core/llm-provider-seam.md](../shared-core/llm-provider-seam.md) (the `LlmMessage` runtime type this maps to), [../shared-core/built-in-tools.md](../shared-core/built-in-tools.md), [../shared-core/database-schema.md](../shared-core/database-schema.md) (the `agent_sessions` / `session_messages` tables), [../../architecture/agent-sessions.md](../../architecture/agent-sessions.md), [../../decisions/0024-agent-first-entry-point-agentsession.md](../../decisions/0024-agent-first-entry-point-agentsession.md), [../../decisions/0026-session-export-to-workflow.md](../../decisions/0026-session-export-to-workflow.md)

An **agent session** is an ongoing, multi-turn conversation between a user and a single agent. It is
Relavium's **agent-first entry point** — a first-class peer of a workflow run that **reuses the same
engine substrate** (the `AgentRunner`, the `ToolRegistry`, the `@relavium/llm` seam, and the event
bus) rather than a parallel implementation; see
[ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md) for the decision and
[agent-sessions.md](../../architecture/agent-sessions.md) for how it is built. This document is the
**one canonical home** for the session *contract*; it **cites** the event schema, the DB schema, and
the seam rather than restating them.

> **Enforced source of truth.** The TypeScript shapes below are **illustrative**. The runtime-validated
> source of truth is the Zod schema set in `@relavium/shared`, from which the types are inferred
> ([ADR-0020](../../decisions/0020-zod-runtime-schema-library.md)). This document is the canonical
> human-readable contract; if the two diverge, this spec wins and the schema is corrected to it.

## What a session is (and is not)

- A session **binds one agent** (an `.agent.yaml`, [agent-yaml-spec.md](agent-yaml-spec.md)) for the whole
  conversation. There is **no mid-session agent switching**; multi-agent orchestration remains a *workflow*
  concern. The **model** and its memoized `fallback_chain`, by contrast, belong to the `AgentSession`
  **instance**: the CLI's mid-chat **reseat** (`/models`) resumes a *new* instance on the chosen model and
  rebuilds the chain for it — the session id is unchanged, the instance is not
  ([ADR-0059](../../decisions/0059-cli-mid-session-model-reseat.md); behaviour in
  [chat-session.md](../cli/chat-session.md#model-reseat-models)). Each instance still has exactly one model.
- A session is **multi-turn and stateful**: each user message produces an assistant turn that may
  include tool-call round-trips, exactly like a workflow `agent` node — the difference is the *entry
  point and lifetime*, not the execution.
- A session is **auto-persisted and resumable** (below); it is **not** a workflow run and does not
  appear in run history. It can be **exported** to a workflow ([export](#export-to-workflow)).

Request data handed to the controlled provider chain follows the
[seam's supported inert-data and ownership contract](../shared-core/llm-provider-seam.md#request-data-ownership).
The shared turn core captures before admission/money awaits and reuses its owned round through
pre-attempt hooks and dispatch, retaining live cancellation and creating fresh owned tool rounds.
The factory-measured first request can be reused by exact identity as described in the
[runner contract](../shared-core/agent-runner.md#pre-egress-injection-contract). Core reuse and Step 8's
session measurement, atomic compaction and overflow recovery have independent acceptance;
[final wave review](../../roadmap/phases/phase-2.6.5-core-reliability-remediation.md#w7-closing-register--2026-10-10) is accepted separately.

## Lifecycle

Hosts select primary delivery when constructing the session handle, following the
[stream consumption contract](sse-event-schema.md#primary-stream-consumption-in-process).
The CLI attaches live subscribers before production; standalone iterated hosts must drain the
primary stream and wire its readiness to the session. Session cancellation closes delivery
without inventing a replayable transient event log.

```mermaid
stateDiagram-v2
    [*] --> Idle: start(agentRef, context)
    Idle --> Streaming: sendMessage(text)
    Streaming --> Streaming: tool-call round-trip
    Streaming --> Idle: assistant turn complete
    Streaming --> Idle: abort (Esc) — turn ends, session lives (ADR-0057)
    Idle --> Idle: setTurnPolicy (reseat-less mode change, ADR-0057)
    Streaming --> Streaming: setTurnPolicy (stored; no effect this turn, applies next, ADR-0057)
    Idle --> Idle: resume (reload from history.db)
    Idle --> [*]: cancel / end
    Idle --> Exported: export → .relavium.yaml
```

| Operation | Meaning |
| --- | --- |
| **start** | Open a session for an `agentRef` with an initial [`SessionContext`](#session-context). Allocates a `sessionId` and persists the session row. |
| **sendMessage** | Append the pending user to the **working transcript**, run one assistant turn through the shared turn core (streaming + tool-call loop), and retain the final assistant **text** on success. The host atomically persists the completed turn's [durable messages](#session-messages), including content-free tool structure and an explicit terminal even for empty final text. Working context excludes tool pairs; carrying them to a later request is deferred ([ADR-0095](../../decisions/0095-what-an-agent-session-remembers-across-turns.md) §2). The request instead carries bounded, content-free [receipts](#content-free-action-receipts--adr-0128) of earlier completed turns' recorded calls and outcomes ([ADR-0128](../../decisions/0128-content-free-tool-receipts-ground-later-chat-turns.md)). |
| **setTurnPolicy** | Set/clear the **reseat-less mode policy** (ADR-0057) — the advertise-filter + the interactive approval hook — on the **same** session instance (no reseat, no tool-context loss). Snapshotted at each turn start, so a change applies on the **next** turn. The ask / plan / accept-edits / auto enum lives in the host; this is its mode-agnostic engine projection. Callable in any state, including mid-turn; **inert once cancelled** (a cancelled session runs no further turn, so the policy is never read again). |
| **abort** | **Mid-turn abort** (ADR-0057 EA7): end the *in-flight turn* via its `AbortSignal` but **keep the session alive** — settle **one** `session:turn_completed{stopReason:'aborted'}` (no error), and return to `idle`. A turn a provider had engaged in is **retained** as an interrupted turn ([ADR-0119](../../decisions/0119-an-interrupted-turn-stays-as-a-content-free-marker.md): the event carries `interruption: { reason: 'aborted' }`); one aborted before any provider engaged rolls its pending user message back. **Distinct from `cancel`** (which is terminal): no `session:cancelled`, no new status. No-op when no turn is in flight; a concurrent `cancel` wins. A **late** abort that lands after the turn already resolved is **also a no-op** — that turn completes normally and its reply is **kept** (`abort` interrupts an in-flight turn only, never discards a finished one). |
| **cancel** | Abort the in-flight turn via `AbortSignal` **and end the session** (the terminal `session:cancelled`); the session stays resumable from its persisted transcript. |
| **runUserCommand** | Run a **USER-invoked `!`-shell command** (2.5.D, [ADR-0061](../../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)) — the additive method that routes a shell escape through the **one** `run_command` dispatch boundary, **reusing the same dispatch-context construction as a turn** (`toolPolicy` allowlist, `fsScope`, `gateApproved:false`, the mode-aware `confirmAction`): `enforcePolicy(allowedCommands)` **before** approval → `spawn`/`shell:false`. The caller pre-tokenizes the line into `command` + `args` (no shell expansion); the user grant of `run_command` is scoped to this one-off dispatch and never reaches the model. Returns a classified `UserCommandOutcome` (`ran` \| `denied{allowlist}` \| `failed` \| `cancelled`) — no raw error escapes. Callable only when **started + idle** (a `!` never races a turn); leaves the session idle. |
| **resume** | Reload a persisted session (messages + context) and continue. |
| **compact** | Summarise the older working context, retain the latest complete exchange and append a durable boundary marker. Callable only when started and idle; returns a typed `CompactionResult`. Memory-policy refusal precedes no-op detection, provider planning, events and egress. |
| **trimHistory** | Keep a suffix under a message-unit bound, starting at a user boundary; append a marker without an LLM call. Callable only when started and idle; returns a typed `TrimResult`. Memory-policy refusal precedes bound/no-op checks and mutation. |
| **export** | Serialize the session to a `.relavium.yaml` scaffold ([export](#export-to-workflow)). |

The turn loop, tool dispatch, streaming, and fallback are the **same** code paths a workflow `agent`
node uses: the session is a thin wrapper over the **correlation-agnostic turn core** — the `runAgentTurn`
path the `AgentRunner` (1.O) also wraps for a workflow node — managing conversation state and context.
*(1.V drives that turn core directly; it does **not** route through the run-only `NodeExecutor` the
`AgentRunner` exposes. "Same `AgentRunner` path" means the shared turn-core execution, not the
`NodeExecutor` surface.)* The lifecycle emits the `session:*` event namespace — defined, with the run
namespace, in [sse-event-schema.md](sse-event-schema.md#session-event-namespace) (this spec does not
enumerate event names). 1.V keeps the conversation **in-memory** (the in-flight `LlmMessage`/`ContentPart`
form) and emits session events through an injected sink; wiring that sink onto the shared `RunEventBus`
(per-session `sequenceNumber` + gap/resync) is **1.W**, and the durable [`SessionMessage`](#session-messages)
schema + persistence is **1.X**.

### Request projection and history operations

The authored [`memory` contract](agent-yaml-spec.md#conversational-memory) selects one request
projection, also used by the session's context estimate. It applies to fresh, resumed and model-reseated
instances. Selection and summary placement happen before same-role folding; generated summaries
remain untrusted user-role data and cannot change the authored system prompt. Each request owns
its message/content arrays and text parts, so request consumers cannot mutate the working transcript.

`AgentSession.memoryPolicy` returns the copied, frozen policy. `automaticCompactionAllowed` exposes
its resolved permission independently of whether a trigger or budget permits a call. `compactionRefusal`
and `trimRefusal` expose the same `MemoryPolicyRefusal` that the operations return:
`{ kind: 'policy_refused', memory: 'none' | 'window', message: string }`. The message is a fixed,
secret-free explanation. Lifecycle misuse still throws `SessionStateError` before a policy outcome.
Hosts use these getters before progress or bound validation; the engine remains the authority.

`reconstructSessionState(record, messages)` returns a text-only, unfolded `SessionResumeState`.
Alongside its messages, costs and turn counter, it supplies required `completedTurnSpans`: ordered,
non-overlapping `{ start, end }` indices into that message array, with exclusive `end`. Each span
starts with a user and contains either that user alone for an empty final, or the user plus its final
assistant text. Structural durable rows are excluded. Legacy text remains outside spans rather than
being invented into a completed turn. The current pending user is tracked separately during a send.
Build resume state with this helper; `AgentSession.resume` validates span bounds, roles and text-only
parts before host cost callbacks, refuses invalid metadata with `SessionStateError` code
`invalid_resume_state`, and copies the admitted state. A compact/trim rebases surviving whole spans;
a failed, aborted or cancelled turn creates none.

### Content-free action receipts — ADR-0128

**Accepted 2026-11-15 ([ADR-0128](../../decisions/0128-content-free-tool-receipts-ground-later-chat-turns.md));
implementation status is recorded at the end of this section.** A session request
carries bounded, content-free *receipts* of earlier completed turns' recorded
tool calls beside those turns' text. Receipts are a projection of the durable
structure [ADR-0095](../../decisions/0095-what-an-agent-session-remembers-across-turns.md) §1
already stores. They are not carried tool content: no argument, result, path,
stored id or byte size survives into the request, and no tool-protocol message
is fabricated. CR-70's raw-content carrying remains separately deferred. The
acceptance cases live in the ADR and are not restated here.

- **Source and identity.** A completed turn's receipt records come from exactly
  two sources: the typed `SessionToolHistoryEntry[]` the turn returns on
  successful completion (the `toolHistory` field, already Zod-parsed and
  content-free; never `agent:tool_call`/`agent:tool_result` events, summaries or
  any other payload), or the completed durable turn's structural row pairs on
  resume/reseat. A record is one adjacent `assistant(tool_call)` + `tool(tool_result)`
  pair whose engine-form ids match. Pairing and uniqueness are validated **within
  one completed turn's inspected rows only**; an id is never used across turns and
  is never rendered, so a session-wide uniqueness property is neither needed nor
  claimed. This is structural validation, not authenticated proof of historical
  execution or registry membership: a modified store can forge a syntactically
  valid pair, so restored evidence is labelled an unverified local record. Do not
  infer receipts from assistant prose. A turn whose inspected rows are
  malformed (unpaired, mismatched or duplicate ids) yields **no receipts for that
  turn and is marked incomplete**; derivation never fails a resume and never emits
  a partial or guessed pair. Metadata that a host *supplies* to
  `AgentSession.resume` is a programming contract and is refused through the
  existing `invalid_resume_state` path when it violates the caps below.
- **Safe labels.** Only exact built-in tool ids from the code-owned catalog may
  be emitted as names. Every other historical/custom/MCP-discovered name becomes
  the fixed label `other_tool`, regardless of syntactic validity or current
  discovery. A call to the built-in `mcp_call` renders as `mcp_call`; a
  discovered external tool is indistinguishable from any other unlisted tool. This
  substitution makes no registry-membership assertion, including for a forged
  built-in name. Never echo a rejected name in a diagnostic. The stored name,
  id and outcome are classified at the reconstruction boundary into a closed
  record type (`label` is a built-in id or `other_tool`; `outcome` is the
  four-value enum) and the original strings are discarded there, so no free-form
  store- or model-chosen text can reach request text. Call ids serve only
  bounded internal pairing; render a per-turn ordinal instead.
- **Excluded data.** No stored ids, arguments, paths/targets, results, byte sizes, media,
  reasoning, signatures, native metadata or error bodies enter receipt notes.
  Receipt state is auxiliary to `messages` and never creates durable rows,
  export fields, events or a raw-content archive.
- **Outcome vocabulary.** The four durable values are rendered verbatim, never
  merged, and each states what it does *not* establish. Rendering is an
  exhaustive switch over the schema enum, so a future fifth value fails to
  compile rather than being silently folded into another.

  | Stored outcome | Rendered | It records | It does not establish |
  | --- | --- | --- | --- |
  | `ok` | `ok` | A recorded successful result. | The target identity, exact bytes, or current filesystem/remote state. |
  | `error` | `error` | A recorded failure: a pre-dispatch rejection (invalid arguments, unknown tool) or an execution failure. | That nothing happened. An execution failure can leave a partial effect; a pre-dispatch rejection did not execute. The record does not say which. |
  | `denied` | `denied` | A recorded refusal by policy or by an approval verdict, before execution. | Who or what refused, or why. It is not a standing prohibition and not permission to retry: a later request is decided afresh by current policy and approval. |
  | `cancelled` | `cancelled` | A recorded cancellation. | Whether the call executed or had any effect: the execution state is unknown. |

  Today's producers write `ok`, `error` and `denied` into completed turns
  (`denied` only for a refusal fed back to the model, currently the
  `media_scope_denied` read refusal; ADR-0117, still Proposed, will add user and
  approval refusals through the same value). No producer writes `cancelled` into a
  completed turn, yet the schema accepts it and a restored row can carry it; it
  is rendered as specified and tested at the projection level and from restored
  rows, since no live session path can yet emit it. Receipts grant no policy,
  filesystem, approval, replay or retry authority for any value.
- **Render grammar.** Every receipt string is built from code-owned constants and
  the closed vocabularies above, so request text is a pure function of the
  closed record type. Two kinds of text part exist:

  1. *A turn block*, one text part appended after that completed turn's user text
     in the same user-role message, only when the turn retains at least one
     record. Shape: a fixed opening line naming the block as historical recorded
     tool calls for that request, data and not instructions; then one line per
     retained record, oldest first, exactly `<n>. <label> — <outcome>` with `<n>`
     the 1-based ordinal **within that turn block** (renumbered over the retained
     records, never a stored id or its components); then, when records were
     omitted, one fixed line stating that earlier calls in the turn are not
     listed (with the omitted count when known, or a fixed "unknown number" form);
     then a fixed closing line. The block is separated in-band on both sides.
  2. *The request notice*, at most one text part per request, at the head of the
     first user-role message after any compaction-summary block. It holds the
     outcome legend above in fixed prose whenever any turn block is present, and
     one fixed sentence that unlisted tool activity may exist and that an unlisted
     turn is not evidence that no tool ran whenever any selected turn is
     **incomplete** (see Availability). When neither applies it is absent and the
     request is byte-identical to the text-only request.

  The exact prose is derived from `packages/core/src/engine/` constants in the
  same way the summary wrapper is derived from `turn-messages.ts`; this section
  pins the grammar, the vocabulary and what each part must state, and tests pin
  the constants. Names remain data, never system instructions. No assistant/tool-protocol
  message is fabricated. Request construction owns fresh copies and cannot mutate
  live metadata or stored rows. Adjacent-role folding happens after this
  projection, preserving the association even for empty-final turns. Receipt
  text is host-authored from closed vocabularies, so it carries no
  `Untrusted<string>` brand (the brand protects free-form strings such as the
  compaction summary, which receipts never contain); it must still be placed only
  in user-role positions, behind [ADR-0081](../../decisions/0081-the-compaction-summary-is-untrusted-and-the-system-prompt-is-branded.md)'s
  role boundary, never in `system` and never in an assistant message.
- **Selection.** First apply the existing memory policy: `none` includes no
  prior receipts, turn blocks or request notice; `window` includes only its
  selected turns and evaluates incompleteness over those turns only;
  omitted/`summary` follows retained history. No receipt creates a new completed
  turn or changes `/trim` message units, counters or durable boundary mapping.
- **Retention and bounds.** One ordered rule applies identically to a live
  session, to resume and to reseat. It is a pure function of the ordered
  completed-turn evidence, never of the order in which that evidence arrived,
  so every route to the same history retains the same records. Normal overflow is
  eviction, never an error.

  1. *Inspection* (derivation from durable rows only): walk turns **newest first**
     and, inside a turn, record pairs newest first, inspecting at most 256 parts
     per turn and 4,096 parts per operation, always at whole-record boundaries.
     Uninspected detail is unknown: that turn is marked incomplete. Never scan
     past the budget to count.
  2. *Per turn*: retain at most the newest 32 records and 4,096 UTF-8 bytes,
     counting wrappers and omission line; older records of the turn are omitted
     whole, in order, never partially truncated.
  3. *Across turns*: walk turns newest first and retain each turn's block whole
     while the running total stays within **128 records and 16,384 UTF-8 bytes**
     after reserving the request notice's fixed bytes. The first block that does
     not fit, and every older block, is omitted. Do not skip a large block to keep
     a smaller older one. There is **no separate cap on the number of turns**:
     only turns with at least one retained record cost anything, so the record
     cap alone bounds turn blocks. A turn that loses its record or its block to
     steps 2-3 is marked incomplete.

  The retained payload is bounded by step 3 in a live session as well (oldest
  block evicted when a new turn would exceed it); because eviction always removes
  the oldest retained block, the live result equals the newest-first result of
  step 3 over the same history. Beside the payload, each already-retained
  completed-turn span carries O(1) availability metadata. Check array and string
  lengths before copying, byte counting or uniqueness work; never reuse an
  unbounded history-array parse for this metadata. Use saturated counts with an
  explicit unknown state, never unchecked arithmetic. Derivation and projection
  are synchronous over these fixed caps and need no internal cancellation
  points; an operation that publishes receipt state observes its own existing
  cancellation immediately before its atomic installation. This bounds added receipt processing,
  not the existing whole-history load. All wrappers and notices count toward
  request admission and token measurement.
  Supplied auxiliary state is admitted only if it already satisfies steps 2-3
  (at most 128 records and 16,384 bytes in total, at most 32 records per turn);
  a host that derives it through this section's helper cannot exceed them.
  Typical reach is stated in the ADR; the cap that binds first depends on turn
  shape and is a measured property, not a promise.
- **Availability.** A turn is **incomplete** when any of its evidence may be
  missing: omitted or evicted by retention, uninspected, malformed, or
  *ambiguous*. A live turn that observed no tool call is known empty and is not
  incomplete. After resume/reseat, zero durable tool rows cannot distinguish a
  no-call turn from legacy missing structure because there is no completeness
  marker, so such a turn is ambiguous, hence incomplete; add no migration or
  marker to infer otherwise. Missing, evicted or uninspected evidence never
  means no call occurred. Incompleteness is disclosed **only** by the single
  request notice, never by a per-turn line, so a plain-chat history costs one
  fixed notice (and none in a live session, where every turn is observed).
  Live/restore parity applies to the retained records and to conservative
  meaning, not to exact knowledge of empty turns or exact omitted counts.
- **Compaction and trimming.** Feed the same bounded observations for the
  foldable turns into measured summarizer input. Current request construction
  alone is insufficient. Keep exact receipts only for surviving whole turns,
  rebased with their spans after an atomic successful compaction/trim. Failed or
  cancelled compaction keeps the original metadata. A generated summary can
  report earlier actions but remains lossy, untrusted text; it is not an exact
  receipt. Every summarizer pass measures its actual notes and keeps the current
  four-pass/all-or-nothing bounds and irreducible kept-turn floor.
  Preserve whole receipt records through the summarizer's oversized-message
  handling. A message's receipts are rendered beside its text and are never
  flattened into the text that head/tail truncation clips. If a message still
  does not fit with an empty text and its receipts, those receipts are dropped
  whole (disclosed by the notice, since the dropped state is incomplete) before
  the existing does-not-fit failure is reported. Never turn a clipped
  label/ordinal/outcome into a new record.
- **Lifecycle.** Publish receipt metadata only with the existing successful
  completed-turn installation; observer/durability failure rolls back its
  installation with the text. A process restart rebuilds only existing durable
  structural evidence; a model reseat follows the same reconstruction. This
  introduces no live raw-content handoff. Since ADR-0119 (MVP-3c) an engaged turn that
  ended by abort, a fatal denial or another classified error keeps its recorded calls
  and a fixed interruption note; a session-ending cancel, a crash and an unclassified
  throw still create no receipt even when a tool ran (the user-facing disclosure is
  [ADR-0098](../../decisions/0098-a-session-effect-row-holds-no-result-and-never-replays.md)
  invariant 4); [ADR-0119](../../decisions/0119-an-interrupted-turn-stays-as-a-content-free-marker.md)
  (Accepted 2026-11-16, MVP-3c) owns that gap — see
  [Interrupted turns](#interrupted-turns--adr-0119). Current cancellation, financial
  acknowledgement and session non-replay rules hold.

Measure the added request bytes/tokens and local cost against an otherwise
identical text-only baseline, including a plain-chat history with no tool calls
(live: no added bytes; restored: the one fixed notice). Do not treat synthetic
provider timings as a measurement of a real hosted model.

**Implementation status (2026-11-15):** implemented on `development` as one step
(the pure projection, live collection, resume/reseat derivation, request and
summariser integration, and the reseat notice). The independent review rounds,
the separate security sitting and the measured request-size results the ADR
requires are still owed; no merge or publication is claimed. Measured: the legend
is 409 bytes and the gap sentence 109 bytes; a block is 148 bytes for one record
and 791 for 32 (worst case 1,232, so the 4,096-byte per-turn cap cannot bind);
the 128-record cap binds first from about two calls per turn (107 turns of
evidence at one call per turn, 32 at four); projection and retention cost under
0.1 ms per 1,000 turns and derivation about 1 ms. See the ADR's implementation
note.

### Interrupted turns — ADR-0119

**Status: implemented on `development` (MVP-3c, 2026-11-16); its D64 review rounds and security sitting are owed.**
A session-ending cancel, a crash and an unclassified throw are still rolled back and forgotten (below).
[ADR-0119](../../decisions/0119-an-interrupted-turn-stays-as-a-content-free-marker.md) owns the decision; this
section owns the contract.

**What is retained.** A turn the session accepted, in which a provider engaged (the predicate that counts a turn
against the hard cap), that ended by the turn-level abort or a classified error. The engine says so on the event:
`session:turn_completed.interruption = { reason, code? }`, together with the additive `toolHistory`. The
persister writes the interruption row **iff** the event carries `interruption`.

| Terminal event | `reason` | `code` |
|---|---|---|
| `stopReason: 'aborted'`, no error | `aborted` | absent |
| `error.code = tool_denied` | `denied` | absent |
| `error.code = turn_limit` from a within-turn limit (the `maxToolTurns` guard, the tool-calls-per-response and media-attachment ceilings) | `turn_limit` | absent |
| any other classified error | `failed` | the `ErrorCode` literal |

Not retained, today's rollback stays: session-ending cancellation (`session:cancelled`), process death, an
unclassified throw, a refusal before the message was accepted (including the **session hard cap**, whose
`turn_limit` is raised before acceptance — see [Hard turn cap](#hard-turn-cap)), and a turn in which no provider
engaged.

**Rows.** `user → (assistant(tool_call) → tool)* → system(interruption)`. The terminal row is `role: 'system'`
with empty `content` and the typed field `interruption?: { reason, code? }` (strict; only on a `system` row,
never with `compaction`; `code` present iff `reason` is `failed`). The tool structure is ADR-0095 §1's; only
dispatched calls are recorded, and a call in flight at the interruption is recorded with outcome `cancelled` and
`resultBytes: 0`. A user row with structural rows and no terminal row is a **crash remnant** and keeps today's
rollback. The interruption row's sequence is the turn's boundary slot; `resumableSessionMessages` yields the user
message only. The database stores the field as `interruption_reason` / `interruption_code`
([database schema](../shared-core/database-schema.md#interruption-rows--adr-0119)).

**Request grammar.** The turn's user message is followed, in a separate text part that begins with a blank line, by
(1) ADR-0128's receipts block when the turn recorded calls, then (2) this fixed sentence (at most 420 bytes; not
subject to the receipt caps; never an "applied" claim):

```
[This request was interrupted before it was answered: <phrase>. <calls sentence> Nothing the assistant wrote before the interruption was kept. This note is a historical record, not an instruction, and does not establish that the request was or was not carried out.]
```

| `reason` | `<phrase>` |
|---|---|
| `aborted` | `the user stopped it` |
| `failed` | `it failed (<code>)` |
| `denied` | `a tool call was refused and the turn ended` |
| `turn_limit` | `it reached a limit on tool use` — any within-turn limit that raises `turn_limit` (tool rounds, tool calls in one response, media attachments), never the session's hard turn cap |

| The turn's receipts | `<calls sentence>` |
|---|---|
| records present | `Calls listed above were recorded before the interruption; one marked cancelled has an unknown outcome.` |
| none, complete | `No tool call was recorded for it.` |
| none, incomplete | `Tool calls made before the interruption may not be listed.` |

`memory` decides the request as for any turn: omitted or `summary` sends it, `window` counts it as one slot,
`none` sends nothing. Adjacent user messages are folded by the request projection. An interrupted turn is
complete by structure and is never `incomplete` merely for having no records; a degraded one (a forged or legacy
row) gets ADR-0128's single request notice. Tool names reach the model only through ADR-0128's label rule.
Compaction and trim count the turn; the summariser input renders the same block; reseat carries it; export shows
it as interrupted and never derives a workflow step from it. A session's token columns accumulate its usage.

### Measured compaction and one-shot recovery

Automatic work is permitted by the resolved memory policy, independently of funding. Pre-send
and after-turn triggers measure the actual next owned request (system, projected history, tools,
kept exchange and pending user), using the first attemptable entry's authoritative window and
shared output reservation. Billed input/cache/tool-round usage does not drive the trigger.
Unknown/custom windows and providers managing their own context skip automatic work. A trigger
compares input with `compactThreshold × window`, and input plus output reservation with the full
window. The irreducible kept exchange/pending user, tools, system and maximum summary wrapper
are compared with the full window; if they cannot fit, pre-send compaction is skipped and that
turn cannot start another recovery cycle. A failed/skipped pre-send operation sends the original
owned request. Budget refusal or cancellation sends no main request and settles the active turn.
`SessionDeps.afterTurnCompaction: false` disables only unused after-turn work; the CLI one-shot
uses it while retaining explicit summary permission at active entry points.

One inner operation shares the active turn's signal; idle `compact()` owns its own controller.
It greedily folds older whole messages through at most four budget-gated passes, keeping the
latest completed exchange, following legacy text and the explicit pending user verbatim.
Every summariser construction fits every known attemptable entry's measured input-plus-output
bound. An individually oversized foldable message uses disclosed head-and-tail truncation;
system text, running summary, kept exchange and pending user are never truncated. All passes
must succeed with nonempty text before one summary/history replacement and one boundary event.
Cancellation, refusal or failure installs no partial summary; engaged spend remains accounted.
`keptTurnCount` includes retained legacy user slots and empty-final exchanges, excluding the
pending user, so the persister advances only the dropped completed-history boundary.

For manual unknown/mixed-window compaction, each pass additionally respects the fixed 16,384-token
soft input bound. This is an operational bound, not model metadata or a fit guarantee. The
surface acknowledges a fixed unknown-window disclosure through `SessionDeps.onCompactionStart`
before the first admitted call can egress. A failed acknowledgement sends nothing. The callback
receives the current operation's signal and checks it before queued publication. Cancellation
races a pending acknowledgement, releases unused admission and returns the session to idle
without waiting for the terminal sink. Late acknowledgement/rejection is observed and grants
no egress authority. Automatic
paths never use the soft bound. All opened moments end with success, one failed-moment event,
or terminal session cancellation; first-admission refusal opens no moment.

`CompactionResult` distinguishes `budget_refused {message, momentOpened}` from ordinary `failed`,
`cancelled`, `nothing_to_compact` and policy refusal. Manual refusal returns its safe cap message
without a turn terminal. After-turn refusal preserves the successful reply and all history;
first-pass refusal emits a standalone side notice, later refusal closes the open moment once.
Budget refusal never trims. Ordinary after-turn failure retains the configured deterministic
trim fallback; cancellation does not trim. Active pre-send/recovery refusal settles one
`budget_exceeded` turn terminal naming the cap. Event shapes have one home in
[sse-event-schema.md](sse-event-schema.md#session-event-namespace).

### Financial request inputs

`SessionDeps.maxTokensEstimate` is an optional estimate-only fallback copied at construction. CLI
fresh/resumed/reseated chat and one-shot entry points pass the resolved config value, including when
no budget governor exists. The shared turn core estimates every current tool round before cross-provider
reasoning stripping and forwards required cap-plan/request identity, input estimate and the same frozen
fallback to admission. The canonical estimator, cap precedence, handoff and failure-evidence contract
lives in [llm-provider-seam.md](../shared-core/llm-provider-seam.md#current-request-estimates-and-bound-output-caps).
The same owned construction and cap authority govern measured session context and each compaction pass.

### Classified context-window failures

An unrecovered official, fixture-matched overflow settles the turn with `context_overflow`, never a
provider-authored message. The engine names the attempted model, its authoritative window
(or fixed `size unknown` wording) and whether tools already ran. The internal recoverability
fact is true only before any tool round or committed content; it is not persisted or emitted.
Before content/tool commitment, one genuine overflow may invoke compaction and one fresh measured
retry when automatic permission and an authoritative applicable window allow it. Observer failures
cannot forge this private invocation-bound evidence, even by rethrowing a genuine error from a
previous call. A failed/skipped prior pre-send operation suppresses
recovery. Nothing to fold or ordinary recovery failure retains the original overflow; budget refusal
settles `budget_exceeded`. Retry overflow is final. Main-attempt usage is accumulated across the two
attempts; summariser spend remains separate and never consumes a user-turn slot. A turn
that already dispatched tools is never restarted by this classification. Native Anthropic
context stops retain their actual usage through the failed turn and money ledger. The
[LLM seam](../shared-core/llm-provider-seam.md#classified-context-overflow) owns the dialect
criteria, custom-endpoint downgrade and admission-release evidence; the
[CLI](../cli/chat-session.md#actionable-error-recovery-25h) owns command-specific remedies.

### Hard turn cap

A session carries a **hard turn cap** — a finite DoS fail-safe on the number of turns it will run (engine
default **50**, overridable at construction; **0/absent ⇒ the default**). It is **distinct** from two other
limits and must not be conflated with either: `[chat].max_messages` (a history-**trim** threshold that
silently *continues* the session — [config-spec.md](config-spec.md)) and the turn core's **within-turn**
`maxToolTurns` tool-loop guard. A `sendMessage` past the cap ends **loudly, with no egress**:
`session:turn_completed` carries `stopReason: 'error'` + `error.code: 'turn_limit'`
([sse-event-schema.md](sse-event-schema.md#error-code-taxonomy)) — never a silent stop; the within-turn
`maxToolTurns` guard surfaces the same `turn_limit` code through the same event. The cap is an **engine-API
knob** (`SessionDeps.maxTurns`); a surface maps the `[chat].max_turns` config field onto it at construction
time — that surface field was added in build-phase 2 (workstream **2.M**); see the `[chat]` block in
[config-spec.md](config-spec.md).

Only provider-engaged turns consume a slot, including failed or aborted turns whose trusted host
callback throws. Engagement is recorded on actual non-error provider chunks and chain-owned provider
invocation evidence, independently of a budget hook, the exception type or a positive token count.
Local preparation, credential, deadline setup and provider-method lookup refusals before invocation
consume no slot.
Accounting uses an internal outcome carrier without mutating the thrown value, including frozen
classified exceptions. Terminal usage retains known prior attempts and an observed valid terminal
usage chunk; an unreported current attempt adds no
invented usage. Ordinary raw callback/money errors remain visible to the API caller after the fixed,
secret-free session terminal. If prototype or diagnostic-field inspection during session presentation itself throws, the fixed
terminal still uses canonical accounting and the original throwable is rethrown. A successful turn
counted before its later durability flush is counted
once even if that flush fails; its known quantities outrank unrelated exception metadata for every
error class. A later-round budget pause retains earlier engagement and usage. Terminal `cancel()`
retains its sole cancellation event.
Provider diagnostic normalization and cause classification follow the normal turn taxonomy, with opaque
provider causes kept private. Nested diagnostics must retain actual invocation evidence and cannot
permit another send past the hard turn cap.

The shared turn driver records the exact throwable escaping its attempt observer. Inline generated
responses preserve that observer failure without entering provider classification, even when the
observer throws an `LlmProviderError`; genuine provider failures retain their normal mapping. A later
tool round guards budget-error inspection so a throwing prototype or diagnostic cannot replace the
original callback failure. External emit/readiness/record and chain clock/backoff failures have
call-local origin distinct from internal admission settlement. Workflow callers refuse retry/gate
and failure-writer authority from that origin. Admission/money causes are unwrapped only with exact
current pre-attempt provenance, never solely by error class.
Session preserves classified-error delivery and raw rejection while using fixed internal,
non-retryable observer presentation; the callback diagnostic cannot become public authority.
Post-success completion and commitment-flush callbacks carry the same exact observer provenance;
readable classified errors use fixed internal, non-retryable presentation, while raw/opaque failures
retain their original rejection. Already engaged turns keep their real usage and consume one slot.
The session attempts its fixed terminal with canonical accounting; a throwing sink cannot guarantee
publication, and a sink recording before throwing may see multiple notification drafts. Compaction uses the same
captured outcome and preserves observer origin through its start/finish lifecycle notifications.
Readable classified observer failures return a fixed private-safe `failed` result; ordinary raw or
opaque observer failures reject with the original value. Actual cancellation and genuine pre-egress
budget refusal retain their existing handling. Controller-factory failures in send, compaction and
user commands release running/abort state and reject the original value without classified delivery.
A throwing turn-start notification receives the same cleanup before any provider call. Terminal
cancellation keeps precedence; a refused initialization consumes no provider-engaged slot.
Compaction clears its running/abort state on every exit. If a trusted controller factory raises
abort or cancel before returning its controller, the returned signal carries that recorded intent
before work begins; terminal cancellation permits no later start/compaction notification or command.
Cold compaction planning also rechecks terminal cancellation after provider resolution and before
arming a controller. Cancellation there permits no credential or provider call and keeps the session
closed; idle abort remains a no-op and a warm memoized plan does not rerun the resolver.
If the resolver starts another real session operation, compaction rechecks its idle precondition
and throws the existing lifecycle refusal before arming a second controller. The running operation
retains the controller targeted by abort and cancel.
A successful commitment flush rechecks terminal cancellation before installing the reply or
publishing completion. Known usage, cost and provider-engaged turn consumption remain accounted.
Compaction estimates the prospective summary/history projection before installing it and rechecks
terminal cancellation after the provider-supplied estimator. A cancellation during that estimator
retains the previous history and summary. Ordinary estimator failure remains best-effort; the existing
EA7 late-abort no-op after successful summarisation remains unchanged.

## Session context

`SessionContext` is the workspace situation a session runs against, auto-detected from the launching
surface and overridable by the user.

```ts
interface SessionContext {
  workingDir: string;        // workspace root (auto-detected; overridable)
  activeFile?: string;       // the surface's active file, if any
  selection?: { file: string; startLine: number; endLine: number };
  gitRef?: string;           // current branch / commit, for provenance
  fsScopeTier: 'sandboxed' | 'project' | 'full';  // same tiers as workflows; default sandboxed
  variables?: Record<string, string>;             // session-scoped {{ctx.*}} values — plaintext, NO secrets (§ Tools, secrets)
}
```

`fsScopeTier` and the command allowlist are the **same** filesystem-scope tiers and `allowedCommands`
policy a workflow uses (see [built-in-tools.md](../shared-core/built-in-tools.md#filesystem-permission-tiers)
and [workflow-yaml-spec.md](workflow-yaml-spec.md#tool-policy-spectools)); the chat-mode **defaults**
(`fs_scope`, the command allowlist, `default_model`, `max_turns` (the hard turn cap → `SessionDeps.maxTurns`),
`max_messages`, and an optional pre-egress cost
cap `max_cost_microcents` / `on_exceed` — the same [ADR-0028](../../decisions/0028-workflow-resource-governance.md)
governor a workflow budget uses) live in the `[chat]` block of [config-spec.md](config-spec.md) and
reference those canonical homes — they are not re-declared here.

## Session messages

`SessionMessage` is the **persistence / transcript** type for a turn. It is **append-only** (mirroring
the run-event log): messages are never edited or deleted, only appended.

```ts
interface SessionMessage {
  id: string;
  sessionId: string;
  sequenceNumber: number;                 // monotonic per session
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: SessionContentPart[];          // session-only durable union: structural tools, handle-only media, signature-less reasoning
  modelId?: string;                       // canonical model id for an assistant turn (fallback-aware; mirrors session_messages.model_id)
  compaction?: { droppedThroughSequence: number };  // ADR-0062: present ONLY on a role:'system' compaction/trim boundary marker — the durable seq through which older messages are superseded (mirrors session_messages.compaction_dropped_through_sequence)
  interruption?: { reason: 'aborted' | 'failed' | 'denied' | 'turn_limit'; code?: ErrorCode };  // ADR-0119: present ONLY on the empty-content role:'system' terminal row of a retained interrupted turn; code iff reason is 'failed' (mirrors session_messages.interruption_reason / interruption_code)
  timestamp: string;                      // ISO 8601
}
```

The session-only `SessionContentPart` union is owned by `@relavium/shared`
([ADR-0095](../../decisions/0095-what-an-agent-session-remembers-across-turns.md)). Its exact structural
tool fields, byte-size units and engine id form live in
[the database contract](../shared-core/database-schema.md#session-content-parts). It refuses raw arguments,
results, continuation signatures and unknown fields instead of silently dropping them. Non-tool media
remains handle-only; tool attachments carry only handle metadata, never result filenames or transcripts.
The generic `DurableContentPart` used by run/event/IPC positions is unchanged.

`SessionMessage` is mapped into the seam's `LlmMessage`, rather than copied. The next turn sees the
text projection plus content-free [receipts](#content-free-action-receipts--adr-0128): carrying earlier tool rounds is deferred. Both forms are Relavium-owned, so
no vendor SDK type crosses the seam ([ADR-0011](../../decisions/0011-internal-llm-abstraction.md)).
A completed turn persists its user row, ordered structural call/result rows, and one terminal
assistant row containing a text part, even when that text is empty. The additive `toolHistory`
field on [the completed-turn event](sse-event-schema.md#session-event-namespace) supplies only
structure; streaming tool inputs and result summaries never feed transcript persistence.
The persister commits the entire exchange and session totals atomically. A failure latches
and stops later model/command egress. Admission checks the live latch at each provider attempt and
effect preparation, and immediately before every actual tool dispatch, including unjournaled tools,
a cached idle-command key and a cost-write failure after provider admission.
Conservative-commitment and realized-cost writes include catalog resolution in
the same sticky failure latch: a catalog read or store write failure preserves
its original error and refuses later dispatch even if the store subsequently
recovers. This supplements the governor's settlement barrier.
The dispatch check runs
after asynchronous approval and preparation. Its refusal proves dispatch never started and releases
any prepared claim. Settling or discarding an already-started effect remains available to record its outcome.
An error or abort commits no completed exchange; a turn the engine **retains** ([ADR-0119](../../decisions/0119-an-interrupted-turn-stays-as-a-content-free-marker.md), below) is stored as the user message, its structural pairs and one interruption row instead, and every other one commits nothing. Billed cost remains real either way.

Resume, model reseat, export, boundary mapping and effect disclosure share the pure structural history
projection in `@relavium/shared`; existing core exports remain available. `completedSessionTurns`
selects its completed exchanges; `resumableMessageSequences` and `resumableTurnBoundarySequences`
supply the matching host boundary seeds. A tool-call row
with preamble text is never a terminal, and an unfinished exchange rolls back. An empty-final turn
restores its user message alone and counts as a completed turn. Compaction/trim boundaries retain
whole turns; `/trim` still takes message units. Export reads all historical completed turns,
including those superseded by a working-context boundary. The engine's internal projection-event
emit boundary requires `keptTurnCount` for both compaction and trimming, so current producers cannot
fall back to message count. The public event schema still accepts older events without that additive
field; the persister's legacy compatibility does not weaken the current producer requirement.

**Legacy empty-final compatibility.** Before explicit empty terminals, the writer could persist a
successful empty final as a user row alone. A bare user immediately followed by another user retains
its text in resumed/reseated context, matching the old projection. It prefixes the next completed
export prompt and has its own compaction/trim boundary slot. It does not create a terminal row or add
to the reconstructed hard turn cap. The final bare user still rolls back, and interrupted structural
exchanges stay excluded. Legacy prefix text without a later terminal remains resumed context and
export metadata; it does not invent an exported node. Explicit empty-terminal turns retain their
ordinary distinct identity. No historical row is rewritten.
The legacy rollback is a read projection: a later append can make a previously trailing bare user
nontrailing, preserving the old archive's ambiguity rather than permanently deleting its text.

> **Relationship to the run `messages` table.** A session's messages are persisted in
> **`session_messages`**, bound to a **session** — distinct from the existing per-step run `messages`
> table, which is bound to a **`step_executions`** row within a workflow run. The two are deliberately
> separate (different lifecycle and FK parent); see the table definitions in
> [database-schema.md](../shared-core/database-schema.md). They share a shape family but must not be
> merged, to avoid coupling the session and run persistence stories.

## Proposed user display text — MVP-2

**Implemented and independently accepted on development — 2026-11-10.** The maintainer approved
[ADR-0123](../../decisions/0123-restored-transcripts-use-host-recorded-display-text.md).
The historical heading remains for stable inbound links; the
[step-4 acceptance](../../roadmap/phases/phase-2.6-conversational-authoring.md#step-4-acceptance-2026-11-10)
records the reviewed source and checkpoint gates.
The existing `SessionMessage` interface above remains the shipped contract.

Keep `SessionMessage` and its canonical `content` unchanged. The host separately
records user display metadata through the existing completed-turn write boundary;
its exact shape and storage live in the
[database contract](../shared-core/database-schema.md#proposed-user-display-storage--mvp-2).
The host supplies the compact displayed prompt before attachment expansion.
Readers must never substitute display metadata into `LlmMessage`, a compaction
summary, an exported workflow prompt or export message metadata. No export shape
changes as a consequence of this addition.

Every host user-row insert path that has captured display text writes it in the
same transaction as that user row. MVP-2 uses the completed-turn transaction;
if [ADR-0119](../../decisions/0119-an-interrupted-turn-stays-as-a-content-free-marker.md)
(Accepted, MVP-3c) is implemented, its interruption transaction inherits this rule. Metadata validation
is role-restricted, not restricted to a successful-turn status; this does not
activate interrupted-turn persistence now. No optional
denormalized `content` metadata is repurposed: that remains checked against
canonical content. The host explicitly supplies display text captured before
expansion, even for a plain prompt. A caller without that representation leaves
metadata absent; never infer it from canonical submitted text. Existing rows
remain absent; no backfill guesses provenance.
Plain/JSON drivers explicitly pass their captured, unexpanded input as the
display argument, rather than relying on a persister fallback.

On restored UI paths, absence causes a fixed legacy-prompt notice instead of
displaying that user row: its compact display was not recorded and it may include
attached context. This also hides plain legacy prompts. Do not infer safe display
from attachment-tag/nonce syntax or absence. Assistant text is sanitized and shown.
Display metadata is itself untrusted and passes the normal display sanitizer.
This rule does not change raw history, model restore or export, and must not be
represented as universal redaction. The notice explicitly states that original
user text may still be part of model context under the existing memory policy.
Display-read or validation failure refuses interactive restoration before host
activation with a fixed safe diagnostic and retry/return action; it never causes
fallback to canonical user text. Presentation metadata is not read by canonical
machine resume and does not change its failure behavior.

## Tools, secrets, and security scope

A session uses the **same** tool surface as a workflow agent: the built-in `ToolRegistry`
([built-in-tools.md](../shared-core/built-in-tools.md)), the same FS-scope tiers, and the same
mandatory guardrails (`run_command` allowlist; `git_commit` behind approval). Per
[ADR-0029](../../decisions/0029-tool-policy-hardening.md):

- a session inherits the agent's tools and may only **narrow** them, never escalate;
- a `secret`-typed value is **never interpolated** into a prompt or tool text;
- `context.variables` (the `{{ctx.*}}` map) is **plaintext supplied by the surface** that is echoed
  **verbatim** in the `session:started` event payload and persisted in the session row — it **MUST NOT**
  carry an API key or any secret. Provider keys and MCP named credentials use their keychain-backed
  resolvers. Workflow `secret` inputs have a separate [caller-supplied admission contract](workflow-yaml-spec.md#inputs);
  this does not authorise putting resolved credentials in session `context.variables`;
- `http_request` / MCP egress is subject to the same SSRF policy as a workflow.

The user's own **conversational content** typed into a session is the user's data: it is persisted in
the `history.db` (on the CLI surface, **unencrypted at rest**, guarded by `0600`/`0700` OS permissions per
[ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md); the desktop's SQLCipher-encrypted store
is a separate surface) and is *not* a managed secret — this boundary is stated in
[security-review.md](../../standards/security-review.md).

## Events

A session emits on the **`session:*` namespace** — its single canonical home is
[sse-event-schema.md](sse-event-schema.md#session-event-namespace), which defines the `SessionEvent`
union, the shared base envelope, and `sequenceNumber` gap-detection. The **steering** events
(`agent:directive_injected` / `agent:context_compacted` / `agent:context_cleared`) are **reserved**
in Phase 1; the steering channel narrative lives in
[agent-sessions.md](../../architecture/agent-sessions.md).

## Export to workflow

Per [ADR-0026](../../decisions/0026-session-export-to-workflow.md), a session exports to a
`.relavium.yaml` **scaffold** that the author reviews before committing:

- completed logical turns become a **linear chain of `agent` nodes**, in order, carrying the
  agent binding, resolved prompts and the deduplicated union of resolved structural tool names,
  per [ADR-0095](../../decisions/0095-what-an-agent-session-remembers-across-turns.md) §1 and §3.
  An empty terminal assistant text still completes a turn; tool preambles do not create extra nodes;
- the **full transcript is preserved in the workflow's durable `metadata` field**, including
  content-free tool structure and user/terminal assistant text. It survives parse → serialize
  round-trips. Tool arguments/results are excluded, while user-authored and assistant text can
  contain sensitive content. Prompt interpolation neutralisation does not redact that text;
- parallel / conditional / loop structure is **not** auto-inferred — the author adds it on the canvas.

Successful CLI `chat-export` writes a fixed continuity/review notice to stderr, including
in JSON mode. It also warns that historical agent snapshots may need edits to pass current
authored validation before running. Live `/export` renders the same notice in the interactive chat/Home transcript
and uses stderr on plain/JSON drivers; the machine event stream is unchanged. A scaffold does not recreate the
session's working context: summarised, trimmed or omitted context may not transfer, and no raw
model-issued tool arguments/results are available to restore. Historical persisted turns and
content-free tool structure are mapped as below. Retained user/assistant text, `@` attachments,
`!` output and authored agent literals still require review before running or committing. The
notice does not redact them, and there is no raw-tool-content export opt-in.

The export **produces** the format owned by [workflow-yaml-spec.md](workflow-yaml-spec.md); the
**mapping** (session turn → `agent` node, transcript → metadata) is the contract owned here. The
desktop "Export to Canvas" affordance and the CLI `relavium chat-export` both drive this one contract.

**Precise mapping (1.Z).** Given a loaded `AgentSessionRecord` + its ordered `SessionMessage[]`, the
exporter builds a `WorkflowDefinition` deterministically (no wall-clock / randomness, so the artifact is
reproducible; snapshots satisfying current authored validation round-trip):

- **Nodes** — a single `input` node (`id: input`), then **one `agent` node per COMPLETED logical turn** in
  `sequenceNumber` order (`id: turn-1`, `turn-2`, … — 1-based), then one `output` node (`id: output`). A
  *logical turn* begins at its user row and ends at its terminal assistant text part (empty text counts).
  Preserved nontrailing legacy bare-user text prefixes the next completed prompt; it creates no extra node.
  Structural tool preambles/results do not create nodes. An interrupted exchange is omitted from the chain
  and remains in the full metadata. Each `agent` node carries `agent_ref` = the session's `agentSlug`;
  `prompt_template` = the user text, with interpolation openers neutralised (omitted if empty);
  `tools` = the deduplicated union of resolved names in its structural calls, including admitted MCP ids.
  The fixed unresolved `unknown_tool` marker never becomes a grant. No
  `model`/`temperature`/`max_tokens`/`retry`/`output_schema` are emitted — those are authoring concerns the
  user adds on the canvas, not replay fields.
- **Edges** — a straight linear chain `input → turn-1 → … → turn-n → output` (just `{ from, to }`); when a
  session has no completed turn the chain is `input → output`. No parallel/conditional/loop edges (ADR-0026).
- **Workflow `id`** — deterministic ASCII kebab-case, matching `kebabIdSchema`. The title undergoes
  NFKD compatibility decomposition, combining-mark removal, lowercase and explicit dotless-i (`ı` → `i`)
  and sharp-s (`ß` → `ss`) mappings; other non-ASCII runs become separators. The title slug is limited to
  128 characters with no trailing separator. This is not universal transliteration. An absent or unusable
  title uses `exported-session-<session-id>` when the session id is legal lowercase kebab-case and at most
  111 characters (ordinary UUIDs survive unchanged). Other external ids use `exported-session-id-` plus
  four-digit hexadecimal UTF-16 encoding of their first 24 code units. Generated workflow ids are bounded
  and renameable, not guaranteed unique: normalisation and truncation can collide. Full original identity
  stays in metadata; the default export filename still uses the session id, not the generated workflow id.
- **`agents`** — the session's frozen `agentSnapshot` (an inline `Agent`) is emitted as the sole `agents[]`
  entry so `agent_ref` resolves. Historical snapshots retain their ordered fallback entries and attempt
  budgets even when current [authored admission](agent-yaml-spec.md#retry-vs-fallback) rejects them
  (for example, repeated model/provider tuples). Such a scaffold requires deliberate author repair
  before it parses/runs; export never silently deduplicates the frozen agent or rewrites history.
  When no snapshot was captured, `agents` is omitted and `agent_ref` resolves
  against the workspace agent registry at author time (the file still parses — `agent_ref` resolution is the
  engine's job, not the schema's).
- **`metadata`** — the full persisted transcript, including content-free tool structure, under a single reserved key: `metadata.relaviumExport = { source:
  'session', sessionId, agentSlug, title?, createdAt, updatedAt, messages: SessionMessage[] }`. It is a real
  schema field (`z.record`), so it survives parse → serialize round-trips.
- **Determinism + exclusions** — the YAML emitter (1.Z, `serializeWorkflow`; 1.L is parse-only) sorts map
  keys alphabetically and preserves array order, so `parse → serialize` is byte-stable. The strict
  `SessionContentPart` transcript refuses raw model-issued tool arguments/results and continuation
  signatures ([ADR-0095](../../decisions/0095-what-an-agent-session-remembers-across-turns.md)). User
  conversational text remains user data in the export.

## Validation and persistence

- Validated against `AgentSessionSchema` / strict `SessionMessageSchema` / `SessionContextSchema` (Zod, in
  `@relavium/shared`) — invalid input fails fast, like every other authored/runtime contract
  ([ADR-0023](../../decisions/0023-strict-authored-yaml-validation.md)).
- Persisted in the global `history.db` (`agent_sessions` + `session_messages`; on the CLI surface
  unencrypted at rest, `0600`/`0700`-guarded per [ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md)); the DDL is
  canonical in [database-schema.md](../shared-core/database-schema.md). Credential retrieval uses the OS
  keychain and does not copy application-held keys into rows, messages or event payloads
  ([keychain-and-secrets.md](../desktop/keychain-and-secrets.md)); this is distinct from the sensitive
  content a user can supply in their conversation.

The session store also validates every denormalized metadata field against the canonical body on
write and read. A text projection must equal its canonical text; structural `toolCalls` must equal
the canonical call parts; `name` and `toolCallId` must match the appropriate single part; `finishReason`
is a fixed stop-reason value on an assistant row. Unknown fields and malformed JSON are refused with
fixed boundary errors. This prevents metadata from becoming a second tool-content channel. User
conversational text, including `!` output and `@` file injection, remains user data at rest.

## Usage coverage through session lifetime

A shipping persisted host attaches a required usage writer independently of its optional cost governor. Fresh creation alone establishes a complete-zero basis; resume/reseat explicitly adopt the existing owner and preserve pending, unknown and historical uncertainty. Pending acknowledgement precedes conversational, tool-round and summariser invocation. Complete actual money and coverage resolve atomically through one direct writer, rather than a second bus subscriber. The CLI waits for retained producers and accounting writes before closing that writer or SQLite. One-shot agent runs use an opaque hidden owner without a transcript or resume privilege.

Public cost completion follows that direct writer's acknowledgement. The persisted host refreshes the
amount, missing-price count and coverage together at accounting and lifecycle boundaries, including
the next turn after resume/reseat; construction-time counters cannot overwrite a newer durable sum.
Content frames reuse the cached projection. The [event contract](sse-event-schema.md#the-runevent-union)
owns the acknowledgement, projection-failure and uncertainty rules.
