import { describe, expect, it } from 'vitest';
import { scrubSecrets, secretMaskRanges } from './scrub-secrets.js';

describe('original secret mask ranges', () => {
  it('retains exact immutable source coordinates with astral text and overlapping rules', () => {
    const text = '😀 Bearer sk-proj-abcdefghijklmnopqrstuvw public';
    const ranges = secretMaskRanges(text);
    expect(ranges).toEqual([{ start: 10, end: 41 }]);
    expect(text.slice(ranges[0]?.start, ranges[0]?.end)).toBe('sk-proj-abcdefghijklmnopqrstuvw');
    expect(Object.isFrozen(ranges)).toBe(true);
    expect(Object.isFrozen(ranges[0])).toBe(true);
  });
  it.each([
    'Bearer sk-proj-abcdefghijklmnopqrstuvw public',
    'prefix https://user:password@example.invalid end',
    '?token=opaque$code|sh&public=yes',
    'sk-proj-abcdef\nghijklmnopqrstuvw',
    'sk-proj-abcde\u001b[0mfghijklmnopqrstuvw',
    'BearerBearerBearerBearerBearerBearerBearerBearerBearer opaque',
  ])('is at least as conservative as the diagnostic masker: %j', (text) => {
    let cursor = 0;
    let projected = '';
    for (const range of secretMaskRanges(text)) {
      expect(range.start).toBeGreaterThanOrEqual(cursor);
      expect(range.end).toBeLessThanOrEqual(text.length);
      projected += text.slice(cursor, range.start) + '[REDACTED]';
      cursor = range.end;
    }
    projected += text.slice(cursor);
    expect(projected === '[REDACTED]' || projected === scrubSecrets(text)).toBe(true);
  });
  it('does not mistake literal display notation for original secrets', () => {
    expect(secretMaskRanges('literal [REDACTED] <MASK:id=1;bytes=2>')).toEqual([]);
  });
});
