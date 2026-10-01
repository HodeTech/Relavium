# ADR-0095: What an agent session remembers across turns

- **Status**: Accepted — 2026-09-14
- **Date**: 2026-09-12 (first draft) · 2026-09-14 (fifth draft). Five review rounds shaped it: the maintainer's review of the first draft and four adversarial workflow rounds. After the fifth, the maintainer had the ADR restated as decisions, invariants and acceptance tests, a short sixth round verified that form, and moved `CR-97`
  into [ADR-0098](0098-a-session-effect-row-holds-no-result-and-never-replays.md).
- **Implementation**: staged for `W7`. "Accepted" here means the decision is settled, not that it ships: until the `W7`
  commits land, the persister still writes no tool structure, the exporter's `tools` union stays empty, and `memory`
  is still inert. [agent-session-spec.md](../reference/contracts/agent-session-spec.md) and
  [agent-yaml-spec.md](../reference/contracts/agent-yaml-spec.md) say so in the meantime.
- **Decides**: `CR-71` and `CR-72` of
  [Phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md) (`W7`), and the `CR-70`
  decision, whose work is deferred (§2)
- **Corrects, by dated note**: [ADR-0062](0062-context-compaction-and-cli-history-commands.md) §6 — its
  *reasoning*, not its decision. After this ADR, cross-turn tool accumulation in the model's context still does
  not exist; it is deferred rather than impossible
- **Amends (a refinement, not a reversal)**: [ADR-0026](0026-session-export-to-workflow.md) (what the export's
  `metadata` carries, §3) · ADR-0062's compaction boundary rule, which identifies a boundary by turn rather than
  by message count (§1)
- **Related**: [ADR-0098](0098-a-session-effect-row-holds-no-result-and-never-replays.md) (a session's effect
  rows) · [ADR-0050](0050-cli-history-db-at-rest-posture.md) ·
  [ADR-0081](0081-the-compaction-summary-is-untrusted-and-the-system-prompt-is-branded.md) ·
  [ADR-0096](0096-a-request-is-measured-before-it-is-sent.md) ·
  [agent-session-spec.md](../reference/contracts/agent-session-spec.md) ·
  [agent-yaml-spec.md](../reference/contracts/agent-yaml-spec.md)

