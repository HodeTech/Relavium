import type { ModelCatalogStore, ModelCatalogUpsert, ProviderStore } from '@relavium/db';
import { catalogModel, catalogPricing, type ModelPricing } from '@relavium/llm';

import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { writeRecordLines } from '../render/records.js';
import { stripTerminalControls } from '../render/tui/chat-projection.js';
import {
  PRICING_FIELDS,
  modelIdFault,
  modelIdSentence,
  noTokenPriceSentence,
  pairingIssue,
  pairingSentence,
  priceToMicrocents,
  pricingField,
  usdTextOfMicrocents,
  type PriceArgs,
  type PriceColumn,
  type PricingFieldId,
  type PricingNaming,
} from './pricing-fields.js';

/**
 * SET a price, or CLEAR one — a discriminated union, so a `--clear` invocation cannot carry a price and a set
 * invocation cannot forget one. The two are different acts, and typing them as one optional-riddled shape is how a
 * half-applied invocation gets written.
 */
export type ModelsPricingCommandArgs = SetPricingArgs | ClearPricingArgs;

export interface SetPricingArgs extends PriceArgs {
  readonly clear?: undefined;
  /** The model id to price. Since ADR-0071 §1 this MAY be one the catalog already knows — the user outranks it. */
  readonly model: string;
  /** The provider slug that serves the model — must be registered, AND must be the one the catalog anchors the model
   *  to (a contradicting price would never be applied anywhere, so it is refused rather than stored). */
  readonly provider: string;
  // The prices are the field table's ({@link PRICING_FIELDS}); each is present only when it was stated, and each is
  // quoted in the field's unit — USD per million tokens for the token three, USD per BILLED UNIT (an image, a second;
  // ADR-0044 §3's canonical units, ADR-0089 §4) for the media three.
  //
  // `inputUsdPerMtok` and `outputUsdPerMtok` are **given together or not at all** (the pairing rule). They are optional
  // since [ADR-0089](../../../../docs/decisions/0089-media-correctness-four-boundaries.md) §4(c): a MEDIA-ONLY invocation is
  // how a user satisfies a strict cap that refused a generation on a model the catalog already prices for tokens. Forcing
  // token rates there would make them restate numbers they may not know into a row that outranks the catalog — and the
  // plausible-looking `--input 0 --output 0` would then bill every token on that model at nothing. Omitted ⇒ the upsert
  // omits the column and the store preserves whatever the row already had.
  //
  // `cachedInputUsdPerMtok` omitted ⇒ the row records that it was NOT stated (migration 0011), and a reader derives it: the
  // catalog's cache DISCOUNT applied to the input rate the user gave. A stated `0` is believed: the flag is what lets a
  // stored `0` mean "free" rather than "nobody said". The media columns are NULLABLE, so a stated `0` and an unstated
  // rate are already distinct on disk and need no companion flag.
}

/** `models pricing <model> --provider <p> --clear` — retire the override; the model falls back to the catalog. */
export interface ClearPricingArgs {
  readonly clear: true;
  readonly model: string;
  readonly provider: string;
}

export interface ModelsPricingCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /** The catalog store — `upsert` writes the `source='user'` row (a pricing-only patch; the store preserves the
   *  existing row's display/limits + media columns). `listAll` is read only to reject a cross-provider duplicate
   *  (the overlay keys by model id, so the same id priced under two providers would be ambiguous). */
  readonly catalog: Pick<ModelCatalogStore, 'upsert' | 'listAll' | 'clearUserPricing'>;
  /** The provider registry — resolves the `<slug>` → its internal `llm_providers` UUID (the catalog FK). */
  readonly providers: Pick<ProviderStore, 'list'>;
  /**
   * Runs {@link commitPricing}'s re-check and its write as ONE unit, in an IMMEDIATE transaction (`db.transaction(work, { behavior:
   * 'immediate' })`), so nothing can write between the re-check and the write. Absent ⇒ the work simply runs (a test with no
   * database; the output is the same).
   */
  readonly atomically?: <T>(work: () => T) => T;
}

/** What {@link preparePricing} reads. It writes nothing, so it takes no store method that does. */
export interface PreparePricingDeps {
  readonly catalog: Pick<ModelCatalogStore, 'listAll'>;
  readonly providers: Pick<ProviderStore, 'list'>;
}

