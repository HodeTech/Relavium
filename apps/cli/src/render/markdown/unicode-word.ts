/** A single Unicode letter or number, including supplementary-plane code points. */
export function isWordCodePoint(value: string): boolean {
  return /^[\p{L}\p{N}]$/u.test(value);
}

/** Classify the code point immediately before a UTF-16 offset. */
export function isWordBefore(source: string, index: number): boolean {
  if (index <= 0) return false;
  const previous = Array.from(source.slice(Math.max(0, index - 2), index)).at(-1) ?? '';
  return isWordCodePoint(previous);
}

/** Classify the code point starting at a UTF-16 offset. */
export function isWordAt(source: string, index: number): boolean {
  const point = source.codePointAt(index);
  return point === undefined ? false : isWordCodePoint(String.fromCodePoint(point));
}
