import { describe, expect, it } from 'vitest';

import { CATALOG_SNAPSHOT } from './catalog/snapshot.js';
import { acceptedTiers, canDisableReasoning } from './reasoning-wire.js';

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

describe('the whole shipped catalog — no model is offered a tier it would reject', () => {
  it('every EFFORT-shaped model accepts only tiers whose wire value it actually publishes', () => {
    // The invariant the picker will rest on. If this holds for all 80 models, no interactive path can produce a
    // 400 — which is what F3 is.
    for (const [id, model] of Object.entries(CATALOG_SNAPSHOT)) {
      const values = model.reasoning?.effortValues;
      if (values === undefined) continue;
      const published = new Set(values);
      for (const tier of acceptedTiers(model.provider, model.reasoning)) {
        if (tier === 'off') continue; // `off` rides the provider's disable axis, checked above.
        const wire =
          model.provider === 'openai'
            ? { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' }[tier]
            : model.provider === 'deepseek'
              ? { low: 'high', medium: 'high', high: 'high', max: 'max' }[tier]
              : model.provider === 'gemini'
                ? { low: 'low', medium: 'medium', high: 'high', max: 'high' }[tier]
                : { low: 'low', medium: 'medium', high: 'high', max: 'max' }[tier];
        expect(published.has(wire), `${id}: tier '${tier}' → wire '${wire}' is not published`).toBe(
          true,
        );
      }
    }
  });

  it('no model that cannot be disabled is ever offered `off`', () => {
    for (const [id, model] of Object.entries(CATALOG_SNAPSHOT)) {
      if (model.reasoning === undefined) continue;
      const offered = acceptedTiers(model.provider, model.reasoning).has('off');
      if (!offered) continue;
      expect(canDisableReasoning(model.provider, model.reasoning), `${id} offers off`).toBe(true);
    }
  });
});
