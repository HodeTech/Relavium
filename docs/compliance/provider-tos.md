# Provider ToS and the Reselling Gate (R1)

- **Status**: Not started — hard go/no-go precondition for managed mode
- **Phase**: Managed inference (Phase 2) only — **does not apply to BYOK-local**
- **Related**: [ADR-0012](../decisions/0012-managed-inference-dual-mode.md), [ADR-0015](../decisions/0015-managed-mode-data-handling-and-compliance.md), [data-protection.md](data-protection.md), [analysis §1](../analysis/managed-inference-business-model-2026-06-03.md)

> **Phase 2 (managed).** This gate exists only because managed mode uses **Relavium's
> own** provider keys and sells metered usage. In BYOK-local the user holds the key and
> calls the provider directly; there is no reselling question and **this file does not
> apply**.

This is the **R1 go/no-go gate** and the single most important file in
[compliance/](README.md). **Managed mode is not built until R1 is cleared, per
provider.** Getting this wrong at scale is account termination, not a fine — one
ToS-violating arrangement can get Relavium's provider account suspended, taking every
managed customer offline at once.

## The decisive line — allowed vs restricted

The same distinction is true for all four providers:

| | Allowed | Restricted / prohibited |
|---|---|---|
| What | **Build a product on top of the API for your own end users** (the normal SaaS case — orchestration, an app, a workflow tool). | **Resell raw API/token access as a commodity** — pass-through metered tokens with no product wrapped around them. |
| Why Relavium can lean to the allowed side | Relavium **is** a product: a git-native multi-agent orchestration tool. Managed inference is a *convenience feature* of that product, not the product itself. | If Relavium positioned and operated as a cheap-token reseller, it crosses the line — **so it must not be marketed or operated that way.** |

Managed mode leans to the allowed side **only if positioned and operated as a product,
not a token reseller** (this is also the [ADR-0012](../decisions/0012-managed-inference-dual-mode.md)
strategy — managed is a convenience lane, BYOK is the unlimited lane, orchestration is
the moat). But "leans allowed" is **not** a substitute for written confirmation. R1
requires the paper, per provider, **before** building.

## R1 — the go/no-go gate

> **R1.** Managed mode is **not built** until, for **each** provider Relavium intends to
> proxy, there is **written confirmation or the appropriate commercial/partner
> agreement** that the arrangement *"Relavium holds the key, customers consume metered
> usage under Relavium's account, Relavium keeps the margin"* is **permitted**.

- R1 is **per provider**: clearing it for one provider does not clear it for another.
- R1 is **launch-blocking** for managed mode and is tracked in the
  [compliance gate status table](README.md#gate-status).
- A provider that cannot be cleared is **excluded from managed mode** — it stays
  BYOK-only (the user brings their own key), which is always permitted.

## Per-provider status

> Status below is **the obligation**, not evidence of an agreement. Every row is **not
> started**. None of these arrangements exists yet; this records what each provider
> requires and the action Relavium must take.

| Provider | Reselling / ToS position | Line | Action for managed mode | R1 status |
|----------|--------------------------|------|-------------------------|-----------|
| **Anthropic** | Building **for your own users** is expressly allowed. **Reselling requires express Anthropic approval.** Consumer Pro/Max plans may **not** back a service. | Allowed as a product on API-key (org) auth; reselling needs the paper. | Use API-key (organization) auth, **never** consumer plans. Pursue a commercial/enterprise agreement at scale. **Never market as "reselling".** Get written confirmation before building. | Not started |
| **OpenAI** | Explicit prohibition: *"may not resell or lease access to its Account or any End User Account."* Building a product for your users is fine, with **moderation and disclosure duties**. | Product use OK; **account/token resale banned**. | Standard product use; move volume onto **Scale Tier / enterprise**. **Never** raw resale of account access. Meet the moderation/disclosure obligations (see [security-and-soc2.md](security-and-soc2.md)). | Not started |
| **Google (Gemini)** | Has an **official Partner / Reseller program** — a clean contractual path. The consumer "AI Studio" key is *not for consumer use*; the unpaid tier **trains on data**. | Cleanest path of the four — there is a sanctioned way to resell. | Build on **Vertex AI / Gemini Enterprise, paid tier** (DPA, no training on data). **Enroll in the Partner/Reseller program** to actually resell. Never ship on the unpaid AI Studio tier. | Not started |
| **DeepSeek** | ToS is **permissive** on reselling — **but** data routes to **China**, the service **trains on inputs by default**, there is **no SOC 2 / HIPAA**, and GDPR coverage is contested. | Reselling allowed, **but the data-handling profile is the blocker**, not the ToS. | Treat as **opt-in, disclosed, non-China-hosted** (open weights on a Western host) for anything sensitive. **Exclude from EU / regulated data.** Disclose clearly to the user. See [data-protection.md](data-protection.md). | Not started |

## What each clearance must produce

For R1 to be considered **cleared** for a provider, Relavium must hold, in writing:

1. **A reselling/usage confirmation** — express approval (Anthropic), the right account
   tier (OpenAI Scale/enterprise), or enrollment in the sanctioned program (Google
   Partner/Reseller). For DeepSeek, the ToS is already permissive but the
   [data-protection](data-protection.md) constraints (opt-in, non-China-host, no EU/
   regulated data) substitute as the gate.
2. **A DPA from the provider** naming Relavium's processing relationship — the provider
   becomes Relavium's **sub-processor**. This provider DPA is a **data-protection gate
   artifact owned by [data-protection.md](data-protection.md)** (which maintains the DPA +
   sub-processor list); R1 clearance **depends on** it rather than producing it. The
   provider must appear on Relavium's published sub-processor list.
3. **The correct account/auth tier** — organization API-key auth, never a consumer plan
   (Anthropic Pro/Max, Google AI Studio consumer key, etc.).

## How this connects to the other gates

- The provider becoming a **sub-processor** is the hinge into
  [data-protection.md](data-protection.md) (DPA + sub-processor list + cross-border
  transfer).
- Abuse running under **Relavium's** provider account is the **key-ban risk** in
  [security-and-soc2.md](security-and-soc2.md) — it is why managed mode needs an AUP,
  abuse controls, and a kill switch. A provider can terminate the account for a customer's
  abuse, so R1 clearance must be protected by those controls.
- The whole gate is launch-blocking per
  [ADR-0012's R1 precondition](../decisions/0012-managed-inference-dual-mode.md) and
  [ADR-0015](../decisions/0015-managed-mode-data-handling-and-compliance.md).
