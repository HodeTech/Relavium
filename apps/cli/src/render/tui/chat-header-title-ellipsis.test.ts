import { describe, expect, it } from 'vitest';

import { chatSessionTitle, headerRow } from './chat-layout.js';
import { displayWidth } from './viewport.js';

/**
 * OB7-L6 (the observation of unit 7's chat half): the header showed the session title with a trailing ASCII `...` next to the header's own `…` cut. The
 * persister cuts a long title with the host's one ellipsis (`deriveSessionTitle`), and the header scrubs its title again (`flowLine`), whose pass folds an
 * ellipsis a value brought into three dots (so a cut stays distinguishable from a value in a list). In the header that read as two styles of cut in one
 * row. The HEADER presentation maps a trailing `...` back to the host's ellipsis, so the row has ONE style; the stored title and `deriveSessionTitle`
 * are untouched.
 */
const ELLIPSIS = String.fromCodePoint(0x2026);

describe('the header draws one ellipsis style, whoever cut the title', () => {
  it('draws the persister’s cut (…) as …, not as three dots', () => {
    const title = chatSessionTitle('word '.repeat(30));
    expect(title.endsWith(ELLIPSIS)).toBe(true);
    const row = headerRow(title, 120);
    expect(row.title.endsWith(ELLIPSIS), row.title).toBe(true);
    expect(row.title).not.toContain('...');
  });

  it('draws a persisted title from an older session that ends in three dots with the host’s ellipsis', () => {
    const row = headerRow('Fix the login bug in the auth module...', 120);
    expect(row.title).toBe(`Fix the login bug in the auth module${ELLIPSIS}`);
  });

  it('keeps three dots that are not at the end of the title', () => {
    expect(headerRow('wait... what happened', 120).title).toBe('wait... what happened');
  });

  it('is one style when the header cuts the title itself: the cut and the mapped ellipsis are the same character', () => {
    const row = headerRow('Fix the login bug in the auth module...', 40);
    expect(row.title.endsWith(ELLIPSIS), row.title).toBe(true);
    expect(row.title).not.toContain('...');
    expect(row.wordmark.length + row.gap.length + displayWidth(row.title)).toBeLessThanOrEqual(40);
  });

  it('keeps the row exactly as wide as the terminal with a title, whichever style the title brought', () => {
    for (const title of ['A short title...', `A short title${ELLIPSIS}`, 'A short title']) {
      const row = headerRow(title, 80);
      expect(displayWidth(row.wordmark) + displayWidth(row.gap) + displayWidth(row.title)).toBe(80);
    }
  });
});
