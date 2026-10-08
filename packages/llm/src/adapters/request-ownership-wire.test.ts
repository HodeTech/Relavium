import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import type { JSONSchema7 } from 'json-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearCatalogRefresh, installCatalogRefresh } from '../catalog/lookup.js';
import { catalogModelFixture } from '../conformance/fixtures/catalog.js';
import { UnsupportedRequestDataError } from '../errors.js';
import { FallbackChain } from '../fallback-chain.js';
import * as ownership from '../output-cap.js';
import type { LlmProvider, LlmRequest, StreamChunk } from '../types.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createGeminiAdapter } from './gemini.js';
import { clearLearnedParamRejections, createOpenAiAdapter } from './openai.js';

const routes = ['openai', 'deepseek', 'anthropic', 'gemini'] as const;
type Route = (typeof routes)[number];
type Path = 'generate' | 'stream';
const paths = ['generate', 'stream'] as const;
const key = 'offline-synthetic-key';
const restorations: Array<() => void> = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('expected test record');
  return value;
}

function field(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null) throw new Error('expected test container');
  const result: unknown = Object.getOwnPropertyDescriptor(value, name)?.value;
  return result;
}

function at(value: unknown, ...names: string[]): unknown {
  return names.reduce<unknown>((current, name) => field(current, name), value);
}

/** Observe the installed method without substituting its converter, HTTP client or response. */
function observeMethod(
  target: object,
  name: string,
  observe: (args: readonly unknown[]) => void,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  const method: unknown = descriptor?.value;
  if (descriptor === undefined || typeof method !== 'function')
    throw new Error(`installed SDK method missing: ${name}`);
  Object.defineProperty(target, name, {
    ...descriptor,
    value: function (this: unknown, ...args: unknown[]): unknown {
      observe(args);
      return Reflect.apply(method, this, args);
    },
  });
  restorations.push(() => Object.defineProperty(target, name, descriptor));
}

function sdkEntries(route: Route, prepared?: unknown[]): unknown[] {
  const entries: unknown[] = [];
  const instance =
    route === 'gemini'
      ? new GoogleGenAI({ apiKey: key, vertexai: false }).models
      : route === 'anthropic'
        ? new Anthropic({ apiKey: key }).messages
        : new OpenAI({ apiKey: key }).chat.completions;
  const prototype: unknown = Object.getPrototypeOf(instance);
  if (typeof prototype !== 'object' || prototype === null) throw new Error('SDK prototype missing');
  // Gemini's public generate methods are instance fields; this shared preprocessing method is
  // reached by both public methods before SDK preparation/conversion and HTTP dispatch.
  observeMethod(
    prototype,
    route === 'gemini' ? 'processParamsMaybeAddMcpUsage' : 'create',
    (args) => {
      entries.push(args[0]);
    },
  );
  if (route === 'gemini' && prepared !== undefined) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'processParamsMaybeAddMcpUsage');
    const method: unknown = descriptor?.value;
    if (descriptor === undefined || typeof method !== 'function')
      throw new Error('missing SDK preparation');
    Object.defineProperty(prototype, 'processParamsMaybeAddMcpUsage', {
      ...descriptor,
      value: async function (this: unknown, ...args: unknown[]): Promise<unknown> {
        const result: unknown = await Reflect.apply(method, this, args);
        prepared.push(result);
        return result;
      },
    });
    restorations.push(() =>
      Object.defineProperty(prototype, 'processParamsMaybeAddMcpUsage', descriptor),
    );
  }
  return entries;
}

function reply(route: Route, path: Path): Response {
  const openai = {
    id: 'c',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok', refusal: null },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  const anthropic = {
    id: 'm',
    type: 'message',
    role: 'assistant',
    model: 'm',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const gemini = {
    candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  };
  const sse =
    route === 'gemini'
      ? `data: ${JSON.stringify(gemini)}\n\n`
      : route === 'anthropic'
        ? 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
        : 'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  return new Response(
    path === 'stream'
      ? sse
      : JSON.stringify(route === 'gemini' ? gemini : route === 'anthropic' ? anthropic : openai),
    {
      headers: { 'content-type': path === 'stream' ? 'text/event-stream' : 'application/json' },
    },
  );
}

