import { describe, expect, it } from 'vitest';

import { isCliError } from '../process/errors.js';
import { parseSecretLines } from './parse-secret-lines.js';

describe('shared first-run and resume secret lines (ADR-0107)', () => {
  const context = 'run --secret-inputs-stdin';

  it('preserves whitespace, Unicode and every equals sign in values across CRLF lines', () => {
    const values = parseSecretLines(
      '\r\n  token \t=  opaque-λ-😀=part=2 \t\r\n\nother=value\n',
      context,
    );
    expect(values).toEqual({ token: '  opaque-λ-😀=part=2 \t', other: 'value' });
    expect(Object.getPrototypeOf(values)).toBeNull();
  });

  it('owns prototype-like names without changing the accumulator prototype', () => {
    const values = parseSecretLines('__proto__=one\nconstructor=two\ntoString=three', context);
    expect(Object.keys(values)).toEqual(['__proto__', 'constructor', 'toString']);
    expect(Object.hasOwn(values, '__proto__')).toBe(true);
    expect(values['__proto__']).toBe('one');
    expect(values['constructor']).toBe('two');
    expect(values['toString']).toBe('three');
    expect(Object.getPrototypeOf(values)).toBeNull();
  });

  it('leaves omitted names absent and ignores blank lines', () => {
    expect(Object.keys(parseSecretLines(' \t\r\n\n', context))).toEqual([]);
    const supplied = parseSecretLines('token=one\n', context);
    expect(Object.hasOwn(supplied, 'optional')).toBe(false);
  });

  it.each([
    'opaque-line-N729',
    '=opaque-value-N729',
    ' \t=opaque-value-N729',
    'opaque-name-N729=',
    'opaque-name-N729= \t\r\n',
  ])('refuses a malformed line without echoing its opaque source: %j', (raw) => {
    try {
      parseSecretLines(raw, context);
      expect.fail('malformed secret lines must refuse');
    } catch (error) {
      expect(isCliError(error)).toBe(true);
      if (!isCliError(error)) throw error;
      expect(error.code).toBe('invalid_invocation');
      expect(error.message).toBe(
        'stdin for run --secret-inputs-stdin must be `name=value` lines with a non-empty value.',
      );
      expect(error.message).not.toContain('N729');
    }
  });

  it.each(['token=one\ntoken=two', 'token=one\n token \t=two'])(
    'refuses duplicates after name trimming without echoing their values: %j',
    (raw) => {
      expect(() => parseSecretLines(raw, context)).toThrow(
        'stdin for run --secret-inputs-stdin supplied the same `secret` name twice.',
      );
    },
  );

  it('retains the established gate context without incorporating the stdin name', () => {
    expect(() => parseSecretLines('opaque-name-N729=', 'run gate-run-id')).toThrow(
      'stdin for run gate-run-id must be `name=value` lines with a non-empty value.',
    );
  });
});
