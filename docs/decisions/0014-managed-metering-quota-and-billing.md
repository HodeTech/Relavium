# ADR-0014: Managed-mode metering, quota, and billing

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [0012-managed-inference-dual-mode.md](0012-managed-inference-dual-mode.md), [0013-managed-key-vault-and-pools.md](0013-managed-key-vault-and-pools.md), [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md), [0005-sqlite-drizzle-local-postgres-cloud.md](0005-sqlite-drizzle-local-postgres-cloud.md), [0015-managed-mode-data-handling-and-compliance.md](0015-managed-mode-data-handling-and-compliance.md), [../analysis/managed-inference-business-model-2026-06-03.md](../analysis/managed-inference-business-model-2026-06-03.md), [../tech-stack.md](../tech-stack.md)

## Context

Managed mode ([ADR-0012](0012-managed-inference-dual-mode.md)) sells metered model usage on Relavium's own keys, so the gateway must **count every token, enforce limits, and bill** — none of which exists for BYOK, where usage is the user's own cost and Relavium never sees a dollar of it. Billing was explicitly out of the MVP / Phase-1 scope ([ADR-0008](0008-local-first-phase-1-cloud-phase-2.md), [product-constraints.md](../product-constraints.md)); this ADR records the Phase-2 decision that lights it up for managed mode only.

The [business-model analysis](../analysis/managed-inference-business-model-2026-06-03.md) makes the requirements unforgiving. Margins are thin (token COGS ~75% of price), so metering must be **accurate and real-time**, not best-effort: the hard included-usage cap (13%→71% gross margin) and the per-user/day budget (turning a runaway loop from a −$5,000 event into a −$150 one) only work if enforcement happens *before* the next request, not in a nightly batch. Prepaid credits require a positive float that can never go negative on a streamed, interruptible request. And streaming makes usage capture hard: a stream can be cut mid-response, and provider usage fields must be mapped correctly into our cost model (the adapter responsibility from [ADR-0011](0011-internal-llm-abstraction.md)).

## Decision

**The managed gateway meters usage in real time in Redis with a reserve→settle protocol keyed on a unique `request_id`, enforces quotas and per-user/day budgets in line, captures streaming usage robustly, reconciles nightly against provider invoices, and bills through Stripe. Every `usage_event` stores both `provider_cost` and `billed_cost`, so margin is observable per request.**

- **Real-time metering (Redis).** Live balances, per-user/day budgets, and rate counters live in Redis ([tech-stack.md](../tech-stack.md)) for sub-request-latency reads/writes; `usage_event` rows are the durable system of record in Postgres ([ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md)).
- **Reserve → settle, idempotent on `request_id`.** Before a call, the gateway **reserves** an estimated cost against the user's prepaid balance/budget; after the provider returns actual usage, it **settles** to the real cost (releasing or capturing the difference). Both steps are **idempotent keyed on a unique `request_id`**, so retries, duplicate webhooks, and reconnects never double-charge or double-credit. The prepaid float is therefore never front-run by a whale (the analysis's post-paid failure mode).
- **Streaming usage capture.** Force `include_usage` so the provider emits a final usage frame; if a stream is **interrupted**, fall back to a token **estimate** for settlement; a **nightly reconciliation** corrects every estimate against the provider's authoritative usage/invoice and adjusts balances. This extends the streaming-usage and cost-mapping responsibilities already owned by the [ADR-0011](0011-internal-llm-abstraction.md) adapters — no new seam.
- **Quota enforcement: warn → throttle → hard-stop.** As a user approaches the hard included-usage cap they are **warned**, then **throttled**, then **hard-stopped** (overage requires explicit opt-in to metered overage). A **per-user/day budget** caps blast radius from runaway loops independently of the monthly cap.
- **Stripe billing.** Subscriptions, included usage, and metered overage / prepaid credit top-ups run through Stripe. The plan shape from [ADR-0012](0012-managed-inference-dual-mode.md) is prepaid credits + hard included cap + overage at ~cost×1.3; a merchant-of-record fronts VAT/sales-tax/chargebacks ([ADR-0015](0015-managed-mode-data-handling-and-compliance.md)).
- **Billing topology clarification.** The **merchant-of-record (Paddle / Lemon Squeezy) is the legal seller-of-record** and the billing + VAT/sales-tax + chargeback rail; given the compliance need to absorb tax and chargebacks it is the **primary/default** rail. Relavium's internal `usage_events` ledger **meters** managed consumption and **feeds invoicing through the MoR** — it is not itself a billing rail. A direct **Stripe** integration is the **alternative** rail used **only if not going through an MoR**; Stripe and an MoR are **mutually-exclusive** billing rails, never layered in front of or behind each other ([tech-stack.md](../tech-stack.md), [compliance/tax-and-billing.md](../compliance/tax-and-billing.md)).
- **Margin observable per request.** Each `usage_event` stores `provider_cost` (COGS) **and** `billed_cost` (revenue) so gross margin is queryable per request, per user, per model — making model-routing and pricing decisions data-driven and surfacing adverse selection early.

