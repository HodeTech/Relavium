import { describe, expect, it } from 'vitest';

import { homeFitsTerminal, HOME_MIN_COLS, HOME_MIN_ROWS } from './home-projection.js';
import { nativePromptFits } from './native-prompt-acknowledgement.js';

/**
 * The first-run setup that waits for room (`drive-home`) asks the NATIVE card's floor, while the Home draws its own resize line at the Home's
 * (ADR-0146 §6). They are two numbers written in two files, and the wait is only honest while they agree: a Home floor above the card's would
 * open a card over a resize line, and one below it would leave the offer waiting on a terminal the Home already draws in. A change to either
 * fails here, loudly, on both sides of each dimension. (A new file: `home-projection.test.ts` is in the permanent usage-coverage cohort, whose
 * case count is pinned.)
 */
describe('the Home’s minimum terminal and the native card’s floor are one number', () => {
  it.each([
    [HOME_MIN_COLS, HOME_MIN_ROWS],
    [HOME_MIN_COLS - 1, HOME_MIN_ROWS],
    [HOME_MIN_COLS, HOME_MIN_ROWS - 1],
    [HOME_MIN_COLS + 1, HOME_MIN_ROWS + 1],
    [HOME_MIN_COLS - 1, HOME_MIN_ROWS - 1],
    [200, 60],
    [10, 10],
  ])('at %i×%i they agree', (cols, rows) => {
    expect(nativePromptFits({ cols, rows })).toBe(homeFitsTerminal(cols, rows));
  });

  it('is 80×24 on both, the size the first-run card is drawn for', () => {
    expect([HOME_MIN_COLS, HOME_MIN_ROWS]).toEqual([80, 24]);
    expect(nativePromptFits({ cols: 80, rows: 24 })).toBe(true);
    expect(nativePromptFits({ cols: 79, rows: 24 })).toBe(false);
    expect(nativePromptFits({ cols: 80, rows: 23 })).toBe(false);
  });
});
