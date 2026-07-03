import { describe, expect, it } from 'vitest';

import { promptRows } from './prompt-cursor.js';

describe('promptRows (multi-line prompt cursor placement, 2.5.D step 2)', () => {
  it('places the cursor mid-line, at the row end (trailing block), and on an empty buffer', () => {
    expect(promptRows('abc', 1)).toEqual([{ before: 'a', at: 'b', after: 'c' }]);
    expect(promptRows('abc', 3)).toEqual([{ before: 'abc', at: ' ', after: '' }]); // cursor at end ⇒ trailing block
    expect(promptRows('', 0)).toEqual([{ before: '', at: ' ', after: '' }]); // empty buffer ⇒ one trailing block
  });

  it('splits on newlines and places the cursor on exactly one row', () => {
    // 'ab\ncd' → rows ['ab','cd']; cursor 4 sits on the 2nd row at col 1 (before 'd').
    expect(promptRows('ab\ncd', 4)).toEqual([
      { before: 'ab', at: undefined, after: '' },
      { before: 'c', at: 'd', after: '' },
    ]);
  });

  it('at a newline boundary the cursor sits at the END of the preceding row (not the start of the next)', () => {
    // cursor 2 is the end of row 'ab' (just before the '\n') ⇒ trailing block on row 0, no cursor on row 1.
    expect(promptRows('ab\ncd', 2)).toEqual([
      { before: 'ab', at: ' ', after: '' },
      { before: 'cd', at: undefined, after: '' },
    ]);
    // cursor 3 is the START of row 'cd' ⇒ cursor on row 1 at col 0, no cursor on row 0.
    expect(promptRows('ab\ncd', 3)).toEqual([
      { before: 'ab', at: undefined, after: '' },
      { before: '', at: 'c', after: 'd' },
    ]);
  });

  it('the cursor cell spans a whole astral char (2 code units)', () => {
    expect(promptRows('a😀b', 1)).toEqual([{ before: 'a', at: '😀', after: 'b' }]);
  });

  it('renders an empty line within a multi-line buffer (a blank continuation row)', () => {
    // 'a\n\nb' → rows ['a','','b']; cursor 4 is at the end (after 'b').
    expect(promptRows('a\n\nb', 4)).toEqual([
      { before: 'a', at: undefined, after: '' },
      { before: '', at: undefined, after: '' },
      { before: 'b', at: ' ', after: '' },
    ]);
  });
});
