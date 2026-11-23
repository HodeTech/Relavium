/**
 * Literal matching for `search_files`, linear in the text it reads (ADR-0142).
 *
 * Knuth–Morris–Pratt: one pass over the haystack, a failure table built once per pattern. Every occurrence is
 * reported in order, overlaps included, so a rejected whole-word match resumes from the next position without
 * rereading text. The native `indexOf` retry loop it replaces has a cost that depends on the pattern's length
 * as well as the text's, which the work budget could only bound by over-charging; this one needs no such bound.
 */

/** The KMP failure table: entry `i` is the length of the longest proper border of `needle[0..i]`. */
export function literalFailureTable(needle: string): Int32Array {
  const table = new Int32Array(needle.length);
  let border = 0;
  for (let i = 1; i < needle.length; i++) {
    const code = needle.charCodeAt(i);
    while (border > 0 && needle.charCodeAt(border) !== code) border = table[border - 1] ?? 0;
    if (needle.charCodeAt(border) === code) border++;
    table[i] = border;
  }
  return table;
}

/**
 * Calls `accept` with each start index of `needle` in `haystack`, in increasing order and including overlapping
 * occurrences, until `accept` returns `true`. `needle` must be nonempty and `failure` must be its table. Reads
 * each haystack unit once.
 */
export function scanLiteral(
  haystack: string,
  needle: string,
  failure: Int32Array,
  accept: (start: number) => boolean,
): void {
  const length = needle.length;
  if (length === 0) return;
  let matched = 0;
  for (let i = 0; i < haystack.length; i++) {
    const code = haystack.charCodeAt(i);
    while (matched > 0 && needle.charCodeAt(matched) !== code) matched = failure[matched - 1] ?? 0;
    if (needle.charCodeAt(matched) === code) matched++;
    if (matched === length) {
      if (accept(i - length + 1)) return;
      matched = failure[length - 1] ?? 0;
    }
  }
}
