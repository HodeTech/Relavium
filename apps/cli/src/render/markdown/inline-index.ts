import { findOpaqueTargets, isInvalidLinkTargetCharacter } from './opaque-targets.js';
import { isWordAt, isWordBefore } from './unicode-word.js';

/** UTF-16 indexed queries used by the canonical inline interpreter. */
export interface InlineSourceIndex {
  readonly length: number;
  charAt(index: number): string;
  slice(start: number, end: number): string;
  startsWith(token: string, index: number): boolean;
  escaped(index: number): boolean;
  intraword(index: number): boolean;
  opaque(index: number): boolean;
  opaqueInterior(index: number): boolean;
  opaqueCode(index: number): boolean;
  next(token: string, start: number, end: number): number;
  tickClose(start: number, end: number): number;
  parenClose(open: number, end: number): number;
  validLinkTarget(start: number, end: number): boolean;
  runEnd(start: number, character: string, end: number): number;
  plainEnd(start: number, end: number): number;
  hasInlineSyntax(start: number, end: number): boolean;
  singleCount(marker: string, start: number, end: number): number;
}

/** Complete-source index; every table is built at most once per input. */
export class StaticInlineIndex implements InlineSourceIndex {
  readonly length: number;
  private readonly escapes: Uint8Array;
  private readonly words: Uint8Array;
  private readonly opaqueMask: Uint8Array;
  private readonly counts = new Map<string, Int32Array>();
  private readonly nextTables = new Map<string, Int32Array>();
  private readonly ticks = new Map<number, number>();
  private readonly parens: Int32Array;
  private readonly invalidTargetCounts: Uint32Array;
  private readonly runEnds = new Map<string, Int32Array>();
  private readonly source: string;
  private plainEnds: Int32Array | undefined;

  constructor(source: string) {
    this.source = source;
    this.length = source.length;
    this.invalidTargetCounts = new Uint32Array(source.length + 1);
    for (let at = 0; at < source.length; at++)
      this.invalidTargetCounts[at + 1] =
        (this.invalidTargetCounts[at] ?? 0) +
        (isInvalidLinkTargetCharacter(source[at] ?? '') ? 1 : 0);
    this.escapes = new Uint8Array(source.length);
    for (let at = 0; at < source.length; at++) {
      if (source[at] === '\\' && at + 1 < source.length) {
        this.escapes[at + 1] = 1;
        at++;
      }
    }
    this.parens = new Int32Array(source.length);
    this.parens.fill(-1);
    const openParens: number[] = [];
    for (let at = 0; at < source.length; at++) {
      if (this.escapes[at]) continue;
      if (source[at] === '(') openParens.push(at);
      else if (source[at] === ')') {
        const open = openParens.pop();
        if (open !== undefined) this.parens[open] = at;
      }
    }
    this.words = new Uint8Array(source.length);
    for (let at = 0; at < source.length; ) {
      if (source[at] !== '_' || this.escapes[at]) {
        at++;
        continue;
      }
      const start = at;
      while (source[at] === '_' && !this.escapes[at]) at++;
      if (isWordBefore(source, start) && isWordAt(source, at)) this.words.fill(1, start, at);
    }
    this.opaqueMask = new Uint8Array(source.length);
    for (const range of findOpaqueTargets(source)) {
      this.opaqueMask.fill(range.bare ? 3 : 1, range.start, range.end);
      this.opaqueMask[range.start] = range.bare ? 4 : 2;
    }
    for (const marker of ['*', '_']) {
      const counts = new Int32Array(source.length + 1);
      for (let at = 0; at < source.length; at++) {
        const single =
          source[at] === marker &&
          source[at - 1] !== marker &&
          source[at + 1] !== marker &&
          !this.escapes[at] &&
          !this.opaqueMask[at] &&
          !this.words[at];
        counts[at + 1] = (counts[at] ?? 0) + (single ? 1 : 0);
      }
      this.counts.set(marker, counts);
    }
    const latest = new Map<number, number>();
    for (let at = source.length - 1; at >= 0; ) {
      if (source[at] !== '`' || this.escapes[at]) {
        at--;
        continue;
      }
      const end = at + 1;
      while (at >= 0 && source[at] === '`' && !this.escapes[at]) at--;
      const start = at + 1;
      const count = end - start;
      this.ticks.set(start, latest.get(count) ?? -1);
      latest.set(count, start);
    }
  }
  charAt(index: number): string {
    return this.source[index] ?? '';
  }
  slice(start: number, end: number): string {
    return this.source.slice(start, end);
  }
  startsWith(token: string, index: number): boolean {
    return this.source.startsWith(token, index);
  }
  escaped(index: number): boolean {
    return Boolean(this.escapes[index]);
  }
  opaque(index: number): boolean {
    return Boolean(this.opaqueMask[index]);
  }
  opaqueInterior(index: number): boolean {
    return this.opaqueMask[index] === 1 || this.opaqueMask[index] === 3;
  }
  opaqueCode(index: number): boolean {
    return this.opaqueMask[index] === 1 || this.opaqueMask[index] === 2;
  }
  intraword(index: number): boolean {
    return Boolean(this.words[index]);
  }
  parenClose(open: number, end: number): number {
    const close = this.parens[open] ?? -1;
    return close >= 0 && close < end ? close : -1;
  }
  validLinkTarget(start: number, end: number): boolean {
    return start < end && this.invalidTargetCounts[start] === this.invalidTargetCounts[end];
  }
  tickClose(start: number, end: number): number {
    const close = this.ticks.get(start) ?? -1;
    const length = this.runEnd(start, '`', end) - start;
    return close >= 0 && close + length <= end ? close : -1;
  }
  plainEnd(start: number, end: number): number {
    if (!this.plainEnds) {
      const table = new Int32Array(this.length + 1);
      let next = this.length;
      table[this.length] = next;
      for (let at = this.length - 1; at >= 0; at--) {
        if ('\\\n`[!<*_~'.includes(this.source[at] ?? '')) next = at;
        table[at] = next;
      }
      this.plainEnds = table;
    }
    return Math.min(this.plainEnds[start] ?? start, end);
  }
  hasInlineSyntax(start: number, end: number): boolean {
    return this.plainEnd(start, end) < end;
  }
  runEnd(start: number, character: string, end: number): number {
    let table = this.runEnds.get(character);
    if (!table) {
      table = new Int32Array(this.length + 1);
      let runEnd = this.length;
      for (let at = this.length - 1; at >= 0; at--) {
        if (this.source[at] !== character) runEnd = at;
        table[at] = runEnd;
      }
      this.runEnds.set(character, table);
    }
    return Math.min(table[start] ?? start, end);
  }
  singleCount(marker: string, start: number, end: number): number {
    const counts = this.counts.get(marker);
    return (counts?.[end] ?? 0) - (counts?.[start] ?? 0);
  }
  next(token: string, start: number, end: number): number {
    let table = this.nextTables.get(token);
    if (!table) {
      table = new Int32Array(this.length + 1);
      let found = -1;
      for (let at = this.length; at >= 0; at--) {
        if (!this.escapes[at] && this.source.startsWith(token, at)) {
          const delimiter = token[0] === '*' || token[0] === '_' || token[0] === '~';
          if ((!delimiter || !this.opaqueMask[at]) && (!token.includes('_') || !this.words[at]))
            found = at;
        }
        table[at] = found;
      }
      this.nextTables.set(token, table);
    }
    const found = table[start] ?? -1;
    return found >= 0 && found + token.length <= end ? found : -1;
  }
}
