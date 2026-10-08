import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JSONSchema7 } from 'json-schema';

import { clearCatalogRefresh, installCatalogRefresh } from './catalog/lookup.js';
import { catalogModelFixture } from './conformance/fixtures/catalog.js';
import { UnsupportedRequestDataError } from './errors.js';
import {
  deriveOwnedRequestMessages,
  InvalidOutputCapPlanError,
  mutableOwnedRequest,
  outputCapNativeOptions,
  outputCapPlanForRequest,
  outputTokensReservation,
  ownLlmRequest,
  ownedRequestSignal,
  ownedRequestSupportReason,
  prepareOwnedRequest,
  prepareOutputCapPlan,
  selectOwnedRequest,
  withOwnedRequestSignal,
  withoutOwnedRequestEffort,
  type RequestCandidate,
} from './output-cap.js';
import type { CapabilityFlags, LlmRequest } from './types.js';

const openai: RequestCandidate = { model: 'gpt-5', provider: 'openai', endpoint: 'official' };
const gemini: RequestCandidate = {
  model: 'gemini-2.5-pro',
  provider: 'gemini',
  endpoint: 'official',
};

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) throw new Error('expected record');
  const result: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return result;
}

function base(): LlmRequest {
  return {
    model: openai.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'before' }] }],
  };
}