function http(
  route: Route,
  path: Path,
): {
  adapter: LlmProvider;
  bodies: Record<string, unknown>[];
  rawBodies: string[];
  fetch: (input: unknown, init?: RequestInit) => Promise<Response>;
} {
  const bodies: Record<string, unknown>[] = [];
  const rawBodies: string[] = [];
  const fetch = (_input: unknown, init?: RequestInit): Promise<Response> => {
    if (typeof init?.body !== 'string') throw new Error('expected actual SDK JSON body');
    const parsed: unknown = JSON.parse(init.body);
    bodies.push(record(parsed));
    rawBodies.push(init.body);
    return Promise.resolve(reply(route, path));
  };
  vi.stubGlobal('fetch', fetch);
  const adapter =
    route === 'gemini'
      ? createGeminiAdapter()
      : route === 'anthropic'
        ? createAnthropicAdapter({ fetch, maxRetries: 0 })
        : // Explicit official-compatible DeepSeek factory route, rather than an id-only provider stub.
          createOpenAiAdapter({
            providerId: route,
            fetch,
            maxRetries: 0,
            ...(route === 'deepseek' ? { baseURL: 'https://api.deepseek.com' } : {}),
          });
  return { adapter, bodies, rawBodies, fetch };
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

async function call(
  provider: Pick<LlmProvider, 'generate' | 'stream'>,
  request: LlmRequest,
  path: Path,
): Promise<void> {
  if (path === 'generate') await provider.generate(request, key);
  else {
    const chunks = await collect(provider.stream(request, key));
    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([]);
    expect(chunks.at(-1)?.type).toBe('stop');
  }
}

async function consumeSdk(result: unknown, path: Path): Promise<void> {
  if (path !== 'stream') return;
  if (typeof result !== 'object' || result === null) throw new Error('expected SDK stream');
  const method: unknown = Reflect.get(result, Symbol.asyncIterator);
  if (typeof method !== 'function') throw new Error('expected SDK iterator');
  const iterator: unknown = Reflect.apply(method, result, []);
  if (typeof iterator !== 'object' || iterator === null) throw new Error('expected SDK iterator');
  const next: unknown = Reflect.get(iterator, 'next');
  if (typeof next !== 'function') throw new Error('expected SDK next');
  while (true) {
    const step: unknown = await Reflect.apply(next, iterator, []);
    if (field(step, 'done') === true) return;
  }
}

interface Fixture {
  request: LlmRequest;
  schema: JSONSchema7;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  options: Record<string, unknown>;
}

function fixture(route: Route, nativeAlias = false): Fixture {
  const map = Object.assign(new Map<unknown, unknown>(), { label: 'map' });
  map.set(map, new Date(0)); // Entries are deliberately ignored by the admitted Map domain.
  const set = Object.assign(new Set<unknown>(), { label: 'set' });
  set.add(set);
  const args = {
    value: 'argument',
    absent: undefined,
    dense: [null, undefined, NaN, Infinity, -Infinity],
    map,
    set,
    toJSON: 'ordinary-data',
  };
  const result = { value: 'result', absent: undefined, dense: [null, undefined, 1], map, set };
  const schema: JSONSchema7 = {
    type: 'object',
    properties: { value: { type: 'string', description: 'before' } },
    required: ['value'],
  };
  const options: Record<string, unknown> = {
    unknownRetained: { map, set, absent: undefined, dense: [null, undefined, NaN] },
    ...(route === 'anthropic'
      ? { metadata: { user_id: 'before' } }
      : route === 'gemini'
        ? {
            candidateCount: 1,
            safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
          }
        : { metadata: { fixture: 'before' } }),
  };
  const request: LlmRequest = {
    model: `adr0102-sdk-${route}`,
    system: 'system before',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'before' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'x', name: 'echo', args },
          { type: 'tool_call', id: 'u', name: 'echo', args: undefined },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool_result', toolCallId: 'x', result },
          { type: 'tool_result', toolCallId: 'u', result: undefined },
        ],
      },
    ],
    tools: [{ name: 'echo', description: 'echo before', parameters: schema }],
    toolChoice: { name: 'echo' },
    responseFormat: { type: 'json', schema, name: 'answer', strict: true },
    temperature: 0.2,
    maxTokens: 16,
    stopSequences: ['end before'],
    outputModalities: ['text'],
    reasoningEffort: 'off',
    providerOptions: options,
  };
  if (nativeAlias) {
    const declaration: JSONSchema7 & { name: string; parameters: JSONSchema7 } = {
      name: 'echo',
      parameters: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema },
    };
    // No canonical tools: replacing native tools here is intentional and lets the SDK see
    // the same declaration through two distinct converter inputs.
    delete request.tools;
    request.responseFormat = { type: 'json', schema: declaration };
    options['tools'] = [{ functionDeclarations: [declaration] }];
  }
  installCatalogRefresh({
    [request.model]: catalogModelFixture({
      modelId: request.model,
      provider: route,
      reasoning: { toggle: true, effortValues: ['none', 'high'] },
    }),
  });
  return { request, schema, args, result, options };
}

/**
 * Independent ordinary vendor fixtures establish each installed SDK's original wire behaviour.
 * These do not invoke ownership helpers, adapter builders, or a clone of their expected output.
 */
