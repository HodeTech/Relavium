/**
 * Byte-identity characterization of `relavium models pricing`
 * ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §9,
 * [ADR-0122](../../../../docs/decisions/0122-the-home-is-the-interactive-product.md) §2).
 *
 * Every case drives the command through its real argv path (`buildModelsPricingArgs`, then `modelsPricingCommand` over a real
 * `:memory:` database and the real catalog and provider stores) and pins the exact stdout, the exact stderr, the exit code or the
 * typed refusal (code, message, exit code) and the rows the database holds afterwards. It was written against the code BEFORE the
 * command was split into `preparePricing` and `commitPricing` and before its flags moved into one field table, and its expected
 * values were not edited by that change: a difference here is a change of the shell's behaviour.
 *
 * The expected values live in `models-pricing-characterization.expected.json`, beside this file. They were produced once, by running the
 * unmodified command, and are never regenerated to make a refactor pass. Nothing in this file can write them: a run only reads and
 * compares, and a change to the expectations is a hand edit that a reviewer reads as a change of the shell's behaviour. (A run used to
 * skip every assertion and write the observations to a path named by an environment variable; a test run that can rewrite its own
 * oracle, or pass without comparing, is not an oracle.)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  runMigrations,
  type DbClient,
  type ModelCatalogStore,
  type ProviderStore,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCliError, toUserFacing } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { buildModelsPricingArgs, type CommandInput } from './dispatch.js';
import { modelsPricingCommand } from './models-pricing.js';

type Options = CommandInput['options'];

interface Invocation {
  readonly positionals: readonly string[];
  readonly options: Options;
  readonly json?: boolean;
}

interface Case {
  readonly name: string;
  /** Invocations run first, in order, against the same database; only the LAST one is observed. */
  readonly before?: readonly Invocation[];
  readonly run: Invocation;
}

interface Observed {
  readonly exit: number;
  readonly refusal: { readonly code: string; readonly message: string } | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly rows: readonly Record<string, unknown>[];
}

const OPENAI = { provider: 'openai' } as const;
const TOKENS = { input: '3', output: '9' } as const;
const inv = (positionals: readonly string[], options: Options, json = false): Invocation => ({
  positionals,
  options,
  json,
});
const model = (id: string, options: Options, json = false): Invocation =>
  inv([id], { ...OPENAI, ...options }, json);

