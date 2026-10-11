import {
  SessionContextSchema,
  type CostUsageDispositionEvent,
  type CostUsagePendingEvent,
} from '@relavium/shared';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { RunLoopInvariantError } from './invariant-error.js';
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

describe('SessionHandle — typed usage delivery (ADR-0104)', () => {
  it('includes active usage variants while retaining the run-only coverage and settlement boundary', () => {
    expectTypeOf<
      Extract<SessionStreamHandleEvent, { type: 'cost:usage_pending' }>
    >().toEqualTypeOf<CostUsagePendingEvent>();
    expectTypeOf<
      Extract<SessionStreamHandleEvent, { type: 'cost:usage_disposition' }>
    >().toEqualTypeOf<CostUsageDispositionEvent>();
    expectTypeOf<
      Extract<SessionStreamHandleEvent, { type: 'cost:coverage_started' | 'cost:attempt_settled' }>
    >().toBeNever();
  });

  it.each(['iterated', 'subscribe-only'] as const)(
    'delivers pending and disposition through the exported %s handle contract',
    async (mode) => {
      const b = bus();
      const handle = createSessionHandle(b, 'sess-1', () => undefined, 4, mode);
      const emit = createSessionEventSink(b, 'sess-1');
      const invocation = {
        producerId: 'producer',
        ordinal: 1,
        dispatchId: 'dispatch',
        round: 0,
        chainAttempt: 1,
      };
      // Narrow the actual public handle type, without widening to the bus union.
      const summarize = (event: SessionStreamHandleEvent): string | undefined => {
        switch (event.type) {
          case 'cost:usage_pending':
            return `${event.invocation.ordinal}:pending`;
          case 'cost:usage_disposition':
            return `${event.invocation.ordinal}:${event.disposition.kind}`;
          default:
            return undefined;
        }
      };
      const observed: string[] = [];
      const off = handle.subscribe((event) => {
        const summary = summarize(event);
        if (summary !== undefined) observed.push(summary);
      });
      try {
        emit({ type: 'cost:usage_pending', nodeId: 'chatter', model: 'model', invocation });
        emit({
          type: 'cost:usage_disposition',
          nodeId: 'chatter',
          model: 'model',
          invocation,
          disposition: {
            kind: 'incomplete',
            evidence: { kind: 'missing', reason: 'not_reported' },
          },
        });
        createSessionEventSink(
          b,
          'sess-2',
        )({
          type: 'cost:usage_pending',
          nodeId: 'chatter',
          model: 'model',
          invocation,
        });
        b.emit({ type: 'cost:coverage_started', runId: 'run-1', basis: 'complete' });
        b.emit(cancelled());
        expect(observed).toEqual(['1:pending', '1:incomplete']);
        if (mode === 'iterated') {
          const events = await drain(handle.events);
          expect(events.map((event) => summarize(event))).toEqual([
            '1:pending',
            '1:incomplete',
            undefined,
          ]);
          expect(events.map((event) => event.sequenceNumber)).toEqual([0, 1, 2]);
        } else {
          expect(handle.bufferedCount).toBe(0);
        }
      } finally {
        off();
      }
    },
  );
});