async function baseline(
  route: Route,
  path: Path,
  f: Fixture,
  rawBodies?: string[],
): Promise<Record<string, unknown>> {
  const { request: req, schema, args, result, options } = f;
  const { bodies, fetch, rawBodies: captured } = http(route, path);
  let answer: unknown;
  if (route === 'gemini') {
    const client = new GoogleGenAI({
      apiKey: key,
      vertexai: false,
      httpOptions: { baseUrl: 'https://generativelanguage.googleapis.com' },
    });
    const params = {
      model: req.model,
      contents: [
        { role: 'user', parts: [{ text: 'before' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'echo', args } },
            { functionCall: { name: 'echo', args: undefined } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'echo', response: result } },
            { functionResponse: { name: 'echo', response: { result: undefined } } },
          ],
        },
      ],
      config: {
        ...options,
        systemInstruction: req.system,
        ...(req.tools === undefined
          ? {}
          : {
              tools: [
                {
                  functionDeclarations: [
                    { name: 'echo', parameters: schema, description: 'echo before' },
                  ],
                },
              ],
            }),
        toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['echo'] } },
        responseMimeType: 'application/json',
        responseJsonSchema:
          req.responseFormat?.type === 'json' ? req.responseFormat.schema : undefined,
        temperature: 0.2,
        maxOutputTokens: 16,
        thinkingConfig: { thinkingBudget: 0 },
        stopSequences: ['end before'],
      },
    };
    answer = await Reflect.apply(
      path === 'stream' ? client.models.generateContentStream : client.models.generateContent,
      client.models,
      [params],
    );
  } else if (route === 'anthropic') {
    const client = new Anthropic({
      apiKey: key,
      maxRetries: 0,
      fetch,
      baseURL: 'https://api.anthropic.com',
    });
    answer = await Reflect.apply(client.messages.create.bind(client.messages), client.messages, [
      {
        ...options,
        model: req.model,
        max_tokens: 16,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'before' }] },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'x', name: 'echo', input: args },
              { type: 'tool_use', id: 'u', name: 'echo', input: undefined },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'x', content: JSON.stringify(result) },
              { type: 'tool_result', tool_use_id: 'u', content: '' },
            ],
          },
        ],
        system: req.system,
        tools: [{ name: 'echo', input_schema: schema, description: 'echo before' }],
        tool_choice: { type: 'tool', name: 'echo' },
        output_config: { format: { type: 'json_schema', schema } },
        thinking: { type: 'disabled' },
        temperature: 0.2,
        stop_sequences: ['end before'],
        stream: path === 'stream',
      },
    ]);
  } else {
    const client = new OpenAI({
      apiKey: key,
      maxRetries: 0,
      fetch,
      baseURL: route === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1',
    });
    answer = await Reflect.apply(
      client.chat.completions.create.bind(client.chat.completions),
      client.chat.completions,
      [
        {
          ...options,
          model: req.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: 'before' },
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'x',
                  type: 'function',
                  function: { name: 'echo', arguments: JSON.stringify(args) },
                },
                { id: 'u', type: 'function', function: { name: 'echo', arguments: '{}' } },
              ],
            },
            { role: 'tool', tool_call_id: 'x', content: JSON.stringify(result) },
            { role: 'tool', tool_call_id: 'u', content: '' },
          ],
          tools: [
            {
              type: 'function',
              function: { name: 'echo', parameters: schema, description: 'echo before' },
            },
          ],
          tool_choice: { type: 'function', function: { name: 'echo' } },
          response_format:
            route === 'deepseek'
              ? { type: 'json_object' }
              : { type: 'json_schema', json_schema: { name: 'answer', schema, strict: true } },
          temperature: 0.2,
          ...(route === 'deepseek'
            ? { max_tokens: 16, thinking: { type: 'disabled' } }
            : { max_completion_tokens: 16, reasoning_effort: 'none' }),
          stop: ['end before'],
          stream: path === 'stream',
          ...(path === 'stream' ? { stream_options: { include_usage: true } } : {}),
        },
      ],
    );
  }
  await consumeSdk(answer, path);
  expect(bodies).toHaveLength(1);
  rawBodies?.push(...captured);
  return record(bodies[0]);
}

function mutate(f: Fixture): void {
  const { request, schema, args, result, options } = f;
  request.model = 'changed';
  request.system = 'system changed';
  request.temperature = 0.9;
  request.maxTokens = 1;
  request.reasoningEffort = 'high';
  request.messages[0]?.content.push({ type: 'text', text: 'changed' });
  request.tools?.push({ name: 'changed', parameters: {} });
  if (request.tools?.[0] !== undefined) request.tools[0].description = 'changed';
  if (typeof request.toolChoice === 'object') request.toolChoice.name = 'changed';
  if (request.responseFormat?.type === 'json') {
    request.responseFormat.name = 'changed';
    request.responseFormat.strict = false;
  }
  request.stopSequences?.push('changed');
  request.outputModalities?.push('image');
  if (schema.properties?.['value'] !== undefined && typeof schema.properties['value'] === 'object')
    schema.properties['value'].description = 'changed';
  args['value'] = 'changed';
  result['value'] = 'changed';
  options['unknownRetained'] = { changed: true };
  options['metadata'] = { user_id: 'changed', fixture: 'changed' };
  options['candidateCount'] = 2;
}

function assertPrivateGraph(request: LlmRequest, frozen: boolean): void {
  const pending: object[] = [request];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const source = pending.pop();
    if (source === undefined || seen.has(source)) continue;
    seen.add(source);
    expect(Object.isFrozen(source)).toBe(frozen);
    if (Array.isArray(source)) {
      expect(Object.getPrototypeOf(source)).toBe(Array.prototype);
      expect(Object.getOwnPropertyDescriptor(source, 'toJSON')).toMatchObject({
        value: undefined,
        enumerable: false,
      });
      for (let index = 0; index < source.length; index++)
        expect(Object.hasOwn(source, index)).toBe(true);
    } else expect(Object.getPrototypeOf(source)).toBe(null);
    for (const name of Object.keys(source)) {
      if (source === request && (name === 'signal' || name === 'preparedOutputCaps')) continue;
      const child = field(source, name);
      if (typeof child === 'object' && child !== null) pending.push(child);
    }
  }
}

