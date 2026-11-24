/**
 * The Home's pricing port ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §9, MVP-8 step 5) over a real `:memory:` database and the real catalog and provider stores: what the form shows is the plan the shell's
 * own core decided, and what it commits is the row the shell would write. The rules that belong to the core — the pairing rule and every
 * price's ceiling — are pinned on BOTH surfaces here: the same invocation is run through the shell (`buildModelsPricingArgs` and
 * `modelsPricingCommand`) and through the form (`port.prepare`), and both refuse it, or both accept it.
 *
 * Nothing here touches an operator's `history.db`: every database is `:memory:`.
 */
import {
  createClient,
  createModelCatalogStore,
  createModelMetadataStore,
  createProviderStore,
  runMigrations,
  type DbClient,
  type ModelCatalogListing,
  type ModelCatalogStore,
  type ProviderStore,
} from '@relavium/db';
import {
  catalogModel,
  clearCatalogRefresh,
  type CatalogModel,
  type ModelCatalogEntry,
} from '@relavium/llm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildModelsPricingArgs, type CommandInput } from '../commands/dispatch.js';
import { persistCatalogToDb } from '../engine/catalog-metadata.js';
import {
  commitPricing,
  modelsPricingCommand,
  preparePricing,
  writePricingResult,
} from '../commands/models-pricing.js';
import {
  PRICING_FIELDS,
  modelIdFault,
  pairingSentence,
  pricingField,
  usdTextOfMicrocents,
  type PricingField,
  type PricingFieldId,
} from '../commands/pricing-fields.js';
import { isCliError } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';
import {
  PRICING_MODEL_ID_FAULTS,
  pricingModelIdFault,
  type PricingPort,
  type PricingPrepared,
} from '../render/tui/pricing-card.js';
import { captureIo } from '../test-support.js';
import { PRICING_WRITE_FAULT, createPricingPort } from './pricing-port.js';

const global = (json = false): GlobalOptions => ({
  json,
  color: false,
  cwd: process.cwd(),
  configPath: undefined,
  verbosity: 'normal',
});

const entry = (modelId: string, over: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
  modelId,
  provider: 'openai',
  displayName: modelId,
  pricingSource: 'none',
  priceKnown: false,
  available: true,
  deprecated: false,
  ...over,
});

let client: DbClient;
let catalog: ModelCatalogStore;
let providers: ProviderStore;
let port: PricingPort;
let entries: readonly ModelCatalogEntry[] = [];

beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  let n = 0;
  const storeDeps = {
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    now: () => 1_700_000_000_000,
  };
  providers = createProviderStore(client.db, storeDeps);
  for (const [name, displayName, baseUrl] of [
    ['openai', 'OpenAI', 'https://api.openai.com/v1'],
    ['deepseek', 'DeepSeek', 'https://api.deepseek.com'],
  ] as const)
    providers.upsert({ name, displayName, baseUrl });
  catalog = createModelCatalogStore(client.db, storeDeps);
  entries = [];
  port = createPricingPort({ db: client.db, ...storeDeps, models: () => entries });
});

afterEach(() => {
  client.sqlite.close();
});

const rowsFor = (modelId: string): ModelCatalogListing[] =>
  catalog.listAll().filter((row) => row.modelId === modelId);

/** The fields a stored row holds a price the operator stated for: the token pair, the cached rate and each media rate that is not NULL. */
function statedFields(row: ModelCatalogListing | undefined): PricingFieldId[] {
  if (row === undefined) return [];
  const stated: Array<[PricingFieldId, boolean]> = [
    ['input', row.tokenRatesStated],
    ['output', row.tokenRatesStated],
    ['cached', row.cachedInputStated],
    ['image', row.mediaImageCostMicrocents !== null],
    ['audio', row.mediaAudioCostMicrocents !== null],
    ['video', row.mediaVideoCostMicrocents !== null],
  ];
  return stated.filter(([, isStated]) => isStated).map(([id]) => id);
}

const OPENAI = (modelId: string) => ({ modelId, provider: 'openai' });

function prepared(
  modelId: string,
  prices: Partial<Record<PricingFieldId, string>>,
  provider = 'openai',
): Extract<PricingPrepared, { ok: true }> {
  const result = port.prepare({ modelId, provider }, { action: 'set', prices });
  if (!result.ok) throw new Error(`expected a plan, got a refusal: ${result.reason}`);
  return result;
}

function refused(
  modelId: string,
  prices: Partial<Record<PricingFieldId, string>>,
  provider = 'openai',
): string {
  const result = port.prepare({ modelId, provider }, { action: 'set', prices });
  if (result.ok) throw new Error('expected a refusal, got a plan');
  return result.reason;
}

/** What the shell does with the same invocation: its refusal sentence, or `undefined` when it accepted (and wrote). */
function shellRefusal(
  modelId: string,
  options: CommandInput['options'],
  provider = 'openai',
): string | undefined {
  const { io } = captureIo();
  try {
    const args = buildModelsPricingArgs({
      positionals: [modelId],
      options: { provider, ...options },
    });
    modelsPricingCommand(args, { io, global: global(), catalog, providers });
    return undefined;
  } catch (cause) {
    if (isCliError(cause)) return cause.message;
    throw cause;
  }
}

/**
 * The ceilings as the product states them (ADR-0089 section 4, the models-pricing docs), written out here and NOT read from the table: a
 * test that read its limit from the table would follow a table that was changed by mistake. The field-table test pins the table to these.
 */
const CEILING: Readonly<Record<PricingFieldId, number>> = {
  input: 100_000,
  output: 100_000,
  cached: 100_000,
  image: 1_000,
  audio: 1_000,
  video: 1_000,
};

/** A model the catalog does not price (so a token pair is needed) or one it does (so a cached or media rate stands alone). */
const modelFor = (field: PricingField): string =>
  field.pairedWith === undefined ? 'gpt-4' : 'acme-custom-1';
/** What a price for `field` needs beside it so that only the field under test can be at fault. */
const beside = (field: PricingField): Partial<Record<PricingFieldId, string>> =>
  field.pairedWith === undefined ? {} : { [field.pairedWith]: '1' };

