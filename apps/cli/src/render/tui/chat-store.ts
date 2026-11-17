import {
  plainTextRefusal,
  ASK_USER_BOUNDS,
  type AskUserAnswer,
  type AskUserRequest,
  type SessionStreamHandleEvent,
  type ToolApprovalRequest,
  type ToolApprovalLiveContext,
  type ToolLiveEvent,
} from '@relavium/core';

import { createReviewDocument, reviewBytes, type ReviewPage } from './tool-review-projection.js';
import {
  approvalKeyRefusal,
  APPROVAL_CONFIRM_MAX_MS,
  APPROVAL_CONFIRM_MIN_MS,
  initialToolReview,
  isAffirmativeReviewKey,
  isAlwaysConfirmKey,
  isTypingIntoReview,
  acknowledgeToolReview,
  reduceToolReviewKey,
  resolveApprovalGuard,
  type ApprovalGuard,
  type ApprovalRefusal,
  type ReviewKeyAction,
  type ToolReviewState,
} from './tool-review-model.js';
import { CARD_LOCKOUT_NOTE, CARD_TYPEAHEAD_NOTE } from './tool-review-card.js';
import type { ToolDisplay } from './tool-display.js';
import {
  initialQuestionCard,
  pasteIntoQuestion,
  QUESTION_SETTLE_MS,
  reduceQuestionKey,
  type QuestionCardState,
} from './question-card-model.js';
import { questionTranscriptText } from './question-card-record.js';
import type { ChatKey } from './chat-input.js';
import { sanitizeUntrustedInline } from '../sanitize.js';
import type { AbortSignalLike, Memory, ReasoningEffort } from '@relavium/shared';
import { MarkdownStream } from '../markdown/index.js';
import { TerminalStream } from '../terminal-stream.js';

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
  approvalClosed,
  approvalOpened,
  initialSessionViewState,
  reduceSessionEvent,
  reduceToolLiveEvent,
  type SessionViewSeed,
  type SessionViewState,
  type TranscriptBound,
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

/** A pending per-tool approval the REPL renders as a `Ctrl+Y yes / Ctrl+G always / Ctrl+N no / Ctrl+R reason / [esc] abort`
 *  prompt (ADR-0057, EA3/EA5). `[c]` opens the typed-reason capture (Step 14) — a reject carrying WHY, via the
 *  `ToolApprovalDecision.reject.reason` seam. */
export interface PendingApproval {
  readonly request: ToolApprovalRequest;
  readonly live?: ToolApprovalLiveContext;
  /** Whether an "always" answer will be remembered (accept-edits) — the prompt greys it out when false. */
  readonly cacheable: boolean;
}

/** The immutable snapshot the ink component reads each frame (a stable reference between flushes). */
export interface ChatStoreSnapshot {
  readonly markdown: Pick<MarkdownStream, 'tail' | 'plainTail' | 'sourceTail' | 'elided'>;
  readonly displaySuspended: boolean;
  readonly state: SessionViewState;
  /** The active chat mode (ADR-0057) — REPL-set (Shift+Tab / `/mode`), shown in the footer. */
  readonly mode: ChatMode;
  /**
   * The session's active reasoning-effort tier ([ADR-0066](../../../../docs/decisions/0066-normalized-reasoning-effort-control.md))
   * — the effective `session-override → agent` tier, shown in the footer (parity with `mode`) and read by the
   * `/models` effort sub-list + `/effort`. Present only when the bound model is reasoning-capable (a non-reasoning
   * model has no controllable tier), so the footer never shows an inert effort. `undefined` ⇒ no tier / not capable.
   */
  readonly reasoningEffort: ReasoningEffort | undefined;
  /** Whether the collapsible "thinking" panel is EXPANDED (2.5.H) — a session-scoped UI toggle (default collapsed),
   *  flipped by `/thinking` + `Ctrl+T`. Independent of whether the turn actually streamed reasoning (the panel is
   *  only rendered when `state.liveReasoning` is non-empty); this is purely the show/hide preference. */
  readonly reasoningVisible: boolean;
  /** The in-flight approval prompt, if a governed tool dispatch is awaiting the user's decision. */
  readonly approval: PendingApproval | undefined;
  readonly review: ToolReviewState | undefined;
  /**
   * The first `Ctrl+G` of the session-wide grant was pressed and the card waits for ENTER (PR #99 corrective sitting G1, security
   * sitting H1). Derived at each flush from the review it was asked on and the clock, so a resize, a screen change or a new
   * card — a new review object — or five seconds ends it without any bookkeeping at those places.
   */
  readonly alwaysConfirm: boolean;
  /**
   * The open `ask_user` card ([ADR-0132](../../../../../docs/decisions/0132-the-model-can-ask-the-user-a-structured-question.md)), if the
   * model asked the person a question. A NEW object on every change, so the measured-frame acknowledgement can tell one frame
   * of it from the next by identity.
   */
  readonly question: QuestionCardState | undefined;
  /**
   * Identity of the FRAME the question card is showing — a fresh object when the card opens, when it moves to its next question,
   * and when the terminal is resized or resumed from suspend. The measured-frame acknowledgement is keyed on it, so each of
   * those needs its own proof that the frame was flushed, and a blocked card recovers when the terminal grows.
   */
  readonly questionFrame: object | undefined;
  readonly toolDisplays: ReadonlyMap<string, ToolDisplay>;
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
  applyToolLiveEvent: (event: ToolLiveEvent) => void;
  sealToolPreviews: () => void;
  openDetails: () => void;
  closeDetails: () => void;
  invalidateToolReview: () => void;
  bindReviewVisibility: (visible: (() => boolean) | undefined) => void;
  bindReviewClipboard: (copy: ((text: string) => Promise<boolean>) | undefined) => void;
  acknowledgeReviewFrame: (review: ToolReviewState, page: ReviewPage | undefined) => void;
  handleReviewInput: (input: string, key: ChatKey) => 'abort' | 'handled' | undefined;

