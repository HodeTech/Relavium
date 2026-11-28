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
  MICROCENTS_PER_USD,
  PRICE_DECIMAL_PLACES,
  PRICING_FIELDS,
  modelIdFault,
  modelIdSentence,
  pairingIssue,
  pairingSentence,
  parsePriceText,
  priceTextIssue,
  priceToMicrocents,
  pricingField,
  usdTextOfMicrocents,
  withoutTrailingZeros,
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

  it("every row's remedy flag is the option's PRIMARY spelling, so a remedy never names a deprecated one", () => {
    for (const field of PRICING_FIELDS) {
      const option = descriptor.options.find((candidate) => candidate.binding === field.id);
      expect(option?.spellings[0], `${field.id} remedy flag`).toBe(field.canonicalFlag);
      expect(option?.deprecatedSpellings ?? []).not.toContain(field.canonicalFlag);
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
    expect(PRICING_FIELDS.map((field) => field.priceUnit)).toEqual([
      'M',
      'M',
      'M',
      'image',
      'second',
      'second',
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
      '--image ($5000 per image) is implausibly large — the maximum is $1000 per image',
    );
    expect(() => priceToMicrocents(image, 5000, 'label')).toThrow(
      'Image price ($5000 per image) is implausibly large — the maximum is $1000 per image',
    );
    expect(priceTextIssue(image, '5000')).toBe(
      'Image price ($5000 per image) is implausibly large — the maximum is $1000 per image',
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

  it('trims trailing zeros exactly as `/0+$/` did, over every short text of the characters a price holds', () => {
    // The reference pops characters off an array, so it shares nothing with the loop under test; a one-off run of both against the
    // replaced `/0+$/` agreed on all of these texts.
    const reference = (text: string): string => {
      const characters = [...text];
      while (characters.at(-1) === '0') characters.pop();
      return characters.join('');
    };
    const alphabet = ['0', '1', '.', '-'];
    let texts = [''];
    let checked = 0;
    for (let length = 1; length <= 7; length += 1) {
      texts = texts.flatMap((text) => alphabet.map((character) => text + character));
      for (const text of texts) {
        expect(withoutTrailingZeros(text)).toBe(reference(text));
        checked += 1;
      }
    }
    expect(checked).toBe(4 + 16 + 64 + 256 + 1024 + 4096 + 16_384);
  });

  it('trims a very long run of zeros in linear work: one that is not at the end is left whole, one at the end goes whole', () => {
    // `/0+$/` retries from every zero of a run that is not at the end (SonarCloud S8786): 200 000 of them took 13 s, so this test fails by
    // exceeding its timeout under that form. Nothing reaches the function with such a length (a stored integer's text is short), so it is
    // exercised directly.
    const run = '0'.repeat(200_000);
    expect(withoutTrailingZeros(`${run}1`)).toBe(`${run}1`);
    expect(withoutTrailingZeros(`1${run}`)).toBe('1');
    expect(withoutTrailingZeros(run)).toBe('');
  });

  it('is the exact inverse of the conversion, for what the table accepts', () => {
    const input = pricingField('input');
    for (const usd of [0, 0.5, 3, 0.15, 0.6, 99_999.99999999, 100_000, 0.00000001]) {
      expect(Number(usdTextOfMicrocents(priceToMicrocents(input, usd)))).toBe(usd);
    }
  });
});

describe('a price is read as an exact decimal and stored as the whole micro-cents it is', () => {
  const input = pricingField('input');
  const microcentsOfText = (text: string, field = input): number =>
    priceToMicrocents(field, parsePriceText(field, text));

  it.each([
    ['0', 0],
    ['0.0', 0],
    ['-0', 0],
    ['0e5', 0],
    ['1', 100_000_000],
    ['0.15', 15_000_000],
    ['0.00000001', 1],
    ['1e-8', 1],
    ['1E-8', 1],
    ['1.5e-7', 15],
    ['0.12345679', 12_345_679],
    ['12345.67890123', 1_234_567_890_123],
    ['99999.99999999', 9_999_999_999_999],
    ['100000', 10_000_000_000_000],
    ['.5', 50_000_000],
    ['5.', 500_000_000],
    ['+5', 500_000_000],
    ['1e2', 10_000_000_000],
    ['0.1e1', 100_000_000],
    ['00012', 1_200_000_000],
    // Zeros after the last significant digit are not more precision, however many there are.
    ['1.000000000000000000000000', 100_000_000],
    ['0.0000000100000000000000', 1],
    // Values whose product with 1e8 is not an integer in binary floating point.
    ['0.285', 28_500_000],
    ['1.005', 100_500_000],
    ['0.07', 7_000_000],
  ])('%s is %d micro-cents', (text, expected) => {
    expect(microcentsOfText(text)).toBe(expected);
  });

  it('refuses a positive price below one micro-cent, whatever way it is written, with the smallest price in the sentence', () => {
    const sentence =
      '--input is below the smallest price that can be stored, $0.00000001 per M. Enter 0 to record it as free.';
    for (const text of [
      '0.000000005',
      '0.000000004',
      '.000000004',
      '0.000000001',
      '1e-9',
      '4E-9',
      '0.00000000000000000001',
      '1e-999',
      '0.' + '0'.repeat(50_000) + '1',
    ])
      expect(() => parsePriceText(input, text), text.slice(0, 20)).toThrow(sentence);
  });

  it('refuses a price with more decimal places than a micro-cent, instead of rounding it', () => {
    const sentence =
      '--input has more than 8 decimal places, and a price is stored in whole steps of $0.00000001 per M. Enter it to the nearest step.';
    for (const text of [
      '0.123456789',
      '.123456789',
      // `0.000000015 * 1e8` is 1.4999999999999998: the old conversion stored 1 where the decimal is 1.5 steps.
      '0.000000015',
      '1.000000001',
      '1.5e-8',
      // The double nearest this text is exactly 1, which the old code stored as $1.
      '1.0000000000000001',
    ])
      expect(() => parsePriceText(input, text), text).toThrow(sentence);
  });

  it('names the unit of the field in the sentence: a media price is per billed unit', () => {
    expect(() => parsePriceText(pricingField('image'), '1e-9', 'label')).toThrow(
      'Image price is below the smallest price that can be stored, $0.00000001 per image. Enter 0 to record it as free.',
    );
    expect(priceTextIssue(pricingField('video'), '0.123456789')).toBe(
      'Video price has more than 8 decimal places, and a price is stored in whole steps of $0.00000001 per second. Enter it to the nearest step.',
    );
    expect(priceTextIssue(input, '0.00000001')).toBeUndefined();
  });

  it('refuses a negative price for its sign, not for its precision, and leaves the range to the conversion', () => {
    expect(parsePriceText(input, '-0.000000001')).toBe(-1e-9);
    expect(() => priceToMicrocents(input, -1e-9)).toThrow(/non-negative/);
  });

  it('refuses what is not a plain decimal number: a name, a non-decimal base, a separator, a lone point or exponent', () => {
    for (const text of [
      '',
      '   ',
      'abc',
      'NaN',
      'Infinity',
      '-Infinity',
      '0x10',
      '0b11',
      '0o7',
      '1_000',
      '1,5',
      '1 5',
      '.',
      'e5',
      '1e',
      '1e+',
      '--1',
      '1e999',
      '9'.repeat(5_000),
    ])
      expect(() => parsePriceText(input, text), JSON.stringify(text.slice(0, 20))).toThrow(
        '--input must be a finite number of USD per million tokens.',
      );
  });

  it('reads a very long text in one pass: a run of zeros costs a scan, not a backtracking search', () => {
    expect(microcentsOfText('0'.repeat(50_000) + '1')).toBe(100_000_000);
    expect(microcentsOfText('1.' + '0'.repeat(50_000))).toBe(100_000_000);
    expect(() => parsePriceText(input, '1' + '0'.repeat(50_000) + 'x')).toThrow(
      /must be a finite number/,
    );
  });

  it('refuses a value past the ceiling in the ceiling sentence, however large, and never converts it', () => {
    expect(() => microcentsOfText('1e30')).toThrow(
      '--input ($1e+30 per M) is implausibly large — the maximum is $100000 per M',
    );
    expect(() => microcentsOfText('100000.00000001')).toThrow(/implausibly large/);
    expect(() => priceToMicrocents(input, Number.MAX_VALUE)).toThrow(/implausibly large/);
  });

  it('refuses a number that is not finite, or is not a whole number of micro-cents, when it is handed over directly', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
      expect(() => priceToMicrocents(input, bad), String(bad)).toThrow(/finite/);
    expect(() => priceToMicrocents(input, 1e-9)).toThrow(/below the smallest price/);
    expect(() => priceToMicrocents(input, 0.1 + 0.2)).toThrow(/more than 8 decimal places/);
    expect(priceToMicrocents(input, 0.1)).toBe(10_000_000);
    expect(priceToMicrocents(input, 1e-8)).toBe(1);
  });

  it('keeps a micro-cent a hundred-millionth of a dollar, and the decimal places the sentences name', () => {
    expect(MICROCENTS_PER_USD).toBe(10 ** PRICE_DECIMAL_PLACES);
    expect(PRICE_DECIMAL_PLACES).toBe(8);
  });

  it('round-trips every price the table accepts through the stored integer and back to the text', () => {
    for (const text of ['0', '0.5', '3', '0.15', '0.00000001', '99999.99999999', '100000'])
      expect(usdTextOfMicrocents(microcentsOfText(text))).toBe(text);
    expect(usdTextOfMicrocents(microcentsOfText('1e-8'))).toBe('0.00000001');
    expect(usdTextOfMicrocents(microcentsOfText('0.1e1'))).toBe('1');
  });
});

describe('the model id rule is one function, read by the shell and by the form', () => {
  it('names an empty id, an invisible character and a padded id, in that order of precedence', () => {
    expect(modelIdFault('')).toBe('empty');
    expect(modelIdFault('gpt-5​')).toBe('invisible');
    // U+FEFF is a format character before it is padding (`trim()` strips it).
    expect(modelIdFault('﻿gpt-5')).toBe('invisible');
    expect(modelIdFault(' gpt-5 ')).toBe('padded');
    expect(modelIdFault('gpt-5')).toBeUndefined();
  });

  it('has one sentence per fault, and none quotes the id', () => {
    expect(modelIdSentence('empty')).toBe('the model id is empty. Nothing written.');
    expect(modelIdSentence('invisible')).toContain('invisible or formatting characters');
    expect(modelIdSentence('padded')).toContain('starts or ends with a space');
    for (const fault of ['empty', 'invisible', 'padded'] as const)
      expect(modelIdSentence(fault)).toMatch(/Nothing written\.$/u);
  });
});
