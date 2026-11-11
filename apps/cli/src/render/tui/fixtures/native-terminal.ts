import { Socket } from 'node:net';
import { clearLine, clearScreenDown, cursorTo, moveCursor } from 'node:readline';
import type { Direction } from 'node:tty';

/** In-memory native streams satisfy Ink's complete TTY types without assertions. */
export class NativeOutput extends Socket {
  isTTY = true;
  columns = 80;
  rows = 24;
  readonly chunks: string[] = [];

  constructor() {
    super({ readable: false, writable: true });
  }

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (typeof chunk === 'string') this.chunks.push(chunk);
    else if (Buffer.isBuffer(chunk)) this.chunks.push(chunk.toString('utf8'));
    else throw new TypeError('Unexpected native output chunk.');
    callback();
  }

  clearLine(direction: Direction, callback?: () => void): boolean {
    return clearLine(this, direction, callback);
  }
  clearScreenDown(callback?: () => void): boolean {
    return clearScreenDown(this, callback);
  }
  cursorTo(x: number, y?: number | (() => void), callback?: () => void): boolean {
    return typeof y === 'function'
      ? cursorTo(this, x, undefined, y)
      : cursorTo(this, x, y, callback);
  }
  moveCursor(x: number, y: number, callback?: () => void): boolean {
    return moveCursor(this, x, y, callback);
  }
  getColorDepth(): number {
    return 8;
  }
  hasColors(count?: number | object): boolean {
    return typeof count !== 'number' || count <= 256;
  }
  getWindowSize(): [number, number] {
    return [this.columns, this.rows];
  }

  resize(columns: number): void {
    this.columns = columns;
    this.emit('resize');
  }
}

export class NativeInput extends Socket {
  isTTY = true;
  isRaw = false;

  constructor() {
    super({ readable: true, writable: false });
  }

  override _read(): void {}

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}
