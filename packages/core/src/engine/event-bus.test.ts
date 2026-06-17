import { describe, expect, it, vi } from 'vitest';

import { SessionContextSchema, type RunOrSessionEvent } from '@relavium/shared';

import { RunEventBus, type RunEventDraft, type SessionEventDraft } from './event-bus.js';

/** A deterministic ISO clock — 1ms per read from a fixed base, so timestamps are reproducible. */
function fakeNow(): () => string {
  let tick = Date.parse('2026-06-13T00:00:00.000Z');
  return () => new Date(tick++).toISOString();
}

const nodeStarted = (runId: string, nodeId: string): RunEventDraft => ({
  type: 'node:started',
  runId,
  nodeId,
  nodeType: 'input',
});

describe('RunEventBus — sequence stamping (the single producer-side translation point)', () => {
  it('assigns a monotonic, gap-free sequenceNumber per correlation key starting at 0', () => {
    const bus = new RunEventBus({ now: fakeNow() });
    const a = bus.next(nodeStarted('run-1', 'a'));
    const b = bus.next(nodeStarted('run-1', 'b'));
    const c = bus.next(nodeStarted('run-1', 'c'));
    expect([a.sequenceNumber, b.sequenceNumber, c.sequenceNumber]).toEqual([0, 1, 2]);
  });

  it('keeps an independent counter per correlation key (two runs do not share a sequence)', () => {
    const bus = new RunEventBus({ now: fakeNow() });
    expect(bus.next(nodeStarted('run-1', 'a')).sequenceNumber).toBe(0);
    expect(bus.next(nodeStarted('run-2', 'a')).sequenceNumber).toBe(0);
    expect(bus.next(nodeStarted('run-1', 'b')).sequenceNumber).toBe(1);
    expect(bus.next(nodeStarted('run-2', 'b')).sequenceNumber).toBe(1);
  });

  it('keys the counter on sessionId for a session-correlated (dual-envelope) event', () => {
    const bus = new RunEventBus({ now: fakeNow() });
    // agent:token is a dual-envelope event — on a session it carries sessionId, not runId.
    const tok: RunEventDraft = {
      type: 'agent:token',
      sessionId: 's1',
      nodeId: 'n',
      token: 'x',
      model: 'm',
    };
    expect(bus.next(tok).sequenceNumber).toBe(0);
    expect(bus.next(tok).sequenceNumber).toBe(1);
    // A run on the same bus keeps its own sequence (disjoint correlation keys).
    expect(bus.next(nodeStarted('run-1', 'a')).sequenceNumber).toBe(0);
  });

  it('stamps an ISO-8601 timestamp from the injected clock', () => {
    const bus = new RunEventBus({ now: () => '2026-06-13T12:00:00.000Z' });
    expect(bus.next(nodeStarted('run-1', 'a')).timestamp).toBe('2026-06-13T12:00:00.000Z');
  });

  it('throws when a draft carries neither runId nor sessionId (an engine invariant breach)', () => {
    const bus = new RunEventBus({ now: fakeNow() });
    // A structurally-incomplete draft — the engine always sets exactly one key, so this is a guard.
    const orphan = {
      type: 'node:started',
      nodeId: 'a',
      nodeType: 'input',
    } as unknown as RunEventDraft;
    expect(() => bus.next(orphan)).toThrow(/neither runId nor sessionId/);
  });

  it('does not advance the counter when validation rejects the event', () => {
    const bus = new RunEventBus({ now: fakeNow() });
    // Statically valid (a number), runtime-invalid (nonNegativeInt rejects -1) — no cast needed.
    const bad: RunEventDraft = {
      type: 'cost:updated',
      runId: 'run-1',
      nodeId: 'n',
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
      costMicrocents: -1,
      cumulativeCostMicrocents: 0,
    };
    expect(() => bus.next(bad)).toThrow();
    // The next valid event still gets sequence 0 — the failed stamp did not consume a number.
    expect(bus.next(nodeStarted('run-1', 'a')).sequenceNumber).toBe(0);
  });

  it('skips Zod validation when validate:false but still stamps the envelope', () => {
    const bus = new RunEventBus({ now: () => '2026-06-13T12:00:00.000Z', validate: false });
    const event = bus.next(nodeStarted('run-1', 'a'));
    expect(event.sequenceNumber).toBe(0);
    expect(event.timestamp).toBe('2026-06-13T12:00:00.000Z');
  });
});

