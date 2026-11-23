/**
 * The poll behind the Home's Active tab ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2), with the clock, the timer, the token, the read and the paint all injected: an unchanged token reads nothing, a late result is
 * dropped, nothing is read while a card is open on a paused row, a cancel leaves no timer, and a closed database is never read. Time moves
 * only when a test says so; the reads are promises the test settles by hand, so "late" and "in flight" are states the test makes.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  ACTIVE_MAX_AGE_MS,
  ACTIVE_POLL_MS,
  createActivePoll,
  type ActivePollDeps,
} from './active-poll.js';
import { createChangeProbe } from './change-probe.js';

/** A clock and a timer that fire only when the test advances them; `pending` is how many timers are still scheduled. */
function manualTime() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: (): number => now,
    schedule: (callback: () => void, delayMs: number): (() => void) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + delayMs, callback });
      return () => {
        timers.delete(id);
      };
    },
    pending: (): number => timers.size,
    /** Move time forward, firing every timer that falls due on the way, in order. */
    advance: (ms: number): void => {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].callback();
      }
      now = end;
    },
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
/** Let every promise callback already queued run. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

/** A poll over a probe, a scripted read and a recording paint. `reads` hands out one read at a time as the poll asks for it. */
function rig(overrides: Partial<ActivePollDeps<string>> = {}) {
  const time = manualTime();
  const probe = createChangeProbe(() => 1);
  const applied: string[] = [];
  const state = { paused: false, closed: false };
  const reads: Deferred<string>[] = [];
  const read = vi.fn((): Promise<string> => {
    const next = deferred<string>();
    reads.push(next);
    return next.promise;
  });
  const token = vi.fn(() => probe.token());
  const poll = createActivePoll<string>({
    schedule: time.schedule,
    now: time.now,
    token,
    read,
    apply: (value) => {
      applied.push(value);
    },
    paused: () => state.paused,
    isClosed: () => state.closed,
    ...overrides,
  });
  /** Answer the newest read with `value`, then let the poll's callbacks run. */
  const answer = async (value: string): Promise<void> => {
    reads.at(-1)?.resolve(value);
    await settle();
  };
  return { time, probe, applied, state, reads, read, token, poll, answer };
}

describe('an unchanged token reads nothing', () => {
  it('reads once at the start, then not at all however many ticks pass with the same token', async () => {
    const { poll, time, read, answer, applied } = rig();
    poll.start();
    expect(read).toHaveBeenCalledTimes(1);
    await answer('first');
    time.advance(ACTIVE_POLL_MS * 10);
    expect(read, 'ten ticks, nothing moved').toHaveBeenCalledTimes(1);
    expect(applied).toEqual(['first']);
  });

  it('reads again as soon as the token moves, at the next tick and not before', async () => {
    const { poll, time, read, answer, probe, applied } = rig();
    poll.start();
    await answer('first');
    probe.bump();
    expect(
      read,
      'a bump alone starts nothing: the poll looks at the next tick',
    ).toHaveBeenCalledTimes(1);
    time.advance(ACTIVE_POLL_MS);
    expect(read).toHaveBeenCalledTimes(2);
    await answer('second');
    expect(applied).toEqual(['first', 'second']);
    time.advance(ACTIVE_POLL_MS * 3);
    expect(read, 'and then nothing again').toHaveBeenCalledTimes(2);
  });

  it('reads once more when the applied read is older than a lease TTL, because the clock moves what the tab shows', async () => {
    const { poll, time, read, answer } = rig();
    poll.start();
    await answer('first');
    time.advance(ACTIVE_MAX_AGE_MS - ACTIVE_POLL_MS);
    expect(read, 'still within the age bound').toHaveBeenCalledTimes(1);
    time.advance(ACTIVE_POLL_MS * 2);
    expect(read, 'past it').toHaveBeenCalledTimes(2);
  });

  it('is coalesced: a tick that finds a read in flight starts none, and the next tick after it reads the newer token', async () => {
    const { poll, time, read, answer, probe, applied } = rig();
    poll.start();
    probe.bump();
    time.advance(ACTIVE_POLL_MS * 4);
    expect(
      read,
      'four ticks and a moved token, with the first read still in flight',
    ).toHaveBeenCalledTimes(1);
    await answer('slow');
    expect(applied).toEqual(['slow']);
    time.advance(ACTIVE_POLL_MS);
    expect(
      read,
      'the token the slow read was made under is older than now: read again',
    ).toHaveBeenCalledTimes(2);
  });
});

