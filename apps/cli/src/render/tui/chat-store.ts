import type { SessionStreamHandleEvent } from '@relavium/core';

import { formatSessionFooter, sanitizeInline, stripTerminalControls } from './chat-projection.js';
import {
  appendNotice,
  appendUserMessage,
  appendWarning,
  initialSessionViewState,
  reduceSessionEvent,
  type SessionViewSeed,
  type SessionViewState,
} from './session-view-model.js';

/**
 * The `ink` chat REPL's external store (workstream **2.M**) — the session counterpart of `run-store.ts`
 * (2.E). **ink-free**, so its full behavior (event reduction, the throttle decision, snapshot stability) is
 * unit-tested without mounting React. The thin chat renderer wires this store to `ink`'s render loop; the
 * `ChatApp` component projects it via `useSyncExternalStore`.
 *
 * Throttle model (mirrors run-store): lifecycle events (`session:*`) and a user message flush a repaint
 * immediately (they feel instant); the high-frequency in-turn events (`agent:token` / `agent:tool_*` /
 * `cost:updated`) only mark the store **dirty** and are coalesced into the next `tick()` (the frame loop) —
 * so a fast-streaming turn never floods React, yet **no event is dropped** (each is reduced; only the repaint
 * rate is capped).
 */

/** The immutable snapshot the ink component reads each frame (a stable reference between flushes). */
export interface ChatStoreSnapshot {
  readonly state: SessionViewState;
  readonly tick: number;
  readonly color: boolean;
}

/** The read surface `ChatApp` subscribes to via `useSyncExternalStore`. */
export interface ChatStore {
  subscribe: (onStoreChange: () => void) => () => void;
  getSnapshot: () => ChatStoreSnapshot;
}

/** The store plus the control surface the renderer's frame loop + REPL drive. */
export interface ChatStoreController extends ChatStore {
  /** Reduce a session event; flush immediately for a lifecycle event, else mark dirty (coalesced). */
  apply: (event: SessionStreamHandleEvent) => void;
  /** Add the user's typed text as a transcript entry (REPL submit) — flushes immediately. */
  appendUser: (text: string) => void;
  /** Surface a one-line note in the ⚠ warnings channel (e.g. an MCP-skipped notice) — sanitized, flushes. */
  note: (message: string) => void;
  /** Append command output (e.g. `/workflows`, `/cost`) as a notice transcript entry — control sequences
   *  stripped (newlines kept for multi-line output), flushes immediately. */
  notice: (text: string) => void;
  /** Advance the spinner tick; repaint if there is pending (dirty) state or a turn is in flight. */
  tick: () => void;
  /** Force a repaint (used on finalize to paint the last frame). */
  flush: () => void;
  /** The persistent one-line session summary (model · cost · turns) for after-unmount output (Step-5 teardown). */
  summaryText: () => string;
}

/**
 * The high-frequency in-turn events whose repaints are coalesced to the next frame (a fast-streaming or
 * tool-heavy turn emits these in bursts). The `session:*` lifecycle events are NOT here — they repaint
 * immediately so a turn boundary / cancel feels instant.
 */
const HIGH_FREQUENCY_EVENTS: ReadonlySet<SessionStreamHandleEvent['type']> = new Set([
  'agent:token',
  'agent:tool_call',
  'agent:tool_result',
  'cost:updated',
]);

export function createChatStore(color: boolean, seed?: SessionViewSeed): ChatStoreController {
  const listeners = new Set<() => void>();
  let state = initialSessionViewState(seed);
  let tickCount = 0;
  let dirty = false;
  let snapshot: ChatStoreSnapshot = { state, tick: tickCount, color };

  const flush = (): void => {
    snapshot = { state, tick: tickCount, color };
    for (const listener of listeners) {
      listener();
    }
    dirty = false;
  };

  return {
    subscribe: (onStoreChange) => {
      listeners.add(onStoreChange);
      return () => {
        listeners.delete(onStoreChange);
      };
    },
    getSnapshot: () => snapshot,
    apply: (event) => {
      state = reduceSessionEvent(state, event);
      if (HIGH_FREQUENCY_EVENTS.has(event.type)) {
        dirty = true; // coalesced to the next frame — no flood, no drop
      } else {
        flush(); // session lifecycle transitions repaint immediately
      }
    },
    appendUser: (text) => {
      state = appendUserMessage(state, text);
      flush();
    },
    note: (message) => {
      state = appendWarning(state, sanitizeInline(message)); // sanitized — a config-derived note can't inject ANSI
      flush();
    },
    notice: (text) => {
      // Strip control sequences (keep intended newlines) — command output can't inject ANSI/OSC into the view.
      state = appendNotice(state, stripTerminalControls(text));
      flush();
    },
    tick: () => {
      tickCount += 1;
      // Repaint when there is coalesced state OR a turn is streaming (so the spinner animates live).
      if (dirty || state.status === 'running') {
        flush();
      }
    },
    flush,
    summaryText: () => formatSessionFooter(state),
  };
}
