/**
 * The `/cost` popup's state machine ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6, [MVP-11 §4.4](../../../../docs/roadmap/phases/mvp-11.md#44-reports-and-settings-as-popups)): what is read when, what each key does and
 * what the confirmed release does. Loaded only when the person first opens a report (`report-port.ts`); its words are `cost-popup.ts`.
 *
 * **Reading.** The session's spend (a query of the database and a look at the live governor) is read in work the popup starts, after one
 * macrotask, entered on the work owner and never while a frame is drawn; the step says `loading` until it lands, and a fault is a state of its
 * own by CODE only (a database error can carry a path) and goes to the owner. Every result carries the popup's run (`PopupContext`), so one
 * for a popup that is closed or replaced lands nowhere. When it lands the report offers `[r]` only if something is held.
 *
 * **Releasing is a confirmed step, and the answer re-checks what it was asked for.** `[r]` (or a typed `/cost --release`, which opens ON the
 * step) shows a confirmation line answered only by `Ctrl+Y` through the popup host's chord guard (the doctor's own machinery: nothing here adds
 * a guard or removes one). At the answer, and only then, this module:
 *
 * 1. asks the host AGAIN whether a turn, a submit, a `!` command or a native action is in flight (`turnInFlight`, the facts the host's open
 *    gate reads). The popup owns the keyboard, so none can start behind it, but a line that was drawn before the answer is not evidence for
 *    it: if one is running the answer releases NOTHING and says so;
 * 2. otherwise calls the port's release ONCE, in ONE synchronous section with that check: the durable record, then the live governor
 *    (`releaseHeldEstimates`, exactly the two calls and the order `/cost --release` has always had);
 * 3. goes to a persistent result step (`Released ~$X back to the cap.` and the total read again) that `Enter` and `Esc` close.
 *
 * Nothing is written into the transcript or any notice. **Why this release is safe against a turn that started before the popup opened**
 * (the finding of MVP-11 step 4b): the popup cannot open over one (the host's
 * open gate), none can start behind it (it owns the keyboard), and the answer asks again (above). Behind those three, the release itself
 * cannot clear the money of an attempt that has not settled: the governor keeps an in-flight attempt's reservation apart from the committed
 * estimates a release clears (`BudgetGovernor.releaseConservativeCommitments`), and the one window between a commitment made in memory and
 * the same commitment written is a synchronous write inside a microtask chain, drained before the next key can arrive.
 */

import type { PopupContext, PopupHandlers, PopupOpenResult } from './popup-host.js';
import {
  COST_STEP,
  costControls,
  costReportContent,
  costSpec,
  releaseContent,
  releaseDoneContent,
  releaseFailedContent,
  releaseRefusedText,
  TURN_IN_FLIGHT_NOTICE,
  turnInFlightContent,
} from './cost-popup.js';
import { type CostPort, type CostReading, type ReportOpenRequest } from './report-port.js';
import { faultCode, macrotask, startReportWork } from './report-work.js';

/** What the report says when the session's cost cannot be read: the fault's CODE, never its message. */
export function costReadFailedContent(cause: unknown) {
  return {
    kind: 'error' as const,
    what: `Could not read the session cost: ${faultCode(cause)}`,
    next: 'Close this and try again.',
  };
}

/** Open the `/cost` popup (or, with `request.line.release`, ON its release step) over `request.host`; see the module header. */
export function openCostPopup(request: ReportOpenRequest, cost: CostPort): PopupOpenResult {
  const { host, port } = request;
  const pause = request.yieldToLoop ?? macrotask;
  const onRelease = request.line.release === true;
  let reading: CostReading | undefined;
  let released = false;
  let generation = 0;

  /** The report and the release step from a reading that has landed; `[r]` is offered only if something is held. */
  const land = (context: PopupContext, landed: CostReading): void => {
    reading = landed;
    context.setContent(COST_STEP.cost, costReportContent(landed), costControls(landed));
    context.setContent(COST_STEP.release, releaseContent(landed));
  };

  const failedRead = (context: PopupContext, cause: unknown): void => {
    context.setContent(COST_STEP.cost, costReadFailedContent(cause), []);
    context.setContent(COST_STEP.release, costReadFailedContent(cause));
  };

  /** Read the session's spend in the popup's own work, then land it. */
  const load = (context: PopupContext): void => {
    generation += 1;
    const mine = generation;
    const live = (): boolean => !context.signal.aborted && generation === mine;
    startReportWork(
      port.workOwner,
      async () => {
        await pause();
        if (!live()) return;
        const read = await cost.read();
        if (!live()) return;
        land(context, read);
      },
      (cause) => {
        if (live()) failedRead(context, cause);
      },
    );
  };

  /** After a release: the session's total read again, put under the released line when it lands. A fault of this read leaves the line as it is. */
  const refresh = (
    context: PopupContext,
    outcome: Parameters<typeof releaseDoneContent>[0],
  ): void => {
    const live = (): boolean => !context.signal.aborted;
    startReportWork(
      port.workOwner,
      async () => {
        await pause();
        if (!live()) return;
        const after = await cost.read();
        if (!live()) return;
        context.setContent(COST_STEP.done, releaseDoneContent(outcome, after));
      },
      () => undefined,
    );
  };

  const handlers: PopupHandlers = {
    control: (context, key) => {
      if (key !== 'r' || context.stepIndex() !== COST_STEP.cost) return;
      // Offered only when something is held, and the report only lists the control then: a key the report does not list never gets here.
      if (reading !== undefined) context.goToStep(COST_STEP.release);
    },
    chord: (context) => {
      if (released) return;
      // The answer re-checks the facts the release depends on: nothing is released while anything is in flight.
      if (request.turnInFlight()) {
        context.setContent(COST_STEP.release, turnInFlightContent());
        context.notify(TURN_IN_FLIGHT_NOTICE);
        return;
      }
      released = true;
      let outcome: ReturnType<CostPort['release']>;
      try {
        // The durable record, then the live governor: one call of the port, one synchronous section with the check above.
        outcome = cost.release();
      } catch (cause) {
        port.workOwner?.failure(cause);
        context.setContent(COST_STEP.done, releaseFailedContent());
        context.goToStep(COST_STEP.done);
        return;
      }
      context.setContent(COST_STEP.done, releaseDoneContent(outcome, undefined));
      context.goToStep(COST_STEP.done);
      refresh(context, outcome);
    },
    chordRefused: (context, reason) => {
      // Not an answer: the host disarmed the line. The person is told that nothing was released, and why.
      context.notify(releaseRefusedText(reason));
    },
    enter: (context) => {
      // The result step is final: `Enter` closes it as `Esc` does.
      if (context.stepIndex() === COST_STEP.done) context.close();
    },
  };

  const opened = host.openForUser(costSpec(request.origin, onRelease), handlers);
  if (!opened.opened) return opened;
  load(opened.context);
  return opened;
}
