# Managed-Inference Business Model — Decision Analysis

> Status: analysis (decision pending) · Date: 2026-06-03

A founder-requested deep analysis of whether Relavium should move from the
currently-documented **BYOK + local-first** model to a **managed-inference** model
— Relavium uses its *own* provider API keys and sells metered model usage by
license tier (the worked example: a ~$20/mo plan includes ~$15 of usage; the rest
is margin). Synthesized from five parallel research streams (provider ToS/legality,
competitive precedents, unit economics, gateway architecture, strategy/compliance).
This document records the findings and the recommendation; **no product docs have
been changed yet** — that follows the decision.

## TL;DR

- The founder's **architectural** instinct is correct and cheap: managed inference
  is a new `ManagedGatewayProvider` behind the *same* `LLMProvider` seam — the
  engine (`@relavium/core`) does not change. It is a **third execution mode**
  (`managed`), distinct from the BYOK-cloud already in the docs.
- The founder's **commercial** instinct ("$20 includes $15, flat, keep $5") is
  **not viable as stated**: real gross margin is **11–18%** (after Stripe + infra),
  and a flat uncapped plan **loses money on heavy users** (one whale = −$367 on a
  $20 payment). Token COGS at ~75% of price is a low-margin reseller business, not
  software.
- The single highest-leverage fix is a **hard included-usage cap** — it moves the
  base case from **13% → 71%** gross margin. Prepaid credits, per-day budgets, and
  cheap-default model routing are the other non-negotiable guardrails.
- **BYOK is the better core business** (~90%+ gross, break-even ~32 users, zero
  token risk) and is also the natural **pressure valve** for heavy users + the
  **trust proof** + the **enterprise** path.
- **Recommendation: dual-mode** — keep BYOK-local first-class; add managed inference
  as an **opt-in convenience mode** (a thin gateway; the engine stays local, only
  LLM egress is proxied), shipped as the **first Phase-2 deliverable** ("Option B").
  Price it as **prepaid credits + hard cap + metered overage + a real markup**, not
  a flat $20-for-$15.
- Two hard gates before building: **(R1)** written confirmation from each provider
  that this is permitted, and **a merchant-of-record** for VAT/sales-tax/chargebacks.

---

## 1. Legality — can we resell/proxy provider access on our own keys?

The decisive line, true for all four providers: **"build a product on top of the
API for your own end users" is permitted** (the normal SaaS case); **"resell raw
API/token access as a commodity" is restricted or prohibited** without a specific
agreement. Relavium is a product (orchestration), so it leans to the allowed side —
*if positioned and operated as a product*, not a cheap-token reseller.

| Provider | Position | Action for Relavium |
|----------|----------|---------------------|
| **Anthropic** | Building for your own users is expressly allowed; **reselling needs express Anthropic approval**; consumer (Pro/Max) plans may **not** back a service. | Use API-key (org) auth; pursue a commercial/enterprise agreement at scale; never market as "reselling". |
| **OpenAI** | Explicit: **"may not resell or lease access to its Account or any End User Account."** Building a product for your users is fine, with moderation/disclosure duties. | Standard product use OK; **Scale Tier / enterprise** for volume; never raw resale. |
| **Google (Gemini)** | Has an **official Partner/Reseller program** (clean contractual path). Consumer "AI Studio" key is "not for consumer use"; unpaid tier trains on data. | Build on **Vertex AI / Gemini Enterprise, paid tier** (DPA, no training); enroll in the reseller program to actually resell. |
| **DeepSeek** | ToS is permissive on reselling, **but** data routes to China, **trains on inputs by default**, no SOC2/HIPAA, GDPR contested. | Treat as **opt-in, disclosed, non-China-hosted** (open weights on a Western host) for anything sensitive; exclude from EU/regulated data. |

**Gate R1 (go/no-go):** before building the gateway, get written confirmation /
the appropriate commercial or partner agreement from **each** provider that
"Relavium holds the key, customers consume metered usage under Relavium's account,
Relavium keeps margin" is permitted. Getting this wrong at scale = account
termination, not a fine.

## 2. Competitive precedent — how others do it

Two archetypes:
- **Zero-markup gateway** (OpenRouter, Vercel AI Gateway, Portkey, Helicone) —
  pass provider list price through; monetize on credit-load fees (OpenRouter
  5.5%+$0.80), BYOK surcharge (OpenRouter 5% after 1M req), platform/observability
  subscriptions ($49–$79/mo), float. Transparency is the brand.
- **Bundled-quota subscription** (Cursor, GitHub Copilot, Poe, Perplexity,
  Claude/ChatGPT) — **this is Relavium's intended model.**

