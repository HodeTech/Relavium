import { SessionContextSchema } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { RunEventBus, type RunEventDraft, type SessionEventDraft } from './event-bus.js';
import {
  createSessionEventSink,
  createSessionHandle,
  type SessionStreamHandleEvent,
} from './session-handle.js';

function bus(): RunEventBus {
  let tick = Date.parse('2026-06-13T00:00:00.000Z');
  return new RunEventBus({ now: () => new Date(tick++).toISOString() });
}

const CTX = SessionContextSchema.parse({ workingDir: '/workspace/s', fsScopeTier: 'sandboxed' });

// --- Fully-correlated drafts (a sessionId is already attached), for the SessionHandle filtering tests ----
const started = (sessionId = 'sess-1'): SessionEventDraft => ({
  type: 'session:started',
  sessionId,
  agentRef: 'chatter',
  model: 'claude-opus-4-8',
  context: CTX,
});
const turnStarted = (sessionId = 'sess-1'): SessionEventDraft => ({
  type: 'session:turn_started',
  sessionId,
});
const turnCompleted = (sessionId = 'sess-1'): SessionEventDraft => ({
  type: 'session:turn_completed',
  sessionId,
  stopReason: 'stop',
  tokensUsed: { input: 1, output: 2 },
});
const cancelled = (sessionId = 'sess-1'): SessionEventDraft => ({
  type: 'session:cancelled',
  sessionId,
});
const runNodeStarted = (runId: string): RunEventDraft => ({
  type: 'node:started',
  runId,
  nodeId: 'a',
  nodeType: 'input',
});

