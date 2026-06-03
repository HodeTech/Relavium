# Data Protection — KVKK + GDPR Posture

- **Status**: Not started — precondition for managed mode
- **Phase**: Managed inference (Phase 2) only — **does not apply to BYOK-local**
- **Related**: [ADR-0012](../decisions/0012-managed-inference-dual-mode.md), [ADR-0015](../decisions/0015-managed-mode-data-handling-and-compliance.md), [provider-tos.md](provider-tos.md), [security-and-soc2.md](security-and-soc2.md), [analysis §5](../analysis/managed-inference-business-model-2026-06-03.md)

> **Phase 2 (managed).** A data-protection posture is required because in managed mode
> Relavium **receives and proxies customer prompts** through its own gateway and provider
> keys. In BYOK-local the prompt never leaves the user's machine via Relavium, no
> personal data is processed by Relavium, and **this file does not apply.**

The moment managed mode sits in the data path, Relavium becomes a **data processor** and
the providers become its **sub-processors**. That relationship triggers obligations under
both **GDPR** (EU residents) and **KVKK** (Turkey — the founder is Turkey-based). This
file is the posture; the canonical decision is
[ADR-0015](../decisions/0015-managed-mode-data-handling-and-compliance.md).

## Relavium's role in the data chain

```
Customer (data controller)
   └─ Relavium gateway (data PROCESSOR)         ← managed mode only
        └─ LLM provider (SUB-PROCESSOR)         ← Anthropic / OpenAI / Google / DeepSeek (opt-in, excluded from EU/regulated data)
```

- The **customer** is the **controller** — they decide what prompts to send.
- **Relavium** is the **processor** — it processes prompts on the customer's behalf to
  produce a completion and to meter usage.
- The **provider** is a **sub-processor** — Relavium hands the prompt onward to it under
  Relavium's own account (this is the link from [provider-tos.md](provider-tos.md)).

In **BYOK-local** none of this exists: the user calls the provider directly with their
own key, Relavium processes no personal data, and there is no controller/processor/
sub-processor chain.

## The three artifacts this role requires

| Artifact | What it is | Status |
|----------|------------|--------|
| **A DPA Relavium offers customers** | A Data Processing Agreement that customers (especially EU/enterprise) sign with Relavium, setting out processing scope, security measures, sub-processors, and transfer mechanisms. | Not started |
| **DPAs from each provider** | A signed DPA from every provider Relavium proxies, naming the provider as Relavium's sub-processor. Owned here (with the sub-processor list); [R1 clearance](provider-tos.md) **depends on** it. | Not started |
| **A published sub-processor list** | A public, maintained list of every sub-processor (the providers, plus the merchant-of-record, hosting, etc.), with a change-notification commitment. | Not started |

## Cross-border transfer and data residency

The founder is **Turkey-based**, so transfers cross at least two regimes, and customer
prompts may originate anywhere. This requires:

- **KVKK (Turkey).**
  - **VERBİS registration** — registration in Turkey's data-controllers' registry where
    applicable.
  - **Cross-border transfer rules** — KVKK restricts transferring personal data abroad;
    transfers to providers (US-hosted, etc.) need a lawful basis / the appropriate KVKK
    transfer mechanism.
  - **Data-residency stance** — a documented position on where prompts and metering data
    are stored and processed.
- **GDPR (EU residents).**
  - **Standard Contractual Clauses (SCCs)** for transfers of EU personal data outside the
    EEA (to US providers and to a Turkey-based operator).
  - **Lawful basis, data-subject rights, breach notification** consistent with the
    processor role.
- **Provider-region selection.** Where a provider offers regional hosting (e.g. Vertex AI
  regions), use it to keep EU data in-region and to honor the data-residency stance.
- **DeepSeek exclusion.** DeepSeek routes data to **China** and **trains on inputs by
  default**; per [provider-tos.md](provider-tos.md) it is **opt-in, disclosed,
  non-China-hosted, and excluded from EU / regulated data**. It must never be a default
  or silent route for personal data.

## No prompt logging by default — a trust and a compliance asset

Relavium's gateway **does not log prompt or completion content by default. It meters
token counts, not content** ([ADR-0012](../decisions/0012-managed-inference-dual-mode.md),
[ADR-0015](../decisions/0015-managed-mode-data-handling-and-compliance.md)). This is both
a **trust asset** (it preserves the privacy posture the BYOK product was built on) and a
**compliance asset**:

- It **minimizes the personal data Relavium processes and retains** — data minimization is
  a GDPR/KVKK principle, and data you never store cannot be breached, subpoenaed, or
  mis-transferred.
- It keeps the metering pipeline working on **token counts** (`usage_event` records cost
  and billing metadata, not prompt text — see
  [ADR-0014](../decisions/0014-managed-metering-quota-and-billing.md)).
- It is consistent with the binding
  [logging-and-observability](../standards/logging-and-observability.md) and
  [security-review](../standards/security-review.md) rules — **no secrets, no full
  prompts/responses in logs, ever.**

Any feature that *would* log content (e.g. an opt-in debugging trace) must be explicit,
consented, scoped, retention-bound, and reflected in the DPA and sub-processor list.

## Gate summary

Data-protection is **launch-blocking for managed mode** and tracked in the
[compliance gate status table](README.md#gate-status). It is **cleared** when Relavium
has: a customer-facing DPA, signed provider DPAs, a published sub-processor list, VERBİS
registration where applicable, SCCs for EU transfers, a documented data-residency stance,
and no-prompt-logging-by-default implemented per
[ADR-0015](../decisions/0015-managed-mode-data-handling-and-compliance.md). **BYOK-local
ships without any of it.**
