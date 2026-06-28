import { describe, expect, it } from 'vitest';

import { deriveSessionTitle, SESSION_TITLE_MAX } from './session-title.js';

describe('deriveSessionTitle', () => {
  it('returns a short message verbatim (trimmed)', () => {
    expect(deriveSessionTitle('Plan the launch')).toBe('Plan the launch');
    expect(deriveSessionTitle('  hello  ')).toBe('hello');
  });

  it('collapses internal whitespace + newlines to a single line', () => {
    expect(deriveSessionTitle('line one\nline two\t  three')).toBe('line one line two three');
  });

  it('truncates an over-long message with an ellipsis, staying within the code-point max', () => {
    const title = deriveSessionTitle('a'.repeat(100));
    expect(title).toBeDefined();
    // `<=` not `===`: a trailing-whitespace cut is trimmed off BEFORE the ellipsis, so the result can be shorter
    // than the cap. (The all-'a' input here happens to land exactly at the cap.)
    expect([...(title ?? '')].length).toBeLessThanOrEqual(SESSION_TITLE_MAX);
    expect(title?.endsWith('…')).toBe(true);
  });

  it('truncates on a code-point boundary — never splits an emoji into a lone surrogate (no mojibake)', () => {
    // An astral char straddling the cut index would, with a code-UNIT slice, leave a lone high surrogate.
    const title = deriveSessionTitle(`${'a'.repeat(38)}\u{1F600}${'b'.repeat(10)}`);
    expect(title).toBeDefined();
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title ?? '')).toBe(false); // no lone high surrogate
  });

  it('returns undefined for an empty or whitespace-only message (no empty title persisted)', () => {
    expect(deriveSessionTitle('')).toBeUndefined();
    expect(deriveSessionTitle('   \n\t ')).toBeUndefined();
  });

  it('keeps a message exactly at the limit untruncated', () => {
    const exact = 'x'.repeat(SESSION_TITLE_MAX);
    expect(deriveSessionTitle(exact)).toBe(exact);
  });
});
