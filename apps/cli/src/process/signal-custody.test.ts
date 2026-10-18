import { describe, expect, it, vi } from 'vitest';
import { SignalCustody, subscribeWithSignalCustody } from './signal-custody.js';

describe('explicit invocation signal custody', () => {
  it('claims before subscription, releases after removal, and rejects a second owner', () => {
    const custody = new SignalCustody();
    const remove = vi.fn(() => expect(custody.claimed).toBe(true));
    const callback = vi.fn();
    const release = subscribeWithSignalCustody(
      custody,
      (listener) => {
        expect(custody.claimed).toBe(true);
        expect(() => custody.claim()).toThrow();
        listener(15);
        return remove;
      },
      callback,
    );
    expect(callback).toHaveBeenCalledExactlyOnceWith(15);
    release();
    expect(remove).toHaveBeenCalledOnce();
    expect(custody.claimed).toBe(false);
  });

  it('returns custody after a failed acquisition but retains it when native removal fails', () => {
    const custody = new SignalCustody();
    const failure = new Error('native signal registration failed');
    expect(() =>
      subscribeWithSignalCustody(
        custody,
        () => {
          throw failure;
        },
        vi.fn(),
      ),
    ).toThrow(failure);
    expect(custody.claimed).toBe(false);
    const release = subscribeWithSignalCustody(
      custody,
      () => () => {
        throw failure;
      },
      vi.fn(),
    );
    expect(() => release()).toThrow(failure);
    expect(custody.claimed).toBe(true);
  });
});
