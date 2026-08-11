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

    money.record(draft('a'));
    money.record(draft('b'));
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
    money.record(draft('a'));

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
    money.record(draft('the-node'));

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
    money.record(draft('a'));
    await expect(money.join()).rejects.toSatisfy(isLedgerDurabilityError);

    // The recovery half, on the SAME instance — and it has to be. What a synchronous throw could brick is
    // THIS chain's tail and THIS pending count; a second, healthy instance shares neither, so asserting on
    // one proved only that a fresh object works. Here the later write must reach the sink and the join must
    // resolve, which is false if `#inFlight` was left permanently rejected or `#pending` leaked at >= 1.
    boom = false;
    money.record(draft('b'));
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
    money.record(draft('a'));

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
    const { record, join } = money.turnPort();
    record(draft('a', 700));
    await join();
    expect(seen).toEqual([expect.objectContaining({ nodeId: 'a', costMicrocents: 700 })]);
  });
});
