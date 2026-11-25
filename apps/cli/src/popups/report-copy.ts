/**
 * `[c] copy` on the four report popups ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1: every report popup offers it, because a closed report leaves nothing to re-read and pasting one into a bug report is the common case),
 * in the manner of the doctor's: the same path (`attemptClipboardWrite`, OSC 52 through the host's one clipboard closure), the same sentence
 * family, and nothing written anywhere but the popup host's notification channel.
 *
 * **What is copied is what is drawn.** The report's own lines, which every builder has already scrubbed with the full floor
 * (`report-text.ts`), passed through the same last step the frame applies to a row (`popupText`: one line, host glyphs blanked), as plain text
 * with no styling, one line to a row, in the plain glyph form when the host says colour is off. A string a hostile project wrote reaches the
 * clipboard exactly as far as it reaches the screen, which is not at all.
 */

import { attemptClipboardWrite, type ClipboardOutcome } from '../render/clipboard.js';
import { withGlyphForm } from '../render/tui/glyphs.js';
import { popupText } from './frame-model.js';
import type { PopupControl } from './popup-reducer.js';
import type { PopupContext } from './popup-host.js';
import type { ReportsPort } from './report-port.js';

/** The control the report step of every report popup lists: `[c] copy`. */
export const COPY_CONTROL: PopupControl = { key: 'c', verb: 'copy' };

/**
 * The controls a report's step lists once its content is known: `[c] copy` when the content is a report (lines that are drawn and can be
 * copied), and none while it loads, says it failed or says there is nothing, so the control is never offered for something it cannot copy.
 */
export function copyControlsFor(content: { readonly kind: string }): readonly PopupControl[] {
  return content.kind === 'report' ? [COPY_CONTROL] : [];
}

/** The report as plain text, exactly the rows the popup draws for `lines`, in the glyph form the host's colour setting asks for. */
export function reportCopyText(lines: readonly string[], plainGlyphs: boolean): string {
  return withGlyphForm(plainGlyphs, () => lines.map((line) => popupText(line)).join('\n'));
}

/** What a copy says, in the doctor's sentences, under the report's name and short enough for the popup's legend row, where it is drawn (`Cost: sent 412 characters to the terminal clipboard.`). */
export function reportCopyNotice(label: string, outcome: ClipboardOutcome): string | undefined {
  switch (outcome.kind) {
    case 'written':
      return `${label}: sent ${String(outcome.characters)} characters to the terminal clipboard.`;
    case 'failed':
      return `${label}: the clipboard request failed.`;
    case 'too-large':
      return `${label}: too large for the terminal clipboard.`;
    case 'empty':
      return undefined;
  }
}

/** What `[c]` says when the host wired no clipboard: copying is not available here. The control is still offered, and says so. */
export function reportCopyUnavailable(label: string): string {
  return `${label}: copying is not available here.`;
}

/**
 * Copy `lines` (the report as it is at this moment) to the host's clipboard, and say what happened on the popup host's one notification
 * channel. Nothing else is written: not the transcript, not a Home notice. A write that fails or is refused is a notification, never a throw.
 */
export function copyReport(
  context: PopupContext,
  port: Pick<ReportsPort, 'clipboard' | 'plainGlyphs'>,
  label: string,
  lines: readonly string[],
): void {
  const clipboard = port.clipboard;
  if (clipboard === undefined) {
    context.notify(reportCopyUnavailable(label));
    return;
  }
  void attemptClipboardWrite(clipboard, reportCopyText(lines, port.plainGlyphs === true)).then(
    (outcome) => {
      const text = reportCopyNotice(label, outcome);
      if (text !== undefined) context.notify(text);
    },
  );
}