describe('a late result is dropped', () => {
  it('a read superseded by a refresh never replaces the newer result, even when it settles last', async () => {
    const { poll, reads, applied, read } = rig();
    poll.start();
    poll.refresh(); // the tab was entered again: a second read supersedes the first, which is still in flight
    expect(read).toHaveBeenCalledTimes(2);
    reads[1]?.resolve('newer');
    await settle();
    reads[0]?.resolve('older');
    await settle();
    expect(applied, 'the older read settled last and was dropped').toEqual(['newer']);
  });

  it('a read in flight when the poll is cancelled is never applied', async () => {
    const { poll, answer, applied } = rig();
    poll.start();
    poll.cancel();
    await answer('too late');
    expect(applied).toEqual([]);
  });

  it('a failure that arrives late is dropped too: it neither reports nor makes the next tick read again', async () => {
    const onError = vi.fn();
    const { poll, reads, time, read } = rig({ onError });
    poll.start();
    poll.refresh();
    reads[1]?.resolve('newer');
    await settle();
    reads[0]?.reject(new Error('stale'));
    await settle();
    expect(onError).not.toHaveBeenCalled();
    time.advance(ACTIVE_POLL_MS * 3);
    expect(read, 'the newer result stands, and nothing moved').toHaveBeenCalledTimes(2);
  });
});

describe('nothing is read while a card is open on a paused row', () => {
  it('neither probes nor reads while paused, and reads at the first tick after it ends', async () => {
    const { poll, time, read, token, state, answer } = rig();
    state.paused = true;
    poll.start();
    time.advance(ACTIVE_POLL_MS * 5);
    expect(read).not.toHaveBeenCalled();
    expect(token, 'a paused poll does not even look at the token').not.toHaveBeenCalled();
    state.paused = false;
    time.advance(ACTIVE_POLL_MS);
    expect(read).toHaveBeenCalledTimes(1);
    await answer('now');
  });

  it('a refresh while paused reads nothing either', () => {
    const { poll, read, state } = rig();
    poll.start();
    state.paused = true;
    poll.refresh();
    expect(read, 'only the start read').toHaveBeenCalledTimes(1);
  });
});