describe("prepare shows the plan the shell's own core decided, and writes nothing", () => {
  it("offers exactly the prices given, in the table's order, in its units and from the stored integers", () => {
    const result = prepared('acme-custom-1', {
      video: '0.5',
      output: '9',
      input: '3',
      cached: '0.03',
      image: '0.04',
    });
    expect(result.offer.kind).toBe('set');
    expect(result.offer.model).toBe('acme-custom-1');
    expect(result.offer.provider).toBe('openai');
    expect(result.offer.prices.map((price) => [price.id, price.amount, price.microcents])).toEqual([
      ['input', '$3/Mtok', 300_000_000],
      ['output', '$9/Mtok', 900_000_000],
      ['cached', '$0.03/Mtok', 3_000_000],
      ['image', '$0.04/image', 4_000_000],
      ['video', '$0.5/s', 50_000_000],
    ]);
    expect(result.offer.keeps, 'audio was left empty, so it keeps what is stored').toBe(true);
    expect(rowsFor('acme-custom-1'), 'preparing writes nothing').toHaveLength(0);
  });

  it('treats an empty or blank text as "not set", exactly as if the field were never asked', () => {
    const result = prepared('acme-custom-1', {
      input: ' 3 ',
      output: '9',
      cached: '',
      image: '   ',
    });
    expect(result.offer.prices.map((price) => price.id)).toEqual(['input', 'output']);
  });

  it('says every field is set when it is, and that nothing is left alone', () => {
    const all = Object.fromEntries(PRICING_FIELDS.map((field) => [field.id, '1']));
    expect(prepared('acme-custom-1', all).offer.keeps).toBe(false);
  });

  it('shows the amount the store will hold: eight decimals are exact, and the written sentence says the stored price', () => {
    const result = prepared('acme-custom-1', { input: '0.12345679', output: '1e-8' });
    expect(result.offer.prices.map((price) => [price.amount, price.microcents])).toEqual([
      ['$0.12345679/Mtok', 12_345_679],
      ['$0.00000001/Mtok', 1],
    ]);
    const attempt = result.commit();
    if (!attempt.ok) throw new Error(`expected a write, got a refusal: ${attempt.reason}`);
    expect(attempt.written).toContain('input $0.12345679/Mtok, output $0.00000001/Mtok.');
    const [row] = rowsFor('acme-custom-1');
    expect([row?.inputCostPerMtokMicrocents, row?.outputCostPerMtokMicrocents]).toEqual([
      12_345_679, 1,
    ]);
  });

  it('names the catalog price a token price replaces, and not when only a media price is given', () => {
    expect(prepared('gpt-5.5', { input: '3', output: '9' }).offer.replaces).toBe(
      'input $5/Mtok, output $30/Mtok',
    );
    expect(prepared('gpt-5.5', { cached: '0.1' }).offer.replaces).toBe('cached $0.5/Mtok');
    expect(prepared('gpt-5.5', { image: '0.04' }).offer.replaces).toBeUndefined();
    expect(prepared('acme-custom-1', { input: '3', output: '9' }).offer.replaces).toBeUndefined();
  });

  it('commits exactly the plan: the row read back holds every integer the card showed, and no other price', () => {
    const result = prepared('acme-custom-1', {
      input: '3',
      output: '9',
      cached: '0.03',
      audio: '0.001',
    });
    expect(result.commit()).toEqual({
      ok: true,
      written:
        'Set user pricing for acme-custom-1 (OpenAI): input $3/Mtok, output $9/Mtok, cached $0.03/Mtok, audio $0.001/s. It applies to your next run/chat and survives a model refresh.',
    });
    const [row] = rowsFor('acme-custom-1');
    const stored: Record<PricingFieldId, number | null | undefined> = {
      input: row?.inputCostPerMtokMicrocents,
      output: row?.outputCostPerMtokMicrocents,
      cached: row?.cachedInputCostPerMtokMicrocents,
      image: row?.mediaImageCostMicrocents,
      audio: row?.mediaAudioCostMicrocents,
      video: row?.mediaVideoCostMicrocents,
    };
    for (const price of result.offer.prices)
      expect(stored[price.id], price.id).toBe(price.microcents);
    // Nothing is stored that the card did not show, and nothing is shown that is not stored.
    expect(statedFields(row)).toEqual(result.offer.prices.map((price) => price.id));
    // The fields the card did not show are the ones the row does not hold a price for.
    expect(stored.image).toBeNull();
    expect(stored.video).toBeNull();
    expect(row?.source).toBe('user');
    expect(row?.tokenRatesStated).toBe(true);
    expect(row?.cachedInputStated).toBe(true);
    // The card's amounts are the stored integers, printed.
    expect(result.offer.prices.map((price) => price.amount)).toEqual(
      result.offer.prices.map(
        (price) => `$${usdTextOfMicrocents(price.microcents)}${pricingField(price.id).suffix}`,
      ),
    );
  });

  it('writes the same row the shell writes for the same prices', () => {
    const prices = {
      input: '3',
      output: '9',
      cached: '0.03',
      image: '0.04',
      audio: '0.001',
      video: '0.5',
    };
    prepared('acme-custom-1', prices).commit();
    const viaForm = rowsFor('acme-custom-1');

    client.sqlite.exec('DELETE FROM model_catalog');
    expect(shellRefusal('acme-custom-1', prices)).toBeUndefined();
    const viaShell = rowsFor('acme-custom-1');
    expect(viaForm).toHaveLength(1);
    expect(viaForm).toEqual(viaShell);
  });

  it('a re-price through the form keeps what the row held for the fields it did not state', () => {
    prepared('acme-custom-1', { input: '3', output: '9', cached: '0.03', image: '0.04' }).commit();
    prepared('acme-custom-1', { input: '4', output: '12' }).commit();
    const [row] = rowsFor('acme-custom-1');
    expect(row?.inputCostPerMtokMicrocents).toBe(400_000_000);
    expect(row?.cachedInputCostPerMtokMicrocents).toBe(3_000_000);
    expect(row?.mediaImageCostMicrocents).toBe(4_000_000);
  });
});

