import { describe, expect, it } from 'vitest';

import { InterpolationError } from '../errors.js';

import { filterFn } from './filters.js';
import type { ResolverCapabilities } from './scope.js';
import type { FilterArg, InterpolationReference } from './references.js';

/** Apply a filter by name directly (the path resolve.ts takes), returning its result or throwing. */
function runFilter(
  name: string,
  value: unknown,
  args: readonly FilterArg[] = [],
  caps: ResolverCapabilities = {},
): unknown {
  const ref: InterpolationReference = {
    kind: 'inputs',
    identifier: 'x',
    path: '',
    filters: [{ name, args }],
    raw: `{{inputs.x | ${name}}}`,
  };
  return filterFn({ name, args }, ref)(value, args, caps, ref);
}

const str = (value: string): FilterArg => ({ type: 'string', value });

describe('filterFn — registry lookup safety', () => {
  it.each(['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'])(
    'rejects the inherited registry member %j as unknown_filter (no prototype invocation)',
    (name) => {
      let thrown: unknown;
      try {
        runFilter(name, 'v');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(InterpolationError);
      if (!(thrown instanceof InterpolationError)) {
        throw new Error('expected an InterpolationError');
      }
      expect(thrown.code).toBe('unknown_filter');
    },
  );

  it('rejects a plain unknown filter name', () => {
    expect(() => runFilter('nope', 'v')).toThrow(InterpolationError);
  });
});

describe('json filter', () => {
  it('serializes a scalar and an object as pretty JSON', () => {
    expect(runFilter('json', 0)).toBe('0');
    expect(runFilter('json', { a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
  });
});

describe('length filter', () => {
  it('counts UTF-16 code units for a string (matching the docblock, not codepoints)', () => {
    expect(runFilter('length', 'abcd')).toBe(4);
    expect(runFilter('length', '👍ab')).toBe(4); // 👍 is two UTF-16 code units
    expect(runFilter('length', '')).toBe(0);
  });

  it('counts array items and object own keys', () => {
    expect(runFilter('length', [1, 2, 3])).toBe(3);
    expect(runFilter('length', [])).toBe(0);
    expect(runFilter('length', { a: 1, b: 2 })).toBe(2);
  });

  it('rejects a non-countable value', () => {
    expect(() => runFilter('length', 5)).toThrow(InterpolationError);
  });
});

describe('default filter', () => {
  it('passes a falsy-but-present value through (0 / false / empty string), rescuing only null/undefined', () => {
    expect(runFilter('default', 0, [str('FB')])).toBe(0);
    expect(runFilter('default', false, [str('FB')])).toBe(false);
    expect(runFilter('default', '', [str('FB')])).toBe('');
    expect(runFilter('default', null, [str('FB')])).toBe('FB');
    expect(runFilter('default', undefined, [str('FB')])).toBe('FB');
  });

  it('requires exactly one argument', () => {
    expect(() => runFilter('default', 'v', [])).toThrow(InterpolationError);
  });
});

describe('read_file filter', () => {
  it('reads via the host capability and forwards the AbortSignal', async () => {
    const controller = new AbortController();
    let received: unknown;
    const caps: ResolverCapabilities = {
      readFile: (path, signal) => {
        received = signal;
        return `FILE(${path})`;
      },
    };
    const ref: InterpolationReference = {
      kind: 'inputs',
      identifier: 'x',
      path: '',
      filters: [{ name: 'read_file', args: [] }],
      raw: '{{inputs.x | read_file}}',
    };
    const out = await filterFn({ name: 'read_file', args: [] }, ref)(
      'a.ts',
      [],
      caps,
      ref,
      controller.signal,
    );
    expect(out).toBe('FILE(a.ts)');
    expect(received).toBe(controller.signal);
  });

  it('fails typed when no host reader is provided', async () => {
    await expect(runFilter('read_file', 'a.ts')).rejects.toMatchObject({
      code: 'read_file_unavailable',
    });
  });

  it('classifies a host AbortError as `aborted`, not `read_file_failed`', async () => {
    const abortErr = new Error('cancelled');
    abortErr.name = 'AbortError';
    await expect(
      runFilter('read_file', 'a.ts', [], {
        readFile: () => {
          throw abortErr;
        },
      }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('classifies a non-abort host error as `read_file_failed`', async () => {
    await expect(
      runFilter('read_file', 'a.ts', [], {
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    ).rejects.toMatchObject({ code: 'read_file_failed' });
  });
});
