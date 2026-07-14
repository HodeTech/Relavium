import { z } from 'zod';

import type { ProviderId } from '../types.js';
import { isNonChatModelId } from '../model-kind.js';
import { providerIdForCatalogKey } from './catalog-providers.js';
import type {
  CatalogModel,
  CatalogPriceTier,
  ReasoningControls,
  RequestCapabilities,
} from './catalog-model.js';

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
 * a field we never read appeared. It is **strict about the MONEY fields** (`cost`, `limit`) — those bound the cost
 * cap and the output ceiling, and a bad value there must fail loudly. The ENRICHMENT fields (`reasoning`,
 * `reasoning_options`) sit in between: consumed, but parsed leniently (review M7) — a shape change there must never
 * EVICT a fully-priced model (which would read as a vanished price and fire the §9 guard), only thin its descriptor.
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
  // ENRICHMENT fields (`reasoning`, `reasoning_options`) are parsed LENIENTLY, decoupled from the money gate
  // (review M7). A fully-priced model must never be EVICTED because a field we merely enrich with changed shape:
  // upstream adding a new `reasoning_options.type` we don't recognize, or emitting `reasoning: null`, would make a
  // strict schema drop the model — and a dropped ALREADY-SHIPPED model reads to `diffCatalog` as a VANISHED price,
  // firing the §9 money guard red for a non-money reason. So `reasoning` tolerates `null`, and each
  // `reasoning_options` entry is validated ONE AT A TIME in {@link toReasoningControls} (an unrecognized shape is
  // skipped, yielding a thinner reasoning descriptor), never as a whole-array `discriminatedUnion` that one bad
  // element fails. The CONTAINER tolerates `null` AND a wrong TYPE (`.catch` → undefined): a `reasoning_options:
  // null` or an array→object change must thin the descriptor, not evict the priced model — element-only leniency
  // left that container-shape gap. `cost`/`limit` stay authoritative — they ARE the money surface — tolerating only
  // `null` (absent).
  reasoning: z.boolean().nullish(),
  reasoning_options: z
    .array(z.unknown())
    .nullish()
    .catch(() => undefined),
  // Per-model REQUEST capabilities (ADR-0071 amendment). Upstream carries these as top-level per-model booleans;
  // they vary per model within a provider (`gpt-5.6-luna` has `temperature: false`). ENRICHMENT, so `nullish` and
  // never fatal — a missing/odd value degrades to "accepted", the safe default.
  temperature: z.boolean().nullish(),
  tool_call: z.boolean().nullish(),
  structured_output: z.boolean().nullish(),
  attachment: z.boolean().nullish(),
  limit: LimitSchema.nullish(),
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
  models: z.record(z.string(), z.unknown()),
});

/**
 * The payload is a bag of providers, and it is parsed as `unknown` per provider for the same reason the models
 * are: **one malformed entry among 166 must not kill a sync that reads four of them.** `id` is not even required
 * here — we key providers by the record key (which `CATALOG_PROVIDER_KEYS` maps), so a provider stub that omits
 * its own `id` field is no reason to fail.
 */
export const ModelsDevPayloadSchema = z.record(z.string(), z.unknown());
export type ModelsDevPayload = z.infer<typeof ModelsDevPayloadSchema>;

/** A model the upstream payload carried but we could not use, and why. Surfaced by the sync, never swallowed. */
export interface DroppedModel {
  readonly provider: ProviderId;
  readonly modelId: string;
  readonly reason: string;
}

/** Normalize the upstream reasoning options into Relavium's control descriptor. Absent/empty ⇒ `undefined`.
 *  Each raw option is validated INDEPENDENTLY (review M7): an unrecognized shape is skipped, so a new upstream
 *  control type thins the descriptor rather than evicting the whole priced model via a failed array parse. */
