import type { SessionStreamHandleEvent } from '@relavium/core';
import { contextWindowForModel } from '@relavium/llm';
import type { ErrorCode, SessionStopReason } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  appendUserMessage,
  initialSessionViewState,
  MAX_LIVE_TOKEN_CHARS,
  MAX_LIVE_TOOL_CALLS,
  MAX_WARNINGS,
  reduceSessionEvent,
  type SessionViewState,
  FULLSCREEN_TRANSCRIPT_BOUND,
  INLINE_TRANSCRIPT_BOUND,
  carriesSeedTranscript,
  type TranscriptEntry,
  assertRenderStoreAgree,
  type TranscriptBound,
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
    reasoning: (text: string): SessionStreamHandleEvent => ({
      type: 'agent:reasoning',
      ...stamp(),
      nodeId: NODE,
      text,
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
    cost: (cumulative: number, model: string = MODEL): SessionStreamHandleEvent => ({
      type: 'cost:updated',
      ...stamp(),
      nodeId: NODE,
      model, // defaults to the bound MODEL; a test passes a DIFFERENT id to simulate a within-turn failover
      inputTokens: 10,
      outputTokens: 5,
      costMicrocents: cumulative,
      cumulativeCostMicrocents: cumulative,
    }),
    turnCompleted: (
      opts: { stopReason?: SessionStopReason; error?: { code: ErrorCode; message: string } } = {},
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
    compacted: (reason: 'manual' | 'auto-threshold'): SessionStreamHandleEvent => ({
      type: 'session:compacted',
      ...stamp(),
      reason,
      summary: 'we set up the project and the db',
      keptMessageCount: 2,
      tokensBefore: 14200,
      tokensAfter: 900,
      tokensUsed: { input: 14000, output: 340 },
    }),
    trimmed: (reason: 'manual' | 'auto-fallback'): SessionStreamHandleEvent => ({
      type: 'session:trimmed',
      ...stamp(),
      reason,
      keptMessageCount: 20,
      droppedMessageCount: 8,
    }),
    compacting: (reason: 'manual' | 'auto-threshold'): SessionStreamHandleEvent => ({
      type: 'session:compacting',
      ...stamp(),
      reason,
    }),
  };
}

const reduceAll = (evs: readonly SessionStreamHandleEvent[]): SessionViewState =>
  evs.reduce(reduceSessionEvent, initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND));

