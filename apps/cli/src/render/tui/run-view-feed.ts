import type { RunRenderer } from '../renderer.js';
import { createRunStore, type RunStore, type RunStoreController } from './run-store.js';
import { FRAME_MS } from './tui-constants.js';

/**
 * Where a hosted leg's events go so the Home's run view can show them
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3): the run host's `renderer` option and the
 * view's `runStore` lookup, over one shared store per leg. It is the Home's counterpart of the shell's ink renderer, minus the mount: the
 * store is the same pure `createRunStore` and the view is the same `RunApp`, painted by the Home's one ink tree instead of a tree of its
 * own, so the two cannot show a run differently.
 *
 * - **One reader per leg.** The leg's single event reader folds into the store whether or not the view is open, so a view opened late
 *   shows everything the leg did.
 * - **The newest leg of a run only.** A resumed run starts a new store; the older leg's frame loop is already stopped by then, and its
 *   store is dropped. Nothing here grows with the number of runs.
 * - **A frame loop only while a leg runs.** The store coalesces token bursts to a frame tick; the tick is unreferenced, and `finalize`
 *   and `seal` stop it, so a finished or sealed leg holds no timer.
 */
export interface RunViewFeed {
  /** The run host's `renderer` option: one reader sink per leg. */
  readonly renderer: (leg: { readonly runId: string }) => RunRenderer;
  /** The live output of the newest leg of `runId`, or `undefined` when this Home has not hosted it. */
  readonly storeFor: (runId: string) => RunStore | undefined;
}

export interface RunViewFeedOptions {
  /** Colour on the live output (`false` under `--no-color`); read when a leg starts, so a late decision still applies. */
  readonly color: () => boolean;
  /** The frame loop's timer; a test injects its own. Default `setInterval` with an unreferenced handle. */
  readonly everyFrame?: ((tick: () => void) => () => void) | undefined;
}

function frameLoop(tick: () => void): () => void {
  const timer = setInterval(tick, FRAME_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export function createRunViewFeed(options: RunViewFeedOptions): RunViewFeed {
  const everyFrame = options.everyFrame ?? frameLoop;
  let current:
    | { readonly runId: string; readonly store: RunStoreController; readonly stop: () => void }
    | undefined;
  return {
    renderer: ({ runId }) => {
      current?.stop();
      const store = createRunStore(options.color());
      let stop: () => void = () => undefined;
      let sealed = false;
      const halt = (): void => {
        sealed = true;
        stop();
        stop = () => undefined;
      };
      stop = everyFrame(() => {
        store.tick();
      });
      current = { runId, store, stop: halt };
      return {
        onEvent: (event) => {
          if (!sealed) store.apply(event);
        },
        seal: halt,
        finalize: () => {
          store.flush(); // the last frame, so the card's live output shows how the leg ended
          halt();
        },
      };
    },
    storeFor: (runId) => (current?.runId === runId ? current.store : undefined),
  };
}
