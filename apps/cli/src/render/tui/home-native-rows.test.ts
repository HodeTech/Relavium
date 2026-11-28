import { describe, expect, it } from 'vitest';

import { promptRows } from './home-app.js';
import { keyToken } from './legend.js';
import type { NativePromptSnapshot } from './native-prompt-channel.js';

/**
 * The room the Home leaves a native card is an estimate of its rows, and the estimate counts the chord card's answer rows with the tag the
 * card draws in front of them: `[Ctrl+Y] ` as the legend grammar writes it (ADR-0145 §3), taken from the same function ({@link keyToken}), so a
 * change of the grammar moves the estimate with the words and not after them.
 */
const chord = (label: string): NativePromptSnapshot => ({
  active: true,
  kind: 'chord',
  message: '',
  note: '',
  options: [{ value: 'allow', label }],
  selected: 0,
  display: '',
  error: '',
  escape: 'cancel',
  details: [],
});

describe('promptRows for a chord card', () => {
  const COLUMNS = 40;
  // two columns of indent, the key as the legend writes it, one space
  const tag = `  ${keyToken('Ctrl+Y')} `;

  it('counts the answer row with the tag the card draws: a label that exactly fills the row is one row, one column more is two', () => {
    const room = COLUMNS - tag.length;
    // one row of body for the row the card draws, plus the card's one row of legend
    const oneRow = promptRows(chord('x'.repeat(room)), COLUMNS);
    const twoRows = promptRows(chord('x'.repeat(room + 1)), COLUMNS);
    expect(twoRows - oneRow).toBe(1);
    expect(promptRows(chord('x'), COLUMNS)).toBe(oneRow);
  });

  it('counts a row of a card that is not a chord with no key tag at all', () => {
    const select: NativePromptSnapshot = { ...chord('x'.repeat(COLUMNS - 2)), kind: 'select' };
    const wrapped: NativePromptSnapshot = { ...chord('x'.repeat(COLUMNS - 1)), kind: 'select' };
    expect(promptRows(wrapped, COLUMNS) - promptRows(select, COLUMNS)).toBe(1);
  });
});