describe('session-view-model', () => {
  it('records agent + model from session:started', () => {
    const e = events();
    const state = reduceAll([e.started()]);
    expect(state.agentRef).toBe('relavium-chat');
    expect(state.model).toBe('claude-sonnet-4-6');
    expect(state.status).toBe('idle');
  });

  it('appendUserMessage adds a user transcript entry', () => {
    const state = appendUserMessage(
      initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND),
      'hello',
    );
    expect(state.transcript).toEqual([{ role: 'user', text: 'hello' }]);
  });

  it('a fresh (unseeded) initial state has an empty header + zero totals', () => {
    const state = initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND);
    expect(state.agentRef).toBeUndefined();
    expect(state.model).toBeUndefined();
    expect(state.cumulativeCostMicrocents).toBe(0);
    expect(state.turnCount).toBe(0);
  });

  it('a resume seed (2.N) pre-sets the header model/agent + carried cost/turn count', () => {
    const state = initialSessionViewState(
      {
        agentRef: 'coder',
        model: 'claude-opus-4-8',
        cumulativeCostMicrocents: 4200,
        turnCount: 3,
        transcript: [],
      },
      INLINE_TRANSCRIPT_BOUND,
    );
    expect(state.agentRef).toBe('coder');
    expect(state.model).toBe('claude-opus-4-8');
    expect(state.cumulativeCostMicrocents).toBe(4200);
    expect(state.turnCount).toBe(3);
    expect(state.status).toBe('idle'); // a resumed session is idle, ready for the next turn
    expect(state.transcript).toEqual([]); // the prior transcript stays durable, not replayed into the view
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

  it('projects a mid-turn abort (ADR-0057 EA7) into a turn summary with stopReason "aborted" and no error', () => {
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.token('partial'),
      e.turnCompleted({ stopReason: 'aborted' }), // EA7: aborted carries NO error
    ]);
    const entry = state.transcript[0];
    expect(entry).toMatchObject({ role: 'assistant', text: 'partial' });
    if (entry?.role === 'assistant') {
      expect(entry.summary.stopReason).toBe('aborted');
      expect(entry.summary.errorCode).toBeUndefined(); // user-initiated, not a failure
    }
    expect(state.status).toBe('idle'); // the session stays alive after an abort
  });

  it('an abort with NO streamed text still appends a trace entry (Esc at the approval prompt is confirmed)', () => {
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      // No token — the common abort-during-approval case (Esc at the [y]/[a]/[n] prompt before any text streamed).
      e.turnCompleted({ stopReason: 'aborted' }),
    ]);
    expect(state.transcript).toHaveLength(1); // NOT silently dropped
    const entry = state.transcript[0];
    expect(entry).toMatchObject({ role: 'assistant', text: '' });
    if (entry?.role === 'assistant') expect(entry.summary.stopReason).toBe('aborted');
    expect(state.status).toBe('idle');
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
    const start = reduceSessionEvent(initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND), {
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
    const start = reduceSessionEvent(initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND), {
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
    let state = initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND);
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
    let state = reduceSessionEvent(initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND), {
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
    const start = reduceSessionEvent(initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND), {
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

  it('surfaces an AUTOMATIC compaction as an inline notice, but not a manual /compact (ADR-0062)', () => {
    const e = events();
    // Auto-compaction (reason 'auto-threshold') → a concise ⟳ notice appended to the transcript, so it is
    // never a silent context swap. Numbers only (no summary text) — the manual /compact shows the summary.
    const auto = reduceSessionEvent(
      initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND),
      e.compacted('auto-threshold'),
    );
    const notice = auto.transcript.at(-1);
    expect(notice?.role).toBe('notice');
    expect(notice?.role === 'notice' && notice.text).toContain('auto-compacted');
    expect(notice?.role === 'notice' && notice.text).toContain('14,200'); // grouped token deltas
    expect(notice?.role === 'notice' && notice.text).not.toContain('we set up'); // summary NOT dumped inline

    // A MANUAL /compact is noticed by the command itself, so the view makes NO transcript change here.
    const manual = reduceSessionEvent(
      initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND),
      e.compacted('manual'),
    );
    expect(manual.transcript).toHaveLength(0);
  });

  it('surfaces the AUTO-FALLBACK trim as a notice, but not a manual /trim (ADR-0062)', () => {
    const e = events();
    // The deterministic trim the engine degrades to when auto-compaction's summariser fails must NOT be silent.
    const fallback = reduceSessionEvent(
      initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND),
      e.trimmed('auto-fallback'),
    );
    const notice = fallback.transcript.at(-1);
    expect(notice?.role).toBe('notice');
    expect(notice?.role === 'notice' && notice.text).toContain('Auto-compaction summary failed');
    // A MANUAL /trim is noticed by the command, so the view makes NO transcript change.
    expect(
      reduceSessionEvent(
        initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND),
        e.trimmed('manual'),
      ).transcript,
    ).toHaveLength(0);
  });

  it('enters the compaction moment on session:compacting and clears it on the terminal (ADR-0062 §7)', () => {
    const e = events();
    const start = reduceAll([e.started()]);
    expect(start.compacting).toBe(false);
    const compacting = reduceSessionEvent(start, e.compacting('manual'));
    expect(compacting.compacting).toBe(true);
    // A cost:updated during the summary (the summariser's only forwarded event) PRESERVES the moment.
    const midCost = reduceSessionEvent(compacting, e.cost(100));
    expect(midCost.compacting).toBe(true);
    // The terminal session:compacted ends the moment.
    expect(reduceSessionEvent(midCost, e.compacted('manual')).compacting).toBe(false);
    // An auto-fallback trim (summariser failed) also ends it.
    expect(reduceSessionEvent(compacting, e.trimmed('auto-fallback')).compacting).toBe(false);
  });

  it('clears a stale compaction moment on the next turn (a manual /compact failure emits no terminal)', () => {
    const e = events();
    const stuck = reduceAll([e.started(), e.compacting('manual')]); // no terminal ⇒ still "compacting"
    expect(stuck.compacting).toBe(true);
    expect(reduceSessionEvent(stuck, e.turnStarted()).compacting).toBe(false); // the next turn resets it
  });

  it('tracks last-turn input tokens + the model context window for the footer fullness (ADR-0062 §7)', () => {
    const e = events();
    const start = reduceAll([e.started()]); // MODEL is a known-catalog id ⇒ a resolved window
    expect(start.contextWindowTokens).toBe(contextWindowForModel('claude-sonnet-4-6'));
    expect(start.contextWindowTokens).toBeGreaterThan(0);
    expect(start.lastInputTokens).toBeUndefined(); // no turn yet ⇒ no numerator
    const afterTurn = reduceAll([e.started(), e.turnStarted(), e.turnCompleted()]);
    expect(afterTurn.lastInputTokens).toBe(10); // the turn's tokensUsed.input
    expect(afterTurn.contextWindowTokens).toBe(contextWindowForModel('claude-sonnet-4-6'));
  });

  it('seeds the context window from a resume seed model (a resumed session never re-emits session:started)', () => {
    const seeded = initialSessionViewState(
      {
        model: 'claude-sonnet-4-6',
        turnCount: 3,
        transcript: [],
      },
      INLINE_TRANSCRIPT_BOUND,
    );
    expect(seeded.contextWindowTokens).toBe(contextWindowForModel('claude-sonnet-4-6'));
    expect(seeded.lastInputTokens).toBeUndefined(); // no per-turn seed until the first resumed turn completes
  });
});

