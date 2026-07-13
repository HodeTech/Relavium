import type { CatalogModel, CatalogSnapshot } from './catalog-model.js';

/**
 * The catalog's MONEY GUARDS — what must never change silently
 * ([ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §9).
 *
 * These live here, in typed and unit-tested code, rather than in the sync tool — and that is a correction, not a
 * preference. The first version compared prices by **regex-matching the generated snapshot's text**, and it was
 * blind in a way nobody would have noticed:
 *
 *   Prettier's default `quoteProps: 'as-needed'` strips quotes from any key that is a valid JS identifier. Two
 *   of our ninety models — `o1` and `o3` — are therefore emitted **unquoted**, the regex required a quote, and
 *   so those two models had **no baseline at all**. A halved `o1` price passed the guard in silence, and the
 *   fatal "a shipped model was dropped" check could not fire for them either.
 *
 * The lesson is structural: the generated file's exact bytes are *prettier's* decision, not the tool's, so any
 * guard that reads them as text is one formatting default away from going quietly blind. Diff the **data**.
 */

/**
 * Every money field of a model, as one comparable string.
 *
 * ALL of them, not just the flat pair. The first version compared `input/output` only — leaving `cache_read`,
 * `cache_write`, and **every context tier** unguarded. That is the worst possible field to miss: the pre-egress
 * estimate takes the **highest applicable tier**, so for any long-context turn the *tier* rate — not the flat
 * rate — is the number that sizes the ADR-0028 cap. Twelve of our ninety models are tiered. Halving only
 * `gemini-2.5-pro`'s >200k tier moved no flat rate, tripped nothing, and would have capped every long-context
 * turn against half its true cost.
 */
export function moneyFingerprint(model: CatalogModel): string {
  const tiers = (model.contextTiers ?? [])
    .map(
      (t) =>
        `${t.aboveContextTokens}:${t.inputPerMtokMicrocents}/${t.outputPerMtokMicrocents}/${t.cachedInputPerMtokMicrocents ?? '-'}`,
    )
    .join(',');
  return [
    model.inputPerMtokMicrocents,
    model.outputPerMtokMicrocents,
    model.cachedInputPerMtokMicrocents ?? '-', // `-` ≠ `0`: absent means "no rate", 0 means "no discount".
    model.cacheWritePerMtokMicrocents ?? '-',
    tiers,
  ].join('|');
}

/** A shipped model whose price moved. */
export interface MovedPrice {
  readonly modelId: string;
  readonly before: string;
  readonly after: string;
}

export interface CatalogDiff {
  /** Models we already ship whose money changed. A human decision — never a silent bot commit. */
  readonly moved: readonly MovedPrice[];
  /**
   * Models we already ship that are **GONE** from the new catalog — for ANY reason: upstream deleted them,
   * upstream stopped pricing them, a provider-key edit erased a whole provider, the deny-list started matching
   * them. The first version could only see models the normalizer explicitly *dropped*; a model that simply
   * VANISHED from the payload appeared in no list at all and was removed in silence. An absent model is an
   * UNPRICED model, and an unpriced model skips the cost cap entirely — so this is fatal by design.
   */
  readonly vanished: readonly string[];
  /** New models. These merge freely: adding a price can only ever *increase* what the cap covers. */
  readonly added: readonly string[];
}

/**
 * Diff the committed snapshot against a freshly-normalized catalog.
 *
 * `added` is informational. `moved` and `vanished` are the two ways a sync can quietly weaken a **safety
 * control**, and the sync refuses both unless a human says otherwise.
 */
export function diffCatalog(
  before: CatalogSnapshot,
  after: Readonly<Record<string, CatalogModel>>,
): CatalogDiff {
  const moved: MovedPrice[] = [];
  const vanished: string[] = [];
  const added: string[] = [];

  for (const [modelId, shipped] of Object.entries(before)) {
    const fresh = after[modelId];
    if (fresh === undefined) {
      vanished.push(modelId);
      continue;
    }
    const wasFingerprint = moneyFingerprint(shipped);
    const nowFingerprint = moneyFingerprint(fresh);
    if (wasFingerprint !== nowFingerprint) {
      moved.push({ modelId, before: wasFingerprint, after: nowFingerprint });
    }
  }
  for (const modelId of Object.keys(after)) {
    if (before[modelId] === undefined) added.push(modelId);
  }
  return { moved, vanished, added };
}
