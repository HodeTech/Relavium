import { afterEach, describe, expect, it } from 'vitest';

import { CATALOG_SNAPSHOT } from './catalog/snapshot.js';
import {
  cappedMaxTokens,
  prepareOutputCapPlan,
  prepareOutputCapRequest,
  outputTokensReservation,
  outputCapNativeOptions,
  assertOutputCapPlanMatches,
  isPreparedOutputCapPlan,
  InvalidOutputCapPlanError,
  type OutputCapIdentity,
  type EndpointKind,
} from './output-cap.js';
import { clearCatalogRefresh, installCatalogRefresh } from './catalog/lookup.js';
import { catalogModelFixture } from './conformance/fixtures/catalog.js';
import type { ProviderId, LlmRequest } from './types.js';

/**
 * The output cap (ADR-0071 §7) — the other half of the maintainer's "max tokens errors".
 *
 * Nothing in the shipped code compared an authored `max_tokens` against the model's real output limit, because
 * nothing KNEW the limit: `MODEL_PRICING` carried a context window and no output ceiling at all. So an agent
 * authored with `max_tokens: 200000` on a 64 000-token model 400'd on every single turn, and the workflow it sat
 * in never ran.
 */
describe('cappedMaxTokens — down to the model ceiling, never up', () => {
  it('CLAMPS a cap above the model ceiling — the 400 that had no fix', () => {
    // gpt-5.4-pro publishes maxOutputTokens: 128_000.
    expect(CATALOG_SNAPSHOT['gpt-5.4-pro']?.maxOutputTokens).toBe(128_000); // the premise
    expect(cappedMaxTokens(200_000, 'gpt-5.4-pro')).toBe(128_000);
  });

  it("LEAVES a cap below the ceiling ALONE — it is the author's budget, not a mistake to correct", () => {
    // The tempting "helpful" move is to raise a small cap to the model's maximum. That spends the user's money on
    // their behalf: a low cap is a cost control, a latency budget, a hard bound on a summary's length.
    expect(cappedMaxTokens(500, 'gpt-5.4-pro')).toBe(500);
  });

  it('passes an ABSENT cap through — the provider default stands, we do not invent one', () => {
    expect(cappedMaxTokens(undefined, 'gpt-5.4-pro')).toBeUndefined();
  });

  it('does NOT clamp a model the catalog cannot describe — there is no ceiling to clamp against', () => {
    expect(cappedMaxTokens(999_999, 'some-model-we-have-never-heard-of')).toBe(999_999);
  });

  it('does NOT clamp a CUSTOM endpoint, even for an id the catalog knows', () => {
    // A `base_url` pointing at LM Studio / vLLM / a gateway may serve something entirely different under a familiar
    // id, with its own limits. Silently LOWERING a number the user typed, on a model we are only guessing at, is a
    // behaviour change we have no right to make — the asymmetry with WITHHOLDING the reasoning field there (which
    // is safe, and which we do) is deliberate.
    expect(cappedMaxTokens(200_000, 'gpt-5.4-pro', 'custom')).toBe(200_000);
  });

  it('a cap EXACTLY at the ceiling is untouched — the boundary is inclusive', () => {
    expect(cappedMaxTokens(128_000, 'gpt-5.4-pro')).toBe(128_000);
  });

  it('every shipped model has a ceiling to clamp against — the invariant the clamp rests on', () => {
    // The clamp is only as good as the data behind it: a model whose row carried no output ceiling would pass an
    // unbounded cap straight through and 400 exactly as before. This is the one assertion here that is NOT a
    // restatement of `Math.min` — it checks the CATALOG, which is generated and can regress upstream.
    for (const [id, model] of Object.entries(CATALOG_SNAPSHOT)) {
      expect(model.maxOutputTokens, `${id} has no output ceiling`).toBeGreaterThan(0);
    }
  });
});