describe('session-view-model — live-turn feedback + attribution (2.5.H)', () => {
  it('flags liveTokensTruncated when the live buffer head scrolls out (the elision marker source)', () => {
    const e = events();
    const long = 'x'.repeat(MAX_LIVE_TOKEN_CHARS + 50);
    const state = reduceAll([e.started(), e.turnStarted(), e.token(long)]);
    expect(state.liveTokens).toHaveLength(MAX_LIVE_TOKEN_CHARS); // only the trailing window is kept
    expect(state.liveTokensTruncated).toBe(true); // …so the render shows a leading elision marker, not a silent loss
  });

  it('keeps liveTokensTruncated false under the cap and resets it on a tool-call boundary', () => {
    const e = events();
    const under = reduceAll([e.started(), e.turnStarted(), e.token('hello')]);
    expect(under.liveTokensTruncated).toBe(false);
    const afterTool = reduceAll([
      e.started(),
      e.turnStarted(),
      e.token('y'.repeat(MAX_LIVE_TOKEN_CHARS + 10)),
      e.toolCall('read_file'),
    ]);
    expect(afterTool.liveTokens).toBe(''); // the segment after the last tool call starts fresh
    expect(afterTool.liveTokensTruncated).toBe(false); // …and the elision flag resets with it
  });

  it('resets liveTokensTruncated on turn_completed and on cancel', () => {
    const e = events();
    const overflow = () => e.token('z'.repeat(MAX_LIVE_TOKEN_CHARS + 1));
    const done = reduceAll([e.started(), e.turnStarted(), overflow(), e.turnCompleted()]);
    expect(done.liveTokensTruncated).toBe(false);
    const cancelled = reduceAll([e.started(), e.turnStarted(), overflow(), e.cancelled()]);
    expect(cancelled.liveTokensTruncated).toBe(false);
  });

  it('bakes the elision marker into the FINALIZED transcript entry so a truncated answer stays visible', () => {
    // The marker must survive turn completion: a completed turn lands in ink <Static> (permanent scrollback)
    // rendered verbatim, so the reducer bakes `…` into the display text — else the head silently vanishes exactly
    // when the turn ends (the loss the feature exists to surface). (The DURABLE record via the persister is full.)
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.token('z'.repeat(MAX_LIVE_TOKEN_CHARS + 20)),
      e.turnCompleted(),
    ]);
    const last = state.transcript.at(-1);
    expect(last?.role === 'assistant' && last.text.startsWith('…')).toBe(true);
  });

  it('does NOT prefix the elision marker on a non-truncated completed turn', () => {
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.token('a short answer'),
      e.turnCompleted(),
    ]);
    const last = state.transcript.at(-1);
    expect(last?.role === 'assistant' && last.text).toBe('a short answer');
  });

  it('attributes a completed turn to the committed model on a within-turn failover', () => {
    const e = events();
    // The LAST cost:updated of the turn carries the committed (failed-over) model, distinct from the bound model.
    const state = reduceAll([
      e.started(), // bound model = claude-sonnet-4-6
      e.turnStarted(),
      e.token('hi'),
      e.cost(1, 'claude-opus-4-8'), // committed model differs ⇒ attributed on the summary
      e.turnCompleted(),
    ]);
    const last = state.transcript.at(-1);
    expect(last?.role === 'assistant' && last.summary.model).toBe('claude-opus-4-8');
  });

  it('keeps the LAST cost:updated model across a multi-attempt turn (the committed model)', () => {
    const e = events();
    // Two attempts: the first model fails over to the second, which commits — the summary shows the last (B).
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.cost(1, 'claude-sonnet-4-6'), // attempt A (== bound)
      e.token('hi'),
      e.cost(2, 'claude-opus-4-8'), // attempt B commits (the final cost:updated before turn_completed)
      e.turnCompleted(),
    ]);
    const last = state.transcript.at(-1);
    expect(last?.role === 'assistant' && last.summary.model).toBe('claude-opus-4-8');
  });

  it('omits the summary model when the committed model equals the bound model (no redundant noise)', () => {
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.token('hi'),
      e.cost(1), // same as the bound model
      e.turnCompleted(),
    ]);
    const last = state.transcript.at(-1);
    expect(last?.role === 'assistant' && last.summary.model).toBeUndefined();
  });

  it('resets activeTurnModel between turns so a failover never leaks into the next turn', () => {
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.token('a'),
      e.cost(1, 'claude-opus-4-8'),
      e.turnCompleted(),
      e.turnStarted(),
      e.token('b'), // this turn engaged no cost:updated ⇒ activeTurnModel stays reset
      e.turnCompleted(),
    ]);
    const last = state.transcript.at(-1);
    expect(last?.role === 'assistant' && last.text).toBe('b');
    expect(last?.role === 'assistant' && last.summary.model).toBeUndefined();
  });
});

