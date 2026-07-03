import { describe, expect, it } from 'vitest';

import { mentionWindow } from './mention-view.js';

describe('mentionWindow — the `@`-completion scroll window (2.5.D step 4)', () => {
  it('shows the whole list when it fits (≤ the window size)', () => {
    expect(mentionWindow(0, 0)).toEqual({ start: 0, end: 0 });
    expect(mentionWindow(3, 2)).toEqual({ start: 0, end: 3 });
    expect(mentionWindow(8, 7)).toEqual({ start: 0, end: 8 }); // exactly the window ⇒ no scroll
  });

  it('scrolls a window of 8 around the selection, clamped to the list bounds', () => {
    // Near the top: the window is anchored at 0 (never a negative start).
    expect(mentionWindow(20, 0)).toEqual({ start: 0, end: 8 });
    expect(mentionWindow(20, 3)).toEqual({ start: 0, end: 8 }); // 3 - 4 clamps to 0
    // In the middle: the selection sits `floor(8/2)` = 4 from the window start.
    expect(mentionWindow(20, 10)).toEqual({ start: 6, end: 14 });
    // Near the bottom: the window is pinned to the last 8 (never past the end).
    expect(mentionWindow(20, 19)).toEqual({ start: 12, end: 20 });
  });
});