> **Amended 2026-09-18 — the `W7` pre-implementation review.** A systematic review of this ADR against the tree
> found one false rationale, several gaps that the implementation would otherwise have decided silently, and
> wording that contradicts the table below it. The decision is unchanged; this note narrows it and adds landing
> obligations. Choices the maintainer made on 2026-09-18 are marked as such.
>
> **§1 — the shape of a persisted turn.**
>
> - **Every completed turn ends with a terminal `assistant` row carrying a text part and no `tool_call` part.**
>   The text may be empty, which is how a completed turn with empty final text is stored. §1's row shape implies
>   it; this says it. A turn therefore runs from its `user` row to its terminal row, and the export groups on that
>   row instead of merging contiguous `user` rows.
> - **A trailing bare `user` row with no terminal row keeps today's resume rollback**, which is what makes "no
>   migration is needed" true for every session persisted before `W7`.
> - **The in-memory transcript is unchanged, and the REQUEST folds adjacent same-role messages.** (Maintainer,
>   2026-09-18.) A completed turn with empty final text leaves a lone `user` message in memory, so a later turn
>   can put two `user` messages next to each other. The request projection folds adjacent same-role messages into
>   one, so every dialect sees an alternating conversation. The Anthropic adapter already does this for itself
>   (`mergeAdjacentSameRole`); the rule now holds for all of them, in one place, and `session-resume.ts`'s
>   "provider-rejected request" comment is corrected with it.
> - **The synthesized `read_media` message is never persisted as a `user` row.** Turn identity is structural, so a
>   `user` row inside a turn would break it. When a surface wires the media delegate, the attachment is recorded on
>   the tool row as structure.
> - **Invariant 1's refusal covers the whole store boundary.** `SessionMessageMeta`'s `toolCalls`, `name` and
>   `toolCallId` reach `session_messages` today with no schema parse; they stop accepting a model- or server-chosen
>   value. A raw argument or result key is **refused** on write, never silently stripped.
> - **The structural tool part is a new session-only durable arm**, not a narrowing of the shared
>   `DurableContentPart` union that run, event, IPC and export positions all reference.
>   [database-schema.md](../reference/shared-core/database-schema.md) and
>   [sse-event-schema.md](../reference/contracts/sse-event-schema.md) define its exact shape when `W7` lands: the
>   fields, the size unit (UTF-8 bytes of the bounded, model-facing JSON), which value each size measures, the
>   outcome vocabulary (`ok` / `error` / `denied` / `cancelled`), and the engine id form — which encodes the turn
>   key and the slot, so [ADR-0098](0098-a-session-effect-row-holds-no-result-and-never-replays.md)'s join is sound.
> - **A persisted engine-assigned tool-call id is unique within its session**, across resume, reseat and
>   compaction. ADR-0098 decides "did not complete" by joining effect rows to persisted ids, and a per-turn ordinal
>   would let a crashed turn's row match an earlier turn's id and suppress a disclosure that is owed.
> - **"Server-chosen" means a string the registry did not resolve.** A discovered MCP tool's registry id is
>   `mcp_<server>_<tool>`, whose tool segment the server supplies — reduced to `[a-zA-Z0-9_-]`, length-capped, and
>   admitted only through the author's own `mcp_servers` ([ADR-0088](0088-the-mcp-boundary-is-hostile.md) §5). It is
>   a resolved name and it persists and exports as itself; an UNRESOLVED name is what becomes `unknown_tool`. The
>   acceptance heading "No model- or server-chosen string is persisted" is scoped to tool parts and ids — assistant
>   text is model-chosen and is persisted by design. The structural field is built from the registry outcome, never
>   from `agent:tool_call`, which carries the raw model-chosen name on its failure path.
> - **An exported MCP tool id is honoured only when `relavium run` rediscovers it** from the inlined snapshot's
>   `mcp_servers`, which [ADR-0094](0094-a-tool-grant-is-checked-when-the-plan-is-built.md) §2 already requires. If
>   the server no longer exposes that tool, the plan build refuses the file.
> - **"No tool content at rest" is about model-issued tool parts and effect rows.** `!`-command output and
>   `@`-mention file content are injected into the user's own message and are persisted and exported as user data,
>   which [ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md) and ADR-0050's note already record.
>
> **§4 — `memory`.**
>
> - **`window` sends the current user message plus the last N completed turns**, and a completed turn with empty
>   final text counts as one of them.
> - **Invariant 1 constrains the policy, not the user.** `none` and `window` shape the request only; a `/trim` the
>   user runs under `window` — which the table permits — still changes the transcript and writes a marker.
> - **`compact()` and `trimHistory()` enforce the policy in the engine** and return a typed refusal naming it, so
>   every surface inherits the author's contract instead of re-implementing it.
>   [agent-session-spec.md](../reference/contracts/agent-session-spec.md) is its canonical home, and the CLI checks
>   the policy before its own bound check.
> - **A one-shot surface skips the after-turn trigger.** `relavium agent run` is one turn, so nothing reads a
>   summary produced after it. "Always permitted" does not mean "always run" — this is invariant 5's reasoning
>   applied to the other surface it fits.
> - **A summary restored from a session compacted before `W7` is not projected under `none` or `window`**, as the
>   table says. The durable rows keep it.
> - **The `window` overflow remedy also names `/trim`**, which the table permits, and marks a smaller `window_size`
>   as applying to a NEW session: a resumed or reseated session runs the frozen `agentSnapshot`, so its author has
>   nothing to edit.
> - **`memory` has no effect on a workflow `agent` node**, including one produced by session export. The canonical
>   `memory` row in [agent-yaml-spec.md](../reference/contracts/agent-yaml-spec.md) carries that sentence; nothing
>   else restates it.
> - **`summary`'s "always permitted" is permission, not funding.** Once ADR-0096 §6 prices input, the summariser is
>   the largest request a session makes, so near the cap it is REFUSED on budget: no trim, and the turn ends
>   `budget_exceeded`. ADR-0096's note of the same date carries the rule.
>
> **One implementation note was wrong in a word.** On the idle paths — `/compact` and the after-turn trigger (the
> kept slice of `splitFoldable`), and `/trim` (the kept slice of `tailFromUserBoundary`, which `/trim` uses
> instead) — the trailing `user` message is the lone message of a COMPLETED empty-final turn, and it counts. Only
> on ADR-0096's pre-send and recovery paths, where `sendMessage` has already pushed the in-flight message, is it
> pending and excluded. Whether a turn is in flight decides which; never the message's position. **`/trim n` keeps
> counting MESSAGES**, unchanged: invariant 5's boundary IDENTITY is per turn, and the two units are deliberately
> different.
>
> **Landing obligations gained.** [config-spec.md](../reference/contracts/config-spec.md) (`[chat].auto_compact`
> governs only an omitted `memory`, and covers all three automatic entry points) ·
> [chat-session.md](../reference/cli/chat-session.md)'s `/compact` and `/trim` rows and its context-compaction
> section (linking to the `memory` row rather than restating it) · agent-session-spec.md §"Session messages" (the
> persisted content type and the `LlmMessage` projection) · a further dated note on
> [ADR-0062](0062-context-compaction-and-cli-history-commands.md) for §4's change to its §5 config gate, its §7
> commands and its "switchable off" consequence · a dated note on [ADR-0026](0026-session-export-to-workflow.md)
> adding "and whether each errored" to the structure it lists · the residual record in
> [deferred-tasks.md](../roadmap/deferred-tasks.md) for an errored or aborted turn, which persists nothing.
>
> **Acceptance gained.** `/compact` and `/trim` immediately after an empty-final turn, each followed by
> `chat-resume` · `window_size: 1` · a session that called a discovered MCP tool persists and exports its
> namespaced id, and the exported file builds a plan · a pre-`W7` compacted session whose snapshot authors `window`
> resumes without projecting its summary · `relavium agent run` with `memory: summary`, over the threshold, makes
> no summariser call after its one turn.