describe('session-view-model — reasoning fold (EA6, 2.5.H)', () => {
  it('accumulates agent:reasoning into liveReasoning', () => {
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.reasoning('let me '),
      e.reasoning('think'),
    ]);
    expect(state.liveReasoning).toBe('let me think');
    expect(state.liveReasoningTruncated).toBe(false);
  });

  it('flags liveReasoningTruncated when the reasoning buffer head scrolls out', () => {
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.reasoning('r'.repeat(MAX_LIVE_TOKEN_CHARS + 5)),
    ]);
    expect(state.liveReasoning).toHaveLength(MAX_LIVE_TOKEN_CHARS);
    expect(state.liveReasoningTruncated).toBe(true);
  });

  it('keeps the reasoning truncation flag STICKY across a later non-truncating delta', () => {
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.reasoning('r'.repeat(MAX_LIVE_TOKEN_CHARS + 5)), // truncates
      e.reasoning(' more'), // this delta alone would not truncate, but the flag stays set for the segment
    ]);
    expect(state.liveReasoningTruncated).toBe(true);
  });

  it('accumulates reasoning ACROSS a tool call (unlike liveTokens, which resets per tool round)', () => {
    const e = events();
    const state = reduceAll([
      e.started(),
      e.turnStarted(),
      e.reasoning('before tool'),
      e.toolCall('read_file'),
      e.reasoning(' after tool'),
    ]);
    expect(state.liveReasoning).toBe('before tool after tool'); // the whole turn's thinking
    expect(state.liveTokens).toBe(''); // liveTokens WAS reset by the tool call — they diverge by design
  });

  it('resets reasoning on turn_started, turn_completed, and cancel (per-turn lifecycle)', () => {
    const e = events();
    const nextTurn = reduceAll([e.started(), e.turnStarted(), e.reasoning('x'), e.turnStarted()]);
    expect(nextTurn.liveReasoning).toBe('');
    const done = reduceAll([
      e.started(),
      e.turnStarted(),
      e.reasoning('x'),
      e.token('a'),
      e.turnCompleted(),
    ]);
    expect(done.liveReasoning).toBe('');
    expect(done.liveReasoningTruncated).toBe(false);
    const cancelled = reduceAll([e.started(), e.turnStarted(), e.reasoning('x'), e.cancelled()]);
    expect(cancelled.liveReasoning).toBe('');
  });
});

