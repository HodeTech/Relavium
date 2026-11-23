import { CliError, isCliError } from '../process/errors.js';

/**
 * The field table of `relavium models pricing` ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §9, [ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §5, [ADR-0089](../../../../docs/decisions/0089-media-correctness-four-boundaries.md) §4).
 *
 * ONE place says which prices a model can be given, what each is called, in what unit it is stated, how large it may be and which of
 * them are set together. The shell's argv parser (`dispatch.ts`), the shell's command core (`models-pricing.ts`) and the Home's
 * `/pricing` form all read this table, so the form cannot offer less than the shell, a ceiling cannot differ between them, and a new
 * price is one new row. `pricing-fields.test.ts` proves that the command descriptor, the table and the core's arguments name the same
 * fields.
 *
 * It also owns the two rules that are not about one field:
 *
 * - **The pairing rule.** Input and output are set together or not at all, and a price must be given: either the pair, or at least
 *   one of the rest (the cached rate, a media modality). {@link pairingIssue} is the only copy of it. Both the shell's parser (early,
 *   so an invocation fails before anything is read) and the command core's `preparePricing` (so no other caller can skip it) call it.
 * - **The ceilings.** A price above its ceiling is a typo, and one that is stored bills at that typo: {@link priceToMicrocents} is
 *   the only place a ceiling is applied.
 *
 * The sentences are the shell's own and are pinned byte for byte by `models-pricing-characterization.test.ts`. The form asks for the
 * same sentences with the field's LABEL instead of its flag (`naming: 'label'`), because a person at a prompt never typed a flag.
 */

export type PricingFieldId = 'input' | 'output' | 'cached' | 'image' | 'audio' | 'video';

/** What a price is quoted per: a million tokens, or one billed media unit (an image, a second). */
export type PricingUnit = 'mtok' | 'billed-unit';

/** The property of the command core's arguments that carries the field's price (USD, as typed). */
export type PriceArgKey =
  | 'inputUsdPerMtok'
  | 'outputUsdPerMtok'
  | 'cachedInputUsdPerMtok'
  | 'imageUsdPerCount'
  | 'audioUsdPerSecond'
  | 'videoUsdPerSecond';

/** The catalog store's column (and the `--json` record's key) that holds the field's price, in integer micro-cents. */
export type PriceColumn =
  | 'inputCostPerMtokMicrocents'
  | 'outputCostPerMtokMicrocents'
  | 'cachedInputCostPerMtokMicrocents'
  | 'mediaImageCostMicrocents'
  | 'mediaAudioCostMicrocents'
  | 'mediaVideoCostMicrocents';

/** The price arguments of a SET, as the command core takes them: each is present only when that price was stated. */
export type PriceArgs = { readonly [K in PriceArgKey]?: number };

/** 1 USD/Mtok = 1e8 micro-cents/Mtok (ADR-0065 §2 — the exact inverse of `@relavium/llm`'s in-code `usd()`). */
export const MICROCENTS_PER_USD = 100_000_000;
/**
 * A typo/absurdity ceiling for a token price: no real model is $100,000 / Mtok. It also keeps the micro-cent product
 * ($100k × 1e8 = 1e13) far under `Number.MAX_SAFE_INTEGER` (~9.007e15), so the integer never loses precision on the way to the DB.
 */
export const MAX_USD_PER_MTOK = 100_000;
/**
 * A single media unit's price is orders of magnitude larger than a token's, so it gets its own ceiling: an image or a second of video
 * at $1000 is already absurd, while $1000/Mtok is merely expensive.
 */
export const MAX_USD_PER_MEDIA_UNIT = 1_000;

