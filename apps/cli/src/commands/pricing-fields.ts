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
 * - **The exactness.** A price is read as the decimal that was typed and stored as the integer micro-cents that decimal IS: no
 *   floating-point multiplication, no rounding. A price that does not fit a whole micro-cent is refused, so what is stored is what
 *   was typed, and a positive price can never be stored as the `0` that means "free" ({@link parsePriceText},
 *   {@link priceToMicrocents}).
 * - **The model id.** A model id the terminal cannot show as it is stored is not priced ({@link modelIdFault}): the shell's core and
 *   the form read the one rule.
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
/** The decimal places a price can hold: one micro-cent is `10^-8` USD, so `MICROCENTS_PER_USD` is `10^PRICE_DECIMAL_PLACES`. */
export const PRICE_DECIMAL_PLACES = 8;
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
 * A decimal number read digit by digit, so that no floating-point value ever stands in for it. The value is `0.<digits> × 10^point`
 * with no leading and no trailing zero in `digits` (so `digits === ''` is zero): `0.05` is `5` with point `-1`, `100` is `1` with
 * point `3`, `1e-9` is `1` with point `-8`.
 */
interface Decimal {
  readonly negative: boolean;
  readonly digits: string;
  readonly point: number;
}

/**
 * A plain decimal number: an optional sign, digits with an optional point, an optional exponent. Hex, binary, octal and names are
 * not. Each part is one unambiguous run, so the match is linear in the text (a long text from a pasted value cannot stall it).
 */
const DECIMAL_TEXT = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;

/** The decimal a text states exactly, or `undefined` when the text is not a plain decimal number. */
function readDecimal(text: string): Decimal | undefined {
  const match = DECIMAL_TEXT.exec(text);
  if (match === null) return undefined;
  const [, sign = '', whole = '', fraction = '', bareFraction = '', exponentText = '0'] = match;
  const all = whole + (whole === '' ? bareFraction : fraction);
  // Strip the zeros at both ends with two scans (a regex over a long run of zeros is quadratic).
  let start = 0;
  while (start < all.length && all[start] === '0') start += 1;
  let end = all.length;
  while (end > start && all[end - 1] === '0') end -= 1;
  return {
    negative: sign === '-',
    digits: all.slice(start, end),
    point: whole.length - start + Number(exponentText),
  };
}

/** Why a decimal does not fit the stored unit: smaller than one micro-cent, or needing more decimal places than a micro-cent has. */
type PrecisionRefusal = 'below-smallest' | 'too-precise';

/** Whether a (non-negative) decimal is not a whole number of micro-cents; zero is, and is how a price says "free". */
function precisionRefusal(decimal: Decimal): PrecisionRefusal | undefined {
  if (decimal.digits === '') return undefined;
  if (decimal.point <= -PRICE_DECIMAL_PLACES) return 'below-smallest';
  return decimal.digits.length - decimal.point > PRICE_DECIMAL_PLACES ? 'too-precise' : undefined;
}

/** The whole micro-cents a decimal is. Only for a decimal {@link precisionRefusal} accepted and a ceiling already applied (so the integer is small). */
function microcentsOf(decimal: Decimal): number {
  if (decimal.digits === '') return 0;
  const fractionDigits = decimal.digits.length - decimal.point;
  return Number(decimal.digits + '0'.repeat(PRICE_DECIMAL_PLACES - fractionDigits));
}

/** What a field's price is per, in a sentence: `million tokens` or `billed unit`. */
const perUnit = (field: PricingField): string =>
  field.unit === 'mtok' ? 'million tokens' : 'billed unit';

/** The one sentence for a price that does not fit a whole micro-cent: it names the smallest price that can be stored. */
function precisionSentence(
  field: PricingField,
  refusal: PrecisionRefusal,
  naming: PricingNaming,
): string {
  const name = nameOf(field, naming);
  const step = `$${usdTextOfMicrocents(1)} per ${perUnit(field)}`;
  return refusal === 'below-smallest'
    ? `${name} is below the smallest price that can be stored, ${step}. Enter 0 to record it as free.`
    : `${name} has more than ${String(PRICE_DECIMAL_PLACES)} decimal places, and a price is stored in whole steps of ${step}. Enter it to the nearest step.`;
}

