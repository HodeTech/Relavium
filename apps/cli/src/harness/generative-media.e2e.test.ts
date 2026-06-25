import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  createRunHistoryStore,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import type { LlmProvider } from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCommand, type RunCommandDeps } from '../commands/run.js';
import type { ProviderResolver } from '../engine/providers.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo, GENERATIVE_IMAGE_CAPABILITY_FLAGS, parseNdjson } from '../test-support.js';

/**
 * The 2.S headline acceptance (off the M3 critical path): a **generative media-output** workflow runs
 * end-to-end on the CLI — `relavium run` over a `media_surface: 'generative'` model that produces an image,
 * exercising the REAL host wiring (the catalog `resolveMediaSurface` routing → `generateMedia`, the
 * `MediaStore` de-inline to a durable `media://` handle, the containment-checked `save_to` write, and the
 * cross-surface "render a produced media handle"). The only stubs are the provider (a deterministic
 * `generateMedia` — no network) and the durable db (in-memory). `HOME` is pointed at a tmpdir so the global
 * CAS lands there, never the developer's real `~/.relavium`.
 */

// `gen-model` is routed generative by the seeded catalog; `save` writes the produced image under the run id.
const GENERATIVE_WF = `schema_version: '1.0'
workflow:
  id: gen-media-e2e
  agents:
    - { id: painter, model: gen-model, provider: openai, system_prompt: paint }
  nodes:
    - { id: start, type: input }
    - { id: paint, type: agent, agent_ref: painter, prompt_template: 'draw a cat', output_modalities: ['image'] }
    - { id: save, type: output, save_to: 'art/{{ run.id }}.png' }
  edges:
    - { from: start, to: paint }
    - { from: paint, to: save }
`;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // a stand-in "PNG" payload (sha256-addressed)

/** A provider flagged generative whose generateMedia returns a base64 image (no network); generate/stream throw. */
function generativeProvider(): LlmProvider {
  return {
    id: 'openai',
    supports: GENERATIVE_IMAGE_CAPABILITY_FLAGS,
    generate: () => Promise.reject(new Error('generate must not run for a generative node')),
    stream: (): AsyncIterable<never> => {
      throw new Error('stream must not run for a generative node');
    },
    generateMedia: () =>
      Promise.resolve({
        media: {
          type: 'media',
          mimeType: 'image/png',
          source: { kind: 'base64', data: Buffer.from(PNG_BYTES).toString('base64') },
        },
        raw: {},
      }),
  };
}

// `os.homedir()` reads `HOME` on POSIX but `USERPROFILE` on Windows — override both so the hermetic home holds
// on every platform (CI), and the global CAS always lands in the tmpdir, never the developer's real `~`.
const HOME_ENV_VARS = ['HOME', 'USERPROFILE'] as const;

describe('generative media-output — end-to-end on the CLI (2.S acceptance)', () => {
  let home: string;
  let cwd: string;
  let client: DbClient;
  const savedHome = new Map<string, string | undefined>();

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'relavium-gen-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'relavium-gen-cwd-'));
    for (const v of HOME_ENV_VARS) {
      savedHome.set(v, process.env[v]);
      process.env[v] = home;
    }
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
      modelId: 'gen-model',
      displayName: 'Generative Image Model',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative', // routes the node to generateMedia (ADR-0045 §1)
      capabilities: GENERATIVE_IMAGE_CAPABILITY_FLAGS,
    });
  });

  afterEach(() => {
    for (const v of HOME_ENV_VARS) {
      const prior = savedHome.get(v);
      if (prior === undefined) {
        delete process.env[v];
      } else {
        process.env[v] = prior;
      }
    }
    client.sqlite.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const providers: ProviderResolver = {
    resolveProvider: () => generativeProvider(),
    keyFor: () => 'sk-test',
  };

  function globalOptions(over: Partial<GlobalOptions> = {}): GlobalOptions {
    return { json: true, color: false, cwd, configPath: undefined, verbosity: 'normal', ...over };
  }

  function deps(io: RunCommandDeps['io']): RunCommandDeps {
    return {
      io,
      global: globalOptions(),
      providers,
      openRunStore: (workflow) => ({
        store: createRunHistoryStore(client.db, {
          uuid: () => randomUUID(),
          now: () => Date.now(),
          workflow: {
            slug: workflow.workflow.id,
            name: workflow.workflow.id,
            definitionJson: JSON.stringify(workflow),
          },
        }),
        db: client.db,
        close: () => {},
      }),
    };
  }

  it('produces an image, de-inlines it to a media:// handle, renders the handle, and writes save_to', async () => {
    const { io, out } = captureIo();
    const wfPath = join(cwd, 'gen.relavium.yaml');
    writeFileSync(wfPath, GENERATIVE_WF);

    const code = await runCommand({ workflow: wfPath, input: [] }, deps(io));
    expect(code).toBe(EXIT_CODES.success); // the generative run completes end-to-end

    const events = parseNdjson(out());
    const runStarted = events.find((e) => e['type'] === 'run:started');
    const runId = runStarted?.['runId'];
    expect(typeof runId).toBe('string');

    // The agent node's node:completed.output carries a DURABLE media handle (de-inlined, never inline bytes),
    // and the --json stream renders it verbatim (the cross-surface "render a produced media handle" leaf).
    const json = out();
    expect(json).toMatch(/media:\/\/sha256-[0-9a-f]{64}/); // a content-addressed handle is on the stream
    expect(json).not.toContain(Buffer.from(PNG_BYTES).toString('base64')); // ...never the inline base64 bytes

    // The save_to deliverable landed under <cwd>/.relavium/runs/art/<runId>.png with the produced bytes.
    const savedPath = join(cwd, '.relavium', 'runs', 'art', `${String(runId)}.png`);
    expect(existsSync(savedPath)).toBe(true);
    expect(Array.from(readFileSync(savedPath))).toEqual(Array.from(PNG_BYTES));
  });
});