/**
 * THE CAPS-LIFT (2.6.F Step 6g, ADR-0068 Decision (c)).
 *
 * ADR-0068 exists because "a long response is clipped and its full text survives only in SQLite — unreachable by
 * scrolling". Until Step 6g the bound was a CONSTANT and `reduceTurnCompleted` baked the transcript entry from the
 * live region's 4000-char render budget — so the full-screen viewport, built to scroll a long answer, could never be
 * given one. The Step-4b-3 amendment's "caps-lift" was a name collision: it shipped the per-entry wrap cache.
 */
describe('the transcript bake is bounded by the RENDERER, not by a constant', () => {
  /** Reduce `evs` from a state seeded with an explicit renderer bound. */
  const reduceWithBound = (
    bound: TranscriptBound,
    evs: readonly SessionStreamHandleEvent[],
  ): SessionViewState => evs.reduce(reduceSessionEvent, initialSessionViewState(undefined, bound));

  const oneTurn = (bound: TranscriptBound, chars: number): SessionViewState => {
    const e = events();
    return reduceWithBound(bound, [e.turnStarted(), e.token('X'.repeat(chars)), e.turnCompleted()]);
  };

  const lastEntry = (state: SessionViewState): string => state.transcript.at(-1)?.text ?? '';

  it('FULL-SCREEN keeps a 10 000-character answer whole — the defect this phase exists to fix', () => {
    const state = oneTurn(FULLSCREEN_TRANSCRIPT_BOUND, 10_000);
    expect(lastEntry(state)).toHaveLength(10_000);
    expect(lastEntry(state).startsWith('…')).toBe(false);
  });

  it('INLINE keeps the historical trailing tail and its elision marker — byte-identical to before', () => {
    const state = oneTurn(INLINE_TRANSCRIPT_BOUND, 10_000);
    expect(lastEntry(state)).toHaveLength(MAX_LIVE_TOKEN_CHARS + 1);
    expect(lastEntry(state).startsWith('…')).toBe(true);
  });

  it('the LIVE REGION stays bounded on BOTH renderers — it re-wraps every frame', () => {
    // The two accumulators answer different questions. Unbounding `liveTokens` would re-segment 10 000 chars at 30fps.
    const bounds: readonly TranscriptBound[] = [
      FULLSCREEN_TRANSCRIPT_BOUND,
      INLINE_TRANSCRIPT_BOUND,
    ];
    for (const bound of bounds) {
      const e = events();
      const state = reduceWithBound(bound, [e.turnStarted(), e.token('X'.repeat(10_000))]);
      expect(state.liveTokens).toHaveLength(MAX_LIVE_TOKEN_CHARS);
      expect(state.liveTokensTruncated).toBe(true);
      expect(state.turnText).toHaveLength(bound === INLINE_TRANSCRIPT_BOUND ? 4000 : 10_000);
    }
  });

  it('a TOOL CALL resets the kept text too — the entry is the segment after the last tool call', () => {
    // Mirrors the engine's `result.text` and the persister. Forgetting to reset `turnText` here would bake the
    // pre-tool-call prose into the final entry, which the durable record does not contain.
    const e = events();
    const state = reduceWithBound(FULLSCREEN_TRANSCRIPT_BOUND, [
      e.turnStarted(),
      e.token('BEFORE'),
      e.toolCall('read_file'),
      e.token('AFTER'),
      e.turnCompleted(),
    ]);
    expect(lastEntry(state)).toBe('AFTER');
  });

  it('a CANCELLED turn clears the kept text, so a later turn cannot inherit it', () => {
    const e = events();
    const state = reduceWithBound(FULLSCREEN_TRANSCRIPT_BOUND, [
      e.turnStarted(),
      e.token('partial'),
      e.cancelled(),
    ]);
    expect(state.turnText).toBe('');
  });

  it('the default bound is the INLINE one — a caller that forgets keeps today’s behaviour', () => {
    expect(initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND).transcriptBound).toBe(
      INLINE_TRANSCRIPT_BOUND,
    );
  });
});

