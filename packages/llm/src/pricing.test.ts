import { describe, expect, it } from 'vitest';

import {
  contextWindowForModel,
  KNOWN_MODEL_IDS,
  MODEL_PRICING,
  modelSupportsReasoning,
} from './pricing.js';

/**
 * `contextWindowForModel` (ADR-0062 §7) — the pure catalog lookup the CLI footer context-fullness indicator uses
 * without going through the provider seam. It must return the SAME `contextWindowTokens` the adapters' `contextLimit`
 * returns for a known model, and `undefined` for a custom base-URL model absent from the catalog (which degrades the
 * indicator + auto-compaction to "not applicable", never a crash).
 */
describe('modelSupportsReasoning (ADR-0066)', () => {
  it('is true for a tagged reasoning model, false for DeepSeek (adapter deferred) + unknown/custom', () => {
    expect(modelSupportsReasoning('claude-opus-4-8')).toBe(true);
    expect(modelSupportsReasoning('gpt-5.5')).toBe(true);
    expect(modelSupportsReasoning('gemini-2.5-pro')).toBe(true);
    // DeepSeek reasons (v4 thinking) but its adapter mapping is deferred, so the capability stays OFF (the effort
    // is not controllable there yet — the picker must not offer it).
    expect(modelSupportsReasoning('deepseek-v4-flash')).toBe(false);
    // Unknown / custom base-URL model NOT matching a reasoning family ⇒ the SAFE default.
    expect(modelSupportsReasoning('some-custom-base-url-model-xyz')).toBe(false);
    expect(modelSupportsReasoning('')).toBe(false);
  });

  it('the §4 id heuristic gates a NON-registry model in a known reasoning family (conservative)', () => {
    // A live-discovered id absent from MODEL_PRICING but in a family whose whole set reasons is gated ON…
    expect(modelSupportsReasoning('o5-mini')).toBe(true); // a future o-series id
    expect(modelSupportsReasoning('gpt-5.9-turbo')).toBe(true); // a future reasoning gpt-5 id
    expect(modelSupportsReasoning('claude-opus-5')).toBe(true); // a future Opus
    expect(modelSupportsReasoning('gemini-3.0-flash-thinking')).toBe(true); // an explicit "thinking" id
    // …while an AMBIGUOUS / non-reasoning id stays OFF (over-matching would earn a provider 400).
    expect(modelSupportsReasoning('gpt-4o')).toBe(false); // not a reasoning family
    expect(modelSupportsReasoning('gpt-5-chat-latest')).toBe(false); // the non-reasoning gpt-5 conversational variant
    expect(modelSupportsReasoning('claude-sonnet-9')).toBe(false); // base Sonnet is version-dependent — registry only
    expect(modelSupportsReasoning('gemini-2.0-flash')).toBe(false); // Gemini by version is not heuristic-matched
  });

  it('the registry is AUTHORITATIVE for a canonical id — a false/absent flag is not overridden by the heuristic', () => {
    // deepseek-v4-flash is a canonical id whose registry flag is not set; the id heuristic never runs for a canonical
    // id, so it stays false (the deferred-adapter decision) even though it is a v4 "thinking" model.
    expect(modelSupportsReasoning('deepseek-v4-flash')).toBe(false);
  });
});

describe('contextWindowForModel (ADR-0062 §7)', () => {
  it('returns the catalog window for a known canonical model', () => {
    // Narrow rather than assert (CLAUDE.md rule 1): under noUncheckedIndexedAccess KNOWN_MODEL_IDS[0] is
    // `CanonicalModelId | undefined`; the guard narrows it to `CanonicalModelId` (a string, and a valid
    // MODEL_PRICING key) so no `as` cast is needed.
    const id = KNOWN_MODEL_IDS[0];
    if (id === undefined) throw new Error('MODEL_PRICING catalog is unexpectedly empty');
    const win = contextWindowForModel(id);
    expect(win).toBe(MODEL_PRICING[id].contextWindowTokens);
    expect(win).toBeGreaterThan(0);
  });

  it('returns a concrete window for a specific pinned model (claude-sonnet-4-6 = 1M)', () => {
    expect(contextWindowForModel('claude-sonnet-4-6')).toBe(1_000_000);
  });

  it('returns undefined for an unknown (custom base-URL) model', () => {
    expect(contextWindowForModel('some-custom-base-url-model-xyz')).toBeUndefined();
    expect(contextWindowForModel('')).toBeUndefined();
  });
});
