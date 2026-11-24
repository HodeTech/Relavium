import { describe, expect, it } from 'vitest';

import { mentionWindow } from './mention-view.js';

describe('mentionWindow — the `@`-completion scroll window (2.5.D step 4)', () => {
  it('shows the whole list when it fits (≤ the window size)', () => {
    expect(mentionWindow(0, 0)).toEqual({ start: 0, end: 0 });
    expect(mentionWindow(3, 2)).toEqual({ start: 0, end: 3 });
    expect(mentionWindow(8, 7)).toEqual({ start: 0, end: 8 }); // exactly the window ⇒ no scroll
  });

  it('scrolls a window of 8 around the selection, clamped to the list bounds, with a marker for what it hides', () => {
    // Near the top: the window is anchored at 0 (never a negative start), and only the end it hides is marked.
    expect(mentionWindow(20, 0)).toEqual({ start: 0, end: 8, below: 13 });
    expect(mentionWindow(20, 3)).toEqual({ start: 0, end: 8, below: 13 }); // 3 - 3 clamps to 0
    // In the middle: the selection is never on a marker row, and each marker counts the row it stands on.
    expect(mentionWindow(20, 10)).toEqual({
      start: 7,
      end: 15,
      above: 8,
      below: 6,
    });
    // Near the bottom: the window is pinned to the last 8 (never past the end).
    expect(mentionWindow(20, 19)).toEqual({ start: 12, end: 20, above: 13 });
  });
});
