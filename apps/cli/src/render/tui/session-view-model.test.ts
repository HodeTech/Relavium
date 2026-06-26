import type { SessionStreamHandleEvent } from '@relavium/core';
import type { ErrorCode } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  appendUserMessage,
  initialSessionViewState,
  MAX_LIVE_TOKEN_CHARS,
  MAX_LIVE_TOOL_CALLS,
  MAX_WARNINGS,
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
      // The 1ms-per-event clock: turn_started @ +1ms, two tokens, turn_completed @ +4ms ⇒ 3ms.
      expect(entry.summary.durationMs).toBe(3);
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
    expect(mid.liveToolCalls).toMatchObject([{ toolId: 'read_file', resolved: false }]);
    expect(mid.liveToolCalls[0]?.id).toMatch(/^tc-/); // a stable, index-free render key
    const resolved = reduceSessionEvent(mid, e.toolResult('read_file'));
    expect(resolved.liveToolCalls).toMatchObject([{ toolId: 'read_file', resolved: true }]);
    expect(resolved.liveToolCalls[0]?.id).toBe(mid.liveToolCalls[0]?.id); // id is preserved across resolve
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

  it('keeps gapDetected set across a following contiguous event AND a turn boundary (monotonic flag)', () => {
    const start = reduceSessionEvent(initialSessionViewState(), {
      type: 'session:turn_started',
      sessionId: 'sess-1',
      sequenceNumber: 0,
      timestamp: '2026-06-25T00:00:00.000Z',
    });
    const gapped = reduceSessionEvent(start, {
      type: 'agent:token',
      sessionId: 'sess-1',
      sequenceNumber: 5, // forward gap
      timestamp: '2026-06-25T00:00:01.000Z',
      nodeId: 'relavium-chat',
      token: 'x',
      model: 'claude-sonnet-4-6',
    });
    const next = reduceSessionEvent(gapped, {
      type: 'session:turn_completed',
      sessionId: 'sess-1',
      sequenceNumber: 6, // contiguous after the gap
      timestamp: '2026-06-25T00:00:02.000Z',
      stopReason: 'stop',
      tokensUsed: { input: 1, output: 1 },
    });
    expect(next.gapDetected).toBe(true); // OR-folded: a later clean event never reverts it
  });

  it('does not append a transcript entry for an empty-text successful turn, but still counts it', () => {
    const e = events();
    const state = reduceAll([e.started(), e.turnStarted(), e.turnCompleted()]);
    expect(state.transcript).toHaveLength(0); // nothing streamed ⇒ no assistant entry (mirrors the engine)
    expect(state.turnCount).toBe(1);
  });

  it('clears all in-flight buffers when session:cancelled arrives mid-turn (the primary cancel path)', () => {
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.token('partial'),
      e.toolCall('read_file'),
      e.cancelled(),
    ]);
    expect(state.status).toBe('ended');
    expect(state.liveTokens).toBe(''); // no dangling partial token in the final frame
    expect(state.liveToolCalls).toEqual([]);
    expect(state.transcript).toHaveLength(0); // the cancelled turn produced no completed entry
  });

  it('stores only the final segment of a multi-tool turn (resets on EACH tool call)', () => {
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.token('preamble '),
      e.toolCall('a'),
      e.token('middle '),
      e.toolCall('b'),
      e.token('final'),
      e.turnCompleted(),
    ]);
    expect(state.transcript[0]).toMatchObject({ role: 'assistant', text: 'final' });
  });

  it('resolves only the first matching unresolved tool call when a toolId repeats', () => {
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.toolCall('read_file'),
      e.toolCall('read_file'),
      e.toolResult('read_file'),
    ]);
    expect(state.liveToolCalls).toMatchObject([
      { toolId: 'read_file', resolved: true },
      { toolId: 'read_file', resolved: false },
    ]);
    // Two calls to the SAME tool get distinct render keys — the case a toolId- or index-based key would collide on.
    expect(state.liveToolCalls[0]?.id).not.toBe(state.liveToolCalls[1]?.id);
  });

  it('interleaves user and assistant entries in turn order', () => {
    const e = events();
    let state: SessionViewState = reduceAll([e.started()]);
    state = appendUserMessage(state, 'hi');
    state = reduceSessionEvent(state, e.turnStarted());
    state = reduceSessionEvent(state, e.token('hello'));
    state = reduceSessionEvent(state, e.turnCompleted());
    state = appendUserMessage(state, 'bye');
    expect(state.transcript.map((t) => `${t.role}:${t.text}`)).toEqual([
      'user:hi',
      'assistant:hello',
      'user:bye',
    ]);
  });

  it('accumulates cost across a turn boundary (the latest cumulative wins)', () => {
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.cost(100),
      e.turnCompleted(),
      e.turnStarted(),
      e.cost(250),
      e.turnCompleted(),
    ]);
    expect(state.cumulativeCostMicrocents).toBe(250);
  });

  it('treats session:exported as a no-op side event', () => {
    const e = events();
    const before = reduceAll([e.started()]);
    const after = reduceSessionEvent(before, {
      type: 'session:exported',
      sessionId: 'sess-1',
      sequenceNumber: 1, // contiguous after started (#0) — no gap, so only lastSequenceNumber advances
      timestamp: '2026-06-25T00:00:01.000Z',
      workflowPath: '/tmp/out.relavium.yaml',
    });
    expect(after.lastSequenceNumber).toBe(1); // the side event still advances the seq high-water mark
    expect({ ...after, lastSequenceNumber: undefined }).toEqual({
      ...before,
      lastSequenceNumber: undefined,
    });
  });

  it('bounds the live token buffer to the trailing MAX_LIVE_TOKEN_CHARS', () => {
    const e = events();
    const big = 'x'.repeat(MAX_LIVE_TOKEN_CHARS + 500);
    const state = reduceAll([e.started(), e.turnStarted(), e.token(big)]);
    expect(state.liveTokens).toHaveLength(MAX_LIVE_TOKEN_CHARS);
  });

  it('bounds the in-flight tool-call list to MAX_LIVE_TOOL_CALLS', () => {
    const e = events();
    const evs = [e.started(), e.turnStarted()];
    for (let i = 0; i < MAX_LIVE_TOOL_CALLS + 3; i++) {
      evs.push(e.toolCall(`tool-${i}`));
    }
    expect(reduceAll(evs).liveToolCalls).toHaveLength(MAX_LIVE_TOOL_CALLS);
  });

  it('keeps the transcript append-only and unbounded (ink <Static> tracks already-printed items by length)', () => {
    let state = initialSessionViewState();
    const n = 600; // well past the old 500 cap — every entry must survive, in order
    for (let i = 0; i < n; i++) {
      state = appendUserMessage(state, `m${i}`);
    }
    // NOT trimmed: head entry is still m0. Trimming the head would freeze the Static cursor and silently
    // stop printing entries past the cap (the F11 bug).
    expect(state.transcript).toHaveLength(n);
    expect(state.transcript[0]).toEqual({ role: 'user', text: 'm0' });
    expect(state.transcript[n - 1]).toEqual({ role: 'user', text: `m${n - 1}` });
  });

  it('bounds the warnings buffer to the trailing MAX_WARNINGS', () => {
    let state = reduceSessionEvent(initialSessionViewState(), {
      type: 'session:turn_started',
      sessionId: 'sess-1',
      sequenceNumber: 100,
      timestamp: '2026-06-25T00:00:00.000Z',
    });
    // Each duplicate (backward) sequenceNumber records one warning; emit more than MAX_WARNINGS.
    for (let i = 0; i < MAX_WARNINGS + 3; i++) {
      state = reduceSessionEvent(state, {
        type: 'agent:token',
        sessionId: 'sess-1',
        sequenceNumber: 1, // stale ⇒ a warning each time
        timestamp: '2026-06-25T00:00:01.000Z',
        nodeId: 'relavium-chat',
        token: 'x',
        model: 'claude-sonnet-4-6',
      });
    }
    expect(state.warnings).toHaveLength(MAX_WARNINGS);
  });

  it('omits durationMs when a turn completes without a preceding turn_started (NaN guard)', () => {
    const e = events();
    // turn_completed with no turn_started ⇒ turnStartedAtMs is undefined ⇒ durationMs must be OMITTED.
    const state = reduceAll([e.started(), e.token('hi'), e.turnCompleted()]);
    const entry = state.transcript[0];
    expect(entry?.role).toBe('assistant');
    if (entry?.role === 'assistant') {
      expect('durationMs' in entry.summary).toBe(false);
    }
  });

  it('clears turnStartedAtMs after each completed turn (so the next turn measures its own duration)', () => {
    const e = events();
    const afterTurn1 = reduceAll([e.started(), e.turnStarted(), e.token('a'), e.turnCompleted()]);
    expect(afterTurn1.turnStartedAtMs).toBeUndefined();
  });

  it('surfaces an error turn that DID stream partial text (keeps the text + the error code)', () => {
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.token('partial '),
      e.turnCompleted({ error: { code: 'provider_unavailable', message: 'boom' } }),
    ]);
    const entry = state.transcript[0];
    expect(entry).toMatchObject({ role: 'assistant', text: 'partial ' });
    if (entry?.role === 'assistant') {
      expect(entry.summary.errorCode).toBe('provider_unavailable');
    }
  });

  it('preserves a detected gap through a mid-turn cancel', () => {
    const start = reduceSessionEvent(initialSessionViewState(), {
      type: 'session:turn_started',
      sessionId: 'sess-1',
      sequenceNumber: 0,
      timestamp: '2026-06-25T00:00:00.000Z',
    });
    const gapped = reduceSessionEvent(start, {
      type: 'agent:token',
      sessionId: 'sess-1',
      sequenceNumber: 9, // forward gap
      timestamp: '2026-06-25T00:00:01.000Z',
      nodeId: 'relavium-chat',
      token: 'x',
      model: 'claude-sonnet-4-6',
    });
    const cancelled = reduceSessionEvent(gapped, {
      type: 'session:cancelled',
      sessionId: 'sess-1',
      sequenceNumber: 10,
      timestamp: '2026-06-25T00:00:02.000Z',
    });
    expect(cancelled.status).toBe('ended');
    expect(cancelled.gapDetected).toBe(true); // a gap survives the terminal
    expect(cancelled.warnings.length).toBeGreaterThan(0);
  });
});