describe("the shell and the form refuse alike (the core's rules, pinned on both surfaces)", () => {
  describe('the pairing rule', () => {
    it.each([
      ['input without output', { input: '3' }, { kind: 'missing', field: 'output' }],
      ['output without input', { output: '9' }, { kind: 'missing', field: 'input' }],
      ['input beside an image', { input: '3', image: '0.04' }, { kind: 'incomplete' }],
      ['output beside a cached price', { output: '9', cached: '1' }, { kind: 'incomplete' }],
      ['no price at all', {}, { kind: 'none', field: 'input' }],
    ] as const)('%s is refused by both, and nothing is written', (_name, prices, issue) => {
      const form = refused('acme-custom-1', prices);
      const shell = shellRefusal('acme-custom-1', prices);
      expect(shell, 'the shell refuses it').toBe(pairingSentence(issue));
      expect(form, 'the form refuses it, in its own words').toBe(pairingSentence(issue, 'label'));
      expect(rowsFor('acme-custom-1')).toHaveLength(0);
    });

    it('accepts the pair and every other price alone, on both', () => {
      expect(shellRefusal('acme-custom-1', { input: '3', output: '9' })).toBeUndefined();
      expect(
        port.prepare(OPENAI('acme-custom-1'), {
          action: 'set',
          prices: { input: '3', output: '9' },
        }).ok,
      ).toBe(true);
      for (const other of ['cached', 'image', 'audio', 'video'] as const) {
        expect(shellRefusal('gpt-4', { [other]: '0.5' }), other).toBeUndefined();
        expect(
          port.prepare(OPENAI('gpt-4'), { action: 'set', prices: { [other]: '0.5' } }).ok,
          other,
        ).toBe(true);
      }
    });

    it("is the core's: preparePricing refuses a half-stated pair whoever calls it", () => {
      expect(() =>
        preparePricing(
          { model: 'acme-custom-1', provider: 'openai', inputUsdPerMtok: 3 },
          { catalog, providers },
        ),
      ).toThrow(pairingSentence({ kind: 'missing', field: 'output' }));
      expect(() =>
        preparePricing(
          {
            model: 'acme-custom-1',
            provider: 'openai',
            inputUsdPerMtok: 3,
            imageUsdPerCount: 0.04,
          },
          { catalog, providers },
        ),
      ).toThrow(pairingSentence({ kind: 'incomplete' }));
      expect(rowsFor('acme-custom-1')).toHaveLength(0);
    });
  });

  describe("every price's ceiling", () => {
    it.each(PRICING_FIELDS.map((field) => [field.id, field] as const))(
      '%s: its ceiling is accepted and a cent above it is refused, by both',
      (_id, field) => {
        const model = modelFor(field);
        const ceiling = CEILING[field.id];
        const at = { ...beside(field), [field.id]: String(ceiling) };
        const above = { ...beside(field), [field.id]: String(ceiling + 0.01) };

        expect(shellRefusal(model, at), 'the shell accepts the ceiling').toBeUndefined();
        client.sqlite.exec('DELETE FROM model_catalog');
        expect(
          port.prepare(OPENAI(model), { action: 'set', prices: at }).ok,
          'the form accepts it',
        ).toBe(true);

        const shell = shellRefusal(model, above);
        const form = refused(model, above);
        expect(shell).toBe(
          field.unit === 'mtok'
            ? `${field.flag} ($${ceiling + 0.01}/Mtok) is implausibly large — the maximum is $${ceiling}/Mtok`
            : `${field.flag} ($${ceiling + 0.01}) is implausibly large — the maximum is $${ceiling} per unit`,
        );
        expect(form).toBe(
          field.unit === 'mtok'
            ? `${field.label} ($${ceiling + 0.01}/Mtok) is implausibly large — the maximum is $${ceiling}/Mtok`
            : `${field.label} ($${ceiling + 0.01}) is implausibly large — the maximum is $${ceiling} per unit`,
        );
      },
    );

    it.each(PRICING_FIELDS.map((field) => [field.id, field] as const))(
      '%s: a negative price and a text that is not a number are refused by both',
      (_id, field) => {
        const model = modelFor(field);
        for (const bad of ['-1', 'abc', 'NaN', 'Infinity']) {
          const options = { ...beside(field), [field.id]: bad };
          expect(shellRefusal(model, options), `shell ${bad}`).toEqual(expect.any(String));
          expect(refused(model, options), `form ${bad}`).toEqual(expect.any(String));
        }
        expect(rowsFor(model)).toHaveLength(0);
      },
    );
  });

  describe('a price is stored as exactly what was typed (one conversion, read by both)', () => {
    /** What the shell prints for an accepted invocation. */
    function shellOutput(modelId: string, options: CommandInput['options'], json = false): string {
      const { io, out } = captureIo();
      const args = buildModelsPricingArgs({
        positionals: [modelId],
        options: { provider: 'openai', ...options },
      });
      modelsPricingCommand(args, { io, global: global(json), catalog, providers });
      return out();
    }

    /** The smallest price, in the unit of `field`, as the refusals name it. */
    const step = (field: PricingField): string =>
      `$0.00000001 per ${field.unit === 'mtok' ? 'million tokens' : 'billed unit'}`;
    const belowSmallest = (name: string, field: PricingField): string =>
      `${name} is below the smallest price that can be stored, ${step(field)}. Enter 0 to record it as free.`;
    const tooPrecise = (name: string, field: PricingField): string =>
      `${name} has more than 8 decimal places, and a price is stored in whole steps of ${step(field)}. Enter it to the nearest step.`;

    const EVERY_FIELD = PRICING_FIELDS.map((field) => [field.id, field] as const);

    it.each(EVERY_FIELD)(
      '%s: a positive price below one micro-cent is refused, never stored as the 0 that means free',
      (_id, field) => {
        const model = modelFor(field);
        // 5e-9 and 4e-9 are the two sides of the old rounding line: `Math.round` made the first 1 and the second 0.
        for (const text of ['0.000000005', '0.000000004', '1e-9', '4E-9', '1e-999']) {
          const options = { ...beside(field), [field.id]: text };
          expect(shellRefusal(model, options), `shell ${text}`).toBe(
            belowSmallest(field.flag, field),
          );
          expect(refused(model, options), `form ${text}`).toBe(belowSmallest(field.label, field));
        }
        expect(rowsFor(model), 'nothing was written').toHaveLength(0);
      },
    );

    it.each(EVERY_FIELD)(
      '%s: a price with more decimal places than a micro-cent is refused, not rounded',
      (_id, field) => {
        const model = modelFor(field);
        // `0.000000015` times 1e8 is 1.4999999999999998 in binary floating point: the old code stored 1 where the decimal says 1.5;
        // `1.0000000000000001` is the double 1, which the old code stored as exactly $1.
        for (const text of ['0.123456789', '0.000000015', '1.000000001', '1.0000000000000001']) {
          const options = { ...beside(field), [field.id]: text };
          expect(shellRefusal(model, options), `shell ${text}`).toBe(tooPrecise(field.flag, field));
          expect(refused(model, options), `form ${text}`).toBe(tooPrecise(field.label, field));
        }
        expect(rowsFor(model), 'nothing was written').toHaveLength(0);
      },
    );

    it.each(EVERY_FIELD)(
      '%s: the smallest price (1e-8, written four ways) and an exact fraction are stored as typed, the same by both',
      (_id, field) => {
        const model = modelFor(field);
        for (const text of ['0.00000001', '1e-8', '1E-8', '.00000001', '0.0000000100']) {
          const options = { ...beside(field), [field.id]: text };
          const form = prepared(model, options);
          expect(
            form.offer.prices.find((price) => price.id === field.id)?.microcents,
            `form ${text}`,
          ).toBe(1);
          form.commit();
          const viaForm = rowsFor(model);
          client.sqlite.exec('DELETE FROM model_catalog');
          expect(shellRefusal(model, options), `shell ${text}`).toBeUndefined();
          expect(rowsFor(model), `the same row for ${text}`).toEqual(viaForm);
          client.sqlite.exec('DELETE FROM model_catalog');
        }
      },
    );

    it('stores the largest price exactly, and any whole or decimal spelling of the same number as one integer', () => {
      expect(
        prepared('acme-custom-1', { input: '99999.99999999', output: '1' }).offer.prices,
      ).toEqual([
        {
          id: 'input',
          label: 'Input price',
          amount: '$99999.99999999/Mtok',
          microcents: 9_999_999_999_999,
        },
        { id: 'output', label: 'Output price', amount: '$1/Mtok', microcents: 100_000_000 },
      ]);
      const spellings = ['3', '3.0', '3.', '+3', '03', '0.3e1', '30e-1', '3E0', ' 3 '];
      for (const text of spellings)
        expect(
          prepared('acme-custom-1', { input: text, output: '1' }).offer.prices[0]?.microcents,
          text,
        ).toBe(300_000_000);
    });

    it('says the stored price on every line the shell prints, and never the digits as typed', () => {
      expect(shellOutput('acme-custom-1', { input: '1e-8', output: ' 0.50 ' })).toContain(
        'input $0.00000001/Mtok, output $0.5/Mtok.',
      );
      expect(shellOutput('gpt-4', { image: '4E-2', audio: '0.0010', video: '+.5' })).toContain(
        'image $0.04/image, audio $0.001/s, video $0.5/s.',
      );
      // The `--json` record carries the same stored integers.
      client.sqlite.exec('DELETE FROM model_catalog');
      const record: unknown = JSON.parse(
        shellOutput('acme-custom-1', { input: '1e-8', output: '2' }, true),
      );
      expect(record).toMatchObject({
        inputCostPerMtokMicrocents: 1,
        outputCostPerMtokMicrocents: 200_000_000,
      });
    });

    it('is the shell sentence and the form sentence for the same stored price, on a catalog override too', () => {
      const viaShell = shellOutput('gpt-5.5', { input: '0.30000000', output: '9' });
      client.sqlite.exec('DELETE FROM model_catalog');
      const viaForm = prepared('gpt-5.5', { input: '0.30000000', output: '9' }).commit();
      // The two sentences are the same but for the two places the form speaks in the Home's words (MVP-11, ADR-0146 §6, OD-20): the
      // shell says `relavium models refresh` where the Home says "a model refresh", and the shell names the provider by its id where
      // the Home names it by its display name. Anything else that differs fails here.
      const shellInTheHomesWords = viaShell
        .replace('`relavium models refresh`', 'a model refresh')
        .replace('(openai)', '(OpenAI)');
      expect(viaForm.ok && shellInTheHomesWords.startsWith(viaForm.written)).toBe(true);
      expect(viaForm.ok && viaForm.written).not.toContain('relavium');
    });

    it('refuses a hexadecimal, binary, octal or separated number, which a bare Number() would have read', () => {
      for (const text of ['0x10', '0b101', '0o7', '1_000', '1,5', '1 5', '١٢']) {
        expect(shellRefusal('acme-custom-1', { input: text, output: '1' }), text).toBe(
          '--input must be a finite number of USD per million tokens.',
        );
        expect(refused('acme-custom-1', { input: text, output: '1' }), text).toBe(
          'Input price must be a finite number of USD per million tokens.',
        );
      }
    });

    it('believes a stated 0 in every spelling: free is a price somebody said', () => {
      for (const text of ['0', '0.0', '0e5', '-0', '.0']) {
        const form = prepared('acme-custom-1', { input: text, output: '1' });
        expect(form.offer.prices[0]?.microcents, text).toBe(0);
        expect(form.offer.prices[0]?.amount, text).toBe('$0/Mtok');
      }
    });
  });

  describe('the model id: one rule, the field table, for the shell and the form', () => {
    const HIDDEN: ReadonlyArray<readonly [string, string]> = [
      ['a zero-width space', 'gpt-5​'],
      ['a byte-order mark', 'gpt﻿-5'],
      ['a soft hyphen', 'gpt­-5'],
      ['a word joiner', 'gpt⁠-5'],
      ['a tag character', 'gpt-5\u{e0041}'],
      ['a variation selector', 'gpt-5️'],
      ['a right-to-left mark', 'gpt-5‏'],
      // Format characters (Unicode `Cf`) that are NOT default-ignorable: only the `Cf` half of the rule catches these.
      ['an Arabic number sign', 'gpt؀-5'],
      ['an interlinear annotation anchor', 'gpt-5￹'],
    ];

    it.each(HIDDEN)(
      '%s: refused by the shell in its own words and by the form in its',
      (_name, id) => {
        const prices = { input: '3', output: '9' };
        expect(shellRefusal(id, prices)).toBe(
          'the model id has invisible or formatting characters, so it would be recorded as one id and shown as another. Nothing written.',
        );
        const form = port.prepare({ modelId: id, provider: 'openai' }, { action: 'set', prices });
        expect(form).toEqual({ ok: false, reason: PRICING_MODEL_ID_FAULTS.invisible });
        expect(rowsFor(id), 'nothing was written').toHaveLength(0);
      },
    );

    it.each(HIDDEN)('%s: the card and the shell core name the same fault', (_name, id) => {
      expect(modelIdFault(id)).toBe('invisible');
      expect(pricingModelIdFault(id)).toBe('invisible');
    });

    it('refuses an empty id and an id with a space at either end, on both', () => {
      const prices = { input: '3', output: '9' };
      expect(shellRefusal('', prices)).toBe('the model id is empty. Nothing written.');
      expect(refused('', prices)).toBe(PRICING_MODEL_ID_FAULTS.empty);
      for (const id of [' acme-custom-1', 'acme-custom-1 ', '\tacme-custom-1']) {
        expect(shellRefusal(id, prices), JSON.stringify(id)).toBe(
          'the model id starts or ends with a space, so it would be recorded as one id and shown as another. Nothing written.',
        );
        expect(refused(id, prices), JSON.stringify(id)).toBe(PRICING_MODEL_ID_FAULTS.padded);
      }
      expect(catalog.listAll()).toHaveLength(0);
    });

    it('names the invisible fault before the padded one, as the form always did (a BOM is both)', () => {
      expect(modelIdFault('﻿gpt-5')).toBe('invisible');
      expect(modelIdFault(' gpt-5')).toBe('padded');
    });

    it('accepts an ordinary id, including the punctuation real ids carry', () => {
      for (const id of [
        'gpt-5.5',
        'claude-opus-4-8',
        'org/model:latest@v2',
        'ünïcode-ok',
        '模型-1',
      ]) {
        expect(modelIdFault(id), id).toBeUndefined();
      }
    });

    it('never refuses a CLEAR for its id: a price stored before the rule can still be removed', () => {
      const id = 'gpt-5​';
      const providerId = providers.list().find((provider) => provider.name === 'openai')?.id ?? '';
      catalog.upsert({
        providerId,
        modelId: id,
        source: 'user',
        inputCostPerMtokMicrocents: 1,
        outputCostPerMtokMicrocents: 2,
      });
      expect(rowsFor(id)).toHaveLength(1);
      expect(shellRefusal(id, { clear: true })).toBeUndefined();
      expect(rowsFor(id), 'the shell removed it').toHaveLength(0);
    });
  });

  describe('the refusals that do not depend on how a field is named', () => {
    it('refuses an unregistered provider with the same sentence', () => {
      const prices = { input: '3', output: '9' };
      expect(refused('acme-custom-1', prices, 'anthropic')).toBe(
        shellRefusal('acme-custom-1', prices, 'anthropic'),
      );
    });

    it('refuses a provider the catalog does not anchor the model to, with the same sentence', () => {
      const prices = { input: '3', output: '9' };
      const shell = shellRefusal('claude-opus-4-8', prices);
      expect(shell).toContain("anthropic's model");
      expect(refused('claude-opus-4-8', prices)).toBe(shell);
    });

    it('refuses a model already priced under another provider, with the same sentence', () => {
      expect(shellRefusal('shared-id', { input: '3', output: '9' }, 'deepseek')).toBeUndefined();
      const prices = { input: '3', output: '9' };
      expect(refused('shared-id', prices)).toBe(shellRefusal('shared-id', prices));
      expect(refused('shared-id', prices)).toContain("already user-priced under 'deepseek'");
    });

    it('refuses a media or cached price alone on a model nothing prices for tokens', () => {
      expect(shellRefusal('brand-new', { image: '0.04' })).toContain('has no token price');
      expect(refused('brand-new', { image: '0.04' })).toContain('has no token price');
      expect(refused('brand-new', { image: '0.04' })).toContain(
        'Set Input price and Output price as well.',
      );
      expect(rowsFor('brand-new')).toHaveLength(0);
    });
  });
});

