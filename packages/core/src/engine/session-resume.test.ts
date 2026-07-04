import type { CapabilityFlags, LlmMessage, LlmProvider, StreamChunk } from '@relavium/llm';
import {
  AgentSchema,
  SessionContextSchema,
  type AgentSessionRecord,
  type SessionMessage,
} from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { AgentSession, type SessionDeps, type SessionStreamEvent } from './agent-session.js';
import { createAbortController } from './execution-host.js';
import { reconstructSessionState, type SessionResumeState } from './session-resume.js';
import type { ToolRegistry } from '../tools/types.js';

const TS = '2026-06-17T08:00:00.000Z';
const CTX = SessionContextSchema.parse({ workingDir: '/workspace/s', fsScopeTier: 'sandboxed' });
const AGENT = AgentSchema.parse({
  id: 'chatter',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'You are concise.',
});

const record = (overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
  id: 'sess-1',
  agentSlug: 'chatter',
  context: CTX,
  status: 'idle',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  createdAt: TS,
  updatedAt: TS,
  ...overrides,
});

const msg = (
  sequenceNumber: number,
  role: SessionMessage['role'],
  content: SessionMessage['content'],
): SessionMessage => ({
  id: `m-${sequenceNumber}`,
  sessionId: 'sess-1',
  sequenceNumber,
  role,
  content,
  timestamp: TS,
});

describe('reconstructSessionState (1.Y)', () => {
  it('projects user/assistant text turns and re-seeds turnCount + cost', () => {
    const state = reconstructSessionState(record({ totalCostMicrocents: 4200 }), [
      msg(0, 'user', [{ type: 'text', text: 'hi' }]),
      msg(1, 'assistant', [{ type: 'text', text: 'hello' }]),
      msg(2, 'user', [{ type: 'text', text: 'more' }]),
      msg(3, 'assistant', [{ type: 'text', text: 'sure' }]),
    ]);
    expect(state.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'text', text: 'more' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'sure' }] },
    ]);
    expect(state.turnCount).toBe(2);
    expect(state.cumulativeCostMicrocents).toBe(4200);
  });

  it('rolls back a trailing unanswered user turn (the incomplete-turn idempotency)', () => {
    const state = reconstructSessionState(record(), [
      msg(0, 'user', [{ type: 'text', text: 'hi' }]),
      msg(1, 'assistant', [{ type: 'text', text: 'hello' }]),
      msg(2, 'user', [{ type: 'text', text: 'interrupted — no reply persisted' }]),
    ]);
    expect(state.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ]);
    expect(state.turnCount).toBe(1);
  });

  it('drops system/tool-role messages and non-text parts (text-only in-flight transcript)', () => {
    const state = reconstructSessionState(record(), [
      msg(0, 'system', [{ type: 'text', text: 'system prompt' }]),
      msg(1, 'user', [{ type: 'text', text: 'q' }]),
      msg(2, 'assistant', [
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'a' },
      ]),
    ]);
    expect(state.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ]);
  });

  it('sorts by sequenceNumber before reconstructing', () => {
    const state = reconstructSessionState(record(), [
      msg(1, 'assistant', [{ type: 'text', text: 'hello' }]),
      msg(0, 'user', [{ type: 'text', text: 'hi' }]),
    ]);
    expect(state.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('rolls back an interrupted tool-loop turn ending in a tool result — no dangling user', () => {
    const state = reconstructSessionState(record(), [
      msg(0, 'user', [{ type: 'text', text: 'q1' }]),
      msg(1, 'assistant', [{ type: 'text', text: 'a1' }]), // a completed exchange
      msg(2, 'user', [{ type: 'text', text: 'q2 — use a tool' }]), // the interrupted turn begins
      msg(3, 'assistant', [
        { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'x' } },
      ]),
      msg(4, 'tool', [{ type: 'tool_result', toolCallId: 'c1', result: 'ok', isError: false }]), // died here
    ]);
    // the entire interrupted turn (user + tool_call + tool) is rolled back — the projection drops the
    // tool/text-less-assistant rows and the trailing-user rollback removes the originating q2.
    expect(state.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
    ]);
    expect(state.turnCount).toBe(1);
  });

  it('rolls back a turn whose assistant produced only a tool_call (no committed text)', () => {
    const state = reconstructSessionState(record(), [
      msg(0, 'user', [{ type: 'text', text: 'q' }]),
      msg(1, 'assistant', [{ type: 'tool_call', id: 'c1', name: 'read_file', args: {} }]),
    ]);
    expect(state.messages).toEqual([]); // no completed exchange survives
    expect(state.turnCount).toBe(0);
  });

  it('counts a completed tool-loop turn once (assistant tool_call → tool → assistant text)', () => {
    const state = reconstructSessionState(record(), [
      msg(0, 'user', [{ type: 'text', text: 'q' }]),
      msg(1, 'assistant', [{ type: 'tool_call', id: 'c1', name: 'read_file', args: {} }]), // within-turn
      msg(2, 'tool', [{ type: 'tool_result', toolCallId: 'c1', result: 'ok', isError: false }]),
      msg(3, 'assistant', [{ type: 'text', text: 'final answer' }]), // the completing text
    ]);
    expect(state.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
    ]);
    expect(state.turnCount).toBe(1); // one logical turn — the tool_call-only assistant row is not counted
  });
});

