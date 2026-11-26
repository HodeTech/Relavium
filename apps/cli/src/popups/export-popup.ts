/**
 * The in-chat `/export` popup's words and steps ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6, §10; [MVP-11 OD-10](../../../../docs/roadmap/phases/mvp-11.md#72-decisions-od-1-to-od-23)): pure builders from where an export would
 * write to the popup's two steps, the confirmation and its result. The state machine that reads, answers the chord and writes is
 * `export-session.ts`; neither is loaded until the person first types `/export` in an interactive chat (`report-port.ts`).
 *
 * **The confirmation is a step, not a keystroke.** `/export` writes a file into the project, so it shows the file first (project-relative), says
 * whether it is a new file or this session's own earlier export rewritten in place (the one overwrite `/export` makes), and says what the
 * scaffold is and what to review before committing it (the review notice's sentence). Only `Ctrl+Y`, through the popup host's chord guard,
 * answers it; `Esc` cancels. The result is a persistent step that `Enter` and `Esc` close: the file written, or that nothing was and why, in the
 * product's words. Nothing is written into the transcript or a notice (§6).
 *
 * The target and every fault text are a file system's and a project's words, so each passes the FULL scrub ({@link scrubPopupText}).
 */

import { CHORD_REFUSAL_PHRASE } from './chord-refusal.js';
import type { PopupContent, PopupOrigin } from './frame-model.js';
import type { ChordRefusal } from './popup-host.js';
import type { PopupSpec } from './popup-reducer.js';
import { scrubPopupText, wrapPopupText } from './popup-text.js';
import type { SessionExportView } from './report-port.js';

/** The popup's steps: the confirmation (what would be written, answered by `Ctrl+Y`) and its result. */
export const EXPORT_STEP = { review: 0, done: 1 } as const;

/** What the confirmation says while the target is worked out. */
export const EXPORT_LOADING_CONTENT: PopupContent = {
  kind: 'loading',
  what: 'Working out where the export goes',
};

/** What the second line of the confirmation says: a new file, or this session's own earlier export rewritten in place. */
export const EXPORT_NEW_FILE = 'A new file in the project.';
export const EXPORT_OVERWRITES = 'It overwrites this session’s earlier export.';

/** What the result says when the answer found a turn in flight: nothing was written. */
export const EXPORT_TURN_IN_FLIGHT = {
  what: 'A turn is running, so nothing was exported.',
  next: 'Let it finish, then type /export again.',
} as const;

/** What the result says when the answer found the target moved since the step was drawn: nothing was written (the person confirmed THAT file). */
export const EXPORT_TARGET_CHANGED = {
  what: 'The target changed while this was open, so nothing was exported.',
  next: 'Type /export again to see where it goes now.',
} as const;

/** What the result says above the reason when the write (or the look before it) failed. */
export const EXPORT_FAILED = 'Nothing was exported.';

/** The confirmation's lines: the file, whether it is new, then the review notice's sentence, each wrapped to the popup's width. */
export function exportReviewContent(view: SessionExportView, review: string): PopupContent {
  return {
    kind: 'report',
    lines: [
      ...wrapPopupText(scrubPopupText(view.target)),
      ...wrapPopupText(view.overwrites ? EXPORT_OVERWRITES : EXPORT_NEW_FILE),
      '',
      ...wrapPopupText(review),
    ],
  };
}

/** The confirmation when the target could not be worked out: an error state (no answer is offered), in the product's words. */
export function exportPrepareFailedContent(reason: string): PopupContent {
  return { kind: 'error', what: EXPORT_FAILED, next: scrubPopupText(reason) };
}

/** The result of a write that was made: the file, project-relative. */
export function exportDoneContent(target: string): PopupContent {
  return { kind: 'report', lines: wrapPopupText(`Exported · ${scrubPopupText(target)}`) };
}

/** The result of a write that failed, by the product's words for it. */
export function exportFailedContent(reason: string): PopupContent {
  return { kind: 'error', what: EXPORT_FAILED, next: scrubPopupText(reason) };
}

/**
 * What the person is told when a `Ctrl+Y` did not count: the line had no step to go back to, so the host closed the popup and this is said on
 * its own channel. Short, because it is drawn in the room a notification has (`POPUP_NOTICE_MAX_COLUMNS`).
 */
export function exportRefusedText(reason: ChordRefusal): string {
  return `Nothing exported: ${CHORD_REFUSAL_PHRASE[reason]}.`;
}

/**
 * The popup's spec: two steps, the confirmation line (answered by `Ctrl+Y`; its `Esc` cancels) and the persistent result (`Enter` and `Esc`
 * close it; there is nothing to go back to).
 */
export function exportSpec(origin: PopupOrigin): PopupSpec {
  return {
    id: 'export',
    title: '/export',
    origin,
    steps: [
      {
        name: 'Export',
        content: EXPORT_LOADING_CONTENT,
        holds: 'chord',
        chord: { verb: 'export' },
        exitVerb: 'cancel',
      },
      {
        name: 'Done',
        content: { kind: 'report', lines: [] },
        back: EXPORT_STEP.review,
        final: true,
        enter: 'close',
      },
    ],
  };
}
