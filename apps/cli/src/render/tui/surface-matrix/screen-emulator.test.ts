import { describe, expect, it } from 'vitest';

import { cellsAreSound, PLAIN_CELL_STYLE, ScreenEmulator, type CellStyle } from './terminal.js';

/**
 * The fake terminal's cell attributes ([ADR-0148](../../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §4): the proof of the dimmed backdrop reads what each cell was DRAWN with, so the emulator that reads it is tested on its own, code by code,
 * against the SGR a terminal reads. Each case writes escapes the way ink writes them and asks one cell. The text rows are unchanged by all of
 * it (`matrix-self-test.test.tsx` holds that half).
 */

const ESC = String.fromCharCode(0x1b);
const sgr = (params: string): string => `${ESC}[${params}m`;

/** The style of the cell at `column` of the first row of what `feed` wrote. */
function styleAt(feed: string, column: number, row = 0): CellStyle {
  const screen = new ScreenEmulator();
  screen.feed(feed);
  const cell = screen.cells()[row]?.[column];
  if (cell === undefined) throw new Error(`no cell at ${String(row)}:${String(column)}`);
  return cell.style;
}

describe('the fake terminal keeps what each cell was written with', () => {
  it('a plain cell has no attribute and the default colours', () => {
    expect(styleAt('a', 0)).toEqual(PLAIN_CELL_STYLE);
  });

  it.each([
    ['bold', '1', 'bold'],
    ['dim', '2', 'dim'],
    ['underline', '4', 'underline'],
    ['inverse', '7', 'inverse'],
  ] as const)('%s is set by SGR %s and by nothing before it', (_name, code, field) => {
    expect(styleAt(`a${sgr(code)}b`, 0)[field]).toBe(false);
    expect(styleAt(`a${sgr(code)}b`, 1)[field]).toBe(true);
  });

  it.each([
    ['underline', '4', '24', 'underline'],
    ['inverse', '7', '27', 'inverse'],
  ] as const)('%s ends at SGR %s and the cell after it is not %s', (_name, open, close, field) => {
    const feed = `${sgr(open)}a${sgr(close)}b`;
    expect(styleAt(feed, 0)[field]).toBe(true);
    expect(styleAt(feed, 1)[field]).toBe(false);
  });

  it('SGR 22 ends bold AND dim, as a terminal reads it, and nothing else', () => {
    const feed = `${sgr('1')}${sgr('2')}${sgr('7')}${sgr('4')}a${sgr('22')}b`;
    const after = styleAt(feed, 1);
    expect(after.bold).toBe(false);
    expect(after.dim).toBe(false);
    expect(after.inverse).toBe(true);
    expect(after.underline).toBe(true);
  });

  it('SGR 0 and an empty list end everything, colours included', () => {
    for (const reset of [sgr('0'), `${ESC}[m`]) {
      const feed = `${sgr('1;2;4;7;31;42')}a${reset}b`;
      expect(styleAt(feed, 0)).toMatchObject({
        bold: true,
        dim: true,
        inverse: true,
        underline: true,
        fg: '31',
        bg: '42',
      });
      expect(styleAt(feed, 1)).toEqual(PLAIN_CELL_STYLE);
    }
  });

  it('a list sets several attributes at once, in order', () => {
    expect(styleAt(`${sgr('1;2;7')}a`, 0)).toMatchObject({ bold: true, dim: true, inverse: true });
  });

  it.each([
    ['a basic foreground', '31', '31'],
    ['a bright foreground', '92', '92'],
    ['a 256-colour foreground', '38;5;196', '38;5;196'],
    ['a truecolour foreground', '38;2;1;2;3', '38;2;1;2;3'],
  ])('%s is the foreground of the cells after it, and 39 ends it', (_name, params, fg) => {
    expect(styleAt(`${sgr(params)}a${sgr('39')}b`, 0).fg).toBe(fg);
    expect(styleAt(`${sgr(params)}a${sgr('39')}b`, 1).fg).toBeUndefined();
  });

  it.each([
    ['a basic background', '44', '44'],
    ['a bright background', '103', '103'],
    ['a 256-colour background', '48;5;17', '48;5;17'],
    ['a truecolour background', '48;2;9;8;7', '48;2;9;8;7'],
  ])('%s is the background of the cells after it, and 49 ends it', (_name, params, bg) => {
    expect(styleAt(`${sgr(params)}a${sgr('49')}b`, 0).bg).toBe(bg);
    expect(styleAt(`${sgr(params)}a${sgr('49')}b`, 1).bg).toBeUndefined();
  });

  it('an extended colour consumes its own parameters and not the ones after it', () => {
    // `38;5;196` then bold: the 196 is the colour's, the 1 is bold.
    expect(styleAt(`${sgr('38;5;196;1')}a`, 0)).toMatchObject({ fg: '38;5;196', bold: true });
    expect(styleAt(`${sgr('38;2;1;2;3;2')}a`, 0)).toMatchObject({ fg: '38;2;1;2;3', dim: true });
  });

  it('a code it does not read (italic, strike) changes no attribute it keeps', () => {
    expect(styleAt(`${sgr('3;9')}a`, 0)).toEqual(PLAIN_CELL_STYLE);
  });

  it('a style belongs to the cell it was active for: overwriting a cell with another style replaces it', () => {
    const screen = new ScreenEmulator();
    screen.feed(`${sgr('2')}old${sgr('22')}\r`);
    screen.feed('new');
    const cells = screen.cells()[0] ?? [];
    expect(cells.map((cell) => cell.char).join('')).toBe('new');
    expect(cells.every((cell) => !cell.style.dim)).toBe(true);
    screen.feed(`\r${sgr('2')}N`);
    expect(screen.cells()[0]?.[0]?.style.dim).toBe(true);
    expect(screen.cells()[0]?.[1]?.style.dim).toBe(false);
  });

  it('a cell the cursor skipped over is plain, and one written after it keeps its own style', () => {
    const screen = new ScreenEmulator();
    screen.feed(`${sgr('2')}${ESC}[5Gx`);
    const cells = screen.cells()[0] ?? [];
    expect(cells.map((cell) => cell.char).join('')).toBe('    x');
    expect(cells.slice(0, 4).every((cell) => !cell.style.dim)).toBe(true);
    expect(cells[4]?.style.dim).toBe(true);
  });

  it('erasing the line takes its styles with it: a cell the cursor then skips over is plain, not the one that was erased', () => {
    const screen = new ScreenEmulator();
    screen.feed(`${sgr('2')}dimdimdim${sgr('22')}\n${ESC}[1A${ESC}[2K${ESC}[G`);
    screen.feed('plain');
    expect(screen.cells()[0]?.every((cell) => !cell.style.dim)).toBe(true);
    const skipped = new ScreenEmulator();
    skipped.feed(`${sgr('2')}dimdimdim${sgr('22')}\n${ESC}[1A${ESC}[2K${ESC}[7Gx`);
    const cells = skipped.cells()[0] ?? [];
    expect(cells.map((cell) => cell.char).join('')).toBe('      x');
    expect(cells.every((cell) => !cell.style.dim)).toBe(true);
  });

  it('a clear-terminal takes every row, and the next frame starts plain', () => {
    const screen = new ScreenEmulator();
    screen.feed(`${sgr('1')}${ESC}[2J${ESC}[H`);
    screen.feed('x');
    expect(screen.cells()).toHaveLength(1);
    expect(screen.cells()[0]?.[0]?.style.bold).toBe(true);
    screen.feed(`\n${sgr('22')}y\n${ESC}[2J${ESC}[H${ESC}[4Gz`);
    expect(screen.cells().map((row) => row.map((cell) => cell.char).join(''))).toEqual(['   z']);
    expect(
      screen
        .cells()[0]
        ?.slice(0, 3)
        .every((cell) => !cell.style.bold),
    ).toBe(true);
  });

  it('an erase from the cursor takes the erased cells’ styles with it: a cell skipped over after it is plain', () => {
    const screen = new ScreenEmulator();
    screen.feed(`${sgr('1')}abcd${sgr('22')}${ESC}[3G${ESC}[K`);
    const kept = screen.cells()[0] ?? [];
    expect(kept.map((cell) => cell.char).join('')).toBe('ab');
    expect(kept.every((cell) => cell.style.bold)).toBe(true);
    screen.feed(`${ESC}[6Gx`);
    const after = screen.cells()[0] ?? [];
    expect(after.map((cell) => cell.char).join('')).toBe('ab   x');
    expect(after.slice(2, 5).every((cell) => !cell.style.bold)).toBe(true);
    expect(after.slice(0, 2).every((cell) => cell.style.bold)).toBe(true);
  });

  it('the cells are the lines: the same rows, the same trimming, one cell per UTF-16 unit', () => {
    const screen = new ScreenEmulator();
    screen.feed(`${sgr('2')}one${sgr('22')}\ntwo\n\n`);
    expect(screen.cells().map((row) => row.map((cell) => cell.char).join(''))).toEqual(
      screen.lines(),
    );
    const emoji = new ScreenEmulator();
    emoji.feed('a📎b');
    expect(emoji.cells()[0]).toHaveLength(emoji.lines()[0]?.length ?? -1);
  });

  it('styling does not change the text rows (the half of this the matrix relied on before)', () => {
    const screen = new ScreenEmulator();
    screen.feed(`${sgr('1')}${sgr('31')}bold red${sgr('39')}${sgr('22')}\nplain\n`);
    expect(screen.lines()).toEqual(['bold red', 'plain']);
  });
});

describe('a column of the emulator is a column of the terminal only when every cell is one column wide', () => {
  const rowsOf = (text: string) => {
    const screen = new ScreenEmulator();
    screen.feed(text);
    return screen.cells();
  };

  it('holds for ASCII, the matrix’s own glyphs and an emoji (two units, two columns)', () => {
    expect(cellsAreSound(rowsOf('abc ›✓⚠ ─│'))).toBe(true);
    expect(cellsAreSound(rowsOf('a📎b'))).toBe(true);
  });

  it('fails for an ideograph (one unit, two columns) and for a zero-width mark', () => {
    expect(cellsAreSound(rowsOf('a日b'))).toBe(false);
    expect(cellsAreSound(rowsOf('é'))).toBe(false);
  });
});
