# `agent run` fixture cassette

> Last updated: 2026-06-26

- **Status**: Reference (the cassette format consumed by `relavium agent run --fixture`, workstream **2.Q**)
- **Surface**: CLI (`relavium agent run`)
- **Scope**: Phase 1 design, local-first. A test/CI artifact only — never part of a live run.
- **Related**: [commands.md](commands.md), [chat-session.md](chat-session.md), [regression-harness.md](regression-harness.md), [../shared-core/llm-provider-seam.md](../shared-core/llm-provider-seam.md), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md), [../../decisions/0011-internal-llm-abstraction.md](../../decisions/0011-internal-llm-abstraction.md), [../../decisions/0049-cli-machine-output-contract.md](../../decisions/0049-cli-machine-output-contract.md)

A **fixture cassette** is a committed JSON file that records an LLM provider's streamed output for a single
`relavium agent run` turn, so that run is **deterministic and fully offline** — no key, no network, no live
provider. It is the on-disk form of the in-memory `scriptedProvider` the `AgentSession` unit tests already
use: `relavium agent run <agent> --fixture <path>` loads the cassette, builds a replay provider
over the `@relavium/llm` seam ([ADR-0011](../../decisions/0011-internal-llm-abstraction.md)), and answers
each `provider.stream()` call from the recorded chunk lists in order.

This is the canonical home for the cassette **format**; it is the CLI's small, dependency-free analogue of
the `@relavium/llm` conformance replay — there is **no new runtime dependency** and no vendor type in the
file (every recorded chunk is a Relavium-owned `StreamChunk`, never a provider SDK shape).

## When to use

- A **regression fixture**: an `agent run` cassette committed under a test/harness directory, replayed on
  every PR so an agent path is exercised end-to-end without a live provider (the agent-fixture half the
  [regression harness](regression-harness.md) deferred until a replay-provider seam existed).
- A **reproducible demo / bug report**: capture a turn's model output once, then re-run it anywhere.

It is **not** a session-persistence format (that is `history.db`, [ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md))
and **not** a workflow (that is `.relavium.yaml`). A cassette is throwaway test input.

## File format

A cassette is a single JSON object:

