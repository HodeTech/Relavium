import { deriveSessionTitle } from '../../chat/session-title.js';
import { PATH_ELLIPSIS } from '../notation.js';
import { flowLine } from './flow-text.js';
import { frameRows, WORDMARK } from './home-layout.js';
import { PROMPT_WINDOW_MIN_ROWS } from './prompt-window.js';
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
 * - **The title is untrusted persistent text** (the person's own first message): scrubbed whole by the one pass of a Home flow ({@link flowLine}:
 *   secrets, control and bidirectional characters, host glyphs, chord tokens and ` · ` made inert), THEN cut to one line of 40 code points
 *   ({@link deriveSessionTitle}), then cut at its end to the columns the wordmark leaves, so a title can never wrap the header or push the
 *   wordmark, and a key that straddles a cut was redacted before it.
 *
 * A data module: it imports nothing from `ink`, `react`, `chalk` or `node:` (ADR-0145 §10).
 */

/** The rows of the header: the wordmark (with the title), and a blank row under it. */
export const CHAT_HEADER_ROWS = 2;

/** The rows of the prompt block at rest: a blank row, the prompt, a thin rule, the status line and the hint. */
export const PROMPT_BLOCK_ROWS = 5;

/** The columns kept empty between the wordmark and the title: a title that would come closer is cut. */
export const HEADER_TITLE_GAP = 2;

/** The fewest transcript rows a chat keeps beside a long draft (OB7-M3): the editor's bound leaves at least this many of the supported 24-row frame. */
export const MIN_TRANSCRIPT_ROWS = 6;

/** The most rows the prompt editor takes however tall the terminal is: a long paste is shown as a window of this many rows, not a screenful. */
export const PROMPT_EDITOR_MAX_ROWS = 8;

/**
 * The rows the prompt editor may take in a frame of `frameRows` rows (OB7-M3): what the frame leaves after the header, the rest of the prompt
 * block (the leading row, the rule, the status line and the hint) and {@link MIN_TRANSCRIPT_ROWS} of the transcript, never more than
 * {@link PROMPT_EDITOR_MAX_ROWS} and never fewer than a window can have. A longer draft is drawn as a window around the cursor, so the cursor, the
 * rule, the status line and the hint are never pushed out of the frame by a paste. `undefined` for a host that does not know its height: the editor
 * is then unbounded, as it was. At the supported 80×24 (a frame of 23 rows) the bound is 8 and the transcript keeps 9 rows.
 */
export function promptEditorRows(frameRows: number | undefined): number | undefined {
  if (frameRows === undefined || !Number.isFinite(frameRows)) return undefined;
  const room =
    Math.floor(frameRows) - CHAT_HEADER_ROWS - (PROMPT_BLOCK_ROWS - 1) - MIN_TRANSCRIPT_ROWS;
  return Math.max(PROMPT_WINDOW_MIN_ROWS, Math.min(PROMPT_EDITOR_MAX_ROWS, room));
}

/**
 * The editor's bound for a host that has either the full-screen frame's rows (`viewportRows`, already one short of the terminal) or only the
 * terminal's (`terminalRows`, the inline renderer's: the frame it would have is {@link chatFrameRows} of it): the first that is known, else none.
 */
export function chatEditorRows(
  viewportRows: number | undefined,
  terminalRows: number | undefined,
): number | undefined {
  if (viewportRows !== undefined) return promptEditorRows(viewportRows);
  return terminalRows === undefined ? undefined : promptEditorRows(chatFrameRows(terminalRows));
}

/**
 * The rows a full-screen chat's frame is bounded to: one fewer than the terminal (never fewer than one, and one for a terminal whose size is
 * not a number). Both hosts bound their root to it and every geometry consumer (the transcript viewport, the live answer's budget, the
 * mouse mapping) reads the same bound. The rule is {@link frameRows}'s, which the Home's pages read too.
 */
export function chatFrameRows(terminalRows: number): number {
  return frameRows(terminalRows);
}

/** What the title is derived from: the transcript's entries, of which only the role and the text of a user line are read. */
export interface TitleSource {
  readonly role: string;
  readonly text: string;
}