afterEach(() => {
  while (restorations.length > 0) restorations.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearCatalogRefresh();
  clearLearnedParamRejections();
});

describe('owned payload reaches installed SDK HTTP paths (ADR-0102)', () => {
  for (const route of routes)
    for (const path of paths) {
      it(`${route} ${path}: key-await mutation retains the independently established ordinary wire body`, async () => {
        const ordinaryBytes: string[] = [];
        const expected = await baseline(route, path, fixture(route), ordinaryBytes);
        const f = fixture(route);
        const { adapter, bodies, rawBodies } = http(route, path);
        const entries = sdkEntries(route);
        const working: LlmRequest[] = [];
        const originalMutable = ownership.mutableOwnedRequest;
        vi.spyOn(ownership, 'mutableOwnedRequest').mockImplementation((request) => {
          const copy = originalMutable(request);
          working.push(copy);
          return copy;
        });
        let owned: LlmRequest | undefined;
        let other: LlmRequest | undefined;
        const observing: LlmProvider = {
          ...adapter,
          generate: (request, apiKey) => {
            owned = request;
            other = originalMutable(request);
            return adapter.generate(request, apiKey);
          },
          stream: (request, apiKey) => {
            owned = request;
            other = originalMutable(request);
            return adapter.stream(request, apiKey);
          },
        };
        let releaseKey: ((value: string) => void) | undefined;
        let keyEntered: (() => void) | undefined;
        const entered = new Promise<void>((resolve) => {
          keyEntered = resolve;
        });
        const keyWait = new Promise<string>((resolve) => {
          releaseKey = resolve;
        });
        const chain = new FallbackChain(
          [{ provider: observing, model: f.request.model, maxAttempts: 1 }],
          {
            keyFor: () => {
              keyEntered?.();
              return keyWait;
            },
            sleep: () => Promise.resolve(),
          },
        );
        const inFlight = call(chain, f.request, path);
        await entered;
        mutate(f);
        releaseKey?.(key);
        await inFlight;
        expect(bodies).toEqual([expected]);
        expect(rawBodies).toEqual(ordinaryBytes);
        expect(entries).toHaveLength(1);
        expect(working).toHaveLength(1);
        if (owned === undefined || other === undefined || working[0] === undefined)
          throw new Error('missing ownership observation');
        expect(ownership.prepareOwnedRequest(owned, route, 'official').request).toBe(owned);
        assertPrivateGraph(owned, true);
        assertPrivateGraph(working[0], false);
        assertPrivateGraph(other, false);
        expect(working[0]).not.toBe(owned);
        expect(other).not.toBe(working[0]);
        expect(owned.tools?.[0]?.parameters).toBe(
          owned.responseFormat?.type === 'json' ? owned.responseFormat.schema : undefined,
        );
        for (const name of ['map', 'set']) {
          const argumentContainer = at(owned, 'messages', '1', 'content', '0', 'args', name);
          expect(argumentContainer).toBe(
            at(owned, 'messages', '2', 'content', '0', 'result', name),
          );
          expect(argumentContainer).toBe(at(owned, 'providerOptions', 'unknownRetained', name));
          expect(at(working[0], 'messages', '1', 'content', '0', 'args', name)).toBe(
            at(working[0], 'messages', '2', 'content', '0', 'result', name),
          );
          expect(at(other, 'messages', '1', 'content', '0', 'args', name)).not.toBe(
            at(working[0], 'messages', '1', 'content', '0', 'args', name),
          );
        }
        expect(owned.reasoningEffort).toBe('off');
        expect(owned.outputModalities).toEqual(['text']);
        expect(Object.isFrozen(f.request)).toBe(false);
        expect(f.args['value']).toBe('changed');
        const sdkSchema =
          route === 'gemini'
            ? at(entries[0], 'config', 'responseJsonSchema')
            : route === 'anthropic'
              ? at(entries[0], 'tools', '0', 'input_schema')
              : at(entries[0], 'tools', '0', 'function', 'parameters');
        expect(Object.getPrototypeOf(record(sdkSchema))).toBe(null);
        expect(Object.hasOwn(record(sdkSchema), 'inheritedCanary')).toBe(false);
      });

      if (path === 'stream')
        it(`${route} stream: direct entry captures before the first iterator pull`, async () => {
          const expected = await baseline(route, path, fixture(route));
          const f = fixture(route);
          const { adapter, bodies } = http(route, path);
          const stream = adapter.stream(f.request, key);
          mutate(f);
          expect(bodies).toEqual([]);
          const chunks = await collect(stream);
          expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([]);
          expect(bodies).toEqual([expected]);
        });
    }

  for (const path of paths)
    it(`Gemini ${path}: shared native declaration is mutable only in one isolated SDK graph`, async () => {
      const expected = await baseline('gemini', path, fixture('gemini', true));
      const f = fixture('gemini', true);
      const candidate = {
        model: f.request.model,
        provider: 'gemini' as const,
        endpoint: 'official' as const,
      };
      const owned = ownership.selectOwnedRequest(
        ownership.ownLlmRequest(f.request, [candidate]),
        candidate,
      ).request;
      const other = ownership.mutableOwnedRequest(owned);
      const beforeCaller = JSON.stringify(f.request);
      const beforeOwned = JSON.stringify(owned);
      const beforeOther = JSON.stringify(other);
      const { adapter, bodies } = http('gemini', path);
      const prepared: unknown[] = [];
      const entries = sdkEntries('gemini', prepared);
      await call(adapter, owned, path);
      expect(bodies).toEqual([expected]);
      expect(entries).toHaveLength(1);
      expect(prepared).toHaveLength(1);
      const config = at(entries[0], 'config');
      const declaration = at(config, 'tools', '0', 'functionDeclarations', '0');
      const converterConfig = at(prepared[0], 'config');
      expect(Object.getPrototypeOf(record(config))).toBe(Object.prototype);
      expect(Object.getPrototypeOf(record(converterConfig))).toBe(Object.prototype);
      expect(at(converterConfig, 'tools', '0', 'functionDeclarations', '0')).toBe(declaration);
      expect(at(converterConfig, 'responseJsonSchema')).toBe(declaration);
      expect(at(config, 'responseJsonSchema')).toBe(declaration);
      expect(Object.getPrototypeOf(record(declaration))).toBe(null);
      expect(Object.isFrozen(declaration)).toBe(false);
      expect(Object.hasOwn(record(declaration), 'parameters')).toBe(false);
      expect(Object.hasOwn(record(declaration), 'parametersJsonSchema')).toBe(true);
      expect(JSON.stringify(f.request)).toBe(beforeCaller);
      expect(JSON.stringify(owned)).toBe(beforeOwned);
      expect(JSON.stringify(other)).toBe(beforeOther);
      expect(at(owned, 'providerOptions', 'tools', '0', 'functionDeclarations', '0')).toBe(
        at(owned, 'responseFormat', 'schema'),
      );
      expect(at(other, 'providerOptions', 'tools', '0', 'functionDeclarations', '0')).toBe(
        at(other, 'responseFormat', 'schema'),
      );
      expect(at(other, 'responseFormat', 'schema')).not.toBe(declaration);
    });
});