```json
{
  "schema_version": "1.0",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "calls": [
    [
      { "type": "tool_call_start", "id": "call-1", "name": "read_file" },
      { "type": "tool_call_end", "id": "call-1" },
      { "type": "stop", "stopReason": "tool_use", "usage": { "inputTokens": 12, "outputTokens": 4 } }
    ],
    [
      { "type": "text_delta", "text": "The file exports a single function." },
      { "type": "stop", "stopReason": "stop", "usage": { "inputTokens": 30, "outputTokens": 8 } }
    ]
  ]
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `schema_version` | `"1.0"` | The cassette format version. An unknown version is a load fault (exit `2`). |
| `provider` | `ProviderId` | The id the replay provider answers as (`anthropic` / `openai` / `gemini` / `deepseek`). The agent's resolved provider must match, or the run fails fast. |
| `model` | `string` (optional) | Informational only — the recorded model id, for provenance. Not used to route. |
| `calls` | `StreamChunk[][]` | One entry per `provider.stream()` invocation during the turn, in order. |

- **Each `calls[i]` is the ordered `StreamChunk[]` replayed on the i-th `stream()` call.** A one-shot
  `agent run` is a single user turn, but that turn may make **several** `stream()` calls when the agent uses
  a tool: `calls[0]` is the initial turn (typically ending in a `stop` with `stopReason: "tool_use"`),
  `calls[1]` is the continuation after the tool result, and so on — exactly the `scripts: StreamChunk[][]`
  shape of the in-memory `scriptedProvider`. A plain (no-tool) turn is a single entry ending in
  `stopReason: "stop"`.
- **Every chunk is a `StreamChunk`** ([llm-provider-seam.md](../shared-core/llm-provider-seam.md), the
  `StreamChunkSchema` discriminated union): `text_delta`, `tool_call_start` / `tool_call_delta` /
  `tool_call_end`, the `reasoning_*` and `media_*` triads, a provider-executed `tool_result`, and the
  terminal `stop` (carrying `stopReason` + `usage`) or `error`. A well-formed turn ends in exactly one
  `stop` (or `error`).
- **`usage`** on the `stop` chunk carries `inputTokens` / `outputTokens` (and optional `reasoningTokens` ≤
  `outputTokens`); these drive the recorded turn's token/cost accounting deterministically.

## Validation and loading

- The cassette is parsed as JSON, then **every chunk is validated against `StreamChunkSchema`** at the load
  boundary (the same Zod schema the live adapters produce against). A malformed cassette — bad JSON, an
  unknown `schema_version`, a chunk that fails the schema, or a non-array `calls` — is an **invalid
  invocation (exit `2`)**, surfaced as a file-attributed error on stderr, never a stack trace as primary
  output (consistent with every other CLI load fault).
- The replay provider answers **only** for the cassette's `provider` id and returns a fixed, non-secret
  dummy key from `keyFor` — it never reads the OS keychain or an env var, so a fixture run needs no key
  configured. **A cassette is NOT inherently secret-free**: its `text_delta` and `tool_result` chunks
  capture real model output and tool results, which **may contain sensitive content** — scrub/redact a
  cassette before committing it, exactly as any other recorded fixture (the same no-secret rules as every
  other surface apply, [keychain-and-secrets.md](../desktop/keychain-and-secrets.md)).
- An **unscripted** `stream()` call (the agent makes more provider calls than the cassette recorded) fails
  **loudly** — an extra LLM invocation is a fixture/agent mismatch bug, never a silent empty turn (mirroring
  `scriptedProvider`). The run exits non-zero rather than fabricating output.

## Usage

The one-shot **prompt is read from stdin** (the `echo … | relavium agent run` idiom); `--fixture` makes the
run deterministic and offline. _(`--input k=v` is **reserved** — currently rejected (exit `2`): a session
does not yet interpolate `{{ctx.*}}` into the agent prompt, a tracked engine follow-up,
[deferred-tasks.md](../../roadmap/deferred-tasks.md).)_

```bash
# deterministic, offline single-turn agent run (prompt on stdin)
echo "review this file" | relavium agent run code-reviewer --fixture ./fixtures/review.cassette.json

# machine-readable: the session:* + agent:* NDJSON stream (ADR-0049), one event per line on stdout
echo "review this file" | relavium agent run code-reviewer --fixture ./fixtures/review.cassette.json --json
```

Under `--json` the run emits the same [`SessionEvent`](../contracts/sse-event-schema.md#session-event-namespace)
+ per-turn `agent:*` / `cost:updated` NDJSON stream a live `agent run --json` produces — the cassette
changes only *where the model bytes come from*, never the event contract. `agent run` is a **non-interactive
one-shot** (a single turn, then exit — not persisted), so its exit code is the **turn's outcome**: `0` on
success, `1` on a turn error; an invocation fault (no stdin prompt / unknown agent / bad `--input` / a
malformed cassette) is `2` ([commands.md](commands.md#exit-codes)). This is distinct from the interactive
`relavium chat` REPL, which a user *ends* (exit `4`).

## Out of scope (v1.0)

- **Multi-turn cassettes.** A cassette records one `agent run` turn (its one-or-more `stream()` calls). A
  multi-user-turn chat replay is a possible later extension (a `turns: Cassette[]` wrapper) and is not in
  v1.0 — `relavium chat --json` reads real stdin and uses the live provider.
- **Auto-recording.** v1.0 cassettes are authored/committed by hand or captured by a test helper; a
  `--record` capture mode is a future affordance, tracked in [deferred-tasks.md](../../roadmap/deferred-tasks.md).
