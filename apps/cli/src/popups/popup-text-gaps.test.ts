/**
 * `fitNotice` ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §2): the one fit of what a
 * setting announces beside a popup's way back, at the exact edge and in which of its forms it clips, where `popup-text.test.ts` leaves it open
 * (found by the step-5 round-1 mutation sweep). The room is 54 columns, written here as a number, not read from the constant it checks.
 */
import { describe, expect, it } from 'vitest';

import { displayWidth } from '../render/tui/viewport.js';
import { fitNotice } from './popup-text.js';

describe('fitNotice at its 54 columns', () => {
  it('keeps a form exactly 54 columns wide whole, and clips one of 55', () => {
    const exact = 'x'.repeat(54);
    expect(fitNotice(exact)).toBe(exact);
    const clipped = fitNotice('x'.repeat(55));
    expect(clipped).not.toBe('x'.repeat(55));
    expect(displayWidth(clipped)).toBeLessThanOrEqual(54);
    expect(clipped.endsWith('…')).toBe(true);
  });

  it('takes the first form that fits, however many follow it', () => {
    expect(fitNotice('a'.repeat(60), 'b'.repeat(40), 'c'.repeat(10))).toBe('b'.repeat(40));
    expect(fitNotice('a'.repeat(54), 'b'.repeat(10))).toBe('a'.repeat(54));
  });

  it('clips the LAST form when none fits: the shortest one, never the longest', () => {
    const clipped = fitNotice('a'.repeat(80), 'b'.repeat(60));
    expect(clipped.startsWith('b')).toBe(true);
    expect(clipped).not.toContain('a');
    expect(displayWidth(clipped)).toBeLessThanOrEqual(54);
    expect(clipped.endsWith('…')).toBe(true);
  });
});
