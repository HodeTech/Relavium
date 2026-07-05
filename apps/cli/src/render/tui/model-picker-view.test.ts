import { describe, expect, it } from 'vitest';

import { modelWindow } from './model-picker-view.js';

describe('modelWindow — the /models picker scroll window (2.5.G S7)', () => {
  it('shows the whole list when it fits (≤ the window size)', () => {
    expect(modelWindow(0, 0)).toEqual({ start: 0, end: 0 });
    expect(modelWindow(5, 3)).toEqual({ start: 0, end: 5 });
    expect(modelWindow(8, 7)).toEqual({ start: 0, end: 8 }); // exactly the window ⇒ no scroll
  });

  it('scrolls a window of 8 around the selection, clamped to the list bounds', () => {
    // Near the top: anchored at 0 (never a negative start).
    expect(modelWindow(30, 0)).toEqual({ start: 0, end: 8 });
    expect(modelWindow(30, 3)).toEqual({ start: 0, end: 8 }); // 3 - 4 clamps to 0
    // In the middle: the selection sits floor(8/2) = 4 from the window start.
    expect(modelWindow(30, 10)).toEqual({ start: 6, end: 14 });
    // Near the bottom: pinned to the last 8 (never past the end).
    expect(modelWindow(30, 29)).toEqual({ start: 22, end: 30 });
  });
});
