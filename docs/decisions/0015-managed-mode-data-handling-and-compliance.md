# ADR-0015: Managed-mode data handling and compliance posture

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [0012-managed-inference-dual-mode.md](0012-managed-inference-dual-mode.md), [0013-managed-key-vault-and-pools.md](0013-managed-key-vault-and-pools.md), [0014-managed-metering-quota-and-billing.md](0014-managed-metering-quota-and-billing.md), [0006-os-keychain-for-api-keys.md](0006-os-keychain-for-api-keys.md), [0008-local-first-phase-1-cloud-phase-2.md](0008-local-first-phase-1-cloud-phase-2.md), [../analysis/managed-inference-business-model-2026-06-03.md](../analysis/managed-inference-business-model-2026-06-03.md), [../tech-stack.md](../tech-stack.md)

## Context

Relavium's privacy story is built on local-first: in BYOK-local mode no data and no keys leave the user's machine ([ADR-0008](0008-local-first-phase-1-cloud-phase-2.md), [ADR-0006](0006-os-keychain-for-api-keys.md)), and transcripts are never persisted off-device. Managed mode ([ADR-0012](0012-managed-inference-dual-mode.md)) changes the data path: prompts and completions now **transit Relavium's gateway** on their way to the provider, and the moment Relavium both bills and sits in the data path an entire compliance surface appears that does not exist for BYOK at all. The [business-model analysis](../analysis/managed-inference-business-model-2026-06-03.md) flags the casualty directly: of the UVP proof points, the one at risk is "zero data leaves the machine" — privacy must be reframed from a single headline into a **first-class, mode-scoped guarantee** kept permanently non-degraded for BYOK.

The founder is Turkey-based, so cross-border transfer and data residency are first-order (KVKK + GDPR), and a trust or logging incident on a privacy-built brand is an existential risk (analysis risk R4), not a cosmetic one.

## Decision

**In managed mode, prompts and completions transit the gateway but are NOT persisted or logged by default — Relavium meters token counts, not content. The "transcripts are never persisted off-device" guarantee is restated, scoped: it holds absolutely for BYOK-local, and in managed mode the gateway proxies content without storing it. Managed mode launches only behind a defined compliance posture, including the R1 provider-ToS gate.**

- **No prompt logging by default.** The gateway meters **token counts**, not prompt or completion **content**. Metering ([ADR-0014](0014-managed-metering-quota-and-billing.md)) records `request_id`, model, token counts, `provider_cost`, and `billed_cost` — never the message bodies. Content transits the gateway in flight to the provider and is **not written to logs or storage**. This is the on-by-default guardrail named in [ADR-0012](0012-managed-inference-dual-mode.md), not an opt-in setting.
- **Transcripts-never-persisted, scoped.** The guarantee is reaffirmed and made mode-aware: **BYOK-local** keeps the absolute "nothing leaves the machine" promise unchanged; **managed** mode does not persist transcripts either — the gateway is a pass-through, not a store. BYOK stays the answer for anyone who will not accept content transiting Relavium's path at all ("here's the door — same product, your key").
- **Merchant-of-record.** A merchant-of-record (e.g. Paddle / Lemon Squeezy) fronts billing to absorb VAT/sales-tax across jurisdictions and chargebacks/disputes, rather than Relavium registering for tax in every jurisdiction. (Hard gate for [ADR-0014](0014-managed-metering-quota-and-billing.md) billing.)
- **DPA + providers as sub-processors.** Managed mode requires a Data Processing Agreement with customers and a **published sub-processor list** — each LLM provider becomes a Relavium sub-processor the moment content transits Relavium to them. Use only provider tiers with no-training/DPA terms (per the analysis: paid Vertex/enterprise tiers, not consumer keys; DeepSeek excluded from EU/regulated data).
- **KVKK + GDPR + data residency.** Cross-border transfer mechanisms and a documented data-residency posture are required given the Turkey-based operator and EU users.
- **SOC 2 trajectory for enterprise.** SOC 2 (Type II) is the enterprise unlock and is on the roadmap for managed/enterprise; not a launch blocker for the first managed users, but the controls (audit logging, access control, the [ADR-0013](0013-managed-key-vault-and-pools.md) vault) are built toward it.
- **AUP + abuse liability.** Managed traffic runs under **Relavium's** provider account, so an abuser's content can trigger a provider key-ban that takes down *all* managed users (analysis risk R3). An Acceptable Use Policy, abuse detection, per-account caps, and a kill switch are required; keys are segmented and rotatable per [ADR-0013](0013-managed-key-vault-and-pools.md).
- **R1 provider-ToS gate (go/no-go).** Managed mode is **not built or shipped** until, per provider, there is written ToS confirmation or the appropriate commercial/partner agreement that Relavium-holds-the-key, customer-consumes-metered-usage, Relavium-keeps-margin is permitted. Getting this wrong at scale is account termination, not a fine.

Considered options:

1. **Log prompts for debugging/quality** — *rejected.* Logging content on a privacy-built brand is the highest-likelihood trust-failure vector (analysis R4); counts-not-content is the default, and any future opt-in content capture would be a separate, explicit, consented ADR.
2. **Ship managed first, sort compliance later** — *rejected.* Provider ToS, DPA/sub-processors, tax, and data residency become liabilities the instant the first managed user pays; R1 and the merchant-of-record are hard gates, not follow-ups.
3. **Pass-through gateway, counts-not-content, mode-scoped privacy, full compliance posture gated by R1** — *chosen.* Preserves the BYOK privacy guarantee absolutely, keeps managed honest about its data path, and front-loads the compliance work managed actually requires.

This does not change BYOK-local or the engine; it defines the trust contract for the **new** managed path only. Pinned versions live in [tech-stack.md](../tech-stack.md); the detailed data-flow, DPA/sub-processor list, and incident-response runbooks are referenced from the managed-inference architecture and compliance docs.

## Consequences

### Positive

- The privacy promise survives, scoped and honest: BYOK-local keeps "nothing leaves the machine" unchanged, and managed is a content-pass-through that meters counts-not-content — no silent erosion of the brand's trust foundation.
- Counts-not-content by default removes the single highest-likelihood trust-failure vector (R4) and keeps the metering subsystem ([ADR-0014](0014-managed-metering-quota-and-billing.md)) free of sensitive content.
- The compliance surface (merchant-of-record, DPA + sub-processors, KVKK/GDPR + residency, AUP/abuse controls) is named and gated up front, so managed cannot ship into a legal/tax/trust liability.
- The R1 provider-ToS gate prevents the worst outcome — building a business a provider can terminate at scale — before any engineering spend.
- BYOK remains the absolute-privacy and enterprise door, reinforcing the dual-mode trust proof of [ADR-0012](0012-managed-inference-dual-mode.md).

### Negative

- Counts-not-content limits Relavium's ability to debug quality issues or fully introspect billing disputes from content; an accepted trade-off, with any future consented content capture requiring a separate ADR.
- The compliance posture (merchant-of-record, DPAs, residency, SOC 2 trajectory, AUP) is real, ongoing cost and likely needs privacy/legal counsel; it is the price of admission for managed and is a launch blocker, not optional.
- Abuse under Relavium's provider account carries account-suspension risk for all managed users (R3); mitigated by AUP, abuse detection, per-account caps, a kill switch, and key segmentation/rotation ([ADR-0013](0013-managed-key-vault-and-pools.md)), but never fully eliminated.
- Provider-tier restrictions (no-training/DPA tiers only; DeepSeek excluded from EU/regulated data) constrain managed-mode model availability versus what a BYOK user may freely choose.
