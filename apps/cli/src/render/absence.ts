/**
 * The words the Home's run pages use for what is absent ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2 and §4, MVP-8 step 4): one fixed sentence for each way a figure, a trace or an output can be missing, so a page never says `0` or
 * leaves a blank where it means "nothing was recorded", and never says two different things with one word.
 *
 * **One home.** The reference lists them in [the Home's "Words for what is absent"](../../../../docs/reference/cli/home.md#words-for-what-is-absent),
 * and this module is the only place the code spells them: the run detail's model (`history/run-detail-model.ts`), the node page's model
 * (`history/node-detail-model.ts`) and the tab host's lines (`render/tui/tab-host-history.ts`, `render/tui/tab-host-node.ts`) import these
 * constants and write no sentence of their own. `absence.test.ts` reads the reference and compares it with {@link ABSENCE_SENTENCES} and
 * {@link TOOL_OUTCOME_TEMPLATES} in both directions, so a sentence changed in one place and not the other fails a test.
 *
 * A sentence says what is known and no cause beyond it: `not recorded` is for a node that finished and whose figure was never written, and
 * is never used for a node that did not run, did not finish or is still going; each of those has its own.
 */

/** A node that finished (completed or failed) whose figure was never written: an older log, or no settled row and no step figure. */
export const NOT_RECORDED = 'not recorded';
/** A node that never started in a run that has ended: a skipped node, or a node an earlier failure kept from being reached. */
export const DID_NOT_RUN = 'did not run';
/** A node whose last attempt has no end event in a run that has ended (a decided gate, a node a failure killed). */
export const DID_NOT_FINISH = 'did not finish';
/** A node that is running in a run that has not ended. */
export const IN_PROGRESS = 'in progress';
/** A node of the frozen workflow that has no record at all in a run that has not ended: its turn has not come. */
export const NOT_YET_RUN = 'not yet run';
/** A tool trace on a node whose end event carries no trace field at all: the log was written before the field existed. */
export const NOT_RECORDED_OLDER_LOG = 'not recorded (older log)';
/** A tool trace on an attempt other than the one the node's end event closed. */
export const NOT_RECORDED_FOR_ATTEMPT = 'not recorded for this attempt';
/** One tool call in a trace that has no recorded result (the node ended before the call was answered, or the tool threw). */
export const NO_RESULT_RECORDED = 'no result recorded';
/** A node whose trace was recorded and is empty: it made no tool call. */
export const NO_TOOL_CALLS = 'no tool calls';
/** An attempt that failed: it produced no output to show. */
export const NO_OUTPUT = 'no output';
/** An output that was recorded and is the empty string: it exists and says nothing, which is not {@link NO_OUTPUT}. */
export const EMPTY_OUTPUT = '(empty)';
/** The word of a node the run passed over; its reason follows it, and every figure of the node says {@link DID_NOT_RUN}. */
export const SKIPPED = 'skipped';
/** A node page whose record could not be read (the attempt row is gone, or the run's log is damaged): nothing is guessed in its place. */
export const UNAVAILABLE = 'unavailable';

/** Every absence sentence, by what it says. The reference's table has exactly these, and the test compares them. */
export const ABSENCE_SENTENCES = {
  notRecorded: NOT_RECORDED,
  didNotRun: DID_NOT_RUN,
  didNotFinish: DID_NOT_FINISH,
  inProgress: IN_PROGRESS,
  notYetRun: NOT_YET_RUN,
  notRecordedOlderLog: NOT_RECORDED_OLDER_LOG,
  notRecordedForAttempt: NOT_RECORDED_FOR_ATTEMPT,
  noResultRecorded: NO_RESULT_RECORDED,
  noToolCalls: NO_TOOL_CALLS,
  noOutput: NO_OUTPUT,
  emptyOutput: EMPTY_OUTPUT,
  skipped: SKIPPED,
  unavailable: UNAVAILABLE,
} as const;

/** The placeholder a tool outcome template carries where the measured duration goes. */
export const DURATION_PLACEHOLDER = '<duration>';

/**
 * How one call of a tool trace ends, as the trace's row says it. `ok` and `refused` are whole; the other two carry the call's measured
 * duration at {@link DURATION_PLACEHOLDER}. The reference lists these four beside the absence sentences.
 */
export const TOOL_OUTCOME_TEMPLATES = {
  ok: 'ok',
  okIn: `ok in ${DURATION_PLACEHOLDER}`,
  refused: 'refused',
  failedAfter: `failed after ${DURATION_PLACEHOLDER}`,
} as const;

/** A template with the call's duration (already formatted by the caller) put where the placeholder is. */
function withDuration(template: string, duration: string): string {
  return template.replace(DURATION_PLACEHOLDER, duration);
}

/** `ok in 12ms`: a call that ran and was answered, with its measured duration. */
export function toolOkIn(duration: string): string {
  return withDuration(TOOL_OUTCOME_TEMPLATES.okIn, duration);
}

/** `failed after 340ms`: a call that ran and failed, with its measured duration. */
export function toolFailedAfter(duration: string): string {
  return withDuration(TOOL_OUTCOME_TEMPLATES.failedAfter, duration);
}