The durable margin engine in the bundled model is **not** "include $15, charge $20."
It is: **a cheap, unlimited default lane** (Cursor *Auto*, Copilot completions, Poe
low-point models) that absorbs the bulk of usage cheaply + **a metered credit pool**
gating expensive frontier models + **overage at cost** + **BYOK as the escape
hatch**. Cautionary tales: Cursor's June-2025 quota change → public apology +
refunds; Copilot's "less for the same price" backlash. Lesson: never silently
devalue an opaque quota; dollar-denominated, learnable pricing earns trust.

Typical AI-app gross margins now cluster **50–65%**, below the 80–90% SaaS ceiling.

## 3. Unit economics — the numbers (base case: 1,000 paying users)

- **The "$5 margin" is fiction.** From $20: −$15 tokens −$0.88 Stripe −$0.50–2.00
  infra = **$2.12–$3.62 real gross (11–18%)**. Token COGS ≈ 75% of price → a
  low-margin, capital-intensive resale business.
- **Heavy-user power law.** With realistic skew, the **median user burns ~$1.23**
  of tokens while a few whales dominate. A flat **$15-included, no-cap** plan: one
  worst-case user = **−$367** on a $20 payment; light users subsidize whales; one
  demographic shift → negative gross. **Not viable.**
- **The hard cap is everything.** Capping included usage takes the base case from
  **13% → 71%** gross margin. A **per-user/day budget** ($5/day) turns a runaway
  loop from a **−$5,000** event into a **−$150** event.
- **Prepaid > post-paid.** Sell credits up front → positive float, never front
  provider cost. Post-paid lets a whale drain your provider pool in days 1–3 of a
  cycle you've collected once for.
- **Cost levers:** model routing + prompt caching ≈ **−46%** token COGS.
- **BYOK comparison (settles it):** BYOK at **$10/mo** ≈ **93% gross**, break-even
  **32 users**, **zero token risk** → produces **more** gross profit ($9,010) than
  managed-capped at $20 ($8,820), at half the price. Managed only *wins* when it
  (a) captures provider price deflation, (b) enables 24/7 cloud execution, (c)
  widens the funnel by removing key setup.

**Viable commercial shape:** prepaid credits + hard included-usage cap + metered
overage at cost×~1.3 + cheap-default routing; **price for a real markup**, not a
$20-for-$15 pass-through.

## 4. Architecture — how managed inference fits (engine unchanged)

- Managed = a new `ManagedGatewayProvider` behind the **same immovable
  `LLMProvider` seam** ([ADR-0011](../decisions/0011-internal-llm-abstraction.md)).
  `@relavium/core` is untouched. The factory picks the implementation by
  **execution mode**, extending `'local' | 'cloud'` → `+ 'managed'`.
- **Three modes, clearly distinct:**

  | Mode | Whose key | Who calls provider | Metered/billed | In docs today |
  |------|-----------|--------------------|----------------|---------------|
  | `local` (BYOK) | user's, keychain | user's machine | no | yes (Phase 1) |
  | `cloud` (BYOK-cloud) | user's, server store | cloud worker | no | yes (Phase 2) |
  | **`managed`** (new) | **Relavium's** | **Relavium gateway** | **yes** | **no** |

- **Key insight for cheap phasing:** managed *inference* ≠ managed *execution*. The
  engine can keep running **locally** and just send LLM egress to
  `gateway.relavium.com`. So managed inference is a **thin proxy gateway**, not the
  heavy cloud-execution plane in [cloud-phase-2.md](../architecture/cloud-phase-2.md).
- **Hard engineering parts** (all extend existing mechanisms): streaming **usage
  capture** (force `include_usage`, estimate on interruption, nightly reconciliation
  vs provider invoices), **idempotent metering** (reserve→settle keyed on a UNIQUE
  `request_id`), **key vault (KMS) + key pools** (multi-key per provider for org
  rate limits, zero-downtime rotation, 429-cooldown + cross-provider fallback),
  quota enforcement (warn/throttle/hard-stop), Stripe billing, abuse/fraud controls,
  multi-tenant RLS, **no prompt logging by default** (meter token counts, not
  content). Each `usage_event` stores both `provider_cost` (COGS) and `billed_cost`
  (margin observable).

## 5. Strategy, positioning, compliance

- **Positioning:** of the five UVP proof points, four survive untouched (the
  git-native workflow wedge is the real moat). The casualty is #5 ("zero data leaves
  the machine"). Reframe privacy from **headline** → **first-class mode** (BYOK /
  "Private mode"), kept permanently non-degraded.