export interface PricingField {
  /** The field's id; also the key `input.options` carries for its flag (the descriptor's `binding`). */
  readonly id: PricingFieldId;
  /** The flag as the shell's sentences name it. The descriptor lists it as a spelling (primary or deprecated). */
  readonly flag: string;
  /** What the form's prompt and card call it. */
  readonly label: string;
  /** What the shell's sentences call the missing flag's value (`--input USD_PER_MTOK`). */
  readonly placeholder: string;
  readonly unit: PricingUnit;
  /** The unit as a person reads it, in the form's prompt (`USD per million tokens`). */
  readonly unitWords: string;
  /** The unit as the shell echoes a price and the card shows it: `$3/Mtok`, `$0.04/image`, `$0.001/s`. */
  readonly suffix: string;
  /** The largest price accepted, in USD per its unit; a larger one is refused as a typo. */
  readonly ceiling: number;
  readonly arg: PriceArgKey;
  readonly column: PriceColumn;
  /** A media modality: priced per billed unit, and never the cause of a token price being derived or replaced. */
  readonly media: boolean;
  /** The field this one is set together with (input and output), or none. */
  readonly pairedWith: PricingFieldId | undefined;
}

/** The fields, in the order the shell parses them, echoes them, writes them and the form asks for them. */
export const PRICING_FIELDS: readonly PricingField[] = Object.freeze([
  {
    id: 'input',
    flag: '--input',
    label: 'Input price',
    placeholder: 'USD_PER_MTOK',
    unit: 'mtok',
    unitWords: 'USD per million tokens',
    suffix: '/Mtok',
    ceiling: MAX_USD_PER_MTOK,
    arg: 'inputUsdPerMtok',
    column: 'inputCostPerMtokMicrocents',
    media: false,
    pairedWith: 'output',
  },
  {
    id: 'output',
    flag: '--output',
    label: 'Output price',
    placeholder: 'USD_PER_MTOK',
    unit: 'mtok',
    unitWords: 'USD per million tokens',
    suffix: '/Mtok',
    ceiling: MAX_USD_PER_MTOK,
    arg: 'outputUsdPerMtok',
    column: 'outputCostPerMtokMicrocents',
    media: false,
    pairedWith: 'input',
  },
  {
    id: 'cached',
    flag: '--cached',
    label: 'Cached input price',
    placeholder: 'USD_PER_MTOK',
    unit: 'mtok',
    unitWords: 'USD per million tokens',
    suffix: '/Mtok',
    ceiling: MAX_USD_PER_MTOK,
    arg: 'cachedInputUsdPerMtok',
    column: 'cachedInputCostPerMtokMicrocents',
    media: false,
    pairedWith: undefined,
  },
  {
    id: 'image',
    flag: '--image',
    label: 'Image price',
    placeholder: 'USD_PER_IMAGE',
    unit: 'billed-unit',
    unitWords: 'USD per image',
    suffix: '/image',
    ceiling: MAX_USD_PER_MEDIA_UNIT,
    arg: 'imageUsdPerCount',
    column: 'mediaImageCostMicrocents',
    media: true,
    pairedWith: undefined,
  },
  {
    id: 'audio',
    flag: '--audio',
    label: 'Audio price',
    placeholder: 'USD_PER_SECOND',
    unit: 'billed-unit',
    unitWords: 'USD per second',
    suffix: '/s',
    ceiling: MAX_USD_PER_MEDIA_UNIT,
    arg: 'audioUsdPerSecond',
    column: 'mediaAudioCostMicrocents',
    media: true,
    pairedWith: undefined,
  },
  {
    id: 'video',
    flag: '--video',
    label: 'Video price',
    placeholder: 'USD_PER_SECOND',
    unit: 'billed-unit',
    unitWords: 'USD per second',
    suffix: '/s',
    ceiling: MAX_USD_PER_MEDIA_UNIT,
    arg: 'videoUsdPerSecond',
    column: 'mediaVideoCostMicrocents',
    media: true,
    pairedWith: undefined,
  },
] satisfies readonly PricingField[]);

export function pricingField(id: PricingFieldId): PricingField {
  const field = PRICING_FIELDS.find((candidate) => candidate.id === id);
  if (field === undefined) throw new CliError('cli_internal', `unknown pricing field ${id}`);
  return field;
}

