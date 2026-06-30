# Agent Session Specification

- **Status**: Stable
- **Validated by**: the `AgentSessionSchema` / `SessionMessageSchema` / `SessionContextSchema` Zod definitions in `@relavium/shared` — `SessionContextSchema` lands with the event union (1.L.0); `SessionMessageSchema` / `AgentSessionSchema` land with the agent-first sub-spine (1.V/1.X), as they reference the shared-owned `ContentPart`
- **Canonical home**: the runtime contract for an `AgentSession` — its lifecycle, message shape, context, and export-to-workflow contract
- **Related**: [workflow-yaml-spec.md](workflow-yaml-spec.md), [agent-yaml-spec.md](agent-yaml-spec.md), [config-spec.md](config-spec.md), [sse-event-schema.md](sse-event-schema.md) (the `session:*` event namespace), [../shared-core/llm-provider-seam.md](../shared-core/llm-provider-seam.md) (the `LlmMessage` runtime type this maps to), [../shared-core/built-in-tools.md](../shared-core/built-in-tools.md), [../desktop/database-schema.md](../desktop/database-schema.md) (the `agent_sessions` / `session_messages` tables), [../../architecture/agent-sessions.md](../../architecture/agent-sessions.md), [../../decisions/0024-agent-first-entry-point-agentsession.md](../../decisions/0024-agent-first-entry-point-agentsession.md), [../../decisions/0026-session-export-to-workflow.md](../../decisions/0026-session-export-to-workflow.md)

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

