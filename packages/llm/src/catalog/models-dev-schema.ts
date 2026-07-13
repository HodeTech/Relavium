import { z } from 'zod';

import type { ProviderId } from '../types.js';
import { providerIdForCatalogKey } from './catalog-providers.js';
import type { CatalogModel, CatalogPriceTier, ReasoningControls } from './catalog-model.js';

/**
 * The BOUNDARY between the upstream metadata catalog and Relavium
 * ([ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §11).
 *
 * Everything in this file describes a **third-party payload**, and nothing in it escapes: the raw shapes below
 * (`reasoning_options`, `cost.tiers`, `limit.input`, …) are Zod-parsed and normalized into
 * {@link CatalogModel} before any other Relavium code sees them. That is what keeps the upstream source a
 * *replaceable implementation detail* rather than an architectural commitment — the same discipline
 * [ADR-0064](../../../../docs/decisions/0064-live-model-catalog.md) §1 applies to a provider's `ModelListing`.
 *
 * The schema is **deliberately lenient about fields we do not consume** (`.passthrough()` is NOT used — unknown
 * keys are simply dropped by Zod's default strip). Upstream adds fields regularly; a sync must not fail because
 * a field we never read appeared. It is **strict about the fields we DO consume**, because those feed a money
 * surface and a wire parameter.
 */

/** USD-per-million-tokens → integer micro-cents-per-million-tokens. 1 USD = 1e8 micro-cents; no float, ever. */
const USD_PER_MTOK_TO_MICROCENTS = 100_000_000;
const toMicrocents = (usdPerMtok: number): number =>
  Math.round(usdPerMtok * USD_PER_MTOK_TO_MICROCENTS);

/** A price must be a non-negative, finite USD figure. A negative or NaN rate would corrupt the cost cap. */
const UsdRate = z.number().finite().nonnegative();

/**
 * One context-size pricing tier. Upstream expresses "above N context tokens, the rate changes" — which our flat
 * `ModelPricing` cannot say, and which understates long-context spend by up to 2× if ignored (`gemini-2.5-pro`
 * is 1.25/10 below 200k and **2.5/15 above**).
 */
const CostTierSchema = z.object({
  input: UsdRate,
  output: UsdRate,
  cache_read: UsdRate.optional(),
  tier: z.object({ type: z.string(), size: z.number().finite().positive() }),
});

const CostSchema = z.object({
  input: UsdRate,
  output: UsdRate,
  /**
   * ABSENT ≠ 0. 19 of the ~97 models we import carry no cache-read rate (including `gpt-5.4-pro`). Coercing an
   * absent rate to `0` would price cached input at **zero** — a silent undercharge in the very mechanism this
   * work is hardening. It stays `undefined` and the cost path falls back to the full input rate (§11).
   */
  cache_read: UsdRate.optional(),
  cache_write: UsdRate.optional(),
  tiers: z.array(CostTierSchema).optional(),
});

const LimitSchema = z.object({
  context: z.number().finite().positive(),
  /** The model's max OUTPUT tokens — the ceiling nothing clamps against today, which is half of "max tokens errors". */
  output: z.number().finite().positive(),
});

/**
 * The reasoning control, as upstream describes it — and the single most valuable field in the payload.
 *
 * Its **`type` is the shape of the control**, and the shape is **per model, not per provider**: `gemini-2.5-*`
 * take `budget_tokens`, `gemini-3.x` take `effort`, `gemma` takes `toggle`. Assuming one shape for a whole
 * adapter is precisely the false premise that shipped as a live bug (ADR-0066's dated correction note).
 *
 * `values` are **PROVIDER-WIRE** strings (`none|minimal|low|medium|high|xhigh|max`), NOT Relavium's normalized
 * `ReasoningEffort`. They are carried through as-is and are only ever *composed* with an adapter's wire map by
 * `acceptedTiers` — reading them as our tiers would silently drop `off` from every Claude model.
 */
const ReasoningOptionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('effort'), values: z.array(z.string().min(1)).min(1) }),
  z.object({
    type: z.literal('budget_tokens'),
    min: z.number().finite().nonnegative(),
    max: z.number().finite().positive().optional(),
  }),
  z.object({ type: z.literal('toggle') }),
]);

const ModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  reasoning: z.boolean().optional(),
  reasoning_options: z.array(ReasoningOptionSchema).optional(),
  limit: LimitSchema.optional(),
  /** `null` on every image model upstream — priced per image, an axis we do not model (§11). */
  cost: CostSchema.nullish(),
});

export type ModelsDevModel = z.infer<typeof ModelSchema>;

/**
 * The payload's OUTER structure only — deliberately shallow.
 *
 * The first draft of this validated the whole 166-provider payload with one strict schema, and it **failed on
 * the very first run**: `requesty` — a provider Relavium has no adapter for and can never call — publishes a
 * `budget_tokens` option with no `min`, and that one malformed entry killed the entire sync. Validating a
 * third-party payload wholesale makes us hostage to 162 providers' data quality for data we never read.
 *
 * So the rule is: **validate what we consume; do not parse what we do not.** The models of our four providers
 * are validated ONE AT A TIME below (`parseModels`), so a single bad row is a dropped model, not a dead sync.
 */
const ProviderSchema = z.object({
  id: z.string().min(1),
  models: z.record(z.string(), z.unknown()),
});
export const ModelsDevPayloadSchema = z.record(z.string(), ProviderSchema);
export type ModelsDevPayload = z.infer<typeof ModelsDevPayloadSchema>;

/** A model the upstream payload carried but we could not use, and why. Surfaced by the sync, never swallowed. */
export interface DroppedModel {
  readonly provider: ProviderId;
  readonly modelId: string;
  readonly reason: string;
}

/** Normalize the upstream reasoning options into Relavium's control descriptor. Absent/empty ⇒ `undefined`. */
function toReasoningControls(raw: z.infer<typeof ModelSchema>): ReasoningControls | undefined {
  if (raw.reasoning !== true) return undefined;
  const controls: {
    effortValues?: readonly string[];
    budgetTokens?: { readonly min: number; readonly max?: number };
    toggle?: true;
  } = {};
  for (const option of raw.reasoning_options ?? []) {
    if (option.type === 'effort') controls.effortValues = option.values;
    else if (option.type === 'budget_tokens') {
      controls.budgetTokens =
        option.max === undefined ? { min: option.min } : { min: option.min, max: option.max };
    } else controls.toggle = true;
  }
  // `reasoning: true` with NO options is a real upstream shape (e.g. `deepseek-reasoner`): the model reasons,
  // but exposes no control. That is NOT the same as "no reasoning" — the descriptor exists and is empty, which
  // is what tells the picker to offer nothing rather than to offer everything.
  return controls;
}

function toPriceTiers(
  cost: NonNullable<z.infer<typeof CostSchema>>,
): readonly CatalogPriceTier[] | undefined {
  if (cost.tiers === undefined || cost.tiers.length === 0) return undefined;
  return cost.tiers.map((tier) => ({
    aboveContextTokens: tier.tier.size,
    inputPerMtokMicrocents: toMicrocents(tier.input),
    outputPerMtokMicrocents: toMicrocents(tier.output),
    ...(tier.cache_read === undefined
      ? {}
      : { cachedInputPerMtokMicrocents: toMicrocents(tier.cache_read) }),
  }));
}

/**
 * Normalize ONE upstream model into a {@link CatalogModel}, or `undefined` if it is not usable as a chat model.
 *
 * A model is **dropped** when it has no `cost` or no `limit` — upstream's image models carry `cost: null`, and
 * they are priced per image, an axis Relavium does not model. Importing them would put rows in the catalog that
 * claim a price of zero, which is worse than their absence: a $0 row *engages* the cost cap and passes it.
 */
