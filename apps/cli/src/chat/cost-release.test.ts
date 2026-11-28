/**
 * The two halves of a release and the order they run in (`releaseHeldEstimates`, ADR-0074 §1): the durable record first, then the live governor;
 * a durable half that throws leaves the governor as it was; the amounts are the halves' own. The popup's confirmed step and `/cost --release` call
 * this one function, so the order is pinned once.
 */
import { describe, expect, it, vi } from 'vitest';

import { releaseHeldEstimates } from './cost-release.js';

describe('releaseHeldEstimates', () => {
  it('releases the durable record first and the live governor second, each once, and returns what each cleared', () => {
    const order: string[] = [];
    const store = {
      releaseSessionConservativeCommitments: vi.fn((id: string, at: number) => {
        order.push(`durable:${id}:${String(at)}`);
        return 450;
      }),
    };
    const governor = {
      releaseConservativeCommitments: vi.fn(() => {
        order.push('live');
        return 470;
      }),
    };
    const outcome = releaseHeldEstimates({ store, sessionId: 's-1', governor, now: () => 1234 });
    expect(order).toEqual(['durable:s-1:1234', 'live']);
    expect(outcome).toEqual({ durable: 450, live: 470 });
  });

  it('a durable half that throws leaves the live governor holding what it held', () => {
    const governor = { releaseConservativeCommitments: vi.fn(() => 450) };
    const store = {
      releaseSessionConservativeCommitments: vi.fn(() => {
        throw new Error('database is locked');
      }),
    };
    expect(() => releaseHeldEstimates({ store, sessionId: 's-1', governor, now: () => 1 })).toThrow(
      'database is locked',
    );
    expect(governor.releaseConservativeCommitments).not.toHaveBeenCalled();
  });

  it('a session with no cap has no live half: its amount is undefined and the durable record is still cleared', () => {
    const store = { releaseSessionConservativeCommitments: vi.fn(() => 0) };
    expect(
      releaseHeldEstimates({ store, sessionId: 's-1', governor: undefined, now: () => 1 }),
    ).toEqual({ durable: 0, live: undefined });
    expect(store.releaseSessionConservativeCommitments).toHaveBeenCalledOnce();
  });
});
