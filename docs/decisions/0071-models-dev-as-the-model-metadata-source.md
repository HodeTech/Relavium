# ADR-0071: models.dev as the model-metadata source; the hand-maintained registry is retired

- **Status**: Accepted
- **Date**: 2026-07-13
- **Related**: [ADR-0064](0064-live-model-catalog.md) (**supersedes** two of its clauses — "pricing authority stays with the static registry" and "adds no new egress surface"; every other part of its architecture is kept) · [ADR-0065](0065-provider-economics-and-extensibility.md) (**narrows** its user-pricing precedence — see §5 — and its custom `base_url` is the *reason* for that narrowing) · [ADR-0066](0066-normalized-reasoning-effort-control.md) (**corrects a false premise in it**: it assumed one fixed reasoning-control shape per *adapter*; the shape is per *model*, and that assumption is a live bug — §Context/3) · [ADR-0070](0070-durable-per-model-session-cost-attribution.md) (which forward-named this ADR: *"2.6.Q's pricing-enrichment decision … will be **ADR-0071**"*; its `session_costs` invariant and `unpriced_calls` counter are what made the unpriced long tail *visible*) · [ADR-0028](0028-workflow-resource-governance.md) (the cost cap this turns into a real control) · [ADR-0062](0062-context-compaction-and-cli-history-commands.md) (its `contextWindowForModel` reads the retired table — §7) · [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md) (the default-OFF-then-flip rollout convention this follows for the new egress) · [ADR-0043](0043-media-egress-failover-rematerialization-ssrf.md) (the outbound-URL posture this extends). Canonical homes: the generated snapshot → `packages/llm/src/catalog/`; the outbound-path inventory → [security-review.md](../standards/security-review.md); adding a provider → [add-a-provider.md](../runbooks/add-a-provider.md).

> **Amended 2026-07-14 by [ADR-0072](0072-model-metadata-in-the-db-behind-a-generated-offline-floor.md)** (append-only — this body is unchanged; refined, not reversed). ADR-0072 moves the model metadata into a DB (`model_metadata`) while keeping this ADR's generated snapshot as the offline floor **under** it, so three clauses are refined:
> - **§3 ("the snapshot is the floor").** Still true and still terminal — but the floor is now a generated artifact *under* a DB that replaces the `~/.relavium` file cache as the durable overlay backing. `catalogModel = refreshed[id] ?? CATALOG_SNAPSHOT[id]` is byte-unchanged; on an empty/torn/older-schema DB the host installs nothing and the snapshot answers offline, exactly as here.
> - **§4 ("additive-only").** Extended to the DB write boundary: the same additive rule is enforced by a single pure `admitRefreshedModels` gate (in `@relavium/llm`, typed over `CatalogModel`) shared by the overlay install *and* the host DB writer. The shipped-id exclusion keys on compile-time `CATALOG_SNAPSHOT` membership (this ADR's `lookup.ts` rule), not any DB column.
> - **§9 ("the money guards").** Unchanged in force: the human money-review CI gate stays at **snapshot-regen** time (a refresh never writes a shipped row), and runtime DB writes are additive-only by construction. Long-tail price drift in the DB is accepted for the same reason §4.2 accepts it here — models.dev is the only source for a long-tail model, with no human baseline to regress from.
>
> This refines the mechanism; it reverses nothing. The snapshot floor, the additive rule, and the guards all stand.

## Context

Relavium's model metadata — price, context window, max output, and reasoning capability — lives in
`MODEL_PRICING` ([pricing.ts](../../packages/llm/src/pricing.ts)), a **hand-maintained table of 12 models**.
[ADR-0064](0064-live-model-catalog.md) built a live catalog on top of it and drew the line explicitly:
*"the live list decides **availability**, the static registry stays the [pricing authority]"*. That line was
right about the split and wrong about the source. Three failures, all reported from real use, all with the
same root — **a hand-typed table cannot say what is true**:

1. **Most models have no price.** `priceModel` is an exact-string lookup; an unknown id throws
   `UnknownModelError`, and `BudgetGovernor.evaluatePreEgress` catches it and returns `allow`.
   `max_cost_microcents` — a **safety control** — is silently skipped for every model outside the 12. The model
   the maintainer actually hit, `gpt-5.4-pro`, is not in the table.

2. **Reasoning capability is a `boolean`, and the truth is not a boolean.** `gateReasoningEffort` is a
   pass-through, not a clamp: if the model reasons *at all*, whatever tier the user picked goes to the wire.
   But the accepted tiers differ **per model** — `gpt-5.4-pro` takes `{medium, high, xhigh}` and **rejects
   `low`**; `gpt-5-pro` takes only `{high}`; `gemini-3-pro-preview` has no `medium`. A boolean cannot say any
   of that, so the picker offers all five tiers to every reasoning model and the provider 400s.

3. **The control's SHAPE differs per model — and we get it wrong today. This is a live bug.** Our Gemini
   adapter sends `thinkingConfig.thinkingLevel` for every reasoning model.
   [ADR-0066](0066-normalized-reasoning-effort-control.md) allowed this: it assumed **one fixed native shape
   per adapter** ("Gemini → thinking-level"). Google's documentation for the `generateContent` API we call is
   unambiguous that the assumption is false: *"**Gemini 2.5 series models don't support `thinkingLevel`; use
   `thinkingBudget` instead**"* — and `gemini-2.5-pro` **cannot disable thinking at all** (`thinkingBudget`
   128–32768, no zero). Those two models are the **only** Gemini rows we ship. So `/effort` on Gemini is,
   today, sending a parameter the model does not take. This ADR therefore **corrects** ADR-0066's premise
   rather than merely extending it.

