import type { ModelCatalogStore, ProviderStore } from '@relavium/db';
import { catalogModel, catalogPricing } from '@relavium/llm';

import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { writeRecordLines } from '../render/records.js';
import { stripTerminalControls } from '../render/tui/chat-projection.js';

/** Integer micro-cents/MTok → a USD string, for echoing the catalog price an override replaces (ADR-0071 §5). */
function microcentsToUsd(microcents: number): string {
  return (microcents / 100_000_000).toString();
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
}

/** 1 USD/Mtok = 1e8 micro-cents/Mtok (ADR-0065 §2 — the exact inverse of `@relavium/llm`'s in-code `usd()`). */
const USD_PER_MTOK_TO_MICROCENTS = 100_000_000;
/**
 * A typo/absurdity ceiling: no real model is $100,000 / Mtok. It also keeps the micro-cent product ($100k × 1e8 =
 * 1e13) far under `Number.MAX_SAFE_INTEGER` (~9.007e15), so the integer never loses precision on the way to the DB.
 */
const MAX_USD_PER_MTOK = 100_000;

/** Convert one USD/Mtok flag to integer micro-cents, rejecting a non-finite / negative / absurd value (exit 2). */
function usdToMicrocents(usdPerMtok: number, flag: string): number {
  if (!Number.isFinite(usdPerMtok) || usdPerMtok < 0) {
    throw new CliError(
      'invalid_invocation',
      `${flag} must be a finite, non-negative number of USD per million tokens`,
    );
  }
  if (usdPerMtok > MAX_USD_PER_MTOK) {
    throw new CliError(
      'invalid_invocation',
      `${flag} ($${usdPerMtok}/Mtok) is implausibly large — the maximum is $${MAX_USD_PER_MTOK}/Mtok`,
    );
  }
  return Math.round(usdPerMtok * USD_PER_MTOK_TO_MICROCENTS);
}

/**
 * SET a price, or CLEAR one — a discriminated union, so a `--clear` invocation cannot carry a price and a set
 * invocation cannot forget one. The two are different acts, and typing them as one optional-riddled shape is how a
 * half-applied invocation gets written.
 */
export type ModelsPricingCommandArgs = SetPricingArgs | ClearPricingArgs;

export interface SetPricingArgs {
  readonly clear?: undefined;
  /** The model id to price. Since ADR-0071 §1 this MAY be one the catalog already knows — the user outranks it. */
  readonly model: string;
  /** The provider slug that serves the model — must be registered, AND must be the one the catalog anchors the model
   *  to (a contradicting price would never be applied anywhere, so it is refused rather than stored). */
  readonly provider: string;
  /** Input (prompt) price, USD per million tokens. */
  readonly inputUsdPerMtok: number;
  /** Output (completion) price, USD per million tokens. */
  readonly outputUsdPerMtok: number;
  /**
   * Cache-read price, USD per million tokens.
   *
   * Omitted ⇒ the row records that it was NOT stated (migration 0011), and a reader derives it: the catalog's cache
   * DISCOUNT applied to the input rate the user gave. `--cached 0` is a real instruction and is believed — the flag
   * is what lets a stored `0` mean "free" rather than "nobody said".
   */
  readonly cachedInputUsdPerMtok?: number;
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
  readonly catalog: Pick<ModelCatalogStore, 'upsert' | 'listAll' | 'clearUserPricing'>;
  readonly providers: Pick<ProviderStore, 'list'>;
}

