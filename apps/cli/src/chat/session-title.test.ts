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

  it('truncates an over-long message with an ellipsis, staying within the max', () => {
    const long = 'a'.repeat(100);
    const title = deriveSessionTitle(long);
    expect(title).toBeDefined();
    expect(title?.length).toBe(SESSION_TITLE_MAX); // 39 chars + the 1-char ellipsis
    expect(title?.endsWith('…')).toBe(true);
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
