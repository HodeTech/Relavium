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
    let token: SyntaxToken = 'text';
    let tokenEnd = end;
    const first = source.charCodeAt(at);
    if (first === 43) {
      token = plusHeader && source.startsWith('+++ ', at) ? 'meta' : 'inserted';
      plusHeader = false;
    } else if (first === 45) {
      const header = source.startsWith('--- ', at) && source.startsWith('+++ ', end + 1);
      token = header ? 'meta' : 'deleted';
      plusHeader = header;
    } else {
      plusHeader = false;
      if (first === 64 && source.startsWith('@@', at)) {
        token = 'hunk';
        tokenEnd = hunkEnd(out, at, end);
      } else if (first === 92) token = 'comment';
      else if (startsMeta(source, at)) token = 'meta';
    }
    if (token !== 'text') out.mark(at, tokenEnd, token);
    at = end + 1;
  }
};
