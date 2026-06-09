# Logging and Observability

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [error-handling.md](error-handling.md), [security-review.md](security-review.md), [architectural-principles.md](architectural-principles.md), [product-constraints.md](../product-constraints.md)

How Relavium logs and stays observable without compromising the
[local-first](architectural-principles.md#3-local-first-by-default) and
[secrets-never-leak](architectural-principles.md#6-secrets-never-touch-disk-or-the-frontend)
principles. The run-event stream — not a logging vendor — is the observability backbone.

## Structured logging

- Logs are **structured** (one JSON object per line: `level`, `timestamp` (ISO 8601),
  `message`, plus context fields), not free-text string interpolation. Context — `runId`,
  `nodeId`, `provider`, `attempt`, `sequenceNumber` — goes in fields so logs are
  queryable, and these fields come straight off the typed errors in
  [error-handling.md](error-handling.md).
- Levels are used with intent: `error` (a failure needing attention), `warn` (a recovered
  or degraded condition, e.g. a retryable provider failure that triggered failover),
  `info` (lifecycle: run started/completed), `debug` (developer detail, off by default).
- The engine logs through an injected logger interface, not a global `console`, so a
  surface (CLI, desktop, Phase-2 worker) supplies its own sink. `packages/core` keeps its
  [zero platform-specific imports](../project-structure.md).

## No secrets in logs

This is a hard rule, enforced in [security-review.md](security-review.md):

- **Never** log API keys, the keychain handle, or any credential — at any level,
  including `debug`.
- **Never** log full prompts or full model responses by default; they may contain user
  data and pasted secrets. Log token counts, model id, stop reason, and cost — the
  metadata — not the content. Full request/response capture is a deliberate, opt-in
  debug-only path that redacts known secret patterns.
- Custom base URLs and request targets are logged host-only where they could carry a
  token; never log a URL with embedded credentials.
- A secret that was *sent* (a key in a header, a token in a query string or URL) and is then
  **echoed back** in a provider response or error body is redacted **before that body is logged** —
  the response/error path is a leak surface too, not just the request (also asserted by the
  `@relavium/llm` conformance suite for the normalized `LlmError`; see [security-review.md](security-review.md)).
- A user-facing error shown in the UI is already redacted (see
  [error-handling.md](error-handling.md)); logs hold the internal detail, never the other
  way around.

## The run-event stream is the observability backbone

Relavium's primary observability surface is the canonical **run-event stream**, not an
external APM. The canonical `RunEvent` union — the colon-namespaced event names and their
payloads — has one home: the [run-event schema](../reference/contracts/sse-event-schema.md).
It is cited, not restated, here, so the names never drift between docs. Every run emits
those events in order by `sequenceNumber`.

- `cost:updated` carries `{nodeId, model, inputTokens, outputTokens, costMicrocents,
  cumulativeCostMicrocents}` and is the live cost-accounting signal that the desktop cost view and
  the CLI both render — cost observability is a product feature, not an add-on.
- The legacy dotted names (`node.token`, `run.complete`, `cost.update`) and `seqNo` are
  wrong; use the canonical names and `sequenceNumber` everywhere, including logs.
- Run events and run history persisted to the local DB are the durable audit trail; logs
  are for diagnosis, the event stream is for understanding what a run did.

## Local-first: no telemetry without consent

- Phase 1 is local-first with **zero cloud dependency**; Relavium does **not** phone home.
  There is **no analytics, crash reporting, or usage telemetry without explicit, informed,
  opt-in consent**, and consent is revocable. Privacy is a feature, not a setting (see
  [product-constraints.md](../product-constraints.md)).
- If telemetry is ever added, it is opt-in, documents exactly what it sends, sends no
  prompt/response content or secrets, and is off until the user turns it on.
- Logs stay on the user's machine by default. Shipping logs anywhere off-device is an
  explicit user action, not a default.

> **Phase 2 (cloud).** Cloud workers will emit the same run-event stream over
> Redis-backed SSE and may add server-side structured logging; the no-secrets and
> consent rules above still hold. This is not part of the local-first Phase 1 build.
