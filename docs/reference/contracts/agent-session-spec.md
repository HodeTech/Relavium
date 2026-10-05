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

## Lifecycle

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
| **sendMessage** | Append the pending user to the **working transcript**, run one assistant turn through the shared turn core (streaming + tool-call loop), and retain the final assistant **text** on success. The host atomically persists the completed turn's [durable messages](#session-messages), including content-free tool structure and an explicit terminal even for empty final text. Working context excludes tool pairs; carrying them to a later request is deferred ([ADR-0095](../../decisions/0095-what-an-agent-session-remembers-across-turns.md) §2). |
| **setTurnPolicy** | Set/clear the **reseat-less mode policy** (ADR-0057) — the advertise-filter + the interactive approval hook — on the **same** session instance (no reseat, no tool-context loss). Snapshotted at each turn start, so a change applies on the **next** turn. The ask / plan / accept-edits / auto enum lives in the host; this is its mode-agnostic engine projection. Callable in any state, including mid-turn; **inert once cancelled** (a cancelled session runs no further turn, so the policy is never read again). |
| **abort** | **Mid-turn abort** (ADR-0057 EA7): end the *in-flight turn* via its `AbortSignal` but **keep the session alive** — settle **one** `session:turn_completed{stopReason:'aborted'}` (no error), roll the pending user message back, and return to `idle`. **Distinct from `cancel`** (which is terminal): no `session:cancelled`, no new status. No-op when no turn is in flight; a concurrent `cancel` wins. A **late** abort that lands after the turn already resolved is **also a no-op** — that turn completes normally and its reply is **kept** (`abort` interrupts an in-flight turn only, never discards a finished one). |
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

**W7 step 5, 2026-10-02:** request projection and policy permission/refusals are implemented on
`development`. The later measured pre-send/recovery entry points and revised multi-pass/budget
compaction outcomes remain staged; this section does not claim they have landed.

### Financial request inputs

`SessionDeps.maxTokensEstimate` is an optional estimate-only fallback copied at construction. CLI
fresh/resumed/reseated chat and one-shot entry points pass the resolved config value, including when
no budget governor exists. The shared turn core estimates every current tool round before cross-provider
reasoning stripping and forwards required cap-plan/request identity, input estimate and the same frozen
fallback to admission. The canonical estimator, cap precedence, handoff and failure-evidence contract
lives in [llm-provider-seam.md](../shared-core/llm-provider-seam.md#current-request-estimates-and-bound-output-caps).
Measured session context and multi-pass compaction remain later W7 step 8 work.

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
text-only projection: carrying earlier tool rounds is deferred. Both forms are Relavium-owned, so
no vendor SDK type crosses the seam ([ADR-0011](../../decisions/0011-internal-llm-abstraction.md)).
A completed turn persists its user row, ordered structural call/result rows, and one terminal
assistant row containing a text part, even when that text is empty. The additive `toolHistory`
field on [the completed-turn event](sse-event-schema.md#session-event-namespace) supplies only
structure; streaming tool inputs and result summaries never feed transcript persistence.
The persister commits the entire exchange and session totals atomically. A failure latches
and stops later model/command egress. Admission checks the live latch at each provider attempt and
effect preparation, and immediately before every actual tool dispatch, including unjournaled tools,
a cached idle-command key and a cost-write failure after provider admission. The dispatch check runs
after asynchronous approval and preparation. Its refusal proves dispatch never started and releases
any prepared claim. Settling or discarding an already-started effect remains available to record its outcome.
Errors and aborts commit no transcript; their billed cost remains real.

Resume, model reseat, export, boundary mapping and effect disclosure share the pure structural history
projection in `@relavium/shared`; existing core exports remain available. `completedSessionTurns`
selects its completed exchanges; `resumableMessageSequences` and `resumableTurnBoundarySequences`
supply the matching host boundary seeds. A tool-call row
with preamble text is never a terminal, and an unfinished exchange rolls back. An empty-final turn
restores its user message alone and counts as a completed turn. Compaction/trim boundaries retain
whole turns; `/trim` still takes message units. Export reads all historical completed turns,
including those superseded by a working-context boundary.

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

## Tools, secrets, and security scope

A session uses the **same** tool surface as a workflow agent: the built-in `ToolRegistry`
([built-in-tools.md](../shared-core/built-in-tools.md)), the same FS-scope tiers, and the same
mandatory guardrails (`run_command` allowlist; `git_commit` behind approval). Per
[ADR-0029](../../decisions/0029-tool-policy-hardening.md):

- a session inherits the agent's tools and may only **narrow** them, never escalate;
- a `secret`-typed value is **never interpolated** into a prompt or tool text;
- `context.variables` (the `{{ctx.*}}` map) is **plaintext supplied by the surface** that is echoed
  **verbatim** in the `session:started` event payload and persisted in the session row — it **MUST NOT**
  carry an API key or any secret. Route every secret through the keychain-backed `secret`-typed resolution
  above, never through `{{ctx.*}}`;
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

The export **produces** the format owned by [workflow-yaml-spec.md](workflow-yaml-spec.md); the
**mapping** (session turn → `agent` node, transcript → metadata) is the contract owned here. The
desktop "Export to Canvas" affordance and the CLI `relavium chat-export` both drive this one contract.

**Precise mapping (1.Z).** Given a loaded `AgentSessionRecord` + its ordered `SessionMessage[]`, the
exporter builds a `WorkflowDefinition` deterministically (no wall-clock / randomness, so the artifact is
reproducible and round-trips):

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
- **Workflow `id`** — a deterministic kebab slug of the title (ASCII alphanumerics only, matching
  `kebabIdSchema`; non-ASCII is stripped), falling back to `exported-session`. The scaffold's id is
  human-reviewed and renameable on the canvas.
- **`agents`** — the session's frozen `agentSnapshot` (an inline `Agent`) is emitted as the sole `agents[]`
  entry so `agent_ref` resolves; when no snapshot was captured, `agents` is omitted and `agent_ref` resolves
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
