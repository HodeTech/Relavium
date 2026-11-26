import { deriveSessionTitle } from '../../chat/session-title.js';
import { flowLine } from './flow-text.js';
import { WORDMARK } from './home-layout.js';
import { keepStart } from './status-line.js';
import { displayWidth } from './viewport.js';

/**
 * The chat's frame as DATA ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §4, [MVP-11 §4.8](../../../../../docs/roadmap/phases/mvp-11.md#48-the-chat)): the rows of the frame the full-screen chat draws, the header's
 * two rows and the one-line session title it carries on the right, and the five rows of the prompt block. The stand-alone chat and the chat
 * the Home hosts read the same numbers, so the two cannot disagree about how tall the frame is or where the transcript's rows end.
 *
 * - **The frame is `rows − 1` tall** ({@link chatFrameRows}): a frame as tall as the terminal makes Ink treat it as full-screen and clear
 *   the whole terminal when it is left for a shorter one (`shouldClearTerminalForFrame`), so both hosts leave the last row alone.
 * - **The header is {@link CHAT_HEADER_ROWS} rows**: the wordmark on the left with the session title right-aligned to the width, and a
 *   blank row. At 80×24 that is 23 rows = 2 (header) + 16 (transcript, at rest) + 5 ({@link PROMPT_BLOCK_ROWS}).
 * - **The title is untrusted persistent text** (the person's own first message): one line from {@link deriveSessionTitle}, scrubbed by the
 *   one pass of a Home flow ({@link flowLine}: secrets, control and bidirectional characters, host glyphs, chord tokens and ` · ` made inert),
 *   then cut at its end to the columns the wordmark leaves, so a title can never wrap the header or push the wordmark.
 *
 * A data module: it imports nothing from `ink`, `react`, `chalk` or `node:` (ADR-0145 §10).
 */

/** The rows of the header: the wordmark (with the title), and a blank row under it. */
export const CHAT_HEADER_ROWS = 2;

/** The rows of the prompt block at rest: a blank row, the prompt, a thin rule, the status line and the hint. */
export const PROMPT_BLOCK_ROWS = 5;

/** The columns kept empty between the wordmark and the title: a title that would come closer is cut. */
export const HEADER_TITLE_GAP = 2;

/**
 * The rows a full-screen chat's frame is bounded to: one fewer than the terminal (never fewer than one, and one for a terminal whose size is
 * not a number). Both hosts bound their root to it and every geometry consumer (the transcript viewport, the live answer's budget, the
 * mouse mapping) reads the same bound.
 */
export function chatFrameRows(terminalRows: number): number {
  return Number.isFinite(terminalRows) ? Math.max(1, Math.floor(terminalRows) - 1) : 1;
}

/** What the title is derived from: the transcript's entries, of which only the role and the text of a user line are read. */
export interface TitleSource {
  readonly role: string;
  readonly text: string;
}

/** The first user line of a transcript, or `undefined` before the first message: what {@link chatSessionTitle} is made from. */
export function firstUserLine(transcript: readonly TitleSource[]): string | undefined {
  return transcript.find((entry) => entry.role === 'user')?.text;
}

/**
 * The session title of a conversation whose first user line is `firstLine`: the title the persister derives from it (one line, trimmed, at
 * most 40 code points, {@link deriveSessionTitle}), then scrubbed for the terminal. Empty before the first message, and for a first message that
 * is blank or reads as nothing once scrubbed.
 */
export function chatSessionTitle(firstLine: string | undefined): string {
  if (firstLine === undefined) return '';
  const derived = deriveSessionTitle(firstLine);
  return derived === undefined ? '' : flowLine(derived).trim();
}

/** The header's row as its parts: the wordmark, the spaces after it and the title (empty when there is none or no room for one). */
export interface HeaderRow {
  readonly wordmark: string;
  /** The spaces between the wordmark and the title (none without a title). */
  readonly gap: string;
  readonly title: string;
}

/**
 * The header row for `columns` columns: the wordmark at the left edge and the title ENDING at the last column, so the row is exactly
 * `columns` wide with a title and the wordmark's width without one. The title is cut at its end to what the wordmark and
 * {@link HEADER_TITLE_GAP} leave; with no room for even one column of it there is no title. `title` is passed through {@link flowLine}
 * here too, so a caller that did not scrub it cannot draw an unscrubbed one.
 */
export function headerRow(title: string, columns: number): HeaderRow {
  const wordmarkWidth = displayWidth(WORDMARK);
  const room = Number.isFinite(columns)
    ? Math.floor(columns) - wordmarkWidth - HEADER_TITLE_GAP
    : 0;
  const cleaned = flowLine(title).trim();
  const cut = room >= 1 && cleaned !== '' ? keepStart(cleaned, room) : '';
  if (cut === '') return { wordmark: WORDMARK, gap: '', title: '' };
  const gap = Math.max(HEADER_TITLE_GAP, Math.floor(columns) - wordmarkWidth - displayWidth(cut));
  return { wordmark: WORDMARK, gap: ' '.repeat(gap), title: cut };
}