describe('the shell prints what prepare and commit decided, byte for byte', () => {
  const invocations: ReadonlyArray<readonly [string, string, CommandInput['options']]> = [
    ['a token pair', 'acme-custom-1', { input: '3', output: '9' }],
    [
      'every field',
      'acme-custom-1',
      { input: '3', output: '9', cached: '1', image: '0.04', audio: '0.001', video: '0.5' },
    ],
    ['a media price on a catalog model', 'gpt-5.5', { image: '0.04' }],
    ['an override of a catalog price', 'gpt-5.5', { input: '3', output: '9' }],
    ['a clear of an override', 'gpt-5.5', { clear: true }],
  ];

  it.each(
    invocations.flatMap(([name, model, options]) => [
      [name, model, options, false] as const,
      [name, model, options, true] as const,
    ]),
  )('%s (%s %j, json: %s)', (_name, model, options, json) => {
    // The first database: the command as the shell runs it.
    const viaCommand = captureIo();
    const seed = (): void => {
      if (options['clear'] === true)
        modelsPricingCommand(
          { model, provider: 'openai', inputUsdPerMtok: 1, outputUsdPerMtok: 2 },
          { io: captureIo().io, global: global(), catalog, providers },
        );
    };
    seed();
    const args = buildModelsPricingArgs({
      positionals: [model],
      options: { provider: 'openai', ...options },
    });
    const code = modelsPricingCommand(args, {
      io: viaCommand.io,
      global: global(json),
      catalog,
      providers,
    });

    // The second database: the same two steps, called one after the other, with the shell's own printing after them.
    client.sqlite.exec('DELETE FROM model_catalog');
    seed();
    const viaSteps = captureIo();
    const seeded = catalog.listAll().length;
    const plan = preparePricing(args, { catalog, providers });
    expect(catalog.listAll(), 'prepare itself wrote nothing').toHaveLength(seeded);
    const outcome = commitPricing(plan, { catalog, providers });
    const stepsCode = writePricingResult(plan, outcome, { io: viaSteps.io, global: global(json) });

    expect(viaSteps.out()).toBe(viaCommand.out());
    expect(viaSteps.err()).toBe(viaCommand.err());
    expect(stepsCode).toBe(code);
    expect(viaCommand.out().length).toBeGreaterThan(0);
  });

  it('prepare alone writes nothing, for a SET and for a CLEAR', () => {
    const set = preparePricing(
      { model: 'acme-custom-1', provider: 'openai', inputUsdPerMtok: 3, outputUsdPerMtok: 9 },
      { catalog, providers },
    );
    expect(set.kind).toBe('set');
    expect(catalog.listAll()).toHaveLength(0);
    commitPricing(set, { catalog, providers });
    const clear = preparePricing(
      { model: 'acme-custom-1', provider: 'openai', clear: true },
      { catalog, providers },
    );
    expect(clear).toMatchObject({ kind: 'clear', hasOverride: true });
    expect(catalog.listAll(), 'preparing a clear removes nothing').toHaveLength(1);
  });
});

