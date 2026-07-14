import { REASONING_EFFORTS, type ReasoningEffort } from '@relavium/shared';

import type { ReasoningControls } from './catalog/catalog-model.js';
import type { ProviderId } from './types.js';

/**
 * How Relavium's normalized reasoning tier becomes a PROVIDER-WIRE value — the one canonical home of that
 * mapping ([ADR-0066](../../../docs/decisions/0066-normalized-reasoning-effort-control.md),
 * [ADR-0071](../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §6).
 *
 * It used to live as four private consts inside three adapters. It moved here when a second consumer appeared:
 * `acceptedTiers`, which must compose these maps with the **catalog's** per-model wire values to decide which
 * tiers a model will actually accept. The composition is the whole fix for the maintainer's bug — `gpt-5.4-pro`
 * accepts `{medium, high, xhigh}` and rejects `low` — and it is only possible if the map and the catalog are
 * read together. Two copies of this map would be two chances to disagree about what we send to a provider.
 *
 * **The `off` tier is NOT an effort value on three of the four providers**, and that asymmetry is the reason a
 * literal read of the catalog's `effortValues` is actively wrong (it would drop `off` from every Claude model):
 *
 * | provider  | `off` is expressed as                     | so `off` is available when…                          |
 * |-----------|-------------------------------------------|------------------------------------------------------|
 * | anthropic | `thinking: { type: 'disabled' }`          | always — an independent switch, not an effort value   |
 * | deepseek  | `thinking: { type: 'disabled' }`          | always — likewise                                     |
 * | openai    | `reasoning_effort: 'none'`                | **only if `'none'` is in the model's effort values**   |
 * | gemini    | `thinkingConfig.thinkingBudget: 0`        | **only if the model takes a budget whose min is 0**    |
 *
 * That last row is what Google's docs say in prose and what the catalog says in one field: `gemini-2.5-pro` has
 * `budgetTokens.min = 128`, so it **cannot disable thinking at all** — and `off` must therefore not be offered
 * for it. `gemini-2.5-flash` has `min = 0`, so it can.
 */

/**
 * OpenAI's `reasoning_effort`. `off` maps to `'none'` — here it IS an effort value, unlike the other three. `max`
 * is the DEFAULT top (`'xhigh'`), but a model may publish a HIGHER `'max'` above it — see {@link openAiWireValue},
 * which reads the model's own ladder so the top tier is per-model, never a fixed alias.
 */
export const OPENAI_WIRE: Record<ReasoningEffort, 'none' | 'low' | 'medium' | 'high' | 'xhigh'> = {
  off: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh', // the DEFAULT top; a model that publishes `'max'` overrides this — see openAiWireValue.
};

/** OpenAI's per-model wire value for a tier (review M1). The `gpt-5.6` family publishes a distinct `'max'` ABOVE
 *  `'xhigh'`, so the top normalized tier must reach the model's OWN highest value, not stop one rung short at the
 *  static `'xhigh'`; a model with no published `'max'` (`gpt-5.4-pro`, top `'xhigh'`) keeps `OPENAI_WIRE.max`.
 *  ONE home for this — {@link wireValueFor}, {@link acceptedTiers}, {@link acceptedWireValue} and the adapter all
 *  read it, so they can never disagree about what "max" sends. */
export function openAiWireValue(
  tier: ReasoningEffort,
  controls: ReasoningControls,
): 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (tier === 'max' && controls.effortValues?.includes('max') === true) return 'max';
  return OPENAI_WIRE[tier];
}

/** Anthropic's `output_config.effort`. `off` is absent on purpose — it is `thinking: {type:'disabled'}` instead. */
export const ANTHROPIC_WIRE: Record<
  Exclude<ReasoningEffort, 'off'>,
  'low' | 'medium' | 'high' | 'max'
> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max', // Anthropic has a native `max`, so all four non-`off` tiers map 1:1.
};

/**
 * Gemini's `thinkingConfig.thinkingLevel`. `off` is absent: `MINIMAL` is the *lowest* level, **not** off — a
 * model set to MINIMAL still thinks. Disabling is `thinkingBudget: 0`, a different field entirely, which is why
 * mapping `off → MINIMAL` (as the shipped adapter does today) both fails to disable thinking and bills the user
 * for reasoning they asked not to have.
 */
