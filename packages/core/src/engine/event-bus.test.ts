import { describe, expect, it, vi } from 'vitest';

import type { RunEvent } from '@relavium/shared';

import { RunEventBus, type RunEventDraft } from './event-bus.js';

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
    const tok: RunEventDraft = { type: 'agent:token', sessionId: 's1', nodeId: 'n', token: 'x', model: 'm' };
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
    const orphan = { type: 'node:started', nodeId: 'a', nodeType: 'input' } as unknown as RunEventDraft;
    expect(() => bus.next(orphan)).toThrow(/neither runId nor sessionId/);
  });

  it('does not advance the counter when validation rejects the event', () => {
    const bus = new RunEventBus({ now: fakeNow() });
    const bad = {
      type: 'cost:updated',
      runId: 'run-1',
      nodeId: 'n',
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
      costMicrocents: -1, // nonNegativeInt — rejected
      cumulativeCostMicrocents: 0,
    } as unknown as RunEventDraft;
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
    const seen: RunEvent[] = [];
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
    const sibling: RunEvent[] = [];
    bus.subscribe(() => {
      throw new Error('subscriber boom');
    });
    bus.subscribe((event) => sibling.push(event));
    const event = bus.emit(nodeStarted('run-1', 'a'));
    expect(sibling).toHaveLength(1);
    expect(onListenerError).toHaveBeenCalledTimes(1);
    expect(onListenerError).toHaveBeenCalledWith(expect.any(Error), event);
  });
});