describe('effective wire-cap plans (ADR-0101)', () => {
  afterEach(clearCatalogRefresh);
  const model = 'gpt-5.4-pro';
  const identity = (
    provider: ProviderId,
    endpoint: EndpointKind = 'official',
    maxTokens?: number,
    providerOptions?: Record<string, unknown>,
  ): OutputCapIdentity => ({ model, provider, endpoint, maxTokens, providerOptions });

  it.each(['openai', 'deepseek', 'gemini', 'anthropic'] as const)(
    'authored %s caps win configured estimates and native fields',
    (provider) => {
      const info = identity(provider, 'official', 200_000, {
        max_tokens: 300_000,
        max_completion_tokens: 400_000,
        maxOutputTokens: 500_000,
      });
      const plan = prepareOutputCapPlan(info);
      expect(outputTokensReservation(plan, 1)).toBe(128_000);
      expect(outputTokensReservation(plan, 1_000_000)).toBe(128_000);
      expect(plan.mappedValue).toBe(128_000);
      expect(outputCapNativeOptions(plan, info.providerOptions)).not.toHaveProperty(
        plan.mappedField,
      );
    },
  );

  it('required Anthropic default wins both its native escape hatch and any configured estimate', () => {
    const plan = prepareOutputCapPlan(
      identity('anthropic', 'official', undefined, { max_tokens: 200_000 }),
    );
    expect(plan.mappedValue).toBe(4096);
    expect(outputTokensReservation(plan, 1)).toBe(4096);
    expect(outputTokensReservation(plan, 1_000_000)).toBe(4096);
  });

  it.each([
    ['openai', 'official', { max_tokens: 200_000, max_completion_tokens: 300_000 }, 300_000],
    ['openai', 'custom', { max_tokens: 200_000, max_completion_tokens: 300_000 }, 300_000],
    ['deepseek', 'official', { max_tokens: 200_000, max_completion_tokens: 300_000 }, 200_000],
    ['deepseek', 'custom', { max_tokens: 200_000, max_completion_tokens: 300_000 }, 300_000],
    ['gemini', 'official', { maxOutputTokens: 300_000 }, 300_000],
  ] satisfies [ProviderId, EndpointKind, Record<string, unknown>, number][])(
    'surviving native %s/%s caps remain unclamped',
    (provider, endpoint, providerOptions, expected) => {
      const plan = prepareOutputCapPlan(identity(provider, endpoint, undefined, providerOptions));
      expect(outputTokensReservation(plan, 1)).toBe(expected);
      expect(plan.mappedValue).toBeUndefined();
      expect(outputCapNativeOptions(plan, providerOptions)).toEqual(providerOptions);
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, '200000', null])(
    'ignores invalid native cap %s for estimates while preserving wire data',
    (value) => {
      const options = { max_completion_tokens: value };
      const plan = prepareOutputCapPlan(identity('openai', 'official', undefined, options));
      expect(outputTokensReservation(plan, 17)).toBe(17);
      expect(outputCapNativeOptions(plan, options)).toEqual(options);
    },
  );

  it('uncapped requests use the frozen official ceiling; custom/unknown routes preserve the fallback', () => {
    const info = identity('openai');
    const plan = prepareOutputCapPlan(info);
    expect(outputTokensReservation(plan, undefined)).toBe(4096);
    expect(outputTokensReservation(plan, 200_000)).toBe(128_000);
    expect(plan.mappedValue).toBeUndefined();
    expect(
      outputTokensReservation(prepareOutputCapPlan(identity('openai', 'custom')), 200_000),
    ).toBe(200_000);
    expect(
      outputTokensReservation(prepareOutputCapPlan({ ...info, model: 'unknown' }), 200_000),
    ).toBe(200_000);
  });

  it('hands off the measured ceiling across refreshes and preserves current unrelated options', () => {
    const id = 'w7-cap-fixture';
    installCatalogRefresh({ [id]: catalogModelFixture({ modelId: id, maxOutputTokens: 1024 }) });
    const info = {
      ...identity('openai', 'official', 4096, { max_tokens: 9000, temperature: 0.1 }),
      model: id,
    };
    const plan = prepareOutputCapPlan(info);
    installCatalogRefresh({ [id]: catalogModelFixture({ modelId: id, maxOutputTokens: 4096 }) });
    const request: LlmRequest = {
      model: id,
      messages: [],
      maxTokens: 4096,
      providerOptions: { max_tokens: 9000, temperature: 0.9 },
      preparedOutputCaps: [plan],
    };
    const staged = prepareOutputCapRequest(request, 'openai', 'official');
    expect(staged.plan).toBe(plan);
    expect(staged.plan.mappedValue).toBe(1024);
    expect(outputCapNativeOptions(plan, staged.request.providerOptions)).toEqual({
      temperature: 0.9,
    });
    expect(prepareOutputCapPlan(info).mappedValue).toBe(4096);
  });

  it('copies cap values before awaits and refuses substituted cap/routing plans', () => {
    const options = { max_tokens: 200_000 };
    const request: LlmRequest = { model, messages: [], providerOptions: options };
    const staged = prepareOutputCapRequest(request, 'openai', 'official');
    options.max_tokens = 1;
    expect(outputTokensReservation(staged.plan, undefined)).toBe(200_000);
    expect(staged.request.providerOptions?.['max_tokens']).toBe(200_000);
    expect(() =>
      assertOutputCapPlanMatches(staged.plan, identity('openai', 'official', undefined, options)),
    ).toThrow(InvalidOutputCapPlanError);
    expect(() =>
      assertOutputCapPlanMatches(
        staged.plan,
        identity('openai', 'custom', undefined, { max_tokens: 200_000 }),
      ),
    ).toThrow(InvalidOutputCapPlanError);
    expect(isPreparedOutputCapPlan({ ...staged.plan })).toBe(false);
  });

  it('captures native JSON semantics once, with the original key, through a measured-plan handoff', () => {
    let amount = 200_000;
    const keys: string[] = [];
    const cap = {
      toJSON: (key: string) => {
        keys.push(key);
        return amount;
      },
    };
    const options = { max_completion_tokens: cap };
    const plan = prepareOutputCapPlan(identity('openai', 'official', undefined, options));
    amount = 1;
    const staged = prepareOutputCapRequest(
      { model, messages: [], providerOptions: options, preparedOutputCaps: [plan] },
      'openai',
      'official',
    );
    expect(staged.plan).toBe(plan);
    expect(staged.request.providerOptions?.['max_completion_tokens']).toBe(200_000);
    expect(outputTokensReservation(plan, 17)).toBe(200_000);
    expect(keys).toEqual(['max_completion_tokens']);
    expect(() =>
      assertOutputCapPlanMatches(plan, {
        ...identity('openai'),
        providerOptions: { max_completion_tokens: {} },
      }),
    ).toThrow(InvalidOutputCapPlanError);
    expect(
      prepareOutputCapPlan(
        identity('openai', 'official', undefined, { max_tokens: Object(200_000) }),
      ).effectiveCap,
    ).toBe(200_000);
  });

  it('deep-copies invalid native JSON data and preserves omission without retaining executable values', () => {
    const cap = { nested: [1, { value: 2 }] };
    const options = { max_tokens: cap, max_completion_tokens: () => 200_000 };
    const staged = prepareOutputCapRequest(
      { model, messages: [], providerOptions: options },
      'openai',
      'official',
    );
    cap.nested.push(3);
    const captured = staged.plan.providerOptions?.['max_tokens'];
    expect(captured).toEqual({ nested: [1, { value: 2 }] });
    expect(Object.isFrozen(captured)).toBe(true);
    if (typeof captured !== 'object' || captured === null || !('nested' in captured))
      throw new Error('missing cap snapshot');
    expect(Object.isFrozen(captured.nested)).toBe(true);
    expect(staged.plan.providerOptions?.['max_completion_tokens']).toBeUndefined();
    expect(outputTokensReservation(staged.plan, 17)).toBe(17);
    expect(JSON.parse(JSON.stringify(outputCapNativeOptions(staged.plan, options)))).toEqual({
      max_tokens: { nested: [1, { value: 2 }] },
    });
  });

  it('refuses unserializable surviving controls without serializing shadowed controls', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(() =>
      prepareOutputCapPlan(identity('openai', 'official', undefined, { max_tokens: cycle })),
    ).toThrow(InvalidOutputCapPlanError);
    const plan = prepareOutputCapPlan(identity('openai', 'official', 17, { max_tokens: cycle }));
    expect(outputCapNativeOptions(plan, { max_tokens: cycle })).toEqual({});
    expect(plan.effectiveCap).toBe(17);
  });
});