describe('SDK mutation and retry controls (ADR-0102)', () => {
  for (const path of paths) {
    it(`Gemini ${path}: splitting the converter-visible alias changes the ordinary SDK body`, async () => {
      const expected = await baseline('gemini', path, fixture('gemini', true));
      const broken = fixture('gemini', true);
      if (broken.request.responseFormat?.type !== 'json') throw new Error('missing test format');
      const independent: JSONSchema7 & { name: string; parameters: JSONSchema7 } = {
        name: 'echo',
        parameters: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...broken.schema },
      };
      broken.request.responseFormat.schema = independent;
      const split = await baseline('gemini', path, broken);
      expect(split).not.toEqual(expected);
      expect(at(split, 'generationConfig', 'responseJsonSchema')).not.toEqual(
        at(expected, 'generationConfig', 'responseJsonSchema'),
      );
    });

    it(`Gemini ${path}: the actual SDK refuses a frozen working declaration`, async () => {
      const frozen = fixture('gemini', true);
      const declaration = at(
        frozen.request,
        'providerOptions',
        'tools',
        '0',
        'functionDeclarations',
        '0',
      );
      Object.freeze(record(declaration));
      await expect(baseline('gemini', path, frozen)).rejects.toBeInstanceOf(TypeError);
      // The same frozen caller data are supported: the adapter sends a private mutable copy.
      const { adapter, bodies } = http('gemini', path);
      await call(adapter, frozen.request, path);
      expect(bodies).toHaveLength(1);
      expect(Object.hasOwn(record(declaration), 'parameters')).toBe(true);
    });

    it(`OpenAI ${path}: learned-parameter retry rebuilds from owned data in a fresh mutable graph`, async () => {
      const expected = await baseline('openai', path, fixture('openai'));
      const f = fixture('openai');
      const candidate = {
        model: f.request.model,
        provider: 'openai' as const,
        endpoint: 'official' as const,
      };
      const owned = ownership.selectOwnedRequest(
        ownership.ownLlmRequest(f.request, [candidate]),
        candidate,
      ).request;
      const untouched = ownership.mutableOwnedRequest(owned);
      const ownedBefore = JSON.stringify(owned);
      const untouchedBefore = JSON.stringify(untouched);
      const bodies: Record<string, unknown>[] = [];
      const entries = sdkEntries('openai');
      const works: LlmRequest[] = [];
      const original = ownership.mutableOwnedRequest;
      vi.spyOn(ownership, 'mutableOwnedRequest').mockImplementation((request) => {
        const work = original(request);
        works.push(work);
        return work;
      });
      const fetch = (_input: unknown, init?: RequestInit): Promise<Response> => {
        if (typeof init?.body !== 'string') throw new Error('expected SDK body');
        const value: unknown = JSON.parse(init.body);
        bodies.push(record(value));
        if (bodies.length === 1) {
          // Mutate the graph the installed SDK actually received, after serialization but before
          // its 400 is consumed; mutating only a test clone would not establish retry isolation.
          const schema = record(at(entries[0], 'tools', '0', 'function', 'parameters'));
          schema['description'] = 'sdk first-attempt mutation';
          const native = record(at(entries[0], 'unknownRetained'));
          native['changed'] = true;
          mutate(f);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  type: 'invalid_request_error',
                  message: "unsupported 'temperature'",
                  param: 'temperature',
                },
              }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(reply('openai', path));
      };
      // Replace only the network dependency; the actual production SDK and learned-parameter
      // callback execute twice.
      await call(createOpenAiAdapter({ fetch, maxRetries: 0 }), owned, path);
      const secondExpected = { ...expected };
      delete secondExpected['temperature'];
      expect(bodies).toEqual([expected, secondExpected]);
      expect(entries).toHaveLength(2);
      expect(works).toHaveLength(2);
      expect(works[0]).not.toBe(works[1]);
      expect(at(entries[0], 'tools', '0', 'function', 'parameters')).not.toBe(
        at(entries[1], 'tools', '0', 'function', 'parameters'),
      );
      expect(JSON.stringify(owned)).toBe(ownedBefore);
      expect(JSON.stringify(untouched)).toBe(untouchedBefore);
      expect(Object.hasOwn(record(at(owned, 'tools', '0', 'parameters')), 'description')).toBe(
        false,
      );
      expect(f.args['value']).toBe('changed');
    });
  }

  it('a null-prototype source still lets an unsafe setter-copy reinterpret the rejected key', () => {
    const source: Record<string, unknown> = {};
    Object.setPrototypeOf(source, null);
    Object.defineProperty(source, '__proto__', {
      value: { inheritedCanary: 'private-canary' },
      enumerable: true,
    });
    const destination: Record<string, unknown> = {};
    const originalPrototype: unknown = Object.getPrototypeOf(destination);
    Object.assign(destination, source);
    expect(Object.getPrototypeOf(destination)).not.toBe(originalPrototype);
    expect(Object.hasOwn(destination, 'inheritedCanary')).toBe(false);
    expect(destination['inheritedCanary']).toBe('private-canary');
    // The same prototype observation used above would detect the deliberately unsafe copy.
    expect(() => expect(Object.getPrototypeOf(destination)).toBe(originalPrototype)).toThrow();
  });
});