export function normalizeCatalogModel(
  provider: ProviderId,
  raw: ModelsDevModel,
): CatalogModel | undefined {
  if (raw.cost === null || raw.cost === undefined || raw.limit === undefined) return undefined;
  const { cost, limit } = raw;
  const reasoning = toReasoningControls(raw);
  const tiers = toPriceTiers(cost);
  return {
    provider,
    modelId: raw.id,
    displayName: raw.name,
    contextWindowTokens: limit.context,
    maxOutputTokens: limit.output,
    inputPerMtokMicrocents: toMicrocents(cost.input),
    outputPerMtokMicrocents: toMicrocents(cost.output),
    ...(cost.cache_read === undefined
      ? {}
      : { cachedInputPerMtokMicrocents: toMicrocents(cost.cache_read) }),
    ...(cost.cache_write === undefined
      ? {}
      : { cacheWritePerMtokMicrocents: toMicrocents(cost.cache_write) }),
    ...(tiers === undefined ? {} : { contextTiers: tiers }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

/**
 * Normalize a validated payload into the catalog snapshot — the whole build-time transform.
 *
 * Keyed by **model id alone**, matching the merge's existing key ({@link mergeModelCatalog} drops a
 * cross-provider id collision rather than letting one provider's price corrupt another's). A collision *within*
 * our four providers would be a real ambiguity, so it **throws** rather than silently picking a winner — a
 * generator that quietly halves the catalog is exactly the failure this whole workstream exists to end.
 */
/** Best-effort read of a FAILED row's `id`, for the drop report. `unknown` in, `string | undefined` out. */
function idOfUnvalidated(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id: unknown = (raw as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

export function normalizeCatalog(payload: ModelsDevPayload): {
  readonly catalog: Record<string, CatalogModel>;
  readonly dropped: readonly DroppedModel[];
} {
  const catalog: Record<string, CatalogModel> = {};
  const dropped: DroppedModel[] = [];

  for (const [upstreamKey, provider] of Object.entries(payload)) {
    const providerId = providerIdForCatalogKey(upstreamKey);
    if (providerId === undefined) continue; // 162 upstream providers we have no adapter for — not callable.

    for (const [recordKey, rawModel] of Object.entries(provider.models)) {
      // ONE MODEL AT A TIME. A malformed row is a dropped model, not a dead sync (see `ProviderSchema`).
      const parsed = ModelSchema.safeParse(rawModel);
      if (!parsed.success) {
        // The reported id must be the MODEL'S OWN `id`, not the record key. The sync's shipped-model guard
        // compares a dropped id against the committed snapshot, which is keyed by model id — so a key that
        // differs from the id would let a model we already ship fall out of the catalog SILENTLY, taking its
        // price (and therefore the cost cap) with it. Upstream happens to key by id today; the guard must not
        // depend on that. Best-effort here, because the row failed validation and its `id` may be junk too.
        dropped.push({
          provider: providerId,
          modelId: idOfUnvalidated(rawModel) ?? recordKey,
          reason: `schema: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        });
        continue;
      }
      const model = normalizeCatalogModel(providerId, parsed.data);
      if (model === undefined) {
        // Almost always an image model: upstream carries `cost: null` because it bills per IMAGE, an axis we do
        // not model. Importing it would write a $0 row — worse than absence, because a $0 row *passes* the cost
        // cap instead of flagging the model as unpriced.
        dropped.push({
          provider: providerId,
          modelId: parsed.data.id,
          reason: 'no cost or no limit (unpriceable)',
        });
        continue;
      }

      const clash = catalog[model.modelId];
      if (clash !== undefined && clash.provider !== providerId) {
        throw new Error(
          `catalog: model id '${model.modelId}' appears under BOTH '${clash.provider}' and '${providerId}'. ` +
            `The catalog is keyed by model id, so this is a real ambiguity — resolve it in CATALOG_PROVIDER_KEYS ` +
            `(is one of them a mirror, like google-vertex?) rather than letting one price silently win.`,
        );
      }
      catalog[model.modelId] = model;
    }
  }
  return { catalog, dropped };
}