const CASES: readonly Case[] = [
  // ── a price is set ────────────────────────────────────────────────────────────────────────────────────────────────────────
  { name: 'set input and output', run: model('acme-custom-1', TOKENS) },
  { name: 'set input and output --json', run: model('acme-custom-1', TOKENS, true) },
  { name: 'set a fractional price', run: model('acme-custom-1', { input: '0.15', output: '0.6' }) },
  { name: 'set a zero price', run: model('acme-custom-1', { input: '0', output: '0' }) },
  {
    name: 'set cached input with the pair',
    run: model('acme-custom-1', { ...TOKENS, cached: '0.03' }),
  },
  { name: 'set cached input alone', run: model('gpt-5-pro', { cached: '0.5' }) },
  { name: 'set cached input alone --json', run: model('gpt-5-pro', { cached: '0.5' }, true) },
  { name: 'set cached input to zero', run: model('gpt-5-pro', { cached: '0' }) },
  { name: 'set an image price', run: model('gpt-5-pro', { image: '0.04' }) },
  { name: 'set an image price --json', run: model('gpt-5-pro', { image: '0.04' }, true) },
  { name: 'set an audio price', run: model('gpt-5-pro', { audio: '0.001' }) },
  { name: 'set a video price', run: model('gpt-5-pro', { video: '0.5' }) },
  { name: 'set a zero media price', run: model('gpt-5-pro', { audio: '0' }) },
  {
    name: 'set cached input and an image price',
    run: model('gpt-5-pro', { cached: '0.5', image: '0.04' }),
  },
  {
    name: 'set every field',
    run: model('acme-custom-1', {
      ...TOKENS,
      cached: '1',
      image: '0.04',
      audio: '0.001',
      video: '0.5',
    }),
  },
  {
    name: 'set every field --json',
    run: model(
      'acme-custom-1',
      { ...TOKENS, cached: '1', image: '0.04', audio: '0.001', video: '0.5' },
      true,
    ),
  },
  { name: 'override a catalog price', run: model('gpt-5.5', TOKENS) },
  { name: 'override a catalog price --json', run: model('gpt-5.5', TOKENS, true) },
  {
    name: 'a media-only price on a catalog model overrides no token price --json',
    run: model('gpt-5.5', { image: '0.04' }, true),
  },
  {
    name: 're-price keeps the stored cached and media rates',
    before: [model('acme-custom-1', { ...TOKENS, cached: '0.03', image: '0.04' })],
    run: model('acme-custom-1', { input: '4', output: '12' }),
  },
  {
    name: 'a media-only re-price keeps the stated token rates',
    before: [model('gpt-5-pro', TOKENS)],
    run: model('gpt-5-pro', { audio: '0.001' }),
  },
  {
    name: 're-price keeps a discovered display name and limits',
    before: [model('acme-custom-1', TOKENS)],
    run: model('acme-custom-1', { input: '1', output: '2' }),
  },
  // The ceilings accept their own value.
  {
    name: 'the token ceiling is accepted',
    run: model('acme-custom-1', { input: '100000', output: '100000' }),
  },
  { name: 'the cached ceiling is accepted', run: model('gpt-5-pro', { cached: '100000' }) },
  {
    name: 'the media ceiling is accepted',
    run: model('gpt-5-pro', { image: '1000', audio: '1000', video: '1000' }),
  },

  // ── a price is cleared ────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: 'clear an override of a catalog model',
    before: [model('gpt-5.5', TOKENS)],
    run: model('gpt-5.5', { clear: true }),
  },
  {
    name: 'clear an override of a catalog model --json',
    before: [model('gpt-5.5', TOKENS)],
    run: model('gpt-5.5', { clear: true }, true),
  },
  {
    name: 'clear an override of a model the catalog does not price',
    before: [model('acme-custom-1', TOKENS)],
    run: model('acme-custom-1', { clear: true }),
  },
  {
    name: 'clear an override of a model the catalog does not price --json',
    before: [model('acme-custom-1', TOKENS)],
    run: model('acme-custom-1', { clear: true }, true),
  },
  { name: 'clear a model with no override', run: model('gpt-5.5', { clear: true }) },
  { name: 'clear a model with no override --json', run: model('gpt-5.5', { clear: true }, true) },
  {
    name: 'clear twice says nothing changed',
    before: [model('gpt-5.5', TOKENS), model('gpt-5.5', { clear: true })],
    run: model('gpt-5.5', { clear: true }),
  },
  {
    name: 'clear under an unregistered provider',
    run: inv(['gpt-5.5'], { provider: 'anthropic', clear: true }),
  },
  { name: 'clear with --input is refused', run: model('gpt-5.5', { clear: true, input: '3' }) },
  { name: 'clear with --output is refused', run: model('gpt-5.5', { clear: true, output: '9' }) },
  { name: 'clear with --cached is refused', run: model('gpt-5.5', { clear: true, cached: '1' }) },
  { name: 'clear with --image is refused', run: model('gpt-5.5', { clear: true, image: '0.04' }) },
  { name: 'clear with --audio is refused', run: model('gpt-5.5', { clear: true, audio: '0.04' }) },
  { name: 'clear with --video is refused', run: model('gpt-5.5', { clear: true, video: '0.04' }) },

  // ── the pairing rule: input and output are set together or not at all ────────────────────────────────────────────────────
  { name: 'input without output', run: model('acme-custom-1', { input: '3' }) },
  { name: 'output without input', run: model('acme-custom-1', { output: '9' }) },
  {
    name: 'input and an image without output',
    run: model('acme-custom-1', { input: '3', image: '0.04' }),
  },
  {
    name: 'output and a cached price without input',
    run: model('acme-custom-1', { output: '9', cached: '1' }),
  },
  { name: 'input without output --json', run: model('acme-custom-1', { input: '3' }, true) },
  { name: 'no price at all', run: model('acme-custom-1', {}) },

  // ── a price above its ceiling, below zero, or not a number ───────────────────────────────────────────────────────────────
  {
    name: 'input above its ceiling',
    run: model('acme-custom-1', { input: '100000.01', output: '1' }),
  },
  {
    name: 'output above its ceiling',
    run: model('acme-custom-1', { input: '1', output: '1000000' }),
  },
  { name: 'cached above its ceiling', run: model('gpt-5-pro', { cached: '100001' }) },
  { name: 'image above its ceiling', run: model('gpt-5-pro', { image: '1000.01' }) },
  { name: 'audio above its ceiling', run: model('gpt-5-pro', { audio: '5000' }) },
  { name: 'video above its ceiling', run: model('gpt-5-pro', { video: '1001' }) },
  { name: 'input below zero', run: model('acme-custom-1', { input: '-1', output: '1' }) },
  { name: 'cached below zero', run: model('gpt-5-pro', { cached: '-0.5' }) },
  { name: 'image below zero', run: model('gpt-5-pro', { image: '-0.04' }) },
  {
    name: 'input that is not a number',
    run: model('acme-custom-1', { input: 'abc', output: '1' }),
  },
  {
    name: 'output that is not a number',
    run: model('acme-custom-1', { input: '1', output: 'abc' }),
  },
  { name: 'cached that is not a number', run: model('gpt-5-pro', { cached: 'abc' }) },
  { name: 'image that is not a number', run: model('gpt-5-pro', { image: 'abc' }) },
  { name: 'audio that is not a number', run: model('gpt-5-pro', { audio: 'abc' }) },
  { name: 'video that is not a number', run: model('gpt-5-pro', { video: 'abc' }) },
  { name: 'input that is empty', run: model('acme-custom-1', { input: '  ', output: '1' }) },
  {
    name: 'input that is infinite',
    run: model('acme-custom-1', { input: 'Infinity', output: '1' }),
  },
  {
    name: 'a rejected price writes nothing even beside a good one',
    run: model('acme-custom-1', { ...TOKENS, cached: '-5' }),
  },
  {
    name: 'a rejected media price writes nothing even beside a good pair',
    run: model('acme-custom-1', { ...TOKENS, image: '5000' }),
  },

  // ── the model and the provider ────────────────────────────────────────────────────────────────────────────────────────────
  { name: 'an unknown model with a token price is priced', run: model('brand-new-model', TOKENS) },
  {
    name: 'an unknown model with a media price alone is refused',
    run: model('brand-new-model', { image: '0.04' }),
  },
  {
    name: 'an unknown model with a cached price alone is refused',
    run: model('brand-new-model', { cached: '0.5' }),
  },
  {
    name: 'an unknown model that already stated token rates takes a media price',
    before: [model('brand-new-model', TOKENS)],
    run: model('brand-new-model', { image: '0.04' }),
  },
  {
    name: 'an unregistered provider',
    run: inv(['acme-custom-1'], { provider: 'anthropic', ...TOKENS }),
  },
  {
    name: 'a provider the catalog does not anchor the model to',
    run: model('claude-opus-4-8', TOKENS),
  },
  {
    name: 'a model id with a control byte is echoed without it',
    run: model('acme\u001b[31m-1', TOKENS),
  },
  { name: 'a missing --provider', run: inv(['acme-custom-1'], TOKENS) },
  { name: 'a missing model', run: inv([], { ...OPENAI, ...TOKENS }) },
  {
    name: 'a model already priced under another provider',
    before: [inv(['shared-id'], { provider: 'deepseek', ...TOKENS })],
    run: model('shared-id', TOKENS),
  },
  {
    name: 're-pricing the same model under the same provider is an update',
    before: [model('acme-custom-1', TOKENS)],
    run: model('acme-custom-1', { input: '4', output: '12' }),
  },
];