function toReasoningControls(raw: z.infer<typeof ModelSchema>): ReasoningControls | undefined {
  if (raw.reasoning !== true) return undefined;
  const controls: {
    effortValues?: readonly string[];
    budgetTokens?: { readonly min: number; readonly max?: number };
    toggle?: true;
  } = {};
  for (const rawOption of raw.reasoning_options ?? []) {
    const parsed = ReasoningOptionSchema.safeParse(rawOption);
    if (!parsed.success) continue; // an unknown/ malformed control shape — skip it, keep the priced model
    const option = parsed.data;
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

/**
 * Normalize the upstream per-model request-capability booleans into Relavium's descriptor (ADR-0071 amendment).
 * Only a `false` (the model does NOT accept the parameter) is carried — absent/true/null all mean "accepted", the
 * safe default the adapters treat as "send it". Returns `undefined` when the model accepts everything, so the
 * common case adds NOTHING to the row.
 */
function toRequestCapabilities(raw: z.infer<typeof ModelSchema>): RequestCapabilities | undefined {
  const caps: {
    temperature?: boolean;
    toolCall?: boolean;
    structuredOutput?: boolean;
    attachment?: boolean;
  } = {};
  if (raw.temperature === false) caps.temperature = false;
  if (raw.tool_call === false) caps.toolCall = false;
  if (raw.structured_output === false) caps.structuredOutput = false;
  if (raw.attachment === false) caps.attachment = false;
  return Object.keys(caps).length === 0 ? undefined : caps;
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
  // A null/absent `limit` is treated as absent, not a parse error (review M7): the model is dropped cleanly (no
  // output ceiling to clamp against) rather than failing the whole row and reading as a VANISHED priced model.
  if (
    raw.cost === null ||
    raw.cost === undefined ||
    raw.limit === null ||
    raw.limit === undefined
  ) {
    return undefined;
  }
  const { cost, limit } = raw;
  const reasoning = toReasoningControls(raw);
  const requestCapabilities = toRequestCapabilities(raw);
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
    ...(requestCapabilities === undefined ? {} : { requestCapabilities }),
  };
}

/** Best-effort read of a FAILED row's `id`, for the drop report. `unknown` in, `string | undefined` out. */
function idOfUnvalidated(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id: unknown = (raw as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Normalize ONE upstream model row into `catalog`, or record why it was DROPPED — a malformed, non-chat, or
 * unpriceable row is a dropped model, never a dead sync. A model id that clashes ACROSS providers is a real
 * ambiguity and THROWS; a clash WITHIN one provider (two record keys that normalize to the same `id`) keeps the
 * first and drops the duplicate VISIBLY, rather than letting one arbitrarily overwrite a row already admitted.
 */
function processModel(
  providerId: ProviderId,
  recordKey: string,
  rawModel: unknown,
  catalog: Record<string, CatalogModel>,
  dropped: DroppedModel[],
): void {
  // NOT A CHAT MODEL — dropped before anything else, and this is load-bearing, not tidiness.
  //
  // `keepOpenAiModelId` short-circuits on `pricedIds.has(id)`: a PRICED id bypasses the live list's deny-list
  // entirely, so a cost-eligible model can never be filtered out. Once the catalog becomes the priced set, any
  // non-chat model in it would be *rescued* by that short-circuit and land in the user's model picker as something
  // to chat with. `text-embedding-3-large` is priced upstream and arrived in the very first snapshot exactly that
  // way. Sharing ONE filter with the live list (`isNonChatModelId`) is what makes the cascade impossible; two
  // filters that can disagree is what makes it inevitable.
  if (isNonChatModelId(recordKey)) return;

  const parsed = ModelSchema.safeParse(rawModel);
  if (!parsed.success) {
    // The reported id must be the MODEL'S OWN `id`, not the record key. The sync's shipped-model guard compares a
    // dropped id against the committed snapshot, which is keyed by model id — so a key that differs from the id
    // would let a model we already ship fall out of the catalog SILENTLY, taking its price (and therefore the cost
    // cap) with it. Upstream happens to key by id today; the guard must not depend on that. Best-effort here,
    // because the row failed validation and its `id` may be junk too.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ');
    dropped.push({
      provider: providerId,
      modelId: idOfUnvalidated(rawModel) ?? recordKey,
      reason: `schema: ${issues}`,
    });
    return;
  }

  const model = normalizeCatalogModel(providerId, parsed.data);
  if (model === undefined) {
    // Almost always an image model: upstream carries `cost: null` because it bills per IMAGE, an axis we do not
    // model. Importing it would write a $0 row — worse than absence, because a $0 row *passes* the cost cap instead
    // of flagging the model as unpriced.
    dropped.push({
      provider: providerId,
      modelId: parsed.data.id,
      reason: 'no cost or no limit (unpriceable)',
    });
    return;
  }

  const clash = catalog[model.modelId];
  if (clash !== undefined) {
    if (clash.provider !== providerId) {
      throw new Error(
        `catalog: model id '${model.modelId}' appears under BOTH '${clash.provider}' and '${providerId}'. ` +
          `The catalog is keyed by model id, so this is a real ambiguity — resolve it in CATALOG_PROVIDER_KEYS ` +
          `(is one of them a mirror, like google-vertex?) rather than letting one price silently win.`,
      );
    }
    // SAME provider, same id from a second record key (two aliases can normalize onto one `id`). Keep the first and
    // drop this duplicate visibly — an unconditional overwrite would let a later row silently replace an admitted
    // one's price, and a price change is exactly what this transform refuses to make in silence.
    dropped.push({
      provider: providerId,
      modelId: model.modelId,
      reason: `duplicate model id within '${providerId}' (record key '${recordKey}') — kept the first`,
    });
    return;
  }
  catalog[model.modelId] = model;
}

/**
 * Normalize a validated payload into the catalog snapshot — the whole build-time transform.
 *
 * Keyed by **model id alone**, matching the merge's existing key ({@link mergeModelCatalog} drops a
 * cross-provider id collision rather than letting one provider's price corrupt another's). A collision *within*
 * our four providers would be a real ambiguity, so it **throws** rather than silently picking a winner — a
 * generator that quietly halves the catalog is exactly the failure this whole workstream exists to end.
 */
export function normalizeCatalog(payload: ModelsDevPayload): {
  readonly catalog: Record<string, CatalogModel>;
  readonly dropped: readonly DroppedModel[];
} {
  const catalog: Record<string, CatalogModel> = {};
  const dropped: DroppedModel[] = [];

  for (const [upstreamKey, rawProvider] of Object.entries(payload)) {
    const providerId = providerIdForCatalogKey(upstreamKey);
    if (providerId === undefined) continue; // 162 upstream providers we have no adapter for — not callable.

    const provider = ProviderSchema.safeParse(rawProvider);
    if (!provider.success) {
      throw new Error(
        `catalog: provider '${upstreamKey}' — which we DO import — has no usable \`models\` map. Refusing to ` +
          `continue: silently importing zero models for a provider we can call would leave every one of its ` +
          `models unpriced, and an unpriced model skips the cost cap.`,
      );
    }

    for (const [recordKey, rawModel] of Object.entries(provider.data.models)) {
      // ONE MODEL AT A TIME. A malformed row is a dropped model, not a dead sync (see `ProviderSchema`).
      processModel(providerId, recordKey, rawModel, catalog, dropped);
    }
  }
  return { catalog, dropped };
}