async function drain(
  events: AsyncIterable<SessionStreamHandleEvent>,
): Promise<SessionStreamHandleEvent[]> {
  const collected: SessionStreamHandleEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe('SessionHandle (1.W) — the long-lived session event stream', () => {
  it('yields session events in order, stays open across turns, and closes only on session:cancelled', async () => {
    const b = bus();
    const handle = createSessionHandle(b, 'sess-1', () => undefined);
    b.emit(started());
    b.emit(turnStarted());
    b.emit(turnCompleted()); // a per-turn boundary — NOT a terminal
    b.emit(turnStarted()); // a second turn on the same session
    b.emit(turnCompleted());
    b.emit(cancelled()); // the session's sole terminal
    const events = await drain(handle.events);
    expect(events.map((e) => e.type)).toEqual([
      'session:started',
      'session:turn_started',
      'session:turn_completed',
      'session:turn_started',
      'session:turn_completed',
      'session:cancelled',
    ]);
    expect(events.map((e) => e.sequenceNumber)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('treats session:turn_completed as a per-turn boundary, not a terminal (stays open after it)', async () => {
    const b = bus();
    const handle = createSessionHandle(b, 'sess-1', () => undefined);
    const iterator = handle.events[Symbol.asyncIterator]();
    b.emit(started());
    b.emit(turnCompleted());
    await iterator.next(); // session:started
    await iterator.next(); // session:turn_completed
    const pending = iterator.next(); // the stream must still be open, awaiting the next turn
    b.emit(turnStarted());
    const result = await pending;
    expect(result.done).toBe(false);
    if (!result.done) {
      expect(result.value.type).toBe('session:turn_started');
    }
  });

  it('scopes each handle to its own session on a shared bus (no run or cross-session leakage)', async () => {
    const b = bus();
    const h1 = createSessionHandle(b, 'sess-1', () => undefined);
    b.emit(started('sess-1'));
    b.emit(started('sess-2')); // another session on the same bus
    b.emit(runNodeStarted('run-9')); // a run on the same bus (no sessionId)
    b.emit(cancelled('sess-1')); // terminal for sess-1 only
    const e1 = await drain(h1.events);
    expect(e1.every((e) => e.sessionId === 'sess-1')).toBe(true);
    expect(e1.map((e) => e.type)).toEqual(['session:started', 'session:cancelled']);
  });

  it('subscribe attaches a passive observer scoped to the session', async () => {
    const b = bus();
    const handle = createSessionHandle(b, 'sess-1', () => undefined);
    const observed: SessionStreamHandleEvent[] = [];
    handle.subscribe((event) => observed.push(event));
    b.emit(started());
    b.emit(started('sess-2')); // another session — must not reach this observer
    b.emit(cancelled());
    await drain(handle.events);
    expect(observed.map((e) => e.type)).toEqual(['session:started', 'session:cancelled']);
  });

  it('cancel() delegates to the injected canceller (AgentSession.cancel)', () => {
    const cancel = vi.fn();
    const handle = createSessionHandle(bus(), 'sess-1', cancel);
    handle.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('ignores events emitted after session:cancelled closed the stream (no late delivery)', async () => {
    const b = bus();
    const handle = createSessionHandle(b, 'sess-1', () => undefined);
    b.emit(started());
    b.emit(cancelled()); // terminal — closes the stream and unsubscribes
    const events = await drain(handle.events);
    b.emit(turnStarted()); // a stray post-terminal emit — not delivered to the closed stream
    expect(events.map((e) => e.type)).toEqual(['session:started', 'session:cancelled']);
  });

  it('detaches the bus subscription when the consumer abandons the stream early (no leaked listener)', async () => {
    // Regression guard for the onClose wiring: a `break`/`return` before the terminal must NOT leave the
    // primary listener registered (filtering every later delivery into a closed buffer on a long-lived bus).
    const b = bus();
    const detached = vi.fn();
    const realSubscribe = b.subscribe.bind(b);
    vi.spyOn(b, 'subscribe').mockImplementation((listener) => {
      const off = realSubscribe(listener);
      return () => {
        detached();
        off();
      };
    });
    const handle = createSessionHandle(b, 'sess-1', () => undefined);
    const iterator = handle.events[Symbol.asyncIterator]();
    await iterator.return?.(); // early abandon → return() → close() → onClose → unsubscribe()
    expect(detached).toHaveBeenCalledTimes(1);
  });
});

describe('createSessionEventSink (1.W) — AgentSession envelope-free drafts → the shared bus', () => {
  it('attaches the sessionId and lets the bus stamp the per-session sequence', async () => {
    const b = bus();
    const handle = createSessionHandle(b, 'sess-1', () => undefined);
    const sink = createSessionEventSink(b, 'sess-1');
    // AgentSession emits envelope-LESS, sessionId-LESS bodies (SessionStreamEvent); the sink injects the key.
    sink({ type: 'session:started', agentRef: 'chatter', model: 'claude-opus-4-8', context: CTX });
    sink({ type: 'session:turn_started' });
    sink({ type: 'agent:token', nodeId: 'n', token: 'hi', model: 'claude-opus-4-8' }); // dual in-turn event
    sink({ type: 'session:cancelled' });
    const events = await drain(handle.events);
    expect(events.map((e) => e.type)).toEqual([
      'session:started',
      'session:turn_started',
      'agent:token',
      'session:cancelled',
    ]);
    expect(events.every((e) => e.sessionId === 'sess-1')).toBe(true);
    expect(events.map((e) => e.sequenceNumber)).toEqual([0, 1, 2, 3]);
  });

  it('drops the run-only agent:file_patch_proposed (never part of a session stream) without consuming a sequence', async () => {
    const b = bus();
    const handle = createSessionHandle(b, 'sess-1', () => undefined);
    const sink = createSessionEventSink(b, 'sess-1');
    sink({ type: 'session:started', agentRef: 'chatter', model: 'claude-opus-4-8', context: CTX });
    // A run-correlated event (the turn core never emits it in a session; defensive drop at the seam).
    sink({
      type: 'agent:file_patch_proposed',
      nodeId: 'n',
      patches: [{ uri: 'file:///x.ts', unifiedDiff: '--- a\n+++ b\n' }],
    });
    sink({ type: 'session:cancelled' });
    const events = await drain(handle.events);
    expect(events.map((e) => e.type)).toEqual(['session:started', 'session:cancelled']);
    // The dropped event consumed no sequence number — cancelled is seq 1, not 2.
    expect(events.map((e) => e.sequenceNumber)).toEqual([0, 1]);
  });

  it('CARRIES the host-emitted agent:approval_requested onto the session stream (ADR-0057, not dropped)', async () => {
    // The inverse of the file_patch_proposed drop: approval_requested IS a session-carried event, so the
    // sink attaches the sessionId, the bus stamps a sequence, and a consumer sees it. A future refactor that
    // accidentally added it to the drop guard would fail here.
    const b = bus();
    const handle = createSessionHandle(b, 'sess-1', () => undefined);
    const sink = createSessionEventSink(b, 'sess-1');
    sink({ type: 'session:started', agentRef: 'chatter', model: 'claude-opus-4-8', context: CTX });
    sink({
      type: 'agent:approval_requested',
      nodeId: 'n',
      toolId: 'write_file',
      action: 'fs_write',
      preview: { path: './out.txt' },
    });
    sink({ type: 'session:cancelled' });
    const events = await drain(handle.events);
    expect(events.map((e) => e.type)).toEqual([
      'session:started',
      'agent:approval_requested',
      'session:cancelled',
    ]);
    expect(events.every((e) => e.sessionId === 'sess-1')).toBe(true);
    expect(events.map((e) => e.sequenceNumber)).toEqual([0, 1, 2]); // it consumed a sequence (was carried)
  });
});
