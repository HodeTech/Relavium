/**
 * OB71 (unit 7, round 1): a draft FITS a bound only as Ink draws it. `promptWindow` answered `undefined` (draw it unbounded, by Ink's word wrap) whenever
 * the hard wrap's rows fit, but Ink's word wrap takes more rows than the hard wrap does, so a prose paste that "fit" 12 rows drew 13 and the frame was as
 * tall as the terminal. A caller that bounds a frame passes the lead's width, and the draft then fits only if the rows Ink draws fit too. Without it
 * nothing changes (the chat's pins in `prompt-window.test.ts`). A new file.
 */
import { describe, expect, it } from 'vitest';

import { sanitizeInline } from '../sanitize.js';
import { promptWindow, wrappedRowCount } from './prompt-window.js';

const LEAD = 2;
const COLUMNS = 74;
const TEXT_COLUMNS = COLUMNS - LEAD;
const HEIGHT = 12;
/** `count` words of 39 characters: one to a row as Ink wraps them at 74 columns, about two to a row as the hard wrap packs them. */
const words = (count: number): string => Array(count).fill('x'.repeat(39)).join(' ');

describe('promptWindow fits a draft as Ink draws it when it is told the lead’s width', () => {
  it('13 words: they fit the hard wrap’s rows and not Ink’s, so they are drawn as a window of the hard rows (and with no marker: all of them fit)', () => {
    const text = words(13);
    expect(wrappedRowCount(text, text.length, LEAD, COLUMNS, sanitizeInline)).toBe(13);
    const lines = promptWindow(text, text.length, TEXT_COLUMNS, HEIGHT, sanitizeInline, LEAD);
    expect(lines, 'a window, not the unbounded draw').toBeDefined();
    expect(lines?.every((line) => line.kind === 'row')).toBe(true);
    expect(lines?.length).toBeLessThanOrEqual(HEIGHT);
  });

  it('without the lead’s width the same draft is drawn unbounded, as before', () => {
    const text = words(13);
    expect(promptWindow(text, text.length, TEXT_COLUMNS, HEIGHT, sanitizeInline)).toBeUndefined();
  });

  it('12 words fit as Ink draws them: drawn unbounded, with or without the lead’s width', () => {
    const text = words(11);
    expect(
      promptWindow(text, text.length, TEXT_COLUMNS, HEIGHT, sanitizeInline, LEAD),
    ).toBeUndefined();
  });

  it('a draft with more hard rows than the bound is windowed as it always was, with the markers', () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${String(index)}`).join('\n');
    const lines = promptWindow(text, text.length, TEXT_COLUMNS, HEIGHT, sanitizeInline, LEAD);
    expect(lines).toHaveLength(HEIGHT);
    expect(lines?.[0]).toEqual({ kind: 'more', side: 'above', count: 29 });
  });
});
