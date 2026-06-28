import { LlmProviderError, makeLlmError } from '@relavium/llm';
import type {
  CapabilityFlags,
  LlmProvider,
  LlmResult,
  ProviderId,
  StreamChunk,
} from '@relavium/llm';
import type { ContentPart } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  ToolCancelledError,
  ToolExecutionError,
  ToolPolicyError,
  ToolUnavailableError,
  UnknownToolError,
} from '../tools/errors.js';
import type {
  ToolCallPart,
  ToolDispatchContext,
  ToolDispatchOutcome,
  ToolRegistry,
  ToolResultPart,
} from '../tools/types.js';
import { markUntrusted } from '../tools/untrusted.js';
import { BudgetExceededError, BudgetPauseError } from './budget-governor.js';
import {
  AgentTurnError,
  DEFAULT_AGENT_TURN_LIMITS,
  runAgentTurn,
  type AgentTurnParams,
  type ChainCapabilities,
} from './agent-turn.js';
import type { NodeStreamEvent } from './node-executor.js';

const CAPS: CapabilityFlags = {
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

/** Replay a chunk list as an async iterable (a top-level async generator keeps the lint rule happy). */
async function* streamOf(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  await Promise.resolve();
  for (const c of chunks) yield c;
}

/** A provider whose `stream` replays a scripted chunk list per call (call N → scripts[N]). */
function scriptedProvider(id: ProviderId, scripts: StreamChunk[][]): LlmProvider {
  let call = 0;
  return {
    id,
    supports: CAPS,
    generate: () => {
      throw new Error('generate not used in these tests');
    },
    stream: (): AsyncIterable<StreamChunk> => {
      const chunks = scripts[call] ?? [];
      call += 1;
      return streamOf(chunks);
    },
  };
}

const STOP = (reason: 'stop' | 'tool_use' = 'stop'): StreamChunk => ({
  type: 'stop',
  stopReason: reason,
  usage: { inputTokens: 10, outputTokens: 5 },
});

/** Caps advertising inline image output (so the chain's per-attempt capability pre-skip keeps the model). */
const MEDIA_CAPS: CapabilityFlags = {
  ...CAPS,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [['image'], ['text', 'image']],
    surface: 'chat',
  },
};

/** A provider whose non-streaming `generate` returns a scripted `LlmResult`; its `stream` THROWS — so a
 *  test that completes proves the media-output turn routed through `generate()`, never `stream()` (1.AG). */
function mediaGenerateProvider(id: ProviderId, result: LlmResult): LlmProvider {
  return {
    id,
    supports: MEDIA_CAPS,
    generate: () => Promise.resolve(result),
    stream: (): AsyncIterable<StreamChunk> => {
      throw new Error('stream must NOT be used for an inline media-out turn');
    },
  };
}

const CAPABILITIES: ChainCapabilities = {
  keyFor: () => 'test-key',
  sleep: () => Promise.resolve(),
  now: () => 1_000,
};

const NEVER_ABORT = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

function baseParams(
  provider: LlmProvider,
  overrides: Partial<AgentTurnParams> = {},
): AgentTurnParams {
  const events: NodeStreamEvent[] = [];
  const dispatchContext: Omit<ToolDispatchContext, 'signal'> = {
    nodeId: 'n1',
    grantedToolIds: new Set(['echo']),
    config: {},
    toolPolicy: {},
    fsScope: 'sandboxed',
    gateApproved: false,
  };
  const params: AgentTurnParams = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    planEntries: [{ provider, model: 'claude-opus-4-8', maxAttempts: 1 }],
    chainCapabilities: CAPABILITIES,
    nodeId: 'n1',
    emit: (e) => events.push(e),
    signal: NEVER_ABORT,
    registry: stubRegistry(),
    dispatchContext,
    limits: DEFAULT_AGENT_TURN_LIMITS,
    ...overrides,
  };
  capturedEvents.set(params, events);
  return params;
}

/** Typed side-channel: the events the default `emit` captured for a given params object. */
const capturedEvents = new WeakMap<AgentTurnParams, NodeStreamEvent[]>();

/** Pull the captured events array back out of the params (no unsafe cast). */
function eventsOf(params: AgentTurnParams): NodeStreamEvent[] {
  return capturedEvents.get(params) ?? [];
}

