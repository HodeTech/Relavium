import '../force-color.js';

/**
 * The legend row of a popup that is drawn over the body ([ADR-0148](../../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §4). The chat's prompt block is five rows tall ([ADR-0146](../../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §4) and a 21-row popup is centred over a 23-row frame, so on a short terminal the popup covers the prompt and the thin rule, and the
 * dimmed backdrop shows their ends beside the popup's box, on the very row of the popup's legend. The legend is therefore read in the box's
 * own columns of the box's rows (the cells outside it are the body's, which `popup-box` and `backdrop-dim` hold to the frame the popup opened
 * over), and every way of drawing the legend wrong INSIDE the box still fails: squeezed against a list, cut, wrapped, drawn over by other text,
 * outside the box, or in a popup that is not drawn over the body.
 */
import { describe, expect, it } from 'vitest';

import { runCell, withSurface } from './cells.js';
import { checkLegendRow, type Observation, type PopupBox } from './properties.js';
import { observe } from './run-cell.js';
import type { SurfaceBase } from './registry.js';
import { CHAT_SURFACES } from './surfaces-chat.js';
import type { Variant } from './variants.js';

const ALT_80: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };
const ALT_80_COLOUR: Variant = { ...ALT_80, color: true };

const LEGEND = '↑/↓ scroll · [c] copy · Esc close';
/** The box of a popup at 80×24 (ADR-0148 §4: `min(columns − 2 × margin, 76)` wide, margin 6): columns 7–74, here five rows from row 3. */
const BOX: PopupBox = { placement: 'overlay', top: 2, left: 6, width: 68, height: 5, rows: [] };
const RULE = '──────';

/** One row of the frame: what the backdrop shows `left` of the box (its 6 columns), `inside` it (its 68), and `right` of it. */
const row = (left: string, inside: string, right: string): string =>
  `${left.padEnd(BOX.left)}${inside.padEnd(BOX.width)}${right}`;
const blank = row('', '', '');

/** A frame whose rows 3–7 (the box's rows) are `inBox`, padded with blank rows, under two blank rows and over one. */
const frameOf = (...inBox: string[]): Observation => ({
  variant: ALT_80,
  lines: [
    blank,
    blank,
    ...Array.from({ length: BOX.height }, (_, at) => inBox[at] ?? blank),
    blank,
  ],
  raw: '',
});
/** A frame of the given rows, from row 1. */
const framed = (...lines: string[]): Observation => ({ variant: ALT_80, lines, raw: '' });
const listRow = row('', ' /details  Inspect recent tool calls and their available', '');
const legendIn = (inside: string, left = '> repl', right = RULE): Observation =>
  frameOf(listRow, row(left, inside, right));

