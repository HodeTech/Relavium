import { type DbClient, llmProviders, type ProviderStore } from '@relavium/db';
import {
  LlmProviderError,
  type LlmProvider,
  type LlmRequest,
  type ProviderId,
  type StreamChunk,
} from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isolateSdkEnvironment,
  LEGACY_HEADERS,
  LEGACY_HEADERS_JSON,
  offlineOpenAiRefusal,
  offlineOpenAiReply,
  offlineOpenAiStream,
  seedLegacyProvider,
  SYNTHETIC_PROVIDER_KEY,
  syntheticKeychain,
} from './fixtures/provider-header-fixture.js';
import { createProviderResolver, KNOWN_PROVIDERS } from './providers.js';
import type { FetchLike } from './validated-fetch.js';

type Operation = 'generate' | 'stream' | 'listModels';

const OPERATIONS = ['generate', 'stream', 'listModels'] as const;
const CUSTOM_PROVIDERS = ['openai', 'deepseek'] as const;
const DEFAULT_PROVIDERS = ['openai', 'deepseek', 'anthropic', 'gemini'] as const;

interface CapturedRequest {
  readonly request: Request;
  readonly body: string;
}

/** Full effective synthetic headers remain in memory, before any W8 redacted exchange projection. */
function offlineRecorder(expectedUrl: string, operation: Operation, reply: () => Response) {
  const captures: CapturedRequest[] = [];
  const failures: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    try {
      const request = new Request(input, init);
      captures.push({ request, body: await request.clone().text() });
      if (
        captures.length !== 1 ||
        request.url !== expectedUrl ||
        request.method !== (operation === 'listModels' ? 'GET' : 'POST')
      ) {
        failures.push('unexpected fixture request route, method or ordinal');
        throw new Error('unexpected fixture request');
      }
      return reply();
    } catch (error) {
      // The adapters normalize transport faults. A sticky failure prevents a caught fixture fault
      // being mistaken for the intentionally asserted HTTP 400 outcome.
      failures.push('fixture request construction or dispatch failed');
      throw error;
    }
  };
  return { fetch, captures, failures };
}

function networkTrap() {
  let calls = 0;
  const fetch: FetchLike = () => {
    calls += 1;
    return Promise.reject(new Error('unexpected fixture transport'));
  };
  return { fetch, calls: () => calls };
}

function requireProvider(provider: LlmProvider | undefined): LlmProvider {
  if (provider === undefined) throw new Error('fixture provider was not registered');
  return provider;
}

function assertTrustedLegacy(client: DbClient, store: ProviderStore, provider: ProviderId): void {
  expect(store.get(provider)?.defaultHeaders).toEqual(LEGACY_HEADERS);
  expect(store.list()).toHaveLength(1);
  expect(store.list()[0]?.defaultHeaders).toEqual(LEGACY_HEADERS);
  expect(client.db.select().from(llmProviders).get()?.defaultHeaders).toBe(LEGACY_HEADERS_JSON);
}

function assertEffectiveHeaders(capture: CapturedRequest, provider: ProviderId): void {
  const headers = capture.request.headers;
  for (const name of Object.keys(LEGACY_HEADERS)) {
    expect(headers.has(name), 'FS_CAUSAL_PROVIDER_HEADER_WIRE: legacy header name').toBe(false);
  }
  for (const [name, value] of headers) {
    for (const sentinel of [...Object.keys(LEGACY_HEADERS), ...Object.values(LEGACY_HEADERS)]) {
      expect(name, 'FS_CAUSAL_PROVIDER_HEADER_WIRE: legacy data in a header name').not.toContain(
        sentinel,
      );
      expect(value, 'FS_CAUSAL_PROVIDER_HEADER_WIRE: legacy data in a header value').not.toContain(
        sentinel,
      );
    }
  }
  if (provider === 'anthropic') {
    expect(headers.get('x-api-key')).toBe(SYNTHETIC_PROVIDER_KEY);
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.has('authorization')).toBe(false);
  } else if (provider === 'gemini') {
    expect(headers.get('x-goog-api-key')).toBe(SYNTHETIC_PROVIDER_KEY);
    expect(headers.get('x-goog-api-client')).toBeTruthy();
  } else {
    expect(headers.get('authorization')).toBe(`Bearer ${SYNTHETIC_PROVIDER_KEY}`);
    expect(headers.get('accept')).toBe('application/json');
  }
  if (capture.request.method === 'POST') {
    expect(headers.get('content-type')).toBe('application/json');
  }
}