/** Gemini's thinking ladder, in the CATALOG's (lowercase) vocabulary — the one name for the three levels it takes. */
export type GeminiWireLevel = 'low' | 'medium' | 'high';

export const GEMINI_WIRE: Record<Exclude<ReasoningEffort, 'off'>, GeminiWireLevel> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'high', // Gemini's ladder stops at HIGH; `max` coarsens onto it, honestly and documentedly.
};

/**
 * Every map above is spelled in the CATALOG's vocabulary — lowercase — because its first job is to be compared
 * against `ReasoningControls.effortValues`, which is what upstream publishes. Gemini's own `ThinkingLevel` enum
 * is the **uppercase** form of the same tokens (`HIGH`, not `high`), so its adapter upper-cases at the wire and
 * nowhere else. One map, two spellings of the same token — never two maps that can drift.
 */
const GEMINI_THINKING_LEVEL: Record<GeminiWireLevel, 'LOW' | 'MEDIUM' | 'HIGH'> = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
};
export const toGeminiThinkingLevel = (wire: GeminiWireLevel): 'LOW' | 'MEDIUM' | 'HIGH' =>
  GEMINI_THINKING_LEVEL[wire];

/**
 * DeepSeek's `thinking.reasoning_effort`. v4 exposes only two graded levels, so `low`/`medium`/`high` all
 * coarsen to `high` and `max` → `max`. `off` is `thinking: {type:'disabled'}`, an independent switch.
 */
export const DEEPSEEK_WIRE: Record<Exclude<ReasoningEffort, 'off'>, 'high' | 'max'> = {
  low: 'high',
  medium: 'high',
  high: 'high',
  max: 'max',
};

/**
 * The wire value a provider would send for a NON-`off` tier, or `undefined` if the provider has no such map.
 *
 * `controls` is consulted only for OpenAI's top tier (the model's own `'max'` vs the static `'xhigh'`, review M1);
 * omit it (the picker's dedup/projection path) and OpenAI's `max` falls to the default `'xhigh'` — which never
 * collides with another tier, so a dedup is unaffected. The gate/adapter path passes it for wire-exact truth.
 */
export function wireValueFor(
  provider: ProviderId,
  tier: Exclude<ReasoningEffort, 'off'>,
  controls?: ReasoningControls,
): string | undefined {
  switch (provider) {
    case 'openai':
      return openAiWireValue(tier, controls ?? {});
    case 'anthropic':
      return ANTHROPIC_WIRE[tier];
    case 'gemini':
      return GEMINI_WIRE[tier];
    case 'deepseek':
      return DEEPSEEK_WIRE[tier];
  }
}

/**
 * Does this model publish **any** control at all?
 *
 * An EMPTY descriptor (`{}` — `deepseek-reasoner`) is not the same as no descriptor. The model reasons; upstream
 * simply declined to describe a knob for it. The honest reading is that there is nothing to turn, so every
 * predicate below answers `false` for it and the field is withheld entirely.
 */
function hasAnyControl(controls: ReasoningControls): boolean {
  return (
    controls.effortValues !== undefined ||
    controls.budgetTokens !== undefined ||
    controls.toggle === true
  );
}

/**
 * Can this adapter express a tier the model's effort ladder does NOT contain, as a **token budget** instead?
 *
 * Only two of the four can. Anthropic takes `thinking.budget_tokens` and Gemini takes `thinkingBudget`, so for
 * those a budget axis genuinely widens what the model accepts. OpenAI's `reasoning_effort` and DeepSeek's
 * `thinking.reasoning_effort` are effort-shaped and nothing else: a budget in the catalog is a fact about the
 * MODEL that our request for it cannot use.
 *
 * This is why {@link acceptedTiers} cannot simply union the two axes. A blind union would have the picker offer
 * every tier for an OpenAI model that publishes a budget, and the adapter — which has no field to put it in —
 * would withhold. That is the picker/wire divergence in a new costume.
 */
