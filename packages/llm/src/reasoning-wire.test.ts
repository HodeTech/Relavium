import { describe, expect, it } from 'vitest';

import { CATALOG_SNAPSHOT } from './catalog/snapshot.js';
import {
  acceptedTiers,
  acceptedWireValue,
  canDisableReasoning,
  openAiWireValue,
  reasoningBudgetFor,
  reasoningControlShape,
  reasoningWithheldByCap,
  thinkingCeiling,
  wireValueFor,
} from './reasoning-wire.js';

/**
 * THE EFFORT BRIDGE (ADR-0071 §6) — the fix for the maintainer's bug report, and the one place a literal read of
 * the catalog is actively harmful.
 *
 * The catalog's `effortValues` are **provider-wire** strings; Relavium's tiers are a different vocabulary. Read
 * one as the other and you drop `off` from every Claude model (where `off` is `thinking:{disabled}`, not an
 * effort value) and drop `off`+`max` from `gpt-5.5`. So the accepted set is COMPUTED — and these tests compute
 * it against the REAL shipped catalog, not against fixtures, because a bridge that is right about a fixture and
 * wrong about `gemini-2.5-pro` is worth nothing.
 */

const tiers = (modelId: string): string[] => {
  const model = CATALOG_SNAPSHOT[modelId];
  if (model === undefined) throw new Error(`${modelId} is not in the shipped catalog`);
  return [...acceptedTiers(model.provider, model.reasoning)].sort();
};

describe('reasoningControlShape — the PRESENTATION shape a picker projects (ADR-0066 amendment)', () => {
  it("effortValues ⇒ 'graded', even alongside a co-published budget (claude-opus-4-5 has both)", () => {
    expect(reasoningControlShape({ effortValues: ['medium', 'high', 'xhigh'] })).toBe('graded');
    expect(
      reasoningControlShape({
        effortValues: ['low', 'medium', 'high'],
        budgetTokens: { min: 1024 },
      }),
    ).toBe('graded');
    expect(reasoningControlShape({ toggle: true, effortValues: ['high', 'max'] })).toBe('graded');
  });

  it("a budget with no ladder ⇒ 'budget' (the off/on case)", () => {
    expect(reasoningControlShape({ budgetTokens: { min: 1024 } })).toBe('budget');
    expect(reasoningControlShape({ toggle: true, budgetTokens: { min: 0, max: 24576 } })).toBe(
      'budget',
    );
  });

  it("no usable knob ⇒ 'none' (empty descriptor, a lone toggle, or absent)", () => {
    expect(reasoningControlShape({})).toBe('none'); // deepseek-reasoner: reasons, no control
    expect(reasoningControlShape({ effortValues: [] })).toBe('none'); // an empty ladder is no ladder
    expect(reasoningControlShape({ toggle: true })).toBe('none'); // no tier to map "on" to
    expect(reasoningControlShape(undefined)).toBe('none'); // does not reason
  });
});

describe('the bug report — gpt-5.4-pro REJECTS the tier we offer it today', () => {
  it('accepts {medium, high, max} and NOT low, NOT off', () => {
    // Catalog: effortValues ['medium','high','xhigh']. Our wire map: max→'xhigh', low→'low', off→'none'.
    // So `low` and `off` have no wire value the model takes — and today's picker offers both, which is the 400.
    expect(tiers('gpt-5.4-pro')).toEqual(['high', 'max', 'medium']);
  });

  it('gpt-5-pro accepts ONLY high — a single-tier model, which a boolean could never express', () => {
    expect(tiers('gpt-5-pro')).toEqual(['high']);
  });

  it('gpt-5.5 keeps ALL FIVE — a literal read of its values would have dropped off and max', () => {
    // Its wire values are none/low/medium/high/xhigh. `off`→'none' ✓ and `max`→'xhigh' ✓, both of which a naive
    // "is our tier name in the list?" check would have missed entirely.
    expect(tiers('gpt-5.5')).toEqual(['high', 'low', 'max', 'medium', 'off']);
  });
});