describe('RunEventBus — delivery and subscription', () => {
  it('delivers stamped events to every subscriber and stops after unsubscribe', () => {
    const bus = new RunEventBus({ now: fakeNow() });
    const seen: RunOrSessionEvent[] = []; // subscribe() delivers the wide bus union (BusEventListener)
    const unsubscribe = bus.subscribe((event) => seen.push(event));
    bus.emit(nodeStarted('run-1', 'a'));
    unsubscribe();
    bus.emit(nodeStarted('run-1', 'b'));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe('node:started');
  });

  it('isolates a throwing subscriber: the sink is notified and sibling subscribers still receive it', () => {
    const onListenerError = vi.fn();
    const bus = new RunEventBus({ now: fakeNow(), onListenerError });
    const sibling: RunOrSessionEvent[] = []; // subscribe() delivers the wide bus union (BusEventListener)
    bus.subscribe(() => {
      throw new Error('subscriber boom');
    });
    bus.subscribe((event) => sibling.push(event));
    const event = bus.emit(nodeStarted('run-1', 'a'));
    expect(sibling).toHaveLength(1);
    expect(onListenerError).toHaveBeenCalledTimes(1);
    expect(onListenerError).toHaveBeenCalledWith(expect.any(Error), event);
  });

  it('with no sink: isolates a throwing subscriber and surfaces the error out-of-band, not swallowed', async () => {
    const bus = new RunEventBus({ now: fakeNow() }); // no onListenerError → the #surfaceOutOfBand path
    const sibling: RunOrSessionEvent[] = []; // subscribe() delivers the wide bus union (BusEventListener)
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    // Capture the deferred re-throw so it does not escape as a process-level unhandled rejection.
    process.on('unhandledRejection', onRejection);
    try {
      const boom = new Error('subscriber boom');
      bus.subscribe(() => {
        throw boom;
      });
      bus.subscribe((event) => sibling.push(event));
      // deliver() must NOT throw into the producer, and the sibling still receives the event.
      expect(() => bus.emit(nodeStarted('run-1', 'a'))).not.toThrow();
      expect(sibling).toHaveLength(1);
      // Flush microtasks (a macrotask tick) so the deferred re-throw becomes the rejection we captured.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections).toContain(boom); // surfaced, not silently swallowed
    } finally {
      process.removeListener('unhandledRejection', onRejection);
    }
  });
});

describe('RunEventBus — the session:* namespace on the one shared bus (1.W, ADR-0036)', () => {
  const ctx = SessionContextSchema.parse({ workingDir: '/workspace/s', fsScopeTier: 'sandboxed' });
  const sessionStarted = (sessionId: string): SessionEventDraft => ({
    type: 'session:started',
    sessionId,
    agentRef: 'chatter',
    model: 'claude-opus-4-8',
    context: ctx,
  });
  const turnStarted = (sessionId: string): SessionEventDraft => ({
    type: 'session:turn_started',
    sessionId,
  });
  const turnCompleted = (sessionId: string): SessionEventDraft => ({
    type: 'session:turn_completed',
    sessionId,
    stopReason: 'stop',
    tokensUsed: { input: 1, output: 2 },
  });
  // A dual-envelope in-turn event carrying sessionId is a RunEventDraft (its arm has an optional sessionId),
  // NOT a SessionEventDraft (SessionEvent is only the five lifecycle events) — mirrors agent-session.ts.
  const token = (sessionId: string): RunEventDraft => ({
    type: 'agent:token',
    sessionId,
    nodeId: 'n',
    token: 'x',
    model: 'm',
  });

  it('stamps + validates a session lifecycle event through the combined RunOrSessionEventSchema gate', () => {
    const bus = new RunEventBus({ now: () => '2026-06-13T12:00:00.000Z' });
    const e = bus.next(sessionStarted('s1'));
    expect(e.type).toBe('session:started');
    expect(e.sessionId).toBe('s1');
    expect(e.timestamp).toBe('2026-06-13T12:00:00.000Z');
    expect(e.sequenceNumber).toBe(0);
  });

  it('shares ONE per-session sequence across lifecycle and dual in-turn events', () => {
    const bus = new RunEventBus({ now: fakeNow() });
    expect(bus.next(sessionStarted('s1')).sequenceNumber).toBe(0);
    expect(bus.next(turnStarted('s1')).sequenceNumber).toBe(1);
    expect(bus.next(token('s1')).sequenceNumber).toBe(2); // a dual event keyed on the same sessionId
    expect(bus.next(turnCompleted('s1')).sequenceNumber).toBe(3);
  });

  it('keeps the session counter disjoint from a run on the same bus (two namespaces, one bus)', () => {
    const bus = new RunEventBus({ now: fakeNow() });
    expect(bus.next(sessionStarted('s1')).sequenceNumber).toBe(0);
    expect(bus.next(nodeStarted('run-1', 'a')).sequenceNumber).toBe(0);
    expect(bus.next(turnStarted('s1')).sequenceNumber).toBe(1);
    expect(bus.next(nodeStarted('run-1', 'b')).sequenceNumber).toBe(1);
  });

  it('does not advance the session counter when a session event fails validation', () => {
    const bus = new RunEventBus({ now: fakeNow() });
    const bad: SessionEventDraft = {
      type: 'session:turn_completed',
      sessionId: 's1',
      stopReason: 'stop',
      tokensUsed: { input: -1, output: 0 }, // nonNegativeInt rejects -1 (statically valid, runtime-invalid)
    };
    expect(() => bus.next(bad)).toThrow();
    // The next valid session event still gets sequence 0 — the failed stamp did not consume a number.
    expect(bus.next(turnStarted('s1')).sequenceNumber).toBe(0);
  });
});
