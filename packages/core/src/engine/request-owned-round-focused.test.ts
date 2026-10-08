import { describe, expect, it } from 'vitest';
import {
  ownLlmRequest,
  ownedRequestShape,
  withoutOwnedRequestTools,
  selectOwnedRequest,
  prepareOutputCapPlan,
  installCatalogRefresh,
  clearCatalogRefresh,
  InvalidOutputCapPlanError,
  UnsupportedRequestDataError,
  estimateRequestTokens,
  type LlmRequest,
  type LlmProvider,
  type StreamChunk,
  type PricingOverlay,
} from '@relavium/llm';
import { unwiredEffectJournal } from '@relavium/shared';
import { markUntrusted } from '../tools/untrusted.js';
import { authoredSystemPrompt } from './authored-system-prompt.js';
import {
  prepareAgentTurnRequest,
  runAgentTurn,
  type AgentTurnParams,
  type PreEgressInfo,
} from './agent-turn.js';
import { quoteBudgetAllowance } from './budget-allowance.js';
import { BudgetGovernor } from './budget-governor.js';

function latch() {
  let resolve: () => void = () => {
    throw new Error('uninitialized latch');
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function provider(id: 'openai' | 'gemini' = 'openai'): LlmProvider {
  return {
    id,
    customEndpoint: true,
    supports: {
      tools: true,
      streaming: true,
      parallelToolCalls: true,
      vision: false,
      promptCache: false,
      reasoning: true,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [['image']],
      },
    },
    generate: () =>
      Promise.resolve({
        content: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'stop',
      }),
    stream: async function* (): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}
function params(p: LlmProvider, patch: Partial<AgentTurnParams> = {}): AgentTurnParams {
  return {
    nodeId: 'n',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'original' }] }],
    planEntries: [{ provider: p, model: 'owned-model', maxAttempts: 1 }],
    chainCapabilities: { keyFor: () => 'offline-key', sleep: () => Promise.resolve() },
    signal: new AbortController().signal,
    emit: () => undefined,
    registry: {
      has: () => true,
      list: () => ['echo'],
      dispatch: (call) =>
        Promise.resolve({
          output: 'x'.repeat(1000),
          truncated: false,
          mediaAttachments: markUntrusted([]),
          toolResult: markUntrusted({
            type: 'tool_result',
            toolCallId: call.id,
            result: 'x'.repeat(1000),
          }),
          events: {
            call: { toolId: call.name, toolInput: {} },
            result: { toolId: call.name, success: true, outputSummary: 'done' },
          },
        }),
    },
    dispatchContext: {
      nodeId: 'n',
      grantedToolIds: new Set(['echo']),
      config: {},
      toolPolicy: {},
      fsScope: 'sandboxed',
      gateApproved: false,
      effects: unwiredEffectJournal(),
      effectSlot: 0,
    },
    limits: { maxToolTurns: 2, maxToolCorrections: 0 },
    ...patch,
  };
}
const prices: PricingOverlay = new Map(
  ['a', 'b'].map((model) => [
    model,
    {
      provider: 'openai',
      nativeId: model,
      displayName: model,
      contextWindowTokens: 10000,
      maxOutputTokens: 10000,
      inputPerMtokMicrocents: 1000000,
      outputPerMtokMicrocents: 1000000,
      cachedInputPerMtokMicrocents: 0,
    },
  ]),
);