describe('OpenAI top tier is PER MODEL — the gpt-5.6 family publishes a `max` above `xhigh` (review M1)', () => {
  // gpt-5.6 effortValues: [...,'xhigh','max']; gpt-5.5 tops at 'xhigh'; gpt-5.4-pro at 'xhigh' too. `max` must
  // reach the MODEL's own highest value, not a fixed alias — otherwise the picker's "max" row silently sends the
  // second-strongest tier and the flagship's true maximum is unreachable from every surface.
  it('openAiWireValue reads the model ladder: max→max when published, else max→xhigh', () => {
    const wix6 = CATALOG_SNAPSHOT['gpt-5.6']?.reasoning;
    const wix5 = CATALOG_SNAPSHOT['gpt-5.5']?.reasoning;
    if (wix6 === undefined || wix5 === undefined)
      throw new Error('gpt-5.6/gpt-5.5 not in the catalog');
    expect(openAiWireValue('max', wix6)).toBe('max'); // gpt-5.6 publishes 'max'
    expect(openAiWireValue('max', wix5)).toBe('xhigh'); // gpt-5.5 tops at 'xhigh'
    expect(openAiWireValue('high', wix6)).toBe('high'); // intermediate tiers unchanged
    expect(openAiWireValue('off', wix6)).toBe('none'); // off still maps to 'none'
  });

  it('wireValueFor is catalog-aware WITH controls and defaults to xhigh WITHOUT them (dedup path)', () => {
    const wix6 = CATALOG_SNAPSHOT['gpt-5.6']?.reasoning;
    if (wix6 === undefined) throw new Error('gpt-5.6 not in the catalog');
    expect(wireValueFor('openai', 'max', wix6)).toBe('max');
    expect(wireValueFor('openai', 'max')).toBe('xhigh'); // no controls ⇒ the static top (never collides on dedup)
  });

  it('acceptedTiers offers max for gpt-5.6 (its wire `max` is a published value)', () => {
    expect(tiers('gpt-5.6')).toContain('max');
    // …and acceptedWireValue resolves that tier to the model's own top, not the coarsened xhigh.
    const wix6 = CATALOG_SNAPSHOT['gpt-5.6']?.reasoning;
    if (wix6 === undefined) throw new Error('gpt-5.6 not in the catalog');
    expect(acceptedWireValue('openai', 'max', wix6)).toBe('max');
  });
});

describe('the live Gemini bug — the catalog says what Google says', () => {
  it('gemini-2.5-pro CANNOT be turned off — its budget floor is 128, not 0', () => {
    // Google: "N/A: Cannot disable thinking". The catalog: budgetTokens.min = 128. Same fact, one field.
    // Today's adapter maps off→MINIMAL and sends it anyway — a value the model does not take.
    const model = CATALOG_SNAPSHOT['gemini-2.5-pro'];
    expect(model?.reasoning?.budgetTokens?.min).toBe(128);
    expect(canDisableReasoning('gemini', model?.reasoning ?? {})).toBe(false);
    expect(tiers('gemini-2.5-pro')).not.toContain('off');
    expect(tiers('gemini-2.5-pro')).toEqual(['high', 'low', 'max', 'medium']); // gradable via the budget
  });

  it('gemini-2.5-flash CAN be turned off — its budget floor IS 0', () => {
    expect(CATALOG_SNAPSHOT['gemini-2.5-flash']?.reasoning?.budgetTokens?.min).toBe(0);
    expect(tiers('gemini-2.5-flash')).toContain('off');
  });

  it('a Gemini EFFORT model still cannot be turned off — MINIMAL is the floor, not an off switch', () => {
    // `gemini-3.5-flash` publishes ['minimal','low','medium','high']. `minimal` is the *lowest* level; a model
    // set to it still thinks. Disabling is `thinkingBudget: 0`, a field this model does not take — so `off` is
    // not on offer, and mapping off→MINIMAL (as the adapter does today) would bill the user for reasoning they
    // asked not to have.
    expect(tiers('gemini-3.5-flash')).not.toContain('off');
  });
});

describe('`off` is not an effort value on three of four providers — the asymmetry a literal read destroys', () => {
  it('every reasoning ANTHROPIC model can be turned off — the switch is independent of the effort ladder', () => {
    // `thinking: {type:'disabled'}`. `off` appears in NO Claude model's effortValues, so a literal read drops it
    // from all of them.
    for (const [id, model] of Object.entries(CATALOG_SNAPSHOT)) {
      if (model.provider !== 'anthropic' || model.reasoning === undefined) continue;
      if (Object.keys(model.reasoning).length === 0) continue; // no control at all — see below
      expect(tiers(id), `${id} must be able to turn reasoning off`).toContain('off');
    }
  });

  it('claude-haiku-4-5 is BUDGET-shaped — gradable, and off-able, with no effort axis at all', () => {
    // The maintainer confirmed this independently. Our adapter sends `output_config.effort` to it today.
    expect(CATALOG_SNAPSHOT['claude-haiku-4-5']?.reasoning?.effortValues).toBeUndefined();
    expect(tiers('claude-haiku-4-5')).toEqual(['high', 'low', 'max', 'medium', 'off']);
  });

  it('deepseek-v4-pro keeps all five — low/medium/high all coarsen onto its single `high` wire value', () => {
    // Its values are ['high','max']. A literal read would offer only {high, max}; the truth is that `low` and
    // `medium` are *expressible* (they coarsen to `high`), and `off` is the independent disable switch.
    expect(tiers('deepseek-v4-pro')).toEqual(['high', 'low', 'max', 'medium', 'off']);
  });
});

