import { describe, expect, it } from 'vitest';

import { CATALOG_SNAPSHOT } from './catalog/snapshot.js';
import { cappedMaxTokens } from './output-cap.js';

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
