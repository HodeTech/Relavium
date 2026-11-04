/**
 * Repeats one masking pass until its output stops changing, at most three passes. A pass can glue a
 * marker to the text after another rule's token, which the next pass reads anew, so a settled output
 * is a fixed point, and an output that still changes on the third pass fails closed to `failed`.
 * Callers choose a `failed` value the pass leaves unchanged, so the result is stable under another
 * call either way. Dependency-free, so the pure `scrub-secrets` leaf can load it.
 */
export function toFixedPoint(pass: (text: string) => string, text: string, failed: string): string {
  const once = pass(text);
  if (once === text) return once;
  const twice = pass(once);
  if (twice === once) return once;
  return pass(twice) === twice ? twice : failed;
}
