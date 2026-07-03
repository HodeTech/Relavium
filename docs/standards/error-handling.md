# Error Handling

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [code-style-typescript.md](code-style-typescript.md), [architectural-principles.md](architectural-principles.md), [logging-and-observability.md](logging-and-observability.md), [security-review.md](security-review.md)

How Relavium represents, classifies, and surfaces failures. The rules apply to every
package; the LLM layer (`@relavium/llm`) and the engine (`packages/core`) are the
highest-stakes consumers because a misclassified error there breaks the fallback chains
and cost accounting that are product features.

## Typed errors, never strings

- Errors are **typed and discriminated**, never bare `Error` and never thrown strings
  (see [code-style-typescript.md](code-style-typescript.md)). Each error type carries a
  stable discriminant (a `kind` / `code`) callers narrow on — not `error.message`, which
  is for humans and may change.
- Errors carry **structured context** (the node id, run id, provider id, attempt number)
  as fields, not interpolated into the message string, so [logging](logging-and-observability.md)
  can emit them as fields and tests can assert on them.
- Wrap-and-rethrow preserves the cause (`{ cause }`); we never swallow a root cause to
  re-throw a vaguer one.
- The engine surfaces this with typed, `code`-discriminated classes — `EngineStateError` (the
  `WorkflowEngine` API-boundary faults) and `RunLoopInvariantError` (the run-loop substrate's
  internal-invariant breaches: a draft with both/neither correlation key, a concurrent stream consumer)
  — each defined and documented at its source under `packages/core/src/engine/` and exported from
  `@relavium/core` so callers and tests narrow on `.code`, never the message. (The cross-cutting
  `LlmError` seam contract is the one error type detailed in full below, because the fallback chains
  depend on its classification.)

## `LlmError` classification — the contract the fallback chains depend on

