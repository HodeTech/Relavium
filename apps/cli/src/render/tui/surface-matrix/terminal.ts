import stringWidth from 'string-width';

import { OwnedTtyOutput } from '../../../test-support.js';

/**
 * The fake terminal of the surface matrix ([ADR-0145](../../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §10).
 *
 * `ink-testing-library` mounts Ink in **debug** mode: every frame is written whole, nothing is ever erased, and a frame as tall as the
 * terminal never makes Ink clear it. That cannot show the two things the matrix has to see: what the terminal is left showing after Ink's
 * erase-and-rewrite cycle, and the scrollback-clear sequence Ink writes when a frame fills the terminal. So the matrix mounts the real
 * `ink` `render()` the way `driveHome` does (interactive, not debug) over THIS stream, and reads two things back: the raw bytes, and the
 * screen a terminal would be showing, built by {@link ScreenEmulator} from those bytes.
 *
 * Not a test file (no `.test.` suffix), so the runner never collects it; apps/cli is outside the coverage floor and the file is unreachable
 * from the tsup entry, as `harness-util.ts` is.
 */

const ESC = String.fromCharCode(0x1b);

/**
 * What one cell of the screen was written with: the SGR state that was active when its character arrived. A colour is the SGR text that
 * set it (`31`, `38;5;196`, `38;2;1;2;3`), so two cells are the same colour exactly when the strings are equal; `undefined` is the
 * terminal's default colour.
 */
export interface CellStyle {
  readonly bold: boolean;
  readonly dim: boolean;
  readonly inverse: boolean;
  readonly underline: boolean;
  readonly fg: string | undefined;
  readonly bg: string | undefined;
}

/** What a cell nothing was written to carries: no attribute, the default colours. */
export const PLAIN_CELL_STYLE: CellStyle = Object.freeze({
  bold: false,
  dim: false,
  inverse: false,
  underline: false,
  fg: undefined,
  bg: undefined,
});

/** One cell of the screen: the character written to it and the style that was active when it was. */
export interface ScreenCell {
  readonly char: string;
  readonly style: CellStyle;
}

const styleKey = (style: CellStyle): string =>
  `${style.bold ? 'b' : ''}${style.dim ? 'd' : ''}${style.inverse ? 'i' : ''}${style.underline ? 'u' : ''}|${style.fg ?? ''}|${style.bg ?? ''}`;

/**
 * A line-oriented model of the part of a terminal that Ink's `log-update` drives: text, `\n`, erase-line, cursor up/down, cursor to a
 * column, and clear-terminal. Everything else (private modes such as the synchronized-output and alternate-screen toggles, cursor
 * hide/show, OSC strings) changes no cell and is skipped. The screen is the whole history of lines (a real terminal scrolls the
 * top of it into the scrollback); the matrix only mounts surfaces whose frame is shorter than the terminal, and a frame that is not
 * is exactly the failure it reports.
 *
 * **Styling.** SGR does not change the text rows ({@link ScreenEmulator.lines} is what it always was), but it is no longer dropped: every cell
 * keeps the {@link CellStyle} that was active when its character was written (bold, dim, inverse, underline, foreground and background,
 * as a terminal reads them: `22` ends bold AND dim, `0` ends everything), so a property can ask what a cell LOOKS like and not only what it
 * says ({@link ScreenEmulator.cells}). A cell the cursor skipped over is plain.
 *
 * **Wide characters.** A cell is one UTF-16 unit, exactly as before: a character the terminal draws two columns wide takes one cell here when
 * it is a single unit (an ideograph) and two when it is a surrogate pair (an emoji), so columns after an ideograph are one short. The
 * matrix's own glyphs are all one column, and a property that reads columns refuses a row it cannot read soundly ({@link cellsAreSound}).
 */
export class ScreenEmulator {
  #lines: string[] = [''];
  /** One style per UTF-16 unit of each line, in step with `#lines`. */
  #styles: CellStyle[][] = [[]];
  #row = 0;
  #col = 0;
  #current: CellStyle = PLAIN_CELL_STYLE;
  readonly #interned = new Map<string, CellStyle>([[styleKey(PLAIN_CELL_STYLE), PLAIN_CELL_STYLE]]);
  #screenClears = 0;
  #scrollbackClears = 0;

  /** How many times the visible screen was cleared (`ESC[2J`). */
  get screenClears(): number {
    return this.#screenClears;
  }

