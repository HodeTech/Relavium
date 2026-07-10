import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  ModelCatalogCapabilitiesError,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { globalConfigDir } from '../config/paths.js';
import type { ResolvedConfig } from '../config/resolve.js';
import { CHAT_TEXT_CAPABILITY_FLAGS, GENERATIVE_IMAGE_CAPABILITY_FLAGS } from '../test-support.js';
import { buildMediaEngineWiring } from './media-wiring.js';

const EMPTY_CONFIG: ResolvedConfig = {
  updateChannel: undefined,
  defaultModel: undefined,
  fsScope: undefined,
  maxTokensEstimate: undefined,
  mediaCostEstimate: undefined,
  mediaGcGraceMs: undefined,
  chat: {
    defaultModel: undefined,
    fsScope: undefined,
    maxTurns: undefined,
    maxMessages: undefined,
    autoCompact: undefined,
    compactThreshold: undefined,
    maxCostMicrocents: undefined,
    onExceed: undefined,
    allowedCommands: undefined,
    allowedCommandGlobs: undefined,
    reasoningEffort: undefined,
  },
  altScreen: undefined,
  mouse: undefined,
  variables: {},
  mcpServers: [],
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
    it('projects a row with a well-formed chat capabilities blob into validated CapabilityFlags', () => {
      createModelCatalogStore(client.db, dbDeps).upsert({
        providerId,
        modelId: 'chat-text',
        displayName: 'Chat Text',
        contextWindowTokens: 4096,
        maxOutputTokens: 4096,
        mediaSurface: 'chat',
        capabilities: CHAT_TEXT_CAPABILITY_FLAGS,
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

    it('carries media.surface from the capabilities blob — a generative row projects surface generative', () => {
      // The projection reads `media.surface` from the capabilities JSON (NOT the DB `mediaSurface` column —
      // resolveMediaSurface owns that), so the load-check's generative branch (validate-catalog.ts) keys on it.
      // A regression that dropped `media.surface` would default to 'chat' and silently take the wrong branch.
      createModelCatalogStore(client.db, dbDeps).upsert({
        providerId,
        modelId: 'gen-image',
        displayName: 'Gen Image',
        contextWindowTokens: 4096,
        maxOutputTokens: 4096,
        mediaSurface: 'generative',
        capabilities: GENERATIVE_IMAGE_CAPABILITY_FLAGS,
      });
      const flags = buildMediaEngineWiring(
        client.db,
        '/home/u',
        '/proj',
        EMPTY_CONFIG,
      ).workflowModelCatalog('gen-image');
      expect(flags?.media.surface).toBe('generative');
      expect(flags?.media.outputCombinations).toEqual([]);
    });

    it('defers (undefined) for a model absent from the catalog', () => {
      expect(
        buildMediaEngineWiring(client.db, '/home/u', '/proj', EMPTY_CONFIG).workflowModelCatalog(
          'not-in-catalog',
        ),
      ).toBeUndefined();
    });

    it('defers (undefined) for a row whose capabilities fail CapabilityFlagsSchema — never throws', () => {
      // Seed a model with an explicit empty `capabilities: {}` (no required flags) so the test is self-contained,
      // not coupled to the beforeEach row's default. `safeParse({})` fails ⇒ the projection must defer, not throw.
      createModelCatalogStore(client.db, dbDeps).upsert({
        providerId,
        modelId: 'empty-caps',
        displayName: 'Empty Caps',
        contextWindowTokens: 4096,
        maxOutputTokens: 4096,
        capabilities: {},
      });
      expect(
        buildMediaEngineWiring(client.db, '/home/u', '/proj', EMPTY_CONFIG).workflowModelCatalog(
          'empty-caps',
        ),
      ).toBeUndefined();
    });

    it('isolates a corrupt (non-object) capabilities row to that model — defers, not a whole-catalog throw', () => {
      // `getByModelId` THROWS a ModelCatalogCapabilitiesError on a non-object capabilities column (the store
      // contract the catch keys on); the projection's per-model catch must degrade THIS model to undefined without
      // sinking the load-check. Corrupt the column directly (the upsert can only write an object), then assert it.
      createModelCatalogStore(client.db, dbDeps).upsert({
        providerId,
        modelId: 'corrupt-caps',
        displayName: 'Corrupt Caps',
        contextWindowTokens: 4096,
        maxOutputTokens: 4096,
        capabilities: { ...CHAT_TEXT_CAPABILITY_FLAGS },
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

    it('propagates a genuine store fault (a closed db) instead of masking it as a defer', () => {
      // The narrowed catch swallows ONLY the store's documented parse faults; a real DB error (here, a closed
      // connection) must surface, not be degraded to a clean "model unresolvable" that slips a node past the gate.
      const local = createClient(':memory:');
      runMigrations(local.db);
      const catalog = buildMediaEngineWiring(
        local.db,
        '/home/u',
        '/proj',
        EMPTY_CONFIG,
      ).workflowModelCatalog;
      local.sqlite.close(); // any subsequent query throws a generic "database connection is not open" Error
      let caught: unknown;
      try {
        catalog('any-model');
      } catch (err) {
        caught = err;
      }
      // It SURFACED (not swallowed to undefined) AND is a non-domain fault — NOT the ModelCatalogCapabilitiesError
      // the catch swallows. This is the whole point: better-sqlite3 throws a TypeError on a closed connection, so a
      // by-type narrow would misclassify it as a defer; the typed-domain narrow lets it through.
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(ModelCatalogCapabilitiesError);
    });
  });
});
