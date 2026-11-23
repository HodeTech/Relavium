/**
 * The field table of `models pricing` ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §9)
 * is the one place that names a price, its flag, its unit and its ceiling. These tests prove that the table, the command's descriptor
 * (what the parser accepts), the shell's argument builder and the command core's arguments name the same fields — each way — and pin the
 * two rules the table owns: the pairing rule and the ceilings.
 */
import { describe, expect, it } from 'vitest';

import { COMMAND_DESCRIPTORS } from './descriptors.js';
import { buildModelsPricingArgs, type CommandInput } from './dispatch.js';
import {
  MAX_USD_PER_MEDIA_UNIT,
  MAX_USD_PER_MTOK,
  PRICING_FIELDS,
  pairingIssue,
  pairingSentence,
  parsePriceText,
  priceTextIssue,
  priceToMicrocents,
  pricingField,
  usdTextOfMicrocents,
  type PricingFieldId,
} from './pricing-fields.js';

const input = (positionals: readonly string[], options: CommandInput['options']): CommandInput => ({
  positionals,
  options,
});

function pricingDescriptor() {
  const found = COMMAND_DESCRIPTORS.find(
    (descriptor) => descriptor.path.join(' ') === 'models pricing',
  );
  if (found === undefined) throw new Error('the models pricing descriptor is missing');
  return found;
}

/** A SET that states only `id` and what the pairing rule needs beside it. */
function optionsFor(id: PricingFieldId, value: string): CommandInput['options'] {
  const mate = pricingField(id).pairedWith;
  return { provider: 'openai', [id]: value, ...(mate === undefined ? {} : { [mate]: '1' }) };
}

describe('the table and the command descriptor name the same flags, each way', () => {
  const descriptor = pricingDescriptor();
  const NOT_PRICES = new Set(['provider', 'clear']);

  it('every price option the descriptor accepts is a row of the table', () => {
    const accepted = descriptor.options
      .map((option) => option.binding)
      .filter((binding) => !NOT_PRICES.has(binding));
    expect(accepted.sort()).toEqual(PRICING_FIELDS.map((field) => field.id).sort());
  });

  it('every row of the table is an option the descriptor accepts, under the flag the sentences name', () => {
    for (const field of PRICING_FIELDS) {
      const option = descriptor.options.find((candidate) => candidate.binding === field.id);
      expect(option, `${field.id} has an option`).toBeDefined();
      expect([...(option?.spellings ?? []), ...(option?.deprecatedSpellings ?? [])]).toContain(
        field.flag,
      );
      // A price option takes a value, a number as text, and is never required on its own (the pairing rule decides).
      expect(option?.type).toBe('string');
      expect(option?.arity).toBe('required');
      expect(option?.required).toBe(false);
    }
  });

  it('the descriptor still offers --provider and --clear, which the table does not own', () => {
    expect(descriptor.options.map((option) => option.binding)).toEqual(
      expect.arrayContaining(['provider', 'clear']),
    );
  });
});

describe('the table and the shell parser name the same fields, each way', () => {
  it('each row is read by the argument builder from its own option, into its own argument', () => {
    for (const field of PRICING_FIELDS) {
      const args = buildModelsPricingArgs(input(['m'], optionsFor(field.id, '0.5')));
      if (args.clear === true) throw new Error('a SET was expected');
      expect(args[field.arg], `${field.id} → ${field.arg}`).toBe(0.5);
    }
  });

  it('an option that is not a row of the table is not read as a price', () => {
    const args = buildModelsPricingArgs(
      input(['m'], { provider: 'openai', input: '1', output: '2', bogus: '9', reasoning: '4' }),
    );
    expect(args).toEqual({
      model: 'm',
      provider: 'openai',
      inputUsdPerMtok: 1,
      outputUsdPerMtok: 2,
    });
  });

  it('--clear refuses a price flag for every row of the table', () => {
    for (const field of PRICING_FIELDS) {
      expect(() =>
        buildModelsPricingArgs(input(['m'], { provider: 'openai', clear: true, [field.id]: '1' })),
      ).toThrow(`--clear removes the price; it takes no ${field.flag}. Nothing written.`);
    }
  });
});

