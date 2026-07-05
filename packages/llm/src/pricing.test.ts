import { describe, expect, it } from 'vitest';

import { contextWindowForModel, KNOWN_MODEL_IDS, MODEL_PRICING } from './pricing.js';

/**
 * `contextWindowForModel` (ADR-0062 §7) — the pure catalog lookup the CLI footer context-fullness indicator uses
 * without going through the provider seam. It must return the SAME `contextWindowTokens` the adapters' `contextLimit`
 * returns for a known model, and `undefined` for a custom base-URL model absent from the catalog (which degrades the
 * indicator + auto-compaction to "not applicable", never a crash).
 */
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