describe('SessionHandle — the producer-await bound (CR-30, ADR-0036)', () => {
  it('subscribe-only does not park a producer and holds no primary buffer', async () => {
    const b = bus();
    const handle = createSessionHandle(b, 'sess-1', () => undefined, 4, 'subscribe-only');
    const seen: SessionStreamHandleEvent[] = [];
    const off = handle.subscribe((event) => seen.push(event));
    for (let i = 0; i < 200; i += 1) {
      await handle.whenConsumersReady();
      b.emit(turnStarted());
    }
    b.emit(cancelled());
    expect(seen).toHaveLength(201);
    expect(seen.map((event) => event.sequenceNumber)).toEqual(
      Array.from({ length: 201 }, (_, i) => i),
    );
    expect(handle.bufferedCount).toBe(0);
    expect(handle.unpulledOverflow).toBe(0);
    off();
  });

  it('iterated mode applies readiness before the first pull and retains its later terminal', async () => {
    const b = bus();
    const handle = createSessionHandle(b, 'sess-1', () => undefined, 1);
    b.emit(started());
    let ready = false;
    const waiting = handle.whenConsumersReady().then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    const iterator = handle.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'session:started' });
    await waiting;
    expect(ready).toBe(true);
    b.emit(turnStarted());
    b.emit(cancelled());
    expect((await iterator.next()).value).toMatchObject({ type: 'session:turn_started' });
    expect((await iterator.next()).value).toMatchObject({ type: 'session:cancelled' });
    expect((await iterator.next()).done).toBe(true);
    expect(handle.unpulledOverflow).toBe(0);
  });

  it('a fast producer that awaits never exceeds the ceiling, and skips no sequence number', async () => {
    // **The session path had NO backpressure, not advisory backpressure.** `createSessionHandle` has always
    // wired `whenConsumersReady: () => primary.whenDrained()` and nothing ever awaited it, so a long
    // streamed reply grew the buffer for as long as the model talked. The workflow path at least throttled
    // once per node. `AgentSession` is a co-equal first-class entry point (ADR-0024), so it gets the same
    // assertion the run path gets — not a weaker one.
    const CEILING = 4;
    const TOTAL = 200;
    const b = bus();
    const handle = createSessionHandle(b, 'sess-1', () => undefined, CEILING);

    const seen: SessionStreamHandleEvent[] = [];
    let peakBuffered = 0;
    const consumer = (async (): Promise<void> => {
      for await (const event of handle.events) {
        seen.push(event);
        await Promise.resolve(); // a SLOW consumer
      }
    })();
    await Promise.resolve();

    for (let i = 0; i < TOTAL; i += 1) {
      await handle.whenConsumersReady();
      b.emit(turnStarted());
      peakBuffered = Math.max(peakBuffered, handle.bufferedCount);
    }
    await handle.whenConsumersReady();
    b.emit(cancelled()); // a session terminal, so the stream closes and the consumer finishes
    await consumer;

    expect(peakBuffered).toBeLessThanOrEqual(CEILING);
    // No-drop: `session:started` is not among these, so the count is exactly what was pushed.
    expect(seen).toHaveLength(TOTAL + 1);
    expect(seen.map((e) => e.sequenceNumber)).toEqual(
      Array.from({ length: TOTAL + 1 }, (_, i) => i),
    );
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
    sink({ type: 'agent:reasoning', nodeId: 'n', text: 'think', model: 'claude-opus-4-8' }); // dual in-turn event (EA6) — carried, not dropped
    sink({ type: 'agent:token', nodeId: 'n', token: 'hi', model: 'claude-opus-4-8' }); // dual in-turn event
    sink({ type: 'session:cancelled' });
    const events = await drain(handle.events);
    expect(events.map((e) => e.type)).toEqual([
      'session:started',
      'session:turn_started',
      'agent:reasoning',
      'agent:token',
      'session:cancelled',
    ]);
    expect(events.every((e) => e.sessionId === 'sess-1')).toBe(true);
    expect(events.map((e) => e.sequenceNumber)).toEqual([0, 1, 2, 3, 4]);
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

describe('SessionHandle — subscribe-only lifecycle (ADR-0087 §1)', () => {
  it('filters live subscribers, has no replay, and rejects iteration before and after cancellation', async () => {
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
    const cancel = vi.fn();
    const handle = createSessionHandle(b, 'sess-1', cancel, 1, 'subscribe-only');
    expect(() => handle.events[Symbol.asyncIterator]()).toThrow(RunLoopInvariantError);
    await expect(drain(handle.events)).rejects.toMatchObject({ code: 'invalid_consumer_mode' });
    const seen: SessionStreamHandleEvent[] = [];
    const off = handle.subscribe((event) => seen.push(event)); // attach before production
    b.emit(started());
    b.emit(started('sess-2'));
    b.emit(runNodeStarted('run-9'));
    b.emit(turnCompleted());
    b.emit(turnStarted()); // per-turn completion does not close the handle
    b.emit(cancelled());
    expect(detached).toHaveBeenCalledTimes(1);
    expect(seen.map((event) => event.type)).toEqual([
      'session:started',
      'session:turn_completed',
      'session:turn_started',
      'session:cancelled',
    ]);
    expect(handle.bufferedCount).toBe(0);
    expect(handle.unpulledOverflow).toBe(0);
    await handle.whenConsumersReady();
    await expect(drain(handle.events)).rejects.toMatchObject({ code: 'invalid_consumer_mode' });
    const late: SessionStreamHandleEvent[] = [];
    const lateOff = handle.subscribe((event) => late.push(event));
    expect(late).toEqual([]); // subscribe-only session delivery is live-only, no durable event replay
    handle.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
    off();
    off();
    lateOff();
  });

  it('delivers the terminal to a late first iterated pull even above capacity', async () => {
    const b = bus();
    const handle = createSessionHandle(b, 'sess-1', () => undefined, 1);
    b.emit(started());
    b.emit(turnStarted());
    b.emit(turnCompleted());
    b.emit(cancelled());
    const events = await drain(handle.events);
    expect(events.map((event) => event.type)).toEqual([
      'session:started',
      'session:turn_started',
      'session:turn_completed',
      'session:cancelled',
    ]);
    expect(events.map((event) => event.sequenceNumber)).toEqual([0, 1, 2, 3]);
    expect(handle.unpulledOverflow).toBe(0);
  });
});
