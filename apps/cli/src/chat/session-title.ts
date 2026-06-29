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
  // first message (a log dump) never spreads the whole string into a code-point array.
  if (oneLine.length <= SESSION_TITLE_MAX) return oneLine;
  // Otherwise count + slice by CODE POINT (`[...]`), not UTF-16 code unit (a code-unit cut could split an astral
  // char and leave a lone surrogate / mojibake). Bound the spread to the first `(MAX+1)*2` units — guaranteed to
  // hold ≥ MAX+1 code points if the string is that long, so the ≤ MAX decision and the slice are exact.
  const head = [...oneLine.slice(0, (SESSION_TITLE_MAX + 1) * 2)];
  if (head.length <= SESSION_TITLE_MAX) return oneLine;
  head.length = SESSION_TITLE_MAX - 1; // truncate IN PLACE (no second array clone) — keep MAX-1 code points + the ellipsis
  return `${head.join('').trimEnd()}…`;
}
