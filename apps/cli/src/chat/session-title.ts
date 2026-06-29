/**
 * Derive a readable session title from the FIRST user message (2.5.B) so the Home list shows a glance-able label
 * instead of a bare session id. Pure + framework-free; the persister sets it on the first turn of every chat
 * session (so `relavium chat` and a Home-started chat both get one). An LLM-summarised title is Phase 3.
 *
 * The title is STORAGE-shaped here (whitespace collapsed to one line, trimmed, truncated to ~40 chars with an
 * ellipsis); CONTROL-char sanitization is the display's job (the Home projection runs `sanitizeInline` on the
 * title when it renders), mirroring the chat transcript's "raw in storage, sanitized at the boundary" rule.
 */

/** The max length of a derived session title, in Unicode code points — the readable width of the Home strip. */
export const SESSION_TITLE_MAX = 40;

/** The first user message → a one-line, trimmed, truncated title, or `undefined` for an empty/blank message. */
export function deriveSessionTitle(firstMessage: string): string | undefined {
  const oneLine = firstMessage.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return undefined; // a blank first message keeps the session title unset (not "")
  // Fast path: a UTF-16 length ≤ MAX implies ≤ MAX code points, so the title never truncates — and a huge pasted
  // first message (a log dump) never walks the whole string.
  if (oneLine.length <= SESSION_TITLE_MAX) return oneLine;
  // Otherwise walk by CODE POINT (not UTF-16 unit — a code-unit cut could split an astral char and leave a lone
  // surrogate / mojibake), bounded to MAX+1 points: track the UTF-16 index AFTER the (MAX-1)th point as the cut.
  let cutUnits = oneLine.length; // default: the string has ≤ MAX points (no truncation) — set below if longer
  let units = 0;
  let points = 0;
  for (const codePoint of oneLine) {
    if (points === SESSION_TITLE_MAX - 1) cutUnits = units; // remember where MAX-1 code points end
    points += 1;
    units += codePoint.length;
    if (points > SESSION_TITLE_MAX) {
      return `${oneLine.slice(0, cutUnits).trimEnd()}…`; // more than MAX points ⇒ truncate at the MAX-1 boundary
    }
  }
  return oneLine; // exactly MAX code points (or fewer after the astral-aware count) ⇒ no truncation
}
