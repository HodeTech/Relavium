import type { ModelCatalogStore, ProviderStore } from '@relavium/db';
import { KNOWN_MODEL_IDS } from '@relavium/llm';

import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { writeRecordLines } from '../render/records.js';

/**
 * The `relavium models pricing <model>` capture command (workstream **2.5.G S10**,
 * [ADR-0065](../../../../docs/decisions/0065-provider-economics-and-user-pricing.md) §1/§2) — hand-enter the
 * per-Mtok text-token price of a model the static registry does NOT know (a custom-endpoint model, or a new
 * provider model not yet in `MODEL_PRICING`), so the cost cap (`max_cost_microcents`) can enforce it. The price is
 * stored as a `source='user'` `model_catalog` row (integer micro-cents, never float); a live `models refresh` NEVER
 * clobbers it (ADR-0065 §1). It closes the ADR-0064 §6 gap where an unknown model's cost governance degraded to
 * `allow` because no price existed.
 *
 * Framework-free (no `commander`): parsed args + injected stores in, output via {@link CliIo}; a fault throws a
 * typed {@link CliError} (exit 2). The command is PURE of secrets — it writes only a model id + provider + prices,
 * never a key. It writes nothing on any validation failure (the reject precedes the upsert).
 *
 * Precedence guard: a **canonical** model id (one already in `MODEL_PRICING`) is REJECTED — the static registry
 * always wins for a known id in both the merge and the cost path (ADR-0065 §2), so a user override would be
 * silently ignored; failing loud is honest. Provider guard: the `<slug>` must be a REGISTERED provider (the catalog
 * row's FK targets `llm_providers`), else the user is told to add it first.
 */

export interface ModelsPricingCommandArgs {
  /** The model id to price — a NON-canonical id (a custom / not-yet-registered model). */
  readonly model: string;
  /** The provider slug that serves the model (e.g. `openai`) — must already be registered. */
  readonly provider: string;
  /** Input (prompt) price, USD per million tokens. */
  readonly inputUsdPerMtok: number;
  /** Output (completion) price, USD per million tokens. */
  readonly outputUsdPerMtok: number;
  /** Cache-read price, USD per million tokens; omitted ⇒ `0` (no cache discount). */
  readonly cachedInputUsdPerMtok?: number;
}

export interface ModelsPricingCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /** The catalog store — `upsert` writes the `source='user'` row; `listByProvider` preserves an existing row's
   *  display/limits on a re-price (the store overwrites those required columns). */
  readonly catalog: Pick<ModelCatalogStore, 'upsert' | 'listByProvider'>;
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

export function modelsPricingCommand(
  args: ModelsPricingCommandArgs,
  deps: ModelsPricingCommandDeps,
): ExitCode {
  // Precedence guard (ADR-0065 §2): a canonical id always resolves to `MODEL_PRICING`, so a user override would be
  // a silent no-op. Reject BEFORE any write — nothing is stored on a rejected invocation.
  if ((KNOWN_MODEL_IDS as readonly string[]).includes(args.model)) {
    throw new CliError(
      'invalid_invocation',
      `'${args.model}' already has a built-in price — a user override would never take effect (the static registry always wins). Nothing written.`,
    );
  }
  // Provider guard: the catalog row's FK targets `llm_providers`, so the provider must already be registered.
  const providerRow = deps.providers.list().find((p) => p.name === args.provider);
  if (providerRow === undefined) {
    throw new CliError(
      'invalid_invocation',
      `unknown provider '${args.provider}' — register it first (e.g. \`relavium provider add ${args.provider}\` or \`relavium provider set-key ${args.provider}\`).`,
    );
  }
  // Convert + bounds-validate BEFORE the write (a bad `--cached` must not leave a partially-applied row).
  const inputCostPerMtokMicrocents = usdToMicrocents(args.inputUsdPerMtok, '--input');
  const outputCostPerMtokMicrocents = usdToMicrocents(args.outputUsdPerMtok, '--output');
  const cachedInputCostPerMtokMicrocents =
    args.cachedInputUsdPerMtok === undefined
      ? 0
      : usdToMicrocents(args.cachedInputUsdPerMtok, '--cached');

  // Preserve an existing row's display name + limits on a re-price (the store overwrites those REQUIRED columns;
  // the media/provenance/pricing columns preserve themselves on omit). A fresh price defaults display → the id,
  // limits → `0` (the "unknown" sentinel, which reads back as absent).
  const existing = deps.catalog
    .listByProvider(providerRow.id)
    .find((m) => m.modelId === args.model);

  deps.catalog.upsert({
    providerId: providerRow.id,
    modelId: args.model,
    displayName: existing?.displayName ?? args.model,
    contextWindowTokens: existing?.contextWindowTokens ?? 0,
    maxOutputTokens: existing?.maxOutputTokens ?? 0,
    source: 'user',
    inputCostPerMtokMicrocents,
    outputCostPerMtokMicrocents,
    cachedInputCostPerMtokMicrocents,
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
        cachedInputCostPerMtokMicrocents,
      },
    ]);
    return EXIT_CODES.success;
  }

  const cachedNote =
    args.cachedInputUsdPerMtok === undefined
      ? ''
      : `, cached $${args.cachedInputUsdPerMtok}/Mtok`;
  deps.io.writeOut(
    `Set user pricing for ${args.model} (${args.provider}): input $${args.inputUsdPerMtok}/Mtok, output $${args.outputUsdPerMtok}/Mtok${cachedNote}. It applies to your next run/chat and survives \`models refresh\`.\n`,
  );
  return EXIT_CODES.success;
}