export function modelsPricingCommand(
  args: ModelsPricingCommandArgs,
  deps: ModelsPricingCommandDeps,
): ExitCode {
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
    return runClearPricing(args, deps, providerRow.id);
  }

  // Cross-provider ambiguity guard (ADR-0065 §2): the cost overlay keys by MODEL ID (the runtime references a model
  // by id alone, no provider), so the SAME id user-priced under two providers can't be distinguished — the cap
  // would then apply an arbitrary one. Reject fail-loud rather than silently overwrite; nothing is written.
  const dup = deps.catalog
    .listAll()
    .find(
      (m) => m.source === 'user' && m.modelId === args.model && m.providerId !== providerRow.id,
    );
  if (dup !== undefined) {
    const otherProvider =
      deps.providers.list().find((p) => p.id === dup.providerId)?.name ?? 'another provider';
    throw new CliError(
      'invalid_invocation',
      `'${args.model}' is already user-priced under '${otherProvider}'. The cost cap keys by model id, so a second provider's price can't be distinguished — remove that price (re-price under '${otherProvider}') or use a distinct model id.`,
    );
  }
  // Provider-vs-CATALOG guard (ADR-0071 §1). The catalog anchors a model id to ONE provider, and both the merge
  // and the cost overlay drop a row that contradicts it — so writing one would store a price that silently never
  // applies, which is the worst of both worlds: the user believes they set it, and nothing reads it.
  const anchored = catalogModel(args.model)?.provider;
  if (anchored !== undefined && anchored !== args.provider) {
    throw new CliError(
      'invalid_invocation',
      `'${args.model}' is ${anchored}'s model, not ${args.provider}'s — the catalog anchors a model id to one provider, and a price under the wrong one would never be applied. Re-run with \`--provider ${anchored}\`. Nothing written.`,
    );
  }
  // Convert + bounds-validate BEFORE the write (a bad `--cached` must not leave a partially-applied row).
  const inputCostPerMtokMicrocents = usdToMicrocents(args.inputUsdPerMtok, '--input');
  const outputCostPerMtokMicrocents = usdToMicrocents(args.outputUsdPerMtok, '--output');
  // OMITTED `--cached` ⇒ `undefined`, so the upsert OMITS the column and the store PRESERVES an existing rate: a
  // re-price must never zero — or overwrite — a cache rate the user hand-entered earlier.
  //
  // `--cached 0` is a REAL instruction (a self-hosted endpoint whose cache genuinely costs nothing), and the money
  // column cannot tell it apart from "never mentioned" — both are `0`. So the FACT of the statement rides in its own
  // flag (migration 0011): stated ⇒ the number is theirs, zero included; not stated ⇒ a reader DERIVES it from the
  // catalog's cache discount applied to their own input rate (see `rowToUserPricing`). Reading a stored `0` as
  // "free" would bill a whole class of tokens at nothing; reading it as "unset" would discard what the user typed.
  const cachedInputCostPerMtokMicrocents =
    args.cachedInputUsdPerMtok === undefined
      ? undefined
      : usdToMicrocents(args.cachedInputUsdPerMtok, '--cached');

  // A pricing-ONLY upsert: omit display name + limits (and every media/capability column) so the store PRESERVES
  // whatever an existing row carries — including a soft-deactivated live row the active-only reader cannot see, so
  // a re-price never zeroes a discovered name/context. A brand-new user-priced model defaults display → the id and
  // limits → the `0` "unknown" sentinel (in the store), so no read is needed here. `cachedInput…` is omitted when
  // `--cached` was not passed (so the store preserves the existing cached rate — see the local above).
  deps.catalog.upsert({
    providerId: providerRow.id,
    modelId: args.model,
    source: 'user',
    inputCostPerMtokMicrocents,
    outputCostPerMtokMicrocents,
    // The rate AND the fact that it was stated ride together, or neither does. Writing the number without the flag
    // would leave a reader deriving a value the user had explicitly typed.
    ...(cachedInputCostPerMtokMicrocents === undefined
      ? {}
      : { cachedInputCostPerMtokMicrocents, cachedInputStated: true }),
  });

  if (deps.global.json) {
    // Key-free record; prices echoed back as the stored integer micro-cents (the canonical unit).
    writeRecordLines(deps.io, [
      {
        model: args.model,
        provider: args.provider,
        source: 'user',
        inputCostPerMtokMicrocents,
        outputCostPerMtokMicrocents,
        // The `--json` field stays present as `0` when `--cached` was omitted (unchanged contract) even though the
        // store now PRESERVES the existing cached rate rather than writing this `0` (see the upsert above).
        cachedInputCostPerMtokMicrocents: cachedInputCostPerMtokMicrocents ?? 0,
        // The catalog price this override REPLACES (ADR-0071 §5) — `null` when the catalog does not price the model
        // at all, which is the case the user tier was originally invented for. A machine consumer must be able to
        // see the divergence for the same reason a human must: the flip removed the guard that made it impossible.
        overriddenCatalogPrice: (() => {
          const shipped = catalogPricing(args.model);
          return shipped === undefined
            ? null
            : {
                inputCostPerMtokMicrocents: shipped.inputPerMtokMicrocents,
                outputCostPerMtokMicrocents: shipped.outputPerMtokMicrocents,
                cachedInputCostPerMtokMicrocents: shipped.cachedInputPerMtokMicrocents,
              };
        })(),
      },
    ]);
    return EXIT_CODES.success;
  }

  const cachedNote =
    args.cachedInputUsdPerMtok === undefined ? '' : `, cached $${args.cachedInputUsdPerMtok}/Mtok`;
  // THE DIVERGENCE IS LOUD (ADR-0071 §5) — and it is the condition on which the "a user can never misprice a
  // shipped model" guard was removed. The user outranks the catalog now; they get what they asked for. What they do
  // NOT get is to do it in silence, so when their number disagrees with the one we shipped, we say both.
  const shipped = catalogPricing(args.model);
  const divergence =
    shipped === undefined
      ? ''
      : `\n  Overrides the catalog price for this model: input $${microcentsToUsd(shipped.inputPerMtokMicrocents)}/Mtok, output $${microcentsToUsd(shipped.outputPerMtokMicrocents)}/Mtok. Yours wins. Run \`relavium models pricing ${stripTerminalControls(args.model)} --clear\` to go back to the catalog's.`;
  // Strip any terminal-control byte from the (user-typed) model id before echo — parity with `renderModelList`'s
  // FIX 2. `ModelListingSchema` only requires min(1), so an id can carry a control byte; the JSON path is safe on
  // its own (JSON.stringify escapes them). The provider is a validated (kebab) ProviderId, and the prices are
  // numbers — both already safe.
  deps.io.writeOut(
    `Set user pricing for ${stripTerminalControls(args.model)} (${args.provider}): input $${args.inputUsdPerMtok}/Mtok, output $${args.outputUsdPerMtok}/Mtok${cachedNote}. It applies to your next run/chat and survives \`models refresh\`.${divergence}\n`,
  );
  return EXIT_CODES.success;
}

