import type { SessionStreamHandleEvent } from '@relavium/core';
import type { ErrorCode } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  appendUserMessage,
  initialSessionViewState,
  reduceSessionEvent,
  type SessionViewState,
} from './session-view-model.js';

// --- A typed session-event factory: monotonic sequenceNumber + a 1ms-per-event clock (for durations). ----
function events() {
  let seq = 0;
  let ms = Date.parse('2026-06-25T00:00:00.000Z');
  const stamp = () => ({
    sessionId: 'sess-1',
    sequenceNumber: seq++,
    timestamp: new Date(ms++).toISOString(),
  });
  const NODE = 'relavium-chat';
  const MODEL = 'claude-sonnet-4-6';
  return {
    started: (): SessionStreamHandleEvent => ({
      type: 'session:started',
      ...stamp(),
      agentRef: NODE,
      model: MODEL,
      context: { workingDir: '/w', fsScopeTier: 'sandboxed' },
    }),
    turnStarted: (): SessionStreamHandleEvent => ({ type: 'session:turn_started', ...stamp() }),
    token: (token: string): SessionStreamHandleEvent => ({
      type: 'agent:token',
      ...stamp(),
      nodeId: NODE,
      token,
      model: MODEL,
    }),
    toolCall: (toolId: string): SessionStreamHandleEvent => ({
      type: 'agent:tool_call',
      ...stamp(),
      nodeId: NODE,
      model: MODEL,
      toolId,
      toolInput: {},
    }),
    toolResult: (toolId: string): SessionStreamHandleEvent => ({
      type: 'agent:tool_result',
      ...stamp(),
      nodeId: NODE,
      toolId,
      success: true,
      outputSummary: 'ok',
    }),
    cost: (cumulative: number): SessionStreamHandleEvent => ({
      type: 'cost:updated',
      ...stamp(),
      nodeId: NODE,
      model: MODEL,
      inputTokens: 10,
      outputTokens: 5,
      costMicrocents: cumulative,
      cumulativeCostMicrocents: cumulative,
    }),
    turnCompleted: (
      opts: { stopReason?: 'stop' | 'tool_use'; error?: { code: ErrorCode; message: string } } = {},
    ): SessionStreamHandleEvent => ({
      type: 'session:turn_completed',
      ...stamp(),
      stopReason: opts.error === undefined ? (opts.stopReason ?? 'stop') : 'error',
      tokensUsed: { input: 10, output: 5 },
      ...(opts.error === undefined
        ? {}
        : { error: { code: opts.error.code, message: opts.error.message, retryable: false } }),
    }),
    cancelled: (): SessionStreamHandleEvent => ({ type: 'session:cancelled', ...stamp() }),
  };
}

const reduceAll = (evs: readonly SessionStreamHandleEvent[]): SessionViewState =>
  evs.reduce(reduceSessionEvent, initialSessionViewState());