/**
 * What {@link commitPricing} writes through: the one write of the command, and the reads of the one rule it checks again (the
 * cross-provider duplicate), which another process can break between the prepare and the commit.
 */
export interface CommitPricingDeps {
  readonly catalog: Pick<ModelCatalogStore, 'upsert' | 'clearUserPricing' | 'listAll'>;
  readonly providers: Pick<ProviderStore, 'list'>;
  /** See {@link ModelsPricingCommandDeps.atomically}. */
  readonly atomically?: <T>(work: () => T) => T;
}

/**
 * One price a SET states: the field and the integer micro-cents that will be stored. The USD as it was typed is not kept: every line
 * that names a price says the stored integer ({@link usdTextOfMicrocents}), so no sentence can say a price the database does not hold.
 */
export interface PlannedPrice {
  readonly id: PricingFieldId;
  readonly microcents: number;
}

/**
 * Everything a SET will do, decided and validated, with nothing written: the model and provider, the prices it states (in the field
 * table's order) and the exact row the store will be given. The Home's card shows this; {@link commitPricing} writes exactly this.
 */
export interface SetPricingPlan {
  readonly kind: 'set';
  readonly model: string;
  readonly provider: string;
  readonly providerId: string;
  readonly prices: readonly PlannedPrice[];
  /** The upsert, exactly as the store will receive it: a pricing-only patch, so every column it omits is PRESERVED. */
  readonly upsert: ModelCatalogUpsert;
  /** The catalog's own price for the model, which a stated token or cached price replaces; `undefined` when it prices none. */
  readonly shipped: ModelPricing | undefined;
}

/** A CLEAR, decided with nothing written: whether the operator has an override for the model now, and what the catalog would give. */
export interface ClearPricingPlan {
  readonly kind: 'clear';
  readonly model: string;
  readonly provider: string;
  readonly providerId: string;
  /** Whether an active `source='user'` row exists for this model and provider as of the prepare. The commit's answer is the truth. */
  readonly hasOverride: boolean;
  readonly shipped: ModelPricing | undefined;
}

export type PricingPlan = SetPricingPlan | ClearPricingPlan;

/** What a commit did: a SET wrote its row; a CLEAR retired a row, or found none to retire. */
export type PricingOutcome =
  | { readonly kind: 'set' }
  | { readonly kind: 'clear'; readonly cleared: boolean };

/** The POSIX way to carry a literal `'` through single quotes: close, escape, reopen. */
const ESCAPED_SINGLE_QUOTE = String.raw`'\''`;

/**
 * POSIX single-quote a value inside a command this message tells the user to paste.
 *
 * `stripTerminalControls` makes a model id safe to PRINT; it says nothing about a shell. Today's snapshot
 * ids are all safe, but they are not ours — a future catalog entry carrying `;` or a backtick would be
 * pasted into a command this text vouched for. The sibling remedies in `effort-notice.ts` and
 * `budget-governor.ts` already do this; this one was missed.
 */
function shellArg(value: string): string {
  // The escape is hoisted OUT of the template: a `String.raw` nested inside another template literal is
  // three layers of quoting in one expression, and this one is security-relevant enough to read at a glance.
  const escaped = value.replaceAll("'", ESCAPED_SINGLE_QUOTE);
  return `'${escaped}'`;
}

// ── prepare: resolve, validate, plan — and write nothing ───────────────────────────────────────────────────────────────────

/**
 * Decide what `models pricing` will do, and refuse what it must refuse, WITHOUT writing: the provider and the catalog's anchoring
 * are resolved, the prices are validated against the field table and converted, and the result is the plan {@link commitPricing}
 * writes. A refusal is a thrown {@link CliError} (a clean exit `2`, nothing written).
 *
 * The shell calls this, then {@link commitPricing}, then prints; the Home's `/pricing` form calls the same two steps and shows the
 * plan on a card between them, so the card says exactly what the write does. `naming` is how a refusal names a field: by the
 * shell's flag (the default, and what the shell pins) or by the form's label.
 */
