# Workflow YAML Specification (v1.0)

- **Status**: Stable
- **File extension**: `.relavium.yaml` (or any `*.yaml` inside a project's `.relavium/` directory)
- **Schema version field**: `schema_version: '1.0'`
- **Validated by**: the `WorkflowSchema` Zod definition in `@relavium/shared`
- **Related**: [agent-yaml-spec.md](agent-yaml-spec.md), [config-spec.md](config-spec.md), [../shared-core/node-types.md](../shared-core/node-types.md), [../shared-core/built-in-tools.md](../shared-core/built-in-tools.md), [../shared-core/mcp-integration.md](../shared-core/mcp-integration.md)

A Relavium workflow is a **git-committable YAML file** describing a directed graph of nodes that agents and tools execute. It is the single most important user-facing artifact in Relavium and is treated as a **public API**: breaking changes to this schema would invalidate users' committed workflow files, so the format is versioned (`schema_version`) and any breaking change must ship with a migration path.

The same file parses and runs **identically** on every surface — desktop canvas, CLI, VS Code extension, and (Phase 2) cloud — because all surfaces load it through the one shared engine, `@relavium/core`. See [../../architecture/shared-core-engine.md](../../architecture/shared-core-engine.md).

> **Strict validation.** `WorkflowSchema` rejects unknown/mistyped keys rather than silently dropping them — a typo in a committed workflow fails at parse time with the offending path ([ADR-0023](../../decisions/0023-strict-authored-yaml-validation.md)). Forward-compatible additions ride the `schema_version` + a migration path.

## Why YAML

- Multiline strings (system prompts, message templates) are readable without escape sequences.
- Comments are legal (`#`) for inline version-history and rationale notes.
- It diffs cleanly in git and reviews well in a pull request.
- Each file is standalone and self-describing — no database lookup is required to understand it.

## Top-level structure

```yaml
schema_version: '1.0'        # required — validated for forward-compat parsing
workflow:
  id: string                 # required, unique, kebab-case
  version: semver            # e.g. '1.2.0'
  name: string
  description: string
  tags: string[]
  metadata: map              # optional free-form provenance (e.g. an exported session's transcript) — a schema field, preserved across save/round-trip (unlike YAML comments)

  trigger: Trigger           # what initiates this workflow (default: manual)
  inputs: Input[]            # typed input declarations
  context: ContextEntry[]    # shared variables exposed as {{ctx.*}}

  agents: AgentRef[]         # inline agents, or $ref to .agent.yaml files
  tools: ToolPolicy          # workflow-wide tool guardrails (command/domain allowlists)
  budget: Budget             # optional cost/time/concurrency guardrails (see Resource governance)
  timeout_ms: number         # optional whole-run wall-clock cap
  max_parallel: number       # optional cap on concurrent in-flight LLM calls
  nodes: Node[]              # execution-graph nodes
  edges: Edge[]              # directed connections between nodes
```

| Field | Required | Notes |
| --- | --- | --- |
| `schema_version` | yes | Top-level, outside `workflow:`. Currently `'1.0'`. |
| `workflow.id` | yes | Unique, kebab-case. |
| `workflow.version` | recommended | Semver of the workflow itself, for human change tracking. |
| `workflow.name` / `description` / `tags` | no | Display + filtering metadata. |
| `workflow.metadata` | no | Free-form provenance map — a real schema field, so it **survives parse → serialize round-trips** (unlike comments). Used by session export to carry the source transcript ([ADR-0026](../../decisions/0026-session-export-to-workflow.md)). |
| `trigger` | no | Defaults to `manual`. |
| `inputs` | no | Typed declarations validated before a run starts. |
| `context` | no | Named values (possibly interpolated) available as `{{ctx.key}}`. |
| `agents` | yes (if any agent node) | Inline definitions or refs to agent files. |
| `tools` | required to use `run_command` / `http_request` | Workflow-wide tool guardrails — exact-match `allowedCommands` and exact-FQDN `allowedDomains` (each empty/absent ⇒ that tool is disabled). See [Tool policy](#tool-policy-spectools). |
| `budget` / `timeout_ms` / `max_parallel` | no | Resource guardrails — a pre-egress cost cap, a whole-run timeout, and a concurrency cap. See [Resource governance](#resource-governance-specbudget) and [ADR-0028](../../decisions/0028-workflow-resource-governance.md). |
| `nodes` | yes | The graph. |
| `edges` | yes | The connections. |

## Triggers

`trigger.type` is one of:

| Type | Purpose | Extra fields |
| --- | --- | --- |
| `manual` | Run on demand (default; the only Phase-1 trigger that fires automatically from a surface). | — |
| `webhook` | Run on an inbound HTTP call. | `webhook: { path: string, secret_env: string }` |
| `schedule` | Run on a cron schedule. | `schedule: <cron_expression>` |
| `file_change` | Run when matching files change. | `file_change: { glob: string, debounce_ms: number }` |
| `mcp_call` | Run when invoked as an MCP tool by an external client. | — (see [../shared-core/mcp-integration.md](../shared-core/mcp-integration.md)) |

> **Phase note.** `webhook` and `schedule` triggers are declarable in the file but require an always-on listener to fire automatically. In Phase 1 (local-first) they are honored when the workflow is invoked manually or by a watcher the user runs; cloud-hosted automatic firing is a **Phase 2** capability. See [../../ideas/scheduled-and-webhook-triggers.md](../../ideas/scheduled-and-webhook-triggers.md).

## Inputs

```yaml
inputs:
  - name: file_path
    type: file_path          # string | number | boolean | file_path | code_diff | secret
    required: true
    description: Path to the TypeScript file to review
  - name: reviewer_email
    type: string
    required: false
    default: 'team@example.com'
```

An input `name` must be a **referenceable identifier** — `[A-Za-z0-9_-]+` (letters, digits, `_` or `-`),
the same charset the `{{inputs.<name>}}` head accepts — so a name like `my name` or `a.b` that could never
be referenced is rejected at parse (ADR-0023).

`secret`-typed inputs are resolved through the secret store, never written into run logs or the workflow file. They are also **masked in event payloads**: a `secret` input's value is redacted from the `run:started.inputs` payload (and any other event that echoes inputs), so a secret never reaches a surface, an IPC channel, or a persisted run log — see the masking rule in [sse-event-schema.md](sse-event-schema.md). See also [../desktop/keychain-and-secrets.md](../desktop/keychain-and-secrets.md).

An input may carry an optional **`validation`** object the engine checks before a run starts; a violating input fails fast and the run never begins:

```yaml
inputs:
  - name: reviewer_email
    type: string
    validation: { format: email, max_length: 100 } # string keys: format, pattern, enum, min_length, max_length
  - name: severity
    type: number
    validation: { min: 0, max: 10 } # number keys: min, max, enum
```

**Validation keys are type-scoped** — the parser rejects a key that doesn't apply to the input's
`type` (e.g. `min` on a `string`, or `max_length` on a `number`):

| `type` | allowed `validation` keys |
|--------|---------------------------|
| `number` | `min`, `max`, `enum` |
| `string` / `file_path` / `code_diff` / `secret` | `format`, `pattern`, `enum`, `min_length`, `max_length` |
| `boolean` | _(none)_ |

(Bound-ordering — `min ≤ max`, `min_length ≤ max_length` — is also enforced at parse.)

> **Secrets are never interpolated into agent text.** A `secret`-typed input may feed a tool credential/header field, but the parser **rejects** a `secret` input interpolated into a `prompt_template` or any agent/tool text — masking only covers *event* payloads, so an interpolated secret would otherwise reach the model and be persisted in the message store. The rejection is **transitive** (taint-tracked through `context` entries and any derived value — a secret cannot be laundered through an intermediate variable). This is a security tightening; see [ADR-0029](../../decisions/0029-tool-policy-hardening.md).

## Context and interpolation

`context` declares named values available throughout the workflow as `{{ctx.key}}`. `{{ ... }}` interpolation is for **template fields only** — `inputs` defaults, `context` values, agent `prompt_template` / `system_prompt_append`, and human-gate `assignee` / `message_template`. The **expression fields** are **bare sandboxed JavaScript** ([ADR-0027](../../decisions/0027-expression-sandbox.md)), *not* interpolation: they read the same run scope directly as `run.outputs["x"]` / `inputs.y` / `ctx.z` with no `{{ }}` wrapper. The three sandboxed kinds (the 1.AB `ExpressionKind`) are a `condition` node's `expression`, a `transform`, and a `merge_fn` — each `js` (a `condition`/`transform` carries `expression_type: js`; `jmespath`/`jsonlogic` are reserved and rejected at parse; a `merge_fn` is always `js`). An **edge `condition`** is the same JS-expression family but has **no `expression_type` field** (always `js`) and is evaluated by the run loop (1.N), not a named 1.AB sandbox kind. A context `key`, like an input `name`, must be a referenceable identifier (`[A-Za-z0-9_-]+`).

```yaml
context:
  - key: focus_area
    value: 'security vulnerabilities and type safety'
  - key: code_content
    value: '{{inputs.file_path | read_file}}'   # pipe filters are supported
```

Common interpolation namespaces:

- `{{inputs.<name>}}` — declared workflow inputs.
- `{{ctx.<key>}}` — context entries.
- `{{run.outputs["<node-id>"]}}` — a completed node's output, in a template field; the same data is read as bare `run.outputs["<node-id>"]` (no `{{ }}`) inside a `condition` / `transform` / `merge_fn` expression.
- Pipe filters: `| read_file`, `| json`, `| length`, `| default("…")`.

> **Evaluation timing.** `context` entries are evaluated **eagerly, exactly once, before any node runs**, and the resolved values are immutable and cached for the whole run. A pipe-filter failure (e.g. `read_file` on a missing path) is a **validation error** that fails the run before it starts (CLI exit code 2), never a mid-run surprise. A `context` value may reference `{{inputs.*}}` but **not** `{{run.outputs[...]}}` (no node has run yet) — doing so is a parse error.

## Agents

Agents are declared inline under `agents:` or referenced from a separate `.agent.yaml` file. An inline `AgentRef` carries the model, provider, prompt, and resilience config. The full agent schema (including `fallback_chain`) is documented in [agent-yaml-spec.md](agent-yaml-spec.md).

```yaml
agents:
  - id: security-scanner
    name: Security Scanner
    model: claude-sonnet-4-6
    provider: anthropic
    system_prompt: |
      You are a security-focused code reviewer. Analyze the code for
      vulnerabilities, injection risks, and unsafe patterns. Return JSON:
      {issues: [{severity, line, description, fix}], score: 0-10}
    temperature: 0.1
    max_tokens: 1024
    retry: { max: 3, backoff: exponential }
    fallback_chain:
      - model: gpt-4o
        provider: openai
        max_attempts: 2
```

A node binds to an agent with `agent_ref: <agent-id>`.

## Nodes

Each node has an `id` (kebab-case, unique within the workflow) and a `type`. The v1.0 file format exposes these node types:

| `type` | Purpose | Key fields |
| --- | --- | --- |
| `input` | Workflow entry point; emits the resolved inputs. | — |
| `agent` | Invoke an agent (LLM call with tools). | `agent_ref`, `prompt_template`, `tools`, `model`, `temperature`, `max_tokens`, `timeout_ms`, `retry` |
| `human_gate` | Pause for human approval / input / review. | `gate_type`, `assignee`, `message_template`, `timeout_ms`, `timeout_action` |
| `condition` | Branch on a JS expression over run outputs. | `expression`, `branches[]` (`when`, `target_node`), `default`, `retry` |
| `transform` | Reshape state without an LLM (JS expression). | `transform`, `retry` |
| `parallel` | Fan out to several nodes concurrently. | `parallel_of[]` |
| `merge` | Fan in / combine parallel results. | `merge_strategy`, `merge_fn`, `retry` |
| `output` | Terminal node capturing the final result. | `output_format` |

> **Canvas vs. engine node taxonomy.** The desktop canvas renders a richer set of node *components* (e.g. `FanOutNode`, `AggregatorNode`, `LoopNode`, `ToolNode`), and the engine's internal node-type enum additionally recognizes `tool`, `loop`, and `subworkflow`. The v1.0 YAML above is the user-authored surface; the full catalog and how the two map is in [../shared-core/node-types.md](../shared-core/node-types.md).

> **`retry` on non-agent nodes.** `condition`, `transform`, and `merge` accept the same optional `retry`
> budget as `agent` — the engine's above-chain node-retry ([ADR-0040](../../decisions/0040-node-retry-budget-above-the-chain.md)): on a retryable failure the whole node is re-dispatched up to `max` total attempts with `backoff`/`backoff_ms`, optionally filtered by `retry_on`. The field shape is owned by [agent-yaml-spec.md](agent-yaml-spec.md#retry-vs-fallback). `input`, `output`, `parallel`, and `human_gate` carry no `retry` (they cannot produce a transient failure; a gate timeout is fatal).

### `agent` node

```yaml
- id: security-scan-node
  type: agent
  agent_ref: security-scanner       # references agents[] by id
  system_prompt_append: |            # optional: appended to the agent's system_prompt for THIS node
    For this task, focus only on authentication and injection issues.
  prompt_template: |
    Review this TypeScript file for security issues:
    ```typescript
    {{ctx.code_content}}
    ```
  model: claude-sonnet-4-6           # optional per-node override (resolved against the catalog at parse)
  temperature: 0.1                   # optional override
  max_tokens: 1024                   # optional override
  tools: [read_file]                 # NARROWS the agent's tools for this node (never widens — see note)
  output_schema:                     # optional: validate the node's output (JSON-Schema subset)
    type: object
    required: [score]
    properties: { score: { type: number } }
  timeout_ms: 60000
  retry: { max: 3, backoff: linear } # linear | exponential
```

> **Node overrides narrow, they never escalate.** A node may override `model` / `temperature` /
> `max_tokens` / `system_prompt_append`, and its `tools:` list may only **narrow** the agent's granted
> tools — it can never add a tool the agent lacks (validator-enforced; [ADR-0029](../../decisions/0029-tool-policy-hardening.md)).
> A `model` override is **resolved against the model catalog at parse time**; an unknown model id fails
> parse with the list of valid options — never a silent fallback. The optional `output_schema` (also on
> `transform`) validates the node's output and powers type-safe downstream interpolation
> and VS Code completion ([ADR-0023](../../decisions/0023-strict-authored-yaml-validation.md)). A
> `condition` node selects a branch rather than producing shaped data, so it carries no `output_schema`.

### `human_gate` node

```yaml
- id: human-approval
  type: human_gate
  gate_type: approval                # approval | input | review
  assignee: '{{inputs.reviewer_email}}'
  message_template: |
    Security scan flagged issues in {{inputs.file_path}}.
    Score: {{run.outputs["security-scan-node"].score}}/10.
  timeout_ms: 86400000               # 24h
  timeout_action: reject             # reject | approve  (escalate is reserved — see note)
```

`timeout_action: approve` auto-approves on timeout — dangerous; use sparingly. **`escalate` is reserved in v1.0**: real escalation needs a Phase-2 notification system, so the validator rejects it for now (use `reject` or `approve`); a timeout then resolves with `decidedBy: 'timeout'`. Because parallel branches may each reach a gate, **multiple gates can be pending at once** — each carries an independent timeout and the surfaces show a pending-gate queue (`relavium gate list`). The gate lifecycle (suspend → notify → resume) is described in [sse-event-schema.md](sse-event-schema.md) and [../../architecture/execution-model.md](../../architecture/execution-model.md).

### `condition` node

```yaml
- id: severity-gate
  type: condition
  expression: 'run.outputs["security-scan-node"].score < 7'
  branches:
    - when: true             # taken when the expression evaluates to this value
      target_node: human-approval
    - when: false
      target_node: synthesize-report
  default: synthesize-report  # taken when no `when` matches the evaluated result
```

A condition node evaluates `expression` **once** and selects the branch whose `when` value **strictly equals** (`===`, no type coercion) the result; `when` values must be a boolean, string, or number. If no `when` matches and no `default` is set, the run fails with a typed "no branch matched" error rather than stalling. The `when` values are also the named output handles, referenceable from edges as `nodeId:when` (see [Edges](#edges)).

The `expression:` string is a **sandboxed JavaScript expression** — in v1.0 the only `expression_type` is **`js`**, evaluated in a deterministic, resource-capped sandbox (no I/O, no ambient globals, no wall-clock/RNG; [ADR-0027](../../decisions/0027-expression-sandbox.md)). `jmespath` and `jsonlogic` are **reserved** (each would add an undeclared dependency) and deferred to a future ADR. **There is no Python evaluator** — the engine is pure TypeScript ([ADR-0003](../../decisions/0003-pure-ts-engine-not-langgraph-python.md)). The `expression_type` set is owned by [node-types.md](../shared-core/node-types.md#per-type-engine-config); the full sandbox contract — scope, allow-list, caps, determinism, and the `sandbox_error` taxonomy — is owned by [expression-sandbox-spec.md](../shared-core/expression-sandbox-spec.md). Note an expression's **JS syntax is checked at evaluation, not at parse** — a typo'd `expression` parses fine and fails the first time its node runs, so test workflows before production. (An `expression_type` other than `js`, by contrast, **is** rejected at parse.)

### `transform` node

```yaml
- id: shape-result
  type: transform
  transform: '{ files: run.outputs["scan"].issues.map(i => i.line) }'
```

A sandboxed JavaScript expression (`expression_type: js`) whose result becomes the node's output. No LLM call. As with `condition`, v1.0 ships **`js` only** (jmespath/jsonlogic reserved; [ADR-0027](../../decisions/0027-expression-sandbox.md)), evaluated in the deterministic sandbox, and there is no Python evaluator — see [node-types.md](../shared-core/node-types.md#per-type-engine-config). A `transform` may carry an optional `output_schema` to validate its reshaped result.

### `parallel` and `merge` nodes

```yaml
- id: fan-out
  type: parallel
  parallel_of: [security-scan-node, style-review-node]  # declares branch membership; see note

- id: merge
  type: merge
  merge_strategy: object_merge       # concat | object_merge | first | custom
  merge_fn: |                        # required only when strategy = custom (a `js` expression)
    { ...branches[0], ...branches[1] }   # `branches` = branch outputs in static `parallel_of` order
```

`merge_strategy` is the **authoritative** name for the aggregation behavior; the canvas (`AggregatorNode`) and engine (`fan_in_config`) carry the same value — see the [merge-strategy reconciliation table](../shared-core/node-types.md#merge-strategy-reconciliation). `best_of_n` (a secondary-LLM picker) is **reserved, not v1.0**, and is not a valid `merge_strategy` value in `'1.0'`. A custom `merge_fn` is a **bare `js` expression** (not a function) evaluated in the [expression sandbox](../shared-core/expression-sandbox-spec.md); it receives `branches` — the branch outputs in **static `parallel_of` declaration order** (never arrival order, so the merge is deterministic) — plus `run.outputs`.

> **`parallel_of` is authoritative for branch membership.** On a `parallel` node, `parallel_of: [...]` alone defines which nodes are the concurrent branches; the parser materializes a fan-out edge to each listed node, so explicit `from: fan-out` edges are **not required**. The complete example below writes them out for readability, but they are redundant with `parallel_of` and must not contradict it — if both are present they must agree (the validator rejects an explicit fan-out edge to a node not in `parallel_of`).

## Tool policy (`spec.tools`)

Workflow-wide tool guardrails live under a top-level `tools:` block. This is the **canonical home** for the command allowlist that [built-in-tools.md](../shared-core/built-in-tools.md) references — `run_command` never executes a command that is not on this list.

```yaml
workflow:
  # …
  tools:
    allowedCommands:            # EXACT-match allowlist for `run_command` (the whole resolved command)
      - 'npm test'              # matched exactly — 'npm test --coverage' would NOT match
      - 'npm run lint'
      - 'git diff'
    allowedCommandGlobs:        # optional, opt-in pattern matching (riskier — use sparingly)
      - 'npm run *'
    allowedDomains:             # exact-FQDN allowlist for `http_request` (HTTPS only, SSRF-guarded)
      - 'api.github.com'
```

| Field | Required | Notes |
| --- | --- | --- |
| `tools.allowedCommands` | required to use `run_command` | **Exact-match** allowlist of permitted shell commands — the full resolved command must equal an entry (`'git'` does **not** permit `git push`). **Empty or absent ⇒ `run_command` is disabled.** Engine-enforced ([ADR-0029](../../decisions/0029-tool-policy-hardening.md)). |
| `tools.allowedCommandGlobs` | no | Opt-in glob patterns for `run_command` (e.g. `'npm run *'`). Riskier than exact match; off by default. |
| `tools.allowedDomains` | required to use `http_request` | Exact-FQDN allowlist for `http_request`. **HTTPS only**, and private/loopback/link-local/metadata ranges are blocked (the same SSRF guard as a provider base URL and MCP server URLs — [security-review.md](../../standards/security-review.md), [ADR-0029](../../decisions/0029-tool-policy-hardening.md)). **Empty or absent ⇒ `http_request` is disabled** (deny-all, symmetric with `allowedCommands`). |

The command allowlist is **independent of the filesystem scope tier** (a workflow can be FS-sandboxed *and* still carry an empty command allowlist). The FS tier itself is set in project config (`fs_scope`), not here — see [config-spec.md](config-spec.md) and [built-in-tools.md](../shared-core/built-in-tools.md#filesystem-permission-tiers).

> **Public workflow-API tightening ([ADR-0029](../../decisions/0029-tool-policy-hardening.md)).** Exact-match `allowedCommands`, deny-all-when-empty `allowedDomains`, the SSRF range-block on `http_request` (and MCP server URLs), and node-`tools:` narrow-only are deliberate **behavior changes**, not additive options — cheap to land now because no authored workflow exists yet. The binding security rules live in [security-review.md](../../standards/security-review.md).

## Resource governance (`spec.budget`)

Optional, author-declared guardrails that bound a run's **cost**, **time**, and **concurrency**, enforced by the engine ([ADR-0028](../../decisions/0028-workflow-resource-governance.md)).

```yaml
workflow:
  # …
  budget:
    max_cost_microcents: 5000000     # ~$0.05 cap (integer micro-cents)
    on_exceed: pause_for_approval    # fail | pause_for_approval | warn
  timeout_ms: 300000                 # whole-run wall-clock cap
  max_parallel: 4                    # max concurrent in-flight LLM calls (bounds a wide fan-out)
```

The cost cap is **pre-egress**: before each LLM call the engine checks `cumulative + worstCaseNextEstimate(maxTokens)` against `max_cost_microcents` and applies `on_exceed` — `fail` stops the run, `pause_for_approval` suspends it like a human gate (resumed via `resume_budget`), `warn` proceeds after a `budget:warning` event. This is a **BYOK-local** safety rail, distinct from Phase-2 managed-mode billing ([ADR-0014](../../decisions/0014-managed-metering-quota-and-billing.md)). The `budget:warning` / `budget:paused` / `run:timeout` events are defined in [sse-event-schema.md](sse-event-schema.md).

## Edges

Edges are explicit directed connections. An edge from a `condition`/branching node uses the `nodeId:handleName` form to reference a named output handle/branch. **A plain (handle-less) edge whose `from` is a `condition` node is rejected at parse** — a `condition` routes only via its `branches[].target_node` (and the optional `nodeId:when` handle edge), so a handle-less edge from it is either redundant with a dependency already materialized from a branch target, or it names a downstream the branch selection never activates (a silently dead node). Use the `nodeId:when` form, or rely on `branches[].target_node` alone (the routing edge is materialized either way).

```yaml
edges:
  - from: input
    to: fan-out
  - from: fan-out
    to: security-scan-node
  - from: severity-gate:true        # branch handle (the `when` value) on the condition node
    to: human-approval
  - from: severity-gate:false
    to: synthesize-report
```

| Field | Required | Notes |
| --- | --- | --- |
| `from` | yes | Source node id, optionally `nodeId:handle`. |
| `to` | yes | Target node id. |
| `label` | no | Display label. |
| `condition` | no | JS expression; the edge is followed only when truthy. Omit for unconditional. |
| `data_mapping` | — | **Reserved / engine-internal in v1.0** — not an authored field; reshape state via a `transform` node or a custom `merge_fn` instead. |
| `on_error` | — | **Reserved (forward-compat; not authorable in v1.0)** — see the reservation note below. |

> **Reserved: `on_error` error-routing edges.** A per-node error port — an edge kind that routes a
> node's *failure* (rather than its output) to a designated handler branch — is **reserved** for a
> post-v1.0 schema revision: the slot is named in this contract so adding it later is additive, but
> there is no v1.0 authored field and no Phase-1 engine handler. Authoring `on_error` today is
> rejected at parse like any unknown key
> ([ADR-0023](../../decisions/0023-strict-authored-yaml-validation.md)). *Considered for v1.0 and
> deliberately deferred:* v1.0 failure semantics stay the simple, predictable pair — per-node
> `retry` plus run failure (a required node is never silently skipped) — and graph-level error
> routing interacts with fan-in strategies, gate timeouts, and checkpoint/resume in ways that
> deserve their own design pass, recorded in a future ADR before the engine grows a third failure
> path.

## Complete example

A three-stage code review: a parallel security scan and style review, a merge, a severity-driven condition, a human approval gate, and a synthesized markdown report.

```yaml
# .relavium/code-review-pipeline.relavium.yaml
schema_version: '1.0'
workflow:
  id: code-review-pipeline
  version: '1.2.0'
  name: Code Review Pipeline
  description: |
    Three-stage code review: security scan, style review, and human approval gate.
  tags: [engineering, review, security]

  trigger:
    type: file_change
    file_change:
      glob: 'src/**/*.ts'
      debounce_ms: 2000

  inputs:
    - name: file_path
      type: file_path
      required: true
      description: Path to the TypeScript file to review
    - name: reviewer_email
      type: string
      required: false
      default: 'team@example.com'
      description: Email to notify when human gate is reached

  context:
    - key: focus_area
      value: 'security vulnerabilities and type safety'
    - key: code_content
      value: '{{inputs.file_path | read_file}}'

  agents:
    - id: security-scanner
      name: Security Scanner
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: |
        You are a security-focused code reviewer. Analyze the following TypeScript
        code for security vulnerabilities, injection risks, and unsafe patterns.
        Return a JSON object: {issues: [{severity, line, description, fix}], score: 0-10}
      temperature: 0.1
      max_tokens: 1024
      retry:
        max: 3
        backoff: exponential
      fallback_chain:
        - model: gpt-4o
          provider: openai
          max_attempts: 2

    - id: style-reviewer
      name: Style Reviewer
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: |
        You are a TypeScript style and architecture reviewer. Return JSON:
        {suggestions: [{type, line, message}], overall_grade: A|B|C|D|F}
      temperature: 0.2
      max_tokens: 1024

    - id: report-synthesizer
      name: Report Synthesizer
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: |
        Combine the security scan and style review results into a single,
        readable markdown report suitable for a pull request comment.
      temperature: 0.3
      max_tokens: 2048

  nodes:
    - id: input
      type: input

    - id: fan-out
      type: parallel
      parallel_of: [security-scan-node, style-review-node]

    - id: security-scan-node
      type: agent
      agent_ref: security-scanner
      prompt_template: |
        Review this TypeScript file for security issues:
        ```typescript
        {{ctx.code_content}}
        ```
      timeout_ms: 60000

    - id: style-review-node
      type: agent
      agent_ref: style-reviewer
      prompt_template: |
        Review this TypeScript file for style and architecture:
        ```typescript
        {{ctx.code_content}}
        ```
      timeout_ms: 60000

    - id: merge
      type: merge
      merge_strategy: object_merge

    - id: severity-gate
      type: condition
      expression: 'run.outputs["security-scan-node"].score < 7'
      branches:
        - when: true
          target_node: human-approval
        - when: false
          target_node: synthesize-report
      default: synthesize-report

    - id: human-approval
      type: human_gate
      gate_type: approval
      assignee: '{{inputs.reviewer_email}}'
      message_template: |
        Security scan flagged issues in {{inputs.file_path}}.
        Score: {{run.outputs["security-scan-node"].score}}/10.
        Issues found: {{run.outputs["security-scan-node"].issues | length}}.
        Approve to continue to report generation, or reject to halt.
      timeout_ms: 86400000
      timeout_action: reject

    - id: synthesize-report
      type: agent
      agent_ref: report-synthesizer
      prompt_template: |
        Security results: {{run.outputs["security-scan-node"] | json}}
        Style results: {{run.outputs["style-review-node"] | json}}
        Human gate decision: {{run.outputs["human-approval"].decision | default("not required")}}
      timeout_ms: 45000

    - id: output
      type: output
      output_format: markdown

  edges:
    - { from: input, to: fan-out }
    - { from: fan-out, to: security-scan-node }
    - { from: fan-out, to: style-review-node }
    - { from: security-scan-node, to: merge }
    - { from: style-review-node, to: merge }
    - { from: merge, to: severity-gate }
    - { from: 'severity-gate:true', to: human-approval }
    - { from: 'severity-gate:false', to: synthesize-report }
    - { from: human-approval, to: synthesize-report }
    - { from: synthesize-report, to: output }
```

## Validation and versioning rules

- The file is parsed and validated against `WorkflowSchema` (Zod, in `@relavium/shared`) at load time; invalid files throw a `WorkflowValidationError` and never start a run.
- `schema_version` is the migration anchor. The format is a public API: breaking changes require a new `schema_version` and a migration tool. Add new optional fields freely; never repurpose or remove an existing one within `'1.0'`.
- Node `id`s must be unique within a workflow and are referenced by edges, conditions, templates, and `run.outputs`.
- Secrets are never embedded in the file — `secret` inputs and tool credentials are resolved from the secret store at run time (see [../desktop/keychain-and-secrets.md](../desktop/keychain-and-secrets.md)).

For the run-time event stream a workflow produces, see [sse-event-schema.md](sse-event-schema.md). For how a run is scheduled and executed, see [../../architecture/execution-model.md](../../architecture/execution-model.md).
