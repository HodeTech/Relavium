# ADR-0065: Provider economics and extensibility — user-supplied pricing, the cost-path pricing-injection seam, pricing-reference capture, and custom OpenAI-compatible endpoints

- **Status**: Accepted
- **Date**: 2026-07-05
- **Related**: [ADR-0064](0064-live-model-catalog.md) (**this ADR extends its static/live merge with a USER tier**; append-only top-note added there) · [ADR-0011](0011-internal-llm-abstraction.md) (**this ADR amends the provider model — a `kind` protocol abstraction + building the adapter from the stored row; the id enum stays CLOSED**; append-only top-note added there) · [ADR-0028](0028-workflow-resource-governance.md) (the pre-egress budget governor whose "cost cap will not apply" gap this closes) · [ADR-0038](0038-agentrunner-llm-call-boundary.md) (host-injected resolution — the pricing overlay is injected exactly like `keyFor`) · [ADR-0006](0006-os-keychain-for-api-keys.md) + [ADR-0019](0019-cli-node-keychain-library.md) (keys stay in the keychain — user pricing is a **non-secret** storage class) · [ADR-0053](0053-mcp-network-transport-egress-security.md) + [ADR-0029](0029-tool-policy-hardening.md) (the one shared SSRF primitive a custom `base_url` reuses) · [ADR-0050](0050-cli-history-db-at-rest-posture.md) · [ADR-0056](0056-cli-in-app-slash-command-system-and-manifest.md) (the `models pricing` / `provider list --verify` commands). Canonical homes: the cost path → [cost-tracker.ts](../../packages/llm/src/cost-tracker.ts) + [budget-governor.ts](../../packages/core/src/engine/budget-governor.ts); the static registry → [pricing.ts](../../packages/llm/src/pricing.ts); the DB columns → [database-schema.md](../reference/desktop/database-schema.md); the commands → [commands.md](../reference/cli/commands.md).

> **Amended 2026-07-13 — the user-pricing PRECEDENCE is narrowed by
> [ADR-0071](0071-models-dev-as-the-model-metadata-source.md); the rest of this ADR stands.**
>
> §2 sets the rule as *"static `MODEL_PRICING` wins for known canonical ids; the overlay fills unknown ids only —
> a user cannot **silently** misprice a shipped model."* ADR-0071 retires that table and replaces it with a
> generated catalog covering ~97 models instead of 12 — which would have turned the rule into a trap: a user
> prices an id the table did not know, the catalog later **learns** that id, and their explicit override is
> silently taken over by a public list price.
>
> **The precedence becomes `user` > `catalog`.** The justification comes from *this* ADR: it introduced custom
> **`base_url`** endpoints (OpenRouter, Azure, LiteLLM, enterprise gateways), on which the public list price is
> simply **wrong** — the user's negotiated or marked-up rate is the correct one. A rule that lets a public
> catalog override a rate the user deliberately typed would misprice precisely the users who took the trouble to
> be accurate.
>
> This ADR's *actual* intent — **not `silently`** — is preserved, not reversed: a user override that disagrees
> with the catalog is surfaced in the model picker, in `/cost`, and at `models pricing` time. The user gets what
> they asked for; they simply cannot do it in silence. The Related line's *"the static registry →
> [pricing.ts](../../packages/llm/src/pricing.ts)"* pointer moves to the generated snapshot (rule 8).


> **Amendment (2026-07-13, [ADR-0071](0071-models-dev-as-the-model-metadata-source.md) §1).** §2's precedence is
> **REVERSED**: it is now **user → catalog → throw**, not static-first.
>
> The old rule — "the static registry always wins; the overlay fills an unknown id only" — protected the user from
> mispricing a model *we* had verified by hand. That protection made sense while the table was ours. It is not ours
> any more: the catalog is generated from models.dev, a third-party aggregator, and by the time the hand-typed
> table was retired it had silently drifted from that catalog on two numbers. The user has a negotiated rate, an
> enterprise discount, or simply a price our snapshot has not caught up with — and they are the one holding the
> invoice. `models pricing` therefore no longer REFUSES a model the catalog already knows; overriding one is the
> point of the command.


## Context

Two latent defects, surfaced while scoping 2.5.G, frame this decision:

1. **`provider add --base-url` is dead config.** It validates HTTPS and stores `base_url` in `llm_providers`,
   and `provider list` echoes it — but **no adapter ever reads it**. `createProviderResolver`
   ([providers.ts](../../apps/cli/src/engine/providers.ts) L186) is never handed the `ProviderStore`; it always
   builds the keyless `defaultProviders()` ([providers.ts](../../packages/llm/src/providers.ts) L14) with the
   **default** endpoints. A user who sets a custom endpoint today **silently gets the default** — and only the
   OpenAI adapter even accepts a `baseURL` at all (Anthropic/Gemini factories have none).

2. **An unpriced model silently disables the cost cap.** `priceModel` ([cost-tracker.ts](../../packages/llm/src/cost-tracker.ts) L19)
   **throws `UnknownModelError`** for any id absent from the static `MODEL_PRICING`; `BudgetGovernor.evaluatePreEgress`
   ([budget-governor.ts](../../packages/core/src/engine/budget-governor.ts) L141–149) **catches it and returns
   `{kind:'allow'}`**. So a model with no static price runs **uncapped** — the `max_cost_microcents` governor
   ([ADR-0028](0028-workflow-resource-governance.md)) silently no-ops. This is the exact "cost cap will not
   apply" gap.

The maintainer requires the model-**selection** and model-**pricing** story to be **clean and complete with no
follow-up debt** — including capturing, at provider-add time, a **pricing reference** and **user-supplied
per-model pricing** so cost governance works for models absent from the static registry. This is a distinct
decision from [ADR-0064](0064-live-model-catalog.md)'s "fetch a live list for the known providers": it centers
on `apps/cli` (the provider-add UX), `@relavium/db` (user-pricing storage), and — the sharp edge —
`@relavium/core`/`@relavium/llm` **cost-path signatures**; it has its own security surface (custom-`base_url`
SSRF + user-input validation); and it opens the **data** layer while keeping the **id enum** closed. It earns
its own ADR rather than swelling ADR-0064.

## Decision

**We make user-supplied per-model pricing a first-class non-secret storage class, inject the merged
static/user pricing into the cost path so a user-priced model is actually capped, rewire `resolveProvider` to
build the adapter from the stored provider row (fixing the dead-`base_url` bug and enabling custom
OpenAI-compatible endpoints over the SSRF floor), and capture a pricing-reference URL + user pricing at
provider-add — keeping the `ProviderId` enum closed.**

### 1. User-supplied pricing — a non-secret storage class in `model_catalog`