describe('the table is well formed', () => {
  it('has unique ids, flags, arguments and columns, and the ids are what the option map carries', () => {
    for (const key of ['id', 'flag', 'arg', 'column', 'label'] as const) {
      const values = PRICING_FIELDS.map((field) => field[key]);
      expect(new Set(values).size, key).toBe(values.length);
    }
    expect(PRICING_FIELDS.map((field) => field.id)).toEqual([
      'input',
      'output',
      'cached',
      'image',
      'audio',
      'video',
    ]);
  });

  it('pairs input with output and nothing else, symmetrically', () => {
    const paired = PRICING_FIELDS.filter((field) => field.pairedWith !== undefined);
    expect(paired.map((field) => field.id)).toEqual(['input', 'output']);
    for (const field of paired) {
      const mate = field.pairedWith === undefined ? undefined : pricingField(field.pairedWith);
      expect(mate?.pairedWith).toBe(field.id);
    }
  });

  it('quotes the token three per million tokens and the media three per billed unit, each with its own ceiling', () => {
    for (const field of PRICING_FIELDS) {
      expect(field.media).toBe(field.unit === 'billed-unit');
      expect(field.ceiling).toBe(field.media ? MAX_USD_PER_MEDIA_UNIT : MAX_USD_PER_MTOK);
    }
    expect(MAX_USD_PER_MEDIA_UNIT).toBeLessThan(MAX_USD_PER_MTOK);
  });

  it('pins each ceiling to the number the product states (the surfaces tests write theirs out, so they do not follow the table)', () => {
    expect(Object.fromEntries(PRICING_FIELDS.map((field) => [field.id, field.ceiling]))).toEqual({
      input: 100_000,
      output: 100_000,
      cached: 100_000,
      image: 1_000,
      audio: 1_000,
      video: 1_000,
    });
  });

  it('echoes each price in the unit the table says', () => {
    expect(PRICING_FIELDS.map((field) => field.suffix)).toEqual([
      '/Mtok',
      '/Mtok',
      '/Mtok',
      '/image',
      '/s',
      '/s',
    ]);
  });
});

describe('the ceilings', () => {
  it.each(PRICING_FIELDS.map((field) => [field.id, field] as const))(
    '%s accepts its ceiling and refuses a cent above it',
    (_id, field) => {
      expect(priceToMicrocents(field, field.ceiling)).toBe(Math.round(field.ceiling * 100_000_000));
      expect(() => priceToMicrocents(field, field.ceiling + 0.01)).toThrow(/implausibly large/);
      expect(() => priceToMicrocents(field, -0.01)).toThrow(/non-negative/);
      expect(() => priceToMicrocents(field, Number.NaN)).toThrow(/finite/);
      expect(priceToMicrocents(field, 0), 'zero is a stated, free price').toBe(0);
    },
  );

  it('names the flag in the shell and the label in the form, with the same words', () => {
    const image = pricingField('image');
    expect(() => priceToMicrocents(image, 5000)).toThrow(
      '--image ($5000) is implausibly large — the maximum is $1000 per unit',
    );
    expect(() => priceToMicrocents(image, 5000, 'label')).toThrow(
      'Image price ($5000) is implausibly large — the maximum is $1000 per unit',
    );
    expect(priceTextIssue(image, '5000')).toBe(
      'Image price ($5000) is implausibly large — the maximum is $1000 per unit',
    );
  });

  it('the form says nothing about an empty text (it means "not set") and refuses the shell\'s refusals', () => {
    for (const field of PRICING_FIELDS) {
      expect(priceTextIssue(field, ''), field.id).toBeUndefined();
      expect(priceTextIssue(field, '   '), field.id).toBeUndefined();
      expect(priceTextIssue(field, String(field.ceiling)), field.id).toBeUndefined();
      expect(priceTextIssue(field, String(field.ceiling + 1)), field.id).toMatch(/implausibly/);
      expect(priceTextIssue(field, 'abc'), field.id).toMatch(/must be a finite number/);
      expect(priceTextIssue(field, '-1'), field.id).toMatch(/non-negative/);
    }
  });

  it('parses shape only: the range and the ceiling are not its business', () => {
    const input = pricingField('input');
    expect(parsePriceText(input, ' 3 ')).toBe(3);
    expect(parsePriceText(input, '-1')).toBe(-1);
    expect(parsePriceText(input, '1000000')).toBe(1_000_000);
    expect(() => parsePriceText(input, 'abc')).toThrow(
      '--input must be a finite number of USD per million tokens.',
    );
    expect(() => parsePriceText(pricingField('video'), 'abc')).toThrow(
      '--video must be a finite number of USD per billed unit (per image, or per second).',
    );
  });
});

