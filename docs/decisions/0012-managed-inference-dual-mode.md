# ADR-0012: Dual-mode inference — managed inference as an opt-in third execution mode

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md), [0008-local-first-phase-1-cloud-phase-2.md](0008-local-first-phase-1-cloud-phase-2.md), [0006-os-keychain-for-api-keys.md](0006-os-keychain-for-api-keys.md), [0013-managed-key-vault-and-pools.md](0013-managed-key-vault-and-pools.md), [0014-managed-metering-quota-and-billing.md](0014-managed-metering-quota-and-billing.md), [0015-managed-mode-data-handling-and-compliance.md](0015-managed-mode-data-handling-and-compliance.md), [../analysis/managed-inference-business-model-2026-06-03.md](../analysis/managed-inference-business-model-2026-06-03.md), [../tech-stack.md](../tech-stack.md)

## Context

Relavium ships with **BYOK local-first** ([ADR-0008](0008-local-first-phase-1-cloud-phase-2.md)): in Phase 1 the engine runs on the user's machine and calls LLM providers directly with the user's own keys from the OS keychain ([ADR-0006](0006-os-keychain-for-api-keys.md)). That model is the higher-margin core business and the trust proof, but it imposes a setup tax (every user must obtain and paste provider keys) and leaves provider-token margin and a funnel-widening on-ramp on the table.

The founder asked whether Relavium should instead use its *own* provider keys and sell metered model usage by license tier. The full investigation — provider ToS/legality, competitive precedent, unit economics, gateway architecture, and compliance — is recorded in [the managed-inference business-model analysis](../analysis/managed-inference-business-model-2026-06-03.md). Two findings frame this decision. **Architecturally**, managed inference is cheap: it is a new provider implementation behind the *same* `LLMProvider` seam ([ADR-0011](0011-internal-llm-abstraction.md)), and managed *inference* is separable from managed *execution* (the engine can stay local and only LLM egress is proxied). **Commercially**, the naive "$20 plan includes $15 of usage, keep $5" shape is not viable: token COGS at ~75% of price yields 11–18% real gross margin and a flat uncapped plan loses money on heavy users. The single highest-leverage fix — a hard included-usage cap — moves the base case from 13% to 71% gross margin.

The stakes are high in two directions: getting the *commercial* shape wrong means reselling tokens at a loss; getting the *architectural* phasing wrong (cloud-first managed core) would overturn local-first, carry COGS from user #1 before product-market fit, and put inference on the engine's critical path.

## Decision

**Relavium adopts dual-mode inference. BYOK-local stays first-class and remains the unchanged Phase-1 default. Managed inference is added as an opt-in convenience mode — a third execution mode, `managed` — shipped as the first Phase-2 deliverable, decoupled from cloud execution.**

`executionMode` becomes the enum `local | cloud | managed`:

| Mode | Whose key | Who calls the provider | Metered/billed |
|------|-----------|------------------------|----------------|
| `local` (BYOK) | user's, OS keychain | the user's machine | no |
| `cloud` (BYOK-cloud) | user's, server-side store | cloud worker | no |
| **`managed`** (new) | **Relavium's** | **Relavium's gateway** | **yes** |

Architecturally, `managed` is a new `ManagedGatewayProvider` behind the **same immovable `LLMProvider` seam** ([ADR-0011](0011-internal-llm-abstraction.md)). The factory selects it by execution mode; **`@relavium/core` and the seam *types* do not change** — this decision validates the reversible-behind-the-seam stance ADR-0011 was designed for. Crucially, managed *inference* is not managed *execution*: the engine keeps running locally and only sends LLM egress to Relavium's gateway. So the managed deliverable is a **thin proxy gateway**, not the heavy cloud-execution plane in [cloud-phase-2.md](../architecture/cloud-phase-2.md), and it ships **ahead of and decoupled from** cloud execution.

Considered options:

