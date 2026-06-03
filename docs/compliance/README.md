# Compliance

> Scope: **managed-inference (Phase-2) preconditions only.** None of this applies to
> BYOK-local.

This folder holds the **legal, privacy, tax, and security gates** that Relavium must
clear **before shipping managed inference** — the `managed` execution mode adopted in
[ADR-0012](../decisions/0012-managed-inference-dual-mode.md). Managed mode puts
Relavium *in the data path*, using its **own** provider API keys and **billing
customers for metered usage**. The moment Relavium bills and proxies model traffic, a
compliance surface appears that the BYOK-local product never had. This folder is that
surface, written down.

## The one framing that governs this whole folder

> **These are managed-mode preconditions. BYOK-local needs none of them.**

In BYOK-local ([ADR-0008](../decisions/0008-local-first-phase-1-cloud-phase-2.md)) the
engine runs on the user's machine and calls the provider with the **user's own key**
from the OS keychain ([ADR-0006](../decisions/0006-os-keychain-for-api-keys.md)).
Relavium never sees a prompt, never holds a provider key, never bills for tokens, and
is **not** in the data path. There is no data-processor relationship, no sub-processor
chain, no token-resale question, and no usage-tax event. Everything in this folder is
triggered specifically by managed mode and is **launch-blocking for managed only** —
shipping BYOK-local is not blocked by any of it.

| | BYOK-local (Phase 1) | Managed inference (Phase 2) |
|---|---|---|
| Whose provider key | the user's, in the OS keychain | **Relavium's** |
| Who calls the provider | the user's machine | **Relavium's gateway** |
| Who is billed for tokens | the user, by the provider | the customer, **by Relavium** |
| Relavium in the data path | no | **yes** |
| Compliance gates in this folder | **none apply** | **all apply (preconditions)** |

See the analysis that produced this decision:
[managed-inference business-model analysis](../analysis/managed-inference-business-model-2026-06-03.md)
(esp. §1 legality and §5 compliance), and
[ADR-0012](../decisions/0012-managed-inference-dual-mode.md) (the dual-mode decision).
The canonical managed-mode data-handling decision is
[ADR-0015](../decisions/0015-managed-mode-data-handling-and-compliance.md).

## Gate status

All gates are launch-blocking for managed mode and are **not started**: this section is
documentation of the obligation, not evidence of compliance. Managed mode does not ship
until every gate below is **cleared**.

| Gate | What it requires | Document | Status |
|------|------------------|----------|--------|
| **R1 — Provider ToS / reselling** | Written confirmation or commercial/partner agreement, **per provider**, that Relavium may hold the key and sell metered usage. Hard go/no-go. | [provider-tos.md](provider-tos.md) | Not started — required before managed ships |
| **Merchant-of-record** | A merchant-of-record (Paddle / Lemon Squeezy) that absorbs VAT/GST/sales-tax calc, collection, and remittance plus chargebacks. | [tax-and-billing.md](tax-and-billing.md) | Not started — required before managed ships |
| **DPA + sub-processor list** | A DPA Relavium offers customers, signed DPAs from each provider, and a published sub-processor list. | [data-protection.md](data-protection.md) | Not started — required before managed ships |
| **KVKK / GDPR posture** | VERBİS registration, lawful cross-border transfer (SCCs), data-residency stance, no-prompt-logging-by-default. | [data-protection.md](data-protection.md) | Not started — required before managed ships |
| **SOC 2 Type II** | Type II report for enterprise sales (6–12 month runway). Master-key handling, multi-tenant isolation, AUP + abuse controls + kill switch. | [security-and-soc2.md](security-and-soc2.md) | Not started — required for enterprise (post-launch trajectory) |

## Documents

| Document | Covers |
|----------|--------|
| [provider-tos.md](provider-tos.md) | The R1 go/no-go gate. Per-provider (Anthropic, OpenAI, Google, DeepSeek) reselling/ToS posture, the allowed-vs-restricted line, and the action needed per provider. **The most important file here.** |
| [data-protection.md](data-protection.md) | KVKK + GDPR posture, Relavium's data-processor role, the DPA and sub-processor list, cross-border transfer / data residency, and the no-prompt-logging-by-default stance. |
| [tax-and-billing.md](tax-and-billing.md) | VAT/GST/sales-tax exposure on cross-border digital services, the merchant-of-record decision, refunds and chargebacks. |
| [security-and-soc2.md](security-and-soc2.md) | Master-key handling, multi-tenant isolation, abuse / AUP + moderation liability + provider key-ban risk, and the SOC 2 Type II trajectory for enterprise. |

## How this folder relates to the rest of the tree

- The **decision** to add managed mode (and the obligation to clear these gates) lives
  in [ADR-0012](../decisions/0012-managed-inference-dual-mode.md) and
  [ADR-0015](../decisions/0015-managed-mode-data-handling-and-compliance.md). This
  folder records *the gates*, not the decision.
- The **engineering** controls these gates depend on (master-key vault and pools,
  metering, no-prompt-logging) are decided in
  [ADR-0013](../decisions/0013-managed-key-vault-and-pools.md) and
  [ADR-0014](../decisions/0014-managed-metering-quota-and-billing.md) and built per the
  [security-review.md](../standards/security-review.md) checklist.
- This folder follows the binding
  [documentation-style.md](../standards/documentation-style.md): no front-matter,
  one H1, relative links, kebab-case, English, Phase-2 content explicitly marked.