  /** Bind the frozen instance policy before the session receives input. */
  setMemoryPolicy: (memory: Readonly<Memory> | undefined) => void;
  /** Bind actual endpoint capacity; undefined deliberately clears a catalog alias. */
  setContextWindow?: (window: number | undefined) => void;
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
  /** Set the active reasoning-effort tier for the footer + the `/models`/`/effort` reads (ADR-0066) — `undefined`
   *  clears it (a non-reasoning model / no tier). The caller also pushes the session override via
   *  `AgentSession.setReasoningEffort`. Flushes immediately (an effort switch feels instant). */
  setReasoningEffort: (effort: ReasoningEffort | undefined) => void;
  /** Toggle the collapsible "thinking" panel's visibility (2.5.H — `/thinking` / `Ctrl+T`); flushes immediately (a
   *  toggle feels instant). A pure UI-view flip — no session/engine effect. */
  toggleReasoning: () => void;
  /** Idempotent command-finally fallback; every admitted compaction also has an engine terminal. */
  clearCompacting: () => void;
  /**
   * The {@link ApprovalPrompt} the mode controller injects: publish a pending approval (flush → the REPL
   * renders the prompt) and RESOLVE when the input handler calls {@link answerApproval}. Honors the abort
   * signal — an abort while pending REJECTS with the signal's reason so the dispatch routes to the engine's
   * cancel path (not a denial). At most ONE approval is pending at a time (the turn blocks on it).
   */
  requestApproval: ApprovalPrompt;
  /** Answer the in-flight approval (the input handler's `Ctrl+Y`/`Ctrl+G`/`Ctrl+N` decision) — a no-op if none is pending. */
  answerApproval: (answer: ApprovalAnswer) => void;
  /**
   * The `ask_user` delegate the session is given on an interactive driver (ADR-0132): publish the question card and RESOLVE with
   * the person's answer or a skip. Honors the abort signal — a stop while pending REJECTS with an `AbortError` so the call is
   * recorded cancelled, never resolved as a skip — and so does a sealed store. At most one overlay is pending at a time.
   */
  requestQuestion: (request: AskUserRequest, signal?: AbortSignalLike) => Promise<AskUserAnswer>;
  /** Insert a bracketed paste into the open question's own-answer field; `true` when a question is open (the paste is consumed). */
  pasteIntoQuestion: (text: string) => boolean;
  /** Bind whether the question card's exact frame has been acknowledged visible (the host component owns the measurement). */
  bindQuestionVisibility: (visible: (() => boolean) | undefined) => void;
}

/**
 * The high-frequency in-turn events whose repaints are coalesced to the next frame (a fast-streaming or
 * tool-heavy turn emits these in bursts). The `session:*` lifecycle events are NOT here — they repaint
 * immediately so a turn boundary / cancel feels instant.
 */
const HIGH_FREQUENCY_EVENTS: ReadonlySet<SessionStreamHandleEvent['type']> = new Set([
  'agent:token',
  'agent:reasoning', // EA6 (2.5.H) — a per-reasoning_delta firehose like agent:token; coalesce its repaints
  'agent:tool_call',
  'agent:tool_result',
  'cost:updated',
]);

/** What a caller may tune. Production passes nothing: only a test isolates one guard or switches both off. */
export interface ChatStoreOptions {
  /**
   * What an affirmative approval key must clear (default: the product's real numbers; a layer left out keeps its real value,
   * `0` — or `confirmAlways: false` — switches one off).
   */
  readonly approvalGuard?: ApprovalGuard;
}

