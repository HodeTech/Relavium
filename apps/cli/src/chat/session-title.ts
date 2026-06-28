/**
 * Derive a readable session title from the FIRST user message (2.5.B) so the Home list shows a glance-able label
 * instead of a bare session id. Pure + framework-free; the persister sets it on the first turn of every chat
 * session (so `relavium chat` and a Home-started chat both get one). An LLM-summarised title is Phase 3.
 *
 * The title is STORAGE-shaped here (whitespace collapsed to one line, trimmed, truncated to ~40 chars with an
 * ellipsis); CONTROL-char sanitization is the display's job (the Home projection runs `stripTerminalControls` on
 * the title when it renders), mirroring the chat transcript's "raw in storage, sanitized at the boundary" rule.
 */

/** The max length of a derived session title, in Unicode code points — the readable width of the Home strip. */
export const SESSION_TITLE_MAX = 40;

/** The first user message → a one-line, trimmed, truncated title, or `undefined` for an empty/blank message. */
export function deriveSessionTitle(firstMessage: string): string | undefined {
  const oneLine = firstMessage.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return undefined; // a blank first message keeps the session title unset (not "")
  // Count + slice by CODE POINT (`[...oneLine]`), not UTF-16 code unit: a code-unit cut at index 39 could split
  // an astral char (emoji) and leave a lone surrogate that renders as mojibake in the Home list.
  const points = [...oneLine];
  if (points.length <= SESSION_TITLE_MAX) return oneLine;
  return `${points
    .slice(0, SESSION_TITLE_MAX - 1)
    .join('')
    .trimEnd()}…`;
}
