import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentNodeExecutor,
  createInMemoryHost,
  InMemoryRunStore,
  parseWorkflow,
  WorkflowEngine,
  type RunHandle,
} from '@relavium/core';
import {
  createClient,
  createMediaReferencePort,
  createMediaReferenceStore,
  FilesystemMediaStore,
  InMemoryMediaStore,
  runMigrations,
} from '@relavium/db';
import type { ModelPricing } from '@relavium/llm';
import { createOpenAiAdapter } from '@relavium/llm/adapters';
import {
  collectDurableMediaHandles,
  containsDurableUnsafeMedia,
  INLINE_MEDIA_CEILING,
  type RunEvent,
} from '@relavium/shared';
import { expect, it, vi } from 'vitest';
import { mp4Video } from '../../../../packages/shared/src/media-test-vectors.js';
import { generatedMpeg, generatedPng, generatedWav } from './media-generated-fixtures.js';

// Each case joins fresh SQLite migrations, installed SDK transport, and repeated exact-byte
// validation of up to 3 MiB through real stores within this bounded integration cohort.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

// Every external SDK request uses the supplied synthetic fetch. No network/provider account is used.
// SQLite metadata is real; the engine's durable event port and polling clock are deterministic.
const cases = [
  {
    modality: 'image',
    model: 'gpt-image-1',
    mimeType: 'image/png',
    bytes: generatedPng,
    charge: 201,
  },
  {
    modality: 'audio',
    model: 'offline-large-audio',
    mimeType: 'audio/wav',
    bytes: generatedWav,
    charge: 13,
  },
  {
    modality: 'audio',
    model: 'tts-1',
    mimeType: 'audio/mpeg',
    bytes: generatedMpeg,
    // Native TTS returns no usage. Without a compatible audio rate, zero remains explicitly unpriced.
    charge: 0,
  },
  // This independent finite-profile MP4 is structural evidence, not native-decoder/playability evidence.
  { modality: 'video', model: 'sora-2', mimeType: 'video/mp4', bytes: mp4Video, charge: 804 },
] as const;