The table also **drifts, silently and in the safe direction**, which is exactly why nobody caught it: it says
`claude-sonnet-4-6` maxes at 64k output (it is 128k) and `gpt-5.5` has a 1,000,000 context (it is 1,050,000).

A provider's `/models` endpoint cannot fix this — it returns **availability**, not economics. Our own code
already says so: *"the live tier is **never** a pricing authority — providers rarely return a price"*. The
missing half has to come from somewhere.

[models.dev](https://models.dev) is that somewhere: an open, **MIT-licensed** catalog maintained by the
opencode project, carrying **per model** `cost` (input/output/cache-read/cache-write plus context-size
`tiers`), `limit` (context **and max output**), and `reasoning_options` — which encodes both the **shape** of
the reasoning control (`effort` / `budget_tokens{min,max}` / `toggle`) and its **accepted values**.

**We checked it rather than trusting it:**

- **All 12 of our hand-verified prices match it exactly** — including the awkward ones (`deepseek-v4-pro`
  0.435/0.87, `gpt-5.4-mini` 0.75/4.5). Zero disagreements; our ids are its keys, 1:1.
- Its `gemini-2.5-pro` `budget_tokens {min: 128, max: 32768}` matches **Google's own documentation exactly** —
  on the very model where our code is broken.
- It has `gpt-5.4-pro`, with `effort: [medium, high, xhigh]` — which *is* the maintainer's bug report.

So this is not a bet. On every axis we could independently verify, models.dev is more correct than we are.

## Decision

**Retire the hand-maintained `MODEL_PRICING`. Model metadata comes from a generated, repo-reviewed models.dev
snapshot that ships in the binary. Availability continues to come from the provider API. Reasoning capability
stops being a boolean and becomes a per-model control descriptor. Everything is driven by a provider table, so
adding a provider is an entry, not a rewrite.**

### 1. Two axes, two sources, no overlap

| Axis | Source | Answers |
|---|---|---|
| **Availability** | provider `listModels` (live, per user key) — [ADR-0064](0064-live-model-catalog.md) | *Can **I** call this model?* |
| **Metadata** | the generated snapshot | *What does it cost, what is its ceiling, what reasoning control does it take?* |

Neither replaces the other. A model can be callable but unpriced (brand new), or priced but not callable (not
on your tier). The existing `available` / `priceKnown` flags already carry both.

**ADR-0064's `MODEL_PRICING`-as-authority clause is superseded.** Its *split* — live for availability, a static
tier for economics — is **kept and strengthened**; only the static tier's **source** changes, from a hand-typed
table to a generated one.

### 2. Provider-extensible by construction — adding a provider is an ENTRY, not a rewrite

`ProviderId` stays the **closed enum** ([ADR-0064](0064-live-model-catalog.md) §6): it crosses the seam, the
persisted run-event `provider` field, and an exhaustive `Record<ProviderId, LlmProvider>`. Adding a provider is
therefore an adapter + an enum entry, as it always was.

What this ADR must not do is bake "four providers" into the catalog machinery. So **one table drives
everything**:

```ts
/** Our ProviderId → the provider's key in models.dev. The ONLY place the two vocabularies meet. */
const CATALOG_PROVIDER_KEYS: Record<ProviderId, string> = {
  anthropic: 'anthropic',
  openai:    'openai',
  gemini:    'google',   // ← their key is `google`, ours is `gemini`
  deepseek:  'deepseek',
};
```

The generator iterates `LLM_PROVIDERS`, not a literal list. **Adding a provider tomorrow is: write the
adapter, add the enum entry, add one line here, re-run the sync.** The runbook
([add-a-provider.md](../runbooks/add-a-provider.md)) is updated to say exactly that, as a numbered step.

Two traps this table also closes:

- **`google-vertex` is ignored.** It republishes the same Gemini ids at different prices; a naive flatten would
  register every Gemini model twice. Only the mapped key is read.
- **models.dev providers we have no adapter for are ignored** — 162 of its 166. Importing a model we cannot
  call would put an uncallable row in the picker. A provider appearing upstream is *not* a signal to add it.

**A provider with no models.dev coverage is a supported case, not an error.** A self-hosted or bespoke endpoint
simply has no metadata rows; it degrades to the same "unpriced" path as a brand-new model (§6), and the user
can price it with `relavium models pricing` ([ADR-0065](0065-provider-economics-and-extensibility.md)). The
catalog tier is *additive*: absence of data is never a failure.

### 3. The snapshot is GENERATED and SHIPPED — the floor is offline

`scripts/sync-models-dev.ts` fetches `api.json`, keeps only the providers in `CATALOG_PROVIDER_KEYS`,
Zod-validates, normalizes to Relavium types, and emits a data module under `packages/llm/src/catalog/` plus the
upstream body's SHA-256. It is a **committed artifact**, reviewed in a PR like any other change.

*Considered fetching at runtime and shipping nothing (rejected — this is the load-bearing rejection):* on first
run, offline, or with models.dev unreachable, there would be **no prices at all**, so `max_cost_microcents`
would not apply. **A cost cap that works only when a third-party host is reachable is not a safety control**,
and "the cap silently does not apply" is precisely the bug this ADR exists to close. The snapshot is the
**floor**: correct, offline, from the moment the binary is installed.

*Considered keeping the hand-maintained table as the top-precedence tier (rejected):* it puts one artifact in
two homes (rule 8) and makes the **less** accurate source authoritative — the table is the thing that is wrong.
"Verified" does not come from a human *typing* the number; it comes from a human **reviewing the diff**. A
generated file preserves the review gate and deletes the duplication.

*Considered vendoring the full `api.json` (rejected):* 3.17 MB, 166 providers, 5,669 models, of which 162
providers are not callable by any adapter. Filtered to ours: **97 models**, and of the fields we consume,
**~22 KB**.

**No new dependency.** `fetch` is native on the Node floor ([ADR-0067](0067-node-supported-floor-22-reaffirm-better-sqlite3.md)),
Zod is already a dependency, and SHA-256 is `node:crypto`. Nothing here needs an npm package.

### 4. The refresh is OPT-IN and DEFAULT-OFF, and it can only ADD

An **optional** refresh keeps a long-lived install current between releases. It is governed by three rules, in
order of importance:

1. **Default OFF.** [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md) established this project's
   convention for a new, risk-bearing surface: *ship opt-in default-OFF, validate, then flip*. Local-first is
   non-negotiable (rule 6), and a local-first tool that contacts a third party **by default** violates its
   spirit even when the payload is innocuous. The config key is `[catalog] auto_refresh` (default `false`).
   A **user-initiated** `relavium models refresh` always may fetch — an explicit command *is* consent. Flipping
   the default to `true` is a later, separate decision, once the surface has been validated in the field.
2. **Additive only.** A refresh may add models and enrich models the shipped snapshot does not pin, but it
   **can never leave a model less priced than the shipped snapshot did**. A failed, unreachable, or malformed
   refresh is a **no-op** — never a downgrade, never a blank catalog.
3. **The shipped snapshot is the floor.** With the refresh off (the default), behaviour is exactly the embedded
   design: zero egress, fully offline, and every model in the snapshot priced.

**This is a new egress surface, and ADR-0064's *"adds no new egress surface"* sentence is hereby superseded.**
It is recorded rather than quietly outgrown. Its posture, and its place in the outbound-path inventory, is §8.

> **Amendment (2026-07-13, implementation — §4.2 + §9 reconciled).** The runtime refresh is **purely additive for
> shipped models**: it adds the long tail the snapshot does not carry, and it **never writes a model the snapshot
> already pins**. That is the exact reading §4.2's "the shipped snapshot is the floor" and §9's "a price change on
> an already-shipped model is a human decision" require together — a runtime path cannot silently move a
> human-verified price, so it does not touch one at all.
>
> The first implementation got this wrong in a way worth recording: its "floor" guard was
> `if (shipped === undefined || model.output > 0)`, and the line above had already dropped every `output <= 0`, so
> the second clause was *always true* and the guard was `if (true)`. A refreshed row replaced its shipped row
> wholesale — so a hostile or merely typo'd upstream `output: 0.00000001` on `gpt-5.5` recorded $14.50 of real
> spend as $0.00, and the cost cap stopped tripping. The safety control this ADR exists to build, defeated by the
> code that builds it. The floor is now: a shipped id is skipped; only a NEW, priced id is admitted.

#### 4a. Both axes get a MANUAL trigger — one command, not two

`relavium models refresh` already exists and refreshes provider availability
([ADR-0064](0064-live-model-catalog.md)). It now refreshes **both axes**, because "refresh what I know about
models" is one user intent, not two:

| Invocation | Refreshes | Egress |
|---|---|---|
| `relavium models refresh` | **both** — provider lists **and** the catalog | provider APIs + models.dev |
| `relavium models refresh --providers` | availability only (today's behaviour) | provider APIs |
| `relavium models refresh --catalog` | metadata only | models.dev |

Every form is **user-initiated**, and an explicit command **is** consent — so the catalog fetch is allowed here
even with `auto_refresh = false` (the default). This is what makes default-OFF a livable default rather than a
dead end: a user who wants current prices types one command and gets them, with no standing background egress.
Each form reports per-source outcomes and honours `--json` ([ADR-0049](0049-cli-machine-output-contract.md)),
so a script (or a later `/models refresh` palette entry) can drive it without a second code path. The
in-REPL slash surface is **not** in scope here — this ADR builds the primitive and its shell entry point; a
palette entry is a curated-surface decision ([ADR-0056](0056-cli-in-app-slash-command-system-and-manifest.md))
to be made when it is wanted.

The supply-chain question — *"a wrong upstream price feeds a safety control"* — is real, bounded, and
**directional**:

- **A too-HIGH price is safe.** The cap over-estimates and refuses early; the user loses a turn, not money.
- **A too-LOW price is the dangerous direction** — the cap under-counts and real overspend follows. Two guards
  (§9) exist specifically for it, and the pre-egress estimate uses the **highest** applicable context tier for
  the same reason.
- And the honest comparison: for a model **not** in the snapshot, today's alternative is **no price at all** —
  cost recorded as `0`, cap skipped entirely. **A wrong price still *engages* the cap; a missing price does
  not.** That asymmetry is the whole argument.

### 5. User pricing wins over the catalog — and the divergence is loud

[ADR-0065](0065-provider-economics-and-extensibility.md) §2 set the precedence as *"static `MODEL_PRICING` wins
for known canonical ids; the overlay fills unknown ids only — a user cannot **silently** misprice a shipped
model."* That rule has a gap this ADR would otherwise open: a user prices an id the table does not know, the
catalog later *learns* that id, and the generated tier silently takes over — the user's explicit override
vanishes with no warning.

**This ADR narrows that precedence to `user > catalog`**, and the reason comes from ADR-0065 itself: it
introduced **custom `base_url`** endpoints (OpenRouter, Azure, LiteLLM, enterprise gateways). On those, the
public list price is simply **wrong** — the user's negotiated or marked-up rate is the *correct* one. A rule
that lets a public catalog override a rate the user deliberately typed would misprice exactly the users who
took the trouble to be accurate.

ADR-0065's actual intent — *not **silently*** — is preserved by making the divergence **visible**: when a user
override disagrees with a catalog price, the model picker, `/cost`, and `models pricing` all say so. The user
gets what they asked for; they simply cannot do it in silence.

Full precedence: **`user` > `catalog snapshot` > (none)**. The **live** tier remains non-authoritative on price
([ADR-0064](0064-live-model-catalog.md) §6, unchanged) and authoritative on availability.

### 6. Reasoning: the accepted tiers are COMPUTED, never copied

models.dev's `reasoning_options[].values` are **provider-wire** values (`none | minimal | low | medium | high |
xhigh | max`). Relavium's `ReasoningEffort` is the normalized `off | low | medium | high | max`
([ADR-0066](0066-normalized-reasoning-effort-control.md)). **They are different vocabularies, and reading one
as the other silently breaks three of our four adapters** — a literal read drops `off` from every Claude model
(where `off` is `thinking:{type:'disabled'}`, not an effort value at all) and drops `off`+`max` from `gpt-5.5`.

So `@relavium/llm` gains a **pure bridge**:

```text
acceptedTiers(provider, model) = { t ∈ REASONING_EFFORTS : wire(provider, t) ∈ catalog.values(model) }
```

with `off` resolved against each provider's **disable axis** — Anthropic `thinking:{type:'disabled'}`, OpenAI
`'none'`, DeepSeek's toggle, and **Gemini's `thinkingBudget: 0`, which `gemini-2.5-pro` does not have** (so
`off` is simply **not in that model's accepted set**). A raw catalog string **never** reaches a picker, a
config, or the wire.

`ModelPricing.reasoning: boolean` becomes a **control descriptor**: the shape (`effort` /
`budget_tokens{min,max}` / `toggle` / none) and the accepted normalized tiers. The Gemini adapter selects
`thinkingLevel` vs `thinkingBudget` **from that descriptor, per model** — which is what fixes the live bug.

An out-of-range tier is **never silently promoted** (that would change behaviour *and* raise spend). The picker
offers only accepted tiers; an authored value outside the set fails **pre-flight** with an actionable message;
the run-time last resort is to **withhold the field with a visible notice**.

### 7. What the retirement breaks, named up front

`contextWindowForModel(model)` ([pricing.ts](../../packages/llm/src/pricing.ts)) reads
`MODEL_PRICING[model].contextWindowTokens` and is consumed by
[ADR-0062](0062-context-compaction-and-cli-history-commands.md)'s compaction path (the context-fullness
indicator and the auto-compaction threshold). Retiring the table **breaks it**, and it is named here rather
than discovered mid-implementation: it is re-sourced from the catalog, which *widens* it — compaction currently
degrades to "no window known" for the 85 models outside the table, and will stop doing so.

### 8. Outbound posture — the fifth path

[security-review.md](../standards/security-review.md) frames the outbound surface as a **closed** inventory:
*"There are **four** outbound-URL paths … and they share one vetted SSRF range-primitive"*. The refresh of §4
is a **fifth**, and that document is updated in the same change — an ADR that adds an egress path without
amending the inventory would defeat the inventory's purpose.

Its posture, which is **not** the SSRF posture, and the difference matters:

- The destination is a **fixed, compile-time constant host** (`models.dev`) — **not** user-supplied and **not**
  model-supplied. The SSRF primitive exists to defend paths where an *attacker chooses the URL*; here nobody
  does. It is the same category as ADR-0064's provider fetch, not the same as `http_request`.
- **HTTPS only; no cross-host redirect is followed** (a redirect off `models.dev` is an error, not a hop).
- The request carries **no user data, no key, no telemetry** — an unauthenticated `GET` of a public file.
- It lives **host-side** (`apps/cli/src/engine/`), never in `packages/core` or the pure part of `packages/llm`
  — engine purity (rule 5) forbids a platform import there. The pure merge keeps taking data as an argument.
- The response is **Zod-validated at the boundary** and normalized before it reaches any Relavium type — the
  same discipline [ADR-0064](0064-live-model-catalog.md) §1 applies to a provider's `ModelListing`.

### 9. Two guards, because a third party now influences a safety-relevant number

- **A price change on an ALREADY-SHIPPED model fails the sync.** New rows merge automatically; a *moved* price
  on a model we already ship is a **human** decision, surfaced as a red CI check, never a silent bot commit.
- **A live conformance test pins the effort mapping against the real API.** The key-gated nightly suite
  (`packages/llm/src/conformance/*`) gains: *the tiers we claim this model accepts, it actually accepts.*
  Without it, a stale catalog entry re-introduces exactly the Gemini bug, silently — and this is the **only**
  mechanism that can catch that. A one-off manual probe cannot: it proves a fact once, not continuously.

> **Amendment (2026-07-13, implementation — §9 wired).** Both guards are live in
> `.github/workflows/models-catalog.yml`:
>
> - **The weekly price-change check** is `pnpm sync:models` (Monday 06:00 UTC): its money guards fail red ONLY on a
>   MOVED or VANISHED price on a model we already ship — the human decision — and pass on benign additive drift.
>   Going red on every additive change (models.dev adds our-provider models constantly) would train the maintainer to
>   ignore the check, eroding the very protection it exists to give (sync.mjs says so in its own comments). The
>   *automatic* PR for the additive case ("new rows merge automatically") is deferred: it needs a create-pull-request
>   action pinned to a verified SHA. See deferred-tasks.md.
> - **The live effort conformance test** is `packages/llm/src/conformance/effort.conformance.test.ts` (nightly
>   07:00 UTC, key-gated per provider): for a representative EFFORT-shaped reasoning model per provider it sends
>   every tier the catalog claims it accepts and asserts the real API does not reject it. The Gemini probe must be
>   effort-shaped (`gemini-3-flash-preview`, not the budget-shaped `gemini-2.5-flash`) — a budget-shaped model
>   sends `thinkingBudget`, always accepted, and never the `thinkingLevel` that can 400 on tier drift, so it would
>   be a tautology on the very provider whose acceptance was the original bug. An offline gate pins the probe ids
>   to real shipped models so a rename cannot silently turn the live lane into a no-op.

### 10. What the catalog does NOT own — named, so it is not discovered mid-build

| Need | Status | Where it comes from instead |
|---|---|---|
| **Request shape** — the field *names* a provider wants | **Absent.** models.dev describes *models*, not *wire protocols*. | Provider docs, in the adapter. §10a. |
| **Media output rates** ([ADR-0044](0044-media-access-governance-read-media-save-to-cost.md)) | **Absent** — `cost: null` on every image model. | No shipped model carries one today, so nothing is lost. The field stays, filled from a Relavium overlay if ever needed. |
| **Deprecation dates** | A `status` flag, not an ISO date. | *When to warn a user* is a Relavium **editorial** call, not a data fact — it stays in a small Relavium-owned overlay. Adopting the flag would **lose** information we already have. |
| **`cache_read` when absent** | Absent on 19 of 97 models. | It is **`undefined`, never `0`**. `0` means *"no discount"* in `ModelPricing` and would **price cached input at zero** — a silent undercharge in the mechanism this ADR is hardening. Absent ⇒ fall back to the full input rate. |
| **Reachability with *your* key** | Absent by design. | `listModels` (§1). A catalog cannot know your account. |

> **Amendment (2026-07-13, implementation — §10 and §11).** Three corrections, recorded rather than rewritten.
>
> 1. **`cache_read` absent ⇒ the full input rate** — §10's rule, which the first implementation of the swap
>    violated. `catalogPricing` wrote `?? 0`, and `cost()` bills `cacheReadTokens × rate`, so **0 charges nothing**:
>    eleven catalog models publish no cache rate, OpenAI auto-caches, and the cached fraction of every prompt on
>    `o1-pro` ($150/MTok in) billed at $0.00. The clause existed precisely to prevent this; the code was written
>    against the clause and the test that "checked" it restated the buggy expression. Corrected, and now asserted as
>    behaviour (a 100k-token cached read must cost the input rate, not zero).
>
> 2. **The deprecation overlay is REAL, and was briefly deleted.** §10 says the retirement date "stays in a small
>    Relavium-owned overlay". The first cut of the swap removed the two DeepSeek dates on the theory that the live
>    provider list would supply them. It does not: **no adapter populates `ModelListing.deprecatedAt`** (the
>    OpenAI-compatible list is id-only), so `deprecated` became permanently `false` for every model in the product
>    and `deepseek-chat` was set to stop working in eleven days with nothing to say so. The overlay
>    (`packages/llm/src/catalog/deprecations.ts`) is what §10 always specified: one date per model, from a published
>    announcement — not a second price table.
>
> 3. **§11's context tiers are now CONSUMED.** They were parsed, guarded and exported, and read by no pricing code —
>    so a >200k `gemini-2.5-pro` turn billed at the cheap tier. That was a tolerable gap while those models threw
>    `UnknownModelError`; it became a silent 2× under-bill the moment the catalog started pricing them. The realized
>    fold prices the tier the prompt landed in; the pre-egress estimate takes the HIGHEST, because a cap that
>    over-estimates refuses a turn the user could have afforded while one that under-estimates lets money escape.

#### 10a. `max_tokens` vs `max_completion_tokens` — a rule, not a probe

Our OpenAI adapter calls **Chat Completions** and sends `max_tokens`. OpenAI's reasoning models (o-series,
GPT-5) **reject** it and require `max_completion_tokens` — which is the second half of the maintainer's
"max tokens errors" report (the first half being the absence of any clamp against `limit.output`, §7). The
same adapter also serves **every custom OpenAI-compatible `base_url`**
([ADR-0065](0065-provider-economics-and-extensibility.md)) — LM Studio, Ollama, vLLM, LiteLLM, enterprise
gateways — most of which implement only the legacy `max_tokens`. Switching the field globally would trade one
broken population for another.

**The rule:** the **official OpenAI endpoint** gets `max_completion_tokens` (the current field; `max_tokens`
is the deprecated one). **Everything else** — DeepSeek, and any custom `base_url` — keeps `max_tokens`, the
field every OpenAI-compatible server implements. A per-provider config key overrides it for an exotic endpoint
that wants the modern field.

> **Amendment (2026-07-13, implementation).** Two corrections, recorded rather than rewritten (ADRs are
> append-only).
>
> 1. **"Official" is decided by HOST, not by "did a caller pass a base URL".** The first implementation read
>    `deps.baseURL !== undefined` as *custom*, and the CLI stores a `--base-url` **verbatim** — so a user who
>    registers OpenAI with its own endpoint spelled out (`https://api.openai.com/v1/`, trailing slash) was
>    classified custom, and got the deprecated field **and no clamp** on the official API. That is this very bug,
>    restored by a typo. The adapter now compares the resolved `hostname` against the provider's own host.
>
> 2. **The "per-provider config key" does not exist, and is not needed.** The override an exotic gateway actually
>    has is the **`providerOptions` escape hatch** ([ADR-0011](0011-internal-llm-abstraction.md) §1.D): a request
>    that carries no `maxTokens` but sets `providerOptions.max_completion_tokens` sends exactly that. What the
>    first implementation got *wrong* was the collision — the mapped cap and an escape-hatch cap under a
>    **different key** both reached the wire, and OpenAI rejects a request carrying both. The adapter now
>    guarantees **exactly one** cap field: whichever we map wins outright and the other key is dropped; an
>    un-mapped escape-hatch cap stands untouched. A config key can be added if a real endpoint ever needs one —
>    none has.

*Considered discovering the dialect at runtime (send the modern field; on a 400 that names the parameter, retry
once with the legacy field and cache the result per endpoint) — **rejected**.* It burns a real turn to learn
what a constant already tells us; it depends on **string-matching a provider's error message**, which is not a
contract; and it introduces mutable per-endpoint state that has to be persisted, invalidated, and made
deterministic for tests. A rule with a documented escape hatch is knowable, testable, and costs the user
nothing.

### 11. The seam holds, so the source is replaceable

models.dev's raw shape (`reasoning_options`, `cost.tiers`, `limit.input`) is Zod-parsed and normalized at the
boundary and **never appears in `@relavium/llm`'s public types** — the pattern
[ADR-0064](0064-live-model-catalog.md) §1 already established for `ModelListing` (and the same instinct
[ADR-0011](0011-internal-llm-abstraction.md) applies to vendor SDKs, though models.dev is an aggregator, not a
provider SDK). models.dev is therefore an **implementation detail of the snapshot generator**, not an
architectural commitment: when Relavium builds its own metadata source, it swaps behind the same normalized
types — one file, not a refactor.

### 12. Per-model REQUEST capabilities — the same "a table cannot say what is true" fix, one more axis

> **Amendment (2026-07-14, implementation).** The same class this ADR already fixed for **pricing** (a hand-typed
> table → a per-model generated row) and **reasoning shape** (§6, a provider-wide boolean → a per-model control
> descriptor) has a third instance: **which request PARAMETERS a model accepts.** `temperature`, `tool_call`,
> `structured_output` and `attachment` all vary **per model within a single provider** — models.dev publishes each
> as a per-model boolean, and (checked against the live payload) all four range over `[false, true]` for the
> providers Relavium serves. The pre-existing `CapabilityFlags` (`packages/llm/src/types.ts`) is a **per-PROVIDER**
> struct, so it cannot express that `gpt-5.6-luna` rejects `temperature` while its siblings accept it; sending the
> parameter to a model that rejects it is a live 400 (the reported bug).
>
> - **The data lives on the model, not the seam.** A per-model `requestCapabilities` descriptor is carried on
>   `CatalogModel` (parsed from models.dev, normalized like `reasoning`), NOT forced into the provider-level
>   `CapabilityFlags` — exactly as §6 put the reasoning shape on the model. It is **enrichment**, parsed leniently
>   (a shape change never evicts a priced model — the §11/M7 rule), and stores **only a `false`**: absent ⇒
>   **accepted**, the safe default, so a model with no capability data (a custom `base_url`, a brand-new id) is
>   never denied a parameter it takes on the strength of missing metadata.
> - **The adapters WITHHOLD, they do not send-and-fail.** `modelAccepts(model, param)` gates the wire parameter in
>   all three OpenAI-compatible/Anthropic/Gemini adapters. A rejected `temperature`/`structured_output` is dropped,
>   turning a guaranteed 400 into a served turn at the model's default — the same "withhold, never guess" posture
>   §6 established for reasoning.
> - **Anthropic thinking pins `temperature` to 1.** Independently, enabling extended thinking (`thinking:{enabled|
>   adaptive}`) forbids any other temperature on Anthropic. The adapter now withholds a caller temperature whenever
>   it enabled thinking for the turn — the reasoning the author selected wins, and the 400 is removed.
> - **Scope, honestly.** `temperature` and `structured_output` are safe **silent** param-withholds (a preference/
>   optimization the wire can omit, and the turn still runs). `tool_call` and `attachment` are NOT: dropping tools
>   silently would leave the agent unable to act, and dropping an image input would change what the model sees.
>   Their catalog data is carried (the mechanism is complete), but gating them is deferred to a **louder** signal
>   (config-time validation, or a gate-level notice like §6's effort gate), not a silent drop. A user-facing notice
>   for the two silent withholds (so a dropped `temperature` is *said out loud*, §6's own standard) is likewise a
>   follow-up — the correctness fix (no 400) ships first.
> - **The data populates via the sync, not by hand.** The snapshot is GENERATED (§3); these fields are parsed by
>   the schema and land on the next `pnpm sync:models`. Until then the mechanism is inert-but-correct (absent ⇒
>   accepted), and the shipped snapshot is **not hand-edited** — the generated-file discipline holds.

### K7. `strict_cost_cap` — refuse a turn on a model we cannot price

> **Amendment (2026-07-14, recorded — append-only).** The `ADR-0071 §K7` citations across the config spec, the
> workflow spec, and the engine all refer to THIS decision, which had no home section: `K7` was an implementation
> milestone label that leaked into the citations before the rule was written up. Recorded now so the citations
> resolve, and numbered `K7` to match them rather than renumbering forty-five references.
>
> A cost cap cannot bound a turn on a model it cannot PRICE — the pre-egress governor has no estimate, so it
> degrades to `allow` and says so ONCE (`onUnpriced`): a cap that silently does not apply is a false sense of
> safety, and one notice per model is the honest middle between silence and per-turn noise. For a self-hosted model
> with ~no metered cost that is the right trade. But a user who set the cap SPECIFICALLY to bound an untrusted model
> wants the opposite, so **`strict_cost_cap`** (default `false`; `[chat].strict_cost_cap` /
> `budget.strict_cost_cap`) makes the governor **REFUSE** the turn instead — *"if we cannot price it, we do not run
> it."* It is INERT without a positive `max_cost_microcents` (no cap ⇒ nothing to enforce), and `models pricing
> <model>` closes the hole either way (once priced, the cap applies normally, pre-egress and realized).

## Consequences

### Positive

- **The cost cap becomes a real control.** Priced models go from 12 to 97 — at install time, offline, by
  default. That is the property a *live-only* fetch could never have guaranteed.
- **The Gemini live bug is fixed**, and its whole class becomes unrepresentable: the control's shape is data,
  not an adapter-wide assumption.
- `gpt-5.4-pro` — the model that produced the bug report — is priced, its effort tiers are correct, and its
  output ceiling is known. One row, three findings.
- **Compaction gets wider**, not narrower: `contextWindowForModel` stops returning `undefined` for the 85
  models outside the old table (§7).
- Two silent drifts corrected (`claude-sonnet-4-6` 64k→128k, `gpt-5.5` context 1M→1.05M).
- **Adding a provider stays cheap**: adapter + enum entry + one line in `CATALOG_PROVIDER_KEYS` (§2).

### Negative

- **A new (fifth) outbound path**, superseding ADR-0064's "no new egress" clause. Mitigated by being
  **default-OFF** (§4), a fixed host with no user data (§8), additive-only, and a no-op offline — but it is
  new, it is recorded here, and [security-review.md](../standards/security-review.md) is amended in the same
  change rather than left stale.
- **A third party can now influence a safety-relevant number** for models outside the shipped snapshot.
  Bounded by the additive rule and the two guards (§9), and directional: a too-low price is the dangerous one,
  which is why the pre-egress estimate takes the **highest** applicable tier. Compared honestly against the
  status quo — *no price at all* — a wrong price still engages the cap.
- **`contextWindowForModel` and every other `MODEL_PRICING` consumer must be re-sourced** (§7). Named, not
  discovered.
- **[ADR-0065](0065-provider-economics-and-extensibility.md)'s precedence is narrowed** (§5): `user` now beats
  the catalog. This is a deliberate reversal of "static wins for known canonical ids", justified by ADR-0065's
  own custom-`base_url` feature, and it keeps that rule's actual intent ("not *silently*") by making any
  divergence visible.
- **Freshness is bounded** by the release cadence with the refresh off (the default). A brand-new model is
  unpriced until the next release or an explicit `models refresh`. The day-0 escape hatch already exists:
  `relavium models pricing <model>`.
- Tiered (context-size) pricing must now be modelled: the cap is a safety control, and a flat rate understates
  long-context spend by up to 2×. `ModelPricing` gains an optional tier field.

### Neutral

- `ProviderId` stays **closed**; the pure merge stays in `@relavium/llm`; the live tier stays non-authoritative
  on price. ADR-0064's architecture is preserved — only the static tier's *source* and its *egress* sentence
  change, and its Related pointer to `pricing.ts` as the registry's canonical home is amended in place.
- [ADR-0066](0066-normalized-reasoning-effort-control.md)'s normalized five-tier vocabulary is **unchanged**.
  What changes is that a model now *declares* which of those tiers it accepts, and what native shape carries
  them, instead of the adapter assuming both.
- **No new runtime dependency** (§3) — native `fetch`, existing Zod, `node:crypto`.