describe('cancelled on close and on teardown', () => {
  it('clears the pending timer, so nothing is left scheduled, and reads nothing afterwards', async () => {
    const { poll, time, read, answer } = rig();
    poll.start();
    await answer('first');
    expect(time.pending(), 'the poll keeps one timer armed while it runs').toBe(1);
    poll.cancel();
    expect(time.pending(), 'cancel clears it').toBe(0);
    time.advance(ACTIVE_MAX_AGE_MS * 3);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('is safe to cancel twice and to cancel a poll that never started', () => {
    const { poll, time } = rig();
    poll.cancel();
    poll.start();
    poll.cancel();
    poll.cancel();
    expect(time.pending()).toBe(0);
  });

  it('can be started again after a cancel, and then reads at once (the tab was entered again)', async () => {
    const { poll, read, answer, applied } = rig();
    poll.start();
    await answer('one');
    poll.cancel();
    poll.start();
    expect(read, 'a restart reads whatever the token says').toHaveBeenCalledTimes(2);
    await answer('two');
    expect(applied).toEqual(['one', 'two']);
  });

  it('start is idempotent while running: it arms one timer and reads once', () => {
    const { poll, time, read } = rig();
    poll.start();
    poll.start();
    expect(time.pending()).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('a poll started after a read the caller already holds', () => {
  it('reads nothing at the start, and at the first tick only when the token moved since the one the held read was taken under', async () => {
    const TAKEN = { dataVersion: 1, generation: 0 }; // the probe's token before anything is bumped
    const unchanged = rig({ after: TAKEN });
    unchanged.poll.start();
    expect(unchanged.read, 'start reads nothing').not.toHaveBeenCalled();
    unchanged.time.advance(ACTIVE_POLL_MS * 3);
    expect(
      unchanged.read,
      'the token the held read was made under has not moved',
    ).not.toHaveBeenCalled();

    const moved = rig({ after: TAKEN });
    moved.probe.bump(); // a commit after the held read's token was taken and before the start
    moved.poll.start();
    expect(moved.read).not.toHaveBeenCalled();
    moved.time.advance(ACTIVE_POLL_MS);
    expect(
      moved.read,
      'a commit between the held read and the start is read at the first tick',
    ).toHaveBeenCalledTimes(1);
    await moved.answer('after');
    expect(moved.applied).toEqual(['after']);
  });

  it('still arms its one timer, and reads nothing for a closed database', () => {
    const armed = rig({ after: { dataVersion: 1, generation: 0 } });
    armed.poll.start();
    expect(armed.time.pending()).toBe(1);

    const closed = rig({ after: { dataVersion: 1, generation: 0 } });
    closed.state.closed = true;
    closed.poll.start();
    expect(closed.token, 'a closed database is not even probed').not.toHaveBeenCalled();
    expect(closed.time.pending(), 'and the poll stopped for good').toBe(0);
  });
});

describe('no read after the database closes', () => {
  it('checks the closed flag before every read: a database closed between two ticks is not read, and the poll stops', async () => {
    const { poll, time, read, state, probe, answer } = rig();
    poll.start();
    await answer('first');
    probe.bump(); // there is something to read...
    state.closed = true; // ...but the database is gone
    time.advance(ACTIVE_POLL_MS);
    expect(read).toHaveBeenCalledTimes(1);
    expect(time.pending(), 'a closed database ends the poll for good').toBe(0);
    state.closed = false;
    time.advance(ACTIVE_POLL_MS * 5);
    expect(read, 'and it does not wake up again').toHaveBeenCalledTimes(1);
  });

  it('does not read at the start when the database is already closed, nor on a refresh', () => {
    const { poll, read, state, time } = rig();
    state.closed = true;
    poll.start();
    poll.refresh();
    expect(read).not.toHaveBeenCalled();
    expect(time.pending()).toBe(0);
  });

  it('a token that throws (a closed handle) is reported, never thrown out of a tick', () => {
    const onError = vi.fn();
    const { poll, time } = rig({
      onError,
      token: () => {
        throw new Error('the database connection is not open');
      },
    });
    expect(() => {
      poll.start();
      time.advance(ACTIVE_POLL_MS * 2);
    }).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });
});

describe('a failed read', () => {
  it('is reported once, applies nothing, and is tried again at the next tick although the token did not move', async () => {
    const onError = vi.fn();
    const { poll, time, read, reads, applied } = rig({ onError });
    poll.start();
    reads[0]?.reject(new Error('could not read'));
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(applied).toEqual([]);
    time.advance(ACTIVE_POLL_MS);
    expect(
      read,
      'a failure leaves nothing applied, so the same token reads again',
    ).toHaveBeenCalledTimes(2);
  });

  it('a read that throws before it returns a promise is the same failure', () => {
    const onError = vi.fn();
    const { poll } = rig({
      onError,
      read: () => {
        throw new Error('sync fault');
      },
    });
    poll.start();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('an apply that throws is reported and does not escape the promise', async () => {
    const onError = vi.fn();
    const { poll, answer } = rig({
      onError,
      apply: () => {
        throw new Error('the paint failed');
      },
    });
    poll.start();
    await answer('x');
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