describe('the legend row of a popup drawn over the body is read in its box', () => {
  it('holds beside the backdrop: the prompt on one side, the thin rule on the other, and the legend alone between them', () => {
    const frame = legendIn(` ${LEGEND}`);
    expect(checkLegendRow(frame, LEGEND, BOX)).toEqual([]);
    expect(
      checkLegendRow(frame, LEGEND)[0]?.property,
      'read as a whole row, the same frame fails: the backdrop is on it',
    ).toBe('legend-row');
  });

  it('holds for any of the forms a surface names, indent and trailing space not counted', () => {
    const forms = ['[c] copy · Esc close', LEGEND];
    expect(checkLegendRow(legendIn(`   ${LEGEND}   `), forms, BOX)).toEqual([]);
    expect(checkLegendRow(legendIn(' [c] copy · Esc close'), forms, BOX)).toEqual([]);
  });

  it('reads the box’s own columns, no more and no fewer: a legend flush with either edge is whole, and the backdrop beside it is not part of it', () => {
    // flush left: the character just left of the box is the backdrop's, and the legend's first character is the box's first column
    expect(checkLegendRow(legendIn(LEGEND, '>>>>>>'), LEGEND, BOX)).toEqual([]);
    expect(checkLegendRow(legendIn(LEGEND), LEGEND, BOX)).toEqual([]);
    // flush right: the legend's last character is the box's last column, and the character just right of it is the backdrop's
    expect(
      checkLegendRow(legendIn(LEGEND.padStart(BOX.width), '> repl', '─'), LEGEND, BOX),
    ).toEqual([]);
    expect(
      checkLegendRow(legendIn(LEGEND.padStart(BOX.width), '> repl', 'x'), LEGEND, BOX),
    ).toEqual([]);
  });

  it('fails for a list row squeezed against the legend inside the box, before it and after it', () => {
    for (const inside of [
      ` /details  Inspect recent tool calls  ${LEGEND}`,
      ` ${LEGEND}  /details  Inspect recent tool calls`,
      ` ${LEGEND}start a fresh session.`,
    ]) {
      expect(checkLegendRow(legendIn(inside), LEGEND, BOX)[0]?.property).toBe('legend-row');
    }
  });

  it('fails for a legend that is cut, and for one the surface did not name', () => {
    expect(checkLegendRow(legendIn(' ↑/↓ scroll · [c] copy ·'), LEGEND, BOX)[0]?.property).toBe(
      'legend-row',
    );
    expect(checkLegendRow(legendIn(' [c] copy · Esc close'), LEGEND, BOX)[0]?.property).toBe(
      'legend-row',
    );
  });

  it('fails for a legend that is wrapped over two rows of the box', () => {
    const frame = frameOf(
      listRow,
      row('> repl', ' ↑/↓ scroll · [c] copy', RULE),
      row('', ' · Esc close', ''),
    );
    expect(checkLegendRow(frame, LEGEND, BOX)[0]?.property).toBe('legend-row');
  });

  it('fails for a legend that other text is drawn over inside the box (the prompt’s own words)', () => {
    expect(
      checkLegendRow(legendIn(' > repl scroll · [c] copy · Esc close'), LEGEND, BOX)[0]?.property,
    ).toBe('legend-row');
    expect(
      checkLegendRow(legendIn(` ${LEGEND.replace('copy', 'cop> ')}`), LEGEND, BOX)[0]?.property,
    ).toBe('legend-row');
  });

  it('fails for a legend that is on the frame but not on a row of the box: above its first row and below its last', () => {
    const body = Array.from({ length: BOX.height }, () => row('', ' body', ''));
    const above = framed(row('', ` ${LEGEND}`, ''), blank, ...body);
    const below = framed(blank, blank, ...body, row('', ` ${LEGEND}`, ''));
    expect(checkLegendRow(above, LEGEND)).toEqual([]);
    expect(checkLegendRow(above, LEGEND, BOX)).toHaveLength(1);
    expect(checkLegendRow(below, LEGEND)).toEqual([]);
    expect(checkLegendRow(below, LEGEND, BOX)).toHaveLength(1);
  });

  it('fails for a legend that starts left of the box (a box that is not where the popup is)', () => {
    const shifted = framed(blank, blank, `  ${LEGEND}`.padEnd(80), blank, blank, blank);
    expect(checkLegendRow(shifted, LEGEND, BOX)).toHaveLength(1);
    expect(checkLegendRow(shifted, LEGEND, { ...BOX, left: 0 })).toEqual([]);
  });

  it('names the box it read, so a reader can find the row', () => {
    const [violation] = checkLegendRow(frameOf(listRow), LEGEND, BOX);
    expect(violation?.message).toBe(
      'the legend row "↑/↓ scroll · [c] copy · Esc close" is not on a row of the popup\'s box by itself, whole (columns 7–74, rows 3–7)',
    );
  });

  it('reads a popup that replaces the live region, and a surface that is not a popup, as a whole row: the backdrop is not there', () => {
    const fragments = framed(row('> repl', ` ${LEGEND}`, RULE));
    expect(checkLegendRow(fragments, LEGEND, { ...BOX, placement: 'replace' })[0]?.property).toBe(
      'legend-row',
    );
    expect(checkLegendRow(fragments, LEGEND)[0]?.message).toBe(
      'the legend row "↑/↓ scroll · [c] copy · Esc close" is not on a row of the frame by itself, whole',
    );
    const whole = framed(`  ${LEGEND}`);
    expect(checkLegendRow(whole, LEGEND, { ...BOX, placement: 'replace' })).toEqual([]);
    expect(checkLegendRow(whole, LEGEND)).toEqual([]);
  });

  it('finds no legend in a frame with no rows', () => {
    expect(checkLegendRow(framed(), LEGEND, BOX)[0]?.property).toBe('legend-row');
  });
});