/** How a sentence names a field: by the shell's flag, or by the form's label. */
export type PricingNaming = 'flag' | 'label';

const nameOf = (field: PricingField, naming: PricingNaming): string =>
  naming === 'flag' ? field.flag : field.label;

// ── one price: its text, its meaning, its bounds ────────────────────────────────────────────────────────────────────────────

/**
 * One price's text → a finite number (SHAPE only: the range and the ceiling are {@link priceToMicrocents}'s). The raw text is never
 * echoed (a defensive no-terminal-injection habit). A separate sentence per unit, so a person pricing one image is never told "per
 * million tokens" and enters a millionth of the number they meant.
 */
export function parsePriceText(
  field: PricingField,
  raw: string,
  naming: PricingNaming = 'flag',
): number {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(value)) {
    const unit =
      field.unit === 'mtok'
        ? 'USD per million tokens.'
        : 'USD per billed unit (per image, or per second).';
    throw new CliError(
      'invalid_invocation',
      `${nameOf(field, naming)} must be a finite number of ${unit}`,
    );
  }
  return value;
}

/**
 * One price in USD → integer micro-cents, refusing a non-finite, negative or absurd value (exit 2). `0` is accepted and meaningful: it
 * records "this is free, and I am telling you so", which the stored column can hold distinctly from "nobody has said". Both units
 * multiply by the same constant; what differs is the ceiling and the sentence, which names the right denominator.
 */
export function priceToMicrocents(
  field: PricingField,
  usd: number,
  naming: PricingNaming = 'flag',
): number {
  const name = nameOf(field, naming);
  const perMtok = field.unit === 'mtok';
  if (!Number.isFinite(usd) || usd < 0) {
    throw new CliError(
      'invalid_invocation',
      `${name} must be a finite, non-negative number of USD per ${perMtok ? 'million tokens' : 'billed unit'}`,
    );
  }
  if (usd > field.ceiling) {
    throw new CliError(
      'invalid_invocation',
      perMtok
        ? `${name} ($${usd}/Mtok) is implausibly large — the maximum is $${field.ceiling}/Mtok`
        : `${name} ($${usd}) is implausibly large — the maximum is $${field.ceiling} per unit`,
    );
  }
  return Math.round(usd * MICROCENTS_PER_USD);
}

/**
 * What the form's prompt says about the text typed for `field`, in the form's words: `undefined` when it is acceptable (an empty text
 * is acceptable: it means "not set"). It is {@link parsePriceText} then {@link priceToMicrocents}, so the prompt refuses exactly what
 * the shell refuses, with the same sentence under the field's label.
 */
export function priceTextIssue(field: PricingField, raw: string): string | undefined {
  if (raw.trim() === '') return undefined;
  try {
    priceToMicrocents(field, parsePriceText(field, raw, 'label'), 'label');
    return undefined;
  } catch (cause) {
    if (isCliError(cause)) return cause.message;
    throw cause;
  }
}

/** Every price the text states, as the command core's arguments, parsed in table order. Throws the shape sentence of the first bad one. */
export function priceArgsFromText(
  raw: Readonly<Partial<Record<PricingFieldId, string>>>,
  naming: PricingNaming = 'flag',
): PriceArgs {
  const out: { -readonly [K in PriceArgKey]?: number } = {};
  for (const field of PRICING_FIELDS) {
    const text = raw[field.id];
    if (text !== undefined) out[field.arg] = parsePriceText(field, text, naming);
  }
  return out;
}

