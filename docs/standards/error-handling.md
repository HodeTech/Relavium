# Error Handling

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [code-style-typescript.md](code-style-typescript.md), [architectural-principles.md](architectural-principles.md), [logging-and-observability.md](logging-and-observability.md), [security-review.md](security-review.md)

How Relavium represents, classifies, and surfaces failures. The rules apply to every
package; the LLM layer (`@relavium/llm`) and the engine (`packages/core`) are the
highest-stakes consumers because a misclassified error there breaks the fallback chains
and cost accounting that are product features.

## Typed errors, never strings

Owned production error families inherit the minimal `RelaviumError` exported by
`@relavium/shared`. It forwards the native `Error` constructor without imposing a
name, discriminant, context or cause policy; each existing family owns those
contracts. Plain seam values such as `LlmError`, foreign SDK exceptions and private
control-flow sentinels retain their separate representations. Shared ancestry is
neither proof of a safe diagnostic nor a substitute for an existing structural
boundary guard: independently bundled class identities can differ. Existing local
identity and private-authority guards also retain their own contracts.

The supported `@relavium/shared/relavium-error` leaf exports that same constructor
without evaluating the schema barrel. Early process contracts use this leaf;
runtime classifiers that recognize engine/DB families stay behind runtime loading.
The supported `@relavium/core/tool-dispatch-error` leaf likewise exports the
existing `ToolDispatchError` base without loading the engine/provider barrel.
Concrete tool errors and the root export extend/re-export that exact constructor;
filesystem grant admission can classify its own denial before service evaluation.
CLI diagnostic rendering accepts an already-classified projection independently
of the heavy runtime-family classifier.

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

