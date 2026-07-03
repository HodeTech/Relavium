import { describe, expect, it } from 'vitest';

import { sanitizeInline } from './chat-projection.js';
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

  it('a control/escape sequence split across the cursor is stripped in EVERY segment (no ANSI/OSC injection)', () => {
    // PromptEditor sanitizes before / at / after INDEPENDENTLY. A crafted ESC/CSI/OSC must not survive in any
    // segment at ANY cursor position — even when the cursor splits the sequence (ESC as the `at` cell, or `[`
    // right after an ESC that ended `before`). The concatenated sanitized render must carry NO control bytes.
    // eslint-disable-next-line no-control-regex -- deliberately matching the C0/C1 control bytes we must strip
    const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
    const crafted = ['a\x1b[31mb', 'a\x1b]0;pwn\x07b', 'a\x1bb', '\x1b[2J\x1b[0;0Hx'];
    for (const text of crafted) {
      for (let cursor = 0; cursor <= text.length; cursor++) {
        for (const row of promptRows(text, cursor)) {
          const rendered =
            sanitizeInline(row.before) +
            (row.at === undefined ? '' : sanitizeInline(row.at)) +
            sanitizeInline(row.after);
          expect(rendered).not.toMatch(CONTROL); // no ESC / CSI / OSC / C0 / C1 byte survives the display boundary
        }
      }
    }
  });
});