/**
 * The SEED TRANSCRIPT CARRY and its one gate (2.6.C — the F1 fix).
 *
 * A `/models` reseat swaps in a brand-new view store. Before this, that store's transcript was hardcoded `[]`, so on
 * the FULL-SCREEN renderer — whose viewport windows the store's in-memory transcript, and whose alt buffer has no
 * native scrollback — the whole conversation vanished from the screen. (Inline was unaffected: its lines were already
 * printed by ink `<Static>` and physically survive the swap.)
 *
 * The fix carries the outgoing store's rendered transcript into the new store's seed — but ONLY on the full-screen
 * renderer. Seeding it inline would make `<Static>` RE-PRINT the whole conversation over the copy the terminal already
 * holds. So the gate is load-bearing in BOTH directions, and both directions are pinned here.
 */
describe('the seed transcript carry (2.6.C) and its full-screen-only gate', () => {
  // A realistic carry: the three entry variants a live conversation actually holds.
  const prior: readonly TranscriptEntry[] = [
    { role: 'user', text: 'first question' },
    {
      role: 'assistant',
      text: 'first answer',
      summary: { stopReason: 'stop', tokensUsed: { input: 10, output: 20 } },
    },
    { role: 'notice', text: '⚙ a command notice' },
  ];

  it('FULL-SCREEN: a seeded transcript IS carried into the initial state', () => {
    const state = initialSessionViewState(
      { model: 'claude-opus-4-8', transcript: prior },
      FULLSCREEN_TRANSCRIPT_BOUND,
    );
    expect(state.transcript).toEqual(prior);
  });

  it('INLINE: the SAME seed is IGNORED — <Static> already printed those lines, re-seeding would double-print', () => {
    const state = initialSessionViewState(
      { model: 'claude-opus-4-8', transcript: prior },
      INLINE_TRANSCRIPT_BOUND,
    );
    expect(state.transcript).toEqual([]);
  });

  // NOTE: there is deliberately no "an unknown bound degrades to inline" test. `TranscriptBound` is a CLOSED union,
  // so a third bound is a COMPILE error — the invariant is carried by the type, not by a defensive runtime branch and
  // a test asserting it. (It used to be a bare `number` with a silent inline default, which is precisely how the F1
  // hole stayed open from the other side: a full-screen caller that forgot the bound got no error and a blank screen.)

  it('carriesSeedTranscript pins the gate directly', () => {
    expect(carriesSeedTranscript(FULLSCREEN_TRANSCRIPT_BOUND)).toBe(true);
    expect(carriesSeedTranscript(INLINE_TRANSCRIPT_BOUND)).toBe(false);
  });

  it('an EMPTY carry is identical to no carry (a fresh session / chat-resume / clear)', () => {
    expect(
      initialSessionViewState({ transcript: [] }, FULLSCREEN_TRANSCRIPT_BOUND).transcript,
    ).toEqual([]);
    expect(initialSessionViewState(undefined, FULLSCREEN_TRANSCRIPT_BOUND).transcript).toEqual([]);
  });
});