describe('retained inert containers through installed SDKs (ADR-0102)', () => {
  for (const route of routes)
    for (const path of paths) {
      it(`${route} ${path}: late inherited array serialization cannot replace owned dense data`, async () => {
        const expected = await baseline(route, path, fixture(route));
        const f = fixture(route);
        const { adapter, bodies } = http(route, path);
        const prior = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
        let serializerCalls = 0;
        try {
          const chain = new FallbackChain(
            [{ provider: adapter, model: f.request.model, maxAttempts: 1 }],
            {
              keyFor: async () => {
                await Promise.resolve();
                Object.defineProperty(Array.prototype, 'toJSON', {
                  configurable: true,
                  value: function (this: unknown, name: string): unknown {
                    if (name === 'dense') {
                      serializerCalls++;
                      return ['private-canary-late'];
                    }
                    return this;
                  },
                });
                return key;
              },
              sleep: () => Promise.resolve(),
            },
          );
          await call(chain, f.request, path);
          expect(bodies).toEqual([expected]);
          expect(serializerCalls).toBe(0);
        } finally {
          if (prior === undefined) Reflect.deleteProperty(Array.prototype, 'toJSON');
          else Object.defineProperty(Array.prototype, 'toJSON', prior);
        }
      });

      it(`${route} ${path}: frozen caller graphs retain wire parity and remain frozen`, async () => {
        const expected = await baseline(route, path, fixture(route));
        const f = fixture(route);
        const pending: object[] = [f.request];
        const seen = new Set<object>();
        while (pending.length > 0) {
          const source = pending.pop();
          if (source === undefined || seen.has(source)) continue;
          seen.add(source);
          for (const name of Object.keys(source)) {
            const child = field(source, name);
            if (typeof child === 'object' && child !== null) pending.push(child);
          }
          Object.freeze(source);
        }
        const { adapter, bodies } = http(route, path);
        await call(adapter, f.request, path);
        expect(bodies).toEqual([expected]);
        for (const source of seen) expect(Object.isFrozen(source)).toBe(true);
      });

      it(`${route} ${path}: callable inherited serializers refuse without invocation or SDK entry`, async () => {
        const { adapter, bodies } = http(route, path);
        const entries = sdkEntries(route);
        let calls = 0;
        let keys = 0;
        let admissions = 0;
        for (const prototype of [Object.prototype, Array.prototype, Map.prototype, Set.prototype]) {
          const f = fixture(route);
          const prior = Object.getOwnPropertyDescriptor(prototype, 'toJSON');
          try {
            Object.defineProperty(prototype, 'toJSON', {
              configurable: true,
              value: () => {
                calls++;
                return 'private-canary-value';
              },
            });
            await refused(adapter, f.request, path, true);
            const chain = new FallbackChain(
              [{ provider: adapter, model: f.request.model, maxAttempts: 1 }],
              {
                keyFor: () => {
                  keys++;
                  return key;
                },
                preAttempt: () => {
                  admissions++;
                },
                sleep: () => Promise.resolve(),
              },
            );
            await refused(chain, f.request, path, false);
          } finally {
            if (prior === undefined) Reflect.deleteProperty(prototype, 'toJSON');
            else Object.defineProperty(prototype, 'toJSON', prior);
          }
        }
        expect(calls).toBe(0);
        expect(keys).toBe(0);
        expect(admissions).toBe(0);
        expect(entries).toEqual([]);
        expect(bodies).toEqual([]);
      });
    }

  for (const path of paths)
    it(`Gemini ${path}: a deep shared ignored graph reaches HTTP without stack failure or alias expansion`, async () => {
      const expected = await baseline('gemini', path, fixture('gemini'));
      const f = fixture('gemini');
      let graph: Record<string, unknown> = { terminal: true };
      for (let index = 0; index < 12_000; index++) graph = { next: graph, repeated: graph };
      f.options['sdkIgnoredDeepGraph'] = graph;
      const candidate = {
        model: f.request.model,
        provider: 'gemini' as const,
        endpoint: 'official' as const,
      };
      const owned = ownership.selectOwnedRequest(
        ownership.ownLlmRequest(f.request, [candidate]),
        candidate,
      ).request;
      let current: unknown = at(owned, 'providerOptions', 'sdkIgnoredDeepGraph');
      for (let index = 0; index < 12_000; index++) {
        expect(field(current, 'next')).toBe(field(current, 'repeated'));
        current = field(current, 'next');
      }
      expect(field(current, 'terminal')).toBe(true);
      const { adapter, bodies } = http('gemini', path);
      await call(adapter, owned, path);
      expect(bodies).toEqual([expected]);
      // Gemini's own converter decides to discard this option; this does not promise stack-safe
      // serialization of a recognized deep graph in any SDK or impose a new request size limit.
    });
});

