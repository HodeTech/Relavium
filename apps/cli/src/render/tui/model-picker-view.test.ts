import { describe, expect, it } from 'vitest';

import { modelWindow } from './model-picker-view.js';

describe('modelWindow — the /models picker scroll window (2.5.G S7)', () => {
  it('shows the whole list when it fits (≤ the window size)', () => {
    expect(modelWindow(0, 0)).toEqual({ start: 0, end: 0 });
    expect(modelWindow(5, 3)).toEqual({ start: 0, end: 5 });
    expect(modelWindow(8, 7)).toEqual({ start: 0, end: 8 }); // exactly the window ⇒ no scroll
  });

  it('scrolls a window of 8 around the selection, clamped to the list bounds, with a marker for what it hides', () => {
    // Near the top: anchored at 0 (never a negative start), and only the end it hides is marked.
    expect(modelWindow(30, 0)).toEqual({ start: 0, end: 8, below: 23 });
    expect(modelWindow(30, 3)).toEqual({ start: 0, end: 8, below: 23 }); // 3 - 3 clamps to 0
    // In the middle: the selection is never on a marker row, and each marker counts the row it stands on.
    expect(modelWindow(30, 10)).toEqual({
      start: 7,
      end: 15,
      above: 8,
      below: 16,
    });
    // Near the bottom: pinned to the last 8 (never past the end).
    expect(modelWindow(30, 29)).toEqual({ start: 22, end: 30, above: 23 });
  });
});