Every failure inside an `@relavium/llm` adapter is normalized to a single `LlmError` type
before it crosses the seam — no vendor SDK error shape ever escapes the adapter (see the
[seam boundary rule](code-style-typescript.md#module-boundaries--no-vendor-type-across-the-llm-seam)).
`LlmError` is classified so the `FallbackChain` runner can make a policy decision without
knowing which provider produced it:

- **Retryable** — transient, worth moving to the next provider in the chain (or retrying
  with backoff): rate limits (HTTP 429), server/overloaded errors (5xx), timeouts, and
  transport/connection resets. The fallback runner advances to the next provider on a
  retryable `LlmError` and records the failed attempt's usage so cost stays accurate
  across failover.
- **Fatal** — not worth retrying anywhere; surface it and stop: authentication/permission
  failures (401/403, a bad or missing key; **402** an account billing / insufficient-balance
  problem — classified `auth` so it surfaces as `provider_auth`, never `internal`), malformed
  requests (400, an unsupported model id, a tool schema a provider rejected), content-policy
  refusals, and request cancellation (`AbortSignal`). A fatal error does **not** silently fall
  through the chain to mask a real bug.

The runner — not the adapter — owns the retry/fallback policy
([ADR-0011](../decisions/0011-internal-llm-abstraction.md)); adapters stay dumb and only
classify. The classification mapping (per-provider status/code → retryable vs fatal) is
covered by the [per-provider conformance suite](testing.md#per-provider-conformance-tests).

## No silent catches

- A `catch` block must do one of: handle the error meaningfully, enrich and rethrow it, or
  classify it. An empty catch, or `catch { /* ignore */ }`, is forbidden — it is how
  failures become invisible.
- Never catch broadly and continue as if nothing happened. If a failure is genuinely
  ignorable, that is a deliberate decision recorded in a comment and, where it matters,
  logged at `warn`.
- No floating promises — an unhandled rejection is a silent catch with extra steps
  (lint-enforced, see [code-style-typescript.md](code-style-typescript.md)).

## User-facing vs internal errors

We distinguish the two and never leak one as the other:

- **User-facing** errors are actionable and safe: "No API key found for provider
  `anthropic` — add one in Settings", "Workflow `x.relavium.yaml` failed validation at
  node `summarize`: missing `model`". They are phrased for the person, name the next step,
  and **never** contain secrets, raw provider payloads, stack traces, or internal file
  paths (see [security-review.md](security-review.md)).
- **Internal** errors carry the full detail (stack, cause chain, provider `raw`) for
  diagnosis and go to [structured logs](logging-and-observability.md), never to the
  frontend verbatim. The mapping from internal → user-facing happens at the surface
  boundary, once.
- Errors surfaced through the run-event stream use the canonical `node:failed` and
  `run:failed` events (see the [SSE event schema](../reference/contracts/sse-event-schema.md));
  they carry a user-safe message plus an internal correlation id, not a raw exception.
- **Content-policy rejections are fatal, with their own cause.** A provider content-filter block (a
  text turn or a media generation) carries `content_filter` (1.AG,
  [ADR-0045](../decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md)) — **fatal**,
  distinct from `validation` (an authoring/shape error) so a surface shows the right cause/remediation;
  re-issuing the same blocked content just re-blocks, so it is never retried.
- **Resource/limit codes are fatal-without-user-action, never silent.** `budget_exceeded`,
  `run_timeout`, and `turn_limit` (a **hard** agent/session turn/round cap — distinct from
  the `[chat].max_messages` history-**trim** threshold of
  [config-spec.md](../reference/contracts/config-spec.md), which continues the session and
  emits no error) end the work with a typed event carrying that code — the engine never
  loops past a cap or quietly stops under one. They are not retryable by policy:
  continuing past a limit is an explicit user decision (raise the cap, resume the
  session), not something a runner retries into. Note `budget_exceeded` is the
  **fail-path** code only: ADR-0028's `on_exceed: warn` / `pause_for_approval` branches
  emit `budget:warning` / `budget:paused` events and do not use this code.
- **Tool-dispatch codes split on policy vs execution.** A tool **policy / grant denial**
  ([tool-registry.md](../reference/shared-core/tool-registry.md),
  [ADR-0029](../decisions/0029-tool-policy-hardening.md)) carries `tool_denied` and is **fatal** — a
  denied call is deterministic, never retried (re-issuing it just re-denies). A tool **execution
  failure** (the host capability threw a transient/runtime error) carries `tool_failed` and is
  **retryable** within the node retry budget. An absent host capability arm (`fs`/`process`/`egress`/…) is
  `tool_unavailable` — **fatal**, naming the missing capability + the tool actionably (a host/config gap,
  not the model's fault), never a bare `internal` (EA1, [ADR-0055](../decisions/0055-cli-host-capability-seam-tool-environment-factory.md)).
  A tool aborted by the run's `AbortSignal` surfaces on the
  **cancellation** path (`cancelled`), never `tool_failed`, so it composes with the
  [ADR-0036](../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md) cancel-precedence
  rule. Messages stay scrubbed to the code + a user-safe string (the tool id / field, never an
  argument value or a host stack).
- **`sandbox_error` splits on determinism.** An expression-sandbox failure
  ([ADR-0027](../decisions/0027-expression-sandbox.md),
  [expression-sandbox-spec.md](../reference/shared-core/expression-sandbox-spec.md)) carries the closed
  `sandbox_error` code. The **deterministic** causes — a syntax error, a runtime `Reference`/`TypeError`,
  a memory/stack overflow, or a non-conforming result — are **fatal** (a retry repeats them); only a
  **wall-clock-timeout** trip is **retryable** (a non-idempotent safety net that may pass on
  re-execution, bounded by the node retry budget). The message is scrubbed to the code + a generic
  string — never the expression source, a variable name, or a scope value.
- **The catch-all is `internal`, never a silent stop.** An uncaught throw from a node handler with no
  more specific classification maps to `internal` with `retryable: false` (a tool throw is
  `tool_failed`, a sandbox throw is `sandbox_error` per its determinism split, above). The run loop
  ([ADR-0036](../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)) catches it, emits a
  single `run:failed{internal}` rather than hanging, and stamps a secret-free `correlationId` joining
  the user-safe message to the internal log — so an unexpected engine fault is always loud and
  attributable, never a zombie run.

## Validation at boundaries

Untrusted input (parsed YAML, IPC payloads, provider responses, env/config) is validated
with a Zod schema at the boundary and fails with a typed, user-facing validation error
that names the offending field. We validate once, at the edge, then trust the typed value
inside the core.

**A node's `output_schema` is enforced NODE-SIDE.** The seam's `LlmRequest.responseFormat`
([ADR-0030](../decisions/0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md))
is a **request-side hint only** — no adapter validates the response against it, and DeepSeek degrades
to bare `json_object` with no schema. So the `AgentRunner` (1.O) lowers `output_schema` to
`responseFormat` **and** validates the returned content node-side. **Phase-1 scope is parse-as-JSON
only**: an output that does **not parse as valid JSON** maps to `code: 'validation'` (`retryable:
false` — a re-ask is a node-retry/authoring concern, not a node-level loop); a schema-violating but
valid-JSON output is **not** yet rejected. **Deep JSON-Schema conformance is a deferred follow-up** (it
needs a JSON-Schema validator dependency behind an ADR — Zod cannot consume an arbitrary JSON-Schema).
See [agent-runner.md](../reference/shared-core/agent-runner.md).
