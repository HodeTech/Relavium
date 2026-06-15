import type { CapabilityFlags, LlmProvider, ProviderId, StreamChunk } from '@relavium/llm';
import {
  AgentSchema,
  SessionContextSchema,
  type Agent,
  type SessionContext,
} from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import type { ToolRegistry, ToolResultPart } from '../tools/types.js';
import { markUntrusted } from '../tools/untrusted.js';
import {
  AgentSession,
  DEFAULT_SESSION_MAX_TURNS,
  SessionStateError,
  type SessionDeps,
  type SessionStreamEvent,
} from './agent-session.js';
import { createAbortController } from './execution-host.js';

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

async function* streamOf(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  await Promise.resolve();
  for (const c of chunks) yield c;
}

/** A provider that replays a different chunk list per `stream()` call (call N → scripts[N]). */
function scriptedProvider(scripts: StreamChunk[][], id: ProviderId = 'anthropic'): LlmProvider {
  let call = 0;
  return {
    id,
    supports: CAPS,
    generate: () => {
      throw new Error('unused');
    },
    stream: () => streamOf(scripts[call++] ?? []),
  };
}

/** A registry returning a sanitized echo outcome (for the tool round-trip). */
const echoRegistry: ToolRegistry = {
  has: () => true,
  list: () => ['echo'],
  dispatch: (call) => {
    const result: ToolResultPart = { type: 'tool_result', toolCallId: call.id, result: 'TOOL-OK' };
    return Promise.resolve({
      output: 'TOOL-OK',
      toolResult: markUntrusted(result),
      truncated: false,
      events: {
        call: { toolId: call.name, toolInput: {} },
        result: { toolId: call.name, success: true, outputSummary: 'TOOL-OK' },
      },
    });
  },
};

const noToolRegistry: ToolRegistry = {
  has: () => false,
  list: () => [],
  dispatch: () => Promise.reject(new Error('no tool dispatch expected')),
};

const AGENT: Agent = AgentSchema.parse({
  id: 'chatter',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'You are a concise chat agent.',
});

const TOOL_AGENT: Agent = AgentSchema.parse({
  id: 'tool-chatter',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'You may call echo.',
  tools: ['echo'],
});

const CONTEXT: SessionContext = SessionContextSchema.parse({
  workingDir: '/tmp/session',
  fsScopeTier: 'sandboxed',
});

const textTurn = (text: string): StreamChunk[] => [
  { type: 'text_delta', text },
  { type: 'stop', stopReason: 'stop', usage: { inputTokens: 5, outputTokens: 3 } },
];

const toolUseTurn = (id: string): StreamChunk[] => [
  { type: 'tool_call_start', id, name: 'echo' },
  { type: 'tool_call_end', id },
  { type: 'stop', stopReason: 'tool_use', usage: { inputTokens: 4, outputTokens: 2 } },
];

interface Harness {
  readonly deps: SessionDeps;
  readonly events: SessionStreamEvent[];
}

function harness(
  scripts: StreamChunk[][],
  overrides: Partial<SessionDeps> = {},
  registry: ToolRegistry = noToolRegistry,
): Harness {
  const events: SessionStreamEvent[] = [];
  const provider = scriptedProvider(scripts);
  const deps: SessionDeps = {
    resolveProvider: () => provider,
    registry,
    tools: [],
    keyFor: () => 'key',
    sleep: () => Promise.resolve(),
    newAbortController: createAbortController,
    emit: (event) => {
      events.push(event);
    },
    ...overrides,
  };
  return { deps, events };
}

const session = (deps: SessionDeps, agent: Agent = AGENT): AgentSession =>
  new AgentSession({ sessionId: 'sess-1', agentRef: agent.id, agent, context: CONTEXT, deps });

const typesOf = (events: readonly SessionStreamEvent[]): readonly string[] =>
  events.map((e) => e.type);

