import type { SyntaxToken } from '../types.js';
import type { Scanner, Segments } from './segments.js';

/** Lines that carry file metadata, not content: only these are meta, so prose in a diff stays plain. */
const META_PREFIXES = [
  'diff ',
  'index ',
  'new file mode',
  'deleted file mode',
  'old mode',
  'new mode',
  'similarity index',
  'dissimilarity index',
  'rename from',
  'rename to',
  'copy from',
  'copy to',
  'Binary files',
  'GIT binary patch',
];

function startsMeta(source: string, at: number): boolean {
  return META_PREFIXES.some((prefix) => source.startsWith(prefix, at));
}

/** `@@ -1,3 +1,4 @@ context`: the range markers are the hunk, the context after them stays plain. */
function hunkEnd(out: Segments, at: number, end: number): number {
  const close = out.find('@@', at + 2);
  return close >= 0 && close < end ? close + 2 : end;
}

/** What one line of a diff is: its class, where that class ends, and whether a `+++` header must follow the next line. */
interface DiffLine {
  readonly token: SyntaxToken;
  readonly end: number;
  readonly plusHeader: boolean;
}

/** A line that starts with `-`: a file header only when the line after it opens with `+++ `, otherwise a deletion. */
function minusLine(source: string, at: number, end: number): DiffLine {
  const header = source.startsWith('--- ', at) && source.startsWith('+++ ', end + 1);
  return { token: header ? 'meta' : 'deleted', end, plusHeader: header };
}

/** A line that starts with neither `+` nor `-`: a hunk header, a "no newline" note, a metadata line, or plain text. */
function otherLine(source: string, out: Segments, at: number, end: number): DiffLine {
  const first = source.charCodeAt(at);
  if (first === 64 && source.startsWith('@@', at)) {
    return { token: 'hunk', end: hunkEnd(out, at, end), plusHeader: false };
  }
  if (first === 92) return { token: 'comment', end, plusHeader: false };
  return { token: startsMeta(source, at) ? 'meta' : 'text', end, plusHeader: false };
}

/**
 * A unified diff, read one line at a time: a line's first character says what it is. Hunk line counts are not
 * trusted (a model often miscounts them); a `---` line is a file header only when a `+++` line follows it.
 */
export const scanDiff: Scanner = (source, out) => {
  let at = 0;
  let plusHeader = false;
  while (at < source.length) {
    out.tick();
    const end = out.lineEnd(at);
    const first = source.charCodeAt(at);
    let line: DiffLine;
    if (first === 43) {
      const header = plusHeader && source.startsWith('+++ ', at);
      line = { token: header ? 'meta' : 'inserted', end, plusHeader: false };
    } else if (first === 45) line = minusLine(source, at, end);
    else line = otherLine(source, out, at, end);
    plusHeader = line.plusHeader;
    if (line.token !== 'text') out.mark(at, line.end, line.token);
    at = end + 1;
  }
};
