/**
 * The in-chat `/export` popup's state machine ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6, §10; [MVP-11 OD-10](../../../../docs/roadmap/phases/mvp-11.md#72-decisions-od-1-to-od-23)): what is read when, what the confirmed
 * answer does. Loaded only when the person first types `/export` in an interactive chat (`report-port.ts`, `report-session.ts`); its words are
 * `export-popup.ts`.
 *
 * **Reading.** Where the export would write (the session's scaffold, the project's catalog and the files of its `workflows/`) is worked out in
 * work the popup starts, after one macrotask, entered on the work owner (`popup-work.ts`) and never while a frame is drawn. The step says
 * `loading` until it lands, and then offers its answer only while it is wholly on its page (the host's rule). A fault is a state of its own, in
 * the product's words (the port's `failure`), and goes to the owner.
 *
 * **The answer re-checks what it was asked for.** The line is answered only by `Ctrl+Y` through the popup host's chord guard (nothing here adds
 * a guard or removes one). At the answer, and only then, this module:
 *
 * 1. asks the host AGAIN whether a turn, a submit, a `!` command or a native action is in flight (`turnInFlight`): the scaffold is the durable
 *    transcript, so nothing is written while a turn could still be adding to it;
 * 2. works out the target AGAIN and compares it with the one the step showed: the file is what the person confirmed. If it is not the same file
 *    (or no longer the same kind of write) nothing is written and the result says so;
 * 3. otherwise writes ONCE, through the session's own `/export` (`exportSessionToProject`: never over another workflow, this session's own
 *    earlier export rewritten in place, the write pinned to the project's directory), in one synchronous section with the two checks above;
 * 4. goes to the persistent result step that `Enter` and `Esc` close: the file written, project-relative, or that nothing was and why.
 *
 * A `Ctrl+Y` that does not count (too soon, typed over, the line cut) disarms the line; it has no step to go back to, so the host closes the
 * popup, and what nothing was exported and why is said on the host's channel. Nothing is written into the transcript or any notice.
 */

import {
  EXPORT_STEP,
  EXPORT_TARGET_CHANGED,
  EXPORT_TURN_IN_FLIGHT,
  exportDoneContent,
  exportFailedContent,
  exportPrepareFailedContent,
  exportRefusedText,
  exportReviewContent,
  exportSpec,
} from './export-popup.js';
import type { PopupContext, PopupHandlers, PopupOpenResult } from './popup-host.js';
import { macrotask, startPopupWork } from './popup-work.js';
import type { ReportOpenRequest, SessionExportPort, SessionExportView } from './report-port.js';

/** Whether two views name the same write: the same file, and the same kind of write (a new file, or this session's earlier export). */
const sameWrite = (a: SessionExportView, b: SessionExportView): boolean =>
  a.target === b.target && a.overwrites === b.overwrites;

/** Open the `/export` popup over `request.host`; see the module header. */
export function openExportPopup(
  request: ReportOpenRequest,
  port: SessionExportPort,
): PopupOpenResult {
  const owner = request.port.workOwner;
  const pause = request.yieldToLoop ?? macrotask;
  /** What the confirmation shows now: absent while it loads or says the look failed (then nothing can be answered). */
  let shown: SessionExportView | undefined;

  const failed = (context: PopupContext, cause: unknown): void => {
    shown = undefined;
    context.setContent(EXPORT_STEP.review, exportPrepareFailedContent(port.failure(cause)));
  };

  /** Work out where the export would write, in the popup's own work, then show it. */
  const load = (context: PopupContext): void => {
    const live = (): boolean => !context.signal.aborted;
    startPopupWork(
      owner,
      async () => {
        await pause();
        if (!live()) return;
        const view = port.prepare();
        if (!live()) return;
        shown = view;
        context.setContent(EXPORT_STEP.review, exportReviewContent(view, port.review));
      },
      (cause) => {
        if (live()) failed(context, cause);
      },
    );
  };

  /** The result step, and the popup on it. */
  const finish = (context: PopupContext, content: Parameters<PopupContext['setContent']>[1]) => {
    context.setContent(EXPORT_STEP.done, content);
    context.goToStep(EXPORT_STEP.done);
  };

  const handlers: PopupHandlers = {
    chord: (context) => {
      // Every way through ends on the result step, which is no line: the host cannot hand this handler a second answer.
      // Nothing is written while a turn could still be adding to the transcript the scaffold is made from.
      if (request.turnInFlight()) {
        finish(context, { kind: 'error', ...EXPORT_TURN_IN_FLIGHT });
        return;
      }
      // The file is what the person confirmed: worked out again now, it must be the one the step showed, or nothing is written.
      let now: SessionExportView;
      try {
        now = port.prepare();
      } catch (cause) {
        owner?.failure(cause);
        finish(context, exportFailedContent(port.failure(cause)));
        return;
      }
      if (shown === undefined || !sameWrite(now, shown)) {
        finish(context, { kind: 'error', ...EXPORT_TARGET_CHANGED });
        return;
      }
      let written: { readonly target: string };
      try {
        written = port.commit();
      } catch (cause) {
        owner?.failure(cause);
        finish(context, exportFailedContent(port.failure(cause)));
        return;
      }
      finish(context, exportDoneContent(written.target));
    },
    chordRefused: (context, reason) => {
      // Not an answer: the host disarmed the line (and, with no step to go back to, closes the popup). The person is told why, nothing more.
      context.notify(exportRefusedText(reason));
    },
    // No `enter`: the result step is `final`, so the host closes it on `Enter` as on `Esc` (`popup-reducer.ts`).
  };

  const opened = request.host.openForUser(exportSpec(request.origin), handlers);
  if (!opened.opened) return opened;
  load(opened.context);
  return opened;
}
