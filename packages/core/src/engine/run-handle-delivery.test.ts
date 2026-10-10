import { describe, expect, it } from 'vitest';

import { RunEventBus, type RunEventDraft } from './event-bus.js';
import type { EventStreamDeliveryState } from './event-stream.js';
import { createRunHandle } from './run-handle.js';

const progress = (runId = 'run-1'): RunEventDraft => ({
  type: 'node:started',
  runId,
  nodeId: 'node-1',
  nodeType: 'input',
});
const pause: RunEventDraft = {
  type: 'run:paused',
  runId: 'run-1',
  pendingGateCount: 1,
  gateIds: ['gate-1'],
};
const terminal: RunEventDraft = {
  type: 'run:completed',
  runId: 'run-1',
  outputs: {},
  totalTokensUsed: { input: 0, output: 0 },
  totalCostMicrocents: 0,
  durationMs: 1,
};

function fixture(capacity = 8) {
  const bus = new RunEventBus({ now: () => '2026-10-08T00:00:00.000Z' });
  let read: (() => EventStreamDeliveryState) | undefined;
  let close: (() => void) | undefined;
  const handle = createRunHandle(
    bus,
    'run-1',
    () => undefined,
    capacity,
    () => 'pending',
    (closer) => {
      close = closer;
    },
    (reader) => {
      read = reader;
    },
  );
  if (read === undefined || close === undefined)
    throw new Error('missing internal construction wiring');
  return { bus, handle, read, close, iterator: handle.events[Symbol.asyncIterator]() };
}

