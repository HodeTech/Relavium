import type { SessionStreamHandleEvent, ToolApprovalRequest } from '@relavium/core';

import {
  DEFAULT_CHAT_MODE,
  type ApprovalAnswer,
  type ApprovalPrompt,
  type ChatMode,
} from '../../chat/chat-mode.js';
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

/** A pending per-tool approval the REPL renders as a `[a]/[r]/[c]` prompt (ADR-0057, EA3/EA5). */
export interface PendingApproval {
  readonly request: ToolApprovalRequest;
  /** Whether an "always" answer will be remembered (accept-edits) — the prompt greys it out when false. */
  readonly cacheable: boolean;
}

/** The immutable snapshot the ink component reads each frame (a stable reference between flushes). */
export interface ChatStoreSnapshot {
  readonly state: SessionViewState;
  /** The active chat mode (ADR-0057) — REPL-set (Shift+Tab / `/mode`), shown in the footer. */
  readonly mode: ChatMode;
  /** The in-flight approval prompt, if a governed tool dispatch is awaiting the user's decision. */
  readonly approval: PendingApproval | undefined;
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
  /** Set the active chat mode (Shift+Tab / `/mode`) — updates the footer; the caller also re-applies the turn
   *  policy via `applyChatMode`. Flushes immediately (a mode switch feels instant). */
  setMode: (mode: ChatMode) => void;
  /**
   * The {@link ApprovalPrompt} the mode controller injects: publish a pending approval (flush → the REPL
   * renders the prompt) and RESOLVE when the input handler calls {@link answerApproval}. Honors the abort
   * signal — an abort while pending REJECTS with the signal's reason so the dispatch routes to the engine's
   * cancel path (not a denial). At most ONE approval is pending at a time (the turn blocks on it).
   */
  requestApproval: ApprovalPrompt;
  /** Answer the in-flight approval (the input handler's `[a]/[r]/[c]` decision) — a no-op if none is pending. */
  answerApproval: (answer: ApprovalAnswer) => void;
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
  let mode: ChatMode = DEFAULT_CHAT_MODE;
  let approval: PendingApproval | undefined;
  // The resolver for the in-flight approval promise (set while `approval` is published; cleared on settle).
  let settleApproval: ((answer: ApprovalAnswer) => void) | undefined;
  let tickCount = 0;
  let dirty = false;
  let snapshot: ChatStoreSnapshot = { state, mode, approval, tick: tickCount, color };

  const flush = (): void => {
    snapshot = { state, mode, approval, tick: tickCount, color };
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
    setMode: (next) => {
      mode = next;
      flush();
    },
    requestApproval: (request, cacheable, signal) =>
      new Promise<ApprovalAnswer>((resolve, reject) => {
        // Honor an already-aborted turn: reject with an AbortError so the dispatch routes to cancel, not deny.
        if (signal?.aborted === true) {
          reject(abortError());
          return;
        }
        const clear = (): void => {
          approval = undefined;
          settleApproval = undefined;
          signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = (): void => {
          // An abort while the prompt is pending is a CANCEL, not a denial — reject with an AbortError; the
          // registry's confirmDispatch re-throws an abort (cancel precedence: ctx.signal.aborted OR an
          // `AbortError`-named cause) rather than denying.
          clear();
          reject(abortError());
          flush();
        };
        settleApproval = (answer) => {
          clear();
          resolve(answer);
        };
        approval = { request, cacheable };
        signal?.addEventListener('abort', onAbort);
        flush(); // render the [a]/[r]/[c] prompt
      }),
    answerApproval: (answer) => {
      // A no-op if nothing is pending (a stray keypress); else settle the in-flight promise + repaint.
      if (settleApproval === undefined) return;
      settleApproval(answer);
      flush();
    },
  };
}

/** An `AbortError`-named error so a pending-approval rejection is classified as a CANCEL by the registry's
 *  `isAbort` (which also accepts `cause.name === 'AbortError'`), never as a denial. */
function abortError(): Error {
  const err = new Error('the approval was aborted');
  err.name = 'AbortError';
  return err;
}