describe('owned core round identity and authority (ADR-0102)', () => {
  it('owns later tool-round static fields and fresh tool results before each admission', async () => {
    const p = provider();
    const calls: LlmRequest[] = [];
    const infos: PreEgressInfo[] = [];
    const tool = {
      name: 'echo',
      description: 'original tool',
      parameters: { type: 'object' as const, description: 'original schema' },
    };
    const schema = { type: 'object' as const, description: 'original response' };
    const source = params(p, {
      system: authoredSystemPrompt({ kind: 'engine', prompt: 'compaction' }),
      tools: [tool],
      responseFormat: { type: 'json', schema },
      maxTokens: 20,
    });
    p.stream = async function* (request): AsyncGenerator<StreamChunk> {
      calls.push(request);
      await Promise.resolve();
      if (calls.length === 1) {
        yield { type: 'tool_call_start', id: 'c', name: 'echo' };
        yield { type: 'tool_call_end', id: 'c' };
        yield { type: 'stop', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } };
      } else yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const first = prepareAgentTurnRequest(source);
    await runAgentTurn({
      ...source,
      preparedRequest: first.request,
      preEgress: (info) => {
        infos.push(info);
        tool.description = 'mutated';
        tool.parameters.description = 'mutated';
        schema.description = 'mutated';
        const part = source.messages[0]?.content[0];
        if (part?.type === 'text') part.text = 'mutated';
      },
    });
    expect(calls).toHaveLength(2);
    expect(infos).toHaveLength(2);
    for (const request of calls) {
      expect(request.system).toBe(first.request.system);
      expect(request.tools?.[0]?.description).toBe('original tool');
      expect(request.responseFormat).toEqual({
        type: 'json',
        schema: { type: 'object', description: 'original response' },
      });
      expect(request.messages[0]?.content[0]).toEqual({ type: 'text', text: 'original' });
      expect(Object.isFrozen(request)).toBe(true);
    }
    expect(calls[1]?.messages).not.toBe(calls[0]?.messages);
    expect(infos[0]?.inputTokensEstimate).toBe(first.inputTokensEstimate);
    expect(infos[1]?.inputTokensEstimate).toBeGreaterThan(first.inputTokensEstimate);
    for (const info of infos) {
      const context = info.allowanceQuoteContext;
      if (context?.route !== 'text') throw new Error('missing context');
      expect(
        estimateRequestTokens({ ...context.request, system: context.request.system ?? '' }),
      ).toBe(info.inputTokensEstimate);
    }
  });

  it('quotes heterogeneous native plans from one owner and preserves it in the real governor pause', async () => {
    const a = provider();
    const b = provider('gemini');
    const entries = [
      { provider: a, model: 'a', maxAttempts: 1 },
      { provider: b, model: 'b', maxAttempts: 2 },
    ];
    const candidates = entries.map((entry) => ({
      provider: entry.provider.id,
      model: entry.model,
      endpoint: 'custom' as const,
    }));
    let captures = 0;
    const raw: LlmRequest = {
      model: 'a',
      messages: [],
      providerOptions: {
        max_completion_tokens: {
          toJSON: () => {
            captures += 1;
            return 70;
          },
        },
        maxOutputTokens: 90,
      },
    };
    const firstCandidate = candidates[0];
    if (firstCandidate === undefined) throw new Error('missing candidate');
    const first = selectOwnedRequest(ownLlmRequest(raw, candidates), firstCandidate);
    const context = {
      route: 'text' as const,
      entries,
      request: first.request,
      inputTokensEstimate: 1,
      maxTokensEstimate: undefined,
      maxToolTurns: 0,
    };
    const quote = quoteBudgetAllowance({ ...context, strictCostCap: false, overlay: prices });
    expect(quote.kind).toBe('quoted');
    if (quote.kind !== 'quoted') throw new Error('missing quote');
    expect(
      quote.quote.provenance.entries.map((entry) => entry.estimate.basis.outputTokensReservation),
    ).toEqual([70, 90]);
    const governor = new BudgetGovernor({
      budget: { max_cost_microcents: 1, on_exceed: 'pause_for_approval' },
      resolvePrice: prices,
      emit: () => Promise.resolve(),
    });
    await expect(
      governor.checkPreEgress({
        ...first.plan,
        route: 'text',
        outputCapPlan: first.plan,
        inputTokensEstimate: 1,
        maxTokensEstimate: undefined,
        allowanceQuoteContext: context,
      }),
    ).rejects.toMatchObject({ allowanceQuote: quote });
    const fallbackCandidate = candidates[1];
    if (fallbackCandidate === undefined) throw new Error('missing fallback');
    const fallbackPlan = selectOwnedRequest(first.request, fallbackCandidate).plan;
    for (const plans of [undefined, [], [fallbackPlan]]) {
      const legacy = new BudgetGovernor({
        budget: { max_cost_microcents: 1, on_exceed: 'pause_for_approval' },
        resolvePrice: prices,
        emit: () => Promise.resolve(),
      });
      await expect(
        legacy.checkPreEgress({
          ...first.plan,
          route: 'text',
          outputCapPlan: first.plan,
          inputTokensEstimate: 1,
          maxTokensEstimate: undefined,
          allowanceQuoteContext: {
            ...context,
            request: { ...raw, ...(plans === undefined ? {} : { preparedOutputCaps: plans }) },
          },
        }),
      ).rejects.toMatchObject({ allowanceQuote: quote });
    }
    expect(captures).toBe(1);
    expect(() =>
      quoteBudgetAllowance({
        ...context,
        request: { ...first.request },
        strictCostCap: false,
        overlay: prices,
      }),
    ).toThrow(InvalidOutputCapPlanError);
  });

  it('does not exclude an applicable failed candidate cap but skips an unsupported one', () => {
    const a = provider('gemini');
    const b = provider();
    const entries = [
      { provider: a, model: 'a', maxAttempts: 1 },
      { provider: b, model: 'b', maxAttempts: 1 },
    ];
    const raw: LlmRequest = {
      model: 'a',
      messages: [],
      tools: [{ name: 'echo', description: 'd', parameters: { type: 'object' } }],
      providerOptions: {
        maxOutputTokens: 90,
        max_completion_tokens: {
          toJSON: () => {
            throw new Error('private');
          },
        },
      },
    };
    const context = {
      route: 'text' as const,
      entries,
      request: raw,
      inputTokensEstimate: 1,
      maxTokensEstimate: undefined,
      maxToolTurns: 0,
      strictCostCap: false,
      overlay: prices,
    };
    expect(() => quoteBudgetAllowance(context)).toThrow(InvalidOutputCapPlanError);
    b.supports.tools = false;
    expect(quoteBudgetAllowance(context)).toMatchObject({
      kind: 'quoted',
      quote: { excludedEntries: [{ index: 1, reason: 'unsupported' }] },
    });
  });

  it.each(['prepared', 'direct'] as const)(
    '%s refuses unsupported local data without touching admission, money, or keys',
    async (route) => {
      const calls = { admission: 0, money: 0, key: 0 };
      const p = provider();
      const source = params(p, {
        messages: [
          { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'c', result: new Date() }] },
        ],
        preEgress: () => {
          calls.admission += 1;
        },
        money: {
          join: () => {
            calls.money += 1;
            return Promise.resolve();
          },
          record: () => undefined,
        },
        chainCapabilities: {
          keyFor: () => {
            calls.key += 1;
            return 'offline';
          },
          sleep: () => Promise.resolve(),
        },
      });
      const expected = {
        code: 'validation',
        retryable: false,
        message: new UnsupportedRequestDataError().message,
      };
      if (route === 'prepared') {
        let refusal: unknown;
        try {
          prepareAgentTurnRequest(source);
        } catch (error) {
          refusal = error;
        }
        expect(refusal).toMatchObject(expected);
      } else await expect(runAgentTurn(source)).rejects.toMatchObject(expected);
      expect(calls).toEqual({ admission: 0, money: 0, key: 0 });
    },
  );

  it('refuses a spread that borrows the prepared request identity', async () => {
    const source = params(provider());
    const first = prepareAgentTurnRequest(source);
    await expect(
      runAgentTurn({ ...source, preparedRequest: { ...first.request } }),
    ).rejects.toMatchObject({ code: 'validation', retryable: false });
  });

  it('overlays the execution signal and live cancellation releases admission before key resolution', async () => {
    const original = new AbortController();
    const execution = new AbortController();
    let keys = 0;
    let released = 0;
    const source = params(provider(), {
      signal: original.signal,
      chainCapabilities: {
        keyFor: () => {
          keys += 1;
          return 'offline';
        },
        sleep: () => Promise.resolve(),
      },
    });
    const first = prepareAgentTurnRequest(source);
    original.abort();
    const entered = latch();
    const resume = latch();
    const active = runAgentTurn({
      ...source,
      preparedRequest: first.request,
      signal: execution.signal,
      preEgress: async () => {
        entered.resolve();
        await resume.promise;
        return {
          settle: () => undefined,
          release: () => {
            released += 1;
          },
          settleAtReservedEstimate: () => undefined,
        };
      },
    });
    const observed = active.then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    execution.abort();
    resume.resolve();
    expect(await observed).toMatchObject({ code: 'cancelled' });
    expect(released).toBe(1);
    expect(keys).toBe(0);
  });
  it('keeps a pre-existing cancellation ahead of local unsupported-data inspection', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runAgentTurn(
        params(provider(), {
          signal: controller.signal,
          messages: [
            {
              role: 'tool',
              content: [{ type: 'tool_result', toolCallId: 'c', result: new Date() }],
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'cancelled', retryable: false });
  });
  it.each(['tools', 'outputModalities'] as const)(
    'sizes a raw quote from owned %s when a cap serializer mutates the caller',
    (field) => {
      const tools = [
        { name: 'echo', description: 'original', parameters: { type: 'object' as const } },
      ];
      const outputModalities: ('text' | 'image')[] = ['text'];
      const request: LlmRequest = {
        model: 'a',
        messages: [],
        tools,
        outputModalities,
        providerOptions: {
          max_completion_tokens: {
            toJSON: () => {
              if (field === 'tools') tools.length = 0;
              else outputModalities.push('image');
              return 70;
            },
          },
        },
      };
      const quote = quoteBudgetAllowance({
        route: 'text',
        entries: [{ provider: provider(), model: 'a', maxAttempts: 1 }],
        request,
        inputTokensEstimate: 1,
        maxTokensEstimate: undefined,
        maxToolTurns: 2,
        strictCostCap: false,
        overlay: prices,
      });
      expect(quote).toMatchObject({
        kind: 'quoted',
        quote: { amount: { kind: 'representable', microcents: 213 }, provenance: { calls: 3 } },
      });
      expect(field === 'tools' ? tools.length : outputModalities.length).toBe(
        field === 'tools' ? 0 : 2,
      );
    },
  );

  it('exposes only immutable owned quote shape, including when every cap capture fails', () => {
    const raw: LlmRequest = {
      model: 'a',
      messages: [],
      tools: [{ name: 'echo', description: 'd', parameters: { type: 'object' } }],
      outputModalities: ['text'],
      providerOptions: {
        max_completion_tokens: {
          toJSON: () => {
            throw new Error('private');
          },
        },
      },
    };
    const candidate = { model: 'a', provider: 'openai', endpoint: 'custom' } as const;
    const owned = ownLlmRequest(raw, [candidate]);
    const shape = ownedRequestShape(owned);
    expect(Object.keys(shape).sort()).toEqual(['outputModalities', 'tools']);
    expect(Object.isFrozen(shape)).toBe(true);
    expect(Object.isFrozen(shape.tools)).toBe(true);
    expect(Object.isFrozen(shape.outputModalities)).toBe(true);
    expect(() => selectOwnedRequest(owned, candidate)).toThrow(InvalidOutputCapPlanError);
    expect(() => ownedRequestShape({ ...owned })).toThrow(InvalidOutputCapPlanError);
    expect(() => ownedRequestShape(raw)).toThrow(InvalidOutputCapPlanError);
  });

  it.each(['system', 'messages', 'tools', 'providerOptions', 'preparedOutputCaps'] as const)(
    'refuses a raw legacy %s getter before invoking it or publishing a money event',
    async (field) => {
      let reads = 0;
      let events = 0;
      const candidate = { model: 'a', provider: 'openai', endpoint: 'custom' } as const;
      const plan = prepareOutputCapPlan({
        ...candidate,
        maxTokens: 70,
        providerOptions: undefined,
      });
      const request: LlmRequest = { model: 'a', messages: [], maxTokens: 70 };
      Object.defineProperty(request, field, {
        enumerable: true,
        get: () => {
          reads += 1;
          throw new Error('private credential sentinel');
        },
      });
      const context = {
        route: 'text' as const,
        entries: [{ provider: provider(), model: 'a', maxAttempts: 1 }],
        request,
        inputTokensEstimate: 1,
        maxTokensEstimate: undefined,
        maxToolTurns: 0,
      };
      expect(() =>
        quoteBudgetAllowance({ ...context, strictCostCap: false, overlay: prices }),
      ).toThrow(UnsupportedRequestDataError);
      const governor = new BudgetGovernor({
        budget: { max_cost_microcents: 1, on_exceed: 'pause_for_approval' },
        resolvePrice: prices,
        emit: () => {
          events += 1;
          return Promise.resolve();
        },
      });
      await expect(
        governor.checkPreEgress({
          ...plan,
          route: 'text',
          outputCapPlan: plan,
          inputTokensEstimate: 1,
          maxTokensEstimate: undefined,
          allowanceQuoteContext: context,
        }),
      ).rejects.toMatchObject({
        name: 'UnsupportedRequestDataError',
        message: new UnsupportedRequestDataError().message,
      });
      expect(reads).toBe(0);
      expect(events).toBe(0);
    },
  );

  it.each(['symbol', 'hidden', 'prototype'] as const)(
    'does not launder %s metadata when supplying the paused plan',
    (kind) => {
      const candidate = { model: 'a', provider: 'openai', endpoint: 'custom' } as const;
      const plan = prepareOutputCapPlan({
        ...candidate,
        maxTokens: 70,
        providerOptions: undefined,
      });
      const request: LlmRequest = { model: 'a', messages: [], maxTokens: 70 };
      if (kind === 'prototype') Object.setPrototypeOf(request, { hidden: true });
      else
        Object.defineProperty(request, kind === 'symbol' ? Symbol('metadata') : 'metadata', {
          value: 'private',
          enumerable: kind === 'symbol',
        });
      expect(() => ownLlmRequest(request, [candidate], plan)).toThrow(UnsupportedRequestDataError);
    },
  );

  it('refuses borrowed, substituted, stale, and wrongly bound supplied attempt plans', () => {
    const candidate = { model: 'a', provider: 'openai', endpoint: 'custom' } as const;
    let captures = 0;
    const options = {
      max_completion_tokens: {
        toJSON: () => {
          captures += 1;
          return 70;
        },
      },
    };
    const raw: LlmRequest = { model: 'a', messages: [], providerOptions: options };
    const first = selectOwnedRequest(ownLlmRequest(raw, [candidate]), candidate);
    expect(() => ownLlmRequest(raw, [candidate], first.plan)).not.toThrow();
    expect(() => ownLlmRequest(first.request, [candidate], first.plan)).not.toThrow();
    expect(captures).toBe(1);
    expect(() => ownLlmRequest(raw, [candidate], { ...first.plan })).toThrow(
      InvalidOutputCapPlanError,
    );
    expect(() => ownLlmRequest({ ...first.request }, [candidate], first.plan)).toThrow(
      InvalidOutputCapPlanError,
    );
    const other = prepareOutputCapPlan({
      ...candidate,
      maxTokens: undefined,
      providerOptions: options,
    });
    expect(() => ownLlmRequest(first.request, [candidate], other)).toThrow(
      InvalidOutputCapPlanError,
    );
    expect(() =>
      ownLlmRequest({ ...raw, preparedOutputCaps: [first.plan] }, [candidate], other),
    ).toThrow(InvalidOutputCapPlanError);
    expect(() => ownLlmRequest({ ...raw, maxTokens: 80 }, [candidate], first.plan)).toThrow(
      InvalidOutputCapPlanError,
    );
    expect(() =>
      ownLlmRequest(
        { ...raw, providerOptions: { ...options, max_tokens: undefined } },
        [candidate],
        first.plan,
      ),
    ).toThrow(InvalidOutputCapPlanError);
    for (const wrong of [
      { ...candidate, model: 'b' },
      { ...candidate, provider: 'gemini' as const },
      { ...candidate, endpoint: 'official' as const },
    ]) {
      expect(() => ownLlmRequest(raw, [wrong], first.plan)).toThrow(InvalidOutputCapPlanError);
      expect(() => ownLlmRequest(first.request, [wrong], first.plan)).toThrow(
        InvalidOutputCapPlanError,
      );
    }
    expect(captures).toBe(2);
  });

  it.each(
    (['messages', 'tools', 'outputModalities'] as const).flatMap((field) =>
      (['accessor', 'hidden', 'symbol'] as const).map((kind) => ({ field, kind })),
    ),
  )('validates original $field array $kind before any execution', async ({ field, kind }) => {
    let reads = 0;
    let effects = 0;
    const source = params(provider(), {
      tools: [{ name: 'echo', description: 'd', parameters: { type: 'object' } }],
      outputModalities: ['text'],
      preEgress: () => {
        effects += 1;
      },
      money: {
        join: () => {
          effects += 1;
          return Promise.resolve();
        },
        record: () => undefined,
      },
      chainCapabilities: {
        keyFor: () => {
          effects += 1;
          return 'offline';
        },
        sleep: () => Promise.resolve(),
      },
    });
    const array = source[field];
    if (array === undefined) throw new Error('missing array');
    if (kind === 'accessor')
      Object.defineProperty(array, '0', {
        enumerable: true,
        get: () => {
          reads += 1;
          throw new Error('private credential sentinel');
        },
      });
    else
      Object.defineProperty(array, kind === 'symbol' ? Symbol('metadata') : 'metadata', {
        value: 'private',
        enumerable: kind === 'symbol',
      });
    await expect(runAgentTurn(source)).rejects.toMatchObject({
      code: 'validation',
      message: new UnsupportedRequestDataError().message,
      retryable: false,
    });
    expect(reads).toBe(0);
    expect(effects).toBe(0);
  });

  it('validates tools even when inline media subsequently omits them', () => {
    let reads = 0;
    const tools = [{ name: 'echo', description: 'd', parameters: { type: 'object' as const } }];
    Object.defineProperty(tools, '0', {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error('private');
      },
    });
    expect(() =>
      prepareAgentTurnRequest(params(provider('gemini'), { tools, outputModalities: ['image'] })),
    ).toThrow(new UnsupportedRequestDataError().message);
    expect(reads).toBe(0);
  });

  it('preserves cross-field aliases while ownership validates the original arrays', () => {
    const shared = { type: 'object' as const, description: 'shared' };
    const prepared = prepareAgentTurnRequest(
      params(provider(), {
        messages: [
          { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'c', result: shared }] },
        ],
        tools: [{ name: 'echo', description: 'd', parameters: shared }],
        responseFormat: { type: 'json', schema: shared },
      }),
    );
    const result = prepared.request.messages[0]?.content[0];
    if (result?.type !== 'tool_result') throw new Error('missing result');
    if (prepared.request.responseFormat?.type !== 'json') throw new Error('missing format');
    expect(result.result).toBe(prepared.request.tools?.[0]?.parameters);
    expect(prepared.request.responseFormat.schema).toBe(result.result);
    expect(result.result).not.toBe(shared);
  });

  it('omits tools from owned inline payload without losing candidate plans or recapturing', () => {
    let captures = 0;
    const candidates = [
      { model: 'a', provider: 'openai', endpoint: 'custom' },
      { model: 'b', provider: 'gemini', endpoint: 'custom' },
    ] as const;
    const owner = ownLlmRequest(
      {
        model: 'a',
        messages: [],
        tools: [{ name: 'echo', description: 'd', parameters: { type: 'object' } }],
        providerOptions: {
          max_completion_tokens: {
            toJSON: () => {
              captures += 1;
              return 70;
            },
          },
          maxOutputTokens: 90,
        },
      },
      candidates,
    );
    const next = withoutOwnedRequestTools(owner);
    for (const candidate of candidates) {
      const first = selectOwnedRequest(owner, candidate);
      const selected = selectOwnedRequest(next, candidate);
      expect(selected.plan).toBe(first.plan);
      expect(selected.request.tools).toBeUndefined();
      expect(selected.request.messages).toBe(first.request.messages);
      expect(Object.isFrozen(selected.request)).toBe(true);
    }
    expect(captures).toBe(1);
    expect(() => withoutOwnedRequestTools({ ...owner })).toThrow(InvalidOutputCapPlanError);
  });

  it.each(
    (['benign', 'failed'] as const).flatMap((cap) =>
      (['direct', 'prepared'] as const).map((route) => ({ cap, route })),
    ),
  )(
    'keeps the unsupported-only diagnostic with $cap caps through $route execution',
    async ({ cap, route }) => {
      const a: LlmProvider = { ...provider(), customEndpoint: false };
      const b: LlmProvider = { ...provider(), customEndpoint: false };
      a.supports.tools = false;
      b.supports.tools = false;
      let effects = 0;
      const source = params(a, {
        planEntries: [
          { provider: a, model: 'gpt-5.5', maxAttempts: 1 },
          { provider: b, model: 'gpt-5.4-pro', maxAttempts: 1 },
        ],
        tools: [{ name: 'echo', description: 'd', parameters: { type: 'object' } }],
        maxTokens: 70,
        preEgress: () => {
          effects += 1;
        },
        money: {
          join: () => {
            effects += 1;
            return Promise.resolve();
          },
          record: () => undefined,
        },
        chainCapabilities: {
          keyFor: () => {
            effects += 1;
            return 'offline';
          },
          sleep: () => Promise.resolve(),
        },
      });
      // Inert wrong-type input: official clamping genuinely fails inside the candidate cap authority.
      if (cap === 'failed')
        Object.defineProperty(source, 'maxTokens', {
          value: { toString: null, valueOf: null },
          enumerable: true,
        });
      const first = prepareAgentTurnRequest(source);
      if (cap === 'failed')
        expect(() =>
          selectOwnedRequest(first.request, {
            model: 'gpt-5.5',
            provider: 'openai',
            endpoint: 'official',
          }),
        ).toThrow(InvalidOutputCapPlanError);
      expect(
        quoteBudgetAllowance({
          route: 'text',
          entries: source.planEntries,
          request: first.request,
          inputTokensEstimate: first.inputTokensEstimate,
          maxTokensEstimate: undefined,
          maxToolTurns: 2,
          strictCostCap: false,
        }),
      ).toMatchObject({
        kind: 'unpriced',
        excludedEntries: [
          { index: 0, reason: 'unsupported' },
          { index: 1, reason: 'unsupported' },
        ],
      });
      await expect(
        runAgentTurn({
          ...source,
          ...(route === 'prepared' ? { preparedRequest: first.request } : {}),
        }),
      ).rejects.toMatchObject({
        code: 'validation',
        retryable: false,
        message:
          "fallback chain exhausted: no provider could serve the request (provider cannot serve the request: 'tools' capability not supported)",
      });
      expect(effects).toBe(0);
      if (cap === 'failed' && route === 'prepared') {
        // A later applicability change cannot turn an unselected source into successful cap authority.
        a.supports.tools = true;
        await expect(
          runAgentTurn({ ...source, preparedRequest: first.request }),
        ).rejects.toMatchObject({
          code: 'validation',
          retryable: false,
          message: new InvalidOutputCapPlanError().message,
        });
        expect(effects).toBe(0);
      }
    },
  );

  it('skips a first unsupported failed cap and dispatches the next supported candidate', async () => {
    const primary: LlmProvider = { ...provider(), customEndpoint: false };
    primary.supports.tools = false;
    const fallback = provider('gemini');
    const model = 'owned-unsupported-ceiling-probe';
    const catalog = {
      modelId: model,
      provider: 'openai' as const,
      displayName: model,
      contextWindowTokens: 10000,
      maxOutputTokens: 1000,
      inputPerMtokMicrocents: 1000000,
      outputPerMtokMicrocents: 1000000,
    };
    let ceilingReads = 0;
    Object.defineProperty(catalog, 'maxOutputTokens', {
      enumerable: true,
      get: () => {
        ceilingReads += 1;
        throw new Error('private catalog failure');
      },
    });
    installCatalogRefresh({ [model]: catalog });
    const invoked: string[] = [];
    const admitted: string[] = [];
    fallback.stream = async function* (request): AsyncGenerator<StreamChunk> {
      invoked.push(request.model);
      await Promise.resolve();
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } };
    };
    try {
      const source = params(primary, {
        planEntries: [
          { provider: primary, model, maxAttempts: 1 },
          { provider: fallback, model: 'b', maxAttempts: 1 },
        ],
        tools: [{ name: 'echo', description: 'd', parameters: { type: 'object' } }],
        maxTokens: 70,
        preEgress: (info) => {
          admitted.push(info.model);
        },
      });
      const first = prepareAgentTurnRequest(source);
      expect(
        quoteBudgetAllowance({
          route: 'text',
          entries: source.planEntries,
          request: first.request,
          inputTokensEstimate: first.inputTokensEstimate,
          maxTokensEstimate: undefined,
          maxToolTurns: 2,
          strictCostCap: false,
          overlay: prices,
        }),
      ).toMatchObject({
        kind: 'quoted',
        quote: { excludedEntries: [{ index: 0, reason: 'unsupported' }] },
      });
      await runAgentTurn({ ...source, preparedRequest: first.request });
      expect(invoked).toEqual(['b']);
      expect(admitted).toEqual(['b']);
      expect(ceilingReads).toBe(1);
    } finally {
      clearCatalogRefresh();
    }
  });
});
