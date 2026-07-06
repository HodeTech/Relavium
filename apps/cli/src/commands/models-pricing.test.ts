import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  runMigrations,
  type DbClient,
  type ModelCatalogStore,
  type ProviderStore,
} from '@relavium/db';
import { KNOWN_MODEL_IDS } from '@relavium/llm';
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
    providers.upsert({ name: 'openai', displayName: 'OpenAI', baseUrl: 'https://api.openai.com/v1' });
    catalog = createModelCatalogStore(client.db, deps);
  });

  afterEach(() => {
    client.sqlite.close();
  });

  function run(args: ModelsPricingCommandArgs, json = false): { code: number; out: string; err: string } {
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
      cachedInputCostPerMtokMicrocents: 0,
    });
  });

  it('REJECTS a canonical model id (the built-in price always wins) — nothing is written', () => {
    const canonical = KNOWN_MODEL_IDS[0];
    if (canonical === undefined) throw new Error('test precondition: KNOWN_MODEL_IDS is non-empty');
    const err = runThrows({ ...baseArgs, model: canonical });
    expect(err.code).toBe('invalid_invocation');
    expect(err.message).toContain('built-in price');
    expect(catalog.listAll().find((m) => m.modelId === canonical)).toBeUndefined();
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
    providers.upsert({ name: 'deepseek', displayName: 'DeepSeek', baseUrl: 'https://api.deepseek.com' });
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
});