/**
 * One price's text → a finite number (SHAPE and EXACTNESS; the range and the ceiling are {@link priceToMicrocents}'s). The text must be
 * a plain decimal number, and a non-negative one must be a whole number of micro-cents: a text this reads as a number is a text that
 * is stored as exactly what it says. `1e-999` reads as the double `0` and `1.0000000000000001` as `1`; both are refused here instead of
 * becoming another price. The raw text is never echoed (a defensive no-terminal-injection habit). A separate sentence per unit, so a
 * person pricing one image is never told "per million tokens" and enters a millionth of the number they meant.
 */
export function parsePriceText(
  field: PricingField,
  raw: string,
  naming: PricingNaming = 'flag',
): number {
  const trimmed = raw.trim();
  const decimal = readDecimal(trimmed);
  const value = Number(trimmed);
  if (decimal === undefined || !Number.isFinite(value)) {
    const unit =
      field.unit === 'mtok'
        ? 'USD per million tokens.'
        : 'USD per billed unit (per image, or per second).';
    throw new CliError(
      'invalid_invocation',
      `${nameOf(field, naming)} must be a finite number of ${unit}`,
    );
  }
  const refusal = decimal.negative ? undefined : precisionRefusal(decimal);
  if (refusal !== undefined)
    throw new CliError('invalid_invocation', precisionSentence(field, refusal, naming));
  return value;
}

/**
 * One price in USD → integer micro-cents, refusing a non-finite, negative, absurd or inexact value (exit 2). `0` is accepted and
 * meaningful: it records "this is free, and I am telling you so", which the stored column can hold distinctly from "nobody has said".
 * Both units are stored in the same step; what differs is the ceiling and the sentence, which names the right denominator.
 *
 * The conversion reads the number's own shortest decimal (`String(usd)`) and never multiplies: `usd * 1e8` in binary floating point
 * moves a half-step either way (`0.000000015 * 1e8` is `1.4999999999999998`), and rounding let a positive price below the smallest
 * step become the `0` that means "free", which the cost cap believes. A price that is not a whole number of micro-cents is refused,
 * with the smallest accepted price in the sentence, so the integer that is stored is the amount that was typed.
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
      `${name} must be a finite, non-negative number of USD per ${perUnit(field)}`,
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
  const decimal = readDecimal(String(usd));
  // The shortest text of a finite number is always a plain decimal. A fault here is a defect, and never a price: a guessed `0` is "free".
  if (decimal === undefined)
    throw new CliError('cli_internal', 'the text of a finite price is not a decimal number');
  const refusal = precisionRefusal(decimal);
  if (refusal !== undefined)
    throw new CliError('invalid_invocation', precisionSentence(field, refusal, naming));
  return microcentsOf(decimal);
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

// ── the model id ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Invisible and formatting characters (Unicode `Cf`, and the default-ignorable code points: zero-width space and joiners, the word
 * joiner, the byte-order mark, the soft hyphen, the tag characters, variation selectors). A terminal draws none of them, so `gpt-5`
 * and `gpt-5` + U+200B are two model ids that look the same: a price recorded for one reads as a price for the other.
 */
const INVISIBLE_CHARACTER = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

/** Why a model id cannot be priced: it is nothing, it carries a character no terminal draws, or a space at either end hides inside quotes. */
export type ModelIdFault = 'empty' | 'invisible' | 'padded';

/**
 * Whether a model id is one a price can be recorded under without the id being shown as something it is not, or why it is not. It is
 * the ONE rule of the shell's core (a SET, with {@link modelIdSentence}) and of the Home's form (which adds what only a card has: a
 * width and the sanitizer). Removing a price is never refused by it: an id stored before the rule must stay removable.
 */
export function modelIdFault(id: string): ModelIdFault | undefined {
  if (id === '') return 'empty';
  // Invisible first: `trim()` also strips U+FEFF, which is a format character before it is padding.
  if (INVISIBLE_CHARACTER.test(id)) return 'invisible';
  if (id !== id.trim()) return 'padded';
  return undefined;
}

/** The shell's sentence for a {@link ModelIdFault}: it never quotes the id (the id is the thing that cannot be shown faithfully). */
export function modelIdSentence(fault: ModelIdFault): string {
  switch (fault) {
    case 'empty':
      return 'the model id is empty. Nothing written.';
    case 'invisible':
      return 'the model id has invisible or formatting characters, so it would be recorded as one id and shown as another. Nothing written.';
    case 'padded':
      return 'the model id starts or ends with a space, so it would be recorded as one id and shown as another. Nothing written.';
  }
}