function honorsBudget(provider: ProviderId): boolean {
  return provider === 'anthropic' || provider === 'gemini';
}

/**
 * Can this model turn reasoning **off** at all?
 *
 * Not a preference — a capability, and the four providers answer it in three different places (see the table
 * above). `gemini-2.5-pro` genuinely cannot: Google's documentation says *"N/A: Cannot disable thinking"*, and
 * the catalog says the same thing in one field (`budgetTokens.min = 128`). Offering `off` for it would send a
 * value the API rejects — which is the entire class of bug this work exists to close.
 */
export function canDisableReasoning(provider: ProviderId, controls: ReasoningControls): boolean {
  // A model that publishes NO knob cannot be proven to have an off switch either. Asking here — rather than
  // relying on every caller to pre-gate — is what stops the next adapter from sending `thinking: {disabled}` to
  // `deepseek-reasoner` on the strength of "well, the PROVIDER can usually disable it".
  if (!hasAnyControl(controls)) return false;
  switch (provider) {
    case 'anthropic':
    case 'deepseek':
      // An independent `thinking: {type:'disabled'}` switch — available on any model that has a knob at all.
      return true;
    case 'openai':
      // `off` IS an effort value here, so the model must actually accept `'none'`.
      return controls.effortValues?.includes(OPENAI_WIRE.off) === true;
    case 'gemini':
      // Disabling is `thinkingBudget: 0`. A model whose budget floor is above zero cannot express it; a `toggle`
      // is an explicit on/off and can.
      return controls.toggle === true || controls.budgetTokens?.min === 0;
  }
}

/**
 * The tiers a model will ACTUALLY accept — computed from the catalog's per-model control, never copied from it
 * ([ADR-0071](../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §6).
 *
 * `undefined` controls ⇒ the model does not reason ⇒ the empty set. An **empty descriptor** (`{}`) is different
 * and real (`deepseek-reasoner`): the model reasons, but exposes **no controllable tier**, so the set is empty
 * too — and that is what tells the picker to offer *nothing* rather than to offer *everything*, which is exactly
 * today's bug.
 *
 * The axes UNION — a model may publish both, and several do:
 *   - **Effort values** → a tier is accepted iff its wire value is one of them. This is where `gpt-5.4-pro`
 *     rejects `low` and `gpt-5-pro` accepts only `high`.
 *   - **A token budget**, on a provider whose adapter has a budget field ({@link honorsBudget}) → every non-`off`
 *     tier is reachable, because the adapter maps the tier onto a point inside `[min, max]`. This is how
 *     `claude-haiku-4-5` (a budget and no ladder) is controllable at all, and how `claude-opus-4-5` serves `max`
 *     — a tier its ladder omits — without a 400.
 *   - **Neither** → no gradation exists; only `off` survives, and only if the model can be disabled at all.
 */
export function acceptedTiers(
  provider: ProviderId,
  controls: ReasoningControls | undefined,
): ReadonlySet<ReasoningEffort> {
  const accepted = new Set<ReasoningEffort>();
  if (controls === undefined) return accepted; // The model does not reason at all.

  // An EMPTY descriptor (`deepseek-reasoner`) means the model reasons but exposes NO control — not even an off
  // switch we can prove exists. The safe answer is the empty set: the field is withheld entirely and the picker
  // offers nothing. Adding `off` here on the provider's general ability to disable would be a guess about a
  // model whose capability upstream declined to describe, and a guess is what put a rejected value on the wire
  // in the first place.
  if (!hasAnyControl(controls)) return accepted;

  const gradable = REASONING_EFFORTS.filter(
    (tier): tier is Exclude<ReasoningEffort, 'off'> => tier !== 'off',
  );

  // The two axes are a UNION, not an either/or. `claude-opus-4-5` publishes BOTH — `effortValues: [low, medium,
  // high]` and `budgetTokens: {min: 1024}` — and its adapter already falls back to the budget for a tier the
  // ladder does not carry. An exclusive `else if` here would have hidden `max` from the picker for a model that
  // serves it perfectly well: the acceptance set must describe what the ADAPTER can send, not one axis of it.
  if (controls.effortValues !== undefined) {
    const values = new Set(controls.effortValues);
    for (const tier of gradable) {
      const wire = wireValueFor(provider, tier, controls);
      if (wire !== undefined && values.has(wire)) accepted.add(tier);
    }
  }
  if (controls.budgetTokens !== undefined && honorsBudget(provider)) {
    // A budget is continuous — every tier maps onto a point inside [min, max], so all of them are reachable.
    // Only for a provider whose adapter HAS a budget field, though; see {@link honorsBudget}.
    for (const tier of gradable) accepted.add(tier);
  }

  if (canDisableReasoning(provider, controls)) accepted.add('off');
  return accepted;
}

