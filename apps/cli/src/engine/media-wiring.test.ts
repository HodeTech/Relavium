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

// A well-formed CapabilityFlags (chat surface, text-only output) — the `capabilities` blob a `model_catalog`
// row stores and the host re-validates against `CapabilityFlagsSchema`. `vision` MUST mirror `media.input.image`
// (the schema's drift refine, ADR-0031), so both are false here.
const CHAT_TEXT_CAPS = {
  tools: true,
  streaming: true,
  parallelToolCalls: false,
  vision: false,
  promptCache: false,
  reasoning: false,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [['text']],
    surface: 'chat',
  },
};

describe('buildMediaEngineWiring (2.S — the shared run/gate media wiring)', () => {
  let client: DbClient;
  let providerId: string;
  const dbDeps = { uuid: () => randomUUID(), now: () => Date.now() };
  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    providerId = createProviderStore(client.db, dbDeps).upsert({
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

  describe('workflowModelCatalog (the D15 load-check projection — capabilities → CapabilityFlags)', () => {
    it('projects a row with a well-formed capabilities blob into validated CapabilityFlags', () => {
      createModelCatalogStore(client.db, dbDeps).upsert({
        providerId,
        modelId: 'chat-text',
        displayName: 'Chat Text',
        contextWindowTokens: 4096,
        maxOutputTokens: 4096,
        mediaSurface: 'chat',
        capabilities: CHAT_TEXT_CAPS,
      });
      const flags = buildMediaEngineWiring(
        client.db,
        '/home/u',
        '/proj',
        EMPTY_CONFIG,
      ).workflowModelCatalog('chat-text');
      // Round-trips through CapabilityFlagsSchema — the load-check reads `media.surface` + `outputCombinations`.
      expect(flags?.media.surface).toBe('chat');
      expect(flags?.media.outputCombinations).toEqual([['text']]);
      expect(flags?.tools).toBe(true);
    });

    it('defers (undefined) for a model absent from the catalog', () => {
      expect(
        buildMediaEngineWiring(client.db, '/home/u', '/proj', EMPTY_CONFIG).workflowModelCatalog(
          'not-in-catalog',
        ),
      ).toBeUndefined();
    });

    it('defers (undefined) for a row whose capabilities fail CapabilityFlagsSchema — never throws', () => {
      // The seeded `gpt-image-1` stored an empty `{}` capabilities blob (no required flags) — a partial/legacy
      // shape that fails the schema. The projection must `safeParse`-defer, not surface a parse throw.
      expect(
        buildMediaEngineWiring(client.db, '/home/u', '/proj', EMPTY_CONFIG).workflowModelCatalog(
          'gpt-image-1',
        ),
      ).toBeUndefined();
    });

    it('isolates a corrupt (non-object) capabilities row to that model — defers, not a whole-catalog throw', () => {
      // `getByModelId` THROWS on a non-object capabilities column (the store contract); the projection's per-model
      // try/catch must degrade THIS model to undefined without sinking the load-check. Corrupt the column directly
      // (the upsert can only write an object), then assert the projection swallows it.
      createModelCatalogStore(client.db, dbDeps).upsert({
        providerId,
        modelId: 'corrupt-caps',
        displayName: 'Corrupt Caps',
        contextWindowTokens: 4096,
        maxOutputTokens: 4096,
        capabilities: { ...CHAT_TEXT_CAPS },
      });
      client.sqlite
        .prepare(`UPDATE model_catalog SET capabilities = '[]' WHERE model_id = ?`)
        .run('corrupt-caps');
      const catalog = buildMediaEngineWiring(
        client.db,
        '/home/u',
        '/proj',
        EMPTY_CONFIG,
      ).workflowModelCatalog;
      expect(() => catalog('corrupt-caps')).not.toThrow();
      expect(catalog('corrupt-caps')).toBeUndefined();
    });
  });
});
