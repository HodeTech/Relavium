import type { SessionStreamHandleEvent } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { createChatStore } from './chat-store.js';

const started: SessionStreamHandleEvent = {
  type: 'session:started',
  sessionId: 'sess-1',
  sequenceNumber: 0,
  timestamp: '2026-06-25T00:00:00.000Z',
  agentRef: 'relavium-chat',
  model: 'claude-sonnet-4-6',
  context: { workingDir: '/w', fsScopeTier: 'sandboxed' },
};
const turnStarted: SessionStreamHandleEvent = {
  type: 'session:turn_started',
  sessionId: 'sess-1',
  sequenceNumber: 1,
  timestamp: '2026-06-25T00:00:01.000Z',
};
const token = (seq: number, text: string): SessionStreamHandleEvent => ({
  type: 'agent:token',
  sessionId: 'sess-1',
  sequenceNumber: seq,
  timestamp: '2026-06-25T00:00:02.000Z',
  nodeId: 'relavium-chat',
  token: text,
  model: 'claude-sonnet-4-6',
});
const toolCall = (seq: number, toolId: string): SessionStreamHandleEvent => ({
  type: 'agent:tool_call',
  sessionId: 'sess-1',
  sequenceNumber: seq,
  timestamp: '2026-06-25T00:00:02.000Z',
  nodeId: 'relavium-chat',
  model: 'claude-sonnet-4-6',
  toolId,
  toolInput: { path: 'x' },
});
const toolResult = (seq: number, toolId: string): SessionStreamHandleEvent => ({
  type: 'agent:tool_result',
  sessionId: 'sess-1',
  sequenceNumber: seq,
  timestamp: '2026-06-25T00:00:02.500Z',
  nodeId: 'relavium-chat',
  toolId,
  success: true,
  outputSummary: 'ok',
});