function stubRegistry(handler?: (call: ToolCallPart) => ToolDispatchOutcome): ToolRegistry {
  return {
    has: () => true,
    list: () => ['echo'],
    dispatch: (call) => {
      if (handler) return Promise.resolve(handler(call));
      const result: ToolResultPart = { type: 'tool_result', toolCallId: call.id, result: 'OK' };
      return Promise.resolve({
        output: 'OK',
        toolResult: markUntrusted(result),
        truncated: false,
        events: {
          call: { toolId: call.name, toolInput: {} },
          result: { toolId: call.name, success: true, outputSummary: 'OK' },
        },
      });
    },
  };
}

describe('runAgentTurn — streaming + cost', () => {
  it('streams text tokens, completes, and emits a cost:updated', async () => {
    const provider = scriptedProvider('anthropic', [
      [{ type: 'text_delta', text: 'Hel' }, { type: 'text_delta', text: 'lo' }, STOP()],
    ]);
    const params = baseParams(provider);
    const result = await runAgentTurn(params);

    expect(result.text).toBe('Hello');
    expect(result.stopReason).toBe('stop');
    expect(result.usage).toEqual({ input: 10, output: 5 });

    const events = eventsOf(params);
    const tokens = events.filter((e) => e.type === 'agent:token');
    expect(tokens.map((t) => (t.type === 'agent:token' ? t.token : ''))).toEqual(['Hel', 'lo']);
    const cost = events.find((e) => e.type === 'cost:updated');
    expect(cost?.type === 'cost:updated' && cost.attemptNumber).toBe(1);
    expect(cost?.type === 'cost:updated' && cost.model).toBe('claude-opus-4-8');
  });
});

