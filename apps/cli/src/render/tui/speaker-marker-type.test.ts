import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  chatGrid,
  marginCell,
  MARGIN_WORDS,
  type ChatGrid,
  type MarginForm,
  type MarginRole,
} from './chat-grid.js';
import { GLYPHS } from './glyphs.js';
import type { DisplayLine } from './viewport.js';

/**
 * The typing of the speaker marker on the grid (MVP-11 unit 9, plan §4 invariant 2; moved from unit 7's `marker`, a text typed as the two forms
 * of the glyph): a row's mark is its `margin`, a role of the CLOSED `MarginRole` set, so no string a model or a person wrote can be one, and the
 * margin cell is drawn by `marginCell`, which takes the role, the grid and the form and no text. `pnpm typecheck` is the check of the
 * `@ts-expect-error` below: a `DisplayLine` that accepted a glyph as its margin would make the directive unused, which fails the compile.
 */
describe('a row’s mark is a role of a closed set, never a text', () => {
  it('is typed as the closed role set, not a string', () => {
    expectTypeOf<DisplayLine['margin']>().toEqualTypeOf<MarginRole | undefined>();
    expectTypeOf<string>().not.toExtend<MarginRole>();
    expectTypeOf<MarginRole>().toEqualTypeOf<
      'yourTurn' | 'toolCall' | 'modelSwitch' | 'agent' | 'notice'
    >();
    // @ts-expect-error a glyph is not a role: no text, a model's or a person's, can be a row's mark
    const forged: DisplayLine = { text: 'x', style: 'user', margin: GLYPHS.yourTurn.glyph };
    expect(forged.text).toBe('x');
  });

  it('marginCell takes a role, the grid and a form, and no text', () => {
    expectTypeOf(marginCell).parameters.toEqualTypeOf<
      [MarginRole | undefined, ChatGrid, MarginForm]
    >();
    expectTypeOf(marginCell).returns.toEqualTypeOf<string>();
    expect(marginCell.length).toBe(3);
  });

  it('the role set is the five roles the words name, and each draws only the table’s mark or its word', () => {
    expect(Object.keys(MARGIN_WORDS).sort()).toEqual([
      'agent',
      'modelSwitch',
      'notice',
      'toolCall',
      'yourTurn',
    ]);
    const grid = chatGrid(80);
    expect(marginCell('yourTurn', grid, 'glyph').trim()).toBe(GLYPHS.yourTurn.glyph);
    expect(marginCell('yourTurn', grid, 'ascii').trim()).toBe(GLYPHS.yourTurn.ascii);
    expect(marginCell('toolCall', grid, 'glyph').trim()).toBe(GLYPHS.toolCall.glyph);
    expect(marginCell('modelSwitch', grid, 'ascii').trim()).toBe(GLYPHS.modelSwitch.ascii);
    expect(marginCell('agent', grid, 'glyph').trim()).toBe(''); // a reply has no glyph
    expect(marginCell('agent', grid, 'word').trim()).toBe('agent');
    expect(marginCell('notice', grid, 'glyph').trim()).toBe(''); // a notice has no glyph either
    expect(marginCell('notice', grid, 'word').trim()).toBe('note');
  });
});
