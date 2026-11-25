/**
 * The text of every popup that shows a project's, a provider's or a catalog's words ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §8,
 * [ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §5): the ONE scrub every untrusted string passes before a popup
 * draws, wraps or copies it, and the one wrap. The `/doctor` popup and the four report popups (`/cost`, `/agent`, `/workflows`, `/help`) each have
 * a step that takes a chord or sits beside one, so all five share the FULL scrub of the run cards: secrets scrubbed, folded, host glyphs blanked,
 * answer chords replaced, and bracketed key tokens and legend separators made inert, so a name from a project, a provider, a model or an MCP
 * server cannot draw `[Ctrl+Y]` where the person decides or forge a field of a row. A change to the scrub is made here, once, and `popup-text.test.ts`
 * holds every sink of both callers to it.
 *
 * Nothing here is loaded until the person first opens a popup (`doctor-port.ts`, `report-port.ts`).
 */

import { inertLegendText } from '../render/tui/legend.js';
import { authorLine } from '../render/tui/run-card-model.js';
import { wrapWords } from '../render/tui/viewport.js';
import { POPUP_FLOOR, popupInnerWidth } from './geometry.js';

/** The columns a popup's text has at the smallest terminal it is drawn on (80 columns): every line a popup writes fits it whole. */
export const POPUP_TEXT_COLUMNS = popupInnerWidth(POPUP_FLOOR.columns, 'standard');

/**
 * The full scrub of a surface with a chord step (ADR-0145 §5): the run cards' author-text floor (secrets scrubbed, folded, host glyphs blanked,
 * answer chords replaced), then key tokens and legend separators made inert. For every string of a popup that a project, a provider, a model, a
 * server or a catalog wrote, wherever it is drawn or copied.
 */
export function scrubPopupText(text: string): string {
  return inertLegendText(authorLine(text));
}

/**
 * `text` in lines of at most `columns`, nothing cut, a long word broken where it must be. `wrapWords` keeps the white space it breaks at, so a
 * line that ended just before a space would start the next one with it: every continuation line starts where the first does.
 */
export function wrapPopupText(text: string, columns = POPUP_TEXT_COLUMNS): string[] {
  return wrapWords(text, columns).map((line, index) =>
    index === 0 ? line.trimEnd() : line.trim(),
  );
}

/**
 * `text` as lines of at most `columns`, the lines after the first indented by `hang` columns, so a row of a table that is wider than the popup
 * still reads as one row. Nothing is cut: the first line is what fits, and the rest wraps in the room the indent leaves.
 */
export function wrapHanging(text: string, columns = POPUP_TEXT_COLUMNS, hang = 4): string[] {
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