> Amended 2026-10-02 — [ADR-0099](0099-compaction-has-an-idle-budget-outcome-and-an-unknown-window-policy.md),
> accepted by the maintainer, qualifies the 2026-09-18 "permission, not funding" note for idle compaction.
> Funding refusal and no budget fallback trim remain. An active pre-send/recovery turn ends
> `budget_exceeded`; after-turn refusal preserves the already-successful turn and reports a side notice;
> manual refusal returns a typed outcome without a turn terminal. `memory`'s permission rules are unchanged.
> Implementation is staged in `W7`; the historical text below is unchanged.

## Context

A session's turn runs a full tool loop and then discards it. `runAgentTurn` returns only the final content, and
`AgentSession` appends only the final assistant text to its cross-turn transcript. Three shipped claims follow,
and the code keeps none of them:

- **A coding agent cannot remember a file it read last turn** (`CR-70`).
- **The transcript and the export lose the flow that happened** (`CR-71`).
  - The persister writes no tool part.
  - The exporter's `toolsUsedIn` was written to read `tool_call` parts, finds none, and omits `tools:` from every
    node.
  - [agent-session-spec.md](../reference/contracts/agent-session-spec.md) promises a `tools` union, a "full
    transcript" in the export, and that `sendMessage` appends "the assistant + tool messages".
- **The authored `memory` policy is inert** (`CR-72`). Its canonical row also names `none` as the default, when
  the shipped default is a full transcript, auto-compacted.

**The earlier drafts, and what their review established.** Four review rounds tested those drafts against the
code, and every finding below was confirmed there. They are kept here because each constrains the decision.

- **Tool content must not reach disk.** ADR-0050 left `history.db` unencrypted on the premise that it "holds no
  credentials". Tool arguments are model-built: an `http_request` header is `z.record(z.string())`. Tool results
  can hold `run_command` output. The project already treats even a digest of the *scrubbed* argument projection
  as "a permanent equality oracle" ([effect-journal.md](../reference/shared-core/effect-journal.md) §11).
- **Carrying tool content into the next request was worth little.** Content stays off disk, and a `/models`
  reseat rebuilds the session from disk (`chat.ts:1781`). Carried content would therefore survive only within
  one process and one model binding, and it generated most of the open findings. The maintainer deferred it.
- **Counting messages across two differently shaped arrays loses data.** The engine keeps a text-only transcript
  while durable rows would hold split tool rows. Compaction reports a message count, so `/trim` followed by resume
  dropped the kept user message.
- **Text presence does not identify a turn.** A tool-call row carries a text preamble, and a completed turn can
  end with empty text.
- **A model-chosen `data:` URI in an argument can fail the durable parse**, latching the persister and stopping
  the session.
- **A model- or server-chosen string reaches durable rows by more than one path.** The obvious path is a tool
  name. The less obvious one is a tool-call id: Gemini derives ids from the model-chosen name (`gemini.ts:351`).

## Decision

### 1. A session's tool history is persisted as structure, never as content