export function preparePricing(
  args: ModelsPricingCommandArgs,
  deps: PreparePricingDeps,
  naming: PricingNaming = 'flag',
): PricingPlan {
  // The guard that lived here REFUSED a price for a model the shipped table already knew, because the table always
  // won and the override would have been a silent no-op. It is gone with the table (ADR-0071 §1): pricing now
  // resolves USER → CATALOG, so overriding a catalog model is not a mistake to be prevented — it is the feature.
  // The user has a negotiated rate, or an enterprise discount, or simply a price our snapshot has not caught up
  // with, and they are the one holding the invoice.
  // Provider guard: the catalog row's FK targets `llm_providers`, so the provider must already be registered.
  const providerRow = deps.providers.list().find((p) => p.name === args.provider);
  if (providerRow === undefined) {
    throw new CliError(
      'invalid_invocation',
      `unknown provider '${args.provider}' — register it first (e.g. \`relavium provider add ${args.provider}\` or \`relavium provider set-key ${args.provider}\`).`,
    );
  }

  // `--clear` (ADR-0071 §5): retire the override and fall back to the catalog. The ONLY way back from a price the
  // user regrets — before it existed, an override could be corrected but never removed, so a model priced by mistake
  // stayed priced by the user for good.
  if (args.clear === true) {
    const hasOverride = deps.catalog
      .listAll()
      .some(
        (row) =>
          row.modelId === args.model && row.providerId === providerRow.id && row.source === 'user',
      );
    return {
      kind: 'clear',
      model: args.model,
      provider: args.provider,
      providerId: providerRow.id,
      hasOverride,
      shipped: catalogPricing(args.model),
    };
  }
  return prepareSet(args, deps, providerRow.id, naming);
}

/** The refusals and the conversion of a SET, in the order the shell has always applied them. */
function prepareSet(
  args: SetPricingArgs,
  deps: PreparePricingDeps,
  providerId: string,
  naming: PricingNaming,
): SetPricingPlan {
  // The model id is the first thing a price is recorded under: an id the terminal would show as another id is refused before anything
  // else is read (the field table's rule, which the Home's form reads as well). A CLEAR is never refused by it, so an id stored before
  // the rule can still be removed.
  const idFault = modelIdFault(args.model);
  if (idFault !== undefined) throw new CliError('invalid_invocation', modelIdSentence(idFault));

  // The pairing rule is the field table's, and it lives here as well as in the shell's parser: whatever calls the core — the shell, the
  // Home's form, a test — gets the same refusal, and a half-stated pair can never reach the store.
  const issue = pairingIssue((id) => args[pricingField(id).arg] !== undefined);
  if (issue !== undefined) throw new CliError('invalid_invocation', pairingSentence(issue, naming));

  assertNotUserPricedElsewhere(args.model, deps, providerId);
  assertCatalogAnchor(args);

  // Convert + bounds-validate BEFORE the write (a bad `--cached` must not leave a partially-applied row). Every price is optional on
  // a media-only or cached-only invocation, in which case the upsert omits the column and the store preserves it.
  const prices: PlannedPrice[] = [];
  for (const field of PRICING_FIELDS) {
    const usd = args[field.arg];
    if (usd !== undefined)
      prices.push({ id: field.id, microcents: priceToMicrocents(field, usd, naming) });
  }
  const states = (id: PricingFieldId): boolean => prices.some((price) => price.id === id);

  // A media-only invocation on a model NOTHING can price for tokens is refused here, at write time, rather
  // than surprising the user at run time ([ADR-0089](../../../../docs/decisions/0089-media-correctness-four-boundaries.md) §4).
  // The row would carry no usable token price: the columns are `NOT NULL DEFAULT 0`, `token_rates_stated` says
  // the `0` is a default and not an instruction, and the catalog has nothing to inherit — so `buildUserPricing`
  // drops the row and the model stays unpriced, which makes the media rate they just set unreachable. Saying so
  // now is the difference between a clear exit `2` and a strict cap that keeps refusing after they did what it
  // asked. (An existing user row that already STATED its token rates is fine — a media-only re-price preserves
  // them, which is the ordinary remedy path.)
  if (!states('input') && catalogPricing(args.model) === undefined) {
    const existingStated = deps.catalog
      .listAll()
      .some((row) => row.modelId === args.model && row.source === 'user' && row.tokenRatesStated);
    if (!existingStated) {
      throw new CliError(
        'invalid_invocation',
        noTokenPriceSentence(stripTerminalControls(args.model), naming),
      );
    }
  }

  const columns: { -readonly [K in PriceColumn]?: number } = {};
  for (const price of prices) columns[pricingField(price.id).column] = price.microcents;
  return {
    kind: 'set',
    model: args.model,
    provider: args.provider,
    providerId,
    prices,
    // A pricing-ONLY upsert: omit display name + limits (and every media/capability column the invocation did not state) so the store
    // PRESERVES whatever an existing row carries — including a soft-deactivated live row the active-only reader cannot see, so a
    // re-price never zeroes a discovered name/context. A brand-new user-priced model defaults display → the id and limits → the `0`
    // "unknown" sentinel (in the store), so no read is needed here. A column the invocation omitted is preserved (see the pairing
    // rule for the token pair; the cached rate and every media rate are each independently optional).
    upsert: {
      providerId,
      modelId: args.model,
      source: 'user',
      // The store derives `tokenRatesStated` from the presence of both token rates (ADR-0089 §4), so the rule lives in one place
      // rather than depending on every caller remembering it — this command was not the only writer.
      ...columns,
      // The cached rate AND the fact that it was stated ride together, or neither does. Writing the number without the flag
      // would leave a reader deriving a value the user had explicitly typed. `--cached 0` is a REAL instruction (a self-hosted
      // endpoint whose cache genuinely costs nothing), and the money column cannot tell it apart from "never mentioned" — both
      // are `0` — so the FACT of the statement rides in its own flag (migration 0011).
      ...(states('cached') ? { cachedInputStated: true } : {}),
    },
    shipped: catalogPricing(args.model),
  };
}

