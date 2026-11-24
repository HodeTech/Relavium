import {
  createModelCatalogStore,
  createModelMetadataStore,
  createProviderStore,
  isOwnedStorageFailure,
  type Db,
} from '@relavium/db';
import type { ModelCatalogEntry, ModelPricing } from '@relavium/llm';

import {
  catalogTokenRates,
  clearedPricingSentence,
  commitPricing,
  preparePricing,
  pricingSetSentence,
  type ModelsPricingCommandArgs,
  type PricingPlan,
} from '../commands/models-pricing.js';
import {
  PRICING_FIELDS,
  priceArgsFromText,
  pricingField,
  usdTextOfMicrocents,
  type PricingFieldId,
} from '../commands/pricing-fields.js';
import { installCatalogFromDb } from '../engine/catalog-metadata.js';
import { isCliError } from '../process/errors.js';
import { sanitizeUntrustedInline } from '../render/sanitize.js';
import {
  PRICING_MODEL_ID_FAULTS,
  pricingModelIdFault,
  type PricingAttempt,
  type PricingOffer,
  type PricingPort,
  type PricingPrepared,
  type PricingTarget,
  type PricingValues,
} from '../render/tui/pricing-card.js';

/**
 * What the Home's pricing form reads and writes, over the Home's own history database
 * ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §9, MVP-8 step 5).
 * It is `relavium models pricing`'s own core: {@link preparePricing} (resolve, validate against the field table, decide the exact row;
 * nothing written) and {@link commitPricing} (the one write), so the form records exactly what the command would, under the same
 * refusals. The form names a refused field by its label (`naming: 'label'`), because a person at a prompt never typed a flag.
 *
 * - **A refusal is text.** Every refusal of the core is a {@link CliError}; the port turns it into a sanitized, bounded sentence. Any other
 *   fault is a defect and ends the Home (ADR-0139): it is never dressed up as a sentence.
 * - **A write fault is a fixed sentence.** The database refusing the write (locked, read-only, full, corrupt) says so in words that quote no
 *   path and no engine message. Nothing is recorded in that case, and the sentence says so.
 * - **The card says what is recorded.** A model id the terminal cannot show faithfully is refused before the card asks, so the id on the
 *   card is the id that is stored.
 */

export interface PricingPortDeps {
  /** The Home's one open `history.db` handle: the catalog and the provider registry are read and written through it. */
  readonly db: Db;
  readonly uuid: () => string;
  readonly now: () => number;
  /** The merged catalog the `/models` picker lists (`createModelCatalogPort(...).load().entries`). Read when the form opens. */
  readonly models: () => readonly ModelCatalogEntry[];
}

/** The longest reason a refusal shows, in code units: a CliError's message can quote a model id. */
const REASON_LIMIT = 240;

function reasonOf(cause: unknown): string | undefined {
  if (!isCliError(cause)) return undefined;
  const text = sanitizeUntrustedInline(cause.message);
  return text.length <= REASON_LIMIT ? text : `${text.slice(0, REASON_LIMIT - 1)}…`;
}

/** What the person is told when the database refuses the write. Fixed: an engine message can quote a path. */
export const PRICING_WRITE_FAULT =
  'The price could not be written: the history database is unavailable (locked, read-only or full). Nothing was recorded.';

/** The fixed sentence for a write the database refused by one of SQLite's own result codes; none for any other fault (a bug ends the Home). */
function writeFaultReasonOf(cause: unknown): string | undefined {
  if (isOwnedStorageFailure(cause)) return PRICING_WRITE_FAULT;
  if (typeof cause !== 'object' || cause === null) return undefined;
  const code: unknown = Object.getOwnPropertyDescriptor(cause, 'code')?.value;
  return typeof code === 'string' && code.startsWith('SQLITE_') ? PRICING_WRITE_FAULT : undefined;
}

/** `your price` / `catalog price` / `no price`: where the model's price comes from now, as the picker's hint. */
function pricingSourceText(entry: ModelCatalogEntry): string {
  if (entry.pricingSource === 'user') return 'your price';
  return entry.pricingSource === 'catalog' ? 'catalog price' : 'no price';
}

/** The catalog's rates a SET replaces: the token pair when it states them, and the cached rate when it states that. */
function replacedRates(plan: PricingPlan): string | undefined {
  if (plan.kind !== 'set' || plan.shipped === undefined) return undefined;
  const stated = (id: PricingFieldId): boolean => plan.prices.some((price) => price.id === id);
  const shipped: ModelPricing = plan.shipped;
  const parts = [
    ...(stated('input') ? [catalogTokenRates(shipped)] : []),
    ...(stated('cached')
      ? [`cached $${usdTextOfMicrocents(shipped.cachedInputPerMtokMicrocents)}/Mtok`]
      : []),
  ];
  return parts.length === 0 ? undefined : parts.join(', ');
}