for (const storage of ['memory', 'filesystem'] as const) {
  it.each(cases)(
    `MEDIA_GENERATED_PUBLICATION: actual SDK $model $modality result reaches ${storage} and metadata before append`,
    async (fixture) => {
      const root = await mkdtemp(join(tmpdir(), 'relavium-generated-publication-'));
      const client = createClient(join(root, 'history.db'));
      let run: RunHandle | undefined;
      try {
        runMigrations(client.db);
        const bytes = fixture.bytes();
        const chatAudio = fixture.modality === 'audio' && fixture.model !== 'tts-1';
        if (fixture.modality !== 'video')
          expect(bytes.length, 'MEDIA_GENERATED_ABOVE_INGRESS').toBeGreaterThan(
            INLINE_MEDIA_CEILING[fixture.modality],
          );
        const handle = `media://sha256-${createHash('sha256').update(bytes).digest('hex')}`;
        const expected = {
          handle,
          mimeType: fixture.mimeType,
          modality: fixture.modality,
          byteLength: bytes.length,
        };
        const references = createMediaReferenceStore(client.db);
        const mediaStore =
          storage === 'memory'
            ? new InMemoryMediaStore()
            : new FilesystemMediaStore(join(root, 'cas'));
        const put = vi.spyOn(mediaStore, 'put');
        const putStream = vi.spyOn(mediaStore, 'putStream');
        const events = new InMemoryRunStore();
        const append = events.persistEvent.bind(events);
        let mediaAppends = 0;
        events.persistEvent = async (event, context) => {
          for (const descriptor of collectDurableMediaHandles(event)) {
            mediaAppends++;
            expect(descriptor, 'MEDIA_GENERATED_METADATA_BEFORE_APPEND').toEqual(expected);
            expect(
              references.describe(handle),
              'MEDIA_GENERATED_METADATA_BEFORE_APPEND',
            ).toMatchObject({ mimeType: fixture.mimeType, byteLength: bytes.length });
            expectExactBytes(await mediaStore.get(handle), bytes);
          }
          expect(containsDurableUnsafeMedia(event), 'MEDIA_GENERATED_HANDLE_ONLY').toBe(false);
          await append(event, context);
        };
        const host = createInMemoryHost({
          store: events,
          mediaStore,
          mediaReferences: createMediaReferencePort(references),
        });
        const calls: string[] = [];
        const json = (value: unknown): Response =>
          new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
        const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          // The installed SDK probes Blob support using this exact data URL before Sora multipart.
          // This local capability probe is distinct from the provider's three HTTP operations.
          if (url === 'data:,') return Promise.resolve(new Response(''));
          const path = new URL(url).pathname;
          calls.push(`${init?.method ?? 'GET'} ${path}`);
          if (fixture.modality === 'video') {
            if (path === '/v1/videos' && init?.method === 'POST')
              return Promise.resolve(json({ id: 'video_offline_generated', status: 'queued' }));
            if (path === '/v1/videos/video_offline_generated' && init?.method === 'GET')
              return Promise.resolve(
                json({ id: 'video_offline_generated', status: 'completed', progress: 100 }),
              );
            if (path === '/v1/videos/video_offline_generated/content' && init?.method === 'GET')
              return Promise.resolve(
                new Response(bytes.slice(), { headers: { 'content-type': fixture.mimeType } }),
              );
          } else {
            if (typeof init?.body !== 'string') throw new Error('Expected SDK JSON body');
            const request: unknown = JSON.parse(init.body);
            expect(request).toMatchObject({ model: fixture.model });
            if (
              fixture.modality === 'image' &&
              path === '/v1/images/generations' &&
              init.method === 'POST'
            )
              return Promise.resolve(
                json({ created: 0, data: [{ b64_json: Buffer.from(bytes).toString('base64') }] }),
              );
            if (
              fixture.model === 'tts-1' &&
              path === '/v1/audio/speech' &&
              init.method === 'POST'
            ) {
              expect(request, 'MEDIA_GENERATED_TTS_DEFAULT').toMatchObject({
                response_format: 'mp3',
              });
              return Promise.resolve(
                new Response(bytes.slice(), { headers: { 'content-type': fixture.mimeType } }),
              );
            }
            if (chatAudio && path === '/v1/chat/completions' && init.method === 'POST') {
              expect(request).toMatchObject({
                modalities: ['text', 'audio'],
                audio: { format: 'wav' },
              });
              return Promise.resolve(
                json({
                  id: 'offline-large-audio-response',
                  model: fixture.model,
                  choices: [
                    {
                      index: 0,
                      finish_reason: 'stop',
                      message: {
                        role: 'assistant',
                        content: null,
                        audio: {
                          data: Buffer.from(bytes).toString('base64'),
                          transcript: 'Independent WAV fixture.',
                        },
                      },
                    },
                  ],
                  usage: {
                    prompt_tokens: 2,
                    completion_tokens: 3,
                    total_tokens: 5,
                    prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
                    completion_tokens_details: {
                      reasoning_tokens: 0,
                      audio_tokens: 3,
                      accepted_prediction_tokens: 0,
                      rejected_prediction_tokens: 0,
                    },
                  },
                }),
              );
            }
          }
          throw new Error('Unexpected synthetic SDK endpoint');
        });
        const provider = createOpenAiAdapter({ fetch, maxRetries: 0 });
        // Synthetic accounting: image=201 each, video=201/second × 4; chat tokens=2×2+3×3.
        // These are fixture rates, never a claim about provider prices or an actual charge.
        const price: ModelPricing = {
          provider: 'openai',
          nativeId: fixture.model,
          displayName: 'Offline generated media',
          contextWindowTokens: 10000,
          maxOutputTokens: 1000,
          inputPerMtokMicrocents: 2000000,
          outputPerMtokMicrocents: 3000000,
          cachedInputPerMtokMicrocents: 2000000,
          mediaOutputRates: { image: 201, video: 201 },
        };
        const prices = new Map([[fixture.model, price]]);
        const executor = createAgentNodeExecutor({
          resolveProvider: () => provider,
          resolveMediaSurface: () => (chatAudio ? 'chat' : 'generative'),
          keyFor: () => 'synthetic-offline-key',
          sleep: () => Promise.resolve(),
          resolvePrice: prices,
          tools: [],
          registry: {
            has: () => false,
            list: () => [],
            dispatch: () => Promise.reject(new Error('Unexpected tool')),
          },
          newAbortController: host.newAbortController,
          setTimer: host.setTimer,
        });
        const workflow = parseWorkflow(
          JSON.stringify({
            schema_version: '1.0',
            workflow: {
              id: 'generated-publication',
              agents: [
                {
                  id: 'generator',
                  provider: 'openai',
                  model: fixture.model,
                  system_prompt: 'Offline generation fixture.',
                  max_tokens: 16,
                },
              ],
              nodes: [
                {
                  id: 'gen',
                  type: 'agent',
                  agent_ref: 'generator',
                  prompt_template: 'Fixture.',
                  output_modalities: chatAudio ? ['text', 'audio'] : [fixture.modality],
                  ...(fixture.modality === 'video' ? { duration_seconds: 4 } : {}),
                },
              ],
              edges: [],
              budget: { max_cost_microcents: 10000, on_exceed: 'fail' },
            },
          }),
        );
        run = new WorkflowEngine({ host, executor, resolvePrice: prices }).start({ workflow });
        const live: RunEvent[] = [];
        for await (const event of run.events) {
          live.push(event);
          if (event.type === 'run:paused') host.fireTimers();
        }
        expect(await run.depart()).toMatchObject({ kind: 'closed', moneyDurability: 'durable' });
        const durable = events.eventsFor(run.runId);
        expect(
          live.filter((event) => event.type === 'cost:updated'),
          'MEDIA_GENERATED_SINGLE_ACCOUNTING',
        ).toMatchObject([{ costMicrocents: fixture.charge }]);
        if (fixture.model === 'tts-1')
          expect(
            live.filter((event) => event.type === 'cost:updated'),
            'MEDIA_GENERATED_TTS_UNPRICED_ONCE',
          ).toMatchObject([{ costMicrocents: 0, priced: false }]);
        expect(
          durable.filter((event) =>
            ['run:completed', 'run:failed', 'run:cancelled'].includes(event.type),
          ),
          'MEDIA_GENERATED_SUCCESS_AFTER_ACCOUNTING',
        ).toMatchObject([{ type: 'run:completed', cumulativeCostMicrocents: fixture.charge }]);
        expect(
          durable.filter((event) => event.type === 'node:completed'),
          'MEDIA_GENERATED_COMPLETED_OUTPUT',
        ).toHaveLength(1);
        expect(durable.some((event) => event.type === 'node:retrying')).toBe(false);
        expect(
          live.filter((event) => collectDurableMediaHandles(event).length > 0),
          'MEDIA_GENERATED_LIVE_DURABLE_AGREE',
        ).toEqual(durable.filter((event) => collectDurableMediaHandles(event).length > 0));
        expect(live.at(-1)).toEqual(durable.at(-1));
        expect(mediaAppends, 'MEDIA_GENERATED_METADATA_BEFORE_APPEND').toBeGreaterThan(0);
        expect(live.flatMap(collectDurableMediaHandles)).toContainEqual(expected);
        expect(references.listObjectHandles()).toEqual([handle]);
        expect(references.describe(handle)?.allowedScopes).toEqual([]);
        expectExactBytes(await mediaStore.get(handle), bytes);
        expect(put, 'MEDIA_GENERATED_NO_INLINE_PUT').not.toHaveBeenCalled();
        expect(putStream, 'MEDIA_GENERATED_ONE_STREAM_WRITE').toHaveBeenCalledTimes(1);
        expect(calls, 'MEDIA_GENERATED_ONE_SDK_OPERATION').toEqual(
          fixture.modality === 'video'
            ? [
                'POST /v1/videos',
                'GET /v1/videos/video_offline_generated',
                'GET /v1/videos/video_offline_generated/content',
              ]
            : [
                `POST /v1/${fixture.modality === 'image' ? 'images/generations' : fixture.model === 'tts-1' ? 'audio/speech' : 'chat/completions'}`,
              ],
        );
        expect(host.armedCount()).toBe(0);
        expect(host.deadlineCount()).toBe(0);
      } finally {
        run?.cancel();
        await run?.depart();
        client.sqlite.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

/** Native byte comparison keeps multi-megabyte readback exact without a per-index assertion graph. */
function expectExactBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength, 'MEDIA_GENERATED_EXACT_BYTES').toBe(expected.byteLength);
  expect(Buffer.compare(actual, expected), 'MEDIA_GENERATED_EXACT_BYTES').toBe(0);
}