function requestFor(model: string): LlmRequest {
  return {
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'offline request' }] }],
    maxTokens: 1,
  };
}

async function assertPositiveOperation(
  adapter: LlmProvider,
  operation: Operation,
  model: string,
  key: string,
): Promise<void> {
  if (operation === 'generate') {
    const result = await adapter.generate(requestFor(model), key);
    expect(result.content).toEqual([{ type: 'text', text: 'offline' }]);
    expect(result.stopReason).toBe('stop');
  } else if (operation === 'stream') {
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(requestFor(model), key)) chunks.push(chunk);
    expect(chunks.filter((chunk) => chunk.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'offline' },
    ]);
    expect(chunks.filter((chunk) => chunk.type === 'stop')).toHaveLength(1);
    expect(chunks.find((chunk) => chunk.type === 'stop')?.stopReason).toBe('stop');
    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([]);
  } else {
    if (adapter.listModels === undefined)
      throw new Error('fixture provider has no model discovery');
    expect(await adapter.listModels(key)).toEqual([{ id: model }]);
  }
}

async function assertRefusedOperation(
  adapter: LlmProvider,
  operation: Operation,
  model: string,
  key: string,
): Promise<void> {
  if (operation === 'stream') {
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(requestFor(model), key)) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: 'error',
      error: { kind: 'bad_request', provider: adapter.id, retryable: false },
    });
    return;
  }
  let caught: unknown;
  try {
    if (operation === 'generate') await adapter.generate(requestFor(model), key);
    else {
      if (adapter.listModels === undefined)
        throw new Error('fixture provider has no model discovery');
      await adapter.listModels(key);
    }
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LlmProviderError);
  if (!(caught instanceof LlmProviderError)) throw new Error('fixture refusal was not normalized');
  expect(caught.llmError).toMatchObject({
    kind: 'bad_request',
    provider: adapter.id,
    retryable: false,
  });
}

