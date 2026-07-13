# ADR-0066: Normalized reasoning-effort control — a provider-agnostic tier, per-adapter native mapping, and a per-model capability

- **Status**: Accepted
- **Date**: 2026-07-06
- **Related**: [ADR-0011](0011-internal-llm-abstraction.md) (the `LLMProvider` seam this amends — a new `LlmRequest` field), [ADR-0030](0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md) (added the reasoning **output** channel; this ADR adds the reasoning **input** control), [ADR-0039](0039-same-provider-reasoning-replay.md) (same-provider signed-reasoning replay — the output whose *production* this input governs), [ADR-0064](0064-live-model-catalog.md) (the `model_catalog.capabilities` JSON this populates per model), [ADR-0059](0059-cli-mid-session-model-reseat.md) (the `/models` picker that surfaces the effort selector), [llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md) (the seam's one canonical home), [agent-yaml-spec.md](../reference/contracts/agent-yaml-spec.md) + [config-spec.md](../reference/contracts/config-spec.md) (the authoring surfaces)

> Accepted 2026-07-06 (the 2.5.G "reasoning-effort" workstream, maintainer question #1). Two independent ADR reviews caught that the original draft's "OpenAI = tier, Anthropic/Gemini = token budget" split was **stale**: all four currently-targeted providers are **tier-native**, and the shipped adapters already merge `{...providerOptions, ...body}` (canonical wins). The Decision below is rewritten around that — a strictly *simpler* design (one tier → each provider's native tier), with the token-budget derivation demoted to a documented legacy fallback.
>
> **Note (2026-07-07): DeepSeek wired + its native shape refined (§2/§4).** DeepSeek was initially DEFERRED (the OpenAI-compatible adapter had no pinned SDK to verify the param against). Its create-chat-completion API was then verified against the official docs (api-docs.deepseek.com): v4 takes a **`thinking` object** — `type: 'enabled' | 'disabled'` + `reasoning_effort: 'high' | 'max'` — richer than §2's assumed "on/off only". The adapter now maps `off` → `{ type: 'disabled' }`, `low`/`medium`/`high` → `{ type: 'enabled', reasoning_effort: 'high' }` (DeepSeek's minimum thinking level), and `max` → `{ type: 'enabled', reasoning_effort: 'max' }` (an honest coarsening onto v4's two graded levels); `deepseek-v4-flash`/`-pro` are `reasoning: true`, the §4 heuristic covers `deepseek-v[4-9]`, and the legacy non-thinking `deepseek-chat` alias stays uncontrollable. So the §2 DeepSeek row's "on/off, no graded tiers" — and the matching on/off phrasing in Consequences → Negative — are both superseded by the doc-verified `thinking` shape here (off / high / max); the reasoning **output** (`reasoning_content`) + token accounting were already mapped.
>
> **Note (2026-07-07): interactive `/effort` overlay realized (§6).** §6 anticipated "a future `/effort`" for standalone effort changes; it is now shipped as a first-class **interactive tier-selector overlay** (not just a typed `/effort <tier>` — that still works). Bare `/effort` (typed or selected from the `/` palette) opens a keyboard-owning overlay — a fixed off/low/medium/high/max list, opening on the bound tier, arrow+Enter to apply — in BOTH `relavium chat` and the in-Home live chat, sharing one pure fold ([effort-picker.ts](../../apps/cli/src/render/tui/effort-picker.ts)) and one view ([effort-tier-list.tsx](../../apps/cli/src/render/tui/effort-tier-list.tsx), also used by the `/models` effort sub-step). Applying calls the §5 per-turn `onSetEffort` — **no reseat**. It opens ONLY on a reasoning-capable bound model; a non-reasoning model falls through to the informational notice (`<model> has no controllable reasoning tier`). This realizes §6's "standalone effort changes ride the same session override" — from a promise to a shipped surface. (§6's separate point, that the bare-Home picker writes only the config default and not a live session's effort, is unchanged here — a follow-up gives that picker its own effort sub-step.)
>
> **Note (2026-07-07): the bare-Home `/models` picker gained an effort sub-step (§6, superseding "config default only").** §6 said the bare-Home picker "writes the config default, not a live session's effort" and stays single-phase. It is now **two-phase for a reasoning model** on BOTH surfaces: picking a reasoning-capable model advances to the effort sub-step (opened on the current default tier), and accepting writes the model AND its effort tier as the NEXT session's defaults. This required a **new global config key**, `[preferences].reasoning_effort` (the effort counterpart of `default_model`), added to `GlobalConfigSchema`; the CLI config writer generalized to `writeGlobalPreferences({ defaultModel?, reasoningEffort? })` (ADR-0063 §note), writing both in one atomic, schema-round-tripped write (a partial write leaves the other key unchanged); and `resolveChat` now falls back to `[preferences].reasoning_effort` below the `[chat]` layers — the exact precedence `default_model` already has. So a user can set BOTH their default model and default effort from the Home without starting a chat. A live in-Home chat's `/models` effort sub-step still sets the per-turn override (no reseat, §5) rather than writing config — the accept action is surface-specific, off the one picker.
>
> **Note (2026-07-13): a PREMISE of this ADR is FALSE, and it shipped as a live bug — corrected by
> [ADR-0071](0071-models-dev-as-the-model-metadata-source.md).**
>
> §1 below states: *"All four currently-targeted providers control reasoning by a discrete **TIER, not a token
> budget** … Gemini (a thinking-level field) … The older 'token budget' shapes (pre-`output_config` Anthropic,
> **Gemini 2.5**) are **legacy**."*
>
> That sentence is defensible about the industry and **wrong about the models we actually ship**. Google's
> documentation for the `generateContent` API this project calls is explicit — *"Gemini 2.5 series models don't
> support `thinkingLevel`; use `thinkingBudget` instead"* — and `gemini-2.5-pro` **cannot disable thinking at
> all** (`thinkingBudget` 128–32768, no zero). `gemini-2.5-flash` and `gemini-2.5-pro` are the **only two Gemini
> rows in `MODEL_PRICING`**. So the shape this ADR set aside as "legacy" is the shape of **every Gemini model we
> ship**, and the adapter has been sending them a `thinkingLevel` they do not take.
>
> The error was **structural, not clerical**. This ADR made the native shape a property of the **adapter** and
> the capability a per-model `boolean`. A boolean cannot say *"this model takes a token budget in [128, 32768]
> and has no off switch"* — so the bug had nowhere to be caught, and a test could not have found it either.
> [ADR-0071](0071-models-dev-as-the-model-metadata-source.md) makes the control's **shape** and its **accepted
> tiers** per-model data from a catalog; the adapter then selects `thinkingLevel` vs `thinkingBudget` from that
> descriptor rather than assuming one for the whole provider.
>
> **What survives, unchanged:** the normalized five-tier vocabulary (`off|low|medium|high|max`), the
> canonical-wins-over-`providerOptions` precedence, the `/effort` overlay, and the host-gated design. What
> changes is only that a model now *declares* which tiers it accepts and which native shape carries them,
> instead of the adapter assuming both.

> **Note (2026-07-14): the PICKER now presents "one row per distinct outcome", separate from the wire-accurate
> accepted set (§6 presentation refinement — append-only, the seam is unchanged).** `acceptedTiers` correctly
> answers what the WIRE takes, but it made a poor MENU: it offered five rows for models that expose fewer real
> choices, because several normalized tiers can collapse onto one provider value (DeepSeek's low/medium/high all
> send `high`; Gemini's `max` coarsens onto `high`) and because a continuous token BUDGET has no discrete rungs at
> all (`claude-haiku-4-5` — the maintainer's report: a five-tier ladder where the model is really on/off, à la
> Claude Code). A new PRESENTATION helper `reasoningControlShape(controls)` → `graded | budget | none` and a
> `CANONICAL_ON_TIER` (= `medium`) drive a CLI projection (`effortTiersFor`, `effortRowLabel` in
> `chat/effort-notice.ts`): a **graded** ladder is deduped by distinct wire value (the representative reads the
> name that matches the wire); a **budget** model is a two-row **off/on** ("on" = `medium`, a real member of the
> accepted set, so the accept sends a value the gate accepts verbatim — a model that cannot be turned off, like
> `gemini-2.5-pro`, has nothing to toggle, so no overlay opens); **none** shows nothing. This is presentation only:
> `acceptedTiers` (the wire truth the engine gate, failover chain, and four adapters read) is untouched, so every
> emitted row is still a valid accepted tier. The rule is GENERAL (by shape), never per-model.

## Context

Reasoning models expose a **control** over how much the model "thinks" before answering. Relavium's seam already has the reasoning **output** side (ADR-0030: the streaming `reasoning_*` channel + `reasoningTokens` observability + the `reasoning` content arm, mapped per adapter). It has **no normalized INPUT control**: a caller who wants "think harder" must reach the raw `providerOptions` escape hatch with provider-specific keys — which defeats the provider-agnostic promise, cannot be authored portably in agent YAML, and cannot be surfaced in the `/models` picker.

Two facts, verified against the current provider surfaces and this repo, shape the decision:

1. **All four currently-targeted providers control reasoning by a discrete TIER, not a token budget.** OpenAI (`reasoning_effort`), Anthropic (an `output_config` effort field — the adapter already writes `output_config` for structured output, [anthropic.ts:477](../../packages/llm/src/adapters/anthropic.ts)), Gemini (a thinking-level field), and DeepSeek-v4 (a thinking on/off request param on a single id — `deepseek-v4-flash`/`-pro`, where *"the mode is a request param, not a separate model,"* [pricing.ts](../../packages/llm/src/pricing.ts)). The older "token budget" shapes (pre-`output_config` Anthropic, Gemini 2.5) are legacy.

2. **`CapabilityFlags.reasoning` is populated only at the ADAPTER level today** — `true` for DeepSeek ([openai.ts:98](../../packages/llm/src/adapters/openai.ts)), `false` for the other three ([openai.ts:80](../../packages/llm/src/adapters/openai.ts), [anthropic.ts:63](../../packages/llm/src/adapters/anthropic.ts), [gemini.ts:67](../../packages/llm/src/adapters/gemini.ts)) — when reasoning is genuinely a **per-model** property (o-series reasons, `gpt-4o` does not, though both share the OpenAI adapter; `claude-opus-4-8` reasons). The per-model `model_catalog.capabilities` column exists (ADR-0064) but is not yet populated per model.

The user-facing ask (question #1): when picking a model, choose a reasoning-effort tier, like the competitors — which requires the tier to be a first-class, provider-agnostic concept end to end.

## Decision

**We normalize reasoning effort as a provider-agnostic TIER on the `LlmRequest`, map it inside each adapter to that provider's native tier control, gate it on a host-injected per-MODEL capability, and thread it per turn (like `temperature`) — not as a session reseat. The token-budget derivation survives only as a legacy fallback. The `providerOptions` escape is untouched.**

### 1. A normalized `reasoningEffort` tier on the seam (`LlmRequest`)

Add `reasoningEffort?: ReasoningEffort` to `LlmRequestSchema` (`@relavium/llm`), where `ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max'` is a new closed vocabulary owned by `@relavium/shared` (a `REASONING_EFFORTS` const tuple, like `STOP_REASONS` / `FS_SCOPE_TIERS`). Five levels (maintainer choice): `off` disables reasoning where the provider allows it; `low`/`medium`/`high` map to the provider's matching tier; `max` maps to the provider's **highest** available tier (so a provider that tops out lower than another still gets "as hard as it goes").

- **Absent** ⇒ the provider default (byte-identical to today — no behavior change for an unset field).
- **Precedence:** the normalized field's per-adapter mapping is CANONICAL and **wins** over any colliding `providerOptions` key — consistent with every shipped adapter's `return { ...req.providerOptions, ...body }` merge (canonical last, [anthropic.ts:512](../../packages/llm/src/adapters/anthropic.ts) / [openai.ts:717](../../packages/llm/src/adapters/openai.ts)), and with Gemini's deliberate "canonical wins so a caller can't override transport keys". `providerOptions` remains for *non-colliding* provider-specific reasoning knobs (e.g. a raw legacy budget on an old model, §3) — it adds, it does not override the tier.

This **amends ADR-0011** (a new optional `LlmRequest` field, no vendor type) and **complements ADR-0030** (which shaped the reasoning *output*; this is the *input* that governs its production — see ADR-0039 for the replay of that output).

### 2. Per-adapter mapping — the tier→native translation lives INSIDE each adapter

Each adapter maps the one normalized tier to its provider's native tier; nothing tier-shaped leaks out, and no vendor type crosses the seam. The exact native field NAMES are pinned in the adapter against its SDK types (the ground truth), not frozen in this ADR:

| Adapter | Native shape | `off` | `low`/`medium`/`high`/`max` |
|---------|--------------|-------|-----------------------------|
| **OpenAI-compatible** (OpenAI) | `reasoning_effort` tier | `'none'` (or the lowest the model accepts; an always-on o-series model has no true off → lowest) | pass the matching tier; `max` → the highest tier the model accepts |
| **Anthropic** | the `output_config` effort tier (already-used `output_config`) | omit / disabled where the model allows; else lowest | the matching tier; `max` → highest |
| **Gemini** | the thinking-level tier | `0`/lowest **only where the model allows** (Flash-class); a Pro-class model that cannot disable → lowest tier | the matching tier; `max` → highest |
| **DeepSeek** (OpenAI-compatible, v4 id) | thinking on/off request param | thinking **off** | thinking **on** (v4 has on/off, not graded tiers, so `low`/`medium`/`high`/`max` all enable thinking — an honest, documented coarsening) |

A model that does not support reasoning (§4) never receives the field — the engine gates it off before the adapter, and each adapter additionally ignores it defensively.

### 3. The token-budget derivation — a documented LEGACY fallback only

For a **legacy** model that still takes a token budget rather than a tier (pre-`output_config` Anthropic, Gemini 2.5), a pure `deriveReasoningBudget(tier, maxTokens)` helper (`@relavium/llm`) maps the tier to a token count — fixed per-tier constants clamped **below `maxTokens`** with a headroom reserve (a budget must leave room for the answer). This path is **not** the primary mechanism (the four current models are tier-native, §2); it exists so an old model id still routed through an adapter degrades gracefully instead of erroring. Its constants live in one home and are **not** a billing input (reasoning tokens are counted inside output, ADR-0030). Note the intrinsic sharp edge the normalized tier cannot paper over: OpenAI o-series `max_tokens` is a *total* cap (reasoning + answer), so a high tier under a very small `max_tokens` can starve the answer — inherent model behavior, surfaced honestly, not a seam defect.

### 4. Reasoning is a per-MODEL capability, read via a host-injected resolver

The authoritative "does THIS model reason" is the per-model **`model_catalog.capabilities.reasoning`** boolean (ADR-0064) — which projects onto `CapabilityFlags.reasoning`; it is simply **not populated per model today**. This ADR populates it: a static capability seed + a conservative **model-id heuristic** for the known reasoning families (OpenAI o-series / reasoning `gpt-5`, `claude-opus-4-8` + extended-thinking Sonnet, Gemini thinking models, `deepseek-v4-*`), so a live-discovered model whose list-endpoint omits the flag still gates correctly (the same maintenance shape as the static `MODEL_PRICING` registry).

Because `packages/core` has **zero platform imports** (CLAUDE.md #5) it cannot read `@relavium/db`. The engine therefore reads the capability through a **host-injected resolver** — `resolveReasoning?: (model: string) => boolean | undefined` on `AgentRunnerDeps`/`SessionDeps`, mirroring the existing `resolveMediaSurface` catalog projection ([agent-runner.ts:92](../../packages/core/src/engine/agent-runner.ts)). Absent resolver ⇒ treat as not-reasoning (safe: the field is not sent). The `/models` picker uses the same catalog projection to OFFER the effort selector only for reasoning-capable models. The adapter's static `supports.reasoning` stays the adapter-level backstop.

### 5. Authoring + plumbing — a per-turn field, resolved agent → config → session

`reasoningEffort` is structurally a **per-turn request field, like `temperature`/`maxTokens`** — NOT a plan-changing binding. So (a reviewer's correction to the draft) a mid-session effort change is a **lightweight per-turn update**, never the heavier ADR-0059 reseat (which exists because a *model* change alters the provider, pricing, and the memoized `#plan` — an *effort* change alters none of those). Resolution order per turn: **session override → agent `reasoning_effort` → `[chat].reasoning_effort` config default → unset (provider default)**.

- **Agent YAML** (`@relavium/shared` `AgentSchema`, `.strict()` — an additive, non-breaking field): `reasoning_effort?: ReasoningEffort` (snake_case authored), so a committed agent pins its effort.
- **Config** (`config-spec.md`): `[chat].reasoning_effort` — the chat-surface default.
- **Engine** (`packages/core`): the `AgentRunner` reads the resolved effort into each turn's `LlmRequest.reasoningEffort`, gated by `resolveReasoning` (§4); `AgentSession` gains a session-level effort override + setter (mirroring the mode control) so an interactive surface can change it mid-session with no reseat. The one seam field is the only new cross-package contract; the engine read + the session setter are platform-agnostic.

### 6. The surface — the `/models` picker effort selector (the user's ask)

The `/models` picker (ADR-0059/2.5.G Step D) surfaces the effort: selecting a **reasoning-capable** model offers a low/medium/high/max sub-choice (a non-reasoning model skips it), setting the session's per-turn effort override (§5) — **not** a reseat, so it takes effect on the next turn with no teardown. Standalone effort changes ride the same session override (a future `/effort`), and an authored agent carries its own default. The bare-Home picker (ADR-0064 §10, next-session default) is orthogonal — it writes the config default, not a live session's effort. This ADR fixes the **data + seam** so every surface speaks one vocabulary.

Considered and rejected: **(a) providerOptions-only** (the status quo — not provider-agnostic, unauthorable, un-surfaceable — the gap this closes); **(b) a normalized token-budget field** instead of a tier (a token count is not the user's vocabulary and is now wrong for *all four* tier-native providers — the tier is the lowest common denominator, budgets a legacy fallback); **(c) a discriminated `{tier}|{budget}` seam union** (pushes provider-shape into the contract; `providerOptions` already serves the exact-budget power user); **(d) effort as a per-session binding changed via reseat** (rejected: effort changes neither provider nor pricing nor the memoized plan, so a reseat is unwarranted overhead — it is a per-turn field).

## Consequences

### Positive

- One provider-agnostic effort vocabulary end to end: authorable in git-committed agent YAML, surfaced in the `/models` picker, changed mid-session with no reseat — the same concept regardless of which provider backs the model.
- The tier-native mapping is *simpler* than the original budget design (one tier → each provider's native tier; budget only a legacy fallback), and matches how the current providers actually work.
- Per-model correctness: the effort selector + the sent field are gated on the actual model via the catalog projection, not a coarse per-provider flag.
- The `providerOptions` escape is preserved with the shipped canonical-wins precedence, so a power user (an exact legacy budget) is never worse off and the adapter merge stays consistent.

### Negative

- The per-model reasoning capability relies on a static seed + an id heuristic until providers expose the flag in list-models (§4) — a genuinely-new reasoning model id may need a heuristic/seed touch (the media-routing-seed maintenance shape).
- `off` on an always-on reasoning model (o-series, `deepseek`-thinking-on) cannot truly disable thinking; it degrades to the minimum, documented per adapter (§2) rather than silently ignored.
- `max` cannot express a level a given provider does not have; it maps to that provider's highest tier (a documented coarsening, §1/§2).
- DeepSeek-v4's on/off (no graded tiers) coarsens `low`/`medium`/`high`/`max` to "thinking on" (§2) — honest, not hidden.

### Neutral

- Amends ADR-0011 + complements ADR-0030/0039 **append-only** (a new optional field + a populated existing capability); no existing behavior changes for an unset `reasoningEffort`. No new runtime dependency.
- The exact native field names are deliberately left to each adapter's SDK-typed implementation (the ground truth), not frozen here — so a provider renaming a field is an adapter edit, not an ADR supersede.
