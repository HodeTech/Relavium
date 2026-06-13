import type { CapabilityFlags, LlmProvider, ProviderId, StreamChunk } from '@relavium/llm';
import { describe, expect, it } from 'vitest';

import { ToolPolicyError, UnknownToolError } from '../tools/errors.js';
import type {
  ToolCallPart,
  ToolDispatchContext,
  ToolDispatchOutcome,
  ToolRegistry,
  ToolResultPart,
} from '../tools/types.js';
import { markUntrusted } from '../tools/untrusted.js';
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
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    planEntries: [{ provider, model: 'claude-opus-4-8', maxAttempts: 1 }],
    chainCapabilities: CAPABILITIES,
    nodeId: 'n1',
    emit: (e) => events.push(e),
    signal: NEVER_ABORT,
    registry: stubRegistry(),
    dispatchContext,
    limits: DEFAULT_AGENT_TURN_LIMITS,
    // expose the captured events for assertions
    ...({ _events: events } as object),
    ...overrides,
  };
}

/** Pull the captured events array back out of the params (test-only side channel). */
function eventsOf(params: AgentTurnParams): NodeStreamEvent[] {
  return (params as unknown as { _events: NodeStreamEvent[] })._events;
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

describe('runAgentTurn — tool loop', () => {
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
