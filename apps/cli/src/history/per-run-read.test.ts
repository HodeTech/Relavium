import { CorruptRunEventError, isCorruptRunEventError } from '@relavium/db';
import { describe, expect, it } from 'vitest';

import { readPerRunOrDegrade } from './per-run-read.js';

describe('readPerRunOrDegrade', () => {
  it('returns the read`s value when it succeeds', () => {
    expect(readPerRunOrDegrade(['fallback'], () => ['real'])).toEqual(['real']);
  });

  it('degrades ONE damaged run instead of aborting the aggregation', () => {
    // The whole point: the Home / `status` / `gate list` fan this read over many runs with no isolation, so one
    // unreadable row used to take away every run — including the healthy ones — and no CLI command can repair it.
    const err = new CorruptRunEventError('run-9', 3, 'node:started', new Error('bad body'));
    expect(
      readPerRunOrDegrade([], () => {
        throw err;
      }),
    ).toEqual([]);
  });

  it('RETHROWS anything else — a closed handle or a programming fault is not a per-run condition', () => {
    // Narrow on purpose. Swallowing these would turn a real, global failure into a silently EMPTY listing, which
    // reads as "you have no runs" — a far worse lie than one run missing its gate detail.
    const otherCode = new Error('nope');
    Object.assign(otherCode, { code: 'some_other_fault' });
    for (const thrown of [
      new Error('database handle is closed'),
      new TypeError('x is not a function'),
      otherCode,
    ]) {
      expect(() =>
        readPerRunOrDegrade([], () => {
          throw thrown;
        }),
      ).toThrow(thrown);
    }
  });

  it('does not accept a NON-Error that merely carries the code', () => {
    // The guard requires `instanceof Error` before looking at `code`, so a bare payload shaped like the error
    // cannot smuggle a degrade past it. Asserted on the guard itself: throwing a non-Error is forbidden by
    // `@typescript-eslint/only-throw-error`, and that rule is right — this is the honest way to pin it.
    expect(isCorruptRunEventError({ code: 'corrupt_run_event' })).toBe(false);
    expect(isCorruptRunEventError('corrupt_run_event')).toBe(false);
    expect(isCorruptRunEventError(undefined)).toBe(false);
    expect(
      isCorruptRunEventError(new CorruptRunEventError('r', 1, 'node:started', undefined)),
    ).toBe(true);
  });
});