/**
 * @param transcriptBound the RENDERER-injected bound on the text a completed turn bakes into the transcript
 *   (ADR-0068 Decision (c)). `FULLSCREEN_TRANSCRIPT_BOUND` in the alt-screen viewport, `INLINE_TRANSCRIPT_BOUND`
 *   otherwise. REQUIRED, and its type is CLOSED ({@link TranscriptBound}) — deliberately, since 2.6.C: it used to
 *   default to the inline bound, which meant a full-screen caller who forgot the argument silently lost the carried
 *   transcript and rendered a blank viewport, with no type error (F1, from the caller's side). Forgetting it — or
 *   inventing a third bound — is now a compile error. Do not restore a default.
 */
export function createChatStore(
  color: boolean,
  seed: SessionViewSeed | undefined,
  transcriptBound: TranscriptBound,
  options?: ChatStoreOptions,
): ChatStoreController {
  const listeners = new Set<() => void>();
  const markdown = new MarkdownStream();
  const terminal = new TerminalStream();
  let state = initialSessionViewState(seed, transcriptBound);
  let mode: ChatMode = DEFAULT_CHAT_MODE;
  let reasoningEffort: ReasoningEffort | undefined;
  let reasoningVisible = false; // the "thinking" panel is collapsed by default (2.5.H); `/thinking` / Ctrl+T flips it
  let approval: PendingApproval | undefined;
  // The resolver for the in-flight approval promise (set while `approval` is published; cleared on settle).
  let settleApproval: ((answer: ApprovalAnswer) => void) | undefined;
  // The open `ask_user` card and the settle pair of its pending promise (ADR-0132).
  let question: QuestionCardState | undefined;
  let pendingQuestion:
    | {
        readonly resolve: (answer: AskUserAnswer) => void;
        readonly reject: (reason: Error) => void;
      }
    | undefined;
  let questionVisible: (() => boolean) | undefined;
  let questionFrame: object | undefined;
  let questionFrameAt = 0;
  const mintQuestionFrame = (): void => {
    questionFrame = {};
    questionFrameAt = Date.now();
  };
  // A choosing key counts only once the frame is flushed AND has been on screen long enough to read (QUESTION_SETTLE_MS).
  const questionAcceptsKeys = (): boolean =>
    questionVisible?.() === true && Date.now() - questionFrameAt >= QUESTION_SETTLE_MS;
  let review: ToolReviewState | undefined;
  // What makes an affirmative approval key a DELIBERATE one (PR #99 security sitting E1 and the corrective sitting G1): the
  // review whose frame was acknowledged last and when, when the previous key of any kind arrived, when the last FOREIGN key
  // (one the card has no use for) arrived, and when a card was last resolved by a key. See `approvalKeyRefusal`. Every one
  // of these times is on the MONOTONIC clock (`performance.now()`): the wall clock can be stepped by NTP or by hand, which
  // would silence every answer (a step back) or let a key through the dwell (a step forward) — G3.
  const approvalGuard = resolveApprovalGuard(options?.approvalGuard);
  let acknowledgedReview: ToolReviewState | undefined;
  let acknowledgedAt = 0;
  let lastKeyAt = Number.NEGATIVE_INFINITY;
  let lastForeignKeyAt = Number.NEGATIVE_INFINITY;
  let lastResolvedAt = Number.NEGATIVE_INFINITY;
  // The session-wide grant is a two-step answer: the review the first `Ctrl+G` was pressed on and when. ENTER confirms it.
  let alwaysAsk: { readonly review: ToolReviewState; readonly at: number } | undefined;
  // Whether this card has already shown its one refusal note.
  let refusalNoted = false;
  const alwaysAsked = (now: number): boolean =>
    alwaysAsk !== undefined &&
    alwaysAsk.review === review &&
    now - alwaysAsk.at <= APPROVAL_CONFIRM_MAX_MS;
  let toolDisplays = new Map<string, ToolDisplay>();
  let sealed = false;
  let reviewVisible: (() => boolean) | undefined;
  let reviewClipboard: ((text: string) => Promise<boolean>) | undefined;
  let reviewPage: ReviewPage | undefined;
  let tickCount = 0;
  let dirty = false;
  let snapshot: ChatStoreSnapshot = {
    markdown,
    displaySuspended: false,
    state,
    mode,
    reasoningEffort,
    reasoningVisible,
    approval,
    review,
    alwaysConfirm: false,
    question,
    questionFrame,
    toolDisplays,
    tick: tickCount,
    color,
  };

  const flush = (): void => {
    snapshot = {
      state,
      mode,
      reasoningEffort,
      reasoningVisible,
      approval,
      review,
      alwaysConfirm: alwaysAsked(performance.now()),
      question,
      questionFrame,
      toolDisplays,
      tick: tickCount,
      color,
      markdown,
      displaySuspended: terminal.overflowed,
    };
    for (const listener of listeners) {
      listener();
    }
    dirty = false;
  };

  const copyReviewPage = (): void => {
    if (review === undefined) return;
    const expected = review;
    const document = review.document;
    if (document === undefined || reviewClipboard === undefined) {
      review = { ...review, message: 'Clipboard unavailable.' };
      flush();
      return;
    }
    if (reviewPage?.valid !== true) {
      review = { ...review, message: 'Review page unavailable — wait for a flushed frame.' };
      flush();
      return;
    }
    const masked = reviewPage.maskedRows.join('\n');
    void reviewClipboard(masked).then(
      (ok) => {
        if (review !== expected || sealed) return;
        review = {
          ...review,
          message: ok ? 'Masked page sent to terminal clipboard.' : 'Clipboard write failed.',
        };
        flush();
      },
      () => {
        if (review === expected && !sealed) {
          review = { ...review, message: 'Clipboard write failed.' };
          flush();
        }
      },
    );
  };

  const reconcileListSelection = (): void => {
    if (review?.screen !== 'list') return;
    const callId = review.callId ?? toolDisplays.keys().next().value;
    const selected = callId === undefined ? -1 : [...toolDisplays.keys()].indexOf(callId);
    review = selected < 0 ? undefined : { ...review, callId, selected };
    reviewPage = undefined;
  };

  const retainToolDisplays = (): void => {
    // Current consent/contents are pinned; list selection follows stable identity through eviction.
    const pinnedCallId = review?.screen === 'list' ? undefined : review?.callId;
    let bytes =
      (pinnedCallId === undefined ? 0 : toolDisplays.get(pinnedCallId)?.document?.sourceBytes) ?? 0;
    for (const [id, value] of [...toolDisplays].reverse()) {
      if (id === pinnedCallId) continue;
      const cost = value.document?.sourceBytes ?? 0;
      if (bytes + cost > 32 * 1024 * 1024) {
        const summary = { ...value };
        delete summary.document;
        toolDisplays.set(id, summary);
      } else bytes += cost;
    }
    while (toolDisplays.size > 64) {
      const id = [...toolDisplays.keys()].find((key) => key !== pinnedCallId);
      if (id === undefined) break;
      toolDisplays.delete(id);
    }
    reconcileListSelection();
  };

  const transitionReviewState = (
    previous: ToolReviewState,
    next: ToolReviewState,
    calls: readonly ToolDisplay[],
  ): ToolReviewState => {
    if (next.screen !== 'list') return next;
    return {
      ...next,
      callId: previous.screen === 'list' ? calls[next.selected]?.callId : previous.callId,
      selected:
        previous.screen === 'list'
          ? next.selected
          : calls.findIndex((call) => call.callId === previous.callId),
    };
  };

  /** Settle the open question with the person's answer (or a skip) and leave a record of it in the transcript. */
  const settleQuestionWith = (answer: AskUserAnswer): void => {
    const open = question;
    const settling = pendingQuestion;
    if (open === undefined || settling === undefined) return;
    question = undefined;
    questionFrame = undefined;
    pendingQuestion = undefined;
    state = approvalClosed(state, Date.now()); // the person's wait is not the turn's work
    // The transcript entry is built from the answer the card already holds — never from an event (ADR-0132 §6).
    state = appendNotice(
      state,
      stripTerminalControls(questionTranscriptText(open.request, answer)),
    );
    settling.resolve(answer);
    flush();
  };

  return {
    applyToolLiveEvent: (event) => {
      if (sealed) return;
      state = reduceToolLiveEvent(state, event);
      if (event.phase === 'started') {
        markdown.reset();
        terminal.reset();
      }
      toolDisplays = new Map(toolDisplays).set(
        event.callId,
        // A read-only turn refuses a governed call, so no card ever shows its preview: do not project it.
        updateToolDisplay(toolDisplays.get(event.callId), event, mode !== 'plan'),
      );
      retainToolDisplays();
      flush();
    },
    sealToolPreviews: () => {
      if (sealed) return;
      sealed = true;
      toolDisplays = new Map();
      review = undefined;
      acknowledgedReview = undefined;
      reviewPage = undefined;
      settleApproval?.({ outcome: 'reject' });
      // A question still open when the store seals is a CANCEL, never a skip (ADR-0132 §4): the call must be recorded
      // cancelled and the turn left to its own ending, not told the person declined.
      if (pendingQuestion !== undefined) {
        const rejecting = pendingQuestion;
        question = undefined;
        questionFrame = undefined;
        pendingQuestion = undefined;
        state = approvalClosed(state, Date.now());
        rejecting.reject(abortError());
      }
      flush();
    },
    openDetails: () => {
      if (!sealed && approval === undefined) {
        // The list opens on the newest call: the one the person has just seen happen is the one they are asking about.
        const ids = [...toolDisplays.keys()];
        review = {
          ...initialToolReview('details', ids.at(-1)),
          selected: Math.max(0, ids.length - 1),
        };
        flush();
      }
    },
    closeDetails: () => {
      if (review?.kind === 'details') {
        review = undefined;
        acknowledgedReview = undefined;
        reviewPage = undefined;
        flush();
      }
    },
    invalidateToolReview: () => {
      // A resize or a resume from suspend: the open question's frame must be measured and flushed again.
      if (question !== undefined) {
        mintQuestionFrame();
        flush();
      }
      if (review !== undefined) {
        review = { ...review, reveal: false, inspected: [] };
        reviewPage = undefined;
        flush();
      }
    },
    bindReviewVisibility: (visible) => {
      reviewVisible = visible;
    },
    bindReviewClipboard: (copy) => {
      reviewClipboard = copy;
    },
    acknowledgeReviewFrame: (expected, page) => {
      if (review !== expected) return;
      // The host acknowledges the same review again on every re-render (a spinner tick flushes the store); only a
      // DIFFERENT review — a new card, a resize, a screen change, any state change — is a new frame the person must be
      // given time to read, so only that restarts the dwell.
      if (acknowledgedReview !== expected) {
        acknowledgedReview = expected;
        acknowledgedAt = performance.now();
      }
      reviewPage = page;
      if (page === undefined) return;
      const updated = acknowledgeToolReview(review, page);
      if (updated !== review) {
        review = updated;
        flush();
      }
    },
    handleReviewInput: (input, key) => {
      // The single choke point: the host routes EVERY key here first, including the ones the composer then drops while a
      // turn runs and the ones a card swallows, so "the previous key" is the person's real previous key.
      const now = performance.now();
      const previousKeyAt = lastKeyAt;
      lastKeyAt = now;
      // An open question card owns the keyboard (ADR-0132 §3): the stop keys abort the turn, a choosing key is applied only
      // once the card's exact frame has been acknowledged visible, and every other key is consumed.
      if (question !== undefined) {
        const action = reduceQuestionKey(question, input, key, questionAcceptsKeys());
        // Everything the question card takes — the characters of an own answer, the Enter that submits it, a choosing key, a
        // key typed before its frame settled — is a person at the keyboard, and the governed call the model made right after
        // the question opens its card a few milliseconds later: a key typed into the question is not an answer to THAT card
        // (PR #99 security sitting H3). Only the stop keys are exempt: they leave the turn, they do not type.
        if (action.kind !== 'stop') lastForeignKeyAt = now;
        switch (action.kind) {
          case 'stop':
            return 'abort';
          case 'state':
            // The next question is a new frame the person has not seen: it needs its own acknowledgement and settle time.
            if (action.state.index !== question.index) mintQuestionFrame();
            question = action.state;
            flush();
            break;
          case 'submit':
            // The key that answered the question is held, double-tapped or repeated onto the card that follows it: a
            // key-resolved question starts the same lockout a key-resolved card does.
            lastResolvedAt = now;
            settleQuestionWith(action.answer);
            break;
          case 'skip':
            lastResolvedAt = now;
            settleQuestionWith({ kind: 'skipped' });
            break;
          case 'none':
            break;
        }
        return 'handled';
      }
      if (review === undefined) {
        // No card exists: the composer owns this key and drops it while a turn runs. That is a person typing the next
        // instruction — a foreign key, evidence that a `Ctrl+Y` or `Ctrl+G` in the next second and a half is not an answer (G1).
        lastForeignKeyAt = now;
        return undefined;
      }
      const calls = [...toolDisplays.values()];
      const cacheable = approval?.cacheable === true;
      const visible = reviewVisible?.() === true;
      const action = reduceToolReviewKey(
        review,
        input,
        key,
        visible,
        reviewPage,
        cacheable,
        calls.length,
      );
      // What the guard compares THIS key against is what happened before it.
      const priorForeignKeyAt = lastForeignKeyAt;
      // The session-wide grant's question — raised by a first `Ctrl+G` that passed every guard — is answered by ENTER and by no
      // other key (PR #99 security sitting H1: a second `a` was typing or a held key whatever the gap between them; the chord keeps that rule). It must
      // be on the same review, no older than the window and no younger than the minimum, and the card must still accept an
      // `Ctrl+G` and the Enter must clear the guard as an answer. Nothing else may have arrived since the `Ctrl+G`: any other key —
      // an early Enter and another `Ctrl+G` included — has already ended the question (below).
      const asked = alwaysAsk !== undefined && alwaysAsked(now) ? alwaysAsk : undefined;
      const mayConfirm =
        asked !== undefined &&
        isAlwaysConfirmKey(review, key) &&
        now - asked.at >= APPROVAL_CONFIRM_MIN_MS;
      const grant = mayConfirm
        ? reduceToolReviewKey(
            review,
            'g',
            { ctrl: true },
            visible,
            reviewPage,
            cacheable,
            calls.length,
          )
        : undefined;
      const confirmed =
        grant?.kind === 'approve' &&
        grant.scope === 'always' &&
        approvalKeyRefusal(approvalGuard, {
          now,
          shownAt: acknowledgedReview === review ? acknowledgedAt : undefined,
          previousKeyAt,
          lastForeignKeyAt: priorForeignKeyAt,
          lastResolvedAt,
        }) === undefined;
      if (
        !confirmed &&
        action.kind !== 'abort' &&
        // Text typed into the reason box or the search query is typing whatever the key is — and so is the Enter that
        // submits it; a stray key the card has no use for is too (PR #99 security sitting H3).
        (isTypingIntoReview(review) ||
          // A key that only took a stale note down moved nothing: it is still a key the card has no use for, so typing.
          ((action.kind === 'none' || noteOnly(review, action)) &&
            !isAffirmativeReviewKey(review, input, key) &&
            // A key the card would act on once its frame is visible is the person using the card, not typing at it.
            (visible ||
              noteOnly(review, action) ||
              reduceToolReviewKey(review, input, key, true, reviewPage, cacheable, calls.length)
                .kind === 'none')))
      )
        lastForeignKeyAt = now;
      // A held key goes on being held: an affirmative key that arrives inside the lockout restarts it, so the key must be
      // RELEASED for the whole window before the next card can be answered (PR #99 security sitting H2: a slow auto-repeat
      // used to slip past the window that counted from the resolving key only). Not only a refused answer: a repeat that lands
      // on a frame not yet acknowledged is no answer either, and it must not let the window run out.
      if (
        isAffirmativeReviewKey(review, input, key) &&
        approvalGuard.lockoutMs > 0 &&
        now - lastResolvedAt < approvalGuard.lockoutMs
      )
        lastResolvedAt = now;
      // The question ends at the next key that is not its confirming Enter — typing, a held `Ctrl+G`, an early Enter, anything.
      if (!confirmed && alwaysAsk !== undefined) {
        alwaysAsk = undefined;
        if (action.kind !== 'abort') flush();
      }
      if (confirmed) {
        lastResolvedAt = now;
        settleApproval?.({ outcome: 'approve', scope: 'always' });
        flush();
        return 'handled';
      }
      // Tell the person why a key was not counted — once per card, and only for a refusal that needs words.
      const refuse = (refusal: ApprovalRefusal): void => {
        if (refusal === 'dwell' || refusalNoted || review === undefined) return;
        refusalNoted = true;
        review = {
          ...review,
          message: refusal === 'lockout' ? CARD_LOCKOUT_NOTE : CARD_TYPEAHEAD_NOTE,
        };
        reviewPage = undefined;
        flush();
      };
      switch (action.kind) {
        case 'state': {
          // A note a move has taken down may be needed again: the refusal is explained once per card, not once ever.
          if (review.message !== '' && action.state.message === '') refusalNoted = false;
          review = transitionReviewState(review, action.state, calls);
          reviewPage = undefined;
          flush();
          break;
        }
        case 'abort':
          return 'abort';
        case 'deny':
          lastResolvedAt = now;
          settleApproval?.(
            action.reason === undefined
              ? { outcome: 'reject' }
              : { outcome: 'reject', reason: action.reason },
          );
          flush();
          break;
        case 'approve': {
          // A `Ctrl+G` that arrives while the question is open is the key that CANCELS it (above): it neither grants nor asks
          // again, so a held or repeated `Ctrl+G` never keeps a confirmation alive for an Enter to land on.
          if (asked !== undefined && action.scope === 'always') break;
          // A key that is not a deliberate answer changes nothing and is consumed (never composer text).
          const refusal = approvalKeyRefusal(approvalGuard, {
            now,
            shownAt: acknowledgedReview === review ? acknowledgedAt : undefined,
            previousKeyAt,
            lastForeignKeyAt: priorForeignKeyAt,
            lastResolvedAt,
          });
          if (refusal !== undefined) {
            refuse(refusal);
            break;
          }
          if (action.scope === 'always' && approvalGuard.confirmAlways) {
            // The session-wide grant takes two presses: this one only asks; ENTER, no other key between, grants.
            alwaysAsk = { review, at: now };
            flush();
            break;
          }
          lastResolvedAt = now;
          settleApproval?.({ outcome: 'approve', scope: action.scope });
          flush();
          break;
        }
        case 'close':
          review = undefined;
          acknowledgedReview = undefined;
          reviewPage = undefined;
          flush();
          break;
        case 'select': {
          const selected =
            review.callId === undefined ? undefined : toolDisplays.get(review.callId);
          if (selected !== undefined) {
            review = initialToolReview('details', selected.callId, detailsDocument(selected));
            flush();
          }
          break;
        }
        case 'copy':
          copyReviewPage();
          break;
        case 'none':
          break;
      }
      return 'handled';
    },
    setMemoryPolicy: (memory) => {
      const rest = { ...state };
      delete rest.memoryPolicy;
      state = memory === undefined ? rest : { ...rest, memoryPolicy: Object.freeze({ ...memory }) };
      flush();
    },
    setContextWindow: (window) => {
      const rest = { ...state };
      delete rest.contextWindowTokens;
      state = {
        ...rest,
        contextWindowResolved: true,
        ...(window === undefined ? {} : { contextWindowTokens: window }),
      };
      flush();
    },
    subscribe: (onStoreChange) => {
      listeners.add(onStoreChange);
      return () => {
        listeners.delete(onStoreChange);
      };
    },
    getSnapshot: () => snapshot,
    apply: (event) => {
      const next = reduceSessionEvent(state, event);
      const fresh =
        state.lastSequenceNumber === undefined || event.sequenceNumber > state.lastSequenceNumber;
      if (fresh) {
        if (event.type === 'agent:token') markdown.append(terminal.append(event.token));
        else if (
          event.type === 'agent:tool_call' ||
          event.type === 'session:turn_started' ||
          event.type === 'session:turn_completed' ||
          event.type === 'session:cancelled'
        ) {
          markdown.reset();
          terminal.reset();
        }
      }
      state = fresh
        ? {
            ...next,
            ...('usageCoverage' in event && event.usageCoverage !== undefined
              ? { usageCoverage: event.usageCoverage }
              : {}),
            ...(event.cumulativeCostMicrocents === undefined
              ? {}
              : { cumulativeCostMicrocents: event.cumulativeCostMicrocents }),
            unpricedCalls:
              event.cumulativeUnpricedCalls ??
              (state.unpricedCalls ?? 0) +
                (event.type === 'cost:updated' && event.priced === false ? 1 : 0),
          }
        : next;
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
    setReasoningEffort: (next) => {
      reasoningEffort = next;
      flush();
    },
    toggleReasoning: () => {
      reasoningVisible = !reasoningVisible;
      flush();
    },
    clearCompacting: () => {
      if (!state.compacting) return; // idempotent — only repaint if the moment was actually latched
      state = { ...state, compacting: false };
      flush();
    },
    requestApproval: (request, cacheable, signal, live) =>
      new Promise<ApprovalAnswer>((resolve, reject) => {
        // One overlay at a time, in BOTH directions: an approval under an open question card would be unreachable, because the
        // card consumes every key. (Tool calls dispatch sequentially, so this is unreachable today; the guard keeps it so.)
        if (sealed || settleApproval !== undefined || pendingQuestion !== undefined) {
          reject(abortError());
          return;
        }
        // Honor an already-aborted turn: reject with an AbortError so the dispatch routes to cancel, not deny.
        if (signal?.aborted === true) {
          reject(abortError());
          return;
        }
        const clear = (): void => {
          approval = undefined;
          review = undefined;
          acknowledgedReview = undefined;
          reviewPage = undefined;
          alwaysAsk = undefined;
          settleApproval = undefined;
          state = approvalClosed(state, Date.now()); // the person's wait is not the turn's work
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
        approval = { request, cacheable, ...(live === undefined ? {} : { live }) };
        alwaysAsk = undefined;
        refusalNoted = false; // a card of its own gets its own note
        state = approvalOpened(state, Date.now());
        const fallback = {
          kind: 'operation',
          fields: [],
        } satisfies import('@relavium/core').ToolPreview;
        review = initialToolReview(
          'approval',
          live?.callId,
          createReviewDocument(live?.preview ?? fallback),
        );
        signal?.addEventListener('abort', onAbort);
        flush(); // render the approval card
      }),
    answerApproval: (answer) => {
      // A no-op if nothing is pending (a stray keypress); else settle the in-flight promise + repaint.
      if (settleApproval === undefined) return;
      settleApproval(answer);
      flush();
    },
    requestQuestion: (request, signal) =>
      new Promise<AskUserAnswer>((resolve, reject) => {
        // One overlay at a time, and never on a sealed store or an already-stopped turn: those are CANCELS.
        if (sealed || settleApproval !== undefined || pendingQuestion !== undefined) {
          reject(abortError());
          return;
        }
        if (signal?.aborted === true) {
          reject(abortError());
          return;
        }
        // Defence in depth: the engine hands over only a validated request, so this is unreachable through the session. A
        // request that is not plain text would be drawn in the product's own chrome, so it is refused as a host fault.
        const fault = unshowableRequest(request);
        if (fault !== undefined) {
          reject(new Error(fault));
          return;
        }
        const onAbort = (): void => {
          if (pendingQuestion === undefined) return;
          question = undefined;
          questionFrame = undefined;
          pendingQuestion = undefined;
          state = approvalClosed(state, Date.now());
          reject(abortError());
          flush();
        };
        signal?.addEventListener('abort', onAbort);
        pendingQuestion = {
          resolve: (answer) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(answer);
          },
          reject: (reason) => {
            signal?.removeEventListener('abort', onAbort);
            reject(reason);
          },
        };
        question = initialQuestionCard(request);
        mintQuestionFrame();
        state = approvalOpened(state, Date.now());
        flush();
      }),
    pasteIntoQuestion: (text) => {
      if (question === undefined) return false;
      const next = pasteIntoQuestion(question, text, questionAcceptsKeys());
      if (next !== question) {
        question = next;
        flush();
      }
      return true;
    },
    bindQuestionVisibility: (visible) => {
      questionVisible = visible;
    },
  };
}

/** Why a request cannot be shown faithfully, or `undefined` when every model-authored string is plain text within its bound. */
function unshowableRequest(request: AskUserRequest): string | undefined {
  if (request.questions.length < 1 || request.questions.length > ASK_USER_BOUNDS.questionsPerCall)
    return 'the question request is empty or too long';
  for (const question of request.questions) {
    const strings: readonly (readonly [string, number])[] = [
      [question.header, ASK_USER_BOUNDS.headerBytes],
      [question.question, ASK_USER_BOUNDS.questionBytes],
      ...question.options.flatMap((option): readonly (readonly [string, number])[] => [
        [option.label, ASK_USER_BOUNDS.labelBytes],
        [option.description, ASK_USER_BOUNDS.descriptionBytes],
      ]),
    ];
    if (question.options.length < 2 || question.options.length > ASK_USER_BOUNDS.optionsPerQuestion)
      return 'a question has the wrong number of options';
    for (const [text, bound] of strings)
      if (plainTextRefusal(text, bound) !== undefined)
        return 'the question is not plain text within its bounds';
  }
  return undefined;
}

/** An `AbortError`-named error so a pending-approval rejection is classified as a CANCEL by the registry's
 *  `isAbort` (which also accepts `cause.name === 'AbortError'`), never as a denial. */
function abortError(): Error {
  const err = new Error('the approval was aborted');
  err.name = 'AbortError';
  return err;
}

/** Whether a `state` action changes nothing but the note: every other field of the review is the very same value. */
function noteOnly(before: ToolReviewState, action: ReviewKeyAction): boolean {
  if (action.kind !== 'state' || action.state.message === before.message) return false;
  const was = before as unknown as Record<string, unknown>;
  const now = action.state as unknown as Record<string, unknown>;
  return Object.keys(was).every((name) => name === 'message' || was[name] === now[name]);
}

function boundedDisplayText(source: string, limit: number): string {
  const text = sanitizeUntrustedInline(source);
  if (text.length <= limit) return text;
  const unit = text.charCodeAt(limit - 1);
  const end = unit >= 0xd800 && unit <= 0xdbff ? limit - 1 : limit;
  return `${text.slice(0, end)} … (${reviewBytes(text.slice(end))} display bytes omitted)`;
}

/**
 * @param withDocument whether a preview event is projected into a review document now. Projecting scans every
 *   field for secrets (260 ms per MiB of diff), so it is skipped for a call nothing will ask the person about; the
 *   display keeps its target and stats, and its details say the preview was not retained.
 */
function updateToolDisplay(
  previous: ToolDisplay | undefined,
  event: ToolLiveEvent,
  withDocument: boolean,
): ToolDisplay {
  let next: ToolDisplay = previous ?? {
    callId: event.callId,
    toolId: event.toolId,
    outcome: 'running',
  };
  if (event.phase === 'preview') {
    const document = withDocument ? createReviewDocument(event.preview) : undefined;
    if (event.preview.kind === 'saved-result' || document === undefined) {
      const delivery = { ...next };
      delete delivery.document;
      if (event.preview.kind === 'saved-result') delete delivery.stats;
      next = delivery;
    }
    return {
      ...next,
      ...(event.preview.target === undefined
        ? {}
        : { target: boundedDisplayText(event.preview.target, 512) }),
      ...(event.preview.diff === undefined ? {} : { stats: event.preview.diff.stats }),
      ...(document === undefined ? {} : { document }),
    };
  }
  if (event.phase === 'completed')
    return {
      ...next,
      outcome: event.outcome,
      ...(event.summary === undefined ? {} : { summary: boundedDisplayText(event.summary, 2048) }),
    };
  return next;
}
function detailsDocument(selected: ToolDisplay) {
  const preview = selected.document?.preview;
  // Nothing to add to what the call already retained: it is the same document, not a second projection of it.
  // (An invalid one retains no preview, and its details are rebuilt from the empty one it carries.)
  if (selected.document?.valid === true && selected.summary === undefined) return selected.document;
  return createReviewDocument({
    ...(preview ?? { kind: 'operation', fields: [] }),
    fields: [
      ...(preview?.fields ?? []),
      ...(preview === undefined
        ? [{ name: 'Preview unavailable', value: 'Not retained for this call.' }]
        : []),
      ...(selected.summary === undefined
        ? []
        : [{ name: 'Result summary', value: selected.summary }]),
    ],
  });
}
