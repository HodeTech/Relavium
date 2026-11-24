import type { RunHistoryReader, RunStateEventsRead } from '@relavium/db';

/**
 * The most run ids one batched state-event read takes. It is the store's own bound
 * (`MAX_RUN_STATE_EVENT_BATCH_IDS`): the store refuses more, so a listing reads in chunks of this size.
 */
export const STATE_EVENT_BATCH_RUNS = 200;

/**
 * The state-event reads of many runs, batched through `loadRunStateEventsForRuns` in chunks the store accepts.
 *
 * It only ever SAVES reads; it never changes an answer. A run is present in the map only when its batched
 * answer is healthy (`{ events }`). A run whose answer is corrupt, a run a faulting chunk did not answer, and a
 * run that was never requested are all ABSENT: the caller then reads that run the per-run way, which keeps the
 * exact degradation and error semantics the command had before the batch existed.
 */
export function batchedStateEvents(
  reader: Pick<RunHistoryReader, 'loadRunStateEventsForRuns'>,
  runIds: readonly string[],
): ReadonlyMap<string, RunStateEventsRead> {
  const healthy = new Map<string, RunStateEventsRead>();
  for (let start = 0; start < runIds.length; start += STATE_EVENT_BATCH_RUNS) {
    const chunk = runIds.slice(start, start + STATE_EVENT_BATCH_RUNS);
    let answers: ReadonlyMap<string, RunStateEventsRead>;
    try {
      answers = reader.loadRunStateEventsForRuns(chunk);
    } catch {
      // A faulting chunk is not an answer: its runs fall back to the per-run read, which reports the fault as before.
      continue;
    }
    for (const [runId, answer] of answers) {
      if ('events' in answer) healthy.set(runId, answer);
    }
  }
  return healthy;
}