const positions = [
  'root',
  'message',
  'tool',
  'schema',
  'response-format',
  'arguments',
  'results',
  'options',
] as const;
type Position = (typeof positions)[number];

function place(f: Fixture, position: Position, value: unknown): void {
  switch (position) {
    case 'root':
      Object.defineProperty(f.request, 'private-canary-property', { value, enumerable: true });
      break;
    case 'message':
      Object.defineProperty(f.request.messages[0], 'private-canary-property', {
        value,
        enumerable: true,
      });
      break;
    case 'tool':
      Object.defineProperty(f.request.tools?.[0], 'private-canary-property', {
        value,
        enumerable: true,
      });
      break;
    case 'schema':
      Object.defineProperty(f.schema, 'private-canary-property', { value, enumerable: true });
      break;
    case 'response-format':
      Object.defineProperty(f.request.responseFormat, 'private-canary-property', {
        value,
        enumerable: true,
      });
      break;
    case 'arguments':
      f.args['private-canary-property'] = value;
      break;
    case 'results':
      f.result['private-canary-property'] = value;
      break;
    case 'options':
      f.options['private-canary-property'] = value;
      break;
  }
}

async function refused(
  provider: Pick<LlmProvider, 'generate' | 'stream'>,
  request: LlmRequest,
  path: Path,
  direct: boolean,
): Promise<void> {
  if (path === 'generate') {
    let caught: unknown;
    try {
      await provider.generate(request, key);
    } catch (error) {
      caught = error;
    }
    if (direct) {
      expect(caught).toBeInstanceOf(UnsupportedRequestDataError);
      if (!(caught instanceof UnsupportedRequestDataError))
        throw new Error('missing typed inert-data refusal');
      expect(caught.name).toBe('UnsupportedRequestDataError');
      expect(caught.code).toBe('unsupported_request_data');
      expect(caught.message).toBe('request data must contain only supported inert values');
      expect(Object.hasOwn(caught, 'cause')).toBe(false);
    } else {
      expect(field(caught, 'llmError')).toMatchObject({ kind: 'bad_request', retryable: false });
      expect(field(field(caught, 'llmError'), 'message')).toBe(
        'request data must contain only supported inert values',
      );
    }
    // Inspect surfaced primitive diagnostics directly. JSON-stringifying the diagnostic while
    // a deliberately hostile Object.prototype.toJSON is installed would invoke the test hook.
    expect(caught instanceof Error ? caught.message : String(caught)).not.toMatch(
      /private-canary|__proto__/,
    );
  } else {
    // Creating the iterable must not synchronously throw a new capture exception.
    let stream: AsyncIterable<StreamChunk> | undefined;
    expect(() => {
      stream = provider.stream(request, key);
    }).not.toThrow();
    if (stream === undefined) throw new Error('missing refusal iterator');
    const chunks = await collect(stream);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: 'error',
      error: { kind: 'bad_request', retryable: false },
    });
    const diagnostic = chunks[0];
    if (diagnostic?.type !== 'error') throw new Error('missing terminal diagnostic');
    expect(diagnostic.error.message).toBe('request data must contain only supported inert values');
    expect(diagnostic.error.message).not.toMatch(/private-canary|__proto__/);
    expect(diagnostic.error.cause).toBeInstanceOf(UnsupportedRequestDataError);
    if (diagnostic.error.cause instanceof UnsupportedRequestDataError)
      expect(Object.hasOwn(diagnostic.error.cause, 'cause')).toBe(false);
  }
}