describe('runAgentTurn — inline media-out (1.AG/ADR-0046)', () => {
  const image: ContentPart = {
    type: 'media',
    mimeType: 'image/png',
    source: { kind: 'base64', data: 'aW1nLWJ5dGVz' },
  };

  it('routes a node requesting non-text output to generate() (not stream()) and returns the media content', async () => {
    const provider = mediaGenerateProvider('gemini', {
      content: [{ type: 'text', text: 'here is your image' }, image],
      stopReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const params = baseParams(provider, {
      planEntries: [{ provider, model: 'gemini-2.5-flash', maxAttempts: 1 }],
      outputModalities: ['text', 'image'],
    });

    const result = await runAgentTurn(params);

    expect(result.stopReason).toBe('stop');
    expect(result.content).toContainEqual(image); // the in-flight base64 media survives the turn (engine de-inlines it)
    expect(result.text).toBe('here is your image');

    // The generate() path streams no tokens, but still settles one cost:updated for the attempt, with the
    // accurate per-attempt model + attemptNumber (the onAttempt plumbing is shared with the stream path).
    const events = eventsOf(params);
    expect(events.some((e) => e.type === 'agent:token')).toBe(false);
    const cost = events.find((e) => e.type === 'cost:updated');
    expect(cost?.type === 'cost:updated' && cost.model).toBe('gemini-2.5-flash');
    expect(cost?.type === 'cost:updated' && cost.attemptNumber).toBe(1);
  });

  it('fails over on the generate() path: a retryable primary error advances to a capable secondary', async () => {
    const primary: LlmProvider = {
      id: 'gemini',
      supports: MEDIA_CAPS,
      generate: () =>
        Promise.reject(
          new LlmProviderError(
            makeLlmError({ provider: 'gemini', kind: 'overloaded', message: 'busy' }),
          ),
        ),
      stream: (): AsyncIterable<StreamChunk> => {
        throw new Error('stream must NOT run for a media-out turn');
      },
    };
    const secondary = mediaGenerateProvider('openai', {
      content: [{ type: 'text', text: 'made it' }, image],
      stopReason: 'stop',
      usage: { inputTokens: 4, outputTokens: 2 },
    });
    const params = baseParams(primary, {
      planEntries: [
        { provider: primary, model: 'gemini-2.5-flash', maxAttempts: 1 },
        { provider: secondary, model: 'gpt-image-1', maxAttempts: 1 },
      ],
      outputModalities: ['text', 'image'],
    });
    const result = await runAgentTurn(params);
    expect(result.content).toContainEqual(image);
    expect(result.model).toBe('gpt-image-1'); // attributed to the succeeding (failed-over) model
  });

  it('maps a generate() budget-exceeded cause to budget_exceeded (the throwMappedChainError cause unwrap)', async () => {
    const provider: LlmProvider = {
      id: 'gemini',
      supports: MEDIA_CAPS,
      generate: () =>
        Promise.reject(
          new LlmProviderError(
            makeLlmError({
              provider: 'gemini',
              kind: 'unknown',
              message: 'budget',
              cause: new BudgetExceededError(120, 50, 130),
            }),
          ),
        ),
      stream: (): AsyncIterable<StreamChunk> => {
        throw new Error('stream must NOT run for a media-out turn');
      },
    };
    const params = baseParams(provider, {
      planEntries: [{ provider, model: 'gemini-2.5-flash', maxAttempts: 1 }],
      outputModalities: ['image'],
    });
    await expect(runAgentTurn(params)).rejects.toMatchObject({ code: 'budget_exceeded' });
  });

  it('a pre-aborted signal on the media path fails cancelled with zero generate() egress', async () => {
    let called = false;
    const provider: LlmProvider = {
      id: 'gemini',
      supports: MEDIA_CAPS,
      generate: () => {
        called = true;
        return Promise.resolve({
          content: [image],
          stopReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
      stream: (): AsyncIterable<StreamChunk> => {
        throw new Error('stream must NOT run for a media-out turn');
      },
    };
    const aborted = {
      aborted: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const params = baseParams(provider, {
      planEntries: [{ provider, model: 'gemini-2.5-flash', maxAttempts: 1 }],
      outputModalities: ['image'],
      signal: aborted,
    });
    await expect(runAgentTurn(params)).rejects.toMatchObject({ code: 'cancelled' });
    expect(called).toBe(false); // a cancel before egress engages no provider
  });

  it('keeps a text-only node on the streaming path (no generate())', async () => {
    // A provider whose generate throws — a text turn must never reach it.
    const provider: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      generate: () => {
        throw new Error('generate must NOT be used for a text turn');
      },
      stream: () => streamOf([{ type: 'text_delta', text: 'hi' }, STOP()]),
    };
    const result = await runAgentTurn(baseParams(provider, { outputModalities: ['text'] }));
    expect(result.text).toBe('hi');
  });

  it('fails loud (provider_unavailable) when a media-output turn returns a tool_use stop — never silently drops it', async () => {
    // ADR-0046: a media turn is single-shot/terminal and is offered NO tools, so a tool_use stop is a provider
    // protocol anomaly (a tool call we never offered, unrunnable). It must fail loud, not complete with empty
    // output, and uses provider_unavailable — the same code the stream path's tool_use-anomaly guard uses.
    const provider = mediaGenerateProvider('gemini', {
      content: [{ type: 'tool_call', id: 't1', name: 'echo', args: {} }],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const params = baseParams(provider, {
      planEntries: [{ provider, model: 'gemini-2.5-flash', maxAttempts: 1 }],
      outputModalities: ['text', 'image'],
    });
    // EA2: generate() settled (reporting usage 10/5) BEFORE the anomalous stop was classified — so the real
    // tokens ride the thrown error rather than being dropped on the media-out path.
    await expect(runAgentTurn(params)).rejects.toMatchObject({
      code: 'provider_unavailable',
      usage: { input: 10, output: 5 },
    });
  });

  it('maps a generate() chain failure into the turn error taxonomy (symmetric with the stream path)', async () => {
    const provider: LlmProvider = {
      id: 'gemini',
      supports: MEDIA_CAPS,
      generate: () => Promise.reject(new Error('boom')),
      stream: (): AsyncIterable<StreamChunk> => {
        throw new Error('stream must NOT be used for a media-out turn');
      },
    };
    const params = baseParams(provider, {
      planEntries: [{ provider, model: 'gemini-2.5-flash', maxAttempts: 1 }],
      outputModalities: ['image'],
    });
    await expect(runAgentTurn(params)).rejects.toBeInstanceOf(AgentTurnError);
  });
});

describe('runAgentTurn — tool loop', () => {
  // A tool-use turn (a tool_call to `echo`, then a tool_use stop) — shared by the tool-loop scenarios.
  const toolUseTurn = (id: string): StreamChunk[] => [
    { type: 'tool_call_start', id, name: 'echo' },
    { type: 'tool_call_end', id },
    STOP('tool_use'),
  ];

  it('performs a tool round-trip then completes', async () => {
    const provider = scriptedProvider('anthropic', [
      // turn 1: a tool call
      [
        { type: 'tool_call_start', id: 'c1', name: 'echo' },
        { type: 'tool_call_delta', id: 'c1', argsJsonDelta: '{"x":1}' },
        { type: 'tool_call_end', id: 'c1' },
        STOP('tool_use'),
      ],
      // turn 2: the answer
      [{ type: 'text_delta', text: 'done' }, STOP()],
    ]);
    const params = baseParams(provider);
    const result = await runAgentTurn(params);

    expect(result.text).toBe('done');
    const events = eventsOf(params);
    expect(events.some((e) => e.type === 'agent:tool_call' && e.toolId === 'echo')).toBe(true);
    expect(events.some((e) => e.type === 'agent:tool_result' && e.success)).toBe(true);
  });

  it('emits agent:tool_call from the registry-SANITIZED payload, never the raw model args', async () => {
    const registry = stubRegistry((call) => {
      const result: ToolResultPart = { type: 'tool_result', toolCallId: call.id, result: 'OK' };
      return {
        output: 'OK',
        toolResult: markUntrusted(result),
        truncated: false,
        events: {
          // The registry's sanitized projection — config-only / secret-tainted keys already stripped.
          call: { toolId: call.name, toolInput: { safe: true } },
          result: { toolId: call.name, success: true, outputSummary: 'OK' },
        },
      };
    });
    const provider = scriptedProvider('anthropic', [
      [
        { type: 'tool_call_start', id: 'c1', name: 'echo' },
        { type: 'tool_call_delta', id: 'c1', argsJsonDelta: '{"raw":"do-not-leak"}' },
        { type: 'tool_call_end', id: 'c1' },
        STOP('tool_use'),
      ],
      [{ type: 'text_delta', text: 'ok' }, STOP()],
    ]);
    const params = baseParams(provider, { registry });
    await runAgentTurn(params);
    const toolCall = eventsOf(params).find((e) => e.type === 'agent:tool_call');
    // The event carries the SANITIZED payload, not the raw model args `{ raw: 'do-not-leak' }`.
    expect(toolCall?.type === 'agent:tool_call' && toolCall.toolInput).toEqual({ safe: true });
  });

  it('feeds a correctable tool error back as an isError result, then recovers', async () => {
    let dispatched = 0;
    const registry = stubRegistry((call) => {
      dispatched += 1;
      if (dispatched === 1) throw new UnknownToolError('echo', ['echo']);
      const result: ToolResultPart = { type: 'tool_result', toolCallId: call.id, result: 'OK' };
      return {
        output: 'OK',
        toolResult: markUntrusted(result),
        truncated: false,
        events: {
          call: { toolId: call.name, toolInput: {} },
          result: { toolId: call.name, success: true, outputSummary: 'OK' },
        },
      };
    });
    const provider = scriptedProvider('anthropic', [
      [
        { type: 'tool_call_start', id: 'c1', name: 'echo' },
        { type: 'tool_call_end', id: 'c1' },
        STOP('tool_use'),
      ],
      [
        { type: 'tool_call_start', id: 'c2', name: 'echo' },
        { type: 'tool_call_end', id: 'c2' },
        STOP('tool_use'),
      ],
      [{ type: 'text_delta', text: 'ok' }, STOP()],
    ]);
    const params = baseParams(provider, { registry });
    const result = await runAgentTurn(params);
    expect(result.text).toBe('ok');
    const failResult = eventsOf(params).find((e) => e.type === 'agent:tool_result' && !e.success);
    expect(failResult).toBeDefined();
  });

  it('combined budget: corrections accumulate across an interleaved genuine round and bound egress (tool_failed before turn_limit)', async () => {
    // Pins the COMBINED tool-loop DoS bound: maxToolCorrections is a MONOTONIC sub-budget — a genuine
    // (non-correctable) round between correctable ones neither resets nor counts toward it. With
    // maxToolCorrections 2, the rounds correctable / genuine / correctable / correctable trip `tool_failed`
    // on the 3rd correctable (at turn 4), well under maxToolTurns 16. Proves the two bounds are NOT
    // multiplicative: the correction sub-budget ends the turn early; egress stays ≤ the turn count.
    let dispatched = 0;
    const registry = stubRegistry((call) => {
      dispatched += 1;
      if (dispatched === 2) {
        // the one genuine round, interleaved between correctable ones
        const result: ToolResultPart = { type: 'tool_result', toolCallId: call.id, result: 'OK' };
        return {
          output: 'OK',
          toolResult: markUntrusted(result),
          truncated: false,
          events: {
            call: { toolId: call.name, toolInput: {} },
            result: { toolId: call.name, success: true, outputSummary: 'OK' },
          },
        };
      }
      throw new UnknownToolError('echo', ['echo']); // calls 1, 3, 4 are model-correctable
    });
    // A 5th turn is scripted but must never be reached (the budget trips on the 4th).
    const provider = scriptedProvider('anthropic', [
      toolUseTurn('c1'),
      toolUseTurn('c2'),
      toolUseTurn('c3'),
      toolUseTurn('c4'),
      toolUseTurn('c5'),
    ]);
    const params = baseParams(provider, {
      registry,
      limits: { maxToolTurns: 16, maxToolCorrections: 2 },
    });
    await expect(runAgentTurn(params)).rejects.toMatchObject({
      code: 'tool_failed',
      retryable: false,
    });
    expect(dispatched).toBe(4); // exactly 4 tool turns — the correction budget ended it far under maxToolTurns
    // the interleaved genuine round actually ran (one successful tool_result between the corrections)
    expect(
      eventsOf(params).filter((e) => e.type === 'agent:tool_result' && e.success),
    ).toHaveLength(1);
  });

  it('maps a tool denial to a fatal tool_denied failure (no feedback loop)', async () => {
    const registry = stubRegistry(() => {
      throw new ToolPolicyError('echo', 'not_granted', 'tool not granted');
    });
    const provider = scriptedProvider('anthropic', [
      [
        { type: 'tool_call_start', id: 'c1', name: 'echo' },
        { type: 'tool_call_end', id: 'c1' },
        STOP('tool_use'),
      ],
    ]);
    const params = baseParams(provider, { registry });
    await expect(runAgentTurn(params)).rejects.toMatchObject({
      code: 'tool_denied',
      retryable: false,
    });
  });

  it('maps ToolCancelledError to cancelled (cancel wins over a tool failure)', async () => {
    const registry = stubRegistry(() => {
      throw new ToolCancelledError('echo');
    });
    const provider = scriptedProvider('anthropic', [toolUseTurn('c1')]);
    await expect(runAgentTurn(baseParams(provider, { registry }))).rejects.toMatchObject({
      code: 'cancelled',
      retryable: false,
    });
  });

  it('maps ToolUnavailableError (absent host capability) to tool_unavailable (EA1, not internal)', async () => {
    const registry = stubRegistry(() => {
      throw new ToolUnavailableError('echo', 'egress');
    });
    const provider = scriptedProvider('anthropic', [toolUseTurn('c1')]);
    const err: unknown = await runAgentTurn(baseParams(provider, { registry })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentTurnError);
    if (err instanceof AgentTurnError) {
      expect(err.code).toBe('tool_unavailable');
      expect(err.retryable).toBe(false);
      // EA1's value over a bare `internal`: the surfaced message names the tool + the unwired arm actionably.
      expect(err.message).toContain('echo');
      expect(err.message).toContain('egress');
      // EA1×EA2 intersection: the tool_use STOP settled usage 10/5 before the dispatch threw, so even a
      // missing-capability failure reports the real spent tokens — pin it so a throw-path refactor can't drop it.
      expect(err.usage).toEqual({ input: 10, output: 5 });
    }
  });

  it('attaches accumulated usage when a LATER turn fails after a settled tool round (EA2, provider path)', async () => {
    // Turn 1's tool_use STOP settles usage 10/5 and the tool dispatches OK; turn 2's stream errors
    // (chain-exhausted) → provider_unavailable. The accumulated 10/5 rides the thrown error (the real payoff:
    // a provider failure that already burned tokens reports them, not a zero).
    const provider = scriptedProvider('anthropic', [
      [
        { type: 'tool_call_start', id: 'c1', name: 'echo' },
        { type: 'tool_call_end', id: 'c1' },
        STOP('tool_use'),
      ],
      [
        {
          type: 'error',
          error: { kind: 'overloaded', retryable: true, provider: 'anthropic', message: 'busy' },
        },
      ],
    ]);
    await expect(runAgentTurn(baseParams(provider))).rejects.toMatchObject({
      code: 'provider_unavailable',
      usage: { input: 10, output: 5 },
    });
  });

  it('leaves usage undefined when the FIRST attempt fails with no usage (provider error → truthful zero)', async () => {
    // A chain-exhausted failure on the first attempt accumulated NO usage (a failed FallbackChain attempt
    // carries none) — so the wrapper leaves `usage` undefined and the caller reports a truthful zero.
    const provider = scriptedProvider('anthropic', [
      [
        {
          type: 'error',
          error: { kind: 'auth', retryable: false, provider: 'anthropic', message: 'bad key' },
        },
      ],
    ]);
    const err: unknown = await runAgentTurn(baseParams(provider)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentTurnError);
    if (err instanceof AgentTurnError) {
      expect(err.code).toBe('provider_auth');
      expect(err.usage).toBeUndefined();
    }
  });

  it('maps ToolExecutionError to tool_failed (retryable — the 1.S node-retry signal)', async () => {
    const registry = stubRegistry(() => {
      throw new ToolExecutionError('echo', 'disk full');
    });
    const provider = scriptedProvider('anthropic', [toolUseTurn('c1')]);
    await expect(runAgentTurn(baseParams(provider, { registry }))).rejects.toMatchObject({
      code: 'tool_failed',
      retryable: true,
    });
  });

  it('attaches the turn’s REAL accumulated usage to a failed turn (EA2)', async () => {
    // The tool-use turn settled an attempt (STOP carries usage 10/5) BEFORE the tool throws, so the
    // accumulated usage is non-zero — the wrapper attaches it to the thrown AgentTurnError rather than
    // dropping it, so AgentSession can report real, not zeroed, tokens on the failed turn.
    const registry = stubRegistry(() => {
      throw new ToolExecutionError('echo', 'disk full');
    });
    const provider = scriptedProvider('anthropic', [toolUseTurn('c1')]);
    await expect(runAgentTurn(baseParams(provider, { registry }))).rejects.toMatchObject({
      code: 'tool_failed',
      usage: { input: 10, output: 5 },
    });
  });

  it('leaves usage undefined on a failure with NO provider engagement (no plan entries)', async () => {
    // A pre-egress / wiring failure never ran a provider — `usage` stays {0,0}, so the wrapper leaves
    // AgentTurnError.usage undefined and the caller reports a truthful zero (never a fabricated count).
    const provider = scriptedProvider('anthropic', []);
    const err: unknown = await runAgentTurn({ ...baseParams(provider), planEntries: [] }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentTurnError);
    if (err instanceof AgentTurnError) expect(err.usage).toBeUndefined();
  });

  it('redacts the raw model args on the error-path agent:tool_call (toolInput {})', async () => {
    const registry = stubRegistry(() => {
      throw new ToolPolicyError('echo', 'not_granted', 'denied');
    });
    const provider = scriptedProvider('anthropic', [
      [
        { type: 'tool_call_start', id: 'c1', name: 'echo' },
        { type: 'tool_call_delta', id: 'c1', argsJsonDelta: '{"raw":"do-not-leak"}' },
        { type: 'tool_call_end', id: 'c1' },
        STOP('tool_use'),
      ],
    ]);
    const params = baseParams(provider, { registry });
    await expect(runAgentTurn(params)).rejects.toMatchObject({ code: 'tool_denied' });
    const toolCall = eventsOf(params).find((e) => e.type === 'agent:tool_call');
    // The error path never had a sanitized outcome — the raw `{ raw: ... }` must NOT reach the event.
    expect(toolCall?.type === 'agent:tool_call' && toolCall.toolInput).toEqual({});
  });

  it('stamps attemptNumber 1 on the first tool turn’s events', async () => {
    const provider = scriptedProvider('anthropic', [
      toolUseTurn('c1'),
      [{ type: 'text_delta', text: 'ok' }, STOP()],
    ]);
    const params = baseParams(provider);
    await runAgentTurn(params);
    const call = eventsOf(params).find((e) => e.type === 'agent:tool_call');
    const result = eventsOf(params).find((e) => e.type === 'agent:tool_result');
    expect(call?.type === 'agent:tool_call' && call.attemptNumber).toBe(1);
    expect(result?.type === 'agent:tool_result' && result.attemptNumber).toBe(1);
  });

  it('cancels mid-tool-loop: an abort after the first dispatch stops the second (cancel wins)', async () => {
    const aborted = {
      aborted: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    let dispatched = 0;
    const registry = stubRegistry((call) => {
      dispatched += 1;
      aborted.aborted = true; // flip the signal after the first dispatch settles
      const result: ToolResultPart = { type: 'tool_result', toolCallId: call.id, result: 'OK' };
      return {
        output: 'OK',
        toolResult: markUntrusted(result),
        truncated: false,
        events: {
          call: { toolId: call.name, toolInput: {} },
          result: { toolId: call.name, success: true, outputSummary: 'OK' },
        },
      };
    });
    const provider = scriptedProvider('anthropic', [
      [
        { type: 'tool_call_start', id: 'c1', name: 'echo' },
        { type: 'tool_call_end', id: 'c1' },
        { type: 'tool_call_start', id: 'c2', name: 'echo' },
        { type: 'tool_call_end', id: 'c2' },
        STOP('tool_use'),
      ],
    ]);
    await expect(
      runAgentTurn(baseParams(provider, { registry, signal: aborted })),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(dispatched).toBe(1); // the second tool was never dispatched
  });

  it('fails tool_failed once the self-correction budget is exhausted', async () => {
    const registry = stubRegistry(() => {
      throw new UnknownToolError('echo', ['echo']); // every call is model-correctable
    });
    const scripts: StreamChunk[][] = Array.from({ length: 10 }, (_, i) => toolUseTurn(`c${i}`));
    const provider = scriptedProvider('anthropic', scripts);
    await expect(
      runAgentTurn(
        baseParams(provider, { registry, limits: { maxToolTurns: 16, maxToolCorrections: 1 } }),
      ),
    ).rejects.toMatchObject({ code: 'tool_failed' });
  });

  it('fails provider_unavailable on a tool_use stop that carries no tool call', async () => {
    const provider = scriptedProvider('anthropic', [
      [{ type: 'text_delta', text: 'hmm' }, STOP('tool_use')],
    ]);
    await expect(runAgentTurn(baseParams(provider))).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });

  it('fails with turn_limit when the tool loop never settles', async () => {
    const scripts: StreamChunk[][] = Array.from({ length: 40 }, (_, i) => [
      { type: 'tool_call_start', id: `c${i}`, name: 'echo' },
      { type: 'tool_call_end', id: `c${i}` },
      STOP('tool_use'),
    ]);
    const provider = scriptedProvider('anthropic', scripts);
    const params = baseParams(provider, { limits: { maxToolTurns: 3, maxToolCorrections: 3 } });
    await expect(runAgentTurn(params)).rejects.toBeInstanceOf(AgentTurnError);
    await expect(
      runAgentTurn(
        baseParams(scriptedProvider('anthropic', scripts), {
          limits: { maxToolTurns: 3, maxToolCorrections: 3 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'turn_limit' });
  });
});

describe('runAgentTurn — failover + cancel + reasoning', () => {
  it('fails over to the next provider on a pre-content error and succeeds', async () => {
    const primary = scriptedProvider('anthropic', [
      [
        {
          type: 'error',
          error: { kind: 'overloaded', retryable: true, provider: 'anthropic', message: 'busy' },
        },
      ],
    ]);
    const fallback = scriptedProvider('openai', [[{ type: 'text_delta', text: 'fb' }, STOP()]]);
    const params = baseParams(primary, {
      planEntries: [
        { provider: primary, model: 'claude-opus-4-8', maxAttempts: 1 },
        { provider: fallback, model: 'claude-sonnet-4-6', maxAttempts: 1 },
      ],
    });
    const result = await runAgentTurn(params);
    expect(result.text).toBe('fb');
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('maps an exhausted chain to a classified provider failure', async () => {
    const provider = scriptedProvider('anthropic', [
      [
        {
          type: 'error',
          error: { kind: 'auth', retryable: false, provider: 'anthropic', message: 'bad key' },
        },
      ],
    ]);
    await expect(runAgentTurn(baseParams(provider))).rejects.toMatchObject({
      code: 'provider_auth',
      retryable: false,
    });
  });

  it('maps a content_filter LlmError to the fatal content_filter ErrorCode (not validation) — 1.AG/ADR-0045 §6', async () => {
    const provider = scriptedProvider('anthropic', [
      [
        {
          type: 'error',
          error: {
            kind: 'content_filter',
            retryable: false,
            provider: 'anthropic',
            message: 'content policy block',
          },
        },
      ],
    ]);
    await expect(runAgentTurn(baseParams(provider))).rejects.toMatchObject({
      code: 'content_filter',
      retryable: false,
    });
  });

  it('maps an aborted signal to cancelled (cancel wins)', async () => {
    const provider = scriptedProvider('anthropic', [[{ type: 'text_delta', text: 'x' }, STOP()]]);
    const aborted = {
      aborted: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    await expect(runAgentTurn(baseParams(provider, { signal: aborted }))).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it('re-checks the signal after the preEgress await — a cancel there costs no provider egress', async () => {
    const aborted = {
      aborted: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    let streamed = false;
    const provider: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      generate: () => {
        throw new Error('generate not used in these tests');
      },
      stream: (): AsyncIterable<StreamChunk> => {
        streamed = true;
        return streamOf([{ type: 'text_delta', text: 'must not run' }, STOP()]);
      },
    };
    // The budget hook is awaited, so the signal can fire during that await; simulate it firing there.
    const params = baseParams(provider, {
      signal: aborted,
      preEgress: () => {
        aborted.aborted = true;
        return Promise.resolve();
      },
    });
    await expect(runAgentTurn(params)).rejects.toMatchObject({ code: 'cancelled' });
    expect(streamed).toBe(false); // the re-check fired before the provider was engaged
  });

  it('maps a pre-egress BudgetExceededError to AgentTurnError(budget_exceeded) — no provider egress', async () => {
    let streamed = false;
    const provider: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      generate: () => {
        throw new Error('generate not used in these tests');
      },
      stream: (): AsyncIterable<StreamChunk> => {
        streamed = true;
        return streamOf([{ type: 'text_delta', text: 'must not run' }, STOP()]);
      },
    };
    const params = baseParams(provider, {
      // on_exceed: fail surfaces as a BudgetExceededError out of the pre-egress hook.
      preEgress: () => Promise.reject(new BudgetExceededError(900_000, 1_000_000, 1_050_000)),
    });
    await expect(runAgentTurn(params)).rejects.toMatchObject({ code: 'budget_exceeded' });
    await expect(runAgentTurn(params)).rejects.toBeInstanceOf(AgentTurnError);
    expect(streamed).toBe(false); // the cap was enforced before the provider was engaged
  });

  it('propagates a pre-egress BudgetPauseError verbatim so the run path can park it as a gate', async () => {
    // pause_for_approval is NOT remapped into the AgentTurnError taxonomy — it propagates as-is so the
    // AgentRunner can fold it into a `paused` node outcome (reusing the human-gate seam).
    const provider: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      generate: () => {
        throw new Error('generate not used in these tests');
      },
      stream: (): AsyncIterable<StreamChunk> =>
        streamOf([{ type: 'text_delta', text: 'x' }, STOP()]),
    };
    const params = baseParams(provider, {
      preEgress: () => Promise.reject(new BudgetPauseError(900_000, 1_000_000, 95)),
    });
    await expect(runAgentTurn(params)).rejects.toBeInstanceOf(BudgetPauseError);
  });

  it('carries the signed reasoning part into the next request on a tool continuation (ADR-0039)', async () => {
    const captured: { reasoningOnContinuation?: boolean } = {};
    const provider: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      generate: () => {
        throw new Error('unused');
      },
      stream: (req): AsyncIterable<StreamChunk> => {
        const isContinuation = req.messages.some(
          (m) => m.role === 'assistant' && m.content.some((p) => p.type === 'reasoning'),
        );
        if (isContinuation) captured.reasoningOnContinuation = true;
        const chunks: StreamChunk[] = isContinuation
          ? [{ type: 'text_delta', text: 'final' }, STOP()]
          : [
              { type: 'reasoning_start', id: 'r1' },
              { type: 'reasoning_delta', id: 'r1', text: 'thinking' },
              { type: 'reasoning_end', id: 'r1', signature: 'sig-123' },
              { type: 'tool_call_start', id: 'c1', name: 'echo' },
              { type: 'tool_call_end', id: 'c1' },
              STOP('tool_use'),
            ];
        return streamOf(chunks);
      },
    };
    const result = await runAgentTurn(baseParams(provider));
    expect(result.text).toBe('final');
    expect(captured.reasoningOnContinuation).toBe(true);
  });
});