/** The card's offer for a plan: the numbers and words, derived from the plan alone, so what it shows is what the plan holds. */
function offerOf(plan: PricingPlan): PricingOffer {
  const model = sanitizeUntrustedInline(plan.model);
  if (plan.kind === 'clear') {
    return {
      kind: 'clear',
      model,
      provider: plan.provider,
      prices: [],
      keeps: false,
      replaces: undefined,
      fallback: plan.shipped === undefined ? undefined : catalogTokenRates(plan.shipped),
    };
  }
  return {
    kind: 'set',
    model,
    provider: plan.provider,
    prices: plan.prices.map((price) => {
      const field = pricingField(price.id);
      return {
        id: price.id,
        label: field.label,
        amount: `$${usdTextOfMicrocents(price.microcents)}${field.suffix}`,
        microcents: price.microcents,
      };
    }),
    keeps: plan.prices.length < PRICING_FIELDS.length,
    replaces: replacedRates(plan),
    fallback: undefined,
  };
}

/** The core's arguments for what the person asked: a CLEAR, or a SET parsed from the text of each price they gave. */
function argsOf(target: PricingTarget, values: PricingValues): ModelsPricingCommandArgs {
  if (values.action === 'clear')
    return { clear: true, model: target.modelId, provider: target.provider };
  // An empty text is "not set": the same as the field never having been asked.
  const stated: Partial<Record<PricingFieldId, string>> = {};
  for (const field of PRICING_FIELDS) {
    const text = values.prices[field.id]?.trim();
    if (text !== undefined && text !== '') stated[field.id] = text;
  }
  return {
    model: target.modelId,
    provider: target.provider,
    ...priceArgsFromText(stated, 'label'),
  };
}

export function createPricingPort(deps: PricingPortDeps): PricingPort {
  const storeDeps = { uuid: deps.uuid, now: deps.now };
  const catalog = createModelCatalogStore(deps.db, storeDeps);
  const providers = createProviderStore(deps.db, storeDeps);
  const metadata = createModelMetadataStore(deps.db, { now: deps.now });

  /**
   * The catalog the core reads (`catalogModel`, `catalogPricing`) is the process's: the snapshot, and the overlay a refresh installed.
   * The database is that overlay's durable backing ([ADR-0072](../../../../docs/decisions/0072-model-metadata-in-the-db-behind-a-generated-offline-floor.md)
   * point 7), so before a plan is decided the overlay is read from it: a model only a refresh has seen is anchored to its provider and
   * priced for tokens here as everywhere else, and a price cannot be stored under a provider the catalog would never apply it for.
   * Read only (`prepare` writes nothing), and best-effort: a database fault leaves the file cache and the snapshot answering.
   */
  const readCatalogFromDb = (): void => {
    try {
      installCatalogFromDb(metadata);
    } catch {
      // Not a reason to refuse a price: the overlay already installed, and under it the snapshot floor, still answer.
    }
  };

  const commitOf = (plan: PricingPlan) => (): PricingAttempt => {
    let sentence: string;
    try {
      // The re-check of the cross-provider rule and the write are one IMMEDIATE transaction: a `models pricing` from a shell while the
      // card was open cannot slip a second provider's price in between them.
      const outcome = commitPricing(plan, {
        catalog,
        providers,
        atomically: (work) => deps.db.transaction(work, { behavior: 'immediate' }),
      });
      sentence =
        plan.kind === 'set'
          ? pricingSetSentence(plan)
          : clearedPricingSentence(plan, outcome.kind === 'clear' && outcome.cleared);
    } catch (cause) {
      // A fault the person can act on is a refusal, not the end of the Home; anything else is a defect (ADR-0139).
      const reason = reasonOf(cause) ?? writeFaultReasonOf(cause);
      if (reason === undefined) throw cause;
      return { ok: false, reason };
    }
    return { ok: true, written: sanitizeUntrustedInline(sentence) };
  };

  return {
    models: () =>
      deps.models().map((entry) => ({
        modelId: entry.modelId,
        provider: entry.provider,
        hint: `${entry.provider} · ${pricingSourceText(entry)}`,
      })),
    providers: () => providers.list().map((provider) => provider.name),
    prepare: (target, values): PricingPrepared => {
      // The card states the model id it records, and says it exactly: an id the card cannot show as it is stored (a control byte, a
      // bidirectional override, a zero-width or other invisible character, a space at either end, more than it can fit) would be
      // recorded as one thing and shown as another, so it is refused here, before anything is asked. This is the boundary: it holds for
      // a hand-typed id and for one the catalog lists.
      const fault = pricingModelIdFault(target.modelId);
      if (fault !== undefined) return { ok: false, reason: PRICING_MODEL_ID_FAULTS[fault] };
      readCatalogFromDb();
      let plan: PricingPlan;
      try {
        plan = preparePricing(argsOf(target, values), { catalog, providers }, 'label');
      } catch (cause) {
        const reason = reasonOf(cause);
        if (reason === undefined) throw cause;
        return { ok: false, reason };
      }
      // A CLEAR of a model the operator has no price for would ask for a Yes to change nothing: it is said, not asked.
      if (plan.kind === 'clear' && !plan.hasOverride)
        return { ok: false, reason: sanitizeUntrustedInline(clearedPricingSentence(plan, false)) };
      return { ok: true, offer: offerOf(plan), commit: commitOf(plan) };
    },
  };
}
