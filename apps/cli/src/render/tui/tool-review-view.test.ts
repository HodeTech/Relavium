import { describe, expect, it } from 'vitest';

import { rowSegments, type LegendRow } from './legend-row.js';
import { cardKeyLegend } from './tool-review-card.js';
import { FULL_DENY_LEGEND } from './tool-review-screen.js';
import { cardTitleRows, keyTone, reviewUnavailableText } from './tool-review-view.js';

/** How a key legend's stretches are coloured, by the role its builder gave them: the answers stand out, the words stay dim. */
describe('keyTone — a legend stretch, coloured by its role', () => {
  it('draws allow in green, deny in red, a stop in yellow and any other key in cyan, all bold', () => {
    expect(keyTone('ok', true)).toEqual({ color: 'green', bold: true });
    expect(keyTone('danger', true)).toEqual({ color: 'red', bold: true });
    expect(keyTone('warn', true)).toEqual({ color: 'yellow', bold: true });
    expect(keyTone('strong', true)).toEqual({ color: 'cyan', bold: true });
  });

  it('dims the words, and draws nothing at all with colour off', () => {
    expect(keyTone('dim', true)).toEqual({ dimColor: true });
    for (const role of ['ok', 'danger', 'warn', 'strong', 'dim'] as const)
      expect(keyTone(role, false), role).toEqual({});
  });

  it('follows the item, not the text: the keys of a real row are drawn in the role their legend gave them', () => {
    const colours = (row: LegendRow): string[] =>
      rowSegments(row)
        .filter((segment) => segment.role !== 'dim')
        .map((segment) => `${segment.text}=${String(keyTone(segment.role, true)['color'])}`);
    const [grants, refusals] = cardKeyLegend({
      inspected: true,
      cacheable: true,
      scope: 'file writes',
      command: true,
      remember: true,
    });
    expect(colours(grants)).toEqual(['[Ctrl+Y]=green', '[Ctrl+G]=green', '[Ctrl+O]=green']);
    expect(colours(refusals)).toEqual(['[Ctrl+N]=red', '[Ctrl+R]=cyan', '[v]=cyan', 'Esc=yellow']);
    expect(colours(FULL_DENY_LEGEND)).toEqual([
      '[Ctrl+N]=red',
      '[b]=cyan',
      '[Ctrl+C]=yellow',
      'Esc=cyan',
    ]);
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