describe('RunHandle — private primary-delivery observation (ADR-0103 foundation)', () => {
  it('records publication before first pull and buffered delivery synchronously before returning next()', async () => {
    const f = fixture();
    expect(f.read()).toEqual({
      publishedCount: 0,
      deliveredCount: 0,
      hasGap: false,
      abandoned: false,
    });
    f.bus.emit(progress());
    f.bus.emit(pause);
    expect(f.read()).toEqual({
      publishedCount: 2,
      deliveredCount: 0,
      hasGap: false,
      abandoned: false,
    });
    const first = f.iterator.next();
    expect(f.read().deliveredCount).toBe(1);
    expect((await first).done).toBe(false);
    const second = f.iterator.next();
    expect(f.read().deliveredCount).toBe(2);
    expect((await second).value).toMatchObject({ type: 'run:paused' });
    f.close();
  });

  it('records a waiting handoff synchronously, while an empty pending next never acknowledges anything', async () => {
    const f = fixture();
    const first = f.iterator.next();
    expect(f.read()).toEqual({
      publishedCount: 0,
      deliveredCount: 0,
      hasGap: false,
      abandoned: false,
    });
    f.bus.emit(pause);
    expect(f.read()).toEqual({
      publishedCount: 1,
      deliveredCount: 1,
      hasGap: false,
      abandoned: false,
    });
    expect((await first).value).toMatchObject({ type: 'run:paused' });
    const waitingAtPause = f.iterator.next();
    expect(f.read().deliveredCount).toBe(1);
    f.close();
    expect(await waitingAtPause).toEqual({ done: true, value: undefined });
    expect(f.read()).toEqual({
      publishedCount: 1,
      deliveredCount: 1,
      hasGap: false,
      abandoned: false,
    });
  });

  it('passive observers see publications without acknowledging them, and receive no mutable cursor', async () => {
    const f = fixture();
    const observed: EventStreamDeliveryState[] = [];
    f.handle.subscribe(() => {
      observed.push(f.read());
    });
    f.bus.emit(progress());
    f.bus.emit(pause);
    expect(observed).toEqual([
      { publishedCount: 1, deliveredCount: 0, hasGap: false, abandoned: false },
      { publishedCount: 2, deliveredCount: 0, hasGap: false, abandoned: false },
    ]);
    const snapshot = f.read();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Reflect.set(snapshot, 'deliveredCount', 2)).toBe(false);
    expect(f.read().deliveredCount).toBe(0);
    await f.iterator.next();
    expect(snapshot.deliveredCount).toBe(0);
    expect(f.read().deliveredCount).toBe(1);
    await f.iterator.return?.();
  });

  it('keeps never-pulled overflow sticky after draining and receiving a later event', async () => {
    const f = fixture(1);
    f.bus.emit(progress());
    f.bus.emit(pause); // Declined by the existing queue; it must remain observable as a gap.
    expect(f.handle.bufferedCount).toBe(1);
    expect(f.read()).toEqual({
      publishedCount: 2,
      deliveredCount: 0,
      hasGap: true,
      abandoned: false,
    });
    await f.iterator.next();
    const pending = f.iterator.next();
    f.bus.emit(progress());
    expect((await pending).value).toMatchObject({ sequenceNumber: 2 });
    expect(f.handle.bufferedCount).toBe(0);
    expect(f.read()).toEqual({
      publishedCount: 3,
      deliveredCount: 2,
      hasGap: true,
      abandoned: false,
    });
    f.close();
    await f.iterator.next();
    expect(f.read().hasGap).toBe(true);
  });

  it('records early return independently of a gap, including when the cursor had caught up', async () => {
    const f = fixture();
    f.bus.emit(pause);
    await f.iterator.next();
    const waiting = f.iterator.next();
    const returned = f.iterator.return?.();
    expect(f.read()).toEqual({
      publishedCount: 1,
      deliveredCount: 1,
      hasGap: false,
      abandoned: true,
    });
    await returned;
    expect((await waiting).done).toBe(true);
    f.bus.emit(progress()); // Unsubscribed: no new publication, but the abandonment veto remains.
    expect(f.read()).toEqual({
      publishedCount: 1,
      deliveredCount: 1,
      hasGap: false,
      abandoned: true,
    });
  });

  it('return before the first pull discards buffered progress without acknowledging it', async () => {
    const f = fixture();
    f.bus.emit(pause);
    await f.iterator.return?.();
    expect(f.handle.bufferedCount).toBe(0);
    expect(f.read()).toEqual({
      publishedCount: 1,
      deliveredCount: 0,
      hasGap: false,
      abandoned: true,
    });
  });

  it('terminal publication closes without acknowledging its buffered event; normal drain is not abandonment', async () => {
    const f = fixture();
    f.bus.emit(terminal);
    expect(f.read()).toEqual({
      publishedCount: 1,
      deliveredCount: 0,
      hasGap: false,
      abandoned: false,
    });
    await f.iterator.next();
    expect((await f.iterator.next()).done).toBe(true);
    await f.iterator.return?.();
    expect(f.read()).toEqual({
      publishedCount: 1,
      deliveredCount: 1,
      hasGap: false,
      abandoned: false,
    });
  });

  it('return after terminal publication but before its delivery is still abandonment', async () => {
    const f = fixture();
    f.bus.emit(terminal);
    await f.iterator.return?.();
    expect(f.read()).toEqual({
      publishedCount: 1,
      deliveredCount: 0,
      hasGap: false,
      abandoned: true,
    });
  });

  it('a never-pulled dropped terminal remains a gap even after the closed buffer drains', async () => {
    const f = fixture(1);
    f.bus.emit(progress());
    f.bus.emit(terminal);
    await f.iterator.next();
    expect((await f.iterator.next()).done).toBe(true);
    expect(f.read()).toEqual({
      publishedCount: 2,
      deliveredCount: 1,
      hasGap: true,
      abandoned: false,
    });
  });

  it('only this execution primary counts, including fresh construction with a nonzero durable sequence', async () => {
    const f = fixture();
    f.bus.emit(progress('other-run'));
    f.bus.emit({ type: 'session:cancelled', sessionId: 'session-1' });
    expect(f.read().publishedCount).toBe(0);
    f.bus.seedSequence('run-1', 80);
    f.bus.emit(pause);
    expect((await f.iterator.next()).value).toMatchObject({ sequenceNumber: 80 });
    const old = f.read();
    f.bus.emit(progress());
    expect(f.read()).toEqual({
      publishedCount: 2,
      deliveredCount: 1,
      hasGap: false,
      abandoned: false,
    });
    expect(old.publishedCount).toBe(1);
    await f.iterator.next();
    f.close();
  });
});
