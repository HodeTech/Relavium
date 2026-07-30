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
 * @param fallback what this run contributes when its log cannot be read
 * @param read the per-run read
 */
export function readPerRunOrDegrade<T>(fallback: T, read: () => T): T {
  try {
    return read();
  } catch (err) {
    if (isCorruptRunEventError(err)) {
      return fallback;
    }
    throw err;
  }
}