/** The single normalized tier that represents "reasoning ON" for a budget-shaped model (ADR-0066 amendment). It is
 *  `medium` — a mid budget, always a member of a budget model's accepted set (the budget axis fills every tier) —
 *  so mapping "on" to it needs ZERO adapter change and the engine gate accepts it verbatim. */
export const CANONICAL_ON_TIER: ReasoningEffort = 'medium';

/**
 * The PRESENTATION shape of a model's reasoning control (ADR-0066 amendment) — how a picker should OFFER it, as
 * distinct from the wire-accurate {@link acceptedTiers}:
 *   - **`'graded'`** — a discrete effort ladder (`effortValues`). A picker shows its rungs, deduped by distinct wire
 *     value (several normalized tiers can collapse onto one provider value — DeepSeek's low/medium/high all map to
 *     `high`; Gemini's `max` onto `high`).
 *   - **`'budget'`** — a continuous token budget and no ladder (`budgetTokens`, e.g. `claude-haiku-4-5`). A budget
 *     has no meaningful discrete rungs, so a picker offers a simple off/on (Claude-Code parity), "on" =
 *     {@link CANONICAL_ON_TIER}.
 *   - **`'none'`** — nothing controllable (`{}` like `deepseek-reasoner`, or a lone toggle with no tier to map "on"
 *     to). No overlay.
 *
 * `effortValues` WINS over a co-published budget (`claude-opus-4-5` publishes both): a real ladder is shown as one.
 * This is PRESENTATION metadata; {@link acceptedTiers} (the wire truth the gate/failover/adapters read) is unchanged.
 */
export function reasoningControlShape(
  controls: ReasoningControls | undefined,
): 'graded' | 'budget' | 'none' {
  if (controls === undefined) return 'none';
  if (controls.effortValues !== undefined && controls.effortValues.length > 0) return 'graded';
  if (controls.budgetTokens !== undefined) return 'budget';
  return 'none';
}

/**
 * The wire value to send for a tier — **only if the model actually publishes it**. `undefined` otherwise.
 *
 * The adapters used to branch on `controls.effortValues !== undefined` — the PRESENCE of the effort axis — and
 * then send the mapped value unchecked. Presence is not membership, and the difference is a 400:
 *
 *   `claude-opus-4-5` publishes ['low','medium','high'] — **no 'max'**. Tier `max` → `output_config.effort: 'max'`.
 *   `gemini-3-pro-preview` publishes ['low','high'] — **no 'medium'**. Tier `medium` → `thinkingLevel: 'MEDIUM'`.
 *
 * Both reach the wire through a FAILOVER, where the chain re-points a request at a weaker model. `acceptedTiers`
 * already encodes the correct rule; this is the same rule, exposed so an adapter can never re-derive a weaker one.
 */
export function acceptedWireValue(
  provider: ProviderId,
  tier: Exclude<ReasoningEffort, 'off'>,
  controls: ReasoningControls,
): string | undefined {
  const wire = wireValueFor(provider, tier, controls);
  if (wire === undefined || controls.effortValues === undefined) return undefined;
  return controls.effortValues.includes(wire) ? wire : undefined;
}

/** How much of a model's thinking-budget range each tier spends. `max` means "all of it". */
const BUDGET_FRACTION: Record<Exclude<ReasoningEffort, 'off'>, number> = {
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  max: 1,
};

