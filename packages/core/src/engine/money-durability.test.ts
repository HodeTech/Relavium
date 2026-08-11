import { describe, expect, it, vi } from 'vitest';

import {
  MoneyDurability,
  isLedgerDurabilityError,
  type SettledAttemptDraft,
} from './money-durability.js';

const draft = (nodeId = 'n1', costMicrocents = 400): SettledAttemptDraft => ({
  nodeId,
  model: 'claude-opus-4-8',
  attemptNumber: 1,
  inputTokens: 10,
  outputTokens: 5,
  costMicrocents,
  priced: true,
});

describe('MoneyDurability', () => {
  it('SERIALIZES writes chained in the same tick', async () => {
    // Chaining rather than a set is what stops two attempts settling in one tick from interleaving their
    // persists — the same reason ADR-0074 §2 chains its estimates.
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const money = new MoneyDurability({
      emit: async (d) => {
        order.push(`start:${d.nodeId}`);
        if (d.nodeId === 'a') {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        order.push(`end:${d.nodeId}`);
      },
    });

    money.record(draft('a'), 400);
    money.record(draft('b'), 400);
    await vi.waitFor(() => {
      expect(releaseFirst).toBeDefined();
    });
    expect(order).toEqual(['start:a']); // b has not started while a is in flight
    releaseFirst?.();
    await money.join();
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('re-throws a failed write at the barrier, ONCE, and stays sticky', async () => {
    // Nobody awaits the write at its call site, so the rejection has to be retained and surfaced here or it
    // is unhandled. Surfaced once — a later join must not re-report the same broken write as new — while the
    // sticky flag keeps the barrier meaningful for the rest of the run.
    const money = new MoneyDurability({
      emit: () => Promise.reject(new Error('disk full')),
    });
    money.record(draft('a'), 400);

    await expect(money.join()).rejects.toSatisfy(isLedgerDurabilityError);
    expect(money.durabilityBroken).toBe(true);
    await expect(money.join()).resolves.toBeUndefined(); // not re-reported
    expect(money.durabilityBroken).toBe(true); // but still broken
  });

  it('names the owning node and keeps the cause OFF the message', async () => {
    // A durable-write failure can carry a filesystem path, and this message reaches a user-facing
    // `run:failed`. The cause rides `cause` for a host that narrows on the class.
    const cause = new Error('ENOENT: /Users/someone/.relavium/history.db');
    const money = new MoneyDurability({ emit: () => Promise.reject(cause) });
    money.record(draft('the-node'), 400);

    await money.join().then(
      () => expect.unreachable('join must throw'),
      (error: unknown) => {
        if (!isLedgerDurabilityError(error)) expect.unreachable('wrong error class');
        expect(error.nodeId).toBe('the-node');
        expect(error.cause).toBe(cause);
        expect(error.message).not.toContain('.relavium');
      },
    );
  });

  it('survives a SYNCHRONOUSLY throwing sink instead of bricking the chain', async () => {
    // A `better-sqlite3`-backed store throws synchronously. A bare `emit(draft)` inside the `.then` would
    // escape before `.catch`/`.finally` attach: the pending count leaks at >= 1 forever and the chain is left
    // permanently rejected, so every later join throws with no way to clear it.
    const seen: string[] = [];
    let boom = true;
    const money = new MoneyDurability({
      emit: (d) => {
        if (boom) throw new Error('sync boom');
        seen.push(d.nodeId);
      },
    });
    money.record(draft('a'), 400);
    await expect(money.join()).rejects.toSatisfy(isLedgerDurabilityError);

    // The recovery half, on the SAME instance — and it has to be. What a synchronous throw could brick is
    // THIS chain's tail and THIS pending count; a second, healthy instance shares neither, so asserting on
    // one proved only that a fresh object works. Here the later write must reach the sink and the join must
    // resolve, which is false if `#inFlight` was left permanently rejected or `#pending` leaked at >= 1.
    boom = false;
    money.record(draft('b'), 400);
    await expect(money.join()).resolves.toBeUndefined();
    expect(seen).toEqual(['b']);
    expect(money.durabilityBroken).toBe(true); // sticky, as designed — usable is not the same as healthy
  });

  it('joins the CONSERVATIVE chain too — one join, not two (ADR-0077 §4)', async () => {
    const flushConservative = vi.fn(async () => {});
    const money = new MoneyDurability({ emit: () => {}, flushConservative });

    await money.join();
    expect(flushConservative).toHaveBeenCalledTimes(1);
  });

  it('surfaces a CONSERVATIVE failure through the same join', async () => {
    // The estimate half throws its own retained failure from `flushCommitments`. A caller awaiting the single
    // join must see it — otherwise "one join" would silently swallow half the money's failures.
    const money = new MoneyDurability({
      emit: () => {},
      flushConservative: () => Promise.reject(new Error('commitment write failed')),
    });
    money.record(draft('a'), 400);

    await expect(money.join()).rejects.toThrow('commitment write failed');
  });

  it('is a no-op join when nothing was ever recorded — an unbudgeted, zero-egress run', async () => {
    const money = new MoneyDurability({ emit: () => expect.unreachable('nothing to emit') });
    await expect(money.join()).resolves.toBeUndefined();
    expect(money.durabilityBroken).toBe(false);
  });

  it('exposes a turn port that records and joins without leaking the class', async () => {
    const seen: SettledAttemptDraft[] = [];
    const money = new MoneyDurability({
      emit: (d) => {
        seen.push(d);
      },
    });
    // Destructured, because the turn core passes `params.money` around by value.
    const { record, join } = money.turnPort(() => 0);
    record(draft('a', 700));
    await join();
    expect(seen).toEqual([expect.objectContaining({ nodeId: 'a', costMicrocents: 700 })]);
  });

  it('captures the run-wide total at RECORD time, not when the chained write runs', async () => {
    // The write is chained behind the previous one's `persistEvent` — real I/O. Reading the engine's live
    // counter inside `emit` therefore yields the total including every attempt that settled DURING that wait,
    // which under a `fan_out` (concurrent nodes sharing one chain) is a different number. Here the counter
    // advances while `a` is in flight, and `b` must still report the total as of its own settle.
    const stamped: number[] = [];
    let releaseFirst: (() => void) | undefined;
    const money = new MoneyDurability({
      emit: async (d, cumulative) => {
        stamped.push(cumulative);
        if (d.nodeId === 'a') {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      },
    });
    let counter = 100;
    const { record, join } = money.turnPort(() => counter);

    record(draft('a')); // settles at 100
    await vi.waitFor(() => {
      expect(releaseFirst).toBeDefined();
    });
    counter = 250;
    record(draft('b')); // settles at 250 — queued behind `a`, which is still blocked
    counter = 900; // a third node settles while `a`'s write is still in flight
    releaseFirst?.();
    await join();

    // Reading the counter inside `emit` would make this `[100, 900]` — `b`'s row claiming a total that
    // includes money `b` never spent, from an attempt that had not settled when `b` did.
    expect(stamped).toEqual([100, 250]);
  });

  it('reports the CONSERVATIVE failure first, then the retained ledger failure on the next join', async () => {
    // Both halves can be broken at once, and `join()` surfaces one failure per call. The order is not
    // arbitrary: the conservative flush is awaited BEFORE the retained ledger failure is thrown, so a caller
    // sees the estimate error first — and the ledger error must still be there afterwards rather than being
    // dropped by the throw that overtook it.
    //
    // The fixture rejects ONCE on purpose, because that is `BudgetGovernor.flushCommitments`'s own contract
    // (a retained failure is surfaced once, then cleared) — and the coupling is load-bearing rather than
    // incidental: a conservative half that rejected on EVERY call would mask the retained ledger failure for
    // the rest of the run, since `join()` never reaches the throw below.
    let conservativeBroken = true;
    const money = new MoneyDurability({
      emit: () => Promise.reject(new Error('ledger disk full')),
      flushConservative: () => {
        if (!conservativeBroken) return Promise.resolve();
        conservativeBroken = false;
        return Promise.reject(new Error('commitment write failed'));
      },
    });
    money.record(draft('the-node'), 400);

    await expect(money.join()).rejects.toThrow('commitment write failed');
    await money.join().then(
      () => expect.unreachable('the retained ledger failure must still surface'),
      (error: unknown) => {
        if (!isLedgerDurabilityError(error)) expect.unreachable('wrong error class');
        expect(error.nodeId).toBe('the-node');
      },
    );
    expect(money.durabilityBroken).toBe(true);
  });
});
