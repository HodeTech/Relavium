import { describe, expect, it } from 'vitest';

import { CATALOG_SNAPSHOT } from './snapshot.js';
import type { CatalogModel, CatalogSnapshot } from './catalog-model.js';
import { diffCatalog, moneyFingerprint } from './snapshot-guard.js';

/**
 * THE MONEY GUARDS (ADR-0071 §9) — the only thing standing between a third-party data file and a silently
 * weakened cost cap. These tests exist because the FIRST version of this guard was blind in two ways at once,
 * and neither would ever have announced itself.
 */

const model = (over: Partial<CatalogModel> = {}): CatalogModel => ({
  provider: 'openai',
  modelId: 'm',
  displayName: 'M',
  contextWindowTokens: 200_000,
  maxOutputTokens: 64_000,
  inputPerMtokMicrocents: 500_000_000,
  outputPerMtokMicrocents: 2_500_000_000,
  ...over,
});

const snapshot = (...models: CatalogModel[]): CatalogSnapshot =>
  Object.fromEntries(models.map((m) => [m.modelId, m]));

describe('moneyFingerprint — EVERY money field, not just the flat pair', () => {
  it('a moved CONTEXT-TIER rate changes the fingerprint even when the flat rate does not', () => {
    // The first guard compared `input/output` only. But the pre-egress estimate takes the HIGHEST applicable
    // tier, so on a long-context turn the TIER rate — not the flat rate — is the number that sizes the cap.
    // Halving only gemini-2.5-pro's >200k tier moved no flat rate, tripped nothing, and would have capped every
    // long-context turn against half its true cost.
    const flat = { inputPerMtokMicrocents: 125_000_000, outputPerMtokMicrocents: 1_000_000_000 };
    const before = model({
      ...flat,
      contextTiers: [
        {
          aboveContextTokens: 200_000,
          inputPerMtokMicrocents: 250_000_000,
          outputPerMtokMicrocents: 1_500_000_000,
        },
      ],
    });
    const after = model({
      ...flat, // the flat rate is IDENTICAL — this is the whole trap
      contextTiers: [
        {
          aboveContextTokens: 200_000,
          inputPerMtokMicrocents: 125_000_000, // …but the >200k rate was halved
          outputPerMtokMicrocents: 1_500_000_000,
        },
      ],
    });
    expect(moneyFingerprint(before)).not.toBe(moneyFingerprint(after));
  });

  it('a moved CACHE-READ or CACHE-WRITE rate changes the fingerprint', () => {
    const base = model({ cachedInputPerMtokMicrocents: 50_000_000 });
    expect(moneyFingerprint(base)).not.toBe(
      moneyFingerprint(model({ cachedInputPerMtokMicrocents: 25_000_000 })),
    );
    expect(moneyFingerprint(model({ cacheWritePerMtokMicrocents: 625_000_000 }))).not.toBe(
      moneyFingerprint(model({ cacheWritePerMtokMicrocents: 312_500_000 })),
    );
  });

  it('distinguishes an ABSENT cache-read rate from a rate of ZERO', () => {
    // `0` means "no discount"; absent means "no rate, fall back to the full input price". Collapsing them
    // would let upstream flip one into the other — billing cached input as FREE — without tripping the guard.
    expect(moneyFingerprint(model({}))).not.toBe(
      moneyFingerprint(model({ cachedInputPerMtokMicrocents: 0 })),
    );
  });

  it('does NOT change for a non-money edit (a renamed display name)', () => {
    expect(moneyFingerprint(model({ displayName: 'A' }))).toBe(
      moneyFingerprint(model({ displayName: 'B' })),
    );
  });
});