/**
 * Cross-provider ambiguity guard (ADR-0065 §2): the cost overlay keys by MODEL ID (the runtime references a model by id alone, no
 * provider), so the SAME id user-priced under two providers can't be distinguished — the cap would then apply an arbitrary one.
 * Reject fail-loud rather than silently overwrite; nothing is written.
 */
function assertNotUserPricedElsewhere(
  model: string,
  deps: PreparePricingDeps,
  providerId: string,
): void {
  const dup = deps.catalog
    .listAll()
    .find((m) => m.source === 'user' && m.modelId === model && m.providerId !== providerId);
  if (dup === undefined) return;
  const otherProvider =
    deps.providers.list().find((p) => p.id === dup.providerId)?.name ?? 'another provider';
  throw new CliError(
    'invalid_invocation',
    `'${model}' is already user-priced under '${otherProvider}'. The cost cap keys by model id, so a second provider's price can't be distinguished — remove that price (re-price under '${otherProvider}') or use a distinct model id.`,
  );
}

/**
 * Provider-vs-CATALOG guard (ADR-0071 §1). The catalog anchors a model id to ONE provider, and both the merge and the cost overlay
 * drop a row that contradicts it — so writing one would store a price that silently never applies, which is the worst of both
 * worlds: the user believes they set it, and nothing reads it.
 */
function assertCatalogAnchor(args: SetPricingArgs): void {
  const anchored = catalogModel(args.model)?.provider;
  if (anchored !== undefined && anchored !== args.provider) {
    throw new CliError(
      'invalid_invocation',
      `'${args.model}' is ${anchored}'s model, not ${args.provider}'s — the catalog anchors a model id to one provider, and a price under the wrong one would never be applied. Re-run with \`--provider ${anchored}\`. Nothing written.`,
    );
  }
}

// ── commit: the one write ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The single write of the command, and exactly what the plan describes: a SET upserts the plan's row; a CLEAR retires the operator's
 * row. It decides nothing new: every refusal is the prepare's, except that the one rule another process can break between the prepare
 * and the commit is checked AGAIN here. A card stays open for as long as a person reads it, and a `models pricing` run from a shell in
 * that time can price the same model under another provider; the overlay keys by model id, so writing the plan then would leave two
 * prices for one id and the cap would apply an arbitrary one. The re-check and the write are one unit (`deps.atomically`), so nothing
 * can slip in between them; a refusal is the shell's own typed refusal and writes nothing.
 */
export function commitPricing(plan: PricingPlan, deps: CommitPricingDeps): PricingOutcome {
  const unit = deps.atomically ?? (<T>(work: () => T): T => work());
  return unit((): PricingOutcome => {
    if (plan.kind === 'clear') {
      return { kind: 'clear', cleared: deps.catalog.clearUserPricing(plan.model, plan.providerId) };
    }
    assertNotUserPricedElsewhere(plan.model, deps, plan.providerId);
    deps.catalog.upsert(plan.upsert);
    return { kind: 'set' };
  });
}