- A session **binds one agent** (an `.agent.yaml`, [agent-yaml-spec.md](agent-yaml-spec.md)) and its
  `fallback_chain` for the whole conversation. There is **no mid-session agent switching** in Phase 1;
  multi-agent orchestration remains a *workflow* concern.
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
| **sendMessage** | Append a user [`SessionMessage`](#session-messages), run one assistant turn through the `AgentRunner` (streaming + tool-call loop), and append the assistant + tool messages. |
| **setTurnPolicy** | Set/clear the **reseat-less mode policy** (ADR-0057) — the advertise-filter + the interactive approval hook — on the **same** session instance (no reseat, no tool-context loss). Snapshotted at each turn start, so a change applies on the **next** turn. The ask / plan / accept-edits / auto enum lives in the host; this is its mode-agnostic engine projection. Callable in any state, including mid-turn; **inert once cancelled** (a cancelled session runs no further turn, so the policy is never read again). |
| **abort** | **Mid-turn abort** (ADR-0057 EA7): end the *in-flight turn* via its `AbortSignal` but **keep the session alive** — settle **one** `session:turn_completed{stopReason:'aborted'}` (no error), roll the pending user message back, and return to `idle`. **Distinct from `cancel`** (which is terminal): no `session:cancelled`, no new status. No-op when no turn is in flight; a concurrent `cancel` wins. A **late** abort that lands after the turn already resolved is **also a no-op** — that turn completes normally and its reply is **kept** (`abort` interrupts an in-flight turn only, never discards a finished one). |
| **cancel** | Abort the in-flight turn via `AbortSignal` **and end the session** (the terminal `session:cancelled`); the session stays resumable from its persisted transcript. |
| **resume** | Reload a persisted session (messages + context) and continue. |
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
  content: DurableContentPart[];          // the PERSISTED content union (ADR-0031): handle-only media, signature-less reasoning
  modelId?: string;                       // canonical model id for an assistant turn (fallback-aware; mirrors session_messages.model_id)
  timestamp: string;                      // ISO 8601
}
```

> **Amended 2026-06-10 (ADR-0031 / 1.AD).** A persisted position references the **durable**
> content union, not the in-flight `ContentPart`: `DurableContentPart` (owned by
> `@relavium/shared`, see [llm-provider-seam.md](../shared-core/llm-provider-seam.md)
> §"Seam-shape amendments (ADR-0031)") makes media handle-only and drops the reasoning
> `signature` structurally — the engine's `deInlineMedia` pass is the in-flight→durable
> transform. Binding on the session-persistence implementation (1.X).

`SessionMessage` is **mapped to the seam's `LlmMessage` at call time, never copied** — when the
session calls a provider, the `AgentRunner` projects the persisted messages into the `LlmMessage`
shape owned by [llm-provider-seam.md](../shared-core/llm-provider-seam.md). **No vendor SDK type
crosses the seam** ([ADR-0011](../../decisions/0011-internal-llm-abstraction.md)): both unions are
Relavium-owned types from `@relavium/shared`, but they are **distinct by design** —
`DurableContentPart` is the persisted form (handle-only media, signature-less reasoning), while
`ContentPart` is the in-flight form `LlmMessage` carries. The projection bridges the two existing
types (resolving durable handles for egress); it never invents a new shape.

> **Relationship to the run `messages` table.** A session's messages are persisted in
> **`session_messages`**, bound to a **session** — distinct from the existing per-step run `messages`
> table, which is bound to a **`step_executions`** row within a workflow run. The two are deliberately
> separate (different lifecycle and FK parent); see the table definitions in
> [database-schema.md](../desktop/database-schema.md). They share a shape family but must not be
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

- the session's assistant turns become a **linear chain of `agent` nodes**, in order, carrying the
  agent binding, resolved prompts, and the tools used;
- the **full transcript is preserved in the workflow's durable `metadata` field** — a schema field that survives parse → serialize round-trips (not fragile comments), with secrets already excluded by
  the no-interpolation rule above);
- parallel / conditional / loop structure is **not** auto-inferred — the author adds it on the canvas.

The export **produces** the format owned by [workflow-yaml-spec.md](workflow-yaml-spec.md); the
**mapping** (session turn → `agent` node, transcript → metadata) is the contract owned here. The
desktop "Export to Canvas" affordance and the CLI `relavium chat-export` both drive this one contract.

**Precise mapping (1.Z).** Given a loaded `AgentSessionRecord` + its ordered `SessionMessage[]`, the
exporter builds a `WorkflowDefinition` deterministically (no wall-clock / randomness, so the artifact is
reproducible and round-trips):

- **Nodes** — a single `input` node (`id: input`), then **one `agent` node per COMPLETED logical turn** in
  `sequenceNumber` order (`id: turn-1`, `turn-2`, … — 1-based), then one `output` node (`id: output`). A
  *logical turn* is the contiguous `user` message(s) plus the assistant/tool messages answering them (a host
  may persist a single turn as split rows — `user → assistant(tool_call) → tool → assistant(text)`); it is one
  node, not one per assistant message. A turn is *completed* only if it produced final assistant **text** — an
  unanswered or interrupted-mid-tool-loop turn (no final text) is **omitted from the chain** (kept verbatim in
  `metadata`), so export and `reconstructSessionState`'s rollback (1.Y) agree on what a turn is. Each `agent`
  node carries: `agent_ref` = the session's `agentSlug`; `prompt_template` = the **text** of the turn's
  `user` message(s), with interpolation openers neutralized (omitted if empty); `tools` = the deduped union of
  tool names invoked across the turn's assistant messages (the `tool_call` parts), omitted when none. No
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
- **`metadata`** — the full transcript under a single reserved key: `metadata.relaviumExport = { source:
  'session', sessionId, agentSlug, title?, createdAt, updatedAt, messages: SessionMessage[] }`. It is a real
  schema field (`z.record`), so it survives parse → serialize round-trips.
- **Determinism + exclusions** — the YAML emitter (1.Z, `serializeWorkflow`; 1.L is parse-only) sorts map
  keys alphabetically and preserves array order, so `parse → serialize` is byte-stable. No `secret` value can
  appear (secrets never enter a message — [ADR-0029](../../decisions/0029-tool-policy-hardening.md)) and no
  reasoning `signature` can appear (the transcript is `DurableContentPart`, which structurally omits it —
  [ADR-0030](../../decisions/0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md)).

## Validation and persistence

- Validated against `AgentSessionSchema` / `SessionMessageSchema` / `SessionContextSchema` (Zod, in
  `@relavium/shared`) — invalid input fails fast, like every other authored/runtime contract
  ([ADR-0023](../../decisions/0023-strict-authored-yaml-validation.md)).
- Persisted in the global `history.db` (`agent_sessions` + `session_messages`; on the CLI surface
  unencrypted at rest, `0600`/`0700`-guarded per [ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md)); the DDL is
  canonical in [database-schema.md](../desktop/database-schema.md). API keys never appear in a session
  row, a message, or an event payload (see [keychain-and-secrets.md](../desktop/keychain-and-secrets.md)).