/** `--clear` (ADR-0071 §5): retire the user override for one model+provider and report the fallback. */
function runClearPricing(
  args: ClearPricingArgs,
  deps: ModelsPricingCommandDeps,
  providerId: string,
): ExitCode {
  const cleared = deps.catalog.clearUserPricing(args.model, providerId);
  if (deps.global.json) {
    writeRecordLines(deps.io, [
      { model: args.model, provider: args.provider, cleared, source: cleared ? 'catalog' : null },
    ]);
    return EXIT_CODES.success;
  }
  deps.io.writeOut(clearedPricingMessage(args, cleared));
  return EXIT_CODES.success;
}

/** The human line for a `--clear`, as a flat if/else so no nested ternary decides the message. */
function clearedPricingMessage(args: ClearPricingArgs, cleared: boolean): string {
  const safeModel = stripTerminalControls(args.model);
  if (!cleared) {
    return `${safeModel} (${args.provider}) has no user price to clear — nothing changed.\n`;
  }
  const shipped = catalogPricing(args.model);
  if (shipped === undefined) {
    return `Cleared the user price for ${safeModel} (${args.provider}). The catalog does not price this model, so its cost cap will not apply until you price it again.\n`;
  }
  return `Cleared the user price for ${safeModel} (${args.provider}). It falls back to the catalog: input $${microcentsToUsd(shipped.inputPerMtokMicrocents)}/Mtok, output $${microcentsToUsd(shipped.outputPerMtokMicrocents)}/Mtok.\n`;
}
