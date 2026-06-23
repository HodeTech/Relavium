import type { RunEvent } from '@relavium/shared';

import { renderFinalSummary } from './final-summary.js';
import { initialRunViewState, reduceRunEvent, type RunViewState } from './run-view-model.js';

/**
 * The `ink` TUI's external store (workstream **2.E**) — **ink-free** so its full behavior (event reduction,
 * the throttle decision, snapshot stability, the final summary) is unit-tested without mounting React. The
 * thin `ink-renderer.ts` wires this store to `ink`'s render loop; the `RunApp` component projects it via
 * `useSyncExternalStore`.
 *
 * Throttle model: lifecycle/terminal events flush a repaint immediately (they feel instant); `agent:token`
 * / `cost:updated` bursts only mark the store **dirty** and are coalesced into the next `tick()` (the frame
 * loop) — so a high token rate never floods React, yet **no event is dropped** (each is reduced into the
 * bounded view model, only the repaint rate is capped).
 */

/** The immutable snapshot the `ink` component reads each frame (a stable reference between flushes). */
export interface RunStoreSnapshot {
  readonly state: RunViewState;
  readonly tick: number;
  readonly color: boolean;
}

/** The read surface `RunApp` subscribes to via `useSyncExternalStore`. */
export interface RunStore {
  subscribe: (onStoreChange: () => void) => () => void;
  getSnapshot: () => RunStoreSnapshot;
}

/** The store plus the control surface the renderer's frame loop drives. */
export interface RunStoreController extends RunStore {
  /** Reduce an event; flush immediately for a lifecycle/terminal event, else mark dirty (coalesced). */
  apply: (event: RunEvent) => void;
  /** Advance the spinner tick; repaint if there is pending (dirty) state or a node is animating. */
  tick: () => void;
  /** Force a repaint (used on finalize to paint the last frame). */
  flush: () => void;
  /** The persistent plain-text final summary for after-unmount output. */
  summaryText: () => string;
}

export function createRunStore(color: boolean): RunStoreController {
  const listeners = new Set<() => void>();
  let state = initialRunViewState();
  let tickCount = 0;
  let dirty = false;
  let snapshot: RunStoreSnapshot = { state, tick: tickCount, color };

  const flush = (): void => {
    snapshot = { state, tick: tickCount, color };
    for (const listener of listeners) {
      listener();
    }
    dirty = false;
  };

  const hasRunningNode = (): boolean =>
    state.nodeOrder.some((id) => state.nodes[id]?.status === 'running');

  return {
    subscribe: (onStoreChange) => {
      listeners.add(onStoreChange);
      return () => {
        listeners.delete(onStoreChange);
      };
    },
    getSnapshot: () => snapshot,
    apply: (event) => {
      state = reduceRunEvent(state, event);
      if (event.type === 'agent:token' || event.type === 'cost:updated') {
        dirty = true; // coalesced to the next frame — no flood, no drop
      } else {
        flush(); // status / terminal transitions repaint immediately
      }
    },
    tick: () => {
      tickCount += 1;
      if (dirty || hasRunningNode()) {
        flush();
      }
    },
    flush,
    summaryText: () => renderFinalSummary(state),
  };
}
