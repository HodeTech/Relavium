# Workflow YAML Specification (v1.0)

- **Status**: Stable
- **File extension**: `.relavium.yaml` (or any `*.yaml` inside a project's `.relavium/` directory)
- **Schema version field**: `schema_version: '1.0'`
- **Validated by**: the `WorkflowSchema` Zod definition in `@relavium/shared`
- **Related**: [agent-yaml-spec.md](agent-yaml-spec.md), [config-spec.md](config-spec.md), [../shared-core/node-types.md](../shared-core/node-types.md), [../shared-core/built-in-tools.md](../shared-core/built-in-tools.md), [../shared-core/mcp-integration.md](../shared-core/mcp-integration.md)

A Relavium workflow is a **git-committable YAML file** describing a directed graph of nodes that agents and tools execute. It is the single most important user-facing artifact in Relavium and is treated as a **public API**: breaking changes to this schema would invalidate users' committed workflow files, so the format is versioned (`schema_version`) and any breaking change must ship with a migration path.

The same file parses and runs **identically** on every surface — desktop canvas, CLI, VS Code extension, and (Phase 2) cloud — because all surfaces load it through the one shared engine, `@relavium/core`. See [../../architecture/shared-core-engine.md](../../architecture/shared-core-engine.md).

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

  trigger: Trigger           # what initiates this workflow (default: manual)
  inputs: Input[]            # typed input declarations
  context: ContextEntry[]    # shared variables exposed as {{ctx.*}}

  agents: AgentRef[]         # inline agents, or $ref to .agent.yaml files
  tools: ToolPolicy          # workflow-wide tool guardrails (command/domain allowlists)
  nodes: Node[]              # execution-graph nodes
  edges: Edge[]              # directed connections between nodes
```

| Field | Required | Notes |
| --- | --- | --- |
| `schema_version` | yes | Top-level, outside `workflow:`. Currently `'1.0'`. |
| `workflow.id` | yes | Unique, kebab-case. |
| `workflow.version` | recommended | Semver of the workflow itself, for human change tracking. |
| `workflow.name` / `description` / `tags` | no | Display + filtering metadata. |
| `trigger` | no | Defaults to `manual`. |
| `inputs` | no | Typed declarations validated before a run starts. |
| `context` | no | Named values (possibly interpolated) available as `{{ctx.key}}`. |
| `agents` | yes (if any agent node) | Inline definitions or refs to agent files. |
| `tools` | required to use `run_command` | Workflow-wide tool guardrails — `allowedCommands` (and optional `allowedDomains`). See [Tool policy](#tool-policy-spectools). |
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

`secret`-typed inputs are resolved through the secret store, never written into run logs or the workflow file. See [../desktop/keychain-and-secrets.md](../desktop/keychain-and-secrets.md).

## Context and interpolation

`context` declares named values available throughout the workflow as `{{ctx.key}}`. Interpolation uses `{{ ... }}` syntax everywhere (inputs, context, prompt templates, message templates, edge/condition expressions).

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
- `{{run.outputs["<node-id>"]}}` — a completed node's output (used in conditions, templates, and merges).
- Pipe filters: `| read_file`, `| json`, `| length`, `| default("…")`.

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
| `condition` | Branch on a JS expression over run outputs. | `condition`, `branches[]` |
| `transform` | Reshape state without an LLM (JS expression). | `transform` |
| `parallel` | Fan out to several nodes concurrently. | `parallel_of[]` |
| `merge` | Fan in / combine parallel results. | `merge_strategy`, `merge_fn` |
| `output` | Terminal node capturing the final result. | `output_format` |

> **Canvas vs. engine node taxonomy.** The desktop canvas renders a richer set of node *components* (e.g. `FanOutNode`, `AggregatorNode`, `LoopNode`, `ToolNode`), and the engine's internal node-type enum additionally recognizes `tool`, `loop`, and `subworkflow`. The v1.0 YAML above is the user-authored surface; the full catalog and how the two map is in [../shared-core/node-types.md](../shared-core/node-types.md).

### `agent` node

```yaml
- id: security-scan-node
  type: agent
  agent_ref: security-scanner       # references agents[] by id
  prompt_template: |
    Review this TypeScript file for security issues:
    ```typescript
    {{ctx.code_content}}
    ```
  model: claude-sonnet-4-6           # optional per-node override
  temperature: 0.1                   # optional override
  max_tokens: 1024                   # optional override
  tools: [read_file, web_search]     # tool ids available to this node
  timeout_ms: 60000
  retry: { max: 3, backoff: linear } # linear | exponential
```

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
  timeout_action: reject             # reject | approve | escalate
```

`timeout_action: approve` auto-approves on timeout — dangerous; use sparingly. `escalate` notifies fallback assignees and extends the timeout. The gate lifecycle (suspend → notify → resume) is described in [sse-event-schema.md](sse-event-schema.md) and [../../architecture/execution-model.md](../../architecture/execution-model.md).

### `condition` node

```yaml
- id: severity-gate
  type: condition
  condition: 'run.outputs["security-scan-node"].score < 7'
  branches:
    - label: low_score
      condition: 'true'
      target_node: human-approval
    - label: passing
      condition: 'false'
      target_node: synthesize-report
```

A condition node selects a branch by evaluating each branch's `condition` against run state. Branch labels are also referenceable from edges as `nodeId:branchLabel` (see [Edges](#edges)).

A bare `condition:` string is a **sandboxed JavaScript expression** (`expression_type: js`, the default — no I/O, no ambient globals). The other allowed expression languages are `jmespath` and `jsonlogic` (set `expression_type` to opt in). **There is no Python expression evaluator** — the engine is pure TypeScript ([ADR-0003](../../decisions/0003-pure-ts-engine-not-langgraph-python.md)). The full `expression_type` set is owned by [node-types.md](../shared-core/node-types.md#per-type-engine-config).

### `transform` node

```yaml
- id: shape-result
  type: transform
  transform: '{ files: run.outputs["scan"].issues.map(i => i.line) }'
```

A sandboxed JavaScript expression (`expression_type: js`, the default) whose result becomes the node's output. No LLM call. As with `condition`, `jmespath` / `jsonlogic` are the only other allowed `expression_type` values, and there is no Python evaluator — see [node-types.md](../shared-core/node-types.md#per-type-engine-config).

### `parallel` and `merge` nodes

```yaml
- id: fan-out
  type: parallel
  parallel_of: [security-scan-node, style-review-node]  # declares branch membership; see note

- id: merge
  type: merge
  merge_strategy: object_merge       # concat | object_merge | first | custom
  merge_fn: |                        # required only when strategy = custom (a `js` expression)
    { ...a, ...b }
```

`merge_strategy` is the **authoritative** name for the aggregation behavior; the canvas (`AggregatorNode`) and engine (`fan_in_config`) carry the same value — see the [merge-strategy reconciliation table](../shared-core/node-types.md#merge-strategy-reconciliation). `best_of_n` (a secondary-LLM picker) is **reserved, not v1.0**, and is not a valid `merge_strategy` value in `'1.0'`.

> **`parallel_of` is authoritative for branch membership.** On a `parallel` node, `parallel_of: [...]` alone defines which nodes are the concurrent branches; the parser materializes a fan-out edge to each listed node, so explicit `from: fan-out` edges are **not required**. The complete example below writes them out for readability, but they are redundant with `parallel_of` and must not contradict it — if both are present they must agree (the validator rejects an explicit fan-out edge to a node not in `parallel_of`).

## Tool policy (`spec.tools`)

Workflow-wide tool guardrails live under a top-level `tools:` block. This is the **canonical home** for the command allowlist that [built-in-tools.md](../shared-core/built-in-tools.md) references — `run_command` never executes a command that is not on this list.

```yaml
workflow:
  # …
  tools:
    allowedCommands:            # allowlist for the `run_command` built-in tool
      - 'npm test'              # matched against the resolved command string
      - 'npm run lint'
      - 'git diff'
    allowedDomains:             # optional allowlist for the `http_request` built-in tool
      - 'api.github.com'
```

| Field | Required | Notes |
| --- | --- | --- |
| `tools.allowedCommands` | required to use `run_command` | An explicit allowlist of permitted shell commands. **Empty or absent ⇒ `run_command` is disabled** (it never runs an unlisted command). Enforced by the engine, not by convention — see [built-in-tools.md](../shared-core/built-in-tools.md#the-built-in-tools). |
| `tools.allowedDomains` | no | Per-workflow domain allowlist for `http_request`. |

The command allowlist is **independent of the filesystem scope tier** (a workflow can be FS-sandboxed *and* still carry an empty command allowlist). The FS tier itself is set in project config (`fs_scope`), not here — see [config-spec.md](config-spec.md) and [built-in-tools.md](../shared-core/built-in-tools.md#filesystem-permission-tiers).

## Edges

Edges are explicit directed connections. An edge from a `condition`/branching node uses the `nodeId:handleName` form to reference a named output handle/branch.

```yaml
edges:
  - from: input
    to: fan-out
  - from: fan-out
    to: security-scan-node
  - from: severity-gate:low_score   # branch handle on the condition node
    to: human-approval
  - from: severity-gate:passing
    to: synthesize-report
```

| Field | Required | Notes |
| --- | --- | --- |
| `from` | yes | Source node id, optionally `nodeId:handle`. |
| `to` | yes | Target node id. |
| `label` | no | Display label. |
| `condition` | no | JS expression; the edge is followed only when truthy. Omit for unconditional. |

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
      condition: 'run.outputs["security-scan-node"].score < 7'
      branches:
        - label: low_score
          condition: 'true'
          target_node: human-approval
        - label: passing
          condition: 'false'
          target_node: synthesize-report

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
    - { from: 'severity-gate:low_score', to: human-approval }
    - { from: 'severity-gate:passing', to: synthesize-report }
    - { from: human-approval, to: synthesize-report }
    - { from: synthesize-report, to: output }
```

## Validation and versioning rules

- The file is parsed and validated against `WorkflowSchema` (Zod, in `@relavium/shared`) at load time; invalid files throw a `WorkflowValidationError` and never start a run.
- `schema_version` is the migration anchor. The format is a public API: breaking changes require a new `schema_version` and a migration tool. Add new optional fields freely; never repurpose or remove an existing one within `'1.0'`.
- Node `id`s must be unique within a workflow and are referenced by edges, conditions, templates, and `run.outputs`.
- Secrets are never embedded in the file — `secret` inputs and tool credentials are resolved from the secret store at run time (see [../desktop/keychain-and-secrets.md](../desktop/keychain-and-secrets.md)).

For the run-time event stream a workflow produces, see [sse-event-schema.md](sse-event-schema.md). For how a run is scheduled and executed, see [../../architecture/execution-model.md](../../architecture/execution-model.md).