describe('the empty descriptor — reasons, but has NO controllable tier', () => {
  it('deepseek-reasoner offers NOTHING — not even off', () => {
    // `reasoning: {}` is a real, distinct state: the model thinks, and upstream declines to describe any control
    // for it. The safe answer is to withhold the field entirely. Adding `off` on DeepSeek's *general* ability to
    // disable would be a guess about a model whose capability nobody documented — and a guess is exactly what
    // put a rejected value on the wire in the first place.
    expect(CATALOG_SNAPSHOT['deepseek-reasoner']?.reasoning).toEqual({});
    expect(tiers('deepseek-reasoner')).toEqual([]);
  });

  it('a NON-reasoning model offers nothing either', () => {
    expect([...acceptedTiers('openai', undefined)]).toEqual([]);
  });
});

describe('MEMBERSHIP, not presence — the bug an adversarial review found in the fix itself', () => {
  /**
   * The adapters branched on `controls.effortValues !== undefined` — the PRESENCE of an effort axis — and then
   * sent the mapped wire value UNCHECKED. Presence is not membership, and the gap is a 400:
   *
   *   claude-opus-4-5     publishes ['low','medium','high'] — no `max`    → tier `max`    sent `effort: 'max'`
   *   gemini-3-pro-preview publishes ['low','high']          — no `medium` → tier `medium` sent `thinkingLevel: MEDIUM`
   *
   * Both reach the wire through a FAILOVER, and that is the sting: the fallback chain exists to RESCUE a failing
   * turn, and a 400 on an unsupported parameter is fatal and non-retryable — so the rescue kills the turn instead.
   */
  it('claude-opus-4-5 does not accept `max` AS AN EFFORT LEVEL — but its budget axis still serves it', () => {
    const model = CATALOG_SNAPSHOT['claude-opus-4-5'];
    expect(model?.reasoning?.effortValues).toEqual(['low', 'medium', 'high']); // the premise
    // No `effort: 'max'` on the wire — that is the 400 this work removes…
    expect(acceptedWireValue('anthropic', 'max', model?.reasoning ?? {})).toBeUndefined();
    // …but the model ALSO publishes `budgetTokens`, and the Anthropic adapter falls back to it, so the tier is
    // genuinely reachable and the picker must keep offering it. Reading "not on the ladder" as "not accepted"
    // would have hidden a tier the model serves perfectly well — the second review caught it.
    expect(model?.reasoning?.budgetTokens?.min).toBe(1024);
    expect(tiers('claude-opus-4-5')).toContain('max');
  });

  it('gemini-3-pro-preview does NOT accept `medium` — its ladder skips it', () => {
    expect(CATALOG_SNAPSHOT['gemini-3-pro-preview']?.reasoning?.effortValues).toEqual([
      'low',
      'high',
    ]);
    expect(tiers('gemini-3-pro-preview')).not.toContain('medium');
  });

  it('gpt-5.4-pro does NOT accept `low` — the original bug report, at the wire layer', () => {
    const model = CATALOG_SNAPSHOT['gpt-5.4-pro'];
    expect(acceptedWireValue('openai', 'low', model?.reasoning ?? {})).toBeUndefined();
    expect(acceptedWireValue('openai', 'high', model?.reasoning ?? {})).toBe('high');
  });
});

