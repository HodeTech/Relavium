import { describe, expect, it, vi } from 'vitest';

import type { RunDurability, RunEvent } from '@relavium/shared';

import { RunEventBus, type RunEventDraft } from './event-bus.js';
import type { EventStreamDeliveryState } from './event-stream.js';
import { RunLoopInvariantError } from './invariant-error.js';
import { createClosedRunHandle, createRunHandle } from './run-handle.js';

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

  it('a fast producer that awaits never exceeds the ceiling, and skips no sequence number (CR-30)', async () => {
    // **ADR-0036's acceptance, and the test it replaces asserted the opposite.** The previous version built
    // a capacity-2 stream, pushed FOUR events (its own comment read `buffer = 4 > capacity 2`), then
    // asserted only that `whenDrained()` resolved after two pulls — it demonstrated the ceiling being
    // exceeded and named that "producer-await backpressure", so a green suite read as though CR-30 were
    // already closed. The two properties the item actually requires are asserted directly here.
    //
    // Break-verified twice, and the numbers are the point: reverting `whenDrained`'s predicate to `<=`
    // gives `expected 5 to be less than or equal to 4` (the off-by-one), and removing the producer's await
    // gives `expected 199 to be less than or equal to 4` — the unbounded growth the item describes.
    const CEILING = 4;
    const TOTAL = 200;
    const b = bus();
    const handle = createRunHandle(b, 'run-1', () => undefined, CEILING);

    const seen: RunEvent[] = [];
    let peakBuffered = 0;
    // A SLOW consumer: it yields to the microtask queue between pulls, so a producer that did not await
    // would run far ahead of it. Started first so the stream has a live iteration throughout.
    const consumer = (async (): Promise<void> => {
      for await (const event of handle.events) {
        seen.push(event);
        await Promise.resolve();
      }
    })();
    await Promise.resolve();

    // The FAST producer, honouring the contract: await the drain before every emit, exactly as the agent
    // turn's chunk loop now does.
    for (let i = 0; i < TOTAL; i += 1) {
      await handle.whenConsumersReady();
      b.emit(started(`n${i}`));
      peakBuffered = Math.max(peakBuffered, handle.bufferedCount);
    }
    await handle.whenConsumersReady();
    b.emit(completed());
    await consumer;

    // Property 1 — the ceiling is a bound, not a hint.
    expect(peakBuffered).toBeLessThanOrEqual(CEILING);
    // Property 2 — no-drop: every event arrived, and the sequence is gap-free and monotonic. A drop policy
    // would satisfy property 1 trivially, which is why ADR-0036 refuses one and why this half is asserted.
    expect(seen).toHaveLength(TOTAL + 1);
    expect(seen.map((e) => e.sequenceNumber)).toEqual(
      Array.from({ length: TOTAL + 1 }, (_, i) => i),
    );
  });

  it('exposes the ceiling it was built with, so the bound is assertable rather than inferred', () => {
    const handle = createRunHandle(bus(), 'run-1', () => undefined, 7);
    expect(handle.highWaterMark).toBe(7);
    expect(handle.bufferedCount).toBe(0);
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

  it('scopes each handle to its own run on a shared bus (no cross-run leakage)', async () => {
    const b = bus();
    const h1 = createRunHandle(b, 'run-1', () => undefined);
    const h2 = createRunHandle(b, 'run-2', () => undefined);
    const ns = (runId: string, nodeId: string): RunEventDraft => ({
      type: 'node:started',
      runId,
      nodeId,
      nodeType: 'input',
    });
    const done = (runId: string): RunEventDraft => ({
      type: 'run:completed',
      runId,
      outputs: {},
      totalTokensUsed: { input: 0, output: 0 },
      totalCostMicrocents: 0,
      durationMs: 1,
    });

    b.emit(ns('run-1', 'a'));
    b.emit(ns('run-2', 'x'));
    b.emit(done('run-1')); // terminal for run-1 only — must not close run-2

    const e1 = await drain(h1.events);
    expect(e1.every((e) => e.runId === 'run-1')).toBe(true);
    expect(e1.map((e) => e.type)).toEqual(['node:started', 'run:completed']);

    b.emit(done('run-2')); // now close run-2
    const e2 = await drain(h2.events);
    expect(e2.every((e) => e.runId === 'run-2')).toBe(true);
    expect(e2.map((e) => e.type)).toEqual(['node:started', 'run:completed']);
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

  it('detaches the bus subscription when the consumer abandons the stream early (no leaked listener)', async () => {
    // Regression guard for the onClose wiring: a `break`/`return` before the terminal must NOT leave the
    // primary listener registered on the (potentially shared) bus.
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
    const handle = createRunHandle(b, 'run-1', () => undefined);
    const iterator = handle.events[Symbol.asyncIterator]();
    await iterator.return?.(); // early abandon → return() → close() → onClose → unsubscribe()
    expect(detached).toHaveBeenCalledTimes(1);
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

describe('RunHandle — subscribe-only consumption (ADR-0087 §1)', () => {
  it.each(['run:completed', 'run:cancelled', 'run:failed'] as const)(
    'observes %s metadata and cleans up without a primary buffer',
    async (terminalType) => {
      const b = bus();
      const detached = vi.fn();
      const subscribe = b.subscribe.bind(b);
      vi.spyOn(b, 'subscribe').mockImplementation((listener) => {
        const off = subscribe(listener);
        return () => {
          detached();
          off();
        };
      });
      let durability: RunDurability = 'pending';
      let read: (() => EventStreamDeliveryState) | undefined;
      const cancel = vi.fn();
      const handle = createRunHandle(
        b,
        'run-1',
        cancel,
        1,
        () => durability,
        undefined,
        (reader) => {
          read = reader;
        },
        undefined,
        'subscribe-only',
      );
      const seen: RunEvent[] = [];
      const off = handle.subscribe((event) => seen.push(event));
      for (let i = 0; i < 100; i += 1) {
        await handle.whenConsumersReady();
        b.emit(started(`n${i}`));
      }
      b.emit({ ...started('other'), runId: 'other-run' });
      b.emit({ type: 'session:cancelled', sessionId: 'other-session' });
      durability = 'uncertain';
      if (terminalType === 'run:failed') {
        b.emit({
          type: 'run:failed',
          runId: 'run-1',
          error: {
            code: 'effect_needs_attention',
            message: 'attention required',
            retryable: false,
          },
          partialOutputs: {},
        });
      } else if (terminalType === 'run:cancelled') {
        b.emit({ type: 'run:cancelled', runId: 'run-1' });
      } else {
        b.emit(completed());
      }
      expect(detached).toHaveBeenCalledTimes(1); // construction-time observer is terminal-driven
      expect(seen).toHaveLength(101);
      expect(seen.at(-1)?.type).toBe(terminalType);
      expect(seen.map((event) => event.sequenceNumber)).toEqual(
        Array.from({ length: 101 }, (_, i) => i),
      );
      expect(handle.bufferedCount).toBe(0);
      expect(read?.()).toEqual({
        publishedCount: 0,
        deliveredCount: 0,
        hasGap: false,
        abandoned: false,
      });
      expect(handle.durability()).toBe('uncertain');
      expect(handle.terminalError()).toBe(
        terminalType === 'run:failed' ? 'effect_needs_attention' : undefined,
      );
      let lateSaw = false;
      const lateOff = handle.subscribe(() => {
        lateSaw = true;
      });
      expect(lateSaw).toBe(false);
      expect(() => handle.events[Symbol.asyncIterator]()).toThrow(RunLoopInvariantError);
      await expect(drain(handle.events)).rejects.toMatchObject({ code: 'invalid_consumer_mode' });
      handle.cancel();
      expect(cancel).toHaveBeenCalledTimes(1);
      off();
      off();
      lateOff(); // passive subscriptions keep their own idempotent cleanup
    },
  );

  it('keeps explicit fenced closure available without granting primary delivery authority', async () => {
    const b = bus();
    let close: (() => void) | undefined;
    const handle = createRunHandle(
      b,
      'run-1',
      () => undefined,
      1,
      undefined,
      (closer) => {
        close = closer;
      },
      undefined,
      () =>
        Promise.resolve({
          kind: 'closed',
          moneyDurability: 'durable',
          effectNeedsAttention: false,
        }),
      'subscribe-only',
    );
    close?.();
    expect(await handle.depart()).toEqual({
      kind: 'closed',
      moneyDurability: 'durable',
      effectNeedsAttention: false,
    });
    expect(handle.bufferedCount).toBe(0);
    await expect(drain(handle.events)).rejects.toMatchObject({ code: 'invalid_consumer_mode' });
  });

  it('closed handles preserve the chosen mode instead of disguising misuse as EOF', async () => {
    const iterated = createClosedRunHandle('prior-run');
    expect(await drain(iterated.events)).toEqual([]);
    const passive = createClosedRunHandle('prior-run', 'subscribe-only');
    await expect(drain(passive.events)).rejects.toMatchObject({ code: 'invalid_consumer_mode' });
    expect(passive.bufferedCount).toBe(0);
    await passive.whenConsumersReady();
    expect(passive.durability()).toBe('durable');
    expect(await passive.depart()).toMatchObject({ kind: 'closed' });
  });
});