`@relavium/core` also exports the frozen canonical
`TRANSIENT_ENGINE_STATE_CODES` array used by `isTransientEngineStateError`.
Boundary projections that must avoid reading caller-controlled accessors may
compare a captured own-data code against that same authority. Do not create a
second transient-code list. This export adds no engine code or retry behavior.
Database storage origin has a separate
[read-only identity fact](../reference/shared-core/database-schema.md#node-client-failure-provenance);
error ancestry and public construction do not grant it.

## `LlmError` classification — the contract the fallback chains depend on

Every failure inside an `@relavium/llm` adapter is normalized to a single `LlmError` type
before it crosses the seam — no vendor SDK error shape ever escapes the adapter (see the
[seam boundary rule](code-style-typescript.md#module-boundaries--no-vendor-type-across-the-llm-seam)).
`LlmError` is classified so the `FallbackChain` runner can make a policy decision without
knowing which provider produced it:

- **Retryable** — transient, worth moving to the next provider in the chain (or retrying
  with backoff): rate limits (HTTP 429), server/overloaded errors (5xx), timeouts, and
  transport/connection resets. The fallback runner advances to the next provider on a
  retryable `LlmError` when the attempt's commitment state permits it. Every attempt
  is reported; actual usage is recorded only when the provider supplies it. An engaged
  attempt that holds a bounded reservation retains it as an estimate when trustworthy
  usage is missing, unless a proven pre-content refusal permits release
  ([ADR-0074](../decisions/0074-durable-conservative-budget-commitments.md),
  [ADR-0076](../decisions/0076-durable-per-attempt-realized-cost-ledger.md)).
  An estimate is never reported as actual usage or realized spend.
- **Fatal** — not worth retrying anywhere; surface it and stop: authentication/permission
  failures (401/403, a bad or missing key; **402** an account billing / insufficient-balance
  problem — classified `auth` so it surfaces as `provider_auth`, never `internal`), malformed
  requests (400, an unsupported model id, a tool schema a provider rejected), classified
  `context_overflow` (ADR-0096, carried as the same fatal engine `ErrorCode`), content-policy
  refusals, request cancellation (`AbortSignal`), and — since
  [ADR-0082](../decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md) —
  **`protocol`**, a provider that broke the stream grammar. A fatal error does **not** silently
  fall through the chain to mask a real bug.

**Two things the classification does NOT decide, and the difference matters.**

*Whether to advance to another provider* is not the same question as *whether to re-run the
node*. `protocol` is fatal in the second sense — an implementation that cannot keep the grammar
will not keep it on the second call. But a violation that happened BEFORE any content still advances
to the next entry, because a different provider may be well-behaved and the user has been shown
nothing. So `retryable` alone no longer determines failover — the chain's verdict reads the kind
*and* the commitment state
([ADR-0082](../decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md) §9).

*Whether the attempt already produced output* is carried separately, by `LlmError.contentCommitted`.
The chain sets it when it surfaces a failure past the first non-terminal chunk, and the turn layer
folds it into retryability — so a `timeout` that arrives after the user has already seen tokens is
never re-dispatched, even though `timeout` is a retryable kind. It is a fact about the ATTEMPT, not
about the error class, which is why it is a field rather than an override of `retryable`
(`makeLlmError` derives `retryable` from `kind`, and that invariant is what keeps a miswired adapter
from producing an inconsistent pair).

**An authoring consequence.** Because `protocol` maps to the `provider_unavailable` `ErrorCode` with
`retryable: false`, an authored `retry_on: [provider_unavailable]`
([ADR-0040](../decisions/0040-node-retry-budget-above-the-chain.md)) does **not** make a grammar
violation retryable — the retryability gate runs before `retry_on` is consulted.

The runner — not the adapter — owns the retry/fallback policy
([ADR-0011](../decisions/0011-internal-llm-abstraction.md)); adapters stay dumb and only
classify. The classification mapping (per-provider status/code → retryable vs fatal) is
covered by the [per-provider conformance suite](testing.md#per-provider-conformance-tests).

A surfaced engine `context_overflow` message is always engine-authored and content-free: it names the actual
attempted model, its authoritative window or fixed unknown wording, and whether tools ran.
Neither chain failover nor node retries handle it. The
[seam's dialect table](../reference/shared-core/llm-provider-seam.md#classified-context-overflow)
owns the fixture-pinned classification and custom-endpoint downgrade. Actual usage supplied
with a failed native response is still priced and recorded; a reserved estimate is never
reported as actual usage. Surfaces supply their own policy-aware commands.

### Diagnostic secret backstop

`makeLlmError` passes every `message` and `code` through `scrubSecrets`
(`packages/llm/src/scrub-secrets.ts`), and the CLI's display sanitizer composes the same function.
It is a defense-in-depth **backstop**: the adapter still owns passing an already-redacted
message, and the backstop masks a finite set of secret **shapes**, not arbitrary sensitive
content.

- **Shapes.** OpenAI/Anthropic `sk-…` and Google `AIza…` key prefixes; a finite list of literal
  secret query names, after `?`, `&` or `#` (an OAuth implicit-flow `#access_token=`); the exact
  `api-key`, `x-api-key` and `x-goog-api-key` header names, also in quoted, JSON-encoded and
  JSON-in-JSON (`\"x-api-key\":\"…\"`) objects; and `Bearer`/`Basic` authentication values. A header
  value may begin with up to eight (possibly quoted, escaped, punctuation-glued or LF/TAB-split)
  `Bearer`/`Basic` labels — a doubled `Bearer Bearer` is a common misconfiguration. Its token may
  begin with any run of (escaped) quotes and ends at a delimiter, at escapes before one, or before a
  nested header name, which then masks its own value. A label may be closed by its own quote before
  its token (`"Bearer" <token>`), and a run of up to eight concatenated labels (`BearerBearer`)
  counts as one label. No label takes as its token another label that whitespace or the end of the
  text follows, even one glued behind punctuation, quoted or concatenated, so a standalone value
  with any number of separately stacked labels masks the token after the last one, and a label glued
  to a token behind a non-word character masks its own token; a second label that other punctuation
  follows (`Bearer Bearer;`) is masked as a token, which only over-masks.
- **Masking.** Every rule, the literal query names included, finds its matches in the original
  text, and the masked ranges of all rules are merged before anything is replaced, so no rule
  can erase the context another rule needs. A header, label or query rule masks only its token:
  the header name, the separator, any labels and the query name stay visible, an LF/TAB-split
  label keeps its spelling, and quotes around a token stay outside it. Masking a token that is
  already exactly `[REDACTED]` changes nothing, so a masked token is a fixed point, quoted,
  escaped or after labels. After a `Bearer`/`Basic` label, text glued to the marker
  (`Bearer [REDACTED];tail`) is masked with it; a header token ends at `,`, `;` or `}`. One
  pass can still glue a marker to the text after another rule's token, so the scrub repeats
  until its output stops changing, at most three passes, and blanks the whole diagnostic if it
  has not settled: a second scrub changes nothing.
- **URL userinfo.** The `?`/`#` rule decides where userinfo ends: a raw `?` or `#` before the
  authority `@` begins public query or fragment text only when the text before it is host-shaped (a
  dotted name or IPv4, `localhost` or a bracketed IP literal, with an optional port, at most 260
  characters in all) **and** an `=` assignment follows it, as in
  `https://host.example?contact=a@b.example`. Masked userinfo that holds such a raw `?` or `#`
  leaves the authority ambiguous: unless a host-shaped name follows its last `@`, the text there may
  be the rest of a query value (`https://svc?password=P@ss`), so the mask runs through the
  authority's end, the next `/`, whitespace, quote, `,` or `}`. The scheme rule then decides what is
  masked: `http(s)`, `ws(s)` and `ftp(s)` mask any userinfo, while the connection-string schemes
  `postgres`, `postgresql`, `mysql`, `mariadb`, `redis`, `rediss`, `mongodb`, `mongodb+srv`, `amqp`,
  `amqps`, `ssh`, `sftp`, `ldap`, `ldaps`, `smtp` and `smtps` mask only colon-bearing userinfo
  (`user:pass@`, `:pass@`), so a bare user such as `ssh://git@host` (or a colonless
  `redis://#TOKEN@host`) stays visible. Userinfo whose password is exactly masked stays as it is:
  beside any username under a connection-string scheme, or beside a masked or empty username under
  any scheme; an empty password, or text glued after a masked one, is still masked. The
  authored-content detector's projection of `postgres://app:{{secrets.password}}@db` to
  `postgres://app:[REDACTED]@db` is therefore a fixed point. Core's journal projection applies the
  same `?`/`#` predicate and also merges its rules' ranges, but masks a userinfo together with the
  values its key and opaque-query rules recognize in it, its username's excepted, each to its own
  end, and ends a value no rule recognizes at the last `@`, whose text after it stays as the host,
  rather than masking through the authority's end
  ([built-in tools](../reference/shared-core/built-in-tools.md#finite-diagnostic-credential-masking)).
- **Split and normalized forms.** Every rule except the literal query names also probes the
  terminal-normalized text; a credential revealed only by normalization masks the **whole**
  diagnostic. The key prefixes, URL userinfo and the exact header names are additionally probed in
  the LF/TAB-joined view at original-text boundaries — of the raw text too when terminal
  normalization changed it, since a terminal sequence there may take a split credential's first
  letter (ESC `A` before `AIza…`) — and a credential revealed only by such a split masks the whole
  diagnostic too. A `Bearer`/`Basic` label may itself be split by LF/TAB.
- **Documented trade-offs, all failing closed.** A scheme glued to a word character is masked in
  place; an unlisted scheme ending in a listed one (`gftp://`, `jdbc:mysql://`) matches by its
  suffix; prose that the whitespace-stripped residual probe glues to a path-less URL and a later `@`
  blanks the whole diagnostic, and so does a key prefix (`sk-`, `AIza`) that the same probe joins
  with the following words to its minimum length, at the start of the text or, since the scrub
  repeats, right after another rule's mask (`Authorization: Bearer xyz sk-ant api key invalid`); a
  path-less terminal hyperlink target (OSC 8) that the raw LF/TAB-joined probe joins with a later
  `@` (a hyperlinked table cell before an e-mail address) blanks it as well; a host fragment with no
  assignment (`https://host.example#sec@x`), a single-label host query and an over-long host-shaped
  prefix are masked, and so is the text after the last `@` of such an ambiguous authority unless it
  is host-shaped; a `Bearer`/`Basic` label that ends a line takes the next token with it; an opaque
  value after a label ends only at whitespace, so in compact JSON it masks to the end of the run;
  nine or more concatenated labels, read in the raw text as well as the normalized one, and a token
  that begins with `,`, `;` or `}` after a `Bearer`/`Basic` label in a header value, blank the whole
  diagnostic. Past eight separate labels after a header name, and in a value of labels alone glued
  behind punctuation (`Bearer |Bearer`), the outcome depends on what precedes the header name: when
  its nearest non-whitespace character is a word character, `-` or `_`, the diagnostic stays in
  place (the last label masks any token); otherwise, the start of the text included, it is blanked.
  No token is visible either way, and the output is stable under a second scrub.
- **Limits.** Userinfo under an unlisted scheme is not masked, including driver-qualified spellings
  such as `postgresql+psycopg2://`. Opaque `Bearer`/`Basic` values, `api-key` header values and
  literal secret query values end at any whitespace, LF and TAB included, so a fragment after such a
  break stays visible, as it does after an ordinary space; a label glued to a quoted token without
  whitespace (`Bearer"<token>"`) is likewise outside the shape, as is a token after a JSON escape
  (`\n`, `\t`) that stands for the whitespace after a label. A JSON escape right after a header
  name's colon starts its token, so a value glued to the escape is masked with the escape's letter
  (`"x-api-key":"\n<t>"` → `"x-api-key":"\[REDACTED]"`), while a quoted value behind such an escape
  stays visible (`x-api-key:\t"<t>"`). A terminal sequence with a parameter whose final byte is a
  shape's first letter (ESC `[` `1` `B` before `earer <t>`), and a terminated device-control,
  start-of-string or application-program string (ESC `P`, ESC `X` or ESC `_`, ended by ST or BEL)
  glued before a shape, hide that shape from every view: in the raw text the sequence's last byte
  glues to the shape's first letter, and normalization removes it. A word glued before `sftp://` on
  the same line (`statusftp://user@h`) reads as `sftp`, so its colonless userinfo stays visible like
  any `sftp` user: every whitespace-joined probe, the CLI's display residual among them, glues prose
  to a scheme the same way, and reading it as `ftp` would blank an ordinary
  `connect to sftp://user@host` diagnostic. (A word that ends a line before `ftp://` is no such
  glue: an LF/TAB-split ftp credential after it blanks the diagnostic.) Malformed URLs
  (`https:/u:p@h`), a raw `/` inside a password, invisible characters inside a scheme and JSON whose
  quotes are themselves escaped as `\u0022` are outside the finite shapes. In a JSON-encoded
  diagnostic, an escape written as two characters (`\n`, `\t`, `\r`) and glued before a key prefix,
  a header name or a label defeats that shape's word boundary, so the credential after it stays
  visible (`"key rejected:\nsk-…"`). Core's journal projection shares this limit for key prefixes
  and scheme labels, while core's summary also reads each such escape as its separator and masks the
  credential after it; core's key/value rule's word-character prefix still reads a header or
  secret-key name glued after such an escape (`"err:\napi-key: …"`) and masks the value with it. A header value
  that begins with `,`, `;` or `}` and has no label before it is an empty token, so the text after
  it stays visible. The backstop has no generic key/value rule: a secret key inside a URL authority
  whose value holds `@` — after `;` (`https://svc;a=1;password=P@ss…`), after `&` unless it is one
  of the literal secret query names, or on the next line of a JSON-encoded file whose break is the
  escape `\n` — leaves its value's text after the last `@` visible as the host. Core's key/value
  rule reads that key and masks its value.

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
  `run_timeout` (carried by THREE causes — the workflow `timeout_ms` cap, a `human_gate` node's
  authored `timeout_ms`, and an `agent` node's, per
  [ADR-0085](../decisions/0085-the-node-executor-owes-liveness-and-the-engine-enforces-it.md) §2;
  `error.nodeId` distinguishes them, absent only for the run cap), and `turn_limit` (a **hard** agent/session turn/round cap — distinct from
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
`responseFormat` **and** validates the returned content node-side. The check is **two steps**: an output that
does **not parse as valid JSON** maps to `code: 'validation'` (`retryable: false` — a re-ask is a
node-retry/authoring concern, not a node-level loop), and an output that parses but **violates the
schema** maps to the same code. Conformance is checked against the schema compiled from the authored
`output_schema` ([ADR-0092](../decisions/0092-output-schema-is-validated-by-the-compiler-we-already-own.md)),
using an allowlist-strict JSON-Schema subset: a construct outside the subset is refused **at parse**, so a
schema is never accepted and then left unenforced. *(This clause read "Phase-1 scope is parse-as-JSON only…
deep conformance is a deferred follow-up, it needs a validator dependency behind an ADR" until 2026-09-02.
The dependency premise was false — the project already owned a dependency-free JSON-Schema compiler, written
for the hostile-MCP boundary; what it needed was a strict mode, not a vendor.)*
See [agent-runner.md](../reference/shared-core/agent-runner.md).