- **Dual-mode is structurally safest:** managed as the convenient default + BYOK as
  the heavy-user pressure valve, the enterprise path, and the trust proof ("don't
  trust us in the path? here's the door — same product, your key").
- **Phasing (managed can't be a no-account local Phase 1):**
  - **A** — BYOK Phase 1, managed = Phase-2 monetization (minimal change, latest revenue).
  - **B (recommended)** — BYOK Phase 1 ships unchanged; a **thin managed gateway**
    is the **first** Phase-2 deliverable, decoupled from (and ahead of) cloud
    execution. Managed revenue early, launch not bet on it, engine critical path clean.
  - **C** — cloud-first managed core (overturns [ADR-0008](../decisions/0008-local-first-phase-1-cloud-phase-2.md);
    carries COGS from user #1 before PMF; not advised for a solo/small founder).
- **Compliance surface that appears the moment you bill + sit in the data path**
  (none of this exists for BYOK-local): provider ToS (R1), **DPA + sub-processor
  list** (providers become your sub-processors), **GDPR + KVKK** (founder
  Turkey-based → cross-border transfer + data residency), **VAT/sales-tax** across
  jurisdictions (→ adopt a **merchant-of-record** like Paddle / Lemon Squeezy to
  absorb tax + chargebacks), refunds/disputes, **moderation liability** (abuse runs
  under *Relavium's* provider account → key-ban risk), **SOC 2 Type II** for
  enterprise.
- **Tier redesign required:** the documented philosophy ("gate on scale not
  capability; local free forever") is **incompatible** with metered inference and
  must be re-architected around **included managed usage + overage + BYOK-unlimited**.

## Risk register (top items)

| Risk | Severity | Mitigation |
|------|----------|-----------|
| R1 Provider ToS bars reselling | Critical | Written confirmation / commercial/partner agreement per provider **before** building (go/no-go). |
| R2 Margin erosion / adverse selection (whales) | High | Hard caps + overage + prepaid credits + model routing/caching; **BYOK as the pressure valve**. |
| R3 Provider key-ban at scale (one abuser → Relavium account suspended) | Critical | AUP + abuse detection + per-account caps + kill switch; segregate keys per provider/region; multi-provider redundancy. |
| R4 Trust failure (logging/billing incident on a privacy-built brand) | High | No-logging-by-default; transparent metering; BYOK escape hatch; SOC 2. |
| R5 Tax/DPA/GDPR-KVKK non-compliance | High | Merchant-of-record from day one; DPAs; privacy counsel; launch-blocking for managed mode. |
| R6 Commoditization (OpenRouter cheaper + transparent) | High | Don't compete as a token reseller — win on orchestration (the intact UVP); managed inference is a *convenience feature*, not the product. |
| R7 Working-capital timing | Med-High | Prepaid credits / caps so revenue precedes COGS. |

## Recommendation

**Adopt dual-mode (managed default for convenience + BYOK first-class), phased per
Option B.** Concretely:

1. Ship the documented **BYOK local-first Phase 1 unchanged** — it's the
   higher-margin core business, the trust/PR launch, and reuses all current work.
2. Add **managed inference as the first Phase-2 deliverable**: a thin gateway
   (engine stays local, only LLM egress proxied), behind the existing seam.
3. Commercial structure: **prepaid credits + hard included-usage cap + metered
   overage + cheap-default model routing**; price for a **real markup**, never flat
   $20-for-$15. Keep BYOK-unlimited as the heavy-user lane.
4. **Gates before building managed:** (R1) provider ToS confirmation per provider;
   adopt a **merchant-of-record**; DPA + KVKK/GDPR posture; no-prompt-logging default.

## If accepted — docs to change (after the decision)

New ADRs (append-only; supersede/amend, never rewrite): managed inference as a third
mode (amends framing of [ADR-0008](../decisions/0008-local-first-phase-1-cloud-phase-2.md));
Relavium master-key vault + key pools (complements [ADR-0006](../decisions/0006-os-keychain-for-api-keys.md));
managed metering/quota/Stripe billing; managed-mode data-handling & compliance
posture. Amend: [product-constraints.md](../product-constraints.md),
[vision.md](../vision.md), [uvp.md](../uvp.md) (proof point #5 → mode-scoped),
[reference/portal/api-reference.md](../reference/portal/api-reference.md) (tier
redesign), [architecture/cloud-phase-2.md](../architecture/cloud-phase-2.md) (+third
mode); new `docs/architecture/managed-inference.md` and a `docs/compliance/` section;
new runbooks (key rotation, key-pool saturation, billing reconciliation,
master-key-compromise IR). Engine and the seam *types* do **not** change.

## Sources

Provider ToS (anthropic.com/legal/commercial-terms, openai.com/policies,
ai.google.dev/gemini-api/terms + GCP partner program, deepseek ToS), competitive
pricing (OpenRouter, Vercel AI Gateway, Cursor, GitHub Copilot, Poe, Perplexity),
and AI-SaaS margin benchmarks — full URLs captured in the research transcripts for
this analysis (2026-06-03).
