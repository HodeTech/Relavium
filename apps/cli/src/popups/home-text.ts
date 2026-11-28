/**
 * The ONE way the Home's management popups (`/help`, `/agents`, `/workflows`) draw a word that is stored somewhere ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §5, the 2026-11-27 note; [MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4): a workflow's or an agent's name, a description, a
 * node id, an input's name, a file's place, a run's id. Each passes the Home's row scrub, the one the work page's rows and the card of an unreadable
 * run pass ({@link workRowText}: the full scrub `flowLine`, then the lookalikes of the `▲`/`▼ N more` marker blanked, then {@link foldKeyLookalikes}:
 * a bracketed key such as `[Enter]`, an arrow or a run of white space made plain), so a hostile name can neither forge a key hint or a row nor take
 * more than its own line. Read to a bound first, so a megabyte of name costs what a short one does.
 *
 * Loaded with the popups that use it, and never before (`lazy-load.test.ts`); it adds nothing the Home's first paint does not already hold.
 */

import { foldKeyLookalikes } from '../render/tui/home-attention.js';
import { workRowText } from '../render/tui/home-projection.js';
import { clipLine } from '../render/tui/sheet-frame.js';
import { displayWidth } from '../render/tui/viewport.js';
import { wrapPopupText } from './popup-text.js';

/** The code points of a stored value read before the scrub, so a megabyte of text costs what a short one does. */
export const STORED_READ_CODE_POINTS = 512;

/** `text` read to {@link STORED_READ_CODE_POINTS} code points, then scrubbed as a Home row is (see the module header), as one line. */
export function storedLine(text: string): string {
  const read = Array.from(text.slice(0, STORED_READ_CODE_POINTS * 2))
    .slice(0, STORED_READ_CODE_POINTS)
    .join('');
  return foldKeyLookalikes(workRowText(read));
}

/** {@link storedLine} cut to `columns` with the ellipsis; `fallback` when nothing of it is left to show. */
export function stored(text: string, columns: number, fallback = ''): string {
  const shown = clipLine(storedLine(text), columns);
  return shown === '' ? fallback : shown;
}

/**
 * A stored paragraph as at most `rows` lines of `columns`: scrubbed as one line, wrapped, and the last line ended with `…` when the text goes on.
 * Empty for a text with nothing left to show.
 */
export function storedParagraph(text: string, columns: number, rows: number): string[] {
  const lines = wrapPopupText(storedLine(text), columns).filter((line) => line !== '');
  if (lines.length <= rows) return lines;
  const kept = lines.slice(0, rows);
  kept[rows - 1] = endedWithEllipsis(kept[rows - 1] ?? '', columns);
  return kept;
}

/** `line` and `…` in `columns`: words are dropped from its end until the mark fits, so the cut falls between words, not inside one. */
export function endedWithEllipsis(line: string, columns: number): string {
  const words = line.trimEnd().split(' ');
  while (words.length > 1 && displayWidth(`${words.join(' ')}…`) > columns) words.pop();
  return clipLine(`${words.join(' ')}…`, columns);
}
