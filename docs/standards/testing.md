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
in CLI tests before it ever reaches the desktop. The **engine regression harness** (2.K) is
the workflow-level extension of the per-provider conformance discipline below: it runs committed
example workflows through `relavium run … --json` and asserts on the NDJSON event stream + exit
code, offline and deterministic on every PR. Its fixture + scenario format is the one canonical
home — [reference/cli/regression-harness.md](../reference/cli/regression-harness.md) — and the
recorded-LLM agent fixtures it grows into follow the same regenerate-not-hand-edit rule as the
conformance fixtures.

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
[code-style-typescript.md](code-style-typescript.md)). One sanctioned extension: **`*.test.tsx`** is the
convention for ink-mounted component tests under `apps/cli`'s renderer layer — a JSX file is required to render
an ink component through `ink-testing-library` and assert on captured frames / driven stdin
([ADR-0068](../decisions/0068-full-screen-tui-renderer-ink7-harness.md)). It is the same `.test.` prefix (not
the rejected `.spec.` suffix), collected by the root Vitest config alongside `*.test.ts`.

## Security-critical primitive tests (direct, negative-case)

Security primitives are tested **directly and adversarially**, never only transitively through a happy-path
caller — the dangerous input is exactly the one the happy path never exercises, so coverage-% is not a
substitute. Each carries its own unit suite with the malicious/edge inputs spelled out:

- **The shared SSRF range-primitive** (the one parser behind provider `baseURL`, the `http_request` tool,
  MCP server URLs, and the multimodal media `url` carrier): asserts it **blocks** the cloud metadata IP
  `169.254.169.254`, link-local (`169.254/16`), loopback (`127/8`, `::1`), private ranges (`10/8`,
  `172.16/12`, `192.168/16`), CGNAT (`100.64/10`), an **IPv4-mapped IPv6** form of any of the above, a
  credentials-in-URL, and a non-HTTPS scheme — and re-checks the **post-DNS-resolution IP** and **per-hop
  redirect** targets, not just the literal hostname. A runtime-*derived* base URL is re-checked the same way.
- **The path-resolve guard** (the Rust CAS / file layer): `realpath` + `commonpath` **fail-closed** rejects
  a `..` traversal, an absolute path outside the run/session dir, and a **symlink** that escapes it.
- **The keychain bridge**: the raw key is never returned from an IPC command and never appears in a command
  result; only a key *reference* crosses to the WebView.
- **`read_media` / byte delivery**: a negative, reversed (`end < start`), or out-of-bounds `Range` is
  rejected; an oversize upload is rejected; a cross-session handle read is denied (scope-set authz).
- **`INLINE_MEDIA_CEILING` + per-message caps**: an over-ceiling base64 part, an over-count message, and an
  over-aggregate-bytes message are each rejected (the inputs the happy path never sends).

These are **acceptance criteria** for the workstreams that build them (the shared SSRF primitive at 1.AE; the
`MediaStore` / `read_media` / Rust CAS at 1.AF/1.AH) — green direct tests, not coverage-only. A normalized
`LlmError.message`/`code` being **secret-free** is likewise asserted by **each adapter's secret-safety unit
test** (a planted secret → a secret-free surfaced `LlmError`) and by `llm-error.test.ts` (the
`makeLlmError`→`scrubSecrets` choke-point backstop), not assumed (see [security-review.md](security-review.md)).

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

- `packages/core`, `packages/llm`, and `packages/mcp`: high line **and branch** coverage
  (enforced floor ≥ 90%), because branch coverage is what catches the error/fallback/edge
  paths that matter here — and `packages/mcp` fences a security-critical seam (the SDK +
  `node:child_process`) plus the dependency-free JSON-Schema→Zod compiler. Coverage is a
  floor and a signal, not the goal — an uncovered branch is a question to answer, not a
  number to game.
- Every bug fix lands with a regression test that fails before the fix.
- Surfaces (`apps/*`, `packages/ui`): smoke + critical-journey coverage; deep logic is
  pushed down into the engine and tested there.

## CI gate

PRs must pass: typecheck, lint ([code-style-typescript.md](code-style-typescript.md)), all
unit tests, and the fixture-mode conformance suite. The live conformance suite and the
desktop e2e suite run nightly and on release branches. A red required check blocks merge.
