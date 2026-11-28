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
import { clipLine } from '../render/tui/sheet-frame.js';
import { displayWidth, wrapWords } from '../render/tui/viewport.js';
import { POPUP_FLOOR, POPUP_NOTICE_MAX_COLUMNS, popupInnerWidth } from './geometry.js';

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
 * {@link scrubPopupText} of text a VIEW has already cut with its own `…` (a bounded prompt head, a long tool id): the cut is the host's mark,
 * not the author's, and the scrub's compatibility fold would turn it into three dots, so a second scrub would draw `...` where the plain
 * surfaces of the same view draw `…`. The text in front of the mark is scrubbed whole and the mark is put back; a text that does not end in
 * `…` is scrubbed as it is.
 */
export function scrubPopupCut(text: string): string {
  return text.endsWith('…') ? `${scrubPopupText(text.slice(0, -1))}…` : scrubPopupText(text);
}

/**
 * A row that starts with a lone `/` (a slash that stands for "or" between two words): drawn at the start of a row it reads as the start of a
 * command (`/ high / max.` under a description that ends `off / low / medium`), so no wrap leaves one there.
 */
const LONE_SLASH_START = /^\s*\/(?:\s|$)/u;

/**
 * `wrapWords` of `text`, but never leaving a row that starts with a lone `/`: the break moves to before the word that stood in front of it (the
 * word goes down to the next row with its slash), and the rest is wrapped again from there. A row of one word has nothing earlier to break at, and
 * is left.
 */
function wrapWithoutLoneSlashStart(text: string, columns: number): string[] {
  const rows = wrapWords(text, columns);
  for (let at = 1; at < rows.length; at += 1) {
    if (!LONE_SLASH_START.test(rows[at] ?? '')) continue;
    const previous = rows[at - 1] ?? '';
    const cut = previous.trimEnd().lastIndexOf(' ');
    if (cut <= 0) continue;
    const tail = previous.slice(cut + 1) + rows.slice(at).join('');
    return [
      ...rows.slice(0, at - 1),
      previous.slice(0, cut + 1),
      ...wrapWithoutLoneSlashStart(tail, columns),
    ];
  }
  return rows;
}

/**
 * `text` in lines of at most `columns`, nothing cut, a long word broken where it must be, and no line starting with a lone `/`. `wrapWords` keeps
 * the white space it breaks at, so a line that ended just before a space would start the next one with it: every continuation line starts where
 * the first does.
 */
export function wrapPopupText(text: string, columns = POPUP_TEXT_COLUMNS): string[] {
  return wrapWithoutLoneSlashStart(text, columns).map((line, index) =>
    index === 0 ? line.trimEnd() : line.trim(),
  );
}

/**
 * `text` as lines of at most `columns`, the lines after the first indented by `hang` columns, so a row of a table that is wider than the popup
 * still reads as one row. Nothing is cut: the first line is what fits, and the rest wraps in the room the indent leaves. No line starts with a lone
 * `/` ({@link wrapPopupText}).
 */
export function wrapHanging(text: string, columns = POPUP_TEXT_COLUMNS, hang = 4): string[] {
  const [first = ''] = wrapWithoutLoneSlashStart(text, columns);
  const head = first.trimEnd();
  const rest = text.slice(first.length).trimStart();
  if (rest === '') return [head];
  const indent = ' '.repeat(hang);
  return [
    head,
    // `wrapWords` keeps the white space it breaks at: a line that ended just before a space would start the next one with it, and the hang would
    // be one column deeper than the others (review round 1, found on the real binary: ` step-12 → out` under a chain). Every line starts at the hang.
    ...wrapWithoutLoneSlashStart(rest, Math.max(1, columns - hang)).map(
      (line) => `${indent}${line.trim()}`,
    ),
  ];
}

/**
 * The one fit of what a setting announces on the host's channel: the first of `forms` that is at most {@link POPUP_NOTICE_MAX_COLUMNS} wide
 * (54: read whole beside a popup's way back, should one open while it is shown), else the last of them cut with the ellipsis. The settings
 * popups' announcements (`/models`' and `/mode`'s) all go through it, longest form first, so none is cut where a person reads it.
 */
export function fitNotice(...forms: readonly string[]): string {
  const fits = forms.find((text) => displayWidth(text) <= POPUP_NOTICE_MAX_COLUMNS);
  return fits ?? clipLine(forms.at(-1) ?? '', POPUP_NOTICE_MAX_COLUMNS);
}
