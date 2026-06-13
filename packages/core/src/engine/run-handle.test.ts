import { describe, expect, it, vi } from 'vitest';

import type { RunEvent } from '@relavium/shared';

import { RunEventBus, type RunEventDraft } from './event-bus.js';
import { createRunHandle } from './run-handle.js';

function bus(): RunEventBus {
  let tick = Date.parse('2026-06-13T00:00:00.000Z');
  return new RunEventBus({ now: () => new Date(tick++).toISOString() });
}

const started = (nodeId: string): RunEventDraft => ({
  type: 'node:started',
  runId: 'run-1',
  nodeId,
  nodeType: 'input',
});
const completed = (): RunEventDraft => ({
  type: 'run:completed',
  runId: 'run-1',
  outputs: {},
  totalTokensUsed: { input: 0, output: 0 },
  totalCostMicrocents: 0,
  durationMs: 1,
});

async function drain(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const collected: RunEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe('RunHandle — the async-iterable event stream', () => {
  it('yields events in order and completes on a terminal event', async () => {
    const b = bus();
    const handle = createRunHandle(b, 'run-1', () => undefined);
    b.emit(started('a'));
    b.emit(started('b'));
    b.emit(completed());
    const events = await drain(handle.events);
    expect(events.map((e) => e.type)).toEqual(['node:started', 'node:started', 'run:completed']);
    expect(events.map((e) => e.sequenceNumber)).toEqual([0, 1, 2]);
  });

  it('never drops an event emitted before the consumer starts iterating (buffered from construction)', async () => {
    const b = bus();
    const handle = createRunHandle(b, 'run-1', () => undefined);
    // All three are emitted before anyone awaits the iterable.
    b.emit(started('a'));
    b.emit(started('b'));
    b.emit(completed());
    expect((await drain(handle.events)).map((e) => e.type)).toEqual([
      'node:started',
      'node:started',
      'run:completed',
    ]);
  });

  it('delivers live events to a consumer already awaiting next()', async () => {
    const b = bus();
    const handle = createRunHandle(b, 'run-1', () => undefined);
    const iterator = handle.events[Symbol.asyncIterator]();
    const pending = iterator.next(); // awaiting before any event exists
    b.emit(started('a'));
    const result = await pending;
    expect(result.done).toBe(false);
    if (!result.done) {
      expect(result.value.type).toBe('node:started');
    }
  });

  it('applies producer-await backpressure once the buffer exceeds capacity, then drains', async () => {
    const b = bus();
    const handle = createRunHandle(b, 'run-1', () => undefined, 2); // capacity 2
    b.emit(started('a'));
    b.emit(started('b'));
    b.emit(started('c'));
    b.emit(started('d')); // buffer = 4 > capacity 2

    let drained = false;
    const ready = handle.whenConsumersReady().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false); // still over capacity

    const iterator = handle.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next(); // buffer back down to 2 (<= capacity)
    await ready;
    expect(drained).toBe(true);
  });

  it('subscribe attaches a passive observer that sees the same stamped events', async () => {
    const b = bus();
    const handle = createRunHandle(b, 'run-1', () => undefined);
    const observed: RunEvent[] = [];
    handle.subscribe((event) => observed.push(event));
    b.emit(started('a'));
    b.emit(completed());
    await drain(handle.events);
    expect(observed.map((e) => e.type)).toEqual(['node:started', 'run:completed']);
  });

  it('cancel() delegates to the injected canceller', () => {
    const cancel = vi.fn();
    const handle = createRunHandle(bus(), 'run-1', cancel);
    handle.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('stops delivering after the consumer abandons the loop (return())', async () => {
    const b = bus();
    const handle = createRunHandle(b, 'run-1', () => undefined);
    const iterator = handle.events[Symbol.asyncIterator]();
    b.emit(started('a'));
    await iterator.next();
    await iterator.return?.(); // consumer breaks out
    const after = await iterator.next();
    expect(after.done).toBe(true);
  });

  it('ignores events emitted after the terminal closed the stream (no late delivery)', async () => {
    const b = bus();
    const handle = createRunHandle(b, 'run-1', () => undefined);
    b.emit(started('a'));
    b.emit(completed()); // terminal — closes the stream and unsubscribes
    const events = await drain(handle.events);
    // A stray post-terminal emit is not delivered to the (closed) stream.
    b.emit(started('late'));
    expect(events.map((e) => e.type)).toEqual(['node:started', 'run:completed']);
  });

  it('rejects a second concurrent next() on the same stream', async () => {
    const b = bus();
    const handle = createRunHandle(b, 'run-1', () => undefined);
    const iterator = handle.events[Symbol.asyncIterator]();
    const first = iterator.next(); // parks waiting for an event
    await expect(iterator.next()).rejects.toThrow(/concurrent next/);
    b.emit(started('a'));
    await first;
  });
});