describe('--clear', () => {
  it("removes the operator's override and says what the model falls back to", () => {
    prepared('gpt-5.5', { input: '3', output: '9' }).commit();
    expect(rowsFor('gpt-5.5')).toHaveLength(1);
    const result = port.prepare(OPENAI('gpt-5.5'), { action: 'clear' });
    if (!result.ok) throw new Error(result.reason);
    expect(result.offer).toMatchObject({
      kind: 'clear',
      model: 'gpt-5.5',
      prices: [],
      fallback: 'input $5/Mtok, output $30/Mtok',
    });
    expect(rowsFor('gpt-5.5'), 'the card asked; nothing is removed yet').toHaveLength(1);
    expect(result.commit()).toEqual({
      ok: true,
      written:
        'Cleared the user price for gpt-5.5 (OpenAI). It falls back to the catalog: input $5/Mtok, output $30/Mtok.',
    });
    expect(rowsFor('gpt-5.5')).toHaveLength(0);
  });

  it('says so when the catalog does not price the model: its cost cap will not apply', () => {
    prepared('acme-custom-1', { input: '3', output: '9' }).commit();
    const result = port.prepare(OPENAI('acme-custom-1'), { action: 'clear' });
    if (!result.ok) throw new Error(result.reason);
    expect(result.offer.fallback).toBeUndefined();
    const attempt = result.commit();
    expect(attempt.ok).toBe(true);
    expect(attempt.ok ? attempt.written : '').toContain('The catalog does not price this model');
  });

  it('a model with no override says so, and asks for nothing', () => {
    const result = port.prepare(OPENAI('gpt-5.5'), { action: 'clear' });
    expect(result).toEqual({
      ok: false,
      reason: 'gpt-5.5 (OpenAI) has no user price to clear — nothing changed.',
    });
  });

  it('an override another process removed after the card opened is "nothing changed", not a fault', () => {
    prepared('gpt-5.5', { input: '3', output: '9' }).commit();
    const result = port.prepare(OPENAI('gpt-5.5'), { action: 'clear' });
    if (!result.ok) throw new Error(result.reason);
    catalog.clearUserPricing(
      'gpt-5.5',
      providers.list().find((p) => p.name === 'openai')?.id ?? '',
    );
    expect(result.commit()).toEqual({
      ok: true,
      written: 'gpt-5.5 (OpenAI) has no user price to clear — nothing changed.',
    });
  });

  it('refuses an unregistered provider, like the shell', () => {
    const result = port.prepare({ modelId: 'gpt-5.5', provider: 'anthropic' }, { action: 'clear' });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain("unknown provider 'anthropic'");
  });
});

