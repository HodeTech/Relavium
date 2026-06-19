# ADR-0040: Node-level retry budget above the provider fallback chain

- **Status**: Accepted
- **Date**: 2026-06-15
- **Related**: [ADR-0038](0038-agentrunner-llm-call-boundary.md) (amended — see Decision A.2), [ADR-0011](0011-internal-llm-abstraction.md) (the `FallbackChain` owns within-chain policy), [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md) (run loop + the injected one-shot timer), [ADR-0027](0027-expression-sandbox.md) / [ADR-0029](0029-tool-policy-hardening.md) (failure classification), [error-handling.md](../standards/error-handling.md), [run-plan.md](../reference/shared-core/run-plan.md) and [node-types.md](../reference/shared-core/node-types.md) (which already pre-describe this layer), [expression-sandbox-spec.md](../reference/shared-core/expression-sandbox-spec.md) (the `runId + nodeId + retryCount` idempotency key)

> **Amended 2026-06-20 by [ADR-0045](0045-async-media-job-loop-poll-checkpoint-resume-cancel.md).** A scoped exception, not a reversal: for the async-media node only, ADR-0045 **re-attaches** to a persisted provider job on crash-resume instead of re-running from pending (the default A.6 quotes), and **carves the wall-clock media-poll cadence out of the A.3 deterministic-replay invariant** (an external job result is non-deterministic state already). The node-retry budget + classification rules are otherwise unchanged.

## Context

Reliability in the engine has **two distinct retry concerns**, and only one is built:

1. **Within an attempt — provider failover (built, 1.K/1.O).** The `FallbackChain`
   ([ADR-0011](0011-internal-llm-abstraction.md)) walks an agent's providers: on a *retryable* `LlmError`
   (429/5xx/timeout/transport) it retries a provider per that **chain entry's `max_attempts`** and fails
   over to the next. LLM-only, in `@relavium/llm`.
