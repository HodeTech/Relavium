import { isCorruptRunEventError } from '@relavium/db';

/**
 * Bound one damaged run's blast radius to that run.
 *
 * Three surfaces fan a per-run event read out over MANY runs — the Home's gate detection
 * (`home-store.ts`), `relavium status`, and the no-arg `relavium gate list`. Each loops with no per-run
 * isolation, so a single unreadable row in a single run threw straight out of the aggregation: the Home never
 * mounted at all, and `status` / `gate list` printed nothing. One corrupt row in one of twenty runs took away
 * every run, including the nineteen healthy ones, with no command in the CLI able to repair or delete it.
 *
 * That is the wrong trade. The damaged run is already lost — its log cannot be read, so it cannot be resumed
 * either — but the other nineteen are fine, and the listing is exactly where a user would go to find out which
 * run is broken. So a {@link isCorruptRunEventError} from ONE run degrades that run's detail and the aggregation
 * continues.
 *
 * Deliberately narrow in two ways. It catches **only** the typed corruption error — any other throw (a closed
 * db handle, an out-of-memory, a programming fault) still propagates, because those are not per-run conditions
 * and swallowing them would hide a real failure. And it is for READS whose absence degrades gracefully; it is
 * NOT for the resume path, where a run's log failing to read must fail loudly rather than resume a run from a
 * partial fold (`checkpointer.ts` / `gate.ts` keep their own strict handling).
 *
 * It returns the DEGRADATION alongside the value (#W15-15). Returning only the fallback made a damaged run
 * indistinguishable from a healthy empty one: `gate list` printed "No pending human gates." for a run whose
 * gates had been lost, and the Home showed it as an ordinary run with nothing to do. "I could not read this"
 * and "there is nothing here" are different answers, and a listing is exactly where a user goes to find out
 * which run is broken — so every caller has to decide how to say so rather than being handed silence.
 *
 * @param fallback what this run contributes when its log cannot be read
 * @param read the per-run read
 */
export function readPerRunOrDegrade<T>(fallback: T, read: () => T): PerRunRead<T> {
  try {
    return { value: read(), degraded: false };
  } catch (err) {
    if (isCorruptRunEventError(err)) {
      return { value: fallback, degraded: true };
    }
    throw err;
  }
}

/** One per-run read's outcome: the value, plus whether it is real data or the degraded fallback. */
export interface PerRunRead<T> {
  /** The read's result, or `fallback` when {@link degraded}. */
  readonly value: T;
  /** `true` when this run's event log could not be read — the value is a stand-in, not an answer. */
  readonly degraded: boolean;
}