Considered options:

1. **Post-paid, batch metering** (tally usage, invoice at period end) — *rejected.* The analysis shows a whale can drain the provider pool in days 1–3 of a cycle collected only once; without real-time enforcement the hard cap and per-day budget cannot actually stop spend.
2. **Best-effort streaming usage** (trust the final frame, drop interrupted requests) — *rejected.* Interrupted streams would be unbilled or mis-billed; on ~75%-COGS economics, leaked usage is leaked margin.
3. **Real-time Redis metering + reserve/settle idempotent on `request_id` + nightly reconciliation + Stripe** — *chosen.* The only shape that enforces caps before the next request, keeps the prepaid float non-negative under interruption and retries, and ties out to provider invoices.

Billing/subscription was out of MVP scope; this ADR scopes it **in for managed mode only** — BYOK-local and BYOK-cloud remain unmetered and unbilled. Pinned versions (Redis, Postgres, Stripe) live in [tech-stack.md](../tech-stack.md); the metering data model and the billing-reconciliation runbook are referenced from the managed-inference architecture doc.

## Consequences

### Positive

- Caps and per-day budgets are enforced **before** the next request, so the hard included-usage cap (13%→71% gross) and the runaway-loop budget (−$5,000→−$150) actually hold — the guardrails [ADR-0012](0012-managed-inference-dual-mode.md) depends on are real.
- `request_id` idempotency on reserve/settle makes retries, duplicate webhooks, and reconnects safe — no double-charge, no double-credit — and keeps the prepaid float non-negative.
- Forced `include_usage` + estimate-on-interruption + nightly reconciliation means streamed and interrupted requests are still billed accurately and tied out to provider invoices.
- `provider_cost` + `billed_cost` on every `usage_event` makes margin observable per request/user/model, so routing and pricing are data-driven and adverse selection shows up early.
- Reuses existing infrastructure and seams: Redis/Postgres from [ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md), the adapter usage-mapping from [ADR-0011](0011-internal-llm-abstraction.md); no engine or seam-type change.

### Negative

- A real-time metering + billing subsystem is significant new surface (Redis balances, reserve/settle, reconciliation, Stripe webhooks, dunning) with money-correctness stakes; mitigated by `request_id` idempotency, the durable Postgres event log, nightly reconciliation, and a reconciliation runbook.
- Estimate-on-interruption introduces transient inaccuracy between settlement and nightly reconciliation; bounded and corrected each night, and the float stays positive so the error never risks Relavium's cash.
- Metering adds per-request latency and a Redis dependency on the managed hot path; kept minimal and off the BYOK paths entirely.
- This subsystem exists **only** for managed mode, so the codebase carries a billing surface that BYOK users never touch; accepted as the cost of monetizing managed convenience.
- Token-count metering is deliberately content-blind: we meter counts, not prompt content, which constrains some billing-dispute introspection — an intentional trade-off recorded in [ADR-0015](0015-managed-mode-data-handling-and-compliance.md).
