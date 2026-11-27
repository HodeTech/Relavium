import './force-color.js';

import { Box } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  chatGrid,
  marginCell,
  MARGIN_WORDS,
  type MarginForm,
  type MarginRole,
} from './chat-grid.js';
import { MarginRow, marginFormFor } from './margin-row.js';
import { Text } from './text.js';
import { displayWidth } from './viewport.js';

/**
 * `MarginRow` (MVP-11 unit 9, the chat's live region and the docked turn): ONE row of the grid with a margin: the margin cell the host draws from the
 * closed set of roles ({@link marginCell}, which takes no text) and the content column beside it, exactly as wide as the grid says. What a person or a
 * model wrote is the content; it can be as long as it likes and begin with whatever it likes, and it never reaches the margin.
 */
afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
const SWITCH = String.fromCodePoint(0x21c4);
const CHEVRON = String.fromCodePoint(0x203a);
const TRIANGLE = String.fromCodePoint(0x25b8);

/** The rows Ink draws for `children` in a `columns`-wide terminal, escape sequences stripped. */
function rowsOf(node: ReactElement, columns: number): string[] {
  const ui = render(<Box width={columns}>{node}</Box>);
  const out = (ui.lastFrame() ?? '').split('\n');
  ui.unmount();
  return out.map((row) => row.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'gu'), ''));
}

describe('MarginRow draws the margin cell and the content column, and nothing else', () => {
  it.each([80, 100, 120])(
    'at %i columns: the toolCall glyph ends at the marker column and the words start at the content column',
    (columns) => {
      const grid = chatGrid(columns);
      const [row] = rowsOf(
        <MarginRow role="toolCall" grid={grid} form="glyph">
          <Text>{'read_file ok'}</Text>
        </MarginRow>,
        columns,
      );
      expect(row).toBe(`${marginCell('toolCall', grid, 'glyph')}read_file ok`.trimEnd());
      expect(row?.indexOf(TRIANGLE)).toBe(grid.markerEnd);
      expect(row?.slice(grid.margin)).toBe('read_file ok');
    },
  );

  it.each<MarginForm>(['glyph', 'ascii', 'word'])(
    'draws the %s form of every role as marginCell says, and no role draws beyond the margin',
    (form) => {
      const grid = chatGrid(80);
      for (const role of Object.keys(MARGIN_WORDS) as MarginRole[]) {
        const [row] = rowsOf(
          <MarginRow role={role} grid={grid} form={form}>
            <Text>{'x'}</Text>
          </MarginRow>,
          80,
        );
        expect(row, `${role} ${form}`).toBe(`${marginCell(role, grid, form)}x`);
        expect(displayWidth(marginCell(role, grid, form)), `${role} ${form}`).toBe(grid.margin);
      }
    },
  );

  it('draws a blank margin for no role', () => {
    const grid = chatGrid(80);
    const [row] = rowsOf(
      <MarginRow role={undefined} grid={grid} form="glyph">
        <Text>{'hello'}</Text>
      </MarginRow>,
      80,
    );
    expect(row).toBe(`${' '.repeat(grid.margin)}hello`);
  });

  it('keeps a content that begins with a host glyph in the content column: nothing of it is in the margin', () => {
    const grid = chatGrid(80);
    for (const hostile of [
      `${CHEVRON} you`,
      `${TRIANGLE} tool`,
      `${SWITCH} model`,
      '> agent',
      'you agent tool model',
    ]) {
      const [row] = rowsOf(
        <MarginRow role={undefined} grid={grid} form="glyph">
          <Text>{hostile}</Text>
        </MarginRow>,
        80,
      );
      expect(row?.slice(0, grid.margin), hostile).toBe(' '.repeat(grid.margin));
      expect(row?.slice(grid.margin), hostile).toBe(hostile);
    }
  });

  it('wraps a long content inside the content column and hangs it: the continuation rows have a blank margin', () => {
    const grid = chatGrid(80);
    const words = Array.from({ length: 40 }, (_unused, index) => `w${String(index)}`).join(' ');
    const rows = rowsOf(
      <MarginRow role="toolCall" grid={grid} form="glyph">
        <Text>{words}</Text>
      </MarginRow>,
      80,
    );
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]?.indexOf(TRIANGLE)).toBe(grid.markerEnd);
    for (const [index, row] of rows.entries()) {
      expect(displayWidth(row), `row ${String(index)}`).toBeLessThanOrEqual(
        grid.margin + grid.content,
      );
      if (index > 0)
        expect(row.slice(0, grid.margin), `row ${String(index)}`).toBe(' '.repeat(grid.margin));
    }
  });

  it('is the content cell alone on a terminal too narrow to give a margin', () => {
    const grid = chatGrid(10);
    expect(grid.margin).toBe(0);
    const [row] = rowsOf(
      <MarginRow role="toolCall" grid={grid} form="glyph">
        <Text>{'tool'}</Text>
      </MarginRow>,
      10,
    );
    expect(row).toBe('tool');
  });
});

describe('marginFormFor: the form a renderer draws its margin in', () => {
  it('is the glyph full-screen with colour, its ASCII form without, and the role word inline whatever the colour', () => {
    expect(marginFormFor(true, true)).toBe('glyph');
    expect(marginFormFor(true, false)).toBe('ascii');
    expect(marginFormFor(false, true)).toBe('word');
    expect(marginFormFor(false, false)).toBe('word');
  });
});