A completed turn is persisted as split rows: `user → assistant(tool_call) → tool → … → assistant(text)`. Its
tool parts record **which tools ran, in what order, how large their arguments and results were, and whether each
errored**. They do not record the arguments or the results themselves. The in-memory transcript stays text-only,
because carrying is deferred (§2).

**Invariants.**

1. **No tool content at rest, enforced by type.** No `session_messages` row holds a tool argument or a tool
   result. The session store refuses a raw value at its boundary, rather than trusting its callers.
2. **Nothing model- or server-chosen in a tool part.** A persisted tool name is one the registry resolved, or a
   fixed `unknown_tool` marker. A persisted tool-call id, and the id a result points back to, is engine-assigned.
3. **A model-chosen value cannot fail a write.** No argument or result value can fail the durable parse.
4. **Resume reproduces the in-memory transcript exactly**, turn for turn. That includes a completed turn with empty
   final text.
5. **A compaction or trim boundary is identified by turn, not by message count.** Every consumer that maps a
   boundary onto durable rows — resume, the persister's resume seed, and its live mapping — uses the same turn
   identity. The in-flight turn's pending user message is never counted.
6. **The persister commits a turn's structure atomically with its text.** A failed write latches exactly as a
   failed text write does today.

**Where the decision is fixed.** A turn is identified by row structure — role and part type — and no migration is
needed. The structure reaches the persister on `session:turn_completed`, as an additive, content-free field. The
public event stream already carries tool names through `agent:tool_call`, and a separate hook would either not
exist when the session is built or land inside `sendMessage`'s one-message rollback.

### 2. `CR-70`: carrying tool history into the model's context is DEFERRED

**Decided 2026-09-13 by the maintainer.** The canonical spec states that a session does not carry prior turns'
tool rounds into the model's context. The work reopens when **ADR-0096's measurement and recovery have shipped and
been observed in a release**, and a surface needs carrying. The coding-assistant surface is the named candidate.

The future ADR inherits these constraints, which the reviews established and the maintainer confirmed:

- **Carried content lives in the process only**, because §1 keeps it off disk.
- **Carried content does not cross a reseat**, so the new model sees notes. (Maintainer, 2026-09-13.)
- **The bound is one pure request-build projection with a per-turn aggregate byte ceiling.** It lowers the
  oldest rounds whole, and never touches the in-memory transcript or durable rows.
- **The synthesized `read_media` message is excluded**, along with its media. Reasoning and signatures are
  stripped at the turn boundary.
- **Any engine-authored note sits behind ADR-0081's role boundary**, never inside an assistant message.
- **Carried tool-call ids are unique within the session.** Validity is proven per provider by the live conformance
  suite, not by a recorded fixture.
- **The toggle is a user-scoped `[preferences]` key.** A repository's committed file must not widen what a user
  sends.

### 3. The export reflects the flow and carries no tool content

**Invariants.**

1. **The `tools` union is filled from the persisted, resolved tool names.** No model-chosen string reaches a
   committed file.
2. **`metadata.relaviumExport.messages` carries the structural rows as stored**, and therefore no argument or
   result.
3. **A turn is exported if and only if it was persisted.** A completed turn with empty final text is exported as
   a node carrying its tools. The spec's "completed only if it produced final assistant text" is amended.

### 4. `memory` decides the request and every compaction; an omitted policy means what ships today

| `memory` | What the next request contains | Automatic compaction, at all three entry points | Manual `/compact` and `/trim` |
|---|---|---|---|
| omitted | the transcript | governed by `[chat].auto_compact` | allowed |
| `none` | the system prompt and the current user message | never | refused, naming why: they cannot change the request |
| `window` (`window_size: N`) | the last `N` completed turns | never | `/compact` refused, naming why: its summary would fold turns inside the window and never reach the request; `/trim` allowed |
| `summary` | the transcript | always permitted | allowed |

**The three automatic entry points** are ADR-0062's after-turn trigger, ADR-0096's pre-send compaction, and
ADR-0096's overflow recovery. An authored `memory` is the author's declared contract and decides all three. When
it is omitted, `[chat].auto_compact` decides all three. (Maintainer, 2026-09-13.)

**Invariants.**

1. **`none` and `window` never change the in-memory transcript or a durable row.** They shape the request only.
2. **`summary` and an omitted policy run ADR-0062's compaction**, which folds the in-memory transcript and writes a
   boundary marker. That is unchanged, and no durable row is ever deleted.
3. **An overflow under `none` or `window` is not compacted**, and its message names a remedy that can work. Under
   `none`, that is a shorter message or a larger-window model. Under `window`, it adds a smaller `window_size`.
