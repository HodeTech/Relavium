import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowEngine, InMemoryRunStore, parseWorkflow } from '@relavium/core';
import { createClient, createMediaReferenceStore, runMigrations } from '@relavium/db';
import { createOpenAiAdapter, createGeminiAdapter } from '@relavium/llm/adapters';
import { collectDurableMediaHandles, type ContentPart } from '@relavium/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { createCliHost } from './host.js';
import { PROVIDER_MEDIA_BYTES } from './media-provider-fixtures.js';

afterEach(() => vi.unstubAllGlobals());
const key = 'synthetic-offline-key';
const workflow = parseWorkflow(
  "schema_version: '1.0'\nworkflow:\n  id: native-media-admission\n  nodes: [{ id: produce, type: output }]\n  edges: []",
);

async function publish(
  bytes: Uint8Array,
  mimeType: string,
  produce: () => Promise<readonly ContentPart[]>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'relavium-provider-admission-'));
  const client = createClient(join(root, 'history.db'));
  try {
    runMigrations(client.db);
    const references = createMediaReferenceStore(client.db);
    const runStore = new InMemoryRunStore();
    const append = runStore.persistEvent.bind(runStore);
    let admittedAppends = 0;
    let mediaAcknowledged = false;
    const expectedHandle = `media://sha256-${createHash('sha256').update(bytes).digest('hex')}`;
    runStore.persistEvent = async (event, context) => {
      for (const meta of collectDurableMediaHandles(event)) {
        expect(meta, 'MEDIA_PROVIDER_ADMISSION_BEFORE_APPEND').toMatchObject({
          handle: expectedHandle,
          mimeType,
          byteLength: bytes.length,
          modality: 'audio',
        });
        expect(references.describe(meta.handle), 'MEDIA_PROVIDER_ADMISSION_BEFORE_APPEND').toEqual({
          mimeType,
          byteLength: bytes.length,
          allowedScopes: [],
        });
        admittedAppends += 1;
      }
      await append(event, context);
      if (collectDurableMediaHandles(event).length > 0) mediaAcknowledged = true;
    };
    const host = createCliHost(runStore, {
      media: { casRoot: join(root, 'cas'), referenceDb: client.db },
    });
    if (host.mediaReferences === undefined) throw new Error('Missing production metadata port');
    const record = host.mediaReferences.recordRunMedia.bind(host.mediaReferences);
    const recorded = vi
      .spyOn(host.mediaReferences, 'recordRunMedia')
      .mockImplementation((meta, runId) => {
        expect(mediaAcknowledged, 'MEDIA_PROVIDER_REFERENCE_AFTER_ACK').toBe(true);
        return record(meta, runId);
      });
    const engine = new WorkflowEngine({
      host,
      executor: { execute: async () => ({ kind: 'completed', output: await produce() }) },
    });
    const run = engine.start({ workflow });
    const events = [];
    for await (const event of run.events) events.push(event);
    await run.depart();
    expect(events.at(-1)?.type, 'MEDIA_PROVIDER_ADMISSION_BEFORE_APPEND').toBe('run:completed');
    expect(admittedAppends, 'MEDIA_PROVIDER_ADMISSION_BEFORE_APPEND').toBeGreaterThan(0);
    expect(await host.mediaStore?.get(expectedHandle)).toEqual(bytes);
    expect(recorded, 'MEDIA_PROVIDER_REFERENCE_AFTER_ACK').toHaveBeenCalled();
    expect(references.runReferenceRunIds()).toEqual([]);
  } finally {
    client.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
}

for (const [format, mimeType, bytes] of [
  ['aac', 'audio/aac', PROVIDER_MEDIA_BYTES.aac],
  ['opus', 'audio/opus', PROVIDER_MEDIA_BYTES.opus],
  ['pcm16', 'audio/L16', PROVIDER_MEDIA_BYTES.pcm],
] as const) {
  for (const canonical of [true, false]) {
    it(`MEDIA_PROVIDER_NATIVE_CHAT: OpenAI ${format} canonical=${canonical} SDK HTTP through CAS and SQLite`, async () => {
      const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
        expect(parseWire(init?.body)).toMatchObject({
          modalities: ['text', 'audio'],
          audio: { format },
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'offline',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: null,
                    audio: { data: Buffer.from(bytes).toString('base64'), transcript: '' },
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
                completion_tokens_details: { audio_tokens: 1 },
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      });
      await publish(
        bytes,
        mimeType,
        async () =>
          (
            await createOpenAiAdapter({ fetch }).generate(
              {
                model: 'gpt-4o-audio-preview',
                messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
                ...(canonical ? { outputModalities: ['text', 'audio'] } : {}),
                providerOptions: {
                  modalities: ['text', 'audio'],
                  audio: { format, voice: 'alloy' },
                },
              },
              key,
            )
          ).content,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }
  it(`MEDIA_PROVIDER_NATIVE_TTS: OpenAI ${format} SDK binary HTTP through CAS and SQLite`, async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
      expect(parseWire(init?.body)).toMatchObject({
        response_format: format === 'pcm16' ? 'pcm' : format,
      });
      return Promise.resolve(
        new Response(bytes.slice(), { headers: { 'content-type': mimeType } }),
      );
    });
    await publish(bytes, mimeType, async () => {
      const result = await createOpenAiAdapter({ fetch }).generateMedia?.(
        { model: 'tts-1', modality: 'audio', mimeType, prompt: 'fixture' },
        key,
      );
      if (result === undefined || result.media === undefined)
        throw new Error('expected synchronous media');
      return [result.media];
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
}
for (const canonical of [true, false]) {
  it(`MEDIA_PROVIDER_NATIVE_GEMINI: PCM canonical=${canonical} SDK HTTP through CAS and SQLite`, async () => {
    const bytes = PROVIDER_MEDIA_BYTES.pcm;
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
      expect(parseWire(init?.body)).toMatchObject({
        generationConfig: { responseModalities: ['TEXT', 'AUDIO'] },
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      inlineData: {
                        data: Buffer.from(bytes).toString('base64'),
                        mimeType: 'audio/L16;codec=pcm;rate=24000',
                      },
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    vi.stubGlobal('fetch', fetch);
    await publish(
      bytes,
      'audio/L16',
      async () =>
        (
          await createGeminiAdapter().generate(
            {
              model: 'gemini-2.5-flash',
              messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
              ...(canonical ? { outputModalities: ['text', 'audio'] } : {}),
              providerOptions: { responseModalities: ['TEXT', 'AUDIO'] },
            },
            key,
          )
        ).content,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
}

function parseWire(body: unknown): unknown {
  if (typeof body !== 'string') throw new Error('Expected native JSON request body');
  return JSON.parse(body);
}