// ── what the commands say ──────────────────────────────────────────────────────────────────────────────────────────────────

function statedPrice(plan: SetPricingPlan, id: PricingFieldId): PlannedPrice | undefined {
  return plan.prices.find((price) => price.id === id);
}

/**
 * The `--json` record for a completed write — the stored micro-cents, echoed back. The omission rules (a field the invocation did not
 * write is ABSENT, not `0`) are a contract worth reading on its own.
 */
function pricingJsonRecord(plan: SetPricingPlan): Record<string, unknown> {
  const record: Record<string, unknown> = {
    model: plan.model,
    provider: plan.provider,
    source: 'user',
  };
  // Absent on a media-only invocation, which is exactly what a machine consumer needs to know: the token columns were PRESERVED, not
  // written. Emitting a `0` there would report a price nobody set. The same for the cached rate: the store PRESERVES the existing
  // one rather than writing a `0`, so a field the invocation did not state would report a value the database does not hold. The
  // media rates this invocation wrote are in the canonical stored unit, so a script automating the strict-cap remedy can confirm
  // the write it just made.
  for (const price of plan.prices) record[pricingField(price.id).column] = price.microcents;
  // The catalog price this override REPLACES (ADR-0071 §5). A machine consumer must be able to see the divergence for the same reason
  // a human must: the flip removed the guard that made mispricing a shipped model impossible. Three states, and each says something
  // different — `null` when the catalog does not price the model at all (the case the user tier was invented for), the shipped
  // numbers when it does, and ABSENT when this invocation wrote no token or cache price, because a media-only re-price replaces
  // nothing and claiming otherwise is the opposite of the transparency this is for.
  if (statedPrice(plan, 'input') !== undefined || statedPrice(plan, 'cached') !== undefined) {
    const shipped = plan.shipped;
    record['overriddenCatalogPrice'] =
      shipped === undefined
        ? null
        : {
            inputCostPerMtokMicrocents: shipped.inputPerMtokMicrocents,
            outputCostPerMtokMicrocents: shipped.outputPerMtokMicrocents,
            cachedInputCostPerMtokMicrocents: shipped.cachedInputPerMtokMicrocents,
          };
  }
  return record;
}

/**
 * The prices a SET states, as one list, joined ONCE. Every part is independently optional now that a media-only (and cache-only)
 * invocation is legal, so no part may carry its own separator and none may assume another precedes it. Media parts are echoed in the
 * canonical BILLED unit, not USD/Mtok (ADR-0044 §3) — a user reading back "image $0.04/Mtok" would have every reason to think they had
 * priced it wrong. Each amount is the STORED integer, printed exactly: the sentence says the price the database holds, never the digits
 * that were typed.
 */
export function pricingPriceNote(plan: SetPricingPlan): string {
  return plan.prices
    .map(
      (price) =>
        `${price.id} $${usdTextOfMicrocents(price.microcents)}${pricingField(price.id).suffix}`,
    )
    .join(', ');
}

/**
 * The sentence that says a SET was recorded. The shell prints it with the divergence note after it; the Home shows it alone, with
 * `surface: 'tui'` so that it names no shell command. The
 * model id is user-typed (or discovered), so any terminal-control byte is stripped before the echo — parity with `renderModelList`.
 * The provider is a validated (kebab) ProviderId, and the prices are numbers — both already safe.
 */
export function pricingSetSentence(
  plan: SetPricingPlan,
  surface: 'shell' | 'tui' = 'shell',
  /** What the sentence calls the provider: the id in the shell, the Home's display name (`OpenAI`) in the card. */
  providerName: string = plan.provider,
): string {
  // The Home's card names no shell command (ADR-0146 §6, MVP-11 OD-20): the refresh it means is the one of its own `/models` picker.
  const refresh = surface === 'tui' ? 'a model refresh' : '`relavium models refresh`';
  return `Set user pricing for ${stripTerminalControls(plan.model)} (${providerName}): ${pricingPriceNote(plan)}. It applies to your next run/chat and survives ${refresh}.`;
}