/**
 * Whether there is a conversation to reply to (OB7-L9): a user or an assistant entry in the transcript, or turns a reseat or a resume carried in (the
 * inline renderer's store holds only what is new since the terminal's own scrollback took the rest, so its transcript says nothing of them). A notice
 * (the startup mode, a cleared session) is not a conversation, and neither is a tool row.
 */
export function hasConversation(state: {
  readonly transcript: readonly { readonly role: string }[];
  readonly turnCount: number;
}): boolean {
  return (
    state.turnCount > 0 ||
    state.transcript.some((entry) => entry.role === 'user' || entry.role === 'assistant')
  );
}

/** The first user line of a transcript, or `undefined` before the first message: what {@link chatSessionTitle} is made from. */
export function firstUserLine(transcript: readonly TitleSource[]): string | undefined {
  return transcript.find((entry) => entry.role === 'user')?.text;
}

/**
 * What of the first line is scrubbed to find the title: the first 1,024 code points of its one-line form, so a pasted log dump is not walked, while
 * a key that straddles the title's own 40-code-point cut is whole inside the window and is redacted before the cut (SE7-7).
 */
const TITLE_SCRUB_WINDOW = 1024;

/**
 * The session title of a conversation whose first user line is `firstLine`: the first line scrubbed for the terminal WHOLE (from a window of it),
 * then cut as the persister cuts it (one line, trimmed, at most 40 code points with the host's ellipsis, {@link deriveSessionTitle}). Scrubbing
 * comes first: cut first, a key that straddles the cut is no longer a key to the scrubber and the front of its body is drawn. For an ordinary
 * message this is exactly the title the persister derives. Empty before the first message, and for a first message that is blank or reads as
 * nothing once scrubbed.
 */
export function chatSessionTitle(firstLine: string | undefined): string {
  if (firstLine === undefined) return '';
  const oneLine = firstLine.replace(/\s+/gu, ' ').trim();
  const window = Array.from(oneLine.slice(0, TITLE_SCRUB_WINDOW * 2))
    .slice(0, TITLE_SCRUB_WINDOW)
    .join('');
  return deriveSessionTitle(flowLine(window).trim()) ?? '';
}

/** The header's row as its parts: the wordmark, the spaces after it and the title (empty when there is none or no room for one). */
export interface HeaderRow {
  readonly wordmark: string;
  /** The spaces between the wordmark and the title (none without a title). */
  readonly gap: string;
  readonly title: string;
}

/**
 * A title with the ellipsis it ends in written as the host's one: the pass of {@link flowLine} folds an ellipsis a value brought into three dots
 * (the persister's own cut, or a title stored by an older session), and a header that cut the same title again would then show two styles of cut in
 * one row (OB7-L6). Only the END is mapped: three dots inside a title are the person's own words.
 */
const trailingEllipsis = (title: string): string => title.replace(/\.{3}$/u, PATH_ELLIPSIS);

/**
 * The header row for `columns` columns: the wordmark at the left edge and the title ENDING at the last column, so the row is exactly
 * `columns` wide with a title and the wordmark's width without one. The title is cut at its end to what the wordmark and
 * {@link HEADER_TITLE_GAP} leave; with no room for even one column of it there is no title. `title` is passed through {@link flowLine}
 * here too, so a caller that did not scrub it cannot draw an unscrubbed one, and a trailing `...` is drawn as the host's ellipsis
 * ({@link trailingEllipsis}).
 */
export function headerRow(title: string, columns: number): HeaderRow {
  const wordmarkWidth = displayWidth(WORDMARK);
  const room = Number.isFinite(columns)
    ? Math.floor(columns) - wordmarkWidth - HEADER_TITLE_GAP
    : 0;
  const cleaned = trailingEllipsis(flowLine(title).trim());
  const cut = room >= 1 && cleaned !== '' ? keepStart(cleaned, room) : '';
  if (cut === '') return { wordmark: WORDMARK, gap: '', title: '' };
  const gap = Math.max(HEADER_TITLE_GAP, Math.floor(columns) - wordmarkWidth - displayWidth(cut));
  return { wordmark: WORDMARK, gap: ' '.repeat(gap), title: cut };
}