describe('the Gemini toggle divergence — the picker offered `off` and the adapter dropped it', () => {
  it('a toggle-shaped model CAN be turned off, even with a non-zero budget floor', () => {
    // `gemini-2.5-flash-lite` has `{ toggle: true, budgetTokens: { min: 512 } }`. `canDisableReasoning` said yes
    // (the toggle), so the picker OFFERED `off` — but the adapter's off-branch only looked at `min === 0` and
    // silently withheld the field. The user turned reasoning off, was billed for it anyway, and nothing said so.
    const model = CATALOG_SNAPSHOT['gemini-2.5-flash-lite'];
    expect(model?.reasoning?.toggle).toBe(true);
    expect(model?.reasoning?.budgetTokens?.min).toBe(512); // NOT zero — which is why the two disagreed
    expect(canDisableReasoning('gemini', model?.reasoning ?? {})).toBe(true);
    expect(tiers('gemini-2.5-flash-lite')).toContain('off');
  });

  it('…and gemini-2.5-pro still cannot — no toggle, and a floor of 128', () => {
    expect(canDisableReasoning('gemini', CATALOG_SNAPSHOT['gemini-2.5-pro']?.reasoning ?? {})).toBe(
      false,
    );
  });
});

describe('the answer must survive the thinking — a budget that eats the cap is not a budget', () => {
  it('the `max` tier leaves room to REPLY', () => {
    // `max` used to spend 100% of the output cap on thoughts: `budget_tokens: max_tokens - 1` on Anthropic (one
    // token of answer), `thinkingBudget == maxOutputTokens` on Gemini (none at all). Both are ACCEPTED by the
    // provider — which is what makes it insidious. The user pays for a full turn of reasoning and gets nothing.
    const cap = 8192;
    const budget = reasoningBudgetFor('max', { min: 1024 }, thinkingCeiling(cap));
    expect(budget).toBeDefined();
    expect(budget).toBeLessThan(cap);
    expect(cap - (budget ?? 0)).toBeGreaterThanOrEqual(cap * 0.19); // ~20% reserved for the answer
  });

  it('a cap too small to hold the model floor AND an answer yields NO budget at all', () => {
    // Withhold, never squeeze. haiku's floor is 1024; a 1024-token cap cannot carry both.
    expect(reasoningBudgetFor('low', { min: 1024 }, thinkingCeiling(1024))).toBeUndefined();
    expect(reasoningBudgetFor('low', { min: 1024 }, thinkingCeiling(1280))).toBe(1024); // the first that can
  });
});

describe('reasoningWithheldByCap — the gate can SAY what the adapter used to drop in silence (review M6)', () => {
  const haiku = CATALOG_SNAPSHOT['claude-haiku-4-5']?.reasoning; // budget-shaped: { min: 1024 }, no ladder
  const opus45 = CATALOG_SNAPSHOT['claude-opus-4-5']?.reasoning; // effort ladder + a budget

  it('a budget-only model withholds under a tight cap, and does NOT under a roomy one', () => {
    if (haiku === undefined) throw new Error('claude-haiku-4-5 not in the catalog');
    expect(reasoningWithheldByCap('anthropic', haiku, 'medium', 500)).toBe(true); // 500 < floor+answer → dropped
    expect(reasoningWithheldByCap('anthropic', haiku, 'medium', 8000)).toBe(false); // room for the budget
  });

  it('a tier reachable via the EFFORT LADDER is never cap-withheld — it carries no budget', () => {
    if (opus45 === undefined) throw new Error('claude-opus-4-5 not in the catalog');
    // `high` is on opus-4-5's ladder → sent as an effort level, so even a tiny cap does not withhold it.
    expect(reasoningWithheldByCap('anthropic', opus45, 'high', 100)).toBe(false);
  });

  it('OpenAI/DeepSeek have no budget field, so nothing is ever cap-withheld there', () => {
    if (haiku === undefined) throw new Error('claude-haiku-4-5 not in the catalog');
    // Even fed a budget descriptor, an effort-only provider has no budget to exceed.
    expect(reasoningWithheldByCap('openai', haiku, 'medium', 1)).toBe(false);
    expect(reasoningWithheldByCap('deepseek', haiku, 'medium', 1)).toBe(false);
  });
});

describe('an UNKNOWN model gets NO reasoning field — on ALL FOUR arms, not just two', () => {
  /**
   * Found by an adversarial review, and it was real. Fixing Gemini and Anthropic's *effort* paths left OpenAI and
   * DeepSeek sending the field unconditionally — and Anthropic's `off` branch sat in FRONT of the catalog check,
   * so an unknown model was sent `thinking: {type:'disabled'}`, which is still a field and still a 400 on a model
   * with no reasoning surface.
   *
   * The host's gate already withholds for an unknown model. The adapter must not depend on a caller having run it:
   * `@relavium/llm` is a public seam, and the whole point of this change is that we never guess at a model we
   * cannot describe.
   */
  const unknown = 'some-custom-endpoint-model';

  it('the catalog genuinely does not know it — the premise of every case below', () => {
    expect(CATALOG_SNAPSHOT[unknown]).toBeUndefined();
    expect(acceptedTiers('openai', undefined).size).toBe(0);
  });

  it('acceptedTiers returns EMPTY for it on every provider, so the gate withholds', () => {
    for (const provider of ['openai', 'anthropic', 'gemini', 'deepseek'] as const) {
      expect(acceptedTiers(provider, undefined).size, provider).toBe(0);
    }
  });
});

