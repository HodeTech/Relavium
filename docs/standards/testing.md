# Testing

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [architectural-principles.md](architectural-principles.md), [tech-stack.md](../tech-stack.md), [code-style-typescript.md](code-style-typescript.md), [error-handling.md](error-handling.md)

This is the binding test discipline for Relavium. It follows from
[engine-first](architectural-principles.md#1-engine-first) and from the
[build-in-house](architectural-principles.md#9-build-in-house-minimize-third-party-dependencies)
principle: because we own the core layers (`@relavium/llm`, `packages/core`), we own the
tests that keep them honest. The tools are pinned in [tech-stack.md](../tech-stack.md)
(Vitest for unit, Playwright for e2e) and are not restated here.

## Engine-first test discipline

The engine is the critical path, so it carries the test burden. `packages/shared`,
`packages/llm`, and `packages/core` are tested to a high bar **before** any surface
consumes them — the same order as the build order in
[architectural-principles.md](architectural-principles.md#1-engine-first). A surface bug
is a surface bug; an engine bug is every surface's bug, so the engine is where we spend
test effort first.

The CLI (`apps/cli`) doubles as an integration harness: it exercises the engine under
real conditions with no UI, so a regression in `WorkflowEngine` / `AgentRunner` surfaces
in CLI tests before it ever reaches the desktop.

## Unit tests — Vitest

- **`packages/core`** — the workflow engine is unit-tested exhaustively: YAML parsing and
  validation, node execution, the run-event sequence, fallback-chain policy,
  checkpoint/resume, and cost accumulation. Run events are asserted against the
  [canonical run-event schema](../reference/contracts/sse-event-schema.md) by their
  colon-namespaced names (the `RunEvent` union — that schema is the one home for the
  names, not restated here) and by their `sequenceNumber` ordering — never the legacy
  dotted names.
- **`packages/llm`** — the seam types, the `ToolNormalizer`, the `CostTracker` pricing
  table, the `FallbackChain` runner, and each adapter's normalization logic (system-prompt
  placement, tool-schema reshaping, stop-reason mapping, usage extraction, streaming-chunk
  folding) are unit-tested with **no live network**. Adapter unit tests run against
  recorded fixtures (see below).
- **`packages/shared`** — Zod schemas are tested for both accept and reject cases; a schema
  that never rejects a bad input is untested.

Tests live beside the code (`*.test.ts`) and never reach across the LLM seam: a core test
asserts on Relavium types only, never on a vendor SDK shape (see
[code-style-typescript.md](code-style-typescript.md)).

## Per-provider conformance tests

Each `@relavium/llm` adapter must pass one shared **conformance suite** — a single spec run
against every provider — proving the adapter honors the seam contract: streams text, calls
a tool and returns a normalized `tool_call`, returns usage, maps stop reasons to the
canonical enum, and surfaces errors as a classified `LlmError` (see
[error-handling.md](error-handling.md)). This suite is the single biggest leverage point
for the in-house abstraction: it converts provider drift from a production incident into a
red CI run.

It runs in two modes:

- **On every PR — recorded fixtures.** The suite replays committed request/response
  fixtures (including streamed SSE transcripts) so PR CI is fast, deterministic, offline,
  and uses no API keys or quota. Fixtures are checked in and reviewed like code; a
  fixture must be regenerated, not hand-edited, when a provider's wire format changes.
- **Nightly — live APIs.** The same suite runs against the real Anthropic, OpenAI, Google,
  and DeepSeek endpoints on a schedule, using keys from CI secrets (never committed, never
  logged). A nightly failure is the early-warning signal that a provider changed its
  contract under us. New model ids and pricing-table entries are validated here.

## End-to-end tests — Playwright

The desktop app (`apps/desktop`, Tauri v2) has Playwright e2e coverage for the critical
user journeys: create/import a workflow, configure an agent and provider key, run a
workflow and watch the live run-event stream render, hit and resolve a human gate, and
read run history and cost. E2e tests drive the real app, not mocked stores. They cover
journeys, not exhaustive logic — exhaustive logic belongs in engine unit tests.

## Coverage expectations

- `packages/core` and `packages/llm`: high line **and branch** coverage (target ≥ 90%),
  because branch coverage is what catches the error/fallback/edge paths that matter here.
  Coverage is a floor and a signal, not the goal — an uncovered branch is a question to
  answer, not a number to game.
- Every bug fix lands with a regression test that fails before the fix.
- Surfaces (`apps/*`, `packages/ui`): smoke + critical-journey coverage; deep logic is
  pushed down into the engine and tested there.

## CI gate

PRs must pass: typecheck, lint ([code-style-typescript.md](code-style-typescript.md)), all
unit tests, and the fixture-mode conformance suite. The live conformance suite and the
desktop e2e suite run nightly and on release branches. A red required check blocks merge.