describe('diffCatalog — the two ways a sync can quietly weaken a safety control', () => {
  it('REGRESSION: catches a moved price on a model whose id is a BARE JS IDENTIFIER (`o1`, `o3`)', () => {
    // THE bug this file exists for. The first guard regex-matched the generated snapshot's TEXT and required a
    // single-quoted key — but prettier's default `quoteProps: 'as-needed'` emits `o1: {` unquoted. The regex saw
    // 88 of 90 models; `o1` and `o3` had NO baseline at all, so a halved `o1` price passed in silence and the
    // fatal "a shipped model vanished" check could not fire for them either. Diffing DATA makes the key's byte
    // shape irrelevant — which is the only way this stays fixed.
    const before = snapshot(model({ modelId: 'o1', inputPerMtokMicrocents: 1_500_000_000 }));
    const after = { o1: model({ modelId: 'o1', inputPerMtokMicrocents: 750_000_000 }) };
    const { moved } = diffCatalog(before, after);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.modelId).toBe('o1');
  });

  it('catches a shipped model that VANISHED — for any reason, including reasons no drop-list would show', () => {
    // The first guard could only see models the normalizer explicitly DROPPED. A model that simply disappeared
    // from the payload — upstream deleted it, a CATALOG_PROVIDER_KEYS edit erased its whole provider — appeared
    // in no list at all and was removed in silence. An absent model is an unpriced model, and an unpriced model
    // skips the cost cap entirely.
    const { vanished } = diffCatalog(snapshot(model({ modelId: 'gone' })), {});
    expect(vanished).toEqual(['gone']);
  });

  it('a NEW model is `added`, never `moved` — pricing a model can only INCREASE what the cap covers', () => {
    const { added, moved, vanished } = diffCatalog({}, { fresh: model({ modelId: 'fresh' }) });
    expect(added).toEqual(['fresh']);
    expect(moved).toEqual([]);
    expect(vanished).toEqual([]);
  });

  it('an unchanged catalog diffs to NOTHING — the guard must not cry wolf', () => {
    const same = snapshot(model({ modelId: 'a' }), model({ modelId: 'b' }));
    const { moved, vanished, added } = diffCatalog(same, { ...same });
    expect([moved, vanished, added]).toEqual([[], [], []]);
  });
});

describe('the SHIPPED snapshot itself — 80 chat models, all priced, none of them non-chat', () => {
  const models = Object.values(CATALOG_SNAPSHOT);

  it('is not empty, and every model carries a positive input AND output price', () => {
    // A `0` price is not "free" — it is a model that would sail straight through the cost cap.
    expect(models.length).toBeGreaterThan(50);
    for (const m of models) {
      expect(m.inputPerMtokMicrocents, `${m.modelId} input`).toBeGreaterThan(0);
      expect(m.outputPerMtokMicrocents, `${m.modelId} output`).toBeGreaterThan(0);
      expect(Number.isInteger(m.inputPerMtokMicrocents), `${m.modelId} is an integer`).toBe(true);
    }
  });

  it('contains ZERO non-chat models — an embedding in the catalog becomes an embedding in the picker', () => {
    // `keepOpenAiModelId` short-circuits on `pricedIds.has(id)`, so once the catalog is the priced set, any
    // non-chat model in it is RESCUED past the live list's deny-list and offered to the user as a chat model.
    // `text-embedding-3-large` is priced upstream and arrived in the very first snapshot exactly that way.
    const nonChat = models.filter((m) =>
      /(^|[-_])(embedding|tts|image|realtime|audio)([-_]|$)/.test(m.modelId),
    );
    expect(nonChat.map((m) => m.modelId)).toEqual([]);
  });

  it('still carries the four models this whole workstream exists for', () => {
    // The bug report, and the three shapes a `reasoning: boolean` could never express.
    expect(CATALOG_SNAPSHOT['gpt-5.4-pro']?.reasoning).toEqual({
      effortValues: ['medium', 'high', 'xhigh'], // REJECTS `low`, which the picker offers today
    });
    expect(CATALOG_SNAPSHOT['gemini-2.5-pro']?.reasoning).toEqual({
      budgetTokens: { min: 128, max: 32_768 }, // no effort axis; min:128 ⇒ `off` is IMPOSSIBLE
    });
    expect(CATALOG_SNAPSHOT['claude-haiku-4-5']?.reasoning?.effortValues).toBeUndefined(); // budget, not effort
    expect(CATALOG_SNAPSHOT['deepseek-reasoner']?.reasoning).toEqual({}); // reasons, but no controllable tier
  });

  it('preserves the max-output ceiling and context window as DISTINCT fields (they are not interchangeable)', () => {
    // A swap here is invisible to a shallow test and would clamp max_tokens against the CONTEXT window — a
    // number ~3x too large on Opus, which is exactly the "max tokens error" this work is meant to end.
    const opus = CATALOG_SNAPSHOT['claude-opus-4-8'];
    expect(opus?.contextWindowTokens).toBe(1_000_000);
    expect(opus?.maxOutputTokens).toBe(128_000);
    // …and the drift the hand-typed table carried, now corrected from source:
    expect(CATALOG_SNAPSHOT['claude-sonnet-4-6']?.maxOutputTokens).toBe(128_000); // the table said 64_000
  });
});