The `model_catalog` cost columns (`input`/`output`/`cached` microcents) **already exist**
([schema.ts](../../packages/db/src/schema.ts) L106) but are unsettable. We widen `ModelCatalogUpsert`
([model-catalog-store.ts](../../packages/db/src/model-catalog-store.ts) L51) to write them under
**`source = 'user'`** (the [ADR-0064](0064-live-model-catalog.md) §4 discriminant), so a background refresh
**never clobbers** a hand-entered row and the merge can rank precedence. Money is **integer microcents**
(`usd()` = `round(usd × 1e8)`, [pricing.ts](../../packages/llm/src/pricing.ts) L60) — no float persists; the
capture surface takes **USD/MTok** and converts at the boundary, echoing the resolved rate back. A new
`relavium models pricing` subcommand (under the [ADR-0064](0064-live-model-catalog.md) §10 `models` family; its
flags are the canonical [commands.md](../reference/cli/commands.md)'s, not restated here) writes it;
the onboarding wizard also captures it when the chosen model lacks a static price. Numeric input is
**bounds-validated** at the CLI boundary (reject negative / `NaN` / magnitudes that would break microcent math).
User pricing is **non-secret** config/data — it lives in the DB in plaintext, **never** the keychain.

### 2. The cost-path pricing-injection seam — closing the "cap will not apply" gap

This is the load-bearing change. We add an **optional pricing overlay** — a Relavium-typed
`ReadonlyMap<string, ModelPricing>` (a `resolvePrice` resolver) — and thread it through **both** cost paths:
`CostTracker` (its constructor + `cost`/`priceModel`) **and** the pre-egress estimators
(`estimateMaxNextCost`/`estimateMediaCost`) **and** the `BudgetGovernor`. Precedence: **static `MODEL_PRICING`
wins for known canonical ids; the overlay fills unknown ids only** — a user cannot silently misprice a shipped
model (matching [ADR-0064](0064-live-model-catalog.md)'s static-wins), and the same slot can also carry a
live-catalog entry for a newly-released official model. (Considered a **separate** user-pricing lookup distinct
from the static path — rejected: it would double the lookup and let realized vs pre-egress cost diverge; one
overlay through `priceModel` keeps them in lockstep. Considered mutating `MODEL_PRICING` or injecting the overlay
**unconditionally** — rejected: an **optional** overlay leaves the default path and every existing cost test
unchanged, and keeps static authoritative for known ids.) `priceModel` consults **static → overlay → then throws**,
preserving the deliberate **never-silent-zero** invariant (1.B): a *truly* unknown id (neither static nor user)
still throws, and cost governance still degrades to `allow` **with a loud, visible "cost cap will not apply"
notice** rather than a silent no-op.

The **host** builds the overlay from **only** the `model_catalog` `source='user'` rows (a live/static cache
row's `NOT NULL DEFAULT 0` cost column is **never** read as a price — pricing authority is static per
[ADR-0064](0064-live-model-catalog.md) §6) and **injects** it — `@relavium/llm` and
`@relavium/core` never import `@relavium/db`; the overlay arrives as plain Relavium data, **byte-identical to
how `keyFor` injects the key** ([ADR-0038](0038-agentrunner-llm-call-boundary.md)). It threads
`SessionDeps → AgentSession → AgentTurnParams → new CostTracker(overlay)` **and** directly into the
`BudgetGovernor`, covering **both** the realized-cost and pre-egress paths — wiring only one would make the cap
and the ledger disagree (a governor that blocks on a price the ledger never charges, or the reverse). This is a
deliberate `core`+`llm` **seam-signature change**; under-scoping it (storing the row but not injecting it) would
leave the gap open — the exact follow-up debt the maintainer forbids.

### 3. `resolveProvider` host-rewiring — make the stored `base_url` live (fixes bug #1)

We upgrade `createProviderResolver` to accept the `ProviderStore` and, for a provider whose stored row carries
a **custom `base_url`**, build a **per-provider** adapter from `{kind, base_url}` rather than the static
`defaultProviders()` map — initially the **`openai-compatible`** kind
(`createOpenAiAdapter({providerId, baseURL})` + its construction-time `assertHttpsBaseUrl` gate). A stored
`base_url` is no longer dead config. The **Anthropic/Gemini** factories gain a validated `baseURL` option
**only** if a custom endpoint for those kinds is in this round's scope; otherwise custom endpoints are honestly
**`openai-compatible`-only**, documented — a `base_url` under `kind = anthropic|gemini` is refused with a clear
message rather than silently ignored (the current bug).

### 4. Custom OpenAI-compatible endpoints + the SSRF floor

A user registers a custom endpoint by pointing an **existing** provider id (`openai`/`deepseek`) at a custom
**HTTPS** `base_url` with `kind = openai-compatible`. `listModels`/`generate` over that custom endpoint is an
egress/SSRF surface and **must** reuse the shared HTTPS + private-range gate: `assertHttpsBaseUrl` +
`isPrivateOrLocalHost` at construction, and — for full **DNS-rebinding** protection — the host routes the
custom-endpoint hop through **`connectValidated`** ([safe-egress.ts](../../packages/db/src/safe-egress.ts), the
one shared connect-by-validated-IP primitive — [ADR-0053](0053-mcp-network-transport-egress-security.md),
[ADR-0029](0029-tool-policy-hardening.md)(d)), **never a second URL parser**. A custom `base_url` resolving to a
private/loopback/metadata address is **refused**. The known-provider fixed-host path
([ADR-0064](0064-live-model-catalog.md) §9) is unchanged — this hardening is scoped to the custom endpoint.

### 5. Pricing-reference capture + the `kind` column

`provider add` gains an optional **`--pricing-url`** (a non-secret, **display-only** URL where prices are looked
up), validated HTTPS at capture via `requireHttpsUrl` and stored in a **new `llm_providers.pricing_reference_url`
column** — **not** `default_headers` (that JSON is destined to be sent as wire headers once §3 wires the stored
row to the adapter — today it is dead config like `base_url`; stuffing a URL there would leak onto the wire once
live, a category error). It is **never auto-fetched** (no egress). The four known providers' pricing pages
**pre-populate** from a new `pricingUrl` field added to `KNOWN_PROVIDERS` (the pages `pricing.ts` already cites),
so the picker and `provider list` can **show where to look up prices without asking**. A **`kind` column** is added to
`llm_providers` too (nullable, populated for uniformity, load-bearing only for custom providers). These
`llm_providers` columns (`pricing_reference_url`, `kind`) ride their **own** additive migration (`0008`),
separate from [ADR-0064](0064-live-model-catalog.md)'s `model_catalog` `0007` — they land in the
provider-extensibility step, after the catalog cache. Both columns' one canonical home is
[database-schema.md](../reference/desktop/database-schema.md).

### 6. The id enum stays CLOSED; `provider list --verify`

`ProviderId` stays the closed `z.enum(LLM_PROVIDERS)` ([ADR-0064](0064-live-model-catalog.md) §6). A user-added
provider is **`(existing id + kind + custom base_url + keychain key + user pricing)`**; its models are unknown
ids priced solely from user rows (§2). A **truly-custom** provider id (a new, arbitrary id) would open the
closed enum — touching the **persisted** run-event `provider` field, authored agent YAML, and the exhaustive
`Record<ProviderId, LlmProvider>` — a deliberate future **supersede** of
[ADR-0011](0011-internal-llm-abstraction.md)'s closed-set posture. (Considered opening the enum **this round** —
rejected: that cross-package + persisted-contract churn is disproportionate to 2.5.G, and the `kind` data-layer
delivers custom endpoints without it.) It is **honestly named as future work, not this round**. `provider list` gains an **opt-in `--verify`** (reusing `validateProviderKey`'s bounded + redacted
probe) that reports per-provider verification state (the maintainer's decision) without hanging or leaking a key. One
honest limitation is documented: a custom OpenAI-compatible endpoint **reuses** the `openai`/`deepseek` id and
therefore cannot coexist with the real provider under that id — a genuinely-separate custom id awaits the
enum-opening ADR.

## Consequences

### Positive

- **The cost-cap gap is closed** — a model absent from the static registry, once user-priced, is enforced by
  `max_cost_microcents` on **both** the pre-egress and realized paths; a *truly* unknown model degrades to
  uncapped **loudly and visibly**, never silently.
- **The dead-`base_url` bug is fixed** — a stored custom endpoint is now actually used; custom OpenAI-compatible
  endpoints work end-to-end, SSRF-validated through the one shared primitive.
- **The pricing story is complete, with no follow-up debt** — capture (reference + per-model), storage
  (non-secret, `source`-tagged so a refresh never clobbers it), and enforcement (the injection) all land
  together; selection and pricing are cleanly separated yet both first-class.
- **A clean non-secret storage class** — user pricing + the pricing-reference URL live in the DB, distinct from
  the keychain path; the two are never conflated.
- **The id enum stays closed** — no churn to the persisted run-event contract or authored YAML; extensibility is
  delivered via the `kind` **data** layer, with a truly-open registry honestly deferred.

### Negative

- **The cost-path injection touches `core`+`llm` signatures and every cost test** — the sharpest risk. Mitigation:
  it is the *only* change that closes the gap, the overlay is optional (absent ⇒ today's behaviour), precedence
  is static-wins so it cannot misprice a known model, and it is covered by its security round. Wiring only
  one of the two cost paths is called out as the specific hazard to avoid.
- **A user can misprice an unknown model** — bounded to *unknown* ids (static always wins for known ids),
  numeric-validated at the boundary, with the USD→microcents conversion echoed back; a typo mis-governs only the
  user's own custom model.
- **Custom-endpoint support is asymmetric** — `openai-compatible` works this round; `anthropic`/`gemini` custom
  endpoints need those factories to gain a validated `baseURL` first, so a non-openai custom `base_url` is
  **refused with a clear message** rather than over-promised.
- **A DB migration** — the `source`, `pricing_reference_url`, and `kind` columns (additive ALTER-ADD, validated
  at the store boundary since SQLite `ALTER ADD` carries no `CHECK`); forward-compatible under the single-user
  local posture ([ADR-0050](0050-cli-history-db-at-rest-posture.md)).
- **The reused-id limitation** — a custom OpenAI-compatible endpoint shadows the real provider under the same
  id; a separate custom id awaits the future enum-opening supersede-ADR (named, not silently missing).
- **Canonical reference docs pending update** — this ADR points to `database-schema.md` (the
  `pricing_reference_url` / `kind` columns) and `commands.md` (`models pricing`, `provider list --verify`, and
  the now-honoured `--base-url`) as canonical homes **not yet updated**; those edits land in the implementing
  steps that add each artifact, matching ADR-0063's honest `config-spec.md` deferral.
- **A mandatory security review** — the custom-`base_url` SSRF and the user-pricing/reference input validation +
  the cost-path injection each carry a dedicated security round before shipping.
