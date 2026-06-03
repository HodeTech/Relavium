# Agent YAML Specification

- **Status**: Stable
- **File extension**: `.agent.yaml` (stored under a project's `.relavium/` directory, or inline in a workflow's `agents:` list)
- **Validated by**: the `AgentSchema` Zod definition in `@relavium/shared`
- **Related**: [workflow-yaml-spec.md](workflow-yaml-spec.md), [config-spec.md](config-spec.md), [../shared-core/built-in-tools.md](../shared-core/built-in-tools.md), [../shared-core/mcp-integration.md](../shared-core/mcp-integration.md), [../shared-core/llm-provider-seam.md](../shared-core/llm-provider-seam.md) (the `model`/`provider`/`fallback_chain` runtime contract), [../../architecture/multi-llm-providers.md](../../architecture/multi-llm-providers.md)

An **agent** is a named, reusable LLM configuration: which model, which provider, the system prompt, generation parameters, the tools it may call, and its resilience behavior (retry + multi-provider fallback). Agents are referenced from workflow `agent` nodes by `agent_ref` (see [workflow-yaml-spec.md](workflow-yaml-spec.md)).

Agents are **git-committable** and shareable. An agent may live as its own `.agent.yaml` file (so it can be reused across workflows) or be declared inline inside a workflow's `agents:` array. Both forms validate against the same schema.

## Schema

```yaml
id: string                  # required, unique, kebab-case — referenced by agent_ref
name: string                # human-readable display name
description: string         # what this agent does (used in UI and tool descriptions)

model: string               # required, e.g. 'claude-sonnet-4-6', 'gpt-4o', 'gemini-2.5-pro'
provider: string            # required, e.g. 'anthropic' | 'openai' | 'google' | 'deepseek'

system_prompt: string       # required; supports {{variable}} interpolation
temperature: number         # optional, default per-provider
max_tokens: number          # optional output cap

tools: string[]             # tool ids this agent may call (built-in, mcp, plugin)
mcp_servers: McpServerRef[] # optional MCP servers this agent consumes
memory:                     # optional conversational memory policy
  type: none | window | summary
  window_size: number       # when type = window

retry:                      # transient-error retry on the primary model
  max: number
  backoff: linear | exponential

fallback_chain:             # ordered alternates tried after the primary is exhausted
  - model: string
    provider: string
    max_attempts: number
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Unique, kebab-case. Target of `agent_ref`. |
| `name` | recommended | Display name. |
| `description` | recommended | Surfaced in pickers and, when the agent is exposed via MCP, in the tool description. |
| `model` | yes | Provider model id. For the supported model matrix see [../../architecture/multi-llm-providers.md](../../architecture/multi-llm-providers.md). |
| `provider` | yes | `anthropic`, `openai`, `google`, `deepseek`. |
| `system_prompt` | yes | Multiline YAML scalar; `{{ctx.*}}` / `{{inputs.*}}` interpolation supported. |
| `temperature` | no | Sampling temperature. |
| `max_tokens` | no | Output token cap. |
| `tools` | no | Tool ids — see [../shared-core/built-in-tools.md](../shared-core/built-in-tools.md). |
| `mcp_servers` | no | See [../shared-core/mcp-integration.md](../shared-core/mcp-integration.md). |
| `memory` | no | `none` (default), `window` (last N turns), or `summary` (rolling summary). |
| `retry` | no | Retry on the *same* model for retryable errors. |
| `fallback_chain` | no | Switch to a *different* model/provider after retries are exhausted. |

## Retry vs. fallback

These are two distinct resilience layers:

- **`retry`** handles transient failures (timeouts, rate limits) by re-attempting the **same** model with the configured `backoff`.
- **`fallback_chain`** handles a model being unavailable or repeatedly failing by moving to the **next** provider/model in the list. Each entry has its own `max_attempts`. The chain is tried in order; the first entry that succeeds produces the node output. This is the mechanism behind the multi-model fallback killer feature.

```yaml
retry:
  max: 3
  backoff: exponential
fallback_chain:
  - model: gpt-4o
    provider: openai
    max_attempts: 2
  - model: gemini-2.5-pro
    provider: google
    max_attempts: 1
```

The resolution order at run time is: primary `model` (with `retry`) → first `fallback_chain` entry (with its `max_attempts`) → next entry → … . The `model`/`provider` pair and the `fallback_chain` are resolved against Relavium's provider-agnostic `LLMProvider` seam: each entry selects a provider adapter and a canonical model id, and the fallback is executed by the `withFallback` runner that sits *outside* the adapters (the adapters stay dumb). Provider-key resolution and cross-provider tool-schema normalization are likewise handled by `@relavium/llm`. The immovable contract for all of this — the request/result/stream types, the normalization rules, and where `fallback_chain` `max_attempts` is enforced — is [../shared-core/llm-provider-seam.md](../shared-core/llm-provider-seam.md); the rationale and supported-model matrix are in [../../architecture/multi-llm-providers.md](../../architecture/multi-llm-providers.md).

## Example

```yaml
# .relavium/agents/summarizer.agent.yaml
id: summarizer
name: Summarizer Agent
description: Produces a concise 3-bullet summary focused on a context-supplied area.
model: claude-sonnet-4-6
provider: anthropic
system_prompt: |
  You are a concise summarizer. Summarize the input in 3 bullet points.
  Focus on: {{ctx.focus_area}}
temperature: 0.3
max_tokens: 512
tools: []
retry:
  max: 3
  backoff: exponential
fallback_chain:
  - model: gpt-4o
    provider: openai
    max_attempts: 2
  - model: gemini-2.5-pro
    provider: google
    max_attempts: 1
```

## Referencing an agent from a workflow

```yaml
nodes:
  - id: summarize
    type: agent
    agent_ref: summarizer          # resolves to the agent above
    prompt_template: '{{inputs.text}}'
```

A node may override the agent's `model`, `temperature`, and `max_tokens` for that node only (see [workflow-yaml-spec.md](workflow-yaml-spec.md#agent-node)). The agent definition supplies the defaults.

## Validation and secrets

- Validated against `AgentSchema` (Zod) at load; invalid agents fail fast.
- Agents **never** contain API keys. Provider credentials are resolved from the secret store at call time and are never written to the agent file, logs, or event payloads. See [../desktop/keychain-and-secrets.md](../desktop/keychain-and-secrets.md).