describe('AgentSession (1.V) — multi-turn entry point over the shared turn core', () => {
  it('runs a multi-turn conversation with a tool round-trip through the same turn core', async () => {
    // Turn 1 calls echo then answers (2 stream() calls); turn 2 is a plain answer (1 stream() call).
    const { deps, events } = harness(
      [toolUseTurn('c1'), textTurn('first answer'), textTurn('second answer')],
      {},
      echoRegistry,
    );
    const s = session(deps, TOOL_AGENT);
    s.start();
    await s.sendMessage('hello');
    await s.sendMessage('again');

    const types = typesOf(events);
    expect(types[0]).toBe('session:started');
    // Two turns, each bracketed by turn_started / turn_completed.
    expect(types.filter((t) => t === 'session:turn_started')).toHaveLength(2);
    expect(types.filter((t) => t === 'session:turn_completed')).toHaveLength(2);
    // The tool round-trip surfaced through the reused core.
    expect(types).toContain('agent:tool_call');
    expect(types).toContain('agent:tool_result');
    // Both turns completed successfully (no error payload).
    const completes = events.filter((e) => e.type === 'session:turn_completed');
    for (const e of completes) {
      expect(e.type === 'session:turn_completed' && e.error).toBeUndefined();
      expect(e.type === 'session:turn_completed' && e.stopReason).toBe('stop');
    }
    // The two assistant answers streamed.
    const tokens = events.filter((e) => e.type === 'agent:token');
    expect(tokens.map((e) => (e.type === 'agent:token' ? e.token : ''))).toEqual([
      'first answer',
      'second answer',
    ]);
  });

  it('accumulates a session-wide cumulative cost across turns (overwrites the turn-core placeholder)', async () => {
    const { deps, events } = harness([textTurn('a'), textTurn('b')]);
    const s = session(deps);
    s.start();
    await s.sendMessage('one');
    await s.sendMessage('two');

    const costs = events.filter((e) => e.type === 'cost:updated');
    expect(costs.length).toBeGreaterThanOrEqual(2);
    // Each cumulative equals the running sum of per-event costMicrocents (never the 0 placeholder).
    let running = 0;
    for (const e of costs) {
      if (e.type !== 'cost:updated') continue;
      running += e.costMicrocents;
      expect(e.cumulativeCostMicrocents).toBe(running);
    }
  });

  it('emits session:turn_completed{turn_limit} — loudly, no egress — when driven past the hard cap', async () => {
    // MANDATORY regression: a turn-loop refactor must not be able to silently drop the cap signal.
    // maxTurns 1: turn 1 runs; turn 2 is blocked with turn_limit and never reaches the provider.
    const { deps, events } = harness([textTurn('only answer')], { maxTurns: 1 });
    const s = session(deps);
    s.start();
    await s.sendMessage('first');
    events.length = 0; // isolate the blocked turn's events
    await s.sendMessage('second — over the cap');

    const completed = events.find((e) => e.type === 'session:turn_completed');
    expect(completed?.type === 'session:turn_completed' ? completed.error?.code : undefined).toBe(
      'turn_limit',
    );
    expect(completed?.type === 'session:turn_completed' ? completed.stopReason : undefined).toBe(
      'error',
    );
    // No egress for the blocked turn: no streamed token / tool / cost.
    expect(typesOf(events)).not.toContain('agent:token');
    expect(typesOf(events)).not.toContain('cost:updated');
  });

  it('maps a within-turn turn_limit (maxToolTurns exceeded) to session:turn_completed{turn_limit}', async () => {
    // maxToolTurns 0: a tool_use turn exceeds the within-turn loop guard → AgentTurnError('turn_limit').
    const { deps, events } = harness(
      [toolUseTurn('c1')],
      { limits: { maxToolTurns: 0, maxToolCorrections: 3 } },
      echoRegistry,
    );
    const s = session(deps, TOOL_AGENT);
    s.start();
    await s.sendMessage('loop please');

    const completed = events.find((e) => e.type === 'session:turn_completed');
    expect(completed?.type === 'session:turn_completed' ? completed.error?.code : undefined).toBe(
      'turn_limit',
    );
  });

  it('completes a turn with an error (stopReason error) when the provider chain is exhausted', async () => {
    const { deps, events } = harness([
      [
        {
          type: 'error',
          error: { kind: 'bad_request', retryable: false, provider: 'anthropic', message: 'nope' },
        },
      ],
    ]);
    const s = session(deps);
    s.start();
    await s.sendMessage('go');

    const completed = events.find((e) => e.type === 'session:turn_completed');
    expect(completed?.type === 'session:turn_completed' ? completed.stopReason : undefined).toBe(
      'error',
    );
    expect(completed?.type === 'session:turn_completed' ? completed.error?.code : undefined).toBe(
      'validation',
    );
  });

  it('cancel() between turns emits session:cancelled and blocks further messages', async () => {
    const { deps, events } = harness([textTurn('answer')]);
    const s = session(deps);
    s.start();
    await s.sendMessage('hi');
    s.cancel();

    expect(typesOf(events)).toContain('session:cancelled');
    await expect(s.sendMessage('after cancel')).rejects.toBeInstanceOf(SessionStateError);
  });

  it('cancel() during an in-flight turn wins: session:cancelled is the terminal, no turn_completed', async () => {
    const { deps, events } = harness([textTurn('streaming…')]);
    const sink = deps.emit;
    // The cancelling deps must reference the running session, which is constructed after them — a holder.
    const ref: { session?: AgentSession } = {};
    let cancelled = false;
    const cancellingDeps: SessionDeps = {
      ...deps,
      emit: (event) => {
        sink(event);
        // Cancel the moment the first token streams (the turn is in flight inside runAgentTurn).
        if (event.type === 'agent:token' && !cancelled) {
          cancelled = true;
          ref.session?.cancel();
        }
      },
    };
    const s = new AgentSession({
      sessionId: 'sess-2',
      agentRef: AGENT.id,
      agent: AGENT,
      context: CONTEXT,
      deps: cancellingDeps,
    });
    ref.session = s;
    s.start();
    await s.sendMessage('stream then cancel');

    expect(typesOf(events)).toContain('session:cancelled');
    // The cancelled turn must NOT also emit a turn_completed (cancel owns the terminal).
    expect(events.filter((e) => e.type === 'session:turn_completed')).toHaveLength(0);
  });

  it('guards the lifecycle: sendMessage before start, and double start, throw SessionStateError', async () => {
    const { deps } = harness([textTurn('x')]);
    const s = session(deps);
    await expect(s.sendMessage('too early')).rejects.toBeInstanceOf(SessionStateError);
    s.start();
    expect(() => {
      s.start();
    }).toThrow(SessionStateError);
  });

  it('exposes a finite default hard cap', () => {
    expect(DEFAULT_SESSION_MAX_TURNS).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_SESSION_MAX_TURNS)).toBe(true);
  });
});