describe('createChatStore', () => {
  it('flushes a lifecycle event immediately (notifies subscribers, updates the snapshot)', () => {
    const store = createChatStore(false);
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.apply(started);
    expect(notified).toBe(1);
    expect(store.getSnapshot().state.model).toBe('claude-sonnet-4-6');
  });

  it('coalesces a high-frequency token event — dirty until the next tick, then repaints', () => {
    const store = createChatStore(false);
    store.apply(started); // running flag not yet set
    store.apply(turnStarted);
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.apply(token(2, 'hi')); // high-frequency ⇒ coalesced, no immediate flush
    expect(notified).toBe(0);
    expect(store.getSnapshot().state.liveTokens).toBe(''); // snapshot not yet refreshed
    store.tick();
    expect(notified).toBe(1); // the frame flush
    expect(store.getSnapshot().state.liveTokens).toBe('hi');
  });

  it('a tick with no pending state and an idle session does not repaint', () => {
    const store = createChatStore(false);
    store.apply(started); // idle, not running
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.tick();
    expect(notified).toBe(0); // nothing dirty, not running ⇒ no wasted repaint
  });

  it('repaints on tick while a turn is in flight (the live spinner animates)', () => {
    const store = createChatStore(false);
    store.apply(started);
    store.apply(turnStarted); // status running
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.tick();
    expect(notified).toBe(1);
    expect(store.getSnapshot().tick).toBe(1);
  });

  it('appendUser adds a user transcript entry and flushes', () => {
    const store = createChatStore(false);
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.appendUser('hello');
    expect(notified).toBe(1);
    expect(store.getSnapshot().state.transcript).toEqual([{ role: 'user', text: 'hello' }]);
  });

  it('unsubscribe stops further notifications', () => {
    const store = createChatStore(false);
    let notified = 0;
    const off = store.subscribe(() => (notified += 1));
    store.apply(started);
    off();
    store.appendUser('x');
    expect(notified).toBe(1); // only the pre-unsubscribe flush
  });

  it('returns a stable snapshot reference between flushes (useSyncExternalStore contract)', () => {
    const store = createChatStore(false);
    store.apply(started);
    const snap = store.getSnapshot();
    expect(store.getSnapshot()).toBe(snap); // identical reference until the next flush
    store.appendUser('x'); // a flush
    expect(store.getSnapshot()).not.toBe(snap); // a fresh snapshot reference
  });

  it('does not repaint on tick once the session has ended', () => {
    const store = createChatStore(false);
    store.apply(started);
    store.apply({
      type: 'session:cancelled',
      sessionId: 'sess-1',
      sequenceNumber: 1,
      timestamp: '2026-06-25T00:00:03.000Z',
    });
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.tick();
    expect(notified).toBe(0); // ended ⇒ not running, nothing dirty ⇒ no wasted repaint
  });

  it('threads the color flag into the snapshot', () => {
    expect(createChatStore(false).getSnapshot().color).toBe(false);
    expect(createChatStore(true).getSnapshot().color).toBe(true);
  });

  it('flushes a session:turn_completed lifecycle event immediately', () => {
    const store = createChatStore(false);
    store.apply(started);
    store.apply(turnStarted); // running
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.apply({
      type: 'session:turn_completed',
      sessionId: 'sess-1',
      sequenceNumber: 3,
      timestamp: '2026-06-25T00:00:03.000Z',
      stopReason: 'stop',
      tokensUsed: { input: 1, output: 1 },
    });
    expect(notified).toBe(1); // a lifecycle transition repaints immediately
    expect(store.getSnapshot().state.turnCount).toBe(1);
  });

  it('coalesces a cost:updated event like a token (dirty until tick)', () => {
    const store = createChatStore(false);
    store.apply(started);
    store.apply(turnStarted);
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.apply({
      type: 'cost:updated',
      sessionId: 'sess-1',
      sequenceNumber: 3,
      timestamp: '2026-06-25T00:00:03.000Z',
      nodeId: 'relavium-chat',
      model: 'claude-sonnet-4-6',
      inputTokens: 10,
      outputTokens: 5,
      costMicrocents: 42,
      cumulativeCostMicrocents: 42,
    });
    expect(notified).toBe(0); // coalesced
    store.tick();
    expect(notified).toBe(1);
    expect(store.getSnapshot().state.cumulativeCostMicrocents).toBe(42);
  });

  it('coalesces an agent:reasoning event like a token (dirty until tick) — EA6', () => {
    // A reasoning-heavy model emits many thinking deltas; each must coalesce to the next frame, not flush a
    // repaint per delta. Pins agent:reasoning's membership in HIGH_FREQUENCY_EVENTS (a drop reintroduces the
    // per-delta thrash) — independent of whether the view yet RENDERS reasoning (Step 2).
    const store = createChatStore(false);
    store.apply(started);
    store.apply(turnStarted);
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.apply({
      type: 'agent:reasoning',
      sessionId: 'sess-1',
      sequenceNumber: 3,
      timestamp: '2026-06-25T00:00:03.000Z',
      nodeId: 'relavium-chat',
      text: 'let me think',
      model: 'claude-sonnet-4-6',
    });
    expect(notified).toBe(0); // high-frequency ⇒ coalesced, no immediate flush
    store.tick();
    expect(notified).toBe(1); // the single frame flush
  });

  it('coalesces an agent:tool_call like a token (dirty until tick), then shows the annotation', () => {
    const store = createChatStore(false);
    store.apply(started);
    store.apply(turnStarted);
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.apply(toolCall(2, 'read_file')); // high-frequency ⇒ coalesced, no immediate flush
    expect(notified).toBe(0);
    expect(store.getSnapshot().state.liveToolCalls).toHaveLength(0); // snapshot not yet refreshed
    store.tick();
    expect(notified).toBe(1); // the frame flush
    expect(store.getSnapshot().state.liveToolCalls[0]?.toolId).toBe('read_file');
  });

  it('coalesces an agent:tool_result like a token (dirty until tick), then marks the call resolved', () => {
    const store = createChatStore(false);
    store.apply(started);
    store.apply(turnStarted);
    store.apply(toolCall(2, 'read_file'));
    store.tick(); // flush the unresolved call into the snapshot
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.apply(toolResult(3, 'read_file')); // coalesced
    expect(notified).toBe(0);
    expect(store.getSnapshot().state.liveToolCalls[0]?.resolved).toBe(false); // snapshot not yet refreshed
    store.tick();
    expect(notified).toBe(1);
    expect(store.getSnapshot().state.liveToolCalls[0]?.resolved).toBe(true);
  });

  it('clears the dirty flag when a lifecycle event flushes mid-stream, so a later tick does not repaint', () => {
    const store = createChatStore(false);
    store.apply(started);
    store.apply(turnStarted);
    store.apply(token(2, 'hi')); // dirty = true
    store.apply({
      type: 'session:cancelled',
      sessionId: 'sess-1',
      sequenceNumber: 3,
      timestamp: '2026-06-25T00:00:03.000Z',
    }); // lifecycle flush clears dirty + ends the session
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.tick();
    expect(notified).toBe(0); // not dirty + ended ⇒ no wasted repaint
  });

  it('summaryText renders the session footer (model · cost · turns)', () => {
    const store = createChatStore(false);
    store.apply(started);
    expect(store.summaryText()).toContain('claude-sonnet-4-6');
    expect(store.summaryText()).toContain('0 turns');
  });

  it('note() surfaces a SANITIZED one-line warning (the MCP-skipped channel) and flushes immediately', () => {
    const store = createChatStore(false);
    let repaints = 0;
    store.subscribe(() => (repaints += 1));
    store.note("MCP tool 'x' skipped\nFAKE" + String.fromCharCode(27) + '[31m'); // a newline + a control seq must not forge a row / inject ANSI
    expect(repaints).toBe(1); // a note repaints immediately
    expect(store.getSnapshot().state.warnings).toEqual(["MCP tool 'x' skipped FAKE"]); // newline collapsed, ESC stripped
  });

  it('notice() appends a command-output transcript entry (control seqs stripped, newlines KEPT for multi-line)', () => {
    const store = createChatStore(false);
    let repaints = 0;
    store.subscribe(() => (repaints += 1));
    store.notice('Workflows (1):\n  deploy' + String.fromCharCode(27) + '[31m'); // the ESC[31m must be stripped, the \n kept
    expect(repaints).toBe(1); // a notice repaints immediately
    expect(store.getSnapshot().state.transcript).toEqual([
      { role: 'notice', text: 'Workflows (1):\n  deploy' }, // multi-line preserved, ANSI stripped
    ]);
  });
});