function defaultUrl(provider: ProviderId, operation: Operation, model: string): string {
  switch (provider) {
    case 'openai':
      return `https://api.openai.com/v1/${operation === 'listModels' ? 'models' : 'chat/completions'}`;
    case 'deepseek':
      return `https://api.deepseek.com/${operation === 'listModels' ? 'models' : 'chat/completions'}`;
    case 'anthropic':
      return `https://api.anthropic.com/v1/${operation === 'listModels' ? 'models' : 'messages'}`;
    case 'gemini':
      return operation === 'listModels'
        ? 'https://generativelanguage.googleapis.com/v1beta/models'
        : `https://generativelanguage.googleapis.com/v1beta/models/${model}:${operation === 'stream' ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
  }
}

function defaultRefusal(provider: ProviderId): Response {
  if (provider === 'anthropic') {
    return Response.json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'offline refusal' } },
      { status: 400 },
    );
  }
  if (provider === 'gemini') {
    return Response.json(
      { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'offline refusal' } },
      { status: 400 },
    );
  }
  return offlineOpenAiRefusal();
}

describe('legacy provider headers remain dormant through actual host factories and installed SDK HTTP (ADR-0108)', () => {
  beforeEach(() => {
    isolateSdkEnvironment();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  for (const provider of CUSTOM_PROVIDERS) {
    for (const operation of OPERATIONS) {
      it(`custom ${provider} ${operation}: FS_CAUSAL_PROVIDER_HEADER_WIRE keeps legacy maps inert with a positive protocol outcome`, async () => {
        const baseUrl = `https://wave7-${provider}.example/v1`;
        const model = provider === 'openai' ? 'gpt-fixture' : 'deepseek-fixture';
        const { client, store } = seedLegacyProvider(provider, baseUrl);
        try {
          assertTrustedLegacy(client, store, provider);
          const globalTrap = networkTrap();
          vi.stubGlobal('fetch', globalTrap.fetch);
          const recorder = offlineRecorder(
            `${baseUrl}/${operation === 'listModels' ? 'models' : 'chat/completions'}`,
            operation,
            () =>
              operation === 'stream'
                ? offlineOpenAiStream(model)
                : operation === 'listModels'
                  ? Response.json({
                      object: 'list',
                      data: [{ id: model, object: 'model', created: 0, owned_by: 'offline' }],
                    })
                  : offlineOpenAiReply(model),
          );
          const resolver = createProviderResolver({}, syntheticKeychain(provider), {
            providerStore: store,
            validatedFetch: recorder.fetch,
          });
          expect(resolver.keyFor(provider)).toBe(SYNTHETIC_PROVIDER_KEY);
          expect(resolver.endpointKind?.(provider)).toBe('custom');
          await assertPositiveOperation(
            requireProvider(resolver.resolveProvider(provider)),
            operation,
            model,
            resolver.keyFor(provider),
          );
          expect(recorder.failures).toEqual([]);
          expect(recorder.captures).toHaveLength(1);
          expect(globalTrap.calls()).toBe(0);
          const capture = recorder.captures[0];
          if (capture === undefined) throw new Error('missing positive SDK HTTP capture');
          assertEffectiveHeaders(capture, provider);
          if (operation === 'listModels') expect(capture.body).toBe('');
          else {
            const body: unknown = JSON.parse(capture.body);
            expect(body).toMatchObject({
              model,
              ...(operation === 'stream' ? { stream: true } : {}),
            });
            if (operation === 'generate') expect(body).not.toHaveProperty('stream', true);
          }
          assertTrustedLegacy(client, store, provider);
        } finally {
          client.sqlite.close();
        }
      });
    }
  }

  for (const provider of DEFAULT_PROVIDERS) {
    for (const operation of OPERATIONS) {
      it(`default ${provider} ${operation}: legacy headers stay absent on exactly one official HTTP 400 request`, async () => {
        const model = KNOWN_PROVIDERS[provider].testModel;
        const { client, store } = seedLegacyProvider(provider, KNOWN_PROVIDERS[provider].baseUrl);
        try {
          assertTrustedLegacy(client, store, provider);
          const recorder = offlineRecorder(defaultUrl(provider, operation, model), operation, () =>
            defaultRefusal(provider),
          );
          vi.stubGlobal('fetch', recorder.fetch);
          const customTrap = networkTrap();
          const resolver = createProviderResolver({}, syntheticKeychain(provider), {
            providerStore: store,
            validatedFetch: customTrap.fetch,
          });
          expect(resolver.keyFor(provider)).toBe(SYNTHETIC_PROVIDER_KEY);
          expect(resolver.endpointKind?.(provider)).toBe('official');
          await assertRefusedOperation(
            requireProvider(resolver.resolveProvider(provider)),
            operation,
            model,
            resolver.keyFor(provider),
          );
          expect(recorder.failures).toEqual([]);
          expect(recorder.captures).toHaveLength(1);
          expect(customTrap.calls()).toBe(0);
          const capture = recorder.captures[0];
          if (capture === undefined) throw new Error('missing official SDK HTTP capture');
          assertEffectiveHeaders(capture, provider);
          if (operation === 'listModels') expect(capture.body).toBe('');
          else expect(capture.body).not.toBe('');
          assertTrustedLegacy(client, store, provider);
        } finally {
          client.sqlite.close();
        }
      });
    }
  }
});