describe('the pairing rule', () => {
  const given =
    (...ids: PricingFieldId[]) =>
    (id: PricingFieldId): boolean =>
      ids.includes(id);

  it('refuses no price at all, naming the first flag that is missing', () => {
    expect(pairingIssue(given())).toEqual({ kind: 'none', field: 'input' });
    expect(pairingSentence({ kind: 'none', field: 'input' })).toBe(
      'missing required option --input USD_PER_MTOK (or price only --cached / --image / --audio / --video).',
    );
  });

  it('names the output when only the input was given and nothing else', () => {
    expect(pairingIssue(given('input'))).toEqual({ kind: 'missing', field: 'output' });
    expect(pairingIssue(given('output'))).toEqual({ kind: 'missing', field: 'input' });
  });

  it('refuses one half of the pair beside another price: they are set together', () => {
    for (const other of ['cached', 'image', 'audio', 'video'] as const) {
      expect(pairingIssue(given('input', other))).toEqual({ kind: 'incomplete' });
      expect(pairingIssue(given('output', other))).toEqual({ kind: 'incomplete' });
    }
    expect(pairingSentence({ kind: 'incomplete' })).toBe(
      '--input and --output must be given together (or omit both and price only media rates).',
    );
  });

  it('accepts the pair, with or without the rest, and any one of the rest alone', () => {
    expect(pairingIssue(given('input', 'output'))).toBeUndefined();
    expect(
      pairingIssue(given('input', 'output', 'cached', 'image', 'audio', 'video')),
    ).toBeUndefined();
    for (const other of ['cached', 'image', 'audio', 'video'] as const)
      expect(pairingIssue(given(other)), other).toBeUndefined();
  });

  it("says the same thing in the form's words, with labels where the shell has flags", () => {
    expect(pairingSentence({ kind: 'incomplete' }, 'label')).toBe(
      'Input price and Output price are set together: give both, or leave both empty and price only the cached or a media rate.',
    );
    expect(pairingSentence({ kind: 'none', field: 'input' }, 'label')).toBe(
      'Set at least one price: Input price and Output price together, or only Cached input price, Image price, Audio price, Video price.',
    );
    expect(pairingSentence({ kind: 'missing', field: 'output' }, 'label')).toBe(
      'Output price is missing: it is set together with the input price. Give both, or leave both empty and price only the cached or a media rate.',
    );
  });
});

describe('an exact decimal amount from the stored integer', () => {
  it('prints whole dollars, fractions to the micro-cent, and never an exponent', () => {
    expect(usdTextOfMicrocents(0)).toBe('0');
    expect(usdTextOfMicrocents(300_000_000)).toBe('3');
    expect(usdTextOfMicrocents(3_000_000)).toBe('0.03');
    expect(usdTextOfMicrocents(15_000_000)).toBe('0.15');
    expect(usdTextOfMicrocents(1)).toBe('0.00000001');
    expect(usdTextOfMicrocents(14_999_999)).toBe('0.14999999');
    expect(usdTextOfMicrocents(1_000_000_000_000)).toBe('10000');
    expect(usdTextOfMicrocents(10_000_000_000_001)).toBe('100000.00000001');
  });

  it('is the exact inverse of the conversion, for what the table accepts', () => {
    const input = pricingField('input');
    for (const usd of [0, 0.5, 3, 0.15, 0.6, 99_999.99999999, 100_000, 0.00000001]) {
      expect(Number(usdTextOfMicrocents(priceToMicrocents(input, usd)))).toBe(usd);
    }
  });
});