2. **Above the chain — whole-node retry (not built, 1.S).** This layer is **already canonically described**:
   [run-plan.md](../reference/shared-core/run-plan.md) (§"Retry is not lifted onto the plan") states *"Node-level
   retry above the provider fallback chain is layered by **1.S**, which reads `retry_config` from the authored
   node (`config.node`) and re-attempts before a node is considered finally failed,"* and
   [node-types.md](../reference/shared-core/node-types.md) already lists the engine `retry_config` field set —
   `max_attempts`, `backoff_ms` (base delay), `backoff_strategy` (`linear`/`exponential`, *"from the authored
   YAML `retry.backoff`"*), `retry_on[]`. [error-handling.md](../standards/error-handling.md) likewise classifies
   `tool_failed` and a sandbox **wall-clock-timeout** as *"retryable **within the node retry budget**."* **None of
   it is wired** — non-agent nodes (`transform`, `tool`, `condition`, `fan_in`) have no retry and the run loop
   never re-dispatches them; a transient `tool_failed` is terminal on the first trip.

Two **verified contradictions** block 1.S:

- **`node.retry` means the wrong thing.** The authored `RetrySchema` is `{ max, backoff }`, doc-commented
  *"transient-error retry on the **same** model"* (`agent.ts:33`), and the AgentRunner feeds **both** fields into
  the **primary `FallbackPlanEntry`** (`agent-runner.ts:208-214`: `maxAttempts: retry?.max ?? 1` and
  `backoff: retry.backoff`) — i.e. `node.retry` currently configures *within-chain* primary retry, not the
  above-chain budget run-plan.md/node-types.md describe.
- **The authored config is too thin** to lower to the documented engine form: `retry_on[]` and a base
  `backoff_ms` (node-types.md:128) have no authored source in `{ max, backoff }`.

Getting this wrong silently double-counts (a node retried within the chain *and* re-run above it under one
`max`), or leaves non-agent nodes un-retryable with error-handling.md's "node retry budget" dangling.

## Decision

This is two related decisions; **Part A** is the in-run automatic retry budget, **Part B** is the
user-triggered retry-from-node. They share the idempotency key but are otherwise independent.

### Part A — an engine-level node-retry budget above the chain

**We will add an engine-level node-retry budget above the provider fallback chain, governed by the node's
extended `retry` config, applied to _every_ node type — re-interpreting `node.retry` as that above-chain
budget.** This realises the layer run-plan.md:62 and node-types.md:128 already specify.

**A.1 — Two layers, cleanly separated.**
- *Within-attempt (unchanged, 1.K):* the `FallbackChain` fails over across providers and retries a provider per
  its **chain-entry `max_attempts`**, on a retryable `LlmError`. LLM-only.
- *Above-chain (new, 1.S):* the **run loop** re-dispatches a **whole node** when its `NodeOutcome` is `failed`
  with `retryable: true` (and, if `retry_on` is set, `code ∈ retry_on`), up to `max` **total attempts**,
  sleeping `backoff(attempt)` between. Applies to **all** node types.

**A.2 — `node.retry` IS the above-chain budget (amends ADR-0038).** The AgentRunner stops feeding `node.retry`
into the primary `FallbackPlanEntry` (it defaults to `maxAttempts: 1` and the chain's own default backoff —
exponential / 250 ms base, `fallback-chain.ts`); the engine reads the resolved node's `retry` and applies it
above the chain. This reverses **one detail** of [ADR-0038](0038-agentrunner-llm-call-boundary.md) (both `max`
**and** `backoff` were fed into the primary entry); the rest of ADR-0038 stands. **On acceptance** this lands as
a dated `> Amended by ADR-0040` note on ADR-0038 (not a status flip — [documentation-style.md](../standards/documentation-style.md) §7) plus an update to the `(ADR-0038)` comment at `agent-runner.ts:207`. *Same-model* in-chain
retry of the **primary**, if an author wants it without re-walking the whole chain, is declared as an optional
primary chain-entry `max_attempts` (default 1) — it is no longer implied by `node.retry`.
- *Considered — two configs* (keep `node.retry` within-chain, add a separate above-chain field): rejected — two
  retry knobs per node is confusing, and run-plan.md/node-types.md/error-handling.md all frame `retry` as *the*
  node budget. One knob, unambiguously above-chain.
- *Considered — no above-chain layer*: rejected — leaves the canonical docs' "node retry budget" dangling and
  non-agent nodes un-retryable.

**A.3 — `RetrySchema` extension + which node schemas carry `retry`.** Authored `retry` keeps `max` (→ engine
`max_attempts`; **total attempts including the first** — `max: 3` ⇒ the initial attempt + up to 2 re-dispatches)
and `backoff` (→ `backoff_strategy`). It **adds**: optional **`backoff_ms?`** (the base delay the strategy
scales — **default 1000 ms**; this is the *above-chain* base, deliberately distinct from and **independent of**
the chain's 250 ms within-chain base) and optional **`retry_on?: ErrorCode[]`**. Existing `{ max, backoff }`
YAML parses unchanged. The lowering (authored friendly names → engine `retry_config`) is the node-types.md:130
mapping, owned by `@relavium/core`.

- **The concrete backoff formula** (1-based `attempt` = the index of the retry about to be scheduled, so the
  first re-dispatch is `attempt = 1`): `linear` ⇒ `delayMs = backoff_ms * attempt`; `exponential` ⇒
  `delayMs = backoff_ms * 2^(attempt - 1)`. **No jitter** — the run loop is deterministic-replay (backoff is
  wall-clock only and never affects event order or outputs; jitter would add non-determinism for no benefit
  here).
- **Bounds + the concurrency-slot trade-off.** The computed `delayMs` is **capped at 24 h**
  (`MAX_NODE_RETRY_BACKOFF_MS`) so a large schema-valid `max` × `exponential` can never overflow the event
  schema's integer range or arm an absurd one-shot timer; a retry that genuinely needs a >24 h wait should be a
  scheduled job, not a node budget. `max` itself is **intentionally unbounded** (`positiveInt`, consistent with
  `max_attempts` / `window_size` / `max_parallel` — author-controlled, git-committed, code-reviewed config): the
  backoff cap, not a `max` ceiling, is the guardrail against an absurd budget. A node holds its `max_parallel`
  slot for the **whole** backoff sleep (it stays `running` so the run never idles mid-retry — freeing it would
  re-introduce the idle race), so under a tight cap a long `backoff_ms` can serialize otherwise-ready sibling
  branches: keep `backoff_ms` modest under a tight cap.
- **Which authored schemas gain `retry`** (a `@relavium/shared` change): it joins `agent` (which already has it)
  on the node types that can produce a *retryable* failure — **`condition`, `transform`, `merge`** (their
  `merge_fn`/expression runs in the sandbox, whose wall-clock-timeout is retryable). **Excluded:**
  `human_gate` (a gate timeout is `run_timeout`, which is **fatal** — re-running a gate is meaningless and its
  own `timeout_action` already governs it), and `input` / `output` / `parallel` (purely structural/deterministic
  — they cannot produce a transient failure, so a `retry` field would be inert noise). The engine retry layer
  itself is **generic** (it acts on any node whose outcome is retryable-and-within-budget); the schema set above
  is just which node types may *author* a budget. A.8's "non-agent nodes have only their own `node.retry`"
  refers to exactly this set.

**A.4 — `retry_on` is parse-validated to the retryable subset (reject, not ignore).** A new
`RETRYABLE_ERROR_CODES` constant in `@relavium/shared/constants.ts` (its one canonical home) names the codes a
node budget may retry — exactly these four enum values: **`provider_rate_limit`, `provider_unavailable`,
`tool_failed`, `sandbox_error`** (the wall-clock-timeout arm only; deterministic sandbox errors are
`retryable: false` and excluded by the A.5 gate). There is no fifth code: when the `FallbackChain` exhausts on
real retryable failures the surfaced `ErrorCode` is already `provider_rate_limit` / `provider_unavailable`, and
a chain that exhausts with no real error surfaces `internal` (fatal — never retried). `RetrySchema`
types `retry_on` as `z.array(z.enum(RETRYABLE_ERROR_CODES))` — the subset enum rejects any member outside it at parse time (the
[ADR-0023](0023-strict-authored-yaml-validation.md) strict-reject ethos — a `retry_on: [tool_denied]` is an
authoring error surfaced loudly, never a silent no-op). `retry_on` only **narrows** the already-retryable set;
it can **never** resurrect a fatal failure. Retryability itself stays single-sourced in `NodeFailure.retryable`
per [error-handling.md](../standards/error-handling.md) (fatal: `provider_auth`, `validation`, `tool_denied`,
`cancelled`, `budget_exceeded`, `run_timeout`, `turn_limit`, deterministic `sandbox_error`).

**A.5 — The engine interceptor + the intermediate-attempt event (the structural change).** Today
`#onOutcome` routes a `failed` outcome straight to `#settleFailed`, which **immediately** sets `#failure`,
marks the vertex `failed`, and calls `#abort.abort()` (killing sibling branches) — none of which may happen
while a retry budget remains. So 1.S inserts a retry decision **before** `#settleFailed`: on a `failed` outcome
that is retryable-and-within-budget-and-`retry_on`-admitted, the engine instead

- emits a **new, non-terminal `node:retrying` event** `{ nodeId, attemptNumber, error, delayMs }`, where
  `error` is the failed attempt's `{ code, message, retryable }` (the `NodeFailure` shape) **without** a
  `correlationId` — the correlation id is the anchor of the *terminal* `node:failed`, not of an intermediate
  attempt; `delayMs` is the backoff before the next attempt,
- sleeps `delayMs` via the **injected one-shot host timer** (`ExecutionHost.setTimer(delayMs, onFire) => disarm`
  — `execution-host.ts`, [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md) Decision 5, the
  1.Q pattern). `setTimer` takes **no** `AbortSignal`; abort-awareness is the engine registering
  `signal.addEventListener('abort', disarm)` so a cancel **disarms** the pending retry → **cancel wins** (no
  re-dispatch after `run:cancelled`),
- re-dispatches the node as a fresh attempt (incremented `attemptNumber`).

`#settleFailed` (terminal `node:failed` + `#failure` + `#abort`) runs when the budget is exhausted, the failure
is fatal / excluded by `retry_on`, **or** a cancel/sibling-abort lands while a retry is pending (the engine
settles the last attempt's failure rather than waste a re-dispatch — the run still closes on the cancel /
sibling root cause, by `#settleFailed`'s precedence). `node:failed` therefore **stays terminal — exactly one per
node** (no breaking change to its meaning). `node:started` and `node:failed` **gain an optional `attemptNumber`**
(a second, additive `@relavium/shared` change) so a surface distinguishes "attempt 2 starting" from a replay and
attributes the terminal failure to an attempt. This is the **node-retry** dispatch counter, shared with
`node:completed`/`node:retrying`; it is **distinct from** the within-chain `cost:updated` / `agent:*` counter
(which resets per re-dispatch) — the two do **not** join (sse-event-schema.md §"Two attemptNumber families").

**A.6 — Checkpointer (1.R) needs no fold change.** Because `node:retrying` is **non-state-bearing** (folded
like `node:started` — ignored) and `node:failed` is emitted **only** on final exhaustion, a
`node:started → node:retrying → node:started → node:completed` sequence folds to `completed`, and a
`… → node:retrying → node:started → node:failed` sequence folds to `failed` (terminal). `reconstructCheckpointState`'s
existing arms are correct as-is; we add `node:retrying` to its explicitly-ignored set (a one-line comment, no
logic change). A crash mid-retry leaves the node started-but-unfinished → absent → re-run from `pending` (the
1.R trap-b path). **The retry _count_ is not persisted in the Phase-1 checkpoint and resets to 0 on a
crash-resume** — so a node may consume up to `max` *additional* attempts per crash-and-resume cycle. The
idempotency key bounds **side-effect re-application** (a re-run of a non-idempotent step is a no-op at the
target), **not** the attempt count. (A Phase-2 refinement may reconstruct the spent count by folding the
persisted `node:retrying` events' `attemptNumber`; the in-memory reference does not, and that is acceptable —
`max` caps cost *within* a single process, not across crashes.)

**A.7 — Idempotency + cost.** Each re-dispatch uses the `runId + nodeId + retryCount` key
([expression-sandbox-spec.md](../reference/shared-core/expression-sandbox-spec.md); a 1.R/retry-from-node
concept — **not** ADR-0036). The node-retry `attemptNumber` rides `node:started`/`node:completed`/`node:failed`/
`node:retrying`; `cost:updated` (and `agent:*`) carries its **own** within-chain attempt counter, which resets
to 1 on each re-dispatch — the two are **distinct** and do not join (sse-event-schema.md §"Two attemptNumber
families"). Cost is still tallied for **every** attempt across both layers and folded run-wide via
`cumulativeCostMicrocents`; to bucket cost *by node-retry attempt*, a surface partitions the ordered stream at
the `node:started`/`node:retrying` boundaries rather than joining on `attemptNumber`. The per-node-execution
`FallbackChain` is rebuilt fresh on each whole-node re-dispatch (ADR-0038) — its per-provider cooldown state does **not** persist across
node retries **by design**: the above-chain `backoff_ms` delay *is* the inter-attempt cooldown, so a rate-limit
that exhausted the chain waits `backoff(attempt)` before the next whole-node attempt rather than re-hitting the
limit immediately.

**A.8 — Resolution precedence.** The runner resolves `node.retry ?? agent.retry` (a node override wins over the
agent default — unchanged from ADR-0038); both are now the **above-chain** budget. `agent.retry` is the
above-chain budget for an `agent` node; **non-agent nodes have only their own `node.retry`** (no agent fallback).

**A.9 — Deferred.** Roadmap §1.S's *"optional input adjustment"* on retry (re-running a node with mutated
inputs) is **explicitly deferred** to a follow-up — the budget+backoff+`retry_on` core lands first; input
adjustment needs an authoring surface and a re-resolution story that are out of this ADR's scope.

### Part B — retry-from-node (user-triggered)

> **Amended (2026-06-15): Part B is deferred to Phase-2 — NOT implemented with Part A.** Implementing it
> surfaced an irreducible conflict for the Phase-1 in-memory engine: the design below wants the **same
> `runId`** (so the host dedups completed-upstream side effects via `runId+nodeId+retryCount`) **and** a
> single terminal event. But a settled run already holds its one `run:completed`/`run:failed`
> ([ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md) exactly-one-terminal); re-running on
> the same `runId` would append a **second** terminal and the 1.R Checkpointer fold would see two. A *new*
> `runId` fixes the terminal/`retryCount` cleanliness but breaks upstream-side-effect dedup (different keys).
> Reconciling "same runId + single terminal + no upstream re-apply" needs the **real persistent store + a
> run-attempt model** (a re-run row referencing the original) — Phase-2, which already owns the surface
> trigger. Part A (the in-run budget) is the landed 1.S deliverable; retry-from-node is tracked in
> [deferred-tasks.md](../roadmap/deferred-tasks.md). The original design intent is preserved below.

**We will add a `WorkflowEngine` API to re-run a settled/failed run from a chosen node**, reusing the
`runId + nodeId + retryCount` key so completed-upstream side effects are not re-applied. To avoid a key
**collision** with Part A's automatic attempts (a fresh run-from-node must not reuse `retryCount: 0`, which an
automatic first attempt already occupies), retry-from-node **continues** the targeted node's `retryCount` from
where the original run left it (monotonic per `runId + nodeId`), never resetting to 0. The Phase-1 deliverable
is the in-memory engine semantics + this key discipline; the surface trigger (a UI/CLI affordance) is Phase-2.

## Consequences

### Positive

- One coherent retry story matching the canonical docs: within-chain failover (LLM) under whole-node retry
  (any node type); the budget error-handling.md/run-plan.md/node-types.md already reference now exists.
- Non-agent nodes recover from a transient failure; `node:failed` stays terminal (exactly one per node), so
  the 1.R Checkpointer fold is untouched; `node:retrying` gives per-attempt observability.
- `retry_on` is author-safe by construction (parse-rejected to the retryable subset; cannot resurrect a fatal).
- Cost is tallied for every attempt across both layers and folded run-wide; per-node-retry-attempt bucketing is
  by stream order, not an `attemptNumber` join (sse-event-schema.md §"Two attemptNumber families"). A required
  node never silently vanishes.

### Negative / land-time obligations

- **`@relavium/shared` contract changes (all additive):** (1) `RetrySchema` gains `backoff_ms?` + `retry_on?`
  with `retry_on` typed as the `z.enum(RETRYABLE_ERROR_CODES)` subset (reject-at-parse, also rejecting an
  empty array via `.min(1)`); (2) a new `RETRYABLE_ERROR_CODES` constant in `constants.ts`; (3) a new
  **`node:retrying`** run event — `NodeRetryingEventSchema` in `run-event.ts`, added to `RUN_EVENT_TYPES`
  (`constants.ts`) **and** the `RunEventUnionSchema` discriminated union, with its per-variant type export and a
  CONTRACT_NAMES count bump in `run-event.test.ts`; (4) optional `attemptNumber` on `node:started` +
  `node:failed`; (5) the `retry` field added to the `condition` / `transform` / `merge` authored node schemas
  (joining `agent`). `sse-event-schema.md` must document the new event + fields (and that `node:started` may
  now repeat per attempt).
- **Behavior change vs ADR-0038:** `node.retry` (both `max` and `backoff`) now drives whole-node re-dispatch,
  not primary in-chain retry. Lands as a dated `> Amended by ADR-0040` note on ADR-0038 + the `agent-runner.ts:207`
  comment update. A workflow relying on the old meaning moves that intent to a primary chain-entry `max_attempts`.
- **Doc invalidations to fix at land time** (the canonical homes that currently describe the old meaning):
  `agent.ts:33` (`RetrySchema` comment), `agent-yaml-spec.md` :37 / :62 / :69 ("same model" retry) and :85
  (the "primary model (with retry) → fallback" resolution order). `run-plan.md:62` and `node-types.md:128`
  already describe the new model and need no change.
- A non-idempotent node's re-run is heavier (bounded by the idempotency key); a node with external side effects
  must be idempotent or guarded — the same constraint 1.R imposes on crash re-runs.
