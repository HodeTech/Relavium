import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  runMigrations,
  type DbClient,
  type ModelCatalogStore,
  type ProviderStore,
} from '@relavium/db';
import { priceModel } from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCliError } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo, parseNdjson } from '../test-support.js';
import { modelsPricingCommand, type ModelsPricingCommandArgs } from './models-pricing.js';

/**
 * `relavium models pricing` command-core tests (2.5.G S10, ADR-0065 §1/§2). A REAL `:memory:` db + the real
 * catalog/provider stores (the write + read-back is the point), no keychain/network. Covers the USD→micro-cents
 * conversion, the canonical-id + unknown-provider + bad-price rejects, `--json`, and the re-price preservation.
 */

function globalOptions(json = false): GlobalOptions {
  return { json, color: false, cwd: process.cwd(), configPath: undefined, verbosity: 'normal' };
}

describe('modelsPricingCommand (2.5.G S10)', () => {
  let client: DbClient;
  let catalog: ModelCatalogStore;
  let providers: ProviderStore;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    let n = 0;
    const deps = {
      uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
      now: () => 1_700_000_000_000,
    };
    providers = createProviderStore(client.db, deps);
    providers.upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    });
    catalog = createModelCatalogStore(client.db, deps);
  });

  afterEach(() => {
    client.sqlite.close();
  });

  function run(
    args: ModelsPricingCommandArgs,
    json = false,
  ): { code: number; out: string; err: string } {
    const { io, out, err } = captureIo();
    const code = modelsPricingCommand(args, {
      io,
      global: globalOptions(json),
      catalog,
      providers,
    });
    return { code, out: out(), err: err() };
  }

  const baseArgs = {
    model: 'acme-custom-1',
    provider: 'openai',
    inputUsdPerMtok: 3,
    outputUsdPerMtok: 9,
  } satisfies ModelsPricingCommandArgs;

  it('captures a fresh user price as micro-cents (USD × 1e8), source=user (the cost-cap gap is closed)', () => {
    const { code, out } = run(baseArgs);
    expect(code).toBe(EXIT_CODES.success);
    const listing = catalog.listAll().find((m) => m.modelId === 'acme-custom-1');
    expect(listing?.source).toBe('user');
    expect(listing?.inputCostPerMtokMicrocents).toBe(300_000_000); // $3 × 1e8
    expect(listing?.outputCostPerMtokMicrocents).toBe(900_000_000); // $9 × 1e8
    expect(listing?.cachedInputCostPerMtokMicrocents).toBe(0); // no --cached ⇒ 0
    expect(out).toContain('acme-custom-1');
  });

  describe('media output rates (CR-55, ADR-0089 §4)', () => {
    it('stores each media rate per BILLED UNIT, and leaves an unstated one NULL', () => {
      const { code, out } = run({ ...baseArgs, imageUsdPerCount: 0.04, videoUsdPerSecond: 0.5 });
      expect(code).toBe(EXIT_CODES.success);
      const listing = catalog.listAll().find((m) => m.modelId === 'acme-custom-1');
      expect(listing?.mediaImageCostMicrocents).toBe(4_000_000); // $0.04 × 1e8, per IMAGE (not per Mtok)
      expect(listing?.mediaVideoCostMicrocents).toBe(50_000_000); // $0.50 × 1e8, per SECOND
      // NULL, not 0 — the column's whole purpose is to hold "nobody said" distinctly from "free".
      expect(listing?.mediaAudioCostMicrocents).toBeNull();
      // Echoed in the billed unit; "$0.04/Mtok" would read as a price a million times off.
      expect(out).toContain('image $0.04/image');
      expect(out).toContain('video $0.5/s');
    });

    it('writes a stated ZERO as 0, never as NULL', () => {
      run({ ...baseArgs, audioUsdPerSecond: 0 });
      const listing = catalog.listAll().find((m) => m.modelId === 'acme-custom-1');
      expect(listing?.mediaAudioCostMicrocents).toBe(0);
    });

    it('a re-price that omits the media flags PRESERVES the stored rates', () => {
      // The `--cached` omission rule, applied to media: re-pricing tokens must not silently drop a media rate
      // the user hand-entered earlier. Without this, `models pricing … --input 4 --output 12` would quietly
      // return the model to unpriced-for-media and (under strict) start refusing generations again.
      run({ ...baseArgs, imageUsdPerCount: 0.04 });
      run({ ...baseArgs, inputUsdPerMtok: 4, outputUsdPerMtok: 12 });
      const listing = catalog.listAll().find((m) => m.modelId === 'acme-custom-1');
      expect(listing?.inputCostPerMtokMicrocents).toBe(400_000_000);
      expect(listing?.mediaImageCostMicrocents).toBe(4_000_000);
    });

    it('renders every combination of optional price parts as one clean list', () => {
      // Each part is independently optional now that media-only and cache-only invocations are legal, so no
      // part may carry its own separator or assume another precedes it. Stitching them with ad-hoc separators
      // produced `): , cached $0.5/Mtokimage $0.04/image` for `--cached` + `--image` — a stray comma and two
      // clauses run together. Every earlier test spread `baseArgs`, which always carries token rates, so the
      // one shape that breaks the stitching was the one shape nothing exercised.
      // A CATALOG-PRICED model, deliberately: a media-only invocation on a model nothing prices for tokens is
      // now refused at write time, because the row it would create carries no usable token price and the media
      // rate would never be applied. `gpt-4` is anchored to `openai`, the provider this suite registers.
      const cachedPlusMedia = run({
        model: 'gpt-4',
        provider: 'openai',
        cachedInputUsdPerMtok: 0.5,
        imageUsdPerCount: 0.04,
      });
      expect(cachedPlusMedia.out).toContain('(openai): cached $0.5/Mtok, image $0.04/image.');
      expect(cachedPlusMedia.out).not.toContain('): ,'); // no leading separator
      expect(cachedPlusMedia.out).not.toContain('Mtokimage'); // no run-together clauses

      const mediaOnly = run({ model: 'gpt-4', provider: 'openai', videoUsdPerSecond: 0.5 });
      expect(mediaOnly.out).toContain('(openai): video $0.5/s.');
      expect(mediaOnly.out).not.toContain('input $');

      const everything = run({ ...baseArgs, cachedInputUsdPerMtok: 1, audioUsdPerSecond: 0.001 });
      expect(everything.out).toContain(
        '(openai): input $3/Mtok, output $9/Mtok, cached $1/Mtok, audio $0.001/s.',
      );
    });

    it('a media-only write does NOT claim the token rates — it records that they were never stated', () => {
      // THE defect this flag exists for. `input_/output_cost_per_mtok_microcents` are `NOT NULL DEFAULT 0`, so a
      // media-only write lands `0`/`0` — and a `source='user'` row OUTRANKS the catalog. Without the flag,
      // following the strict-cap refusal's own instruction ("add an image rate") billed every token on that
      // model at nothing, permanently and silently: `CR-55`'s defect, reintroduced by its own remedy, on the
      // axis that carries most of the spend.
      run({ model: 'gpt-4', provider: 'openai', imageUsdPerCount: 0.04 });
      const listing = catalog.listAll().find((m) => m.modelId === 'gpt-4');
      expect(listing?.mediaImageCostMicrocents).toBe(4_000_000);
      expect(listing?.tokenRatesStated).toBe(false); // …so a reader inherits the catalog's token rates
    });

    it('a token write DOES claim them, and a later media-only re-price preserves that claim', () => {
      run({ ...baseArgs, model: 'gpt-4' });
      expect(catalog.listAll().find((m) => m.modelId === 'gpt-4')?.tokenRatesStated).toBe(true);
      // The `--cached` omission rule, applied to the flag: a media-only re-price must not demote token rates the
      // user stated earlier, or their own numbers would silently revert to the catalog's.
      run({ model: 'gpt-4', provider: 'openai', audioUsdPerSecond: 0.001 });
      const listing = catalog.listAll().find((m) => m.modelId === 'gpt-4');
      expect(listing?.tokenRatesStated).toBe(true);
      expect(listing?.inputCostPerMtokMicrocents).toBe(300_000_000);
      expect(listing?.mediaAudioCostMicrocents).toBe(100_000);
    });

    it('refuses a media-only write on a model NOTHING prices for tokens', () => {
      // The row would carry no usable token price — the catalog has nothing to inherit and the `0` is a default —
      // so `buildUserPricing` drops it and the media rate is unreachable. Refusing at write time is the
      // difference between a clear exit 2 and a strict cap that keeps refusing after the user did what it asked.
      expect(() =>
        run({ model: 'acme-custom-1', provider: 'openai', imageUsdPerCount: 0.04 }),
      ).toThrow(/has no token price/);
      expect(catalog.listAll().find((m) => m.modelId === 'acme-custom-1')).toBeUndefined();
    });

    it('refuses an implausible per-unit price before writing anything', () => {
      expect(() => run({ ...baseArgs, imageUsdPerCount: 5_000 })).toThrow(/implausibly large/);
      expect(catalog.listAll().find((m) => m.modelId === 'acme-custom-1')).toBeUndefined();
    });
  });

  it('rounds a fractional USD price correctly ($0.15/Mtok → 15_000_000µ¢)', () => {
    run({ ...baseArgs, inputUsdPerMtok: 0.15, outputUsdPerMtok: 0.6 });
    const listing = catalog.listAll().find((m) => m.modelId === 'acme-custom-1');
    expect(listing?.inputCostPerMtokMicrocents).toBe(15_000_000);
    expect(listing?.outputCostPerMtokMicrocents).toBe(60_000_000);
  });

  it('stores an explicit --cached price', () => {
    run({ ...baseArgs, cachedInputUsdPerMtok: 0.03 });
    const listing = catalog.listAll().find((m) => m.modelId === 'acme-custom-1');
    expect(listing?.cachedInputCostPerMtokMicrocents).toBe(3_000_000); // $0.03 × 1e8
  });

  it('a re-price that OMITS --cached PRESERVES the previously-stored cached price (not zeroed)', () => {
    run({ ...baseArgs, cachedInputUsdPerMtok: 0.03 }); // first: set a cached price
    run({ ...baseArgs, inputUsdPerMtok: 5 }); // re-price WITHOUT --cached (change input only)
    const listing = catalog.listAll().find((m) => m.modelId === 'acme-custom-1');
    expect(listing?.cachedInputCostPerMtokMicrocents).toBe(3_000_000); // preserved — NOT overwritten with 0
    expect(listing?.inputCostPerMtokMicrocents).toBe(500_000_000); // the input re-price DID take ($5 × 1e8)
  });

  it('--json emits one key-free record with the stored micro-cents', () => {
    const { code, out } = run(baseArgs, true);
    expect(code).toBe(EXIT_CODES.success);
    const [rec] = parseNdjson(out);
    expect(rec).toEqual({
      model: 'acme-custom-1',
      provider: 'openai',
      source: 'user',
      inputCostPerMtokMicrocents: 300_000_000,
      outputCostPerMtokMicrocents: 900_000_000,
      // `cachedInputCostPerMtokMicrocents` is OMITTED — `--cached` was not given, and the store PRESERVES
      // the existing rate rather than writing a `0`. It used to be reported as `0`, which named a value the
      // database does not hold; a caller confirming its own write was told a number nobody set.
      // The catalog has never heard of `acme-custom-1` — the case the user tier was invented for. Nothing is
      // overridden, so there is nothing to declare.
      overriddenCatalogPrice: null,
    });
  });

  it('--json OMITS overriddenCatalogPrice on a media-only re-price — it overrides no token price', () => {
    // A media-only invocation replaces nothing in the catalog's token pricing, so declaring what it
    // "overrides" claims a divergence that did not happen — the opposite of what the field is for.
    const { code, out } = run(
      // A model the CATALOG prices, so a media-only re-price is legal — and the field is still omitted,
      // because this invocation overrode no token price.
      { model: 'gpt-5.5', provider: 'openai', imageUsdPerCount: 0.04 },
      true,
    );
    expect(code).toBe(EXIT_CODES.success);
    const [rec] = parseNdjson(out);
    expect(rec).not.toHaveProperty('overriddenCatalogPrice');
    expect(rec).not.toHaveProperty('cachedInputCostPerMtokMicrocents');
    expect(rec).toMatchObject({ mediaImageCostMicrocents: 4_000_000 });
  });

  it('--json DECLARES the catalog price an override replaces (ADR-0071 §5)', () => {
    // The flip removed the guarantee that a user cannot misprice a shipped model. The condition on which it was
    // removed is that the divergence is LOUD — for a machine consumer as much as for a human. Without this, a
    // `--json` caller cannot tell a price that fills a gap from one that overrules a number we shipped.
    const { code, out } = run({ ...baseArgs, model: 'gpt-5.5' }, true);
    expect(code).toBe(EXIT_CODES.success);
    const [rec] = parseNdjson(out);
    const overridden = (rec as { overriddenCatalogPrice: { inputCostPerMtokMicrocents: number } })
      .overriddenCatalogPrice;
    expect(overridden).not.toBeNull();
    expect(overridden.inputCostPerMtokMicrocents).toBeGreaterThan(0);
  });

  it('REFUSES a price under a provider the CATALOG anchors elsewhere — never stored-then-ignored', () => {
    // The catalog anchors a model id to ONE provider. Both the merge and the cost overlay drop a user row that
    // contradicts it, so writing one would store a price that silently never applies — the user believes they set
    // it, and nothing reads it. Worse: before this guard the two DISAGREED — the merge dropped the row while
    // `priceModel` billed it, so the picker kept showing the catalog price while the CostTracker charged the user's.
    // `claude-opus-4-8` is Anthropic's; `openai` is the provider registered in this db. The FK guard passes (openai
    // exists) and the CATALOG guard is the one that must catch it.
    const err = runThrows({ ...baseArgs, model: 'claude-opus-4-8', provider: 'openai' });
    expect(err.code).toBe('invalid_invocation');
    expect(err.message).toContain("anthropic's model");
    expect(catalog.listAll().find((m) => m.modelId === 'claude-opus-4-8')).toBeUndefined();
  });

  it('ACCEPTS a price for a model the CATALOG already knows — the override is the feature now', () => {
    // This test asserted a REJECTION until ADR-0071 §1: the shipped table always won, so a user override would have
    // been a silent no-op, and refusing it was the honest thing. Pricing resolves USER → CATALOG now, so a
    // negotiated rate — or an enterprise discount, or a price our snapshot has not caught up with — takes effect.
    // The user is the one holding the invoice.
    expect(priceModel('gpt-5.5').inputPerMtokMicrocents).toBeGreaterThan(0); // the catalog does know it
    expect(run({ ...baseArgs, model: 'gpt-5.5' }).code).toBe(0);
    const written = catalog.listAll().find((m) => m.modelId === 'gpt-5.5');
    expect(written).toBeDefined();
    expect(written?.source).toBe('user');
  });

  it('REJECTS an unregistered provider (the catalog FK targets llm_providers) — nothing is written', () => {
    const err = runThrows({ ...baseArgs, provider: 'anthropic' }); // not registered in this db
    expect(err.code).toBe('invalid_invocation');
    expect(err.message).toContain('unknown provider');
    expect(catalog.listAll()).toHaveLength(0);
  });

  it('REJECTS a negative price', () => {
    const err = runThrows({ ...baseArgs, inputUsdPerMtok: -1 });
    expect(err.code).toBe('invalid_invocation');
    expect(catalog.listAll()).toHaveLength(0);
  });

  it('REJECTS a non-finite price', () => {
    const err = runThrows({ ...baseArgs, outputUsdPerMtok: Number.POSITIVE_INFINITY });
    expect(err.code).toBe('invalid_invocation');
    expect(catalog.listAll()).toHaveLength(0);
  });

  it('REJECTS an implausibly large price (typo guard)', () => {
    const err = runThrows({ ...baseArgs, inputUsdPerMtok: 1_000_000 });
    expect(err.code).toBe('invalid_invocation');
    expect(catalog.listAll()).toHaveLength(0);
  });

  it('a bad --cached rejects BEFORE the write (no partially-applied row)', () => {
    const err = runThrows({ ...baseArgs, cachedInputUsdPerMtok: -5 });
    expect(err.code).toBe('invalid_invocation');
    expect(catalog.listAll()).toHaveLength(0);
  });

  it('REJECTS pricing a model id already user-priced under a DIFFERENT provider (the overlay keys by id)', () => {
    // Register a second provider + price the SAME model id under it, then try to price it under openai.
    providers.upsert({
      name: 'deepseek',
      displayName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
    });
    const deepseekId = providers.list().find((p) => p.name === 'deepseek')?.id ?? '';
    catalog.upsert({
      providerId: deepseekId,
      modelId: 'shared-id',
      source: 'user',
      inputCostPerMtokMicrocents: 5,
      outputCostPerMtokMicrocents: 15,
    });
    const err = runThrows({ ...baseArgs, model: 'shared-id', provider: 'openai' });
    expect(err.code).toBe('invalid_invocation');
    expect(err.message).toContain('already user-priced');
    expect(err.message).toContain('deepseek'); // names the other provider
    // The openai row was NOT written — only the original deepseek user row remains for this id.
    const rows = catalog.listAll().filter((m) => m.modelId === 'shared-id');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerId).toBe(deepseekId);
  });

  it('ALLOWS re-pricing the SAME (provider, model) — an update, not a cross-provider duplicate', () => {
    run(baseArgs); // openai / acme-custom-1
    // Re-price the same pair — the dup guard must NOT trip (same provider), it is a plain update.
    run({ ...baseArgs, inputUsdPerMtok: 4, outputUsdPerMtok: 12 });
    const rows = catalog.listAll().filter((m) => m.modelId === 'acme-custom-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputCostPerMtokMicrocents).toBe(400_000_000);
  });

  it('re-pricing an existing model preserves its display name + limits (only prices change)', () => {
    const providerId = providers.list()[0]?.id ?? '';
    // Seed a richer existing row (as a live discovery would) with a display name + context.
    catalog.upsert({
      providerId,
      modelId: 'acme-custom-1',
      displayName: 'Acme Custom (discovered)',
      contextWindowTokens: 32_000,
      maxOutputTokens: 4_000,
      source: 'live',
    });
    run({ ...baseArgs, inputUsdPerMtok: 1, outputUsdPerMtok: 2 });
    const listing = catalog.listAll().find((m) => m.modelId === 'acme-custom-1');
    expect(listing?.displayName).toBe('Acme Custom (discovered)'); // preserved
    expect(listing?.contextWindowTokens).toBe(32_000); // preserved
    expect(listing?.maxOutputTokens).toBe(4_000); // preserved
    expect(listing?.inputCostPerMtokMicrocents).toBe(100_000_000); // $1
    expect(listing?.source).toBe('user'); // now a user price
  });

  /** Invoke and assert the command threw a CliError, returning its narrowed shape (no `as`). */
  function runThrows(args: ModelsPricingCommandArgs): { code: string; message: string } {
    const { io } = captureIo();
    try {
      modelsPricingCommand(args, { io, global: globalOptions(), catalog, providers });
    } catch (err) {
      if (isCliError(err)) return { code: err.code, message: err.message };
      throw err;
    }
    throw new Error('expected modelsPricingCommand to throw a CliError');
  }

  it('--clear RETIRES an override — the only way back from a price the user regrets', () => {
    // Before `--clear`, a mispriced model could be corrected but never UN-priced: a user who overrode a catalog model
    // by mistake was stuck with their own number for good. The fix commit's own message told them to run this command
    // — and it did not exist.
    expect(run({ ...baseArgs, model: 'gpt-5.5' }).code).toBe(EXIT_CODES.success);
    expect(catalog.listAll().find((m) => m.modelId === 'gpt-5.5')).toBeDefined();

    const { code, out } = run({ model: 'gpt-5.5', provider: 'openai', clear: true });
    expect(code).toBe(EXIT_CODES.success);
    expect(out).toContain('falls back to the catalog');
    // SOFT-deactivated, never deleted (`model_catalog.id` is an FK target from five tables), so the active-only
    // reader stops seeing it and the model falls back to the catalog's price.
    expect(catalog.listAll().find((m) => m.modelId === 'gpt-5.5')).toBeUndefined();
  });

  it('--clear on a model with no user price is an honest no-op, never a lie', () => {
    const { code, out } = run({ model: 'gpt-5.5', provider: 'openai', clear: true });
    expect(code).toBe(EXIT_CODES.success);
    expect(out).toContain('no user price to clear');
  });

  it('--clear --json reports `source` from the CATALOG price, matching the human line (bot fix)', () => {
    // A cleared model the catalog PRICES falls back to it → source 'catalog'.
    run({ ...baseArgs, model: 'gpt-5.5' }); // set a user price first
    const catalogClear = run({ model: 'gpt-5.5', provider: 'openai', clear: true }, true);
    expect(JSON.parse(catalogClear.out.trim())).toMatchObject({
      model: 'gpt-5.5',
      cleared: true,
      source: 'catalog',
    });

    // A cleared model the catalog does NOT price → source null (unpriced; `cleared ? 'catalog'` used to LIE here).
    run({ ...baseArgs, model: 'acme-custom-1' }); // a user price on a non-catalog id
    const nullClear = run({ model: 'acme-custom-1', provider: 'openai', clear: true }, true);
    expect(JSON.parse(nullClear.out.trim())).toMatchObject({
      model: 'acme-custom-1',
      cleared: true,
      source: null,
    });
  });
});