function globalOptions(json: boolean): GlobalOptions {
  return { json, color: false, cwd: process.cwd(), configPath: undefined, verbosity: 'normal' };
}

const EXPECTED_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'models-pricing-characterization.expected.json',
);

/** The observations a run of the unmodified command produced, keyed by case name. */
function readExpected(): Readonly<Record<string, Observed>> {
  const parsed: unknown = JSON.parse(readFileSync(EXPECTED_PATH, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error('expected.json is not an object');
  return Object.fromEntries(Object.entries(parsed));
}

describe('models pricing: the shell, byte for byte (characterization)', () => {
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
    for (const [name, displayName, baseUrl] of [
      ['openai', 'OpenAI', 'https://api.openai.com/v1'],
      ['deepseek', 'DeepSeek', 'https://api.deepseek.com'],
    ] as const) {
      providers.upsert({ name, displayName, baseUrl });
    }
    catalog = createModelCatalogStore(client.db, deps);
  });

  afterEach(() => {
    client.sqlite.close();
  });

  function invoke(call: Invocation): Observed {
    const { io, out, err } = captureIo();
    let exit = 0;
    let refusal: Observed['refusal'] = null;
    try {
      const args = buildModelsPricingArgs({ positionals: call.positionals, options: call.options });
      exit = modelsPricingCommand(args, {
        io,
        global: globalOptions(call.json === true),
        catalog,
        providers,
      });
    } catch (cause) {
      if (!isCliError(cause)) throw cause;
      const facing = toUserFacing(cause);
      exit = facing.exitCode;
      refusal = { code: cause.code, message: cause.message };
    }
    const names = new Map(providers.list().map((p) => [p.id, p.name] as const));
    const rows = catalog.listAll().map((row) => ({
      model: row.modelId,
      provider: names.get(row.providerId) ?? row.providerId,
      source: row.source,
      displayName: row.displayName,
      contextWindowTokens: row.contextWindowTokens ?? null,
      maxOutputTokens: row.maxOutputTokens ?? null,
      input: row.inputCostPerMtokMicrocents,
      output: row.outputCostPerMtokMicrocents,
      cached: row.cachedInputCostPerMtokMicrocents,
      cachedStated: row.cachedInputStated,
      tokenRatesStated: row.tokenRatesStated,
      image: row.mediaImageCostMicrocents,
      audio: row.mediaAudioCostMicrocents,
      video: row.mediaVideoCostMicrocents,
    }));
    return { exit, refusal, stdout: out(), stderr: err(), rows };
  }

  it.each(CASES.map((c) => [c.name, c] as const))('%s', (name, testCase) => {
    // A case that needs a row a live discovery would have left: the preserved display name and limits.
    if (name === 're-price keeps a discovered display name and limits') {
      const providerId = providers.list().find((p) => p.name === 'openai')?.id ?? '';
      catalog.upsert({
        providerId,
        modelId: 'acme-custom-1',
        displayName: 'Acme Custom (discovered)',
        contextWindowTokens: 32_000,
        maxOutputTokens: 4_000,
        source: 'live',
      });
    }
    for (const call of testCase.before ?? []) invoke(call);
    const observed = invoke(testCase.run);
    expect(observed).toEqual(readExpected()[name]);
  });

  it('can neither skip a comparison nor rewrite its own expectations', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    // The needles are assembled, so this test's own text does not contain them.
    expect(source).not.toContain(['process', 'env'].join('.'));
    expect(source).not.toContain(['write', 'FileSync'].join(''));
  });

  it('pins one expectation per case, and no stale one', () => {
    expect(Object.keys(readExpected()).sort()).toEqual(CASES.map((c) => c.name).sort());
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
  });
});
