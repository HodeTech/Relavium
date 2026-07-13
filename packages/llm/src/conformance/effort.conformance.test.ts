import { describe, expect, it } from 'vitest';

import { createAnthropicAdapter } from '../adapters/anthropic.js';
import { createGeminiAdapter } from '../adapters/gemini.js';
import { createOpenAiAdapter } from '../adapters/openai.js';
import { catalogModel } from '../catalog/lookup.js';
import { CATALOG_SNAPSHOT } from '../catalog/snapshot.js';
import { acceptedTiers } from '../reasoning-wire.js';
import type { ReasoningEffort } from '@relavium/shared';

import type { LlmProvider } from '../types.js';

/**
 * THE ONLY MECHANISM THAT CATCHES A STALE CATALOG RE-INTRODUCING THE REASONING BUG (ADR-0071 §9).
 *
 * The whole point of this work is that a model DECLARES which effort tiers it accepts, and the adapters send only
 * those. But the catalog is a snapshot: models.dev could change a model's `reasoning_options`, or a provider could
 * tighten what it accepts, and our shipped snapshot would go on claiming a tier the model now rejects — silently,
 * the exact Gemini bug this ADR fixed, back from the dead. Nothing offline can see it: the fixtures replay what we
 * recorded, and a unit test proves the mapping is internally consistent, not that the PROVIDER agrees.
 *
 * So this asks the real API. For each shipped reasoning model, it sends EVERY tier the catalog says the model
 * accepts and asserts the provider does not reject it. A 400 here means the catalog is lying about that model —
 * which is precisely what a stale snapshot looks like, and precisely what a one-off manual probe cannot keep
 * catching (it proves a fact once; the catalog drifts continuously).
 *
 * Key-gated and nightly (testing.md): skipped with no key, so it never gates a PR. `off` is excluded — disabling
 * reasoning is a different wire shape whose acceptance the adapters already gate, and sending it proves nothing
 * about the effort ladder this test exists to pin.
 */

/** A representative reasoning model per provider — one with a non-trivial effort ladder to actually exercise. */
const PROBE: Record<'anthropic' | 'openai' | 'gemini' | 'deepseek', string> = {
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-5.5',
  gemini: 'gemini-2.5-flash',
  deepseek: 'deepseek-v4-pro',
};

/** The graded tiers the catalog claims a model accepts (never `off` — see the file header). */
function gradedTiersFor(modelId: string): ReasoningEffort[] {
  const entry = catalogModel(modelId);
  if (entry === undefined) return [];
  return [...acceptedTiers(entry.provider, entry.reasoning)].filter((t) => t !== 'off');
}

/** Send one tier at the real API and assert it is not rejected — a returned result, non-empty output. */
async function assertTierAccepted(
  adapter: LlmProvider,
  model: string,
  tier: ReasoningEffort,
  key: string,
): Promise<void> {
  const result = await adapter.generate(
    {
      model,
      maxTokens: 64,
      reasoningEffort: tier,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with one word.' }] }],
    },
    key,
  );
  // The assertion is "the provider did not 400 on the tier" — `generate` throwing an LlmError is the failure. A
  // returned result with output tokens is proof the tier rode.
  expect(result.usage.outputTokens, `${model} rejected tier '${tier}'`).toBeGreaterThan(0);
}

const anthropicKey = process.env['ANTHROPIC_API_KEY'] ?? '';
describe('anthropic — effort conformance (live, nightly): the catalog does not lie about accepted tiers', () => {
  const model = PROBE.anthropic;
  const tiers = gradedTiersFor(model);
  it.skipIf(anthropicKey === '' || tiers.length === 0)(
    `${model} accepts every tier the catalog claims (${tiers.join(', ')})`,
    async () => {
      const adapter = createAnthropicAdapter({ maxRetries: 0 });
      for (const tier of tiers) {
        await assertTierAccepted(adapter, model, tier, anthropicKey);
      }
    },
  );
});

const openaiKey = process.env['OPENAI_API_KEY'] ?? '';
describe('openai — effort conformance (live, nightly): the catalog does not lie about accepted tiers', () => {
  const model = PROBE.openai;
  const tiers = gradedTiersFor(model);
  it.skipIf(openaiKey === '' || tiers.length === 0)(
    `${model} accepts every tier the catalog claims (${tiers.join(', ')})`,
    async () => {
      const adapter = createOpenAiAdapter({ providerId: 'openai', maxRetries: 0 });
      for (const tier of tiers) {
        await assertTierAccepted(adapter, model, tier, openaiKey);
      }
    },
  );
});

const geminiKey = process.env['GEMINI_API_KEY'] ?? '';
describe('gemini — effort conformance (live, nightly): the catalog does not lie about accepted tiers', () => {
  const model = PROBE.gemini;
  const tiers = gradedTiersFor(model);
  it.skipIf(geminiKey === '' || tiers.length === 0)(
    `${model} accepts every tier the catalog claims (${tiers.join(', ')})`,
    async () => {
      const adapter = createGeminiAdapter();
      for (const tier of tiers) {
        await assertTierAccepted(adapter, model, tier, geminiKey);
      }
    },
  );
});

const deepseekKey = process.env['DEEPSEEK_API_KEY'] ?? '';
describe('deepseek — effort conformance (live, nightly): the catalog does not lie about accepted tiers', () => {
  const model = PROBE.deepseek;
  const tiers = gradedTiersFor(model);
  it.skipIf(deepseekKey === '' || tiers.length === 0)(
    `${model} accepts every tier the catalog claims (${tiers.join(', ')})`,
    async () => {
      const adapter = createOpenAiAdapter({ providerId: 'deepseek', maxRetries: 0 });
      for (const tier of tiers) {
        await assertTierAccepted(adapter, model, tier, deepseekKey);
      }
    },
  );
});

/**
 * The OFFLINE half — this DOES gate a PR (no key needed). The live probes above can only run for a model the
 * catalog carries; if a PROBE id ever drifts out of the snapshot, the live test silently skips (empty tier list)
 * and the drift goes unnoticed. This pins the probes to real shipped models so a rename can't quietly disable the
 * one mechanism §9 relies on.
 */
describe('effort conformance — the probe models are real, so the live lane cannot silently no-op', () => {
  it('every probe id is a shipped reasoning model with a non-empty effort ladder', () => {
    for (const [provider, modelId] of Object.entries(PROBE)) {
      const entry = CATALOG_SNAPSHOT[modelId];
      expect(entry, `${provider} probe '${modelId}' is not in the catalog`).toBeDefined();
      expect(entry?.provider).toBe(provider);
      expect(gradedTiersFor(modelId).length, `${modelId} has no graded tiers to probe`).toBeGreaterThan(0);
    }
  });
});