describe('a write the database refuses is a fixed sentence', () => {
  it('a read-only database says so in words that quote nothing, and records nothing', () => {
    const result = prepared('acme-custom-1', { input: '3', output: '9' });
    client.sqlite.pragma('query_only = ON');
    const attempt = result.commit();
    client.sqlite.pragma('query_only = OFF');
    expect(attempt).toEqual({ ok: false, reason: PRICING_WRITE_FAULT });
    expect(PRICING_WRITE_FAULT).not.toMatch(/SQLITE|readonly|\//u);
    expect(rowsFor('acme-custom-1')).toHaveLength(0);
  });

  it('a clear the database refuses is the same sentence', () => {
    prepared('gpt-5.5', { input: '3', output: '9' }).commit();
    const result = port.prepare(OPENAI('gpt-5.5'), { action: 'clear' });
    if (!result.ok) throw new Error(result.reason);
    client.sqlite.pragma('query_only = ON');
    const attempt = result.commit();
    client.sqlite.pragma('query_only = OFF');
    expect(attempt).toEqual({ ok: false, reason: PRICING_WRITE_FAULT });
    expect(rowsFor('gpt-5.5'), 'the override is still there').toHaveLength(1);
  });

  it('a fault that is not the database refusing is a defect and is not dressed up as a sentence', () => {
    const result = prepared('acme-custom-1', { input: '3', output: '9' });
    client.sqlite.close();
    expect(() => result.commit()).toThrow();
    // The afterEach closes the handle again; closing twice is harmless.
  });
});

describe('the id on the card is the id that is stored', () => {
  it.each([
    ['an escape sequence', 'acme\u001b[31m-1'],
    ['a bidirectional override', `acme${String.fromCodePoint(0x202e)}-1`],
    ['a newline', 'acme\n-1'],
  ])('refuses a model id with %s before anything is asked', (_name, modelId) => {
    const reason = refused(modelId, { input: '3', output: '9' });
    expect(reason).toContain('cannot be shown safely');
    expect(catalog.listAll()).toHaveLength(0);
    const cleared = port.prepare({ modelId, provider: 'openai' }, { action: 'clear' });
    expect(cleared.ok).toBe(false);
    expect(cleared.ok ? '' : cleared.reason).toContain('cannot be shown safely');
  });

  /**
   * Characters the terminal does not draw (Unicode `Cf` and the default-ignorable code points), written as code points and never as
   * literal characters: a literal one is invisible in the very file that is meant to prove it is refused.
   */
  const INVISIBLE: ReadonlyArray<readonly [string, number]> = [
    ['a zero-width space (U+200B)', 0x200b],
    ['a zero-width non-joiner (U+200C)', 0x200c],
    ['a zero-width joiner (U+200D)', 0x200d],
    ['a word joiner (U+2060)', 0x2060],
    ['a byte-order mark (U+FEFF)', 0xfeff],
    ['a soft hyphen (U+00AD)', 0x00ad],
    ['a combining grapheme joiner (U+034F)', 0x034f],
    ['a variation selector (U+FE0F)', 0xfe0f],
    ['a tag character (U+E0041)', 0xe0041],
    ['a left-to-right mark (U+200E)', 0x200e],
    ['an invisible separator (U+2063)', 0x2063],
  ];

  it('the invisible characters are built from code points, not typed: the fixtures read back as what they say', () => {
    for (const [name, code] of INVISIBLE) {
      const decoy = `gpt-5${String.fromCodePoint(code)}`;
      expect(decoy.codePointAt(decoy.length - (code > 0xffff ? 2 : 1)), name).toBe(code);
      expect(decoy.length, name).toBe(5 + (code > 0xffff ? 2 : 1));
      expect(/^[\u0021-\u007e]+$/u.test(decoy), `${name} is not printable ASCII`).toBe(false);
    }
  });

  it.each(INVISIBLE)(
    'refuses a model id with %s, with a fixed sentence, and writes nothing — a decoy is never another row',
    (_name, code) => {
      const decoy = `gpt-5${String.fromCodePoint(code)}`;
      const inMiddle = `gpt${String.fromCodePoint(code)}-5`;
      for (const modelId of [decoy, inMiddle]) {
        const reason = refused(modelId, { input: '3', output: '9' });
        expect(reason).toBe(PRICING_MODEL_ID_FAULTS.invisible);
        expect(reason, 'the sentence quotes no id').not.toContain('gpt');
        const cleared = port.prepare({ modelId, provider: 'openai' }, { action: 'clear' });
        expect(cleared).toEqual({ ok: false, reason: PRICING_MODEL_ID_FAULTS.invisible });
      }
      expect(catalog.listAll(), 'nothing was written').toHaveLength(0);
    },
  );

  it('a catalog-listed id carrying one is refused the same way as one typed by hand', () => {
    const listed = `gpt-5.5${String.fromCodePoint(0x200b)}`;
    entries = [entry('gpt-5.5', { pricingSource: 'catalog' }), entry(listed)];
    const choices = port.models();
    expect(choices.map((choice) => choice.modelId)).toEqual(['gpt-5.5', listed]);
    // The person picks the decoy from the list: the target is the listed id as it is.
    const picked = choices[1];
    if (picked === undefined) throw new Error('the decoy is not offered');
    const result = port.prepare(
      { modelId: picked.modelId, provider: picked.provider },
      { action: 'set', prices: { input: '3', output: '9' } },
    );
    expect(result).toEqual({ ok: false, reason: PRICING_MODEL_ID_FAULTS.invisible });
    // The real id, which looks the same, is the one that can be priced.
    expect(
      port.prepare(
        { modelId: 'gpt-5.5', provider: 'openai' },
        { action: 'set', prices: { input: '3', output: '9' } },
      ).ok,
    ).toBe(true);
    expect(catalog.listAll()).toHaveLength(0);
  });

  it("refuses an id with a space at either end: inside the card's quotes it reads as the id without it", () => {
    for (const modelId of [' gpt-5', 'gpt-5 ', '\tgpt-5']) {
      expect(refused(modelId, { input: '3', output: '9' }), JSON.stringify(modelId)).toBe(
        PRICING_MODEL_ID_FAULTS.padded,
      );
    }
    expect(catalog.listAll()).toHaveLength(0);
  });

  it('shows an id in full or not at all: eighty columns are priced, the eighty-first is refused', () => {
    const at = 'm'.repeat(80);
    expect(
      port.prepare(
        { modelId: at, provider: 'openai' },
        { action: 'set', prices: { input: '3', output: '9' } },
      ).ok,
    ).toBe(true);
    const over = 'm'.repeat(81);
    expect(refused(over, { input: '3', output: '9' })).toBe(PRICING_MODEL_ID_FAULTS['too-long']);
    // Wide characters take two columns each: forty fit, forty-one do not.
    const wide = String.fromCodePoint(0x4e2d);
    expect(
      port.prepare(
        { modelId: wide.repeat(40), provider: 'openai' },
        { action: 'set', prices: { input: '3', output: '9' } },
      ).ok,
    ).toBe(true);
    expect(refused(wide.repeat(41), { input: '3', output: '9' })).toBe(
      PRICING_MODEL_ID_FAULTS['too-long'],
    );
    expect(PRICING_MODEL_ID_FAULTS['too-long']).toContain('80 columns');
  });

  it('enforces the 200-code-unit bound too: a string of combining marks is narrow and long', () => {
    // One column wide, three hundred code units long: only the length bound can refuse it.
    const narrow = `a${String.fromCodePoint(0x301).repeat(300)}`;
    expect(narrow).toHaveLength(301);
    expect(refused(narrow, { input: '3', output: '9' })).toBe(PRICING_MODEL_ID_FAULTS['too-long']);
    const edge = `a${String.fromCodePoint(0x301).repeat(199)}`;
    expect(edge).toHaveLength(200);
    expect(
      port.prepare(
        { modelId: edge, provider: 'openai' },
        { action: 'set', prices: { input: '3', output: '9' } },
      ).ok,
    ).toBe(true);
    expect(catalog.listAll()).toHaveLength(0);
  });
});

describe('the commit checks the one rule another process can break while the card is open', () => {
  /** The deepseek registry row's id, for a price a shell writes in the meantime. */
  const deepseekId = (): string => providers.list().find((p) => p.name === 'deepseek')?.id ?? '';

  it("a second provider's price for the same model, written between prepare and commit, makes the commit refuse and write nothing", () => {
    const result = prepared('acme-custom-1', { input: '3', output: '9' });
    // A `models pricing acme-custom-1 --provider deepseek` from another terminal, while the card is open.
    expect(shellRefusal('acme-custom-1', { input: '1', output: '2' }, 'deepseek')).toBeUndefined();
    expect(rowsFor('acme-custom-1')).toHaveLength(1);

    const attempt = result.commit();
    expect(attempt.ok).toBe(false);
    expect(attempt.ok ? '' : attempt.reason).toContain(
      "'acme-custom-1' is already user-priced under 'deepseek'",
    );
    const rows = rowsFor('acme-custom-1');
    expect(rows, 'the commit wrote nothing').toHaveLength(1);
    expect(rows[0]?.providerId).toBe(deepseekId());
    expect(rows[0]?.inputCostPerMtokMicrocents, 'the other price is untouched').toBe(100_000_000);
  });

  it("the refusal is the shell's own sentence, byte for byte", () => {
    const result = prepared('acme-custom-1', { input: '3', output: '9' });
    shellRefusal('acme-custom-1', { input: '1', output: '2' }, 'deepseek');
    const attempt = result.commit();
    const shell = shellRefusal('acme-custom-1', { input: '3', output: '9' });
    expect(shell).toContain('is already user-priced under');
    expect(attempt).toEqual({ ok: false, reason: shell });
  });

  it('commitPricing itself throws the typed refusal, and a plain commit with no conflict still writes', () => {
    const plan = preparePricing(
      { model: 'acme-custom-1', provider: 'openai', inputUsdPerMtok: 3, outputUsdPerMtok: 9 },
      { catalog, providers },
    );
    shellRefusal('acme-custom-1', { input: '1', output: '2' }, 'deepseek');
    let refusal: unknown;
    try {
      commitPricing(plan, { catalog, providers });
    } catch (cause) {
      refusal = cause;
    }
    expect(isCliError(refusal)).toBe(true);
    expect(isCliError(refusal) ? refusal.code : '').toBe('invalid_invocation');
    expect(rowsFor('acme-custom-1')).toHaveLength(1);

    const fine = preparePricing(
      { model: 'other-model', provider: 'openai', inputUsdPerMtok: 3, outputUsdPerMtok: 9 },
      { catalog, providers },
    );
    expect(commitPricing(fine, { catalog, providers })).toEqual({ kind: 'set' });
    expect(rowsFor('other-model')).toHaveLength(1);
  });

  it('a CLEAR is not blocked by a price under another provider: it removes only its own', () => {
    prepared('gpt-5.5', { input: '3', output: '9' }).commit();
    const result = port.prepare(OPENAI('gpt-5.5'), { action: 'clear' });
    if (!result.ok) throw new Error(result.reason);
    expect(result.commit().ok).toBe(true);
    expect(rowsFor('gpt-5.5')).toHaveLength(0);
  });

  it("the port opens the IMMEDIATE transaction around the re-check and the store's own write", () => {
    // The store opens a transaction of its own around its write. The port opens one more, IMMEDIATE, around the re-check and that
    // call: two transactions are opened for one commit, the outermost IMMEDIATE. Without the port's, there is one.
    const spy = vi.spyOn(client.db, 'transaction');
    const result = prepared('acme-custom-1', { input: '3', output: '9' });
    expect(spy).not.toHaveBeenCalled();
    result.commit();
    const configs = spy.mock.calls.map((call) => call[1]);
    spy.mockRestore();
    expect(configs, "the port's transaction, then the store's inside it").toHaveLength(2);
    expect(configs[0]).toEqual({ behavior: 'immediate' });
  });

  describe('nothing can write between the re-check and the write (two connections to one file)', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'relavium-pricing-commit-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('a second connection cannot write while the commit holds its transaction, so the re-checked state is the written state', () => {
      const file = join(dir, 'history.db');
      const a = createClient(file);
      runMigrations(a.db);
      const b = createClient(file);
      b.sqlite.pragma('busy_timeout = 0');
      try {
        let n = 0;
        const storeDeps = {
          uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
          now: () => 1_700_000_000_000,
        };
        const aProviders = createProviderStore(a.db, storeDeps);
        aProviders.upsert({
          name: 'openai',
          displayName: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
        });
        const aCatalog = createModelCatalogStore(a.db, storeDeps);
        const plan = preparePricing(
          { model: 'acme-custom-1', provider: 'openai', inputUsdPerMtok: 3, outputUsdPerMtok: 9 },
          { catalog: aCatalog, providers: aProviders },
        );
        // The re-check's own read is where "another process" tries to get in: right after the state was read, before the write.
        let blocked: string | undefined;
        const spied = {
          ...aCatalog,
          listAll: () => {
            const rows = aCatalog.listAll();
            try {
              b.sqlite.exec('CREATE TABLE probe_from_b (x INTEGER)');
            } catch (cause) {
              blocked = cause instanceof Error ? cause.message : String(cause);
            }
            return rows;
          },
        };
        commitPricing(plan, {
          catalog: spied,
          providers: aProviders,
          atomically: (work) => a.db.transaction(work, { behavior: 'immediate' }),
        });
        expect(
          blocked,
          'a write from the other connection was refused while the commit held its transaction',
        ).toMatch(/locked|busy/iu);
        expect(aCatalog.listAll()).toHaveLength(1);
      } finally {
        a.sqlite.close();
        b.sqlite.close();
      }
    });
  });
});