/**
 * THE DIVERGENCE IS LOUD (ADR-0071 §5) — and it is the condition on which the "a user can never misprice a shipped model" guard was
 * removed. The user outranks the catalog now; they get what they asked for. What they do NOT get is to do it in silence, so when their
 * number disagrees with the one we shipped, we say both. Only when TOKEN rates were actually stated: a media-only invocation overrides
 * no catalog token price, so printing "yours wins" over numbers the user never touched would be false — and alarming, since the whole
 * point of allowing a media-only set is that it does NOT disturb the catalog's token pricing.
 */
export function catalogDivergence(plan: SetPricingPlan): { readonly shipped: string } | undefined {
  const shipped = plan.shipped;
  if (shipped === undefined || statedPrice(plan, 'input') === undefined) return undefined;
  return { shipped: catalogTokenRates(shipped) };
}

/** `input $5/Mtok, output $30/Mtok`: what the catalog charges. */
export function catalogTokenRates(shipped: ModelPricing): string {
  return `input $${usdTextOfMicrocents(shipped.inputPerMtokMicrocents)}/Mtok, output $${usdTextOfMicrocents(shipped.outputPerMtokMicrocents)}/Mtok`;
}

/** The sentence for a CLEAR, as a flat if/else so no nested ternary decides the message. */
export function clearedPricingSentence(
  plan: ClearPricingPlan,
  cleared: boolean,
  /** What the sentence calls the provider: the id in the shell, the Home's display name in the card. */
  providerName: string = plan.provider,
): string {
  const safeModel = stripTerminalControls(plan.model);
  if (!cleared) {
    return `${safeModel} (${providerName}) has no user price to clear — nothing changed.`;
  }
  const shipped = plan.shipped;
  if (shipped === undefined) {
    return `Cleared the user price for ${safeModel} (${providerName}). The catalog does not price this model, so its cost cap will not apply until you price it again.`;
  }
  return `Cleared the user price for ${safeModel} (${providerName}). It falls back to the catalog: ${catalogTokenRates(shipped)}.`;
}

/**
 * The shell's own output for a commit: `--json` records, or the human lines. This is the half of the command that only the shell does;
 * the Home shows the same sentences ({@link pricingSetSentence}, {@link clearedPricingSentence}) in its own notice.
 */
export function writePricingResult(
  plan: PricingPlan,
  outcome: PricingOutcome,
  deps: Pick<ModelsPricingCommandDeps, 'io' | 'global'>,
): ExitCode {
  if (plan.kind === 'clear') {
    const cleared = outcome.kind === 'clear' && outcome.cleared;
    if (deps.global.json) {
      // `source` is the EFFECTIVE price source after the clear, decided by the catalog exactly as the human sentence decides its
      // words — 'catalog' iff the catalog actually prices the model, else null (unpriced, the cost cap will not apply). `cleared ?
      // 'catalog'` was wrong: a cleared model the catalog does NOT price reported 'catalog' while the human line said the opposite.
      const source = plan.shipped !== undefined ? 'catalog' : null;
      writeRecordLines(deps.io, [{ model: plan.model, provider: plan.provider, cleared, source }]);
      return EXIT_CODES.success;
    }
    deps.io.writeOut(`${clearedPricingSentence(plan, cleared)}\n`);
    return EXIT_CODES.success;
  }
  if (deps.global.json) {
    // Key-free record; prices echoed back as the stored integer micro-cents (the canonical unit).
    writeRecordLines(deps.io, [pricingJsonRecord(plan)]);
    return EXIT_CODES.success;
  }
  const divergence = catalogDivergence(plan);
  deps.io.writeOut(
    `${pricingSetSentence(plan)}${
      divergence === undefined
        ? ''
        : `\n  Overrides the catalog price for this model: ${divergence.shipped}. Yours wins. Run \`relavium models pricing ${shellArg(stripTerminalControls(plan.model))} --clear\` to go back to the catalog's.`
    }\n`,
  );
  return EXIT_CODES.success;
}

/** `relavium models pricing`: prepare, commit, print. The Home's form runs the same two steps with a card between them. */
export function modelsPricingCommand(
  args: ModelsPricingCommandArgs,
  deps: ModelsPricingCommandDeps,
): ExitCode {
  const plan = preparePricing(args, deps);
  const outcome = commitPricing(plan, deps);
  return writePricingResult(plan, outcome, deps);
}
