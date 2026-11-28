import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openLocalDb } from '../db/open.js';
import { syncCatalogFromDb } from '../engine/catalog-metadata.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import { captureIo } from '../test-support.js';
import { executeCommand, type CommandInput, type DispatchContext } from './dispatch.js';

// The history file is an in-memory db: `models pricing` opens it through the one opener every command uses.
vi.mock('../db/open.js', () => ({ openLocalDb: vi.fn() }));
// The real sync, wrapped so a test can see that the executor ran it (and over which database).
vi.mock('../engine/catalog-metadata.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/catalog-metadata.js')>();
  return { ...actual, syncCatalogFromDb: vi.fn(actual.syncCatalogFromDb) };
});

/**
 * `models pricing` through the dispatch path the CLI itself takes (`executeCommand`, over the uniform `CommandInput` the Commander
 * action builds), not through `modelsPricingCommand` directly: the core's own tests give it a store and nothing else, so they cannot see
 * what the executor hands it. The commit re-checks the one rule another process can break between the prepare and the write (a second
 * provider's price for the same model), and the executor must run that re-check and the write as ONE IMMEDIATE transaction.
 */
describe('models pricing through the dispatch path', () => {
  let client: DbClient;
  let cwd: string;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    createProviderStore(client.db, { uuid: () => 'p-openai', now: () => 1 }).upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    });
    cwd = mkdtempSync(join(tmpdir(), 'relavium-dispatch-pricing-'));
    vi.mocked(openLocalDb).mockImplementation(() => ({ db: client.db, close: () => undefined }));
  });
  afterEach(() => {
    client.sqlite.close();
    rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const input = (options: CommandInput['options']): CommandInput => ({
    positionals: ['acme-custom-1'],
    options: { provider: 'openai', ...options },
  });

  function context(io: DispatchContext['io']): DispatchContext {
    // A `--config` path that does not exist keeps the read off the operator's real config (it is never healed).
    return {
      io,
      global: {
        json: false,
        color: false,
        cwd,
        configPath: join(cwd, 'no-such-config.toml'),
        verbosity: 'normal',
      },
    };
  }

  it('writes the price, and prints what the command always printed', async () => {
    const { io, out } = captureIo();
    await expect(
      executeCommand('models.pricing', input({ input: '3', output: '9' }), context(io)),
    ).resolves.toBe(EXIT_CODES.success);
    expect(out()).toBe(
      'Set user pricing for acme-custom-1 (openai): input $3 per M, output $9 per M. It applies to your next run/chat and survives `relavium models refresh`.\n',
    );
    const rows = createModelCatalogStore(client.db, { uuid: () => 'row', now: () => 1 }).listAll();
    expect(rows.map((row) => [row.modelId, row.source, row.inputCostPerMtokMicrocents])).toEqual([
      ['acme-custom-1', 'user', 300_000_000],
    ]);
  });

  it("runs the commit as one IMMEDIATE transaction around the store's own: the re-check and the write cannot be split", async () => {
    const spy = vi.spyOn(client.db, 'transaction');
    const { io } = captureIo();
    await executeCommand('models.pricing', input({ input: '3', output: '9' }), context(io));
    // Three transactions, in this order: the catalog sync's own (it runs first), then the executor's, then the store's inside it.
    // Without the executor's there are two, and the re-check and the write could be split.
    const configs = spy.mock.calls.map((call) => call[1]);
    expect(configs).toHaveLength(3);
    expect(configs[1]).toEqual({ behavior: 'immediate' });
  });

  it("reads the database's own catalog before it checks a price, as the Home's form does", async () => {
    const { io } = captureIo();
    await executeCommand('models.pricing', input({ input: '3', output: '9' }), context(io));
    // A model only the database holds would otherwise be called unknown, or taken under the wrong provider.
    expect(vi.mocked(syncCatalogFromDb)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(syncCatalogFromDb).mock.calls[0]?.[0]).toBe(client.db);
  });
});
