# Tax and Billing — Merchant-of-Record

- **Status**: Not started — precondition for managed mode
- **Phase**: Managed inference (Phase 2) only — **does not apply to BYOK-local**
- **Related**: [ADR-0012](../decisions/0012-managed-inference-dual-mode.md), [ADR-0014](../decisions/0014-managed-metering-quota-and-billing.md), [ADR-0015](../decisions/0015-managed-mode-data-handling-and-compliance.md), [analysis §3, §5](../analysis/managed-inference-business-model-2026-06-03.md)

> **Phase 2 (managed).** Tax and billing obligations attach because managed mode is the
> first time **Relavium sells anything** — metered model usage by license tier. BYOK-local
> sells no usage and puts no transaction in Relavium's hands, so **this file does not
> apply** to it. (If BYOK-local later charges a flat software subscription, that is a
> separate, simpler tax question — not the cross-border usage-tax surface described here.)

The moment Relavium **bills for usage**, indirect tax (VAT / GST / sales tax) attaches at
the **first sale** of a cross-border digital service. Relavium's customers can be
anywhere, so this is not one jurisdiction's rule — it is dozens, each with its own
registration thresholds, rates, invoicing format, and remittance schedule. Handling that
in-house is a heavy, error-prone, ongoing obligation.

## The decision — adopt a merchant-of-record

> **Relavium adopts a merchant-of-record (MoR) — Paddle or Lemon Squeezy — for all
> managed-mode billing**, rather than acting as the seller-of-record itself.

A merchant-of-record becomes the **legal seller** to the end customer and **absorbs**:

| Burden | Without an MoR (Relavium does it) | With an MoR |
|--------|-----------------------------------|-------------|
| **VAT / GST / sales-tax calculation** | Relavium computes the correct rate per jurisdiction, per sale. | The MoR computes it. |
| **Tax collection** | Relavium collects it at checkout. | The MoR collects it. |
| **Tax registration + remittance** | Relavium registers in and files with each jurisdiction. | The MoR is registered and remits. |
| **Chargebacks / disputes** | Relavium fights each one with the card networks. | The MoR handles disputes as seller-of-record. |
| **Invoicing / compliance format** | Relavium issues compliant invoices per country. | The MoR issues them. |

This trades a slice of margin for the removal of a multi-jurisdiction tax-compliance
liability — the right trade for a solo/small founder, and consistent with the analysis
recommendation ([analysis §5](../analysis/managed-inference-business-model-2026-06-03.md))
that an MoR be adopted **from day one** of managed mode.

> **Why not Stripe alone?** Stripe is a **payment processor**, not a merchant-of-record:
> it moves money but does **not** become the seller-of-record and does **not** assume the
> tax-registration/remittance liability. Stripe Tax helps with *calculation* but leaves
> Relavium as the seller still responsible for registering and remitting. An MoR
> (Paddle / Lemon Squeezy) takes on the seller role itself, which is why the MoR is the
> **primary billing rail** here. The MoR is the **seller-of-record rail**; Relavium's
> internal `usage_events` ledger ([ADR-0014](../decisions/0014-managed-metering-quota-and-billing.md))
> only **meters** consumption and **feeds invoicing through** that rail. A direct Stripe
> integration is the **non-MoR alternative** rail, used only if not going through an MoR —
> the two are **mutually exclusive** and are never layered together.

## Refunds and chargebacks

- **Prepaid credits make refunds bounded and clean.** Managed mode sells **prepaid
  credits with a hard included-usage cap**
  ([ADR-0012](../decisions/0012-managed-inference-dual-mode.md),
  [ADR-0014](../decisions/0014-managed-metering-quota-and-billing.md)): revenue precedes
  COGS, so a refund returns *unspent* credit rather than money already burned on provider
  tokens.
- **Chargebacks route through the MoR** as seller-of-record, removing Relavium from the
  card-network dispute process.
- **A clear refund policy** must be published and consistent with the MoR's terms and the
  [AUP](security-and-soc2.md) — heavy provider-cost consumption followed by a chargeback is
  also an **abuse vector** (a customer can burn real provider tokens, then reverse the
  charge), so refund/chargeback handling and abuse controls are linked.
- **The cautionary precedent** ([analysis §2](../analysis/managed-inference-business-model-2026-06-03.md)):
  silently devaluing an opaque quota triggers public refunds and reputational damage
  (Cursor, June 2025). Dollar-denominated, learnable pricing and an honest refund policy
  are the mitigation.

## Gate summary

Tax-and-billing is **launch-blocking for managed mode** and tracked in the
[compliance gate status table](README.md#gate-status). It is **cleared** when an MoR
(Paddle / Lemon Squeezy) is integrated as seller-of-record for managed billing, a refund
policy is published, and chargeback handling routes through the MoR. **BYOK-local ships
without any of it.**