// --- AgentSession.resume integration (stub provider, mirroring agent-session.test.ts) ----------------

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
  for (const chunk of chunks) yield chunk;
}

const textTurn = (text: string): StreamChunk[] => [
  { type: 'text_delta', text },
  { type: 'stop', stopReason: 'stop', usage: { inputTokens: 5, outputTokens: 3 } },
];

const noToolRegistry: ToolRegistry = {
  has: () => false,
  list: () => [],
  dispatch: () => Promise.reject(new Error('no tool dispatch expected')),
};

/** A provider that records the `messages` of each request and replies with a fixed text turn. */
function capturingProvider(seen: LlmMessage[][]): LlmProvider {
  return {
    id: 'anthropic',
    supports: CAPS,
    generate: () => {
      throw new Error('unused');
    },
    stream: (req) => {
      seen.push(req.messages.map((m) => ({ role: m.role, content: [...m.content] })));
      return streamOf(textTurn('resumed reply'));
    },
  };
}

function depsFor(
  provider: LlmProvider,
  events: SessionStreamEvent[],
  maxTurns?: number,
): SessionDeps {
  return {
    resolveProvider: () => provider,
    registry: noToolRegistry,
    tools: [],
    keyFor: () => 'key',
    sleep: () => Promise.resolve(),
    newAbortController: createAbortController,
    emit: (event) => {
      events.push(event);
    },
    ...(maxTurns === undefined ? {} : { maxTurns }),
  };
}

const params = (deps: SessionDeps) => ({
  sessionId: 'sess-1',
  agentRef: AGENT.id,
  agent: AGENT,
  context: CTX,
  deps,
});

describe('AgentSession.resume (1.Y)', () => {
  it('resumes without re-emitting session:started, and the next turn sees the prior transcript', async () => {
    const seen: LlmMessage[][] = [];
    const events: SessionStreamEvent[] = [];
    const state = reconstructSessionState(record(), [
      msg(0, 'user', [{ type: 'text', text: 'hi' }]),
      msg(1, 'assistant', [{ type: 'text', text: 'hello' }]),
    ]);
    const session = AgentSession.resume(params(depsFor(capturingProvider(seen), events)), state);

    // resume does NOT re-emit session:started (the session already started in the prior process).
    expect(events.map((e) => e.type)).not.toContain('session:started');

    await session.sendMessage('again');

    // the provider's call saw the resumed transcript followed by the new user message.
    expect(seen[0]).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ]);
    const types = events.map((e) => e.type);
    expect(types).toContain('session:turn_started');
    expect(types).toContain('session:turn_completed');
  });

  it('honors the hard turn cap across a restart (the resumed turnCount counts)', async () => {
    const seen: LlmMessage[][] = [];
    const events: SessionStreamEvent[] = [];
    // maxTurns 1, resumed already at 1 completed turn → the next turn is over the cap.
    const state: SessionResumeState = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
      turnCount: 1,
      cumulativeCostMicrocents: 0,
    };
    const session = AgentSession.resume(params(depsFor(capturingProvider(seen), events, 1)), state);

    await session.sendMessage('again');

    expect(seen).toHaveLength(0); // blocked loud BEFORE any egress — the provider was never called
    const completed = events.filter((e) => e.type === 'session:turn_completed');
    expect(completed).toHaveLength(1);
    const only = completed[0];
    expect(only?.type === 'session:turn_completed' && only.error?.code).toBe('turn_limit');
  });

  it('syncs a host-wired budget governor with the carried-over cost on resume', () => {
    const events: SessionStreamEvent[] = [];
    const costs: number[] = [];
    const deps: SessionDeps = {
      ...depsFor(capturingProvider([]), events),
      updateCost: (cost) => {
        costs.push(cost);
      },
    };
    AgentSession.resume(params(deps), {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      turnCount: 1,
      cumulativeCostMicrocents: 4200,
    });
    // the governor is seeded once, at resume, with the absolute cumulative — so the first resumed turn's
    // pre-egress check sees the real spend, not 0 (before any cost:updated fires).
    expect(costs).toEqual([4200]);
  });
});