describe('the whole shipped catalog — no model is offered a tier it would reject', () => {
  /** The wire value each provider would send for a tier — the same table `wireValueFor` implements. */
  const WIRE = {
    openai: { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' },
    anthropic: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
    gemini: { low: 'low', medium: 'medium', high: 'high', max: 'high' },
    deepseek: { low: 'high', medium: 'high', high: 'high', max: 'max' },
  } as const;

  it('every offered tier is one the ADAPTER can actually put on the wire — by ladder or by budget', () => {
    // The invariant the picker rests on. If it holds for all 80 models, no interactive path can produce a 400.
    //
    // "Publishes the wire value" is NOT the whole invariant, and reading it that way is what an adversarial review
    // caught: `claude-opus-4-5`'s ladder omits `max`, but it ALSO publishes a token budget, and its adapter serves
    // `max` from that. A tier is legitimate if EITHER route exists — and only if the provider's adapter actually
    // has a budget field (OpenAI's `reasoning_effort` and DeepSeek's `thinking` do not, so a budget in the catalog
    // buys those models nothing).
    const BUDGET_CAPABLE = new Set(['anthropic', 'gemini']);
    for (const [id, model] of Object.entries(CATALOG_SNAPSHOT)) {
      if (model.reasoning === undefined) continue;
      const published = new Set(model.reasoning.effortValues ?? []);
      const viaBudget =
        model.reasoning.budgetTokens !== undefined && BUDGET_CAPABLE.has(model.provider);
      for (const tier of acceptedTiers(model.provider, model.reasoning)) {
        if (tier === 'off') continue; // `off` rides the provider's disable axis, checked below.
        const servable = published.has(WIRE[model.provider][tier]) || viaBudget;
        expect(servable, `${id}: tier '${tier}' is offered but no adapter route can send it`).toBe(
          true,
        );
      }
    }
  });

  it('a BUDGET on a provider whose adapter has no budget field buys the model nothing', () => {
    // The mirror of the case above, and the reason `acceptedTiers` cannot blindly union the two axes. If OpenAI
    // ever ships a model with `budgetTokens`, the picker must NOT start offering every tier for it: `reasoning_effort`
    // is the only reasoning knob that adapter has, and a tier outside the published ladder would be a 400.
    const openaiWithBudget = { effortValues: ['high'], budgetTokens: { min: 1024 } } as const;
    expect([...acceptedTiers('openai', openaiWithBudget)]).toEqual(['high']);

    const deepseekWithBudget = { budgetTokens: { min: 1024 } } as const;
    // A budget alone gives DeepSeek no gradation — but `thinking: {disabled}` still exists, so `off` survives.
    expect([...acceptedTiers('deepseek', deepseekWithBudget)]).toEqual(['off']);
  });

  it('no model that cannot be disabled is ever offered `off`', () => {
    for (const [id, model] of Object.entries(CATALOG_SNAPSHOT)) {
      if (model.reasoning === undefined) continue;
      const offered = acceptedTiers(model.provider, model.reasoning).has('off');
      if (!offered) continue;
      expect(canDisableReasoning(model.provider, model.reasoning), `${id} offers off`).toBe(true);
    }
  });

  it('an EMPTY descriptor cannot be disabled either — not even on a provider with a disable switch', () => {
    // `deepseek-reasoner` ships `reasoning: {}`: it reasons, and upstream describes no knob. `canDisableReasoning`
    // used to answer `true` for anthropic/deepseek on the provider's general ability, regardless of the model — and
    // that answer is what let the adapters send `thinking: {type:'disabled'}` to a model that never said it takes
    // one. An empty descriptor means there is nothing to turn.
    expect(canDisableReasoning('deepseek', {})).toBe(false);
    expect(canDisableReasoning('anthropic', {})).toBe(false);
    expect(acceptedTiers('deepseek', CATALOG_SNAPSHOT['deepseek-reasoner']?.reasoning).size).toBe(
      0,
    );
  });
});
