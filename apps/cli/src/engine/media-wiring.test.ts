import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { globalConfigDir } from '../config/paths.js';
import type { ResolvedConfig } from '../config/resolve.js';
import { buildMediaEngineWiring } from './media-wiring.js';

const EMPTY_CONFIG: ResolvedConfig = {
  updateChannel: undefined,
  defaultModel: undefined,
  fsScope: undefined,
  maxTokensEstimate: undefined,
  mediaCostEstimate: undefined,
  variables: {},
  mcpServers: [],
};

describe('buildMediaEngineWiring (2.S — the shared run/gate media wiring)', () => {
  let client: DbClient;
  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    const dbDeps = { uuid: () => randomUUID(), now: () => Date.now() };
    const providerId = createProviderStore(client.db, dbDeps).upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    }).id;
    createModelCatalogStore(client.db, dbDeps).upsert({
      providerId,
      modelId: 'gpt-image-1',
      displayName: 'GPT Image 1',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative',
    });
  });
  afterEach(() => {
    client.sqlite.close();
  });

  it('roots the CAS under the home dir + save_to under the cwd, and reuses the db for references', () => {
    const wiring = buildMediaEngineWiring(client.db, '/home/u', '/proj', EMPTY_CONFIG);
    // CAS is global under the home `.relavium/`; save_to is project-relative to the run/resume cwd; one db.
    expect(wiring.media.casRoot).toBe(join(globalConfigDir('/home/u'), 'media'));
    expect(wiring.media.saveToRoot).toBe(join('/proj', '.relavium', 'runs'));
    expect(wiring.media.referenceDb).toBe(client.db);
  });

  it('surfaces the catalog routing over the db (seeded generative model routes, unknown is undefined)', () => {
    const wiring = buildMediaEngineWiring(client.db, '/home/u', '/proj', EMPTY_CONFIG);
    expect(wiring.resolveMediaSurface('gpt-image-1')).toBe('generative');
    expect(wiring.resolveMediaSurface('not-in-catalog')).toBeUndefined();
  });

  it('forwards the configured media_cost_estimate (the populated arm), and undefined when unset', () => {
    expect(
      buildMediaEngineWiring(client.db, '/home/u', '/proj', {
        ...EMPTY_CONFIG,
        mediaCostEstimate: { image: 3, audio: 7 },
      }).mediaCostEstimate,
    ).toEqual({ image: 3, audio: 7 });
    expect(
      buildMediaEngineWiring(client.db, '/home/u', '/proj', EMPTY_CONFIG).mediaCostEstimate,
    ).toBeUndefined();
  });
});