describe('session-view-model', () => {
  it('records agent + model from session:started', () => {
    const e = events();
    const state = reduceAll([e.started()]);
    expect(state.agentRef).toBe('relavium-chat');
    expect(state.model).toBe('claude-sonnet-4-6');
    expect(state.status).toBe('idle');
  });

  it('appendUserMessage adds a user transcript entry', () => {
    const state = appendUserMessage(initialSessionViewState(), 'hello');
    expect(state.transcript).toEqual([{ role: 'user', text: 'hello' }]);
  });

  it('streams a text turn: running while live, then a completed assistant entry with a summary', () => {
    const e = events();
    const mid = reduceAll([e.started(), e.turnStarted(), e.token('hel'), e.token('lo')]);
    expect(mid.status).toBe('running');
    expect(mid.liveTokens).toBe('hello');

    const done = reduceSessionEvent(mid, e.turnCompleted());
    expect(done.status).toBe('idle');
    expect(done.liveTokens).toBe(''); // live buffer cleared on completion
    expect(done.turnCount).toBe(1);
    expect(done.transcript).toHaveLength(1);
    const entry = done.transcript[0];
    expect(entry).toMatchObject({ role: 'assistant', text: 'hello' });
    if (entry?.role === 'assistant') {
      expect(entry.summary.stopReason).toBe('stop');
      expect(entry.summary.tokensUsed).toEqual({ input: 10, output: 5 });
      expect(entry.summary.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('drops a pre-tool preamble from the stored assistant text (mirrors result.text), annotates the call', () => {
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.token('let me check… '),
      e.toolCall('read_file'),
      e.toolResult('read_file'),
      e.token('the answer'),
      e.turnCompleted({ stopReason: 'stop' }),
    ]);
    const entry = state.transcript[0];
    expect(entry).toMatchObject({ role: 'assistant', text: 'the answer' }); // preamble dropped
  });

  it('tracks live tool calls and marks them resolved on the result', () => {
    const e = events();
    const mid = reduceAll([e.started(), e.turnStarted(), e.toolCall('read_file')]);
    expect(mid.liveToolCalls).toEqual([{ toolId: 'read_file', resolved: false }]);
    const resolved = reduceSessionEvent(mid, e.toolResult('read_file'));
    expect(resolved.liveToolCalls).toEqual([{ toolId: 'read_file', resolved: true }]);
  });

  it('stamps the running cost from cost:updated', () => {
    const e = events();
    const state = reduceAll([e.started(), e.turnStarted(), e.cost(1234)]);
    expect(state.cumulativeCostMicrocents).toBe(1234);
  });

  it('shows an error turn in the transcript with its error code, still counting the turn', () => {
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.turnCompleted({ error: { code: 'turn_limit', message: 'reached cap' } }),
    ]);
    expect(state.turnCount).toBe(1);
    const entry = state.transcript[0];
    expect(entry?.role).toBe('assistant');
    if (entry?.role === 'assistant') {
      expect(entry.summary.errorCode).toBe('turn_limit');
    }
  });

  it('ends the session on session:cancelled', () => {
    const e = events();
    const state = reduceAll([e.started(), e.cancelled()]);
    expect(state.status).toBe('ended');
  });

  it('reduces multiple turns, accumulating the transcript and turn count', () => {
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.token('one'),
      e.turnCompleted(),
      e.turnStarted(),
      e.token('two'),
      e.turnCompleted(),
    ]);
    expect(state.turnCount).toBe(2);
    expect(state.transcript.map((t) => (t.role === 'assistant' ? t.text : t.role))).toEqual([
      'one',
      'two',
    ]);
  });

  it('detects a forward sequenceNumber gap (applies the event, flags + warns)', () => {
    const start = reduceSessionEvent(initialSessionViewState(), {
      type: 'session:turn_started',
      sessionId: 'sess-1',
      sequenceNumber: 0,
      timestamp: '2026-06-25T00:00:00.000Z',
    });
    const gapped = reduceSessionEvent(start, {
      type: 'agent:token',
      sessionId: 'sess-1',
      sequenceNumber: 5, // jumped past #1..#4
      timestamp: '2026-06-25T00:00:01.000Z',
      nodeId: 'relavium-chat',
      token: 'x',
      model: 'claude-sonnet-4-6',
    });
    expect(gapped.gapDetected).toBe(true);
    expect(gapped.liveTokens).toBe('x'); // forward gap still applies the genuine event
    expect(gapped.warnings.some((w) => w.includes('gap'))).toBe(true);
  });

  it('ignores a backward/duplicate sequenceNumber (records a warning, does NOT apply)', () => {
    const e = events();
    const twoTokens = reduceAll([e.started(), e.turnStarted(), e.token('a'), e.token('b')]);
    const dup = reduceSessionEvent(twoTokens, {
      type: 'agent:token',
      sessionId: 'sess-1',
      sequenceNumber: 1, // stale, far behind the high-water mark
      timestamp: '2026-06-25T00:00:09.000Z',
      nodeId: 'relavium-chat',
      token: 'STALE',
      model: 'claude-sonnet-4-6',
    });
    expect(dup.liveTokens).toBe('ab'); // the stale token was NOT applied
    expect(dup.gapDetected).toBe(true);
    expect(dup.warnings.some((w) => w.includes('out of order'))).toBe(true);
  });
});