  /** How many times the scrollback was cleared (`ESC[3J`): the earlier output of the user's terminal, which the screen model does not keep. */
  get scrollbackClears(): number {
    return this.#scrollbackClears;
  }

  feed(chunk: string): void {
    let index = 0;
    while (index < chunk.length) {
      const char = chunk[index] ?? '';
      if (char === ESC) {
        index = this.#escape(chunk, index);
        continue;
      }
      if (char === '\n') {
        this.#row += 1;
        this.#col = 0;
        this.#ensureRow();
      } else if (char === '\r') {
        this.#col = 0;
      } else {
        this.#put(char);
      }
      index += 1;
    }
  }

  /** The visible lines, styling already absent, without the empty line the final `\n` leaves under the frame. */
  lines(): string[] {
    const lines = [...this.#lines];
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines.length === 1 && lines[0] === '' ? [] : lines;
  }

  /**
   * The visible rows as {@link ScreenEmulator.lines} returns them (the same rows, the same trimming), one {@link ScreenCell} per UTF-16 unit
   * of each: what is written there and how it was styled when it was.
   */
  cells(): ScreenCell[][] {
    return this.lines().map((line, row) =>
      Array.from(
        { length: line.length },
        (_unit, column): ScreenCell => ({
          char: line.charAt(column),
          style: this.#styles[row]?.[column] ?? PLAIN_CELL_STYLE,
        }),
      ),
    );
  }

  #escape(chunk: string, start: number): number {
    const next = chunk[start + 1];
    if (next === '[') {
      let end = start + 2;
      while (end < chunk.length && !/[@-~]/u.test(chunk[end] ?? '')) end += 1;
      this.#csi(chunk.slice(start + 2, end), chunk[end] ?? '');
      return end + 1;
    }
    if (next === ']') {
      // An OSC string runs to BEL or to ST (`ESC \`).
      let end = start + 2;
      while (end < chunk.length && chunk[end] !== '\u0007' && !chunk.startsWith(`${ESC}\\`, end))
        end += 1;
      return chunk[end] === '\u0007' ? end + 1 : end + 2;
    }
    return start + 2;
  }