1. **Managed-first** (cloud-hosted managed core as the primary model) — *rejected.* Low gross margin (11–18% before guardrails) makes it a token-resale business, not software; it overturns [ADR-0008](0008-local-first-phase-1-cloud-phase-2.md)'s local-first promise, gates first use behind an account and a server, and carries provider COGS from user #1 before product-market fit — the wrong risk profile for a small founder.
2. **BYOK-only** (never build managed) — *rejected.* BYOK is the better core business (~90%+ gross, break-even ~32 users, zero token risk), but BYOK-only leaves the key-setup funnel un-widened and forgoes provider-token margin and the convenience on-ramp that converts curious first-time users.
3. **Dual-mode** (BYOK-local first-class + managed as opt-in convenience) — *chosen.* Keeps the high-margin, zero-token-risk core and the trust/PR launch intact while capturing the convenience funnel and token margin; BYOK is also the structural pressure valve for heavy users (the unlimited lane), the enterprise path, and the trust proof ("don't trust us in the path? same product, your key").

**Commercial structure (managed mode).** Price for a **real markup**, never a flat $20-for-$15 pass-through. The shape is **prepaid credits + a hard included-usage cap + metered overage at roughly cost×1.3 + cheap-default model routing**. BYOK remains the **unlimited heavy-user lane**. The billing mechanics are in [ADR-0014](0014-managed-metering-quota-and-billing.md).

**Launch-blocker guardrails (all on by default before managed mode is exposed):** a hard included-usage cap; a per-user/day budget; prepaid credits (a positive float — revenue precedes COGS); real-time metering with an anomaly cutoff; model routing and prompt caching on by default; and **no prompt logging by default** (meter token counts, not content — see [ADR-0015](0015-managed-mode-data-handling-and-compliance.md)). The key vault and pools that hold Relavium's own provider keys are [ADR-0013](0013-managed-key-vault-and-pools.md).

**Hard go/no-go precondition (R1).** Managed mode is **not built** until there is, per provider, written ToS confirmation or the appropriate commercial/partner agreement that "Relavium holds the key, customers consume metered usage under Relavium's account, Relavium keeps margin" is permitted; plus a merchant-of-record for VAT/sales-tax/chargebacks, a DPA with a published sub-processor list, a KVKK+GDPR and data-residency posture, and a SOC 2 trajectory for enterprise. The compliance posture is [ADR-0015](0015-managed-mode-data-handling-and-compliance.md).

**This ADR amends the framing of [ADR-0008](0008-local-first-phase-1-cloud-phase-2.md), it does not overturn it.** Local-first Phase 1 is **reaffirmed** and ships unchanged; managed is purely additive — a Phase-2 opt-in mode behind the existing seam. The engine and the seam types are untouched.

## Consequences

### Positive

- Two demand lanes from one engine: BYOK keeps the ~90%+ gross core, zero token risk, and the privacy/PR launch; managed widens the funnel by removing key setup and captures provider-token margin — without forking the engine.
- The architecture is cheap and reversible: a new `ManagedGatewayProvider` behind the unchanged `LLMProvider` seam ([ADR-0011](0011-internal-llm-abstraction.md)); `@relavium/core` does not change, validating the seam's purpose.
- Phasing is low-risk: a thin managed gateway is the *first* Phase-2 deliverable but is decoupled from cloud execution, so managed revenue can arrive early while the launch is not bet on it and the engine's critical path stays clean.
- BYOK is a real structural pressure valve — the unlimited heavy-user lane, the enterprise path, and the trust proof — so managed's margin risk is bounded by an always-available escape hatch.
- Local-first ([ADR-0008](0008-local-first-phase-1-cloud-phase-2.md)) is reaffirmed, not weakened; "Private mode" stays permanently non-degraded.

### Negative

- Managed mode introduces a token-COGS business with thin gross margin; viability depends entirely on the guardrails (hard cap, per-day budget, prepaid, routing/caching). The cap is non-negotiable — without it the base case is ~13% gross and a single whale loses money. Mitigated by making every guardrail on-by-default and by keeping BYOK as the pressure valve.
- A large new operational and compliance surface appears the moment Relavium bills and sits in the data path — provider ToS, merchant-of-record, DPA/sub-processors, KVKK/GDPR, abuse liability under Relavium's provider account. This is gated behind the R1 go/no-go precondition and detailed across [ADR-0013](0013-managed-key-vault-and-pools.md), [ADR-0014](0014-managed-metering-quota-and-billing.md), and [ADR-0015](0015-managed-mode-data-handling-and-compliance.md).
- The documented tier philosophy ("gate on scale, not capability; local free forever") must be re-architected around included managed usage + overage + BYOK-unlimited; that is downstream product work, not part of this ADR.
- A third execution mode is more surface area to build, test, and support; accepted because it reuses the existing seam and engine and adds no vendor type or framework.