describe('reconstructSessionState — context-compaction boundary markers (ADR-0062)', () => {
  const marker = (
    sequenceNumber: number,
    summary: string,
    droppedThroughSequence: number,
  ): SessionMessage => ({
    ...msg(sequenceNumber, 'system', summary.length > 0 ? [{ type: 'text', text: summary }] : []),
    compaction: { droppedThroughSequence },
  });

  it('drops the folded prefix and restores the compact summary as the preamble', () => {
    // A `/compact` folded seq 0..1 into 'S1' (marker@4, D=1) and kept the last exchange (u2/a3); then u5/a6.
    const state = reconstructSessionState(record({ totalCostMicrocents: 10 }), [
      msg(0, 'user', [{ type: 'text', text: 'old-q' }]),
      msg(1, 'assistant', [{ type: 'text', text: 'old-a' }]),
      msg(2, 'user', [{ type: 'text', text: 'kept-q' }]),
      msg(3, 'assistant', [{ type: 'text', text: 'kept-a' }]),
      marker(4, 'S1', 1),
      msg(5, 'user', [{ type: 'text', text: 'new-q' }]),
      msg(6, 'assistant', [{ type: 'text', text: 'new-a' }]),
    ]);
    expect(state.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'kept-q' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'kept-a' }] },
      { role: 'user', content: [{ type: 'text', text: 'new-q' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'new-a' }] },
    ]);
    expect(state.contextPreamble).toBe('S1');
    expect(state.turnCount).toBe(2); // two surviving assistant turns
  });

  it('a later summary-less /trim advances the boundary but does NOT blank the prior compact summary (B4)', () => {
    // compact@2 ('S1', D=1) → u3/a4 → trim@5 (no summary, D=4) → u6/a7.
    const state = reconstructSessionState(record(), [
      msg(0, 'user', [{ type: 'text', text: 'q0' }]),
      msg(1, 'assistant', [{ type: 'text', text: 'a1' }]),
      marker(2, 'S1', 1),
      msg(3, 'user', [{ type: 'text', text: 'q3' }]),
      msg(4, 'assistant', [{ type: 'text', text: 'a4' }]),
      marker(5, '', 4), // a /trim marker: empty summary, boundary advanced to 4
      msg(6, 'user', [{ type: 'text', text: 'q6' }]),
      msg(7, 'assistant', [{ type: 'text', text: 'a7' }]),
    ]);
    // Boundary = max(1, 4) = 4 → only seq > 4 survive; preamble = newest marker WITH a summary = 'S1'.
    expect(state.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q6' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a7' }] },
    ]);
    expect(state.contextPreamble).toBe('S1');
  });

  it('uses the NEWEST summary-bearing marker as the preamble across multiple compactions', () => {
    const state = reconstructSessionState(record(), [
      msg(0, 'user', [{ type: 'text', text: 'q0' }]),
      msg(1, 'assistant', [{ type: 'text', text: 'a1' }]),
      marker(2, 'S1', 1),
      msg(3, 'user', [{ type: 'text', text: 'q3' }]),
      msg(4, 'assistant', [{ type: 'text', text: 'a4' }]),
      marker(5, 'S2', 4),
      msg(6, 'user', [{ type: 'text', text: 'q6' }]),
      msg(7, 'assistant', [{ type: 'text', text: 'a7' }]),
    ]);
    expect(state.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q6' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a7' }] },
    ]);
    expect(state.contextPreamble).toBe('S2');
  });

  it('no markers ⇒ no preamble (backward-compatible with a never-compacted session)', () => {
    const state = reconstructSessionState(record(), [
      msg(0, 'user', [{ type: 'text', text: 'q' }]),
      msg(1, 'assistant', [{ type: 'text', text: 'a' }]),
    ]);
    expect(state.contextPreamble).toBeUndefined();
    expect(state.messages).toHaveLength(2);
  });
});