describe('unsupported non-cap data refuses before installed SDK entry (ADR-0102)', () => {
  for (const route of routes)
    for (const path of paths) {
      for (const shape of ['ordinary', 'null', 'map', 'set'] as const) {
        it(`${route} ${path}: own prototype key in ${shape} containers refuses at every request position`, async () => {
          const { adapter, bodies } = http(route, path);
          const entries = sdkEntries(route);
          let keys = 0;
          let admissions = 0;
          for (const position of positions) {
            const f = fixture(route);
            const value =
              shape === 'map'
                ? new Map<unknown, unknown>()
                : shape === 'set'
                  ? new Set<unknown>()
                  : {};
            if (shape === 'null') Object.setPrototypeOf(value, null);
            Object.defineProperty(value, '__proto__', {
              value: { inheritedCanary: 'private-canary-value' },
              enumerable: true,
            });
            place(f, position, value);
            await refused(adapter, f.request, path, true);
            const chain = new FallbackChain(
              [{ provider: adapter, model: f.request.model, maxAttempts: 1 }],
              {
                keyFor: () => {
                  keys++;
                  return key;
                },
                preAttempt: () => {
                  admissions++;
                },
                sleep: () => Promise.resolve(),
              },
            );
            await refused(chain, f.request, path, false);
          }
          expect(entries).toEqual([]);
          expect(bodies).toEqual([]);
          expect(keys).toBe(0);
          expect(admissions).toBe(0);
        });
      }

      it(`${route} ${path}: executable, opaque and malformed non-cap neighbors have fixed refusals and zero hooks`, async () => {
        const { adapter, bodies } = http(route, path);
        const entries = sdkEntries(route);
        let executions = 0;
        let keys = 0;
        let admissions = 0;
        const cycle: Record<string, unknown> = {};
        cycle['self'] = cycle;
        const accessor = {};
        Object.defineProperty(accessor, 'private-canary-property', {
          enumerable: true,
          get: () => {
            executions++;
            throw new Error('private-canary-value');
          },
        });
        const hidden = {};
        Object.defineProperty(hidden, 'private-canary-property', { value: 'private-canary-value' });
        const symbolic = { [Symbol('private-canary-property')]: 'private-canary-value' };
        const array = [1];
        Object.defineProperty(array, 'private-canary-property', {
          value: 'private-canary-value',
          enumerable: true,
        });
        class Custom {
          readonly value = 'private-canary-value';
        }
        const invalid: readonly unknown[] = [
          new Date(0),
          new Custom(),
          Object(1),
          Object('boxed'),
          Object(true),
          1n,
          Symbol('private-canary-value'),
          () => {
            executions++;
            return 'private-canary-value';
          },
          cycle,
          accessor,
          hidden,
          symbolic,
          new Array(1),
          array,
          {
            toJSON: () => {
              executions++;
              return 'private-canary-value';
            },
          },
          Object.assign(new Map(), {
            toJSON: () => {
              executions++;
              return 'private-canary-value';
            },
          }),
          Object.assign(new Set(), {
            toJSON: () => {
              executions++;
              return 'private-canary-value';
            },
          }),
          new Proxy(
            {},
            {
              ownKeys: () => {
                throw new Error('private-canary-inspection-cause');
              },
            },
          ),
        ];
        for (const value of invalid) {
          const f = fixture(route);
          place(f, 'options', value);
          await refused(adapter, f.request, path, true);
          const chain = new FallbackChain(
            [{ provider: adapter, model: f.request.model, maxAttempts: 1 }],
            {
              keyFor: () => {
                keys++;
                return key;
              },
              preAttempt: () => {
                admissions++;
              },
              sleep: () => Promise.resolve(),
            },
          );
          await refused(chain, f.request, path, false);
        }
        expect(executions).toBe(0);
        expect(keys).toBe(0);
        expect(admissions).toBe(0);
        expect(entries).toEqual([]);
        expect(bodies).toEqual([]);
      });

      it(`${route} ${path}: nearby ordinary names and noncallable toJSON retain the real SDK wire body`, async () => {
        const f = fixture(route);
        f.options['nearby'] = {
          constructor: 'ordinary',
          prototype: 'ordinary',
          __protoX: 'ordinary',
          toString: 'ordinary',
          toJSON: 'ordinary',
        };
        const expected = await baseline(route, path, f);
        const { adapter, bodies } = http(route, path);
        await call(adapter, f.request, path);
        expect(bodies).toEqual([expected]);
      });
    }
});
