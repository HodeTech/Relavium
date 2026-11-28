import { describe, expect, it } from 'vitest';

import { chatGrid } from './chat-grid.js';
import { transcriptDocument, transcriptRows } from './chat-projection.js';
import type { TranscriptEntry } from './session-view-model.js';
import { wrapWords } from './viewport.js';

/**
 * The hanging wrap starts each wrapped row at its text (MVP-11 unit 9, review round 1, D-2, C-1, O-3): when a word ended exactly at the content
 * column's last column, the space the line broke at stayed at the START of the next row, so about one hanging row in six stood a column right
 * of the others. The space is dropped where the wrap created the row, in the projection (`hangingRows`) and in the markdown layout's prose
 * blocks (paragraph, list item, quotation, heading); a source indent, a code block and the documents keep every space.
 */

const SEGMENTS = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'zeta',
  'eta',
  'theta',
  'iota',
  'kappa',
  'lambda',
  'mu',
  'nu',
  'xi',
  'omicron',
  'pi',
  'rho',
  'sigma',
  'tau',
  'upsilon',
];

/** A deterministic prose paragraph of `words` words (mulberry32), so a word ends at the last column at many widths. */
function prose(seed: number, words: number): string {
  let state = seed;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from(
    { length: words },
    () => SEGMENTS[Math.floor(next() * SEGMENTS.length)] ?? 'x',
  ).join(' ');
}

describe('a word that ends at the last column', () => {
  it.each([true, false])(
    'the next row starts at the next word, not at the space (colour %s)',
    (color) => {
      const grid = chatGrid(80);
      for (const role of ['assistant', 'user', 'notice'] as const) {
        const entry: TranscriptEntry = { role, text: `${'x'.repeat(grid.content)} word after` };
        const rows = transcriptRows([entry], grid, color).map((row) => row.text);
        expect(rows, role).toEqual(['x'.repeat(grid.content), 'word after']);
      }
    },
  );

  it('the same where the line is not ASCII (the grapheme path of the wrap)', () => {
    const grid = chatGrid(80);
    for (const color of [true, false]) {
      const rows = transcriptRows(
        [{ role: 'assistant', text: `${'中'.repeat(grid.content / 2)} 中文 after` }],
        grid,
        color,
      ).map((row) => row.text);
      expect(rows, String(color)).toEqual(['中'.repeat(grid.content / 2), '中文 after']);
    }
  });

  it('the documents keep the space', () => {
    expect(transcriptDocument([{ role: 'assistant', text: `${'x'.repeat(68)} word after` }])).toBe(
      `${'x'.repeat(68)} word after`,
    );
  });

  it('`wrapWords` keeps its whitespace-retaining contract unless asked (selection and `viewport.test.ts`)', () => {
    expect(wrapWords('xxxx word', 4)).toEqual(['xxxx', ' ', 'word']);
    expect(wrapWords('xxxx word', 4, true)).toEqual(['xxxx', 'word']);
    expect(wrapWords('  indented line', 40, true)).toEqual(['  indented line']);
  });
});

describe('property: prose replies at every width from 20 to 120', () => {
  it.each([true, false])('no continuation row starts with a space (colour %s)', (color) => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => prose(0x51f2 + index, 60));
    for (let columns = 20; columns <= 120; columns += 1) {
      const grid = chatGrid(columns);
      for (const [index, paragraph] of paragraphs.entries()) {
        const rows = transcriptRows([{ role: 'assistant', text: paragraph }], grid, color);
        expect(rows.length, `${columns} ${index}`).toBeGreaterThan(1);
        const stray = rows.slice(1).filter((row) => row.text.startsWith(' '));
        if (stray.length > 0)
          expect.fail(`${columns} ${index}: ${JSON.stringify(stray.map((row) => row.text))}`);
      }
    }
  });

  it('a quotation’s continuations stand right after the gutter, and a list item’s under its text', () => {
    for (let columns = 20; columns <= 120; columns += 7) {
      const grid = chatGrid(columns);
      const quote = transcriptRows([{ role: 'assistant', text: `> ${prose(7, 50)}` }], grid, true);
      for (const row of quote)
        expect(/^│ \S/u.test(row.text), `${columns} ${JSON.stringify(row.text)}`).toBe(true);
      const list = transcriptRows([{ role: 'assistant', text: `- ${prose(9, 50)}` }], grid, true);
      expect(list[0]?.text.startsWith('• ') || list[0]?.text.startsWith('- ')).toBe(true);
      for (const row of list.slice(1))
        expect(/^ {2}\S/u.test(row.text), `${columns} ${JSON.stringify(row.text)}`).toBe(true);
    }
  });

  it('a code block keeps its spaces where the wrap breaks it', () => {
    const rows = transcriptRows(
      [{ role: 'assistant', text: `\`\`\`\n${'c'.repeat(64)}    indented tail\n\`\`\`` }],
      chatGrid(80),
      true,
    ).map((row) => row.text);
    // the four spaces split at the wrap: two end the first row, two begin the next, after the gutter (a code block is not prose)
    expect(rows).toEqual([`│ ${'c'.repeat(64)}  `, '│   indented tail']);
  });
});