/** An integer of micro-cents as an exact decimal USD amount (`300000000` → `3`, `3000000` → `0.03`), never in exponent form. */
export function usdTextOfMicrocents(microcents: number): string {
  const whole = Math.trunc(microcents / MICROCENTS_PER_USD);
  const fraction = microcents - whole * MICROCENTS_PER_USD;
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(8, '0').replace(/0+$/, '')}`;
}

// ── the pairing rule ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What is wrong with the set of prices given: none at all (`none`), one half of the pair missing while nothing else is priced
 * (`missing`, naming the half), or one half of the pair beside another price (`incomplete`). `field` is the flag the shell's sentence
 * names as missing.
 */
export type PairingIssue =
  | { readonly kind: 'none'; readonly field: PricingFieldId }
  | { readonly kind: 'missing'; readonly field: PricingFieldId }
  | { readonly kind: 'incomplete' };

/**
 * THE pairing rule: a SET states at least one price, input and output come together or not at all, and a price other than the pair
 * (the cached rate, a media modality) is a legitimate invocation on its own.
 *
 * The pair is not decoration. Both token columns are `NOT NULL DEFAULT 0`: a half-stated pair would write a `0` that a reader cannot
 * tell from an instruction, and an `--input 0 --output 0` typed to "satisfy" a media refusal would bill every token at nothing. A
 * media-only (or cached-only) invocation is how a person satisfies a `strict_cost_cap` refusal on a model the catalog already prices
 * for tokens WITHOUT writing a row that outranks the catalog for tokens (ADR-0089 §4(c)).
 *
 * `present` says whether a field was stated. The result names the first problem, in the order the shell has always reported them.
 */
export function pairingIssue(present: (id: PricingFieldId) => boolean): PairingIssue | undefined {
  const paired = PRICING_FIELDS.filter((field) => field.pairedWith !== undefined);
  const hasOther = PRICING_FIELDS.some(
    (field) => field.pairedWith === undefined && present(field.id),
  );
  const missing = paired.find((field) => !present(field.id));
  if (missing !== undefined && !hasOther)
    return {
      kind: paired.some((field) => present(field.id)) ? 'missing' : 'none',
      field: missing.id,
    };
  for (const field of paired) {
    if (field.pairedWith !== undefined && present(field.id) !== present(field.pairedWith))
      return { kind: 'incomplete' };
  }
  return undefined;
}

/** The sentence for a {@link PairingIssue}: the shell's under `flag`, the form's under `label`. */
export function pairingSentence(issue: PairingIssue, naming: PricingNaming = 'flag'): string {
  const others = PRICING_FIELDS.filter((field) => field.pairedWith === undefined);
  const pair = PRICING_FIELDS.filter((field) => field.pairedWith !== undefined);
  if (issue.kind === 'incomplete') {
    if (naming === 'flag')
      return `${pair.map((p) => p.flag).join(' and ')} must be given together (or omit both and price only media rates).`;
    return `${pair.map((p) => p.label).join(' and ')} are set together: give both, or leave both empty and price only the cached or a media rate.`;
  }
  const field = pricingField(issue.field);
  if (naming === 'flag')
    return `missing required option ${field.flag} ${field.placeholder} (or price only ${others.map((other) => other.flag).join(' / ')}).`;
  if (issue.kind === 'none')
    return `Set at least one price: ${pair.map((p) => p.label).join(' and ')} together, or only ${others.map((other) => other.label).join(', ')}.`;
  const mate = field.pairedWith === undefined ? undefined : pricingField(field.pairedWith);
  return `${field.label} is missing: it is set together with the ${mate?.label.toLowerCase() ?? 'other price'}. Give both, or leave both empty and price only the cached or a media rate.`;
}

/** The sentence for a model nothing prices for tokens that was given only a cached or media rate. */
export function noTokenPriceSentence(model: string, naming: PricingNaming = 'flag'): string {
  const pair = PRICING_FIELDS.filter((field) => field.pairedWith !== undefined);
  const head = `'${model}' has no token price — the catalog does not price it and you have not either, so a media rate alone would never be applied.`;
  if (naming === 'flag')
    return `${head} Re-run with ${pair.map((p) => `${p.flag} ${p.placeholder}`).join(' ')} as well. Nothing written.`;
  return `${head} Set ${pair.map((p) => p.label).join(' and ')} as well. Nothing written.`;
}
