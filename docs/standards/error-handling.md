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
  failures (401/403, a bad or missing key), malformed requests (400, an unsupported model
  id, a tool schema a provider rejected), content-policy refusals, and request
  cancellation (`AbortSignal`). A fatal error does **not** silently fall through the chain
  to mask a real bug.

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
- **Resource/limit codes are fatal-without-user-action, never silent.** `budget_exceeded`,
  `run_timeout`, and `turn_limit` (an agent/session round cap, e.g. the `[chat]`
  `max_messages` ceiling) end the work with a typed event carrying that code — the engine
  never trims, loops, or quietly stops to fit under a cap. They are not retryable by
  policy: continuing past a limit is an explicit user decision (raise the cap, resume the
  session), not something a runner retries into.

## Validation at boundaries

Untrusted input (parsed YAML, IPC payloads, provider responses, env/config) is validated
with a Zod schema at the boundary and fails with a typed, user-facing validation error
that names the offending field. We validate once, at the edge, then trust the typed value
inside the core.
