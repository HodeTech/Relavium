import { describe, expect, it } from 'vitest';
import {
  DispatchAllowanceBook,
  InvalidDispatchAllowanceError,
  type AllowanceDebit,
} from './dispatch-allowance.js';

function admitted(
  book: DispatchAllowanceBook,
  token: Parameters<DispatchAllowanceBook['acquire']>[0],
  cost: number | undefined,
): AllowanceDebit {
  const result = book.acquire(token, cost);
  expect(result.kind).toBe('admitted');
  if (result.kind !== 'admitted') throw new Error('expected fixture admission');
  return result.debit;
}

describe('dispatch ownership and monetary reconciliation', () => {
  for (const mode of ['realized', 'conservative'] as const) {
    it(`closes a positive allowance consumed exactly by ${mode} spend`, () => {
      const book = new DispatchAllowanceBook();
      const token = book.activate('n', 1, 2, () => true);
      const debit = admitted(book, token, 2);
      if (mode === 'realized') debit.settle(2);
      else debit.retain();
      expect(book.acquire(token, 0)).toEqual({ kind: 'refused', reason: 'exhausted' });
      expect(book.acquire(token, undefined)).toEqual({ kind: 'refused', reason: 'exhausted' });
    });
  }
  it('keeps a single in-flight priced zero and closes it on a real overrun', () => {
    const book = new DispatchAllowanceBook();
    const token = book.activate('n', 1, 0, () => true);
    const debit = admitted(book, token, 0);
    expect(book.acquire(token, 0)).toEqual({ kind: 'refused', reason: 'in_flight' });
    debit.settle(1);
    expect(book.acquire(token, 0)).toEqual({ kind: 'refused', reason: 'exhausted' });
    expect(book.acquire(token, undefined)).toEqual({ kind: 'refused', reason: 'exhausted' });
  });

  it('preserves non-strict unpriced admission at a natural zero without inventing a debit', () => {
    const book = new DispatchAllowanceBook();
    const token = book.activate('n', 1, 0, () => true);
    admitted(book, token, undefined).retain();
    admitted(book, token, 0).retain();
    expect(book.acquire(token, 1)).toEqual({ kind: 'refused', reason: 'exhausted' });
    expect(book.acquire(token, undefined)).toEqual({ kind: 'refused', reason: 'exhausted' });
  });

  it('reconciles a previously unpriced call when a known actual charge arrives', () => {
    const book = new DispatchAllowanceBook();
    const token = book.activate('n', 1, 4, () => true);
    const debit = admitted(book, token, undefined);
    debit.settle(3);
    debit.release();
    debit.settle(0);
    expect(book.acquire(token, 2)).toEqual({ kind: 'refused', reason: 'exhausted' });
    const zero = book.activate('zero', 2, 0, () => true);
    admitted(book, zero, undefined).settle(1);
    expect(book.acquire(zero, undefined)).toEqual({ kind: 'refused', reason: 'exhausted' });
  });

  it('holds its single-flight slot while a settlement lifetime predicate reenters', () => {
    const book = new DispatchAllowanceBook();
    let reenter = false;
    let refusal: ReturnType<DispatchAllowanceBook['acquire']> | undefined;
    const token = book.activate('n', 1, 10, () => {
      if (reenter) {
        reenter = false;
        refusal = book.acquire(token, 5);
      }
      return true;
    });
    const debit = admitted(book, token, 5);
    reenter = true;
    debit.settle(20);
    expect(refusal).toEqual({ kind: 'refused', reason: 'in_flight' });
    expect(book.acquire(token, 0)).toEqual({ kind: 'refused', reason: 'exhausted' });
  });

  it('refunds realized underspend, a proven release, and retains conservative spend exactly once', () => {
    const book = new DispatchAllowanceBook();
    const token = book.activate('n', 1, 10, () => true);
    const first = admitted(book, token, 8);
    first.settle(3);
    first.release();
    first.retain();
    const released = admitted(book, token, 7);
    released.release();
    released.release();
    released.settle(6);
    admitted(book, token, 7).retain();
    expect(book.acquire(token, 1)).toEqual({ kind: 'refused', reason: 'exhausted' });
  });

  it('accounts successive overruns until a single final overrun spends the remainder', () => {
    const book = new DispatchAllowanceBook();
    const token = book.activate('n', 1, 10, () => true);
    let actual = 0;
    for (const [estimate, realized] of [
      [2, 3],
      [2, 3],
      [2, 3],
      [1, 2],
    ]) {
      if (estimate === undefined || realized === undefined) throw new Error('incomplete fixture');
      admitted(book, token, estimate).settle(realized);
      actual += realized;
    }
    expect(actual).toBe(11);
    expect(actual).toBeLessThanOrEqual(10 + (2 - 1));
    expect(book.acquire(token, 0)).toEqual({ kind: 'refused', reason: 'exhausted' });
  });

  it('cannot debit or refund a replacement owner through an abandoned token', () => {
    const book = new DispatchAllowanceBook();
    const old = book.activate('n', 1, 10, () => true);
    const straggler = admitted(book, old, 8);
    const next = book.activate('n', 2, 4, () => true);
    straggler.settle(0);
    expect(book.acquire(old, 0)).toEqual({ kind: 'refused', reason: 'owner_invalid' });
    admitted(book, next, 4).retain();
    expect(book.acquire(next, 1)).toEqual({ kind: 'refused', reason: 'exhausted' });
    expect(() => book.activate('n', 1, 10, () => true)).toThrow(InvalidDispatchAllowanceError);
  });

  it('separates two sibling tranches and rejects tokens from another governor book', () => {
    const book = new DispatchAllowanceBook(),
      other = new DispatchAllowanceBook();
    const a = book.activate('a', 1, 2, () => true),
      b = book.activate('b', 2, 3, () => true);
    const debit = admitted(book, a, 2);
    admitted(book, b, 3).retain();
    debit.release();
    admitted(book, a, 2).retain();
    expect(other.acquire(a, 0)).toEqual({ kind: 'refused', reason: 'owner_invalid' });
  });

  it('refuses a reentrant takeover while checking lifetime and preserves successor capacity', () => {
    const book = new DispatchAllowanceBook();
    let reenter = false;
    let next: ReturnType<DispatchAllowanceBook['activate']> | undefined;
    const token = book.activate('n', 1, 10, () => {
      if (reenter) {
        reenter = false;
        next = book.activate('n', 2, 3, () => true);
      }
      return true;
    });
    reenter = true;
    expect(book.validateLive(token)).toBe('owner_invalid');
    if (next === undefined) throw new Error('missing reentrant successor');
    admitted(book, next, 3).retain();
    expect(book.acquire(next, 1)).toEqual({ kind: 'refused', reason: 'exhausted' });
  });

  it('does not lose an unsettled reservation on an invalid actual amount', () => {
    const book = new DispatchAllowanceBook();
    const token = book.activate('n', 1, 10, () => true);
    const debit = admitted(book, token, 8);
    expect(() => debit.settle(Number.NaN)).toThrow(InvalidDispatchAllowanceError);
    expect(book.acquire(token, 0)).toEqual({ kind: 'refused', reason: 'in_flight' });
    debit.retain();
    admitted(book, token, 2).retain();
    expect(book.acquire(token, 1)).toEqual({ kind: 'refused', reason: 'exhausted' });
  });

  for (const amount of [
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    0.5,
  ]) {
    it(`refuses malformed allowance ${amount}`, () => {
      expect(() => new DispatchAllowanceBook().activate('n', 1, amount, () => true)).toThrow(
        InvalidDispatchAllowanceError,
      );
    });
  }
});