/**
 * THE RENDER/STORE AGREEMENT INVARIANT (2.6.C). `ChatView` calls {@link assertRenderStoreAgree} under VITEST so a
 * future refactor that lets the render discriminator and the seed-transcript gate drift apart fails in CI instead of
 * corrupting a user's screen. Pinning the predicate HERE (rather than only through a mounted render) is what makes
 * that guard real: a render-time throw does not escape React synchronously, so an `expect(render).toThrow()` proves
 * nothing — but this does, and the mounted suites prove the wiring by simply staying green.
 *
 * BOTH directions corrupt, so the assertion is an EQUALITY, not a one-sided check.
 */
describe('assertRenderStoreAgree — the render/store tripwire', () => {
  it('throws on inline render + FULL-SCREEN store (the double-print direction)', () => {
    expect(() => assertRenderStoreAgree(false, FULLSCREEN_TRANSCRIPT_BOUND)).toThrow(/diverged/);
  });

  it('throws on FULL-SCREEN render + inline store (the F1 direction — a silently dropped carry)', () => {
    expect(() => assertRenderStoreAgree(true, INLINE_TRANSCRIPT_BOUND)).toThrow(/diverged/);
  });

  it('is silent on both matched pairings', () => {
    expect(() => assertRenderStoreAgree(true, FULLSCREEN_TRANSCRIPT_BOUND)).not.toThrow();
    expect(() => assertRenderStoreAgree(false, INLINE_TRANSCRIPT_BOUND)).not.toThrow();
  });

  it('names WHICH side is wrong, so the failure is actionable', () => {
    expect(() => assertRenderStoreAgree(true, INLINE_TRANSCRIPT_BOUND)).toThrow(
      /renderer is FULL-SCREEN but the store is bound INLINE/,
    );
  });
});

/**
 * `/clear` FRESHNESS (2.6.C guard). `/clear`'s whole contract is a clean slate, so it must never carry the outgoing
 * conversation the way a `/models` reseat does. Its protection is structural — `buildFreshChatWiring` passes an
 * `undefined` seed — but "structural" is exactly the kind of protection a future refactor deletes while generalizing
 * the carry. Pin the store-level guarantee: no seed ⇒ no transcript, on EITHER renderer.
 */
describe('/clear stays fresh — an absent seed carries nothing, on either renderer', () => {
  it('FULL-SCREEN: no seed ⇒ empty transcript (a reseat carries; /clear must not)', () => {
    expect(initialSessionViewState(undefined, FULLSCREEN_TRANSCRIPT_BOUND).transcript).toEqual([]);
  });

  it('INLINE: no seed ⇒ empty transcript', () => {
    expect(initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND).transcript).toEqual([]);
  });
});

describe('TranscriptBound is genuinely CLOSED', () => {
  it('FULLSCREEN_TRANSCRIPT_BOUND is exactly Number.MAX_SAFE_INTEGER (the literal must not drift)', () => {
    // It is spelled as a literal so the union stays closed: `Number.MAX_SAFE_INTEGER` is typed `number` in lib.d.ts,
    // so using it would widen `TranscriptBound` back to `number` — silently restoring the hole this type closes.
    expect(FULLSCREEN_TRANSCRIPT_BOUND).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('the two bounds are distinct, so carriesSeedTranscript can discriminate', () => {
    expect(FULLSCREEN_TRANSCRIPT_BOUND).not.toBe(INLINE_TRANSCRIPT_BOUND);
  });
});
