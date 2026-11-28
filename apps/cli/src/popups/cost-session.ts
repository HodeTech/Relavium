/**
 * The `/cost` popup's state machine ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6, [MVP-11 §4.4](../../../../docs/roadmap/phases/mvp-11.md#44-reports-and-settings-as-popups)): what is read when, what each key does and
 * what the confirmed release does. Loaded only when the person first opens a report (`report-port.ts`); its words are `cost-popup.ts`.
 *
 * **Reading.** The session's spend (a query of the database and a look at the live governor) is read in work the popup starts, after one
 * macrotask, entered on the work owner (`popup-work.ts`) and never while a frame is drawn; the step says `loading` until it lands, and a fault is a state of its
 * own by CODE only (a database error can carry a path) and goes to the owner. Every result carries the popup's run (`PopupContext`), so one
 * for a popup that is closed or replaced lands nowhere. When it lands the report offers `[r]` only if something is held.
 *
 * **Releasing is a confirmed step, and the answer re-checks what it was asked for.** `[r]` (or a typed `/cost --release`, which opens ON the
 * step) READS AGAIN and offers the confirmation line only from that reading (a line built from the reading the popup opened with would name a
 * figure the answer no longer releases): the step says `loading` until it lands, and the figure it names is kept. The line is answered only by
 * `Ctrl+Y` through the popup host's chord guard (the same one the doctor's deep check answers through: nothing here adds a guard or removes one,
 * and the words of a refusal are `chord-refusal.ts`'s). At the answer, and only then, this module:
 *
 * 1. asks the host AGAIN whether a turn, a submit, a `!` command or a native action is in flight (`turnInFlight`, the facts the host's open
 *    gate reads). The popup owns the keyboard, so none can start behind it, but a line that was drawn before the answer is not evidence for
 *    it: if one is running the answer releases NOTHING and says so;
 * 2. reads the held amount AGAIN and compares it with the figure the line named: the amount is what the person confirmed, and a release clears
 *    whatever is held when it runs. If it is not the same figure the answer releases NOTHING, says so, and goes back to the report, read
 *    again, where `[r]` asks about the figure that is held now (a new reading, a line armed afresh, a new dwell). A read that fails, or that is
 *    not synchronous (it cannot be compared inside the one section below), is a failed read: nothing is released;
 * 3. otherwise calls the port's release ONCE, in ONE synchronous section with the two checks above: the durable record, then the live governor
 *    (`releaseHeldEstimates`, exactly the two calls and the order `/cost --release` has always had);
 * 4. goes to a persistent result step (`Released ~$X back to the cap.` and the total read again) that `Enter` and `Esc` close.
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
  COST_LOADING_CONTENT,
  COST_STEP,
  costControls,
  costReportContent,
  costReportLines,
  costSpec,
  HELD_CHANGED_NOTICE,
  heldMicrocents,
  releasable,
  releaseContent,
  releaseDoneContent,
  releaseFailedContent,
  releaseRefusedText,
  TURN_IN_FLIGHT_NOTICE,
  turnInFlightContent,
} from './cost-popup.js';
import { copyReport } from './popup-copy.js';
import { faultCode, macrotask, startPopupWork } from './popup-work.js';
import type { CostPort, CostReading, ReportOpenRequest } from './report-port.js';

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
  /** The figure the release step's confirmation line names, in micro-cents: absent while there is no line (loading, nothing held, a failed read). */
  let named: number | undefined;
  let released = false;
  let generation = 0;

  /** The report and the release step from a reading that has landed; `[r]` is offered only if something is held. */
  const land = (context: PopupContext, landed: CostReading): void => {
    reading = landed;
    named = releasable(landed) ? heldMicrocents(landed) : undefined;
    context.setContent(COST_STEP.cost, costReportContent(landed), costControls(landed));
    context.setContent(COST_STEP.release, releaseContent(landed));
  };

  const failedRead = (context: PopupContext, cause: unknown): void => {
    named = undefined;
    context.setContent(COST_STEP.cost, costReadFailedContent(cause), []);
    context.setContent(COST_STEP.release, costReadFailedContent(cause));
  };

  /** Read the session's spend in the popup's own work, then land it. */
  const load = (context: PopupContext): void => {
    generation += 1;
    const mine = generation;
    const live = (): boolean => !context.signal.aborted && generation === mine;
    startPopupWork(
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
    startPopupWork(
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

  /**
   * The held amount, read now and synchronously, for the answer's comparison with {@link named}. A port whose read is not synchronous cannot be
   * compared inside the section the release is in, so it is a failed read (and its promise is not left to reject unhandled).
   */
  const heldAtTheAnswer = (): number => {
    const fresh = cost.read();
    if (fresh instanceof Promise) {
      void fresh.catch(() => undefined);
      throw new TypeError('the cost read did not answer synchronously');
    }
    return heldMicrocents(fresh);
  };

  const handlers: PopupHandlers = {
    control: (context, key) => {
      if (context.stepIndex() !== COST_STEP.cost || reading === undefined) return;
      // Each control is listed only when it applies (`[r]` when something is held, `[c]` when a reading has landed), and the report lists no
      // control while it loads or says the read failed: a key the step does not list never gets here.
      // The line is made from a reading taken NOW, never from the one the popup opened with: what is held moves while the popup is open (a turn
      // that finished since commits its estimates), and `Ctrl+Y` releases what is held at its answer. An earlier answer that found a turn
      // running left the step on its empty state, and that state must not outlive the turn: the step is `loading` until the new line lands.
      if (key === 'r') {
        named = undefined;
        context.setContent(COST_STEP.release, COST_LOADING_CONTENT);
        context.goToStep(COST_STEP.release);
        load(context);
      }
      // The report as it is at this moment: the lines of the reading the step shows, which is what is drawn.
      else if (key === 'c') copyReport(context, port, 'Cost', costReportLines(reading));
    },
    chord: (context) => {
      if (released) return;
      // The answer re-checks the facts the release depends on: nothing is released while anything is in flight.
      if (request.turnInFlight()) {
        context.setContent(COST_STEP.release, turnInFlightContent());
        context.notify(TURN_IN_FLIGHT_NOTICE);
        return;
      }
      // The amount is what the person confirmed: the held amount read now must be the figure the line named, or nothing is released.
      let heldNow: number;
      try {
        heldNow = heldAtTheAnswer();
      } catch (cause) {
        port.workOwner?.failure(cause);
        failedRead(context, cause);
        return;
      }
      if (heldNow !== named) {
        // The line is gone and the report behind it is read again: `[r]` then asks about the figure that is held now, on a line armed afresh
        // (a line the host has answered once cannot be answered again, whatever it says: the answer was evidence against it).
        named = undefined;
        context.setContent(COST_STEP.release, COST_LOADING_CONTENT);
        context.setContent(COST_STEP.cost, COST_LOADING_CONTENT, []);
        context.goToStep(COST_STEP.cost);
        context.notify(HELD_CHANGED_NOTICE);
        load(context);
        return;
      }
      released = true;
      let outcome: ReturnType<CostPort['release']>;
      try {
        // The durable record, then the live governor: one call of the port, one synchronous section with the checks above.
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
    // No `enter`: the result step is `final`, so the host closes it on `Enter` as on `Esc` (`popup-reducer.ts`).
  };

  const opened = host.openForUser(costSpec(request.origin, onRelease), handlers);
  if (!opened.opened) return opened;
  load(opened.context);
  return opened;
}
