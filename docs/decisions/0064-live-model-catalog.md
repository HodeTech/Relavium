# ADR-0064: Live model catalog — the `listModels?` seam capability, the `kind` protocol abstraction, the `model_catalog` live cache, the refresh lifecycle, and the static/live merge

- **Status**: Accepted
- **Date**: 2026-07-05
- **Related**: [ADR-0011](0011-internal-llm-abstraction.md) + [ADR-0030](0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md) + [ADR-0031](0031-llm-seam-shape-amendment-multimodal-io.md) (**this ADR amends the `LLMProvider` seam shape — additively**; append-only top-notes added there) · [ADR-0038](0038-agentrunner-llm-call-boundary.md) (host-injected provider resolution — the refresh service reuses it) · [ADR-0050](0050-cli-history-db-at-rest-posture.md) (the cache shares `history.db`; a model list is non-secret) · [ADR-0044](0044-media-access-governance-read-media-save-to-cost.md) + [ADR-0045](0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) (the `model_catalog` **media-routing** consumer this must not regress) · [ADR-0056](0056-cli-in-app-slash-command-system-and-manifest.md) (the `/models` REPL command + `models refresh` shell command) · [ADR-0049](0049-cli-machine-output-contract.md) (`--json`) · [ADR-0059](0059-cli-mid-session-model-reseat.md) (the **other** `/models` — mid-chat reseat, Phase 2.6 — disambiguated below) · [ADR-0063](0063-cli-config-write-contract.md) (the `/models` selection persists the next session's default via its config-write primitive) · [ADR-0065](0065-provider-economics-and-extensibility.md) (**extends** this ADR's merge with a user-pricing tier + custom providers). Canonical homes: the seam signature → [llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md); the `model_catalog` DDL → [database-schema.md](../reference/desktop/database-schema.md); the commands → [commands.md](../reference/cli/commands.md); the static registry → [pricing.ts](../../packages/llm/src/pricing.ts).

> **Amended 2026-07-05 by [ADR-0065](0065-provider-economics-and-extensibility.md)** (append-only — this body is unchanged): §6's merge precedence gains its **USER tier** — user-supplied per-model pricing fills **unknown** ids (`price = static ?? user`; static always wins for a known id), populating the merge helper's day-one optional user slot from the `model_catalog` `source='user'` rows. ADR-0065 also **injects** that merged pricing into the cost path (closing the unpriced-model cap gap) and wires custom OpenAI-compatible `base_url` endpoints over the shared SSRF floor. This ADR's static/live contract is unchanged; ADR-0065 extends it additively.

> **Clarified 2026-07-06 (2.5.G key-awareness — append-only, body unchanged):** §6 availability also requires a **resolvable key**. The merge gains an optional `keyedProviders` input (the providers with a keychain/env key); a model whose provider is **not** keyed is `available: false` with `unavailableReason: 'no-key'`, regardless of live/static presence — because with no key the model is genuinely uncallable (a chat started on it would only fail `provider_auth`), so the `/models` picker dims it (naming the remedy) and makes it **non-selectable**. This **refines, not reverses**, §6's "never everything unavailable" static-presence safe default: that default applies only to a **keyed** provider with no live data (never dimming a whole provider the user can actually use). `keyedProviders` is optional — **absent ⇒ availability is not key-gated**: the `available` BOOLEAN is unchanged from the pre-clarification behavior (the only new output is the additive-optional `unavailableReason`), so only a key-resolving surface (the CLI Home) opts in. The pre-existing "not available on your key" dim (a keyed provider whose live list omits a static model) is now labeled `unavailableReason: 'not-on-key'`.

