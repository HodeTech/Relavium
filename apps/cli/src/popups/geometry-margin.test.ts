/**
 * AR7-4 (unit 7, round 1): the margin rule was written twice, `popupMargin` here and `homeMargin` for the Home's pages, with nothing to tie them.
 * A popup's frame is as wide as the content column (ADR-0148 §4), and the content column IS the Home's, so the two margins are one rule: 6 from
 * 80 to 99 columns and 8 from 100. `popups/geometry.ts` imports nothing (it moves to a shared package as it is), so the tie is this test.
 */
import { describe, expect, it } from 'vitest';

import { homeMargin } from '../render/tui/home-layout.js';
import { popupMargin, popupWidth } from './geometry.js';

describe('a popup’s margin is the Home’s margin', () => {
  it.each([20, 79, 80, 88, 99, 100, 101, 120, 200])('at %i columns', (columns) => {
    expect(popupMargin(columns)).toBe(homeMargin(columns));
  });

  it('so a standard popup is as wide as the Home’s content column, capped as the ADR caps it', () => {
    expect(popupWidth(80, 'standard')).toBe(80 - 2 * homeMargin(80));
    expect(popupWidth(100, 'standard')).toBe(76);
  });
});
