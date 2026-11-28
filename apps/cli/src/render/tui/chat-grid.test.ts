import { describe, expect, it } from 'vitest';

import {
  chatGrid,
  GRID_MIN_CONTENT_COLUMNS,
  marginCell,
  MARGIN_WORDS,
  SUSPENDED_GRID,
  type MarginForm,
  type MarginRole,
} from './chat-grid.js';
import { homeMargin, homeRailWidth } from './home-layout.js';

const ROLES: readonly MarginRole[] = ['yourTurn', 'toolCall', 'modelSwitch', 'agent'];
const FORMS: readonly MarginForm[] = ['glyph', 'ascii', 'word'];

describe('the chat grid (MVP-11 unit 9): the numbers the plan’s frames carry', () => {
  it.each([
    [80, 6, 68, 74, 3],
    [90, 6, 78, 84, 3],
    [99, 6, 87, 93, 3],
    [100, 8, 84, 92, 5],
    [120, 8, 96, 112, 5],
    [200, 8, 96, 192, 5],
  ])(
    '%i columns: margin %i, content %i, text %i, the marker ends at column %i',
    (columns, margin, content, text, markerEnd) => {
      expect(chatGrid(columns)).toEqual({ columns, margin, content, text, markerEnd });
    },
  );

  it('is the Home’s grid wherever the Home draws one (the same margin and the same rail width)', () => {
    for (let columns = 40; columns <= 240; columns += 1) {
      const grid = chatGrid(columns);
      expect(grid.margin, `margin at ${columns}`).toBe(homeMargin(columns));
      expect(grid.content, `content at ${columns}`).toBe(homeRailWidth(columns));
    }
  });

  it('gives the margin up before the text its room: 0 at 17 columns and fewer, 1 at 18–19, 2 at 20–21, 4 at 24 (review round 1, C-8)', () => {
    expect(chatGrid(24).margin).toBe(4);
    expect(chatGrid(20).margin).toBe(2);
    expect(chatGrid(19).margin).toBe(1);
    expect(chatGrid(16).margin).toBe(0);
    expect(
      [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28].map((columns) => chatGrid(columns).margin),
    ).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6]);
    // the glyph needs a margin of 3 (two blank columns after it): it is drawn from 22 columns
    expect(marginCell('yourTurn', chatGrid(21), 'glyph').trim()).toBe('');
    expect(marginCell('yourTurn', chatGrid(22), 'glyph')).toBe('›  ');
    expect(chatGrid(10)).toMatchObject({ margin: 0, content: 10, text: 10 });
    expect(chatGrid(1)).toMatchObject({ margin: 0, content: 1, text: 1 });
    expect(GRID_MIN_CONTENT_COLUMNS).toBe(16);
  });

  it('is the suspended grid for a width that is not a number or is below 1', () => {
    for (const columns of [Number.NaN, Number.POSITIVE_INFINITY, 0, -4, 0.5]) {
      expect(chatGrid(columns), String(columns)).toBe(SUSPENDED_GRID);
    }
    expect(chatGrid(80.9).columns).toBe(80);
  });

  it('never draws a row wider than the terminal: margin + content fits every width', () => {
    for (let columns = 1; columns <= 300; columns += 1) {
      const grid = chatGrid(columns);
      expect(grid.margin + grid.content, `${columns}`).toBeLessThanOrEqual(columns);
      expect(grid.margin + grid.text, `${columns}`).toBeLessThanOrEqual(columns);
    }
  });
});

describe('the margin cell: composed from product constants, exactly the margin wide', () => {
  it('is exactly the margin’s columns for every role, form and width', () => {
    for (let columns = 1; columns <= 300; columns += 1) {
      const grid = chatGrid(columns);
      for (const role of [...ROLES, undefined])
        for (const form of FORMS) {
          const cell = marginCell(role, grid, form);
          expect([...cell].length, `${role} ${form} at ${columns}`).toBe(grid.margin);
        }
    }
  });

  it('draws your turn’s glyph in the frame’s column with two blank columns before the content (80 and 100 columns)', () => {
    expect(marginCell('yourTurn', chatGrid(80), 'glyph')).toBe('   ›  ');
    expect(marginCell('yourTurn', chatGrid(100), 'glyph')).toBe('     ›  ');
    expect(marginCell('toolCall', chatGrid(80), 'glyph')).toBe('   ▸  ');
    expect(marginCell('modelSwitch', chatGrid(80), 'glyph')).toBe('   ⇄  ');
  });

  it('draws the plain forms right-aligned to the same column, so the content never moves', () => {
    expect(marginCell('yourTurn', chatGrid(80), 'ascii')).toBe('   >  ');
    expect(marginCell('toolCall', chatGrid(80), 'ascii')).toBe('  ->  ');
    expect(marginCell('modelSwitch', chatGrid(80), 'ascii')).toBe(' <->  ');
  });

  it('writes the inline renderer’s words at column 0 with a blank column before the content', () => {
    expect(marginCell('yourTurn', chatGrid(80), 'word')).toBe('you   ');
    expect(marginCell('agent', chatGrid(80), 'word')).toBe('agent ');
    expect(marginCell('toolCall', chatGrid(80), 'word')).toBe('tool  ');
    // review round 1 (D-5, S-2): the model switch's word is `note` (its sentence starts with `model changed`), and a notice has the same word
    expect(marginCell('modelSwitch', chatGrid(100), 'word')).toBe('note    ');
    expect(marginCell('notice', chatGrid(80), 'word')).toBe('note  ');
    expect(MARGIN_WORDS).toEqual({
      yourTurn: 'you',
      toolCall: 'tool',
      modelSwitch: 'note',
      agent: 'agent',
      notice: 'note',
    });
  });

  it('draws nothing for a reply in the full-screen forms (a reply has no marker) and for no role', () => {
    for (const form of ['glyph', 'ascii'] as const)
      expect(marginCell('agent', chatGrid(80), form)).toBe(' '.repeat(6));
    for (const form of FORMS) expect(marginCell(undefined, chatGrid(80), form)).toBe(' '.repeat(6));
  });

  it('draws a mark only where it fits: a terminal without a marker column, or a word without room, stays blank', () => {
    expect(marginCell('yourTurn', chatGrid(20), 'glyph')).toBe('  ');
    expect(marginCell('yourTurn', chatGrid(16), 'glyph')).toBe('');
    expect(marginCell('agent', chatGrid(24), 'word')).toBe('    ');
    expect(marginCell('yourTurn', chatGrid(24), 'word')).toBe('you ');
  });

  it('is empty for a suspended grid', () => {
    expect(marginCell('yourTurn', SUSPENDED_GRID, 'glyph')).toBe('');
  });

  it('has no row text to draw: the only text a cell can hold is a glyph of the table or a word of the closed list', () => {
    const allowed = new Set([
      ' ',
      '›',
      '>',
      '▸',
      '-',
      '⇄',
      '<',
      ...Object.values(MARGIN_WORDS).join(''),
    ]);
    for (const columns of [80, 100, 120])
      for (const role of ROLES)
        for (const form of FORMS)
          for (const char of marginCell(role, chatGrid(columns), form))
            expect(allowed.has(char), `${role} ${form} ${columns}: ${char}`).toBe(true);
  });
});
