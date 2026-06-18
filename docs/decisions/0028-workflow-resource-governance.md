# ADR-0028: Workflow resource governance — pre-egress budget, run timeout, concurrency cap

- **Status**: Accepted
- **Date**: 2026-06-05
- **Related**: [0008-local-first-phase-1-cloud-phase-2.md](0008-local-first-phase-1-cloud-phase-2.md), [0014-managed-metering-quota-and-billing.md](0014-managed-metering-quota-and-billing.md), [../reference/contracts/workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md), [../reference/contracts/sse-event-schema.md](../reference/contracts/sse-event-schema.md), [../reference/contracts/ipc-contract.md](../reference/contracts/ipc-contract.md), [../architecture/execution-model.md](../architecture/execution-model.md)

> **Amended 2026-06-18 by [ADR-0044](0044-media-access-governance-read-media-save-to-cost.md).** A refinement, not a reversal: ADR-0044 adds a **disjoint per-modality media cost class** to this ADR's pre-egress governor — it widens the pre-egress hook to carry `outputModalities`/a media-unit estimate and folds the media estimate into the **existing** `max_cost_microcents` cap (no new cap dimension, no new event/error class). This ADR's budget / timeout / concurrency decisions are unchanged.

## Context

A workflow can spend real money. A fan-out of agent nodes, a fallback chain that tries several
providers, or a mis-authored graph can run up cost with **nothing to stop it**: the engine today
tallies cost *after* each call (the `cost:updated` event) but has no pre-emptive cap, no run-level
timeout, and no limit on how many provider calls fire at once. Per-node cost tracking is a Relavium
differentiator; an authored **budget** is the natural first-class complement. This must not be
confused with the Phase-2 **managed-mode** quota/billing system
([ADR-0014](0014-managed-metering-quota-and-billing.md)), which governs *Relavium's* keys and
metered billing — this ADR is a **BYOK-local, author-declared safety rail** that ships in Phase 1.

## Decision

**A workflow may declare an optional `budget` block, a run `timeout_ms`, and a parallel concurrency
cap; the budget is enforced *pre-egress* — estimate-and-block, not count-after.**

- **Pre-egress check.** Before each LLM call the engine evaluates
  `cumulative_cost + worstCaseNextEstimate(maxTokens) > budget.max_cost_microcents`; if it would
  exceed, it applies `on_exceed`:
  - `fail` — stop the run with a typed budget error;
  - `pause_for_approval` — **reuse the human-gate seam** to suspend and ask the user to continue
    (the gate carries the spent/limit figures);
  - `warn` — emit a warning and proceed.
  - **No `maxTokens` on the node?** the estimate uses a **configured per-call default**
    (`[defaults].max_tokens_estimate` — [config-spec.md](../reference/contracts/config-spec.md)), not the
    model's absolute max output (which would over-block — e.g. trip a small budget on the first turn);
    a workflow that declares a `budget` may additionally require `maxTokens` on its agent nodes for a
    tighter estimate.
- **Run timeout.** `timeout_ms` bounds total wall-clock; on expiry the run ends with a typed timeout
  outcome.
- **Concurrency cap.** A configurable maximum number of in-flight provider calls bounds a wide
  fan-out so it cannot trigger a rate-limit/cost storm.
- **Events.** New `budget:warning`, `budget:paused` (human-gate-shaped, resumable via the
  `resume_budget` IPC command + the `relavium budget resume` CLI / `relavium.resumeBudget` VS Code
  paths), and `run:timeout` events join the canonical stream
  ([sse-event-schema.md](../reference/contracts/sse-event-schema.md)). The authored fields live in
  [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md).
- **Sessions, too.** An `AgentSession` (which has no workflow YAML) carries the **same** pre-egress
  cost cap via the `[chat]` config's `max_cost_microcents` + `on_exceed`
  ([config-spec.md](../reference/contracts/config-spec.md)), enforced by the identical governor — so
  "both entry points inherit resource governance" ([ADR-0024](0024-agent-first-entry-point-agentsession.md))
  is literally true, and an open-ended multi-turn chat cannot run away on cost.

Considered: **(A)** count-after only (the status quo) — *rejected*: detects the overspend after the
money is gone. **(B)** reuse ADR-0014's managed quota engine — *rejected*: that is a cloud,
multi-tenant, Relavium-key billing system; a BYOK-local author wants a simple per-workflow guardrail
with no account. **(C, chosen)** an author-declared, pre-egress, estimate-and-block budget plus
timeout and concurrency cap, wired to the existing human-gate seam for the pause case.

## Consequences

### Positive

- A runaway workflow fails safe before it drains an account — cost control becomes a first-class,
  authored property aligned with the cost-tracking value proposition.
- `pause_for_approval` reuses the human-gate machinery, so there is no new suspension mechanism.
- BYOK-local users get the guardrail in Phase 1 without any cloud or account dependency; it composes
  cleanly with the Phase-2 managed quotas (which remain a separate, additional layer).

### Negative

- `worstCaseNextEstimate` is an estimate (it uses `maxTokens`), so the cap is conservative — it may
  stop slightly early rather than overshoot; this is the safe direction and is documented.
- The concurrency cap can slow a wide fan-out; it is configurable so authors trade throughput
  against rate-limit/cost risk explicitly.
- More run outcomes/events (`budget:*`, `run:timeout`) for every surface to render.
