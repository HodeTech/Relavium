import { describe, expect, it } from 'vitest';

import { cardTitleRows, keyTone, reviewUnavailableText } from './tool-review-view.js';

/** How a key legend's parts are coloured: the answers stand out, the exits are as visible as any answer, the words stay dim. */
describe('keyTone — a legend part, coloured by what it does', () => {
  it('draws allow in green, deny in red, any other bracketed key in cyan, all bold', () => {
    for (const part of ['[Ctrl+Y]', '[Ctrl+G]', '[Ctrl+O]'])
      expect(keyTone(part, true), part).toEqual({ color: 'green', bold: true });
    expect(keyTone('[Ctrl+N]', true)).toEqual({ color: 'red', bold: true });
    for (const part of ['[v]', '[b]', '[Ctrl+R]', '[PgUp/PgDn]'])
      expect(keyTone(part, true), part).toEqual({ color: 'cyan', bold: true });
  });

  it('draws both exits, Esc and Ctrl+C (the stop key every legend names), in yellow and bold (ADR-0137 §4)', () => {
    expect(keyTone('Esc', true)).toEqual({ color: 'yellow', bold: true });
    expect(keyTone('Ctrl+C', true)).toEqual({ color: 'yellow', bold: true });
  });

  it('dims the words, and draws nothing at all with colour off', () => {
    expect(keyTone(' stops the turn', true)).toEqual({ dimColor: true });
    expect(keyTone(' Deny   ', true)).toEqual({ dimColor: true });
    for (const part of ['[Ctrl+Y]', '[Ctrl+N]', 'Esc', 'Ctrl+C', ' words', '[v]'])
      expect(keyTone(part, false), part).toEqual({});
  });
});

/** The card's title rows: the verb and the target, a saved result's own words, or the tool's name when the call has no target. */
describe('cardTitleRows — what the top of the card says the call is', () => {
  const DASH = String.fromCharCode(0x2014);
  const base = {
    savedResult: false,
    verb: 'Overwrite',
    toolId: 'write_file',
    command: false,
  } as const;

  it('says a delivered saved result is not a new operation, and indents the rows of what it is about', () => {
    expect(cardTitleRows({ ...base, savedResult: true, targetRows: ['a.txt', 'b'] })).toEqual([
      `Deliver saved result ${DASH} no new filesystem operation`,
      '  a.txt',
      '  b',
    ]);
  });

  it('names the tool when the call has no target, and strips what a tool name could carry into the terminal', () => {
    expect(cardTitleRows({ ...base, targetRows: [] })).toEqual(['Overwrite write_file']);
    const hostile = `evil${String.fromCharCode(27)}[31mred`;
    expect(cardTitleRows({ ...base, toolId: hostile, targetRows: [] })).toEqual([
      'Overwrite evilred',
    ]);
  });

  it('wraps a target under two spaces, and a command under its own first word', () => {
    expect(cardTitleRows({ ...base, targetRows: ['one', 'two', 'three'] })).toEqual([
      'Overwrite one',
      '  two',
      '  three',
    ]);
    expect(
      cardTitleRows({ ...base, verb: 'Run', command: true, targetRows: ['one', 'two', 'three'] }),
    ).toEqual(['Run one', '    two', '    three']);
  });
});

/** What the card says in place of itself: the identity first, then a command too large to show, then the screen. */
describe('reviewUnavailableText — why a review cannot be shown, said once', () => {
  const DASH = String.fromCharCode(0x2014);
  const none = { identityInvalid: false, commandTooLarge: false, onCard: true } as const;

  it('says the identity does not fit, whatever else is true', () => {
    const identity = `Review unavailable ${DASH} the tool identity does not fit; enlarge terminal.`;
    expect(reviewUnavailableText({ ...none, identityInvalid: true })).toBe(identity);
    expect(
      reviewUnavailableText({ identityInvalid: true, commandTooLarge: true, onCard: false }),
    ).toBe(identity);
  });

  it('says a command too large to show cannot be approved here, and that denying tells the model to split it', () => {
    const text = reviewUnavailableText({ ...none, commandTooLarge: true });
    expect(text).toContain('too large for this card to show');
    expect(text).toContain('more than 63 arguments');
    expect(text).toContain('so it cannot be approved here');
    expect(text).toContain('Denying tells the model to run it as smaller commands.');
    expect(reviewUnavailableText({ ...none, commandTooLarge: true, onCard: false })).toBe(text);
  });

  it('offers the full view only on the card, where [v] opens it; on the full view it does nothing', () => {
    expect(reviewUnavailableText(none)).toBe(
      `Review unavailable ${DASH} enlarge terminal, narrow change, or [v] full view / [p] code points.`,
    );
    expect(reviewUnavailableText({ ...none, onCard: false })).toBe(
      `Review unavailable ${DASH} enlarge terminal, narrow change, or [p] code points.`,
    );
  });
});
