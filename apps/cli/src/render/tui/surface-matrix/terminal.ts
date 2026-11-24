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
 * A line-oriented model of the part of a terminal that Ink's `log-update` drives: text, `\n`, erase-line, cursor up/down, cursor to a
 * column, and clear-terminal. Everything else (SGR styling, private modes such as the synchronized-output and alternate-screen toggles,
 * cursor hide/show, OSC strings) changes no cell and is skipped. The screen is the whole history of lines (a real terminal scrolls the
 * top of it into the scrollback); the matrix only mounts surfaces whose frame is shorter than the terminal, and a frame that is not
 * is exactly the failure it reports.
 */
export class ScreenEmulator {
  #lines: string[] = [''];
  #row = 0;
  #col = 0;
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
        if (params === '2') this.#lines[this.#row] = '';
        else this.#lines[this.#row] = (this.#lines[this.#row] ?? '').slice(0, this.#col);
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
      default:
        // SGR (`m`), a private mode (`h`/`l`), and every other CSI the matrix does not need: no cell changes.
        return;
    }
  }

  #ensureRow(): void {
    while (this.#lines.length <= this.#row) this.#lines.push('');
  }

  #put(char: string): void {
    this.#ensureRow();
    const line = this.#lines[this.#row] ?? '';
    if (line.length === this.#col) {
      this.#lines[this.#row] = line + char;
      this.#col += 1;
      return;
    }
    const padded = line.length < this.#col ? line + ' '.repeat(this.#col - line.length) : line;
    this.#lines[this.#row] = padded.slice(0, this.#col) + char + padded.slice(this.#col + 1);
    this.#col += 1;
  }
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