4. **ADR-0096 measures the request this table builds**, not the raw transcript.
5. **A workflow `agent` node is one turn**, so `memory` has no effect there. That is documented, not refused.

### Implementation notes (non-normative)

These are traps the reviews found in mechanisms earlier drafts specified. An implementation may meet the
invariants another way, but it must not fall into these:

- **Durable rows and the engine's text-only transcript differ in shape**, so any count taken over one and applied
  to the other drifts: `persister.ts:193-194` maps a count straight onto durable sequence numbers.
- **`splitFoldable` keeps a trailing pending user message** in the kept slice.
- **A tool-call row's preamble text** means text presence cannot identify a final row.
- **The denormalized `session_messages.tool_calls` column is written by nothing today**, and must stay content-free
  if it is ever written.

### Alternatives

Considered **persisting raw content and amending ADR-0050's premise** (rejected by the maintainer). Considered
**app-layer encryption of `content_parts` in W7** (rejected by the maintainer). Considered **a regex-scrubbed copy**
(rejected: not a guarantee). Considered **carrying in W7** (deferred by the maintainer). Considered **a `turn`
column** (rejected: structure identifies a turn). Considered **a separate `SessionDeps` hook** (rejected, §1).
Considered **`auto_compact = false` overriding an authored `memory`** (rejected by the maintainer). Considered
**specifying the boundary and projection algorithms in this ADR** (rejected by the maintainer after four rounds,
each of which found a defect in the previous algorithm; the invariants and tests bind the implementation
instead).

## Consequences

### Positive

- A session's history, resume and export describe the same flow, and none of them holds tool content.
- A model-chosen value can neither fail a durable write nor reach a committed file.
- `memory` does what its row says, and one rule decides compaction everywhere.
- Every constraint a carrying design must meet is written down before anyone designs it.

### Negative

- **A coding agent still re-reads a file it read last turn.** Accepted: that is the deferral, and the spec says so.
- **An errored or aborted turn persists nothing**, including a turn whose tools already ran. Unchanged, recorded as
  a residual; [ADR-0098](0098-a-session-effect-row-holds-no-result-and-never-replays.md) covers what its effect rows
  must then disclose.

### Acceptance

- **No tool content at rest.** A secret-shaped bearer token in an `http_request` header, and a `run_command`
  output containing one, appear in no `session_messages` row and not in the export. A raw value handed to the
  session store is refused.
- **A model-chosen value cannot stop a session.** A tool call whose arguments hold
  `data:image/png;base64,AAAA` completes and persists, and the session sends again.
- **No model- or server-chosen string is persisted.** On the Gemini dialect, no persisted id or `toolCallId`
  contains a model-chosen name, and an unresolved tool name never appears in an exported `tools:` list.
- **Resume survives compaction, through every boundary consumer.** Run tool-using turns, one of them with empty final
  text. Then `chat-resume`, `/compact`, and `chat-resume` again, and repeat that sequence with `/trim 2` in place of
  `/compact`. In both, the second resumed transcript equals the in-memory transcript of the process that resumed,
  and its first message is `user`. The same holds when a `/models` reseat replaces the first `chat-resume`.
- **Empty final text.** A completed turn with empty final text persists, resumes equal to the in-memory transcript,
  and exports as a node carrying its tools.
- **`memory`.** The §4 table holds for each policy at all three automatic entry points. Under `none`, `/compact`
  and `/trim` are refused with a reason, and an overflow names a shorter message or a larger model. Under `window`,
  `/compact` is refused with a reason.

### Landing obligations

- **Dated notes**: ADR-0062 (§6's reasoning, and the boundary rule) and ADR-0026.
- **Canonical docs**:
  - [agent-session-spec.md](../reference/contracts/agent-session-spec.md): the carrying claim narrowed, the export
    rule, and the turn definition.
  - [agent-yaml-spec.md](../reference/contracts/agent-yaml-spec.md): `memory`, its default and the manual-command
    column.
  - [sse-event-schema.md](../reference/contracts/sse-event-schema.md): the structural field and the turn-identified
    boundary.
  - [database-schema.md](../reference/shared-core/database-schema.md): structural tool rows.
  - [chat-session.md](../reference/cli/chat-session.md) and
    [agent-sessions.md](../architecture/agent-sessions.md): what a turn appends, and what the export carries.
- **Records**: the `CR-70` deferral in [deferred-tasks.md](../roadmap/deferred-tasks.md).