describe('internal request ownership factory (ADR-0102)', () => {
  afterEach(() => clearCatalogRefresh());
  it('owns every current and future data field before an asynchronous handoff', async () => {
    const textSchema: JSONSchema7 = { type: 'string' };
    const schema: JSONSchema7 = { type: 'object', properties: { text: textSchema } };
    const request: LlmRequest = {
      ...base(),
      system: 'before',
      tools: [{ name: 'tool', parameters: schema }],
      responseFormat: { type: 'json', schema },
      toolChoice: { name: 'tool' },
      outputModalities: ['text'],
      temperature: 0.5,
      maxTokens: 100,
      reasoningEffort: 'high',
      stopSequences: ['before'],
      providerOptions: { nested: schema },
    };
    const future = { text: 'before' };
    Object.defineProperty(request, 'futureField', { value: future, enumerable: true });
    const owned = ownLlmRequest(request, [openai, gemini]);
    await Promise.resolve();
    request.model = 'changed';
    request.system = 'changed';
    request.temperature = 1;
    request.maxTokens = 1;
    request.reasoningEffort = 'low';
    request.messages[0]?.content.push({ type: 'text', text: 'changed' });
    request.tools?.push({ name: 'changed', parameters: {} });
    if (typeof request.toolChoice === 'object') request.toolChoice.name = 'changed';
    request.outputModalities?.push('image');
    request.stopSequences?.push('changed');
    textSchema.type = 'number';
    future.text = 'changed';
    const selected = selectOwnedRequest(owned, openai).request;
    expect(selected).toMatchObject({
      model: openai.model,
      system: 'before',
      temperature: 0.5,
      maxTokens: 100,
      reasoningEffort: 'high',
      toolChoice: { name: 'tool' },
      outputModalities: ['text'],
      stopSequences: ['before'],
      futureField: { text: 'before' },
    });
    expect(selected.messages[0]?.content).toHaveLength(1);
    expect(selected.tools).toHaveLength(1);
    expect(selected.responseFormat?.type === 'json' && selected.responseFormat.schema).toBe(
      selected.tools?.[0]?.parameters,
    );
    expect(selected.providerOptions?.['nested']).toBe(selected.tools?.[0]?.parameters);
    expect(field(field(field(selected.tools?.[0]?.parameters, 'properties'), 'text'), 'type')).toBe(
      'string',
    );
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected.messages[0]?.content)).toBe(true);
    expect(Object.isFrozen(request.messages)).toBe(false);
    expect(selectOwnedRequest(owned, openai).request).toBe(selected);
    expect(selectOwnedRequest(owned, gemini).request.messages).toEqual(selected.messages);
    expect(selectOwnedRequest(owned, gemini).request.messages).toBe(selected.messages);
    expect(selectOwnedRequest(owned, gemini).request.tools).toBe(selected.tools);
    expect(selectOwnedRequest(owned, gemini).request.providerOptions?.['nested']).toBe(
      selected.tools?.[0]?.parameters,
    );
  });

  it('preserves SDK-visible aliases across every field in isolated mutable working copies', () => {
    const declaration = Object.freeze({
      name: 'tool',
      parameters: Object.freeze({ type: 'object' }),
    });
    const request = {
      ...base(),
      providerOptions: {
        tools: [{ functionDeclarations: [declaration] }],
        responseJsonSchema: declaration,
      },
      tools: [{ name: 'tool', parameters: declaration.parameters }],
    };
    const selected = selectOwnedRequest(ownLlmRequest(request, [gemini]), gemini).request;
    const first = mutableOwnedRequest(selected);
    const second = mutableOwnedRequest(selected);
    const options = first.providerOptions;
    const tools = options?.['tools'];
    if (!Array.isArray(tools)) throw new Error('expected tools');
    const declarations = field(tools[0], 'functionDeclarations');
    if (!Array.isArray(declarations)) throw new Error('expected declarations');
    expect(declarations[0]).toBe(options?.['responseJsonSchema']);
    expect(field(declarations[0], 'parameters')).toBe(first.tools?.[0]?.parameters);
    Object.defineProperty(declarations[0], 'converted', { value: true });
    expect(field(options?.['responseJsonSchema'], 'converted')).toBe(true);
    expect(field(second.providerOptions?.['responseJsonSchema'], 'converted')).toBeUndefined();
    expect(field(selected.providerOptions?.['responseJsonSchema'], 'converted')).toBeUndefined();
    expect(field(declaration, 'converted')).toBeUndefined();
    expect(Object.getPrototypeOf(declarations[0])).toBeNull();
    expect(Object.getPrototypeOf(first)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(first.messages, 'toJSON')).toMatchObject({
      value: undefined,
    });
  });

  it('keeps a providerOptions-root alias while inspecting that non-cap path normally', () => {
    const options = { max_tokens: 500, nested: { value: 'inert' } };
    const request = { ...base(), providerOptions: options };
    Object.defineProperty(request, 'futureField', { value: options, enumerable: true });
    const selected = selectOwnedRequest(ownLlmRequest(request, [openai]), openai).request;
    expect(field(selected, 'futureField')).toBe(selected.providerOptions);
    expect(selected.providerOptions?.['max_tokens']).toBe(500);
    const working = mutableOwnedRequest(selected);
    expect(field(working, 'futureField')).toBe(working.providerOptions);
    const executable = { max_tokens: { toJSON: () => 500 } };
    const invalid = { ...base(), providerOptions: executable };
    Object.defineProperty(invalid, 'futureField', { value: executable, enumerable: true });
    expect(() => ownLlmRequest(invalid, [openai])).toThrow(UnsupportedRequestDataError);
  });

  it.each([
    { candidate: openai, key: 'max_tokens', maxTokens: 100, survives: false },
    { candidate: openai, key: 'max_tokens', maxTokens: undefined, survives: true },
    { candidate: gemini, key: 'max_tokens', maxTokens: undefined, survives: false },
    { candidate: gemini, key: 'maxOutputTokens', maxTokens: undefined, survives: true },
    {
      candidate: { ...openai, provider: 'anthropic' } satisfies RequestCandidate,
      key: 'max_tokens',
      maxTokens: undefined,
      survives: false,
    },
    {
      candidate: { ...openai, provider: 'deepseek' } satisfies RequestCandidate,
      key: 'max_completion_tokens',
      maxTokens: undefined,
      survives: true,
    },
  ])(
    'retains ordinary aliased tool-result cap data for $candidate.provider/$key/$maxTokens',
    ({ candidate, key, maxTokens, survives }) => {
      const cap = { nested: 'retained', array: [{ value: true }] };
      const shared = { [key]: cap, other: 'kept' };
      const raw: LlmRequest = {
        model: candidate.model,
        maxTokens,
        reasoningEffort: 'high',
        messages: [
          { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'call', result: shared }] },
        ],
        providerOptions: shared,
      };
      Object.defineProperty(raw, 'futureCapAlias', { value: cap, enumerable: true });
      const owner = ownLlmRequest(raw, [candidate]);
      const selected = selectOwnedRequest(owner, candidate);
      const captured = selected.request;
      const result = field(captured.messages[0]?.content[0], 'result');
      expect(result).toBe(captured.providerOptions);
      expect(result).toEqual({
        [key]: { nested: 'retained', array: [{ value: true }] },
        other: 'kept',
      });
      expect(field(result, key)).toBe(field(captured, 'futureCapAlias'));
      expect(outputCapPlanForRequest(captured, candidate.provider, candidate.endpoint)).toBe(
        selected.plan,
      );
      cap.nested = 'caller changed';
      expect(field(field(result, key), 'nested')).toBe('retained');
      const working = mutableOwnedRequest(captured);
      const otherWorking = mutableOwnedRequest(captured);
      const workingResult = field(working.messages[0]?.content[0], 'result');
      expect(workingResult).toBe(working.providerOptions);
      expect(field(workingResult, key)).toBe(field(working, 'futureCapAlias'));
      expect(field(field(workingResult, key), 'nested')).toBe('retained');
      expect(() =>
        outputCapPlanForRequest(working, candidate.provider, candidate.endpoint),
      ).toThrow(InvalidOutputCapPlanError);
      expect(() => ownLlmRequest(working, [candidate])).toThrow(InvalidOutputCapPlanError);
      const native = outputCapNativeOptions(selected.plan, working.providerOptions);
      expect(Object.hasOwn(native ?? {}, key)).toBe(survives);
      expect(field(field(workingResult, key), 'nested')).toBe('retained');
      Object.defineProperty(field(workingResult, key), 'nested', { value: 'SDK changed' });
      expect(() =>
        outputCapPlanForRequest(working, candidate.provider, candidate.endpoint),
      ).toThrow(InvalidOutputCapPlanError);
      expect(field(field(otherWorking.providerOptions, key), 'nested')).toBe('retained');
      expect(field(field(result, key), 'nested')).toBe('retained');
      const live = withOwnedRequestSignal(captured, new AbortController().signal);
      const stripped = withoutOwnedRequestEffort(live);
      expect(outputCapPlanForRequest(stripped, candidate.provider, candidate.endpoint)).toBe(
        selected.plan,
      );
      const derived = deriveOwnedRequestMessages(stripped, {
        route: 'media',
        messages: stripped.messages,
      });
      expect(field(derived.messages[0]?.content[0], 'result')).toBe(derived.providerOptions);
      expect(field(field(derived.providerOptions, key), 'nested')).toBe('retained');
      expect(outputCapPlanForRequest(derived, candidate.provider, candidate.endpoint)).toBe(
        selected.plan,
      );
      // The full generic captured view is accepted solely through the exact private request association.
      expect(() =>
        outputCapPlanForRequest({ ...captured }, candidate.provider, candidate.endpoint),
      ).toThrow(InvalidOutputCapPlanError);
      expect(() => ownLlmRequest({ ...captured }, [candidate])).toThrow(InvalidOutputCapPlanError);
      expect(() =>
        outputCapPlanForRequest(
          captured,
          candidate.provider,
          candidate.endpoint === 'official' ? 'custom' : 'official',
        ),
      ).toThrow(InvalidOutputCapPlanError);
    },
  );

  it('retains the exact discarded object-cap/tool-result alias regression', () => {
    const shared = { max_tokens: { nested: 'retained' }, other: 'kept' };
    const raw: LlmRequest = {
      model: 'gpt-5',
      maxTokens: 100,
      messages: [
        { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'call', result: shared }] },
      ],
      providerOptions: shared,
    };
    const selected = selectOwnedRequest(ownLlmRequest(raw, [openai]), openai);
    expect(field(selected.request.messages[0]?.content[0], 'result')).toEqual(shared);
    expect(field(selected.request.messages[0]?.content[0], 'result')).toBe(
      selected.request.providerOptions,
    );
    const working = mutableOwnedRequest(selected.request);
    expect(field(working.messages[0]?.content[0], 'result')).toEqual(shared);
    expect(field(working.messages[0]?.content[0], 'result')).toBe(working.providerOptions);
    expect(outputCapNativeOptions(selected.plan, working.providerOptions)).toEqual({
      other: 'kept',
    });
    expect(field(working.messages[0]?.content[0], 'result')).toEqual(shared);
  });

  it('captures each dialect at construction and retains unused failures until selection', async () => {
    let amount = 100_000;
    const keys: string[] = [];
    const bad = {
      toJSON: () => {
        throw new Error('private cap value');
      },
    };
    const cap = {
      toJSON: (key: string) => {
        keys.push(key);
        return amount;
      },
    };
    const request = { ...base(), providerOptions: { maxOutputTokens: cap, max_tokens: bad } };
    const owned = ownLlmRequest(request, [gemini, openai]);
    expect(keys).toEqual(['maxOutputTokens']);
    amount = 1;
    await Promise.resolve();
    const selected = selectOwnedRequest(owned, gemini);
    expect(selected.plan.effectiveCap).toBe(100_000);
    expect(selected.request.providerOptions?.['max_tokens']).toBeUndefined();
    expect(() => selectOwnedRequest(owned, openai)).toThrow(InvalidOutputCapPlanError);
    expect(() => owned.candidates.map((candidate) => selectOwnedRequest(owned, candidate))).toThrow(
      InvalidOutputCapPlanError,
    );
    expect(keys).toHaveLength(1);
  });

  it('checks owned capability applicability and live cancellation before selecting a failed cap', () => {
    const supports: CapabilityFlags = {
      tools: true,
      streaming: true,
      parallelToolCalls: true,
      vision: false,
      promptCache: false,
      reasoning: true,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [],
      },
    };
    const serializer = vi.fn(() => {
      throw new Error('private failed cap');
    });
    const controller = new AbortController();
    const raw: LlmRequest = {
      ...base(),
      signal: controller.signal,
      tools: [{ name: 'tool', parameters: { type: 'object' } }],
      providerOptions: { max_tokens: { toJSON: serializer } },
    };
    const owned = ownLlmRequest(raw, [openai, gemini]);
    raw.tools = [];
    expect(ownedRequestSupportReason(owned, openai, { ...supports, tools: false })).toBe(
      "'tools' capability not supported",
    );
    expect(ownedRequestSupportReason(owned, gemini, supports)).toBeNull();
    expect(selectOwnedRequest(owned, gemini).plan.provider).toBe('gemini');
    // An applicable candidate's capture failure remains fail-closed for attempts and quotes.
    expect(ownedRequestSupportReason(owned, openai, supports)).toBeNull();
    expect(() => selectOwnedRequest(owned, openai)).toThrow(InvalidOutputCapPlanError);
    expect(serializer).toHaveBeenCalledTimes(1);
    expect(ownedRequestSignal(owned)).toBe(controller.signal);
    controller.abort();
    expect(ownedRequestSignal(owned)?.aborted).toBe(true);
    const borrowed = { candidates: owned.candidates };
    expect(() => ownedRequestSupportReason(borrowed, gemini, supports)).toThrow(
      InvalidOutputCapPlanError,
    );
    expect(() => ownedRequestSignal(borrowed)).toThrow(InvalidOutputCapPlanError);
    expect(() => selectOwnedRequest(borrowed, gemini)).toThrow(InvalidOutputCapPlanError);
    expect(() => ownedRequestSupportReason(raw, gemini, supports)).toThrow(
      InvalidOutputCapPlanError,
    );
    expect(() =>
      ownedRequestSupportReason(owned, { ...gemini, endpoint: 'custom' }, supports),
    ).toThrow(InvalidOutputCapPlanError);
  });

  it('retains the exact measured plan and its serializer-once authority', () => {
    let amount = 200_000;
    const serializer = vi.fn((key: string) => (key === 'max_completion_tokens' ? amount : 1));
    const options = { max_completion_tokens: { toJSON: serializer } };
    const plan = prepareOutputCapPlan({
      ...openai,
      maxTokens: undefined,
      providerOptions: options,
    });
    amount = 1;
    const owned = ownLlmRequest(
      { ...base(), providerOptions: options, preparedOutputCaps: [plan] },
      [openai],
    );
    const selected = selectOwnedRequest(owned, openai);
    expect(selected.plan).toBe(plan);
    expect(outputCapPlanForRequest(selected.request, 'openai', 'official')).toBe(plan);
    expect(outputTokensReservation(plan, 1)).toBe(200_000);
    expect(serializer).toHaveBeenCalledTimes(1);
    mutableOwnedRequest(selected.request);
    withOwnedRequestSignal(selected.request, new AbortController().signal);
    expect(serializer).toHaveBeenCalledTimes(1);
  });

  it.each([
    'changed-native',
    'changed-canonical',
    'changed-presence',
    'changed-model',
    'changed-provider',
    'changed-endpoint',
    'forged-plan',
  ])('refuses %s before projection can mask the original mismatch', (change) => {
    const options: Record<string, unknown> = { max_tokens: undefined };
    const plan = prepareOutputCapPlan({ ...openai, maxTokens: 100, providerOptions: options });
    const request = {
      ...base(),
      maxTokens: 100,
      providerOptions: options,
      preparedOutputCaps: [plan],
    };
    let candidate = openai;
    if (change === 'changed-native') options['max_tokens'] = 1;
    if (change === 'changed-canonical') request.maxTokens = 101;
    if (change === 'changed-presence') delete options['max_tokens'];
    if (change === 'changed-model') candidate = { ...openai, model: 'other' };
    if (change === 'changed-provider') candidate = { ...openai, provider: 'gemini' };
    if (change === 'changed-endpoint') candidate = { ...openai, endpoint: 'custom' };
    if (change === 'forged-plan') request.preparedOutputCaps = [{ ...plan }];
    expect(() => ownLlmRequest(request, [candidate])).toThrow(InvalidOutputCapPlanError);
  });

  it('does not grant a borrowed primary projection authority for a foreign dialect', () => {
    const original = {
      ...base(),
      maxTokens: 100,
      providerOptions: {
        max_tokens: { toJSON: () => 200 },
        maxOutputTokens: { toJSON: () => 300 },
      },
    };
    const owned = ownLlmRequest(original, [openai, gemini]);
    const primary = selectOwnedRequest(owned, openai);
    expect(selectOwnedRequest(primary.request, gemini).plan.effectiveCap).toBe(100);
    expect(() => selectOwnedRequest({ ...primary.request }, gemini)).toThrow(
      InvalidOutputCapPlanError,
    );
    expect(() => mutableOwnedRequest({ ...primary.request })).toThrow(InvalidOutputCapPlanError);
    // Ordinary measured-plan intake is allowed, but the captured primary has lost foreign raw controls.
    const borrowed = { ...primary.request, preparedOutputCaps: [primary.plan] };
    const newOwner = ownLlmRequest(borrowed, [openai, gemini]);
    expect(selectOwnedRequest(newOwner, openai).plan).toBe(primary.plan);
    expect(() => selectOwnedRequest(newOwner, gemini)).toThrow(InvalidOutputCapPlanError);
  });

  it('retains discarded opaque caps and outer serializer behavior without generic traversal', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    const outer = vi.fn(() => {
      throw new Error('private serializer');
    });
    const owned = ownLlmRequest(
      {
        ...base(),
        maxTokens: 100,
        providerOptions: {
          max_tokens: cycle,
          toJSON: outer,
          temperature: 0.2,
        },
      },
      [openai],
    );
    const selected = selectOwnedRequest(owned, openai);
    expect(selected.request.providerOptions).toEqual({ max_tokens: undefined, temperature: 0.2 });
    expect(outputCapNativeOptions(selected.plan, selected.request.providerOptions)).toEqual({
      temperature: 0.2,
    });
    expect(outer).not.toHaveBeenCalled();
  });

  it('allows cap JSON exception keys without granting the exception to ordinary options', () => {
    const data: unknown = JSON.parse('{"__proto__":{"safe":true},"nested":[1,2]}');
    const owned = ownLlmRequest(
      { ...base(), providerOptions: { max_tokens: { toJSON: () => data } } },
      [openai],
    );
    const selected = selectOwnedRequest(owned, openai).request;
    const copy = mutableOwnedRequest(selected);
    expect(JSON.stringify(copy.providerOptions)).toBe(JSON.stringify(selected.providerOptions));
    expect(Object.hasOwn(copy.providerOptions?.['max_tokens'] ?? {}, '__proto__')).toBe(true);
    const options: Record<string, unknown> = {};
    Object.defineProperty(options, '__proto__', { value: data, enumerable: true });
    expect(() => ownLlmRequest({ ...base(), providerOptions: options }, [openai])).toThrow(
      UnsupportedRequestDataError,
    );
  });

  it('refuses unsupported non-cap data synchronously, without invoking getters or leaking content', () => {
    const getter = vi.fn(() => {
      throw new Error('secret payload');
    });
    const options = {};
    Object.defineProperty(options, 'private-name', { get: getter, enumerable: true });
    let afterCapture = false;
    const run = (): void => {
      ownLlmRequest({ ...base(), providerOptions: options }, [openai]);
      afterCapture = true;
    };
    expect(run).toThrow(UnsupportedRequestDataError);
    expect(afterCapture).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    try {
      run();
    } catch (error) {
      expect(error).toMatchObject({ name: 'UnsupportedRequestDataError' });
      expect(String(error)).not.toMatch(/secret|private-name/);
      expect(field(error, 'cause')).toBeUndefined();
    }
  });

  it('keeps cancellation live and trusted effort omission bound to the same cap authority', () => {
    const caller = new AbortController();
    const replacement = new AbortController();
    const owned = ownLlmRequest({ ...base(), signal: caller.signal, reasoningEffort: 'high' }, [
      openai,
      gemini,
    ]);
    const selected = selectOwnedRequest(owned, openai);
    expect(selectOwnedRequest(owned, gemini).request.messages).toBe(selected.request.messages);
    expect(selected.request.signal).toBe(caller.signal);
    const overlaid = withOwnedRequestSignal(selected.request, replacement.signal);
    expect(overlaid.messages).toBe(selected.request.messages);
    expect(overlaid.providerOptions).toBe(selected.request.providerOptions);
    replacement.abort();
    expect(overlaid.signal?.aborted).toBe(true);
    expect(selected.request.signal?.aborted).toBe(false);
    expect(outputCapPlanForRequest(overlaid, 'openai', 'official')).toBe(selected.plan);
    const stripped = withoutOwnedRequestEffort(overlaid);
    expect(stripped.messages).toBe(overlaid.messages);
    expect(Object.hasOwn(stripped, 'reasoningEffort')).toBe(false);
    expect(selected.request.reasoningEffort).toBe('high');
    expect(selectOwnedRequest(stripped, gemini).request.signal).toBe(replacement.signal);
    expect(() => withOwnedRequestSignal({ ...overlaid }, caller.signal)).toThrow(
      InvalidOutputCapPlanError,
    );
  });

  it('captures deep acyclic and shared ignored data without recursion or expansion', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let index = 0; index < 15_000; index += 1) deep = { next: deep };
    let shared: Record<string, unknown> = {};
    for (let index = 0; index < 100; index += 1) shared = { left: shared, right: shared };
    const owned = ownLlmRequest({ ...base(), providerOptions: { deep, shared } }, [openai]);
    const selected = selectOwnedRequest(owned, openai).request;
    const working = mutableOwnedRequest(selected);
    const node = working.providerOptions?.['shared'];
    expect(field(node, 'left')).toBe(field(node, 'right'));
    let cursor = working.providerOptions?.['deep'];
    for (let index = 0; index < 15_000; index += 1) cursor = field(cursor, 'next');
    expect(field(cursor, 'end')).toBe(true);
  });

  it('owns fresh trusted message derivations without recapturing plans or borrowing metadata', () => {
    const schema = { type: 'object' };
    const original: LlmRequest = {
      ...base(),
      providerOptions: { shared: schema },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'private reasoning' },
            { type: 'tool_call', id: 'call', name: 'tool', args: schema },
          ],
        },
      ],
    };
    const selected = selectOwnedRequest(ownLlmRequest(original, [openai, gemini]), openai);
    const messages = selected.request.messages.map((message) => ({
      ...message,
      content: message.content.filter((part) => part.type !== 'reasoning'),
    }));
    const derived = deriveOwnedRequestMessages(selected.request, { route: 'reasoning', messages });
    messages[0]?.content.push({ type: 'text', text: 'later mutation' });
    expect(derived.messages[0]?.content).toHaveLength(1);
    const call = derived.messages[0]?.content[0];
    expect(call?.type === 'tool_call' && call.args).toBe(derived.providerOptions?.['shared']);
    expect(outputCapPlanForRequest(derived, 'openai', 'official')).toBe(selected.plan);
    expect(selectOwnedRequest(derived, gemini).request.messages[0]?.content).toHaveLength(1);
    expect(() =>
      deriveOwnedRequestMessages({ ...selected.request }, { route: 'media', messages }),
    ).toThrow(InvalidOutputCapPlanError);
  });

  it('inspects transparent request and genuine-plan array proxies without ordinary reads', () => {
    const plan = prepareOutputCapPlan({
      ...openai,
      maxTokens: undefined,
      providerOptions: undefined,
    });
    const read = vi.fn(() => {
      throw new Error('private ordinary read');
    });
    const plans = new Proxy([plan], { get: read });
    const request = new Proxy({ ...base(), preparedOutputCaps: plans }, { get: read });
    const selected = selectOwnedRequest(ownLlmRequest(request, [openai]), openai);
    expect(selected.plan).toBe(plan);
    expect(read).not.toHaveBeenCalled();
    expect(prepareOwnedRequest(request, 'openai', 'official').plan).toBe(plan);
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a direct-adapter model accessor as unsupported data without invoking it', () => {
    const read = vi.fn(() => openai.model);
    const request = base();
    Object.defineProperty(request, 'model', { get: read, enumerable: true });
    expect(() => prepareOwnedRequest(request, 'openai', 'official')).toThrow(
      UnsupportedRequestDataError,
    );
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['hole', 'accessor', 'nonenumerable', 'extra', 'symbol'])(
    'refuses %s metadata in the genuine-plan array without executing accessors',
    (kind) => {
      const plan = prepareOutputCapPlan({
        ...openai,
        maxTokens: undefined,
        providerOptions: undefined,
      });
      const plans = [plan];
      const read = vi.fn(() => plan);
      if (kind === 'hole') Reflect.deleteProperty(plans, '0');
      if (kind === 'accessor') Object.defineProperty(plans, '0', { get: read });
      if (kind === 'nonenumerable')
        Object.defineProperty(plans, '0', { value: plan, enumerable: false });
      if (kind === 'extra') Object.defineProperty(plans, 'private', { value: true });
      if (kind === 'symbol') Object.defineProperty(plans, Symbol('private'), { value: true });
      expect(() => ownLlmRequest({ ...base(), preparedOutputCaps: plans }, [openai])).toThrow(
        InvalidOutputCapPlanError,
      );
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('preserves captured measured ceilings across catalog refresh and candidate reuse', () => {
    const model = 'owned-request-cap-fixture';
    const candidate = { ...openai, model };
    installCatalogRefresh({
      [model]: catalogModelFixture({ modelId: model, maxOutputTokens: 1024 }),
    });
    const plan = prepareOutputCapPlan({
      ...candidate,
      maxTokens: 4096,
      providerOptions: undefined,
    });
    installCatalogRefresh({
      [model]: catalogModelFixture({ modelId: model, maxOutputTokens: 8192 }),
    });
    const selected = selectOwnedRequest(
      ownLlmRequest({ ...base(), model, maxTokens: 4096, preparedOutputCaps: [plan] }, [candidate]),
      candidate,
    );
    expect(selected.plan).toBe(plan);
    expect(outputTokensReservation(selected.plan, 1)).toBe(1024);
    expect(
      selectOwnedRequest(ownLlmRequest(selected.request, [candidate]), candidate).request,
    ).toBe(selected.request);
    expect(
      outputCapPlanForRequest(
        withOwnedRequestSignal(selected.request, undefined),
        'openai',
        'official',
      ),
    ).toBe(plan);
  });

  it('captures stateful serializers per configured dialect before awaiting, including unused candidates', async () => {
    let next = 500_000;
    const keys: string[] = [];
    const modern = {
      toJSON: (key: string) => {
        keys.push(key);
        return next++;
      },
    };
    const google = {
      toJSON: (key: string) => {
        keys.push(key);
        return next++;
      },
    };
    const deepseek: RequestCandidate = {
      model: 'deepseek-chat',
      provider: 'deepseek',
      endpoint: 'official',
    };
    const anthropic: RequestCandidate = {
      model: 'claude-sonnet-4',
      provider: 'anthropic',
      endpoint: 'official',
    };
    const owned = ownLlmRequest(
      {
        ...base(),
        providerOptions: {
          max_completion_tokens: modern,
          maxOutputTokens: google,
        },
      },
      [openai, gemini, deepseek, anthropic],
    );
    const capturedKeys = [...keys];
    expect(capturedKeys).toEqual([
      'max_completion_tokens',
      'maxOutputTokens',
      'maxOutputTokens',
      'max_completion_tokens',
      'maxOutputTokens',
      'max_completion_tokens',
      'maxOutputTokens',
    ]);
    await Promise.resolve();
    next = 1;
    expect(selectOwnedRequest(owned, openai).plan.effectiveCap).toBe(500_000);
    expect(selectOwnedRequest(owned, gemini).plan.effectiveCap).toBe(500_002);
    expect(selectOwnedRequest(owned, deepseek).plan.effectiveCap).toBeUndefined();
    expect(selectOwnedRequest(owned, anthropic).plan.effectiveCap).toBe(4096);
    expect(outputTokensReservation(selectOwnedRequest(owned, deepseek).plan, 17)).toBe(17);
    expect(keys).toEqual(capturedKeys);
  });

  it('refuses canonical executable data before cap arithmetic or serializer execution', () => {
    const conversion = vi.fn(() => 100);
    const serializer = vi.fn(() => 200);
    const request = { ...base(), providerOptions: { max_tokens: { toJSON: serializer } } };
    Object.defineProperty(request, 'maxTokens', {
      value: { valueOf: conversion },
      enumerable: true,
    });
    expect(() => ownLlmRequest(request, [openai])).toThrow(UnsupportedRequestDataError);
    expect(conversion).not.toHaveBeenCalled();
    expect(serializer).not.toHaveBeenCalled();
    const invalidModel = { ...base(), providerOptions: request.providerOptions };
    Object.defineProperty(invalidModel, 'model', {
      value: { toString: conversion },
      enumerable: true,
    });
    expect(() => prepareOwnedRequest(invalidModel, 'openai', 'official')).toThrow(
      UnsupportedRequestDataError,
    );
    expect(conversion).not.toHaveBeenCalled();
    expect(serializer).not.toHaveBeenCalled();
  });

  it('captures duplicate configured identities once and refuses ambiguous incoming plan lists', () => {
    let next = 10;
    const serializer = vi.fn(() => next++);
    const options = { max_completion_tokens: { toJSON: serializer } };
    const owned = ownLlmRequest({ ...base(), providerOptions: options }, [openai, { ...openai }]);
    expect(owned.candidates).toHaveLength(1);
    const selected = selectOwnedRequest(owned, openai);
    expect(selectOwnedRequest(owned, { ...openai }).request).toBe(selected.request);
    expect(selected.plan.effectiveCap).toBe(10);
    expect(serializer).toHaveBeenCalledTimes(1);
    expect(() =>
      ownLlmRequest(
        { ...base(), providerOptions: options, preparedOutputCaps: [selected.plan, selected.plan] },
        [openai],
      ),
    ).toThrow(InvalidOutputCapPlanError);
    expect(serializer).toHaveBeenCalledTimes(1);
  });

  it('refuses true cycles through provider options and aliases in either root-property order', () => {
    for (const aliasFirst of [false, true]) {
      const options: Record<string, unknown> = { max_tokens: 100 };
      options['self'] = options;
      const request = aliasFirst
        ? { ...base(), future: options, providerOptions: options }
        : { ...base(), providerOptions: options, future: options };
      expect(() => ownLlmRequest(request, [openai])).toThrow(UnsupportedRequestDataError);
    }
  });

  it('retains undefined arguments/results and repeated Map/Set property aliases through working copies', () => {
    const map = new Map<unknown, unknown>();
    map.set(map, map);
    const set = new Set<unknown>();
    set.add(set);
    const shared = { retained: true };
    Object.defineProperty(map, 'shared', { value: shared, enumerable: true });
    Object.defineProperty(set, 'shared', { value: shared, enumerable: true });
    const request: LlmRequest = {
      ...base(),
      messages: [
        {
          role: 'tool',
          content: [
            { type: 'tool_call', id: 'call', name: 'tool', args: undefined },
            { type: 'tool_result', toolCallId: 'call', result: undefined },
            { type: 'tool_result', toolCallId: 'map', result: map },
          ],
        },
      ],
      providerOptions: { map, set, shared },
    };
    const selected = prepareOwnedRequest(request, 'openai', 'official').request;
    const working = mutableOwnedRequest(selected);
    const [call, result, mapped] = working.messages[0]?.content ?? [];
    expect(Object.hasOwn(call ?? {}, 'args')).toBe(true);
    expect(field(call, 'args')).toBeUndefined();
    expect(Object.hasOwn(result ?? {}, 'result')).toBe(true);
    expect(field(result, 'result')).toBeUndefined();
    expect(field(mapped, 'result')).toBe(working.providerOptions?.['map']);
    expect(field(working.providerOptions?.['map'], 'shared')).toBe(
      working.providerOptions?.['shared'],
    );
    expect(field(working.providerOptions?.['set'], 'shared')).toBe(
      working.providerOptions?.['shared'],
    );
    expect(Object.getPrototypeOf(working.providerOptions?.['map'])).toBeNull();
  });
});
