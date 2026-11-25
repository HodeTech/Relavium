/**
 * The text of the report popups ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §8,
 * [ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §5): the one scrub every untrusted string passes before a
 * report draws or wraps it, and the one wrap. The `/cost` popup has a chord step, and the other three share its content builders' floor, so the
 * FULL scrub of the run cards applies to all four: secrets scrubbed, folded, host glyphs blanked, answer chords replaced, and bracketed key
 * tokens and legend separators made inert, so a name from a project, a provider or a model cannot draw `[Ctrl+Y]` where the person decides or
 * forge a field of a row.
 *
 * Nothing here is loaded until the person first opens a report (`report-port.ts`).
 */

import { inertLegendText } from '../render/tui/legend.js';
import { authorLine } from '../render/tui/run-card-model.js';
import { wrapWords } from '../render/tui/viewport.js';
import { POPUP_FLOOR, POPUP_MAX_WIDTH, POPUP_SIDE_MARGIN, popupMargin } from './geometry.js';

/** The columns a popup's text has at the smallest terminal it is drawn on (80 columns): every line a report writes fits it whole. */
export const REPORT_TEXT_COLUMNS =
  Math.min(POPUP_FLOOR.columns - 2 * popupMargin(POPUP_FLOOR.columns), POPUP_MAX_WIDTH) -
  2 * POPUP_SIDE_MARGIN;

/**
 * The full scrub of a surface with a chord step (ADR-0145 §5): the run cards' author-text floor, then key tokens and legend separators made
 * inert. For every string of a report that a project, a provider, a model or a catalog wrote.
 */
export function reportText(text: string): string {
  return inertLegendText(authorLine(text));
}

/** `text` in lines of at most `columns`, nothing cut, a long word broken where it must be. */
export function wrapReport(text: string, columns = REPORT_TEXT_COLUMNS): string[] {
  return wrapWords(text, columns).map((line) => line.trimEnd());
}

/**
 * `text` as lines of at most `columns`, the lines after the first indented by `hang` columns, so a row of a table that is wider than the popup
 * still reads as one row. Nothing is cut: the first line is what fits, and the rest wraps in the room the indent leaves.
 */
export function wrapHanging(text: string, columns = REPORT_TEXT_COLUMNS, hang = 4): string[] {
  const [first = ''] = wrapWords(text, columns);
  const head = first.trimEnd();
  const rest = text.slice(first.length).trimStart();
  if (rest === '') return [head];
  const indent = ' '.repeat(hang);
  return [
    head,
    ...wrapWords(rest, Math.max(1, columns - hang)).map((line) => `${indent}${line.trimEnd()}`),
  ];
}