  #csi(params: string, final: string): void {
    const count = Number.parseInt(params.replace(/^\?/u, ''), 10);
    const n = Number.isNaN(count) || count < 1 ? 1 : count;
    switch (final) {
      case 'K':
        // `2K` erases the whole line; `0K`/`K` erases from the cursor, which Ink does not use.
        if (params === '2') {
          this.#lines[this.#row] = '';
          this.#styles[this.#row] = [];
        } else {
          this.#lines[this.#row] = (this.#lines[this.#row] ?? '').slice(0, this.#col);
          this.#styles[this.#row] = (this.#styles[this.#row] ?? []).slice(0, this.#col);
        }
        return;
      case 'A':
        this.#row = Math.max(0, this.#row - n);
        return;
      case 'B':
        this.#row += n;
        this.#ensureRow();
        return;
      case 'G':
        this.#col = n - 1;
        return;
      case 'J':
        if (params === '2') {
          this.#screenClears += 1;
          this.#lines = [''];
          this.#styles = [[]];
          this.#row = 0;
          this.#col = 0;
        } else if (params === '3') {
          // The scrollback is not part of the model (the matrix reads the screen); only the fact that it was wiped is kept.
          this.#scrollbackClears += 1;
        }
        return;
      case 'H':
        if (params === '') {
          this.#row = 0;
          this.#col = 0;
        }
        return;
      case 'm':
        this.#sgr(params);
        return;
      default:
        // A private mode (`h`/`l`), and every other CSI the matrix does not need: no cell changes.
        return;
    }
  }

  /**
   * One SGR sequence, as a terminal reads it. Read: `0` (and an empty list), bold `1`, dim `2`, `22` (ends bold AND dim: one code closes
   * both intensities), underline `4`/`24`, inverse `7`/`27`, the foreground `30-37`, `38;5;n`, `38;2;r;g;b`, `39` and `90-97`, and the
   * background `40-47`, `48;…`, `49` and `100-107`. Every other code (italic, strike, link) is ignored: the matrix asks about none of them.
   */
  #sgr(params: string): void {
    const codes = params === '' ? ['0'] : params.split(/[;:]/u);
    let { bold, dim, inverse, underline, fg, bg } = this.#current;
    for (let at = 0; at < codes.length; at += 1) {
      const code = Number(codes[at] === '' ? '0' : codes[at]);
      if (code === 0) {
        ({ bold, dim, inverse, underline, fg, bg } = PLAIN_CELL_STYLE);
      } else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 22) {
        bold = false;
        dim = false;
      } else if (code === 4) underline = true;
      else if (code === 24) underline = false;
      else if (code === 7) inverse = true;
      else if (code === 27) inverse = false;
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = String(code);
      else if (code === 39) fg = undefined;
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) bg = String(code);
      else if (code === 49) bg = undefined;
      else if (code === 38 || code === 48) {
        // `5;n` is one more parameter, `2;r;g;b` is three more; anything else is not a colour this reads, and the rest of the list with it.
        const mode = codes[at + 1];
        const width = mode === '5' ? 2 : mode === '2' ? 4 : 0;
        if (width === 0) break;
        const colour = codes.slice(at, at + 1 + width).join(';');
        if (code === 38) fg = colour;
        else bg = colour;
        at += width;
      }
    }
    this.#current = this.#intern({ bold, dim, inverse, underline, fg, bg });
  }

  #intern(style: CellStyle): CellStyle {
    const key = styleKey(style);
    const known = this.#interned.get(key);
    if (known !== undefined) return known;
    const frozen = Object.freeze({ ...style });
    this.#interned.set(key, frozen);
    return frozen;
  }

  #ensureRow(): void {
    while (this.#lines.length <= this.#row) {
      this.#lines.push('');
      this.#styles.push([]);
    }
  }

  #put(char: string): void {
    this.#ensureRow();
    const line = this.#lines[this.#row] ?? '';
    const styles = this.#styles[this.#row] ?? [];
    this.#styles[this.#row] = styles;
    if (line.length === this.#col) {
      this.#lines[this.#row] = line + char;
      styles[this.#col] = this.#current;
      this.#col += 1;
      return;
    }
    const padded = line.length < this.#col ? line + ' '.repeat(this.#col - line.length) : line;
    this.#lines[this.#row] = padded.slice(0, this.#col) + char + padded.slice(this.#col + 1);
    // A cell the cursor skipped over is plain; the one written takes the style that is active now.
    for (let skipped = styles.length; skipped < this.#col; skipped += 1)
      styles[skipped] = PLAIN_CELL_STYLE;
    styles[this.#col] = this.#current;
    this.#col += 1;
  }
}

/**
 * Whether a column of `rows` is a column of the terminal: every cell is one column wide, and a surrogate pair (an emoji) is two cells for the
 * two columns the terminal draws it in. A row with an ideograph (one cell, two columns), a zero-width mark or a longer emoji sequence is read
 * wrong after that cell, so a property that reads columns refuses it instead of reading a wrong cell.
 */
export function cellsAreSound(rows: readonly (readonly ScreenCell[])[]): boolean {
  const isHigh = (char: string): boolean => char >= '\ud800' && char <= '\udbff';
  const isLow = (char: string): boolean => char >= '\udc00' && char <= '\udfff';
  return rows.every((row) => {
    for (let at = 0; at < row.length; at += 1) {
      const char = row[at]?.char ?? '';
      const next = row[at + 1]?.char ?? '';
      if (isHigh(char) && isLow(next)) {
        if (stringWidth(char + next) !== 2) return false;
        at += 1;
      } else if (stringWidth(char) !== 1) return false;
    }
    return true;
  });
}

/**
 * The terminal's output stream: the repository's own owned TTY double (a real `Socket` that says it is a TTY of a size, so it is a
 * `NodeJS.WriteStream` with no cast), with every byte kept and fed to the screen model.
 */
export class FakeStdout extends OwnedTtyOutput {
  readonly chunks: string[] = [];
  readonly screen = new ScreenEmulator();
  /** A test-only hook applied to every chunk before it is kept: the mutation tests use it to break a property on purpose. */
  readonly #tamper: ((chunk: string) => string) | undefined;

  constructor(columns: number, rows: number, tamper?: (chunk: string) => string) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.#tamper = tamper;
  }

  override _write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text =
      typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
    const kept = this.#tamper === undefined ? text : this.#tamper(text);
    this.chunks.push(kept);
    this.screen.feed(kept);
    super._write(kept, encoding, callback);
  }

  /** Every byte written so far, including the styling the screen drops. */
  raw(): string {
    return this.chunks.join('');
  }

  /** Change the size and tell Ink, as a terminal does. */
  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }
}