/**
 * The share of a request's output cap that thinking may consume. The rest is the ANSWER's.
 *
 * Without it, `max` spends **100% of the cap on thoughts** — `budget_tokens: max_tokens - 1` on Anthropic leaves
 * exactly one token for the reply, and on Gemini `thinkingBudget == maxOutputTokens` leaves none at all. Both are
 * accepted by the provider and both are useless: the user pays for a full turn of reasoning and gets no answer.
 * A ceiling that reserves nothing for the output is not a ceiling.
 */
export const THINKING_BUDGET_SHARE = 0.8;

/** The thinking ceiling for a request whose output cap is `maxTokens` — reserving room for the answer itself. */
export function thinkingCeiling(maxTokens: number): number {
  return Math.floor(maxTokens * THINKING_BUDGET_SHARE);
}

/**
 * Map a normalized tier onto a **token budget** for a budget-shaped model — `claude-haiku-4-5`, `gemini-2.5-pro`,
 * and every other model whose tier the effort ladder cannot express.
 *
 * `ceiling` is the caller's hard upper bound, and it is not optional theatre: Anthropic requires
 * `budget_tokens < max_tokens`, so a budget derived from the catalog alone can exceed the request's own output
 * cap and be rejected. `claude-haiku-4-5` publishes `{ min: 1024 }` with **no max**, which is precisely the case
 * where the range has to come from the request. The adapter passes what it can honour; this stays pure.
 *
 * **Returns `undefined` when no budget in the range fits under the ceiling** — see the comment on the guard
 * below. The caller must then WITHHOLD the field: there is no legal value to send.
 */
/**
 * Would the adapter WITHHOLD reasoning for this tier purely because the request's output cap is too small (review
 * M6)? True only on the budget-shaped path — an effort-ladder tier carries no budget, and `off` is a switch — and
 * only when the model's minimum thinking budget cannot fit under `thinkingCeiling(maxTokens)`. This is the SAME
 * predicate the adapters act on (they call {@link reasoningBudgetFor} directly), lifted so the gate can SAY the tier
 * was dropped rather than the adapter dropping it in silence. `budget-only` models (`claude-haiku-4-5`) route every
 * tier here; a model with a matching effort rung (`claude-opus-4-5` for `high`) does not.
 */
export function reasoningWithheldByCap(
  provider: ProviderId,
  controls: ReasoningControls,
  tier: Exclude<ReasoningEffort, 'off'>,
  maxTokens: number,
): boolean {
  if (!honorsBudget(provider)) return false; // OpenAI/DeepSeek have no budget field — nothing cap-sensitive
  if (acceptedWireValue(provider, tier, controls) !== undefined) return false; // reachable via the effort ladder
  if (controls.budgetTokens === undefined) return false; // not budget-shaped → the tier is simply unaccepted, not capped
  return reasoningBudgetFor(tier, controls.budgetTokens, thinkingCeiling(maxTokens)) === undefined;
}

export function reasoningBudgetFor(
  tier: Exclude<ReasoningEffort, 'off'>,
  range: { readonly min: number; readonly max?: number },
  ceiling: number,
): number | undefined {
  const hi = Math.min(range.max ?? ceiling, ceiling);
  // THE RANGE DOES NOT EXIST. Anthropic requires `budget_tokens < max_tokens`, so a request whose own output cap
  // is at or below the model's MINIMUM thinking budget (haiku's floor is 1024) has no valid budget to send at all.
  //
  // The first version returned `range.min` here — "the least thinking the model can do" — and that is a 400: with
  // `max_tokens: 256` it put `budget_tokens: 1024` on the wire. The honest answer is that reasoning cannot be
  // enabled under this cap, so the caller WITHHOLDS the field. The tempting alternative — quietly raising
  // `max_tokens` to make room — would change what the user asked for and what they pay, without telling them.
  // `hi === range.min` is NOT degenerate: the floor itself is a valid budget, and it still sits strictly below the
  // caller's cap (the caller passes `maxTokens - 1` as the ceiling). Only `hi < min` means no budget exists at all.
  if (hi < range.min) return undefined;
  return Math.round(range.min + (hi - range.min) * BUDGET_FRACTION[tier]);
}