describe('through the cells of the chat the maintainers saw red: /help and /agent over a 23-row frame at 80×24', () => {
  const surface = (id: string) => {
    const found = CHAT_SURFACES.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`no surface ${id}`);
    return found;
  };
  const legendRows = (entry: SurfaceBase): string[] => {
    const named = entry.legendRow;
    return named === undefined ? [] : typeof named === 'string' ? [named] : [...named];
  };

  it.each([
    ['chat.report-help', ALT_80],
    ['chat.report-help', ALT_80_COLOUR],
    ['chat.report-agent', ALT_80],
    ['chat.report-agent', ALT_80_COLOUR],
    ['standalone-chat.report-help', ALT_80],
    ['standalone-chat.report-agent', ALT_80_COLOUR],
  ])(
    '%s (%j): the box covers the prompt block, the backdrop is on the legend row, and the legend is alone in the box',
    async (id, variant) => {
      const entry = surface(id);
      const { observation, box, violations } = await withSurface(entry, variant, {}, (mount) => {
        const result = observe(entry, mount);
        return {
          observation: result.observation,
          violations: result.violations,
          box: entry.popup?.(variant, mount.popupFrame?.(), false),
        };
      });
      expect(violations).toEqual([]);
      expect(box?.placement).toBe('overlay');
      if (box === undefined) throw new Error('no box');
      const named = legendRows(entry);
      const inBox = (line: string): string =>
        Array.from(line)
          .slice(box.left, box.left + box.width)
          .join('')
          .trim();
      const wholeRow = observation.lines.findIndex((line) => named.includes(line.trim()));
      const boxRow = observation.lines.findIndex((line) => named.includes(inBox(line)));
      expect(
        wholeRow,
        'no row is the legend and nothing else: the backdrop is beside the box on its row',
      ).toBe(-1);
      expect(boxRow, 'the legend is alone in the box on one of its rows').toBeGreaterThanOrEqual(
        box.top,
      );
      expect(boxRow).toBeLessThan(box.top + box.height);
      expect(
        checkLegendRow(observation, named),
        'read as a whole row the same frame fails: the refinement is what turns the cell green',
      ).toHaveLength(1);
      expect(checkLegendRow(observation, named, box)).toEqual([]);
    },
  );

  const tamperedProblems = async (
    id: string,
    tamper: (chunk: string) => string,
  ): Promise<string[]> => {
    const entry = surface(id);
    const result = await runCell(entry, ALT_80, { tamper });
    return result.violations.map((violation) => violation.property);
  };

  it('a legend that is cut by the terminal (its last words removed) still fails the cell', async () => {
    expect(await tamperedProblems('chat.report-help', (chunk) => chunk)).toEqual([]);
    expect(
      await tamperedProblems('chat.report-help', (chunk) =>
        chunk.replace('\u001b[1mEsc\u001b[22m close', ''),
      ),
    ).toContain('legend-row');
  });

  it('a legend with another row squeezed into it, inside the box, still fails the cell', async () => {
    expect(
      await tamperedProblems('chat.report-help', (chunk) =>
        chunk.replace('\u001b[22m scroll · ', '\u001b[22m scroll · /details tail · '),
      ),
    ).toContain('legend-row');
  });

  it('a legend that the prompt’s words are drawn over, inside the box, still fails the cell', async () => {
    expect(
      await tamperedProblems('chat.report-help', (chunk) =>
        chunk.replace('\u001b[1m↑/↓\u001b[22m scroll', '> repl scroll'),
      ),
    ).toContain('legend-row');
  });
});
