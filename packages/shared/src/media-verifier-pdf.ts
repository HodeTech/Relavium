import { MediaInspectionMemory } from './media-inspection-memory.js';
import { mediaByteLength } from './media-byte-view.js';
import { fail } from './media-verifier-reader.js';
/** PDF 32000-1 classic xref profile; one bounded rolling tail, no whole-body string. */
export class PdfVerifier {
  readonly #tail: Uint8Array;
  readonly #header: Uint8Array;
  constructor(memory = new MediaInspectionMemory()) {
    this.#tail = memory.allocate(49152);
    this.#header = memory.allocate(9);
  }
  #length = 0;
  push(chunk: Uint8Array): void {
    const length = mediaByteLength(chunk);
    for (let i = 0; i < length; i++) {
      const b = chunk[i] ?? fail();
      if (this.#length < 9) this.#header[this.#length] = b;
      this.#tail[this.#length % this.#tail.length] = b;
      this.#length++;
    }
  }
  #at(i: number): number {
    if (i < Math.max(0, this.#length - this.#tail.length) || i >= this.#length)
      fail('inspection_limit');
    return this.#tail[i % this.#tail.length] ?? fail();
  }
  #matches(i: number, text: string): boolean {
    if (i < Math.max(0, this.#length - this.#tail.length) || i + text.length > this.#length)
      return false;
    for (let j = 0; j < text.length; j++) if (this.#at(i + j) !== text.charCodeAt(j)) return false;
    return true;
  }
  finish(): 'application/pdf' {
    let header = '';
    for (const b of this.#header) header += String.fromCharCode(b);
    if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]$/.test(header)) fail();
    const white = (b: number): boolean => [0, 9, 10, 12, 13, 32].includes(b);
    let end = this.#length;
    while (end > 0 && white(this.#at(end - 1))) end--;
    if (!this.#matches(end - 5, '%%EOF')) fail();
    let cursor = end - 5;
    while (cursor > 0 && white(this.#at(cursor - 1))) cursor--;
    let start = cursor;
    while (start > 0 && this.#at(start - 1) >= 48 && this.#at(start - 1) <= 57) start--;
    if (start === cursor || cursor - start > 10) fail();
    let xref = 0;
    for (let i = start; i < cursor; i++) xref = xref * 10 + this.#at(i) - 48;
    cursor = start;
    while (cursor > 0 && white(this.#at(cursor - 1))) cursor--;
    const startxref = cursor - 9;
    if (!this.#matches(startxref, 'startxref') || xref >= startxref) fail();
    cursor = xref;
    let tokens = 0;
    const token = (): string => {
      tokens++;
      if (tokens > 65536) fail('inspection_limit');
      while (cursor < startxref && white(this.#at(cursor))) cursor++;
      if (cursor >= startxref) return '';
      let out = '';
      const first = this.#at(cursor++);
      out = String.fromCharCode(first);
      if ((first === 60 || first === 62) && this.#at(cursor) === first) {
        cursor++;
        return out + out;
      }
      if ([91, 93].includes(first)) return out;
      if (first === 60) {
        while (cursor < startxref && this.#at(cursor) !== 62) {
          const b = this.#at(cursor++);
          if (!white(b) && !((b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102)))
            fail();
          if (out.length >= 256) fail('inspection_limit');
          out += String.fromCharCode(b);
        }
        if (cursor >= startxref) fail();
        cursor++;
        return out + '>';
      }
      while (
        cursor < startxref &&
        !white(this.#at(cursor)) &&
        ![60, 62, 91, 93, 47].includes(this.#at(cursor))
      ) {
        if (out.length >= 64) fail('inspection_limit');
        out += String.fromCharCode(this.#at(cursor++));
      }
      return out;
    };
    const integer = (value: string): number => {
      if (!/^(?:0|[1-9][0-9]*)$/.test(value) || value.length > 10) fail();
      const n = Number(value);
      if (!Number.isSafeInteger(n)) fail();
      return n;
    };
    if (token() !== 'xref') fail();
    let next = token(),
      maximum = 0,
      entries = 0;
    while (next !== 'trailer') {
      const first = integer(next),
        count = integer(token());
      if (count === 0 || count > 65536 - entries || first + count > 0x7fffffff) fail();
      entries += count;
      maximum = Math.max(maximum, first + count);
      for (let i = 0; i < count; i++) {
        const offsetToken = token(),
          generationToken = token(),
          state = token();
        if (
          !/^[0-9]{10}$/.test(offsetToken) ||
          !/^[0-9]{5}$/.test(generationToken) ||
          !['n', 'f'].includes(state) ||
          Number(generationToken) > 65535
        )
          fail();
        if (state === 'n' && Number(offsetToken) >= xref) fail();
      }
      next = token();
    }
    if (entries === 0 || token() !== '<<') fail();
    let size = 0,
      root = 0;
    const keys = new Set<string>();
    for (;;) {
      const key = token();
      if (key === '>>') break;
      if (keys.has(key) || keys.size >= 8) fail();
      keys.add(key);
      if (key === '/Size') size = integer(token());
      else if (key === '/Root' || key === '/Info') {
        const object = integer(token()),
          generation = integer(token());
        if (!object || generation > 65535 || token() !== 'R') fail();
        if (key === '/Root') root = object;
      } else if (key === '/Prev') {
        if (integer(token()) >= xref) fail();
      } else if (key === '/ID') {
        if (
          token() !== '[' ||
          !/^<[0-9a-fA-F\s]+>$/.test(token()) ||
          !/^<[0-9a-fA-F\s]+>$/.test(token()) ||
          token() !== ']'
        )
          fail();
      } else fail();
    }
    if (size < maximum || root === 0 || root >= size || token() !== '') fail();
    return 'application/pdf';
  }
}