> **Clarified 2026-07-07 (2.5.I — DB write-path concurrency — append-only, body unchanged):** §5's Negative
> bullet already requires the background refresh to "tolerate two concurrent `relavium` processes racing the DB
> write (WAL + `busy_timeout` already exist)". 2.5.I gives that requirement its concrete, **repo-wide**
> realization across every `history.db` writer, establishing two conventions the next store author follows.
> **(1)** Every write transaction opens with **`BEGIN IMMEDIATE`** (not drizzle's `DEFERRED` default), taking
> the write lock up front to close the read→write lock-upgrade race — applied to `persistEvent` (run history),
> the model-catalog `replaceProviderModels` bulk live-upsert and its per-model `upsert`, the provider
> `upsert` read-then-write, and the media-reference GC writes (`addReference` / `removeRunReferences` /
> `reclaimExpired`). **(2)** Every such
> write routes through a bounded, **fail-loud** `SQLITE_BUSY`/`SQLITE_LOCKED` retry helper
> ([retry.ts](../../packages/db/src/retry.ts)) with **deterministic** backoff — **no jitter**, never
> `Math.random`, following the no-jitter/deterministic-replay convention of
> [ADR-0040](0040-node-retry-budget-above-the-chain.md) — that **surfaces** the error (never silently drops a
> write) once the bounded attempt budget is exhausted, preserving
> [ADR-0050](0050-cli-history-db-at-rest-posture.md)'s durability-first `persistEvent` posture. Single-statement
> writes rely on SQLite's built-in busy handler (`busy_timeout`). Symmetrically, `sessionStore.loadFull` reads
> its session row and its messages inside one **read transaction**, for a torn-read-free snapshot. This
> **extends** §5's already-accepted concurrent-process clause: it reverses nothing, adds **no dependency**
> (`retry.ts` is an in-house helper), and changes **no** at-rest/credential posture (ADR-0050 /
> [ADR-0006](0006-os-keychain-for-api-keys.md) /
> [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md) untouched — concurrency is a
> data-integrity/liveness concern, not the credential boundary). The mechanism's one canonical home is the
> "Concurrency & transaction behavior" section of
> [database-schema.md](../reference/desktop/database-schema.md); the `0600`/`0700` guard is a documented Windows
> no-op (ADR-0050), so the 2.5.I test lane gates POSIX-permission assertions off Windows, while the
> `BEGIN IMMEDIATE` + retry mechanism behaves identically cross-OS.

## Context

The model catalog is **static in-code**: `MODEL_PRICING` ([pricing.ts](../../packages/llm/src/pricing.ts))
is the single source of truth for both **cost** and **display** — canonical id → `{provider, displayName,
contextWindowTokens, prices, …}` — and `contextWindowForModel` returns `undefined` for an unknown id. The
`model_catalog` DB table + `createModelCatalogStore` **already exist** ([schema.ts](../../packages/db/src/schema.ts)
L95, [model-catalog-store.ts](../../packages/db/src/model-catalog-store.ts)) but were built for the 2.S
**media-routing** projection, ship **empty**, and are documented as "a display projection *seeded from*
`MODEL_PRICING`" ([pricing.ts](../../packages/llm/src/pricing.ts) L8).

Phase 2.5.G was originally scoped to a **static** `/models` catalog, and a live provider `/v1/models` fetch
was listed **out of scope → Phase 3** ([phase-2.5-cli-consolidation.md](../roadmap/phases/phase-2.5-cli-consolidation.md)
§ "Explicitly out of scope"). The maintainer has **removed that deferral** (**Option A** — the live catalog,
chosen over the originally-scoped static-registry catalog): we build a **live** catalog now, because the
static registry inevitably lags a provider shipping a new model, and a live list surfaces the models a given
**key** can actually reach (tier/allowlist-gated). But the two concerns are not symmetric: **no provider
returns pricing**, and only Anthropic and Gemini return a context window — so the catalog is *discovery*
(live) reconciled with *economics* (static). Model **selection** and model **pricing** are separable, and this
ADR keeps them cleanly separated: the live list decides **availability**, the static registry stays the
**pricing** authority.

The stakes: this adds a method to the **frozen `LLMProvider` seam** ([ADR-0011](0011-internal-llm-abstraction.md) —
the seam is "the immovable contract"), it is an **egress/SSRF surface**, and a naive refresh could **regress
media routing** (the table's existing consumer) or **overwrite a known price**. Getting the merge precedence or
the refresh isolation wrong silently corrupts cost governance or empties the picker.

## Decision

**We add an optional `listModels?` capability to the `LLMProvider` seam, a `kind` protocol abstraction, widen
the existing `model_catalog` table into a live-discovery cache, add a refresh lifecycle (first-run / explicit /
TTL background), and reconcile live discovery with the static registry in one pure `@relavium/llm` merge
helper — keeping the provider-id enum CLOSED and pricing authority with the static registry.** The live fetch
for the four known providers rides each adapter's vendor SDK; no new runtime dependency.

### 1. Seam — `listModels?` optional capability method

We add **`listModels?(key, signal?): Promise<ModelListing[]>`** to `LlmProvider`, following the existing
optional capability-varying pattern (`contextLimit?` / `generateMedia?` / `pollMediaJob?`,
[types.ts](../../packages/llm/src/types.ts) L494–521). `ModelListing` is a **Relavium/Zod** type
(`id`, `displayName?`, `contextWindowTokens?`, `maxOutputTokens?`, `capabilities?`, `deprecatedAt?`); each
adapter Zod-parses its vendor `models.list()` response and maps it to `ModelListing` **inside `src/adapters/*`**,
so **no vendor SDK type crosses the seam** ([ADR-0011](0011-internal-llm-abstraction.md), CLAUDE.md #4). The
method is **optional**: an adapter (or a future kind) without a list endpoint omits it and the host degrades to
static-only for that provider. The exact signature + `ModelListing` shape are the seam's one canonical home
([llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md)), not restated here.

> **Clarification (2026-07-05):** the informal `ModelListing` sketch in this §1 (and §6's
> "CAPABILITIES ← live `??` static") lists a `capabilities?` field, but the **shipped** shape — whose
> canonical home is the seam doc — deliberately carries **no `capabilities`**: the field is
> `{ id, displayName?, contextWindowTokens?, maxOutputTokens?, deprecatedAt? }`. The adapters drop the
> vendor capabilities object (no merge step consumes per-model capabilities, and there is no per-model
> static tier to reconcile against), so §6's "CAPABILITIES ← live `??` static" reduces in practice to the
> per-**provider** `CapabilityFlags`. This is a documentation reconciliation only — the schema is unchanged.

### 2. The `kind` protocol abstraction

We introduce a provider **`kind` ∈ `{anthropic, openai-compatible, gemini}`** — a closed vocabulary
`PROVIDER_KINDS` in `@relavium/shared` (mirroring how `LLM_PROVIDERS` lives there and `@relavium/db` /
`@relavium/llm` derive from it). `kind` derives, **once per protocol rather than per provider**: the adapter
factory, the list-models endpoint path (`modelsPath`), the auth style, and the response mapper. Each of the
four known providers declares a `kind` in the single-home `KNOWN_PROVIDERS` metadata
([providers.ts](../../apps/cli/src/engine/providers.ts)) — `anthropic → anthropic`,
`openai`/`deepseek → openai-compatible`, `gemini → gemini`. DeepSeek already proves the pattern
(`createOpenAiAdapter({providerId:'deepseek'})`, [providers.ts](../../packages/llm/src/providers.ts) L18). This
is the seam mechanism [ADR-0065](0065-provider-economics-and-extensibility.md) reuses for OpenAI-compatible
custom endpoints; the enum itself stays **closed** (§6).

### 3. Live fetch via the vendor SDK path; lenient inbound parsing

For the four known providers, `listModels` rides each adapter's **vendor SDK `models.list()`** over the
adapter's injected network seam (the injectable `fetch` on Anthropic/OpenAI; the `GeminiTransport` on Gemini) — so `@relavium/llm` gains **no `node:` import** — and inherits the
construction-time `assertHttpsBaseUrl` SSRF gate (the OpenAI adapter) or the provider's fixed public host
(Anthropic/Gemini). The call is **bounded + abortable + secret-free**, mirroring `validateProviderKey`'s
`AbortController` + hard-timeout + key-redaction discipline ([providers.ts](../../apps/cli/src/engine/providers.ts) L107).
Parsing is **lenient inbound / strict outbound**: the mapper ignores unknown vendor fields and requires only
`id`, so **additive provider drift is absorbed silently**; a per-provider filter keeps only chat-capable text
models (Gemini by `supportedGenerationMethods` including `generateContent`; OpenAI/DeepSeek by an id-family
allowlist, intersected with `MODEL_PRICING` for cost eligibility; Anthropic/Gemini lists are clean). The
per-provider endpoint contracts (Anthropic's rich `/v1/models` with `max_input_tokens`/`capabilities`; Gemini's
`/v1beta/models`; the id-only OpenAI/DeepSeek shapes) are documented in
[llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md), derived once, not restated here.

> **Clarification (2026-07-05):** §3's phrase "an id-family allowlist, **intersected** with `MODEL_PRICING`"
> describes a **UNION**, not a set intersection — a priced id is kept **even without a family match**
> (cost-eligibility always wins), matching §6, the seam doc, and `keepOpenAiModelId`
> ([openai.ts](../../packages/llm/src/adapters/openai.ts) — `pricedIds.has(id)` short-circuits to `true`
> before the family heuristic runs). The intent throughout is "id-family allowlist ∪ priced ids".

### 4. The `model_catalog` live cache — repurpose, widen, migrate

We **invert** the table's documented role: from "static projection seeded from `MODEL_PRICING`" to the
**live-discovery cache** ("which ids exist for this key"), with `MODEL_PRICING` enriching at **read** time.
Registry pricing is **never** seeded into the DB (that would create a second, drift-prone home — CLAUDE.md #8);
the DB cost columns are reserved for **user-supplied** pricing ([ADR-0065](0065-provider-economics-and-extensibility.md)).
(Considered a **new dedicated** live-catalog table — rejected: `model_catalog` already carries the
pricing/context/deprecation columns and the FK graph, so a second table would duplicate the schema and split
the media-routing and discovery homes into two.) A drizzle migration (`0007`, ALTER-ADD only) adds a **`source`** discriminant (`static | live | user`) and a
**`last_refreshed_at`** freshness column; because SQLite `ALTER TABLE ADD` cannot carry a `CHECK`, the closed
set is validated at the **store read boundary** (mirroring `coerceMediaSurface`,
[model-catalog-store.ts](../../packages/db/src/model-catalog-store.ts) L91). We widen the store with
`listByProvider`/`listAll` readers and a **transactional bulk live-upsert** that **soft-deactivates** models
absent from the new list — **never hard-deletes** (`model_catalog.id` is an FK target from five tables:
agents, step_executions, run_costs, agent_sessions, session_messages). The existing **media-routing reader
path stays regression-clean** — the widening is additive and the narrow media projection is untouched. The
new columns' one canonical home is [database-schema.md](../reference/desktop/database-schema.md).

### 5. Refresh lifecycle — first-run / explicit / TTL background, per-provider isolation

Three triggers: **(a) first-run-if-empty** — a minimal blocking fetch when the cache is empty (Home open);
**(b) explicit `relavium models refresh`** — blocking, reports per-provider *added/updated/deactivated*, with a
`--json` machine form ([ADR-0049](0049-cli-machine-output-contract.md)); **(c) a 24h TTL** — opening the picker
over a stale cache renders the cache **immediately** and kicks a **non-blocking background** refresh that
updates the view as results arrive. The background refresh is **fire-and-forget and `unref`'d** so it can
**never keep a short-lived CLI process alive** past command exit, and it **swallows** per-provider failures.
Isolation is **per-provider** (`Promise.allSettled`): one provider's failure (bad key, network, drift) **never
fails the whole refresh** — it keeps its last-good cached rows and is surfaced as "couldn't refresh — showing
last-known", never an empty picker. Offline / all-fail degrades **cache → static registry**, so the picker is
**never empty**. (Considered an **event-driven** refresh keyed off a provider-key change instead of a TTL —
rejected: the connected-key set rarely changes, and a TTL + explicit `models refresh` is simpler and
offline-predictable, with no hidden trigger.) The orchestration is a **host service with injected deps** (`{resolveProvider, keyFor,
catalogStore, now}`, [ADR-0038](0038-agentrunner-llm-call-boundary.md)), so desktop/VS Code reuse it and
`@relavium/llm`/`@relavium/core` stay platform-free. CI/replay never hits the network — the refresh is
injectable/skippable behind the same recorded-fetch seam the conformance harness uses.

### 6. The enum stays CLOSED; the merge is a pure `@relavium/llm` function

`ProviderId` stays the **closed `z.enum(LLM_PROVIDERS)`** — it flows through the seam, the **persisted**
run-event `provider` field ([run-event.ts](../../packages/shared/src/run-event.ts) L338), authored agent YAML,
and an **exhaustive** `Record<ProviderId, LlmProvider>` ([providers.ts](../../packages/llm/src/providers.ts)).
Opening it to arbitrary ids is a persisted-contract + exhaustiveness change **out of 2.5.G scope**;
[ADR-0065](0065-provider-economics-and-extensibility.md) names it as future work. The pure **static/live merge**
lives in `@relavium/llm` beside `pricing.ts` (references `ModelPricing`, I/O-free) so every surface reuses it.
(Considered placing the merge in the **host** (`apps/cli`) — rejected: desktop and VS Code would each
re-implement it; a pure `@relavium/llm` function is written once and reused by all surfaces.)
Per-field **precedence**:

- **AVAILABILITY** ← the live list. A static model **absent** from the current key's live list renders **dimmed
  "not available on your key"** and is non-selectable (the maintainer's decision: dim, do not hide); a provider with **no live list**
  (endpoint down or `listModels` absent) falls back to **static presence** — never "everything unavailable".
- **PRICE** ← **static** (`MODEL_PRICING`). The live tier is **never** a pricing authority (providers rarely
  return price); a refresh must **never** overwrite or zero a known price.
- **CONTEXT / CAPABILITIES** ← live `??` static (live is fresher when present; e.g. Anthropic's
  `max_input_tokens`).
- **DEPRECATION** ← **union** of static `deprecatedAt` and the live `deprecationDate` (§7).
- **PRICE-KNOWN** ← whether a static (or, per [ADR-0065](0065-provider-economics-and-extensibility.md), user)
  price exists; **false** ⇒ the "cost cap will not apply" marker the picker surfaces.

The helper accepts an **optional USER tier from day one** (unused here); [ADR-0065](0065-provider-economics-and-extensibility.md)
fills it with user-supplied pricing **additively**, with no re-open of this signature — the "no follow-up debt"
guarantee. The merged `ModelCatalogEntry` shape (`pricingSource`, `priceKnown`, `available`, `deprecated`, …)
is defined once beside the helper.

### 7. Deprecation representation

We add an optional **`deprecatedAt?: string` (ISO)** to the static `ModelPricing`
([pricing.ts](../../packages/llm/src/pricing.ts)), formalizing the DeepSeek legacy-alias prose (deprecating
2026-07-24) into a machine-readable, deterministic (`now ≥ deprecatedAt`) field. The DB
`model_catalog.deprecation_date` (`epochMs`, already present) carries the live half; the merge **unions** them;
the host projection converts ISO ↔ epochMs. The picker **flags** a deprecated model but never **forbids** it
(legacy aliases still cost correctly until their date).

### 8. Drift resilience — endpoint/shape change behaviour

Beyond §3's lenient inbound: a **breaking** provider change (a removed `id` field, a moved endpoint, a `4xx`)
makes the adapter's `listModels` **throw**, which §5's per-provider isolation catches → **cache + static
registry** keep the picker fully functional → a **visible, non-fatal notice** ("Provider X model list
unexpected — showing last-known") makes the drift **visible, not silent**. The **SDK path insulates** endpoint
and version moves (a vendor SDK bump handles them). A single **malformed row** is dropped at the mapper
boundary (a typed domain error, mirroring `parseCapabilities`), degrading **one** model, never the whole
provider. A drift fixture in the conformance suite proves this.

### 9. Egress posture

For the four known providers `listModels` hits **fixed public HTTPS hosts** via the SDK
(`assertHttpsBaseUrl` → `isPrivateOrLocalHost` on the OpenAI adapter; fixed hosts on Anthropic/Gemini), so the
residual SSRF risk is nil — the operative backstop is **SNI-pinned TLS certificate validation** (never
disabled): a private/loopback/metadata address cannot present a valid certificate for the provider's fixed
hostname, so even a DNS-rebinding answer fails the TLS handshake — and this ADR adds **no new egress surface**. A **user custom `base_url`** is a
distinct egress/SSRF surface handled entirely by [ADR-0065](0065-provider-economics-and-extensibility.md)
(host-side `connectValidated`). Gemini's key is sent in the **`x-goog-api-key` header**, never the `?key=`
query param (a URL-log leak — [ADR-0006](0006-os-keychain-for-api-keys.md)).

### 10. Surfaces — `/models` (Home) and `relavium models refresh`

`/models` is a new REPL command ([ADR-0056](0056-cli-in-app-slash-command-system-and-manifest.md)),
`availableIn: ['home']`: it opens an **in-tree ink picker** over the merged catalog and, on selection, **writes
the next session's default** via [ADR-0063](0063-cli-config-write-contract.md) — it does **not** rebind the live
session. This deliberately **disambiguates** the *other* `/models`
([ADR-0059](0059-cli-mid-session-model-reseat.md), Phase 2.6 — mid-chat **live reseat**): 2.5.G's Home `/models`
is a next-session **config** action, not a reseat. `relavium models` / `relavium models refresh` is a new
`COMMAND_MANIFEST` shell pair (list-cache vs force-refresh) with a `--json` contract. The picker UX is
first-class: pricing display, dimmed-unavailable, deprecated flag, an unpriced "cost cap will not apply"
hint, a loading spinner, a per-provider partial-failure banner, and a "last updated" freshness badge.

## Consequences

### Positive

- **New models surface per key** — a provider's newly-shipped or tier-gated model appears without waiting for a
  `pricing.ts` edit; the catalog is authoritative for **availability** while the registry stays authoritative
  for **economics** — a clean separation of selection from pricing.
- **Drift-resilient and never-empty** — lenient inbound absorbs additive drift; a breaking change or an offline
  provider degrades to last-known → static, visibly, never a crash or an empty picker.
- **Reusable across every surface** — the `listModels?` seam method, the pure merge helper, and the injected-deps
  refresh service work identically for CLI, desktop, and VS Code (one engine, all surfaces).
- **Media routing unaffected** — the widening is additive; the existing narrow media-routing projection and its
  D15 load-check are untouched; soft-deactivation preserves every FK reference.
- **No new dependency, seam frozen in shape** — reuses the vendor SDKs already fenced under `adapters/*`; the seam
  gains one **optional** method (its method set is meant to grow; its shape stays frozen), amending
  [ADR-0011](0011-internal-llm-abstraction.md)/[0030](0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md)/[0031](0031-llm-seam-shape-amendment-multimodal-io.md)
  additively; the provider-id enum stays closed so no persisted-contract churn.

### Negative

- **A wider seam surface** (one optional method + a `kind` vocabulary) and a **`model_catalog` role inversion**
  with a migration. Mitigation: additive and forward-compatible ([ADR-0050](0050-cli-history-db-at-rest-posture.md)
  single-user local posture); the media projection is untouched; the inversion is recorded here so the two homes
  (static registry vs live cache) cannot be confused.
- **Live-cache staleness after key rotation** — a cached list can name models a newly-rotated key cannot call;
  mitigated by the "last updated" badge, the TTL refresh, and a graceful run-time "model not available for this
  key" failure. Serving stale-but-usable data is the deliberate offline-first trade.
- **Background-refresh lifecycle care** — a fire-and-forget refresh in a short-lived CLI must be `unref`'d, must
  not surface a stack, and must tolerate two concurrent `relavium` processes racing the DB write (WAL +
  `busy_timeout` already exist); getting this wrong hangs or corrupts the cache. Explicitly designed in (§5),
  not bolted on, and covered by the refresh orchestration's security/robustness review.
- **A residual DNS-rebinding gap on the vendor-SDK path** — the known-provider path uses only the
  construction-time string gate, not `connectValidated`; for the four **fixed public hosts** this is nil risk and
  documented. The custom-`base_url` hardening is [ADR-0065](0065-provider-economics-and-extensibility.md)'s.
- **A mandatory security review** — the seam egress and the refresh orchestration (which reads provider keys)
  each carry a dedicated security round before shipping (the [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md)
  precedent for a security-touching regime ADR).
- **Canonical reference docs pending update** — this ADR points to `llm-provider-seam.md` (the `listModels?` +
  `ModelListing` shape), `database-schema.md` (the `source` / `last_refreshed_at` columns), and `commands.md`
  (the `models` / `models refresh` family) as canonical homes that are **not yet updated**; those edits land in
  the implementing steps that add each artifact, matching ADR-0063's honest `config-spec.md` deferral.
- **Roadmap pull-forward** — this reverses the Phase-3 deferral of the live `/v1/models` fetch and supersedes
  2.5.G's static-only scope. The phase-2.5 § "Explicitly out of scope" and §2.5.G are **already reconciled in
  this doc round**, together with the sibling
  [phase-2.6-conversational-authoring.md](../roadmap/phases/phase-2.6-conversational-authoring.md) out-of-scope
  list.