describe('the lists the form offers', () => {
  it("offers the picker's models with where each one's price comes from, and the registered providers", () => {
    entries = [
      entry('gpt-5.5', { pricingSource: 'catalog', priceKnown: true }),
      entry('acme-custom-1', { pricingSource: 'user', priceKnown: true }),
      entry('mystery', { provider: 'deepseek' }),
    ];
    expect(port.models()).toEqual([
      { modelId: 'gpt-5.5', provider: 'openai', hint: 'OpenAI · catalog price' },
      { modelId: 'acme-custom-1', provider: 'openai', hint: 'OpenAI · your price' },
      { modelId: 'mystery', provider: 'deepseek', hint: 'DeepSeek · no price' },
    ]);
    expect([...port.providers()].sort()).toEqual(['deepseek', 'openai']);
  });

  it('reads the catalog when asked, not when the port is made', () => {
    entries = [];
    expect(port.models()).toEqual([]);
    entries = [entry('late')];
    expect(port.models().map((choice) => choice.modelId)).toEqual(['late']);
  });
});

describe('the catalog the form reads is the database-backed one, as the shell reads it', () => {
  afterEach(() => {
    clearCatalogRefresh(); // the overlay is process-wide: a leaked install would price the next test's models
  });

  const TAIL: CatalogModel = {
    modelId: 'tail-xyz-9',
    provider: 'anthropic',
    displayName: 'tail',
    contextWindowTokens: 100_000,
    maxOutputTokens: 10_000,
    inputPerMtokMicrocents: 100_000_000,
    outputPerMtokMicrocents: 200_000_000,
  };

  function refreshOnlyInTheDatabase(): void {
    clearCatalogRefresh();
    providers.upsert({
      name: 'anthropic',
      displayName: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
    });
    persistCatalogToDb(
      createModelMetadataStore(client.db, { now: () => 1_700_000_000_000 }),
      { [TAIL.modelId]: TAIL },
      1_700_000_000_000,
    );
    // A fresh process whose file cache has not heard of the model: only the database has.
    expect(catalogModel(TAIL.modelId)).toBeUndefined();
  }

  it('refuses a price under a provider the catalog anchors a refresh-only model away from', () => {
    refreshOnlyInTheDatabase();
    expect(refused(TAIL.modelId, { input: '1', output: '2' }, 'openai')).toContain(
      "anthropic's model, not openai's",
    );
    expect(rowsFor(TAIL.modelId)).toHaveLength(0);
  });

  it('prices a refresh-only model for tokens, so a media price stands alone on it', () => {
    refreshOnlyInTheDatabase();
    expect(prepared(TAIL.modelId, { image: '0.04' }, 'anthropic').offer.prices).toHaveLength(1);
  });

  it('a database that cannot be read for the catalog is not a reason to refuse a price: the snapshot still answers', () => {
    clearCatalogRefresh();
    client.sqlite.exec('DROP TABLE model_metadata');
    const result = prepared('gpt-5.5', { input: '3', output: '9' });
    expect(result.offer.replaces).toBe('input $5/Mtok, output $30/Mtok');
  });

  it('reads nothing when the database has no refreshed model, and leaves the snapshot answering', () => {
    clearCatalogRefresh();
    expect(prepared('gpt-5.5', { input: '3', output: '9' }).offer.replaces).toBe(
      'input $5/Mtok, output $30/Mtok',
    );
  });
});