describe('createChatStore — chat mode + per-tool approval coordination (ADR-0057)', () => {
  const approvalRequest = {
    toolId: 'write_file',
    action: 'fs_write',
    preview: { path: 'notes.md' },
  } as const;

  it('defaults to ask mode; setMode updates the snapshot mode and flushes immediately', () => {
    const store = createChatStore(false);
    expect(store.getSnapshot().mode).toBe('ask');
    let repaints = 0;
    store.subscribe(() => (repaints += 1));
    store.setMode('accept-edits');
    expect(repaints).toBe(1);
    expect(store.getSnapshot().mode).toBe('accept-edits');
  });

  it('the reasoning panel defaults to collapsed; toggleReasoning flips it and flushes (2.5.H)', () => {
    const store = createChatStore(false);
    expect(store.getSnapshot().reasoningVisible).toBe(false); // collapsed by default
    let repaints = 0;
    store.subscribe(() => (repaints += 1));
    store.toggleReasoning();
    expect(repaints).toBe(1); // flushes immediately (a toggle feels instant)
    expect(store.getSnapshot().reasoningVisible).toBe(true);
    store.toggleReasoning();
    expect(store.getSnapshot().reasoningVisible).toBe(false); // flips back
  });

  it('requestApproval publishes a pending approval, then resolves when answerApproval is called', async () => {
    const store = createChatStore(false);
    expect(store.getSnapshot().approval).toBeUndefined();
    const pending = store.requestApproval(approvalRequest, true);
    // The prompt is now published for the REPL to render (with its cacheable hint).
    expect(store.getSnapshot().approval).toEqual({ request: approvalRequest, cacheable: true });
    store.answerApproval({ outcome: 'approve', scope: 'always' });
    expect(await pending).toEqual({ outcome: 'approve', scope: 'always' });
    expect(store.getSnapshot().approval).toBeUndefined(); // cleared on settle
  });

  it('answerApproval with nothing pending is a no-op (a stray keypress)', () => {
    const store = createChatStore(false);
    expect(() => store.answerApproval({ outcome: 'approve', scope: 'once' })).not.toThrow();
    expect(store.getSnapshot().approval).toBeUndefined();
  });

  it('an abort while an approval is pending REJECTS with an AbortError and clears the prompt (cancel, not deny)', async () => {
    const store = createChatStore(false);
    const ac = new AbortController();
    const pending = store.requestApproval(approvalRequest, false, ac.signal);
    expect(store.getSnapshot().approval).toEqual({ request: approvalRequest, cacheable: false });
    ac.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // Narrow via instanceof (no `as Error`) before reading `.name` — classified as a CANCEL by isAbort.
    if (err instanceof Error) expect(err.name).toBe('AbortError');
    expect(store.getSnapshot().approval).toBeUndefined();
  });

  it('an ALREADY-aborted signal rejects immediately and never publishes a prompt', async () => {
    const store = createChatStore(false);
    const ac = new AbortController();
    ac.abort();
    const err = await store
      .requestApproval(approvalRequest, true, ac.signal)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    if (err instanceof Error) expect(err.name).toBe('AbortError');
    expect(store.getSnapshot().approval).toBeUndefined(); // no prompt was ever shown
  });
});
