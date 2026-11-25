/**
 * The popup host of ONE terminal host (the Home, or a stand-alone chat): the external store that owns the open popups and every rule of
 * [ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §2, §3 and §5 that is not drawing.
 * The Home controller and the chat hosts route keys and pastes to it and ask it to open a popup; they hold no popup logic. The frame is drawn
 * by the one overlay slot (`popup-slot.tsx`), which also measures it and tells this store when a frame was seen.
 *
 * **Opening** (§2). A popup opens only on the person's command ({@link PopupHost.openForUser}: there is no other way in, so a system event
 * cannot open one), and only when the host's gate says no turn runs, no card or sheet is open and no two-step is armed. A refused open says so
 * in ONE notification and opens nothing.
 *
 * **One key history** (§2). Every key and paste a popup takes is stamped on the host's ONE key history (`ChordHistory`, shared with the chat
 * store's approval guards and the Home's chord cards) as typing, and a key that RESOLVES something as a resolution: `Enter` on a step that
 * answers it, `Esc` or `Ctrl+C` that closes a popup, a `Ctrl+Y` that answered a confirmation line, and a `Ctrl+Y` that answered nothing (on a
 * line that refused it, or on any step that is not a line: a refused affirmative, so a held key keeps restarting the lockout). A control letter
 * (`[r]`, `[d]`, `[c]`) resolves nothing and is not stamped: it is not what a key held through the popup could answer a card with. So a key
 * typed into a popup is seen by the guards of a card that opens next, and a key held through a popup cannot answer that card.
 *
 * **The opening guard** (§3, `opening-guard.ts`) is applied to every popup: a key before the first measured and flushed frame is dropped, nothing
 * answers for half a second after it appeared, and an answer needs a key that arrived after it did. The leaving keys always work.
 *
 * **What closes a popup unanswered** (§2, §4, §5): a sheet arriving (`sheetArrived`: the sheet wins and nothing is restored), a popup that throws
 * (`fail`: the error boundary; it never reaches the renderer's error path, which would end the Home and cancel a hosted run), and a resize below
 * the floor while a step holds a chord or a secret (`resized`). Closing aborts the popup's signal (its loads stop), drops what it held and tells
 * the command it closed; it is never an answer.
 *
 * **Late results** (§2): every asynchronous result goes through the popup's own context, which carries its run id, so a result for a popup that
 * is closed or replaced lands nowhere.
 *
 * **Stacking** (§5): a popup may open one other; the depth is two. A child is a new frame with its own run id, opening guard, abort and
 * buffers; `Esc` on its first step returns to the opener with the opener's state intact; `Ctrl+C` closes the whole stack.
 *
 * **Identity** (§2, ADR-0147 §2): {@link PopupHost.getSnapshot} is reference-stable until something the frame draws changes: the top popup's
 * frame, the depth, and the live notification the frame draws in its legend row ({@link PopupHostSnapshot.notice}). The loading clock is NOT in
 * it (it is a display value read through {@link PopupHost.clock}), so a tick never makes a new frame and never restarts a guard.
 *
 * **Notifications** (§2). While a popup is open the host's notification is drawn in the popup's own legend row, so the popup host says whether
 * the channel is held (`NotificationChannel.popupHold`): while the step offers a chord answer or holds a secret, or the frame is not drawn
 * (below the floor), and not otherwise. A new or expired notification is a new frame.
 *
 * **A confirmation line** (§3, §8; a step with `chord`) is answered by `Ctrl+Y` through the approval card's own chord guard (`chord-guard.ts`,
 * {@link CHORD_STEP_GUARD}), on top of the opening guard. The `Ctrl+Y` counts only when the line's exact frame is measured and flushed on screen
 * now, at least the confirmation constant (800 ms) after THAT frame was acknowledged (the dwell origin is the acknowledgement, never the key that
 * armed the line, and a new frame of the line, a resize, a re-measure or a notification, restarts it), within the confirmation window
 * ({@link CHORD_STEP_WINDOW_MS}, counted from the same acknowledgement), after a quiet gap, outside the lockout of a key that resolved something
 * before the key that armed the line, and only when no key that is not a navigation key reached the popup since the line was armed (a key
 * dropped because its frame was not seen yet counts). A `Ctrl+Y` that does not count, the one the frame or the opening guard dropped included,
 * DISARMS the line at once, is stamped as a resolution and is told to the command (`chordRefused`, with why), so a held key's auto-repeat can
 * never answer it, nor a line it re-arms, and the person sees why. Every other key but the navigation keys, and a paste, disarms it too (a typed
 * one is told as `typed`; `Esc` and `Ctrl+C` are cancels and are not). When the window runs out the host disarms the line itself and tells it as
 * `expired`, so a line never offers an answer it can no longer take. Nothing but the command's own `chord` handler hears an answer.
 */

import { sanitizeInline } from '../render/sanitize.js';
import {
  createChordGuard,
  createChordHistory,
  reduceChordKey,
  type ChordGuard,
  type ChordHistory,
  type ChordStamp,
} from '../render/tui/chord-guard.js';
import { SHEET_CONFIRM_WINDOW_MS } from '../render/tui/permissions-sheet.js';
import { clipLine } from '../render/tui/sheet-frame.js';
import {
  APPROVAL_CONFIRM_MIN_MS,
  APPROVAL_LOCKOUT_MS,
  APPROVAL_QUIET_MS,
  type ApprovalGuard,
} from '../render/tui/tool-review-model.js';
import { displayWidth } from '../render/tui/viewport.js';
import { loadingElapsedText, type PopupContent, type PopupListRow } from './frame-model.js';
import { POPUP_NOTICE_MAX_COLUMNS, popupFits, type PopupPlacement } from './geometry.js';
import type { NotificationChannel, Schedule } from './notifications.js';
import { unrefTimer } from './notifications.js';
import { createOpeningGuard, type OpeningGuard } from './opening-guard.js';
import {
  backOf,
  currentStep,
  foldPopupAction,
  onChordStep,
  openFrame,
  openingKeyOf,
  reducePopupKey,
  withContent,
  type PopupControl,
  type PopupFrame,
  type PopupKey,
  type PopupKeyAction,
  type PopupSpec,
} from './popup-reducer.js';

/**
 * The numbers behind a confirmation line's `Ctrl+Y` ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3 and §8): the approval card's layers through the one chord guard, with the approval's CONFIRMATION constant as the dwell (800 ms, counted
 * from the acknowledged frame of the line, the approval card's dwell origin), its quiet gap and its lockout. Its typeahead layer is replaced by
 * the line's stricter rule (`typed`: no key that is not a navigation key since the line was armed, however long ago).
 */
export const CHORD_STEP_GUARD: ApprovalGuard = Object.freeze({
  settleMs: APPROVAL_CONFIRM_MIN_MS,
  quietMs: APPROVAL_QUIET_MS,
  typeaheadMs: 0,
  lockoutMs: APPROVAL_LOCKOUT_MS,
});

/**
 * How long after its frame was acknowledged a confirmation line can still be answered: the window of the `[d]`-arms family (ADR-0137's
 * withdrawal question, `SHEET_CONFIRM_WINDOW_MS`, 10 s), long enough to read a line that names several origins. Each new acknowledged frame
 * of the line restarts it; when it runs out the host disarms the line and says so.
 */
export const CHORD_STEP_WINDOW_MS = SHEET_CONFIRM_WINDOW_MS;

/**
 * Why a `Ctrl+Y` on a confirmation line did not count, or why the line went away unanswered: its frame was not seen, or the line was still being
 * prepared (`unseen`); the opening guard's settle time or a guard layer refused it (`early`: the dwell, the quiet gap or the lockout); the
 * confirmation window had passed (`expired`, also when the host disarms a line nobody answered in time); or a key that is not a navigation key
 * reached the popup after the line was armed (`typed`, also when such a key or a paste disarms the line). Each one disarms the line.
 */
export type ChordRefusal = 'unseen' | 'early' | 'expired' | 'typed';

/** Why a popup could not open: what the host's gate found, or the stack. */
export type PopupRefusal =
  | 'turn-running'
  | 'card-open'
  | 'sheet-open'
  | 'armed'
  | 'starting'
  | 'overlay-open'
  | 'popup-open'
  | 'depth'
  | 'closed';

export type PopupOpenResult =
  /** It opened: its run, and the context through which the command starts its loads and lands their results (it is the handlers' context). */
  | { readonly opened: true; readonly runId: number; readonly context: PopupContext }
  | { readonly opened: false; readonly reason: PopupRefusal };

/** Why a popup closed. None of them is an answer. */
export type PopupCloseReason =
  | 'escape'
  | 'interrupt'
  | 'sheet'
  | 'error'
  | 'resize'
  | 'command'
  | 'dispose';

/** What a command's popup is handed: its own run, and the only ways a result can reach its frame. */
export interface PopupContext {
  readonly runId: number;
  /** Aborted when THIS popup closes, however it closes: a load it started stops. */
  readonly signal: AbortSignal;
  /** The step the popup is on now (or `undefined` once it is closed). */
  readonly stepIndex: () => number | undefined;
  /**
   * Put a result into a step of THIS popup. `false` (and nothing changes) when the popup is closed or replaced: a late result lands nowhere.
   * `controls`, when given, sets the letters the step answers to from now on (a control that exists only once the result is known); `[]` takes
   * them away, and absent keeps the ones it has.
   */
  readonly setContent: (
    stepIndex: number,
    content: PopupContent,
    controls?: readonly PopupControl[],
  ) => boolean;
  /** Move THIS popup to a step. `false` when it is closed, or the step does not exist. */
  readonly goToStep: (stepIndex: number) => boolean;
  /** Close THIS popup (and a child it opened): the command's own close, after it has applied what it was for. */
  readonly close: () => void;
  /** Open a child popup over this one (depth two at most). */
  readonly openChild: (spec: PopupSpec, handlers?: PopupHandlers) => PopupOpenResult;
  /** One line for the host's notification channel (drawn in the popup's legend row while it is open, on the hint row otherwise). */
  readonly notify: (text: string) => void;
}

/** What a command does with its popup's answers. Each runs inside the host's error boundary: one that throws closes the popup unanswered. */
export interface PopupHandlers {
  /** `Enter` on a step that answers it (the step's `enter`), with the highlighted row of a list. */
  readonly enter?: ((context: PopupContext, row: PopupListRow | undefined) => void) | undefined;
  /** A control letter the step lists. */
  readonly control?: ((context: PopupContext, key: string) => void) | undefined;
  /** `Ctrl+Y` answered a confirmation line, through every layer of its guard. The ONLY way a line is answered. */
  readonly chord?: ((context: PopupContext) => void) | undefined;
  /**
   * A confirmation line that offered (or was preparing) an answer went away unanswered: a `Ctrl+Y` that did not count, a key typed over it, or
   * its window ran out. The line is already disarmed when this is called. Never an answer.
   */
  readonly chordRefused?: ((context: PopupContext, reason: ChordRefusal) => void) | undefined;
  /** A key moved the popup to another step (`Esc` back, a disarmed line). Not called for a step the command moved to itself. */
  readonly stepChanged?: ((context: PopupContext, from: number, to: number) => void) | undefined;
  /** The popup closed, however it closed. Never an answer. */
  readonly closed?: ((reason: PopupCloseReason) => void) | undefined;
}

export interface PopupHostSnapshot {
  readonly open: boolean;
  /** How many popups are open: 0, the popup, or the popup and its child. */
  readonly depth: 0 | 1 | 2;
  readonly placement: PopupPlacement;
  /** The popup on top (the one drawn and the one keys go to). */
  readonly frame: PopupFrame | undefined;
  /**
   * The host's live notification while a popup is open: the frame draws it in its legend row in place of the legend (the hint row it is drawn
   * on otherwise is under the popup). Part of the identity: a new or expired notification is a new frame. Absent with no popup open.
   */
  readonly notice?: string | undefined;
}

export interface PopupHost {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => PopupHostSnapshot;
  /** Open a popup because the person asked for it (a command they typed or chose). The only way a popup opens. */
  readonly openForUser: (spec: PopupSpec, handlers?: PopupHandlers) => PopupOpenResult;
  /** One key the host's reader routed here while a popup is open. `false` (and nothing happens) with none open. */
  readonly input: (input: string, key: PopupKey) => boolean;
  /** One bracketed paste. Typed text goes only into a text field, so it lands in a filter or nowhere. */
  readonly paste: (text: string) => boolean;
  /** A sheet arrived (a card, a question the system asks): the sheet wins, every popup closes unanswered and one notification says so. */
  readonly sheetArrived: () => void;
  /** A popup threw while it was drawn or answered: it closes unanswered and the Home stays (the error boundary). */
  readonly fail: (cause: unknown) => void;
  /** The terminal was resized: a step that holds a chord or a secret closes unanswered below the floor. */
  readonly resized: (columns: number, rows: number) => void;
  /** Close every popup (the host's own reason: it is ending, or a command closed it). */
  readonly closeAll: (reason: PopupCloseReason) => void;
  /** The host's gate: why a popup may not open now (a turn, a card, a sheet, an armed two-step), or `undefined`. Read at each open. */
  readonly bindOpenGate: (gate: (() => PopupRefusal | undefined) | undefined) => void;
  /** The acknowledgement's check: whether this exact snapshot is measured and flushed on screen now. */
  readonly bindVisibility: (check: ((snapshot: PopupHostSnapshot) => boolean) | undefined) => void;
  /** The rows a page moves (the list window the frame draws). */
  readonly bindPageRows: (rows: (() => number) | undefined) => void;
  /** This exact snapshot was just measured and flushed as a NEW frame: the top popup has appeared (its opening guard starts here). */
  readonly shown: (snapshot: PopupHostSnapshot) => void;
  /** The loading clock of the top popup: its elapsed text, quantised to the second, or `undefined`. Not a snapshot field. */
  readonly clock: {
    readonly subscribe: (listener: () => void) => () => void;
    readonly read: () => string | undefined;
  };
  readonly dispose: () => void;
}

/**
 * A popup's title and the words after it as one notification that fits {@link POPUP_NOTICE_MAX_COLUMNS} (it is drawn in a popup's legend row,
 * one row): the title is cut first, with the ellipsis, never the words that say what happened.
 */
function titled(title: string, rest: string): string {
  const room = POPUP_NOTICE_MAX_COLUMNS - displayWidth(rest);
  return `${clipLine(sanitizeInline(title), Math.max(1, room))}${rest}`;
}

/** What a refused open says (one notification; ADR-0148 §2). The words name the reason, never a key: the legend owns those. */
export function refusedOpenText(title: string, reason: PopupRefusal): string {
  const why: Readonly<Record<PopupRefusal, string>> = {
    'turn-running': 'a turn is running',
    'card-open': 'a card is waiting for your answer',
    'sheet-open': 'a question is open',
    armed: 'a confirmation is armed',
    starting: 'a chat is starting',
    'overlay-open': 'another list is open',
    'popup-open': 'another popup is open',
    depth: 'two popups are already open',
    closed: 'the screen is closing',
  };
  return titled(title, ` cannot open now: ${why[reason]}`);
}

/** What a popup closed by the system says. */
export function closedUnansweredText(title: string, reason: 'sheet' | 'error' | 'resize'): string {
  switch (reason) {
    case 'sheet':
      return titled(title, ' closed: a question needs your answer');
    case 'error':
      return titled(title, ' closed: it could not be shown');
    case 'resize':
      return titled(title, ' closed: terminal too small, nothing was answered');
  }
}

/**
 * A confirmation line that is armed: how many keys that are not navigation keys had reached the popup when it was armed (the key that armed it
 * included), when the key history last saw a resolution just before that key (the lockout is measured against it), the guard of its answer, and
 * the timer that disarms it when its window runs out.
 */
interface ChordArming {
  readonly typedWhenArmed: number;
  readonly lastResolvedAt: number;
  /** The one chord guard (`chord-guard.ts`) over the host's history: its dwell restarts at every acknowledged frame of the line. */
  readonly guard: ChordGuard;
  /** Cancels the expiry timer while one is scheduled (from the line's acknowledged frame, while it offers its answer). */
  cancelExpiry: (() => void) | undefined;
}

/** What the key history said just before a key (its stamp), or now when no key moved the popup. */
type ArmingEvidence = Pick<ChordStamp, 'lastResolvedAt'>;

/** What a confirmation line shows: an answer to give (`answer`), one still being prepared (`preparing`), or nothing to confirm (`nothing`). */
type LineOffer = 'answer' | 'preparing' | 'nothing';

/** One open popup and what it holds that is not drawn. */
interface FrameRecord {
  frame: PopupFrame;
  readonly handlers: PopupHandlers;
  readonly abort: AbortController;
  readonly guard: OpeningGuard;
  /** When each step's content last became `loading` (the clock's origin; never a guard's). */
  loadingSince: number | undefined;
  /** The confirmation line's evidence while the popup is on one, else `undefined`. */
  chord: ChordArming | undefined;
  /**
   * How many keys that are not navigation keys have reached THIS popup, seen or not (a paste on a confirmation line disarms it outright). A
   * count, not a time: a key that arrives in the same millisecond as the one that armed a line is still a key after it.
   */
  typed: number;
}

export interface PopupHostOptions {
  /** A MONOTONIC clock (production: `performance.now`). */
  readonly now?: (() => number) | undefined;
  /** The host's ONE key history (shared with the chat store and the Home's chord cards). Default: one of its own. */
  readonly history?: ChordHistory | undefined;
  /** The host's notification channel: a refused open and a popup closed by the system, and what an open popup draws in its legend row. */
  readonly notifications?: NotificationChannel | undefined;
  /** Where popups are drawn: `overlay` in the alternate screen, `replace` inline. */
  readonly placement: PopupPlacement;
  /** The loading clock's and the line expiry's timer (production: an unref'd timeout). */
  readonly schedule?: Schedule | undefined;
  /** The opening guard's settle time (default 500 ms); a test that isolates another rule passes `0`. */
  readonly settleMs?: number | undefined;
}

const CLOSED: Omit<PopupHostSnapshot, 'placement'> = { open: false, depth: 0, frame: undefined };

/** The most a paste puts into a filter line: a filter is a word or two, never a document. */
export const PASTE_LIMIT = 200;

export function createPopupHost(options: PopupHostOptions): PopupHost {
  const now = options.now ?? (() => performance.now());
  const history = options.history ?? createChordHistory();
  const chord = createChordGuard({ now, history });
  const schedule = options.schedule ?? unrefTimer;
  const placement = options.placement;
  const channel = options.notifications;
  const stack: FrameRecord[] = [];
  const listeners = new Set<() => void>();
  const clockListeners = new Set<() => void>();
  let snapshot: PopupHostSnapshot = { ...CLOSED, placement };
  let gate: (() => PopupRefusal | undefined) | undefined;
  let visibility: ((snapshot: PopupHostSnapshot) => boolean) | undefined;
  let pageRows: (() => number) | undefined;
  let runSeq = 0;
  let disposed = false;
  let clockText: string | undefined;
  let cancelClock: (() => void) | undefined;
  /** Whether the terminal holds a popup at its last known size (a frame below the floor is a notice, with no legend row to draw a notification). */
  let fitsTerminal = true;
  /** The stamp of the key being handled, while it is: a step a handler moves to during it is armed against what came before THAT key. */
  let keyStamp: ChordStamp | undefined;

  const top = (): FrameRecord | undefined => stack.at(-1);

  /** What the history says now, for a line armed by no key (a popup opened on it, or a command that moved there on its own). */
  const evidenceNow = (): ArmingEvidence => keyStamp ?? { lastResolvedAt: history.lastResolvedAt };

  const lineOffer = (record: FrameRecord): LineOffer => {
    const kind = currentStep(record.frame).state.content.kind;
    return kind === 'report' ? 'answer' : kind === 'loading' ? 'preparing' : 'nothing';
  };

  const stopExpiry = (arming: ChordArming | undefined): void => {
    if (arming === undefined) return;
    arming.cancelExpiry?.();
    arming.cancelExpiry = undefined;
  };

  /** A new frame of the record's line has not been seen yet: its dwell (and so its window) starts again at ITS acknowledgement. */
  const beginLine = (record: FrameRecord | undefined): void => {
    record?.chord?.guard.begin();
    stopExpiry(record?.chord);
  };

  /** Arm the record's confirmation line when its step is one (and disarm it otherwise): a new guard, its dwell not started (a guard starts with none). */
  const rearm = (record: FrameRecord, before: ArmingEvidence): void => {
    stopExpiry(record.chord);
    if (!onChordStep(record.frame)) {
      record.chord = undefined;
      return;
    }
    record.chord = {
      typedWhenArmed: record.typed,
      lastResolvedAt: before.lastResolvedAt,
      guard: createChordGuard({ now, history, guard: CHORD_STEP_GUARD }),
      cancelExpiry: undefined,
    };
  };

  /** The loading clock: one timer while the top popup is loading in the alternate screen; a listener hears only a CHANGED text. */
  const readClock = (): string | undefined => {
    const record = top();
    if (record === undefined || placement !== 'overlay') return undefined;
    if (currentStep(record.frame).state.content.kind !== 'loading') return undefined;
    return record.loadingSince === undefined
      ? undefined
      : loadingElapsedText(now() - record.loadingSince);
  };
  const stopClock = (): void => {
    cancelClock?.();
    cancelClock = undefined;
  };
  const tickClock = (): void => {
    cancelClock = undefined;
    const text = readClock();
    if (text !== clockText) {
      clockText = text;
      for (const listener of clockListeners) listener();
    }
    syncClock();
  };
  function syncClock(): void {
    const record = top();
    const loading =
      !disposed &&
      placement === 'overlay' &&
      record !== undefined &&
      currentStep(record.frame).state.content.kind === 'loading';
    if (!loading) {
      stopClock();
      if (clockText !== undefined) {
        clockText = undefined;
        for (const listener of clockListeners) listener();
      }
      return;
    }
    // At most once a second, never at the frame rate (§5; ADR-0147 §2: no repaint above 1 Hz).
    cancelClock ??= schedule(tickClock, 1000);
  }

  /**
   * Tell the channel whether the open popup holds it: while its step offers a chord answer (a line drawn with its answer) or holds a secret,
   * and while its frame is not drawn (below the floor). With none open the host's own hold applies again.
   */
  const syncHold = (): void => {
    if (channel === undefined) return;
    const record = top();
    if (record === undefined || disposed) {
      channel.popupHold(undefined);
      return;
    }
    const { spec } = currentStep(record.frame);
    const offersChord = onChordStep(record.frame) && lineOffer(record) === 'answer';
    channel.popupHold(spec.holds === 'secret' || offersChord || !fitsTerminal);
  };

  /** The notification the top popup draws now, or `undefined`. */
  const liveNotice = (): string | undefined =>
    stack.length === 0 ? undefined : channel?.getSnapshot().current?.text;

  const publish = (): void => {
    // First, so a notification it lets through (or holds back) is already in the snapshot built below; it may publish once itself.
    syncHold();
    const record = top();
    const next: PopupHostSnapshot =
      record === undefined
        ? { ...CLOSED, placement }
        : {
            open: true,
            depth: stack.length === 1 ? 1 : 2,
            placement,
            frame: record.frame,
            notice: liveNotice(),
          };
    if (
      next.open !== snapshot.open ||
      next.depth !== snapshot.depth ||
      next.frame !== snapshot.frame ||
      next.notice !== snapshot.notice
    ) {
      // A new frame of a confirmation line (a notification appearing or going included) has not been seen yet.
      if (next.frame !== snapshot.frame || next.notice !== snapshot.notice) beginLine(record);
      snapshot = next;
    }
    syncClock();
    for (const listener of listeners) listener();
  };

  // A notification that comes or goes while a popup is open is a new frame of it (it is drawn in the legend row).
  const stopNotices = channel?.subscribe(() => {
    if (!disposed && stack.length > 0 && liveNotice() !== snapshot.notice) publish();
  });

  const notify = (text: string): void => channel?.notify(text);

  /** Close the top `count` popups, each with `reason`: abort its work, drop what it held, tell its command. */
  const closeTop = (count: number, reason: PopupCloseReason): void => {
    const closed: FrameRecord[] = [];
    for (let index = 0; index < count && stack.length > 0; index += 1) {
      const record = stack.pop();
      if (record !== undefined) {
        stopExpiry(record.chord);
        record.chord = undefined;
        closed.push(record);
      }
    }
    publish();
    for (const record of closed) {
      record.abort.abort();
      try {
        record.handlers.closed?.(reason);
      } catch {
        // A command's own close hook cannot reopen or fail the host: the popup is already gone.
      }
    }
  };

  const recordOf = (runId: number): FrameRecord | undefined =>
    stack.find((record) => record.frame.runId === runId);

  /** Run a command's handler; one that throws closes the popup unanswered, as a popup that throws while drawn does. */
  const guarded = (run: () => void): void => {
    try {
      run();
    } catch (cause) {
      host.fail(cause);
    }
  };

  /** Tell the command why its line went away unanswered (never an answer). */
  const tellRefused = (record: FrameRecord, reason: ChordRefusal): void => {
    const refused = record.handlers.chordRefused;
    if (refused === undefined) return;
    const { runId } = record.frame;
    guarded(() => refused(contextOf(runId), reason));
  };

  /** The window of the record's line runs from ITS acknowledged frame: when it runs out the host disarms the line and says so. */
  const startExpiry = (record: FrameRecord): void => {
    const arming = record.chord;
    if (arming === undefined || lineOffer(record) !== 'answer') return;
    const shownAt = arming.guard.shownAt();
    if (shownAt === undefined) return;
    stopExpiry(arming);
    const due = (): void => {
      arming.cancelExpiry = undefined;
      if (disposed || record.chord !== arming || top() !== record) return;
      if (arming.guard.shownAt() !== shownAt) return;
      // A line is expired when MORE than the window has passed since its frame was acknowledged (the last moment of it still answers).
      const left = shownAt + CHORD_STEP_WINDOW_MS - now();
      if (left >= 0) {
        arming.cancelExpiry = schedule(due, left + 1);
        return;
      }
      if (lineOffer(record) !== 'answer') return;
      disarm(record);
      tellRefused(record, 'expired');
    };
    arming.cancelExpiry = schedule(due, CHORD_STEP_WINDOW_MS + 1);
  };

  const push = (spec: PopupSpec, handlers: PopupHandlers): PopupOpenResult => {
    runSeq += 1;
    const frame = openFrame(spec, runSeq);
    const record: FrameRecord = {
      frame,
      handlers,
      abort: new AbortController(),
      guard: createOpeningGuard({ now, settleMs: options.settleMs }),
      loadingSince: currentStep(frame).state.content.kind === 'loading' ? now() : undefined,
      chord: undefined,
      typed: 0,
    };
    // A popup that opens ON its confirmation line (`/doctor --deep`) is armed as it opens: every key after this moment is evidence.
    rearm(record, evidenceNow());
    stack.push(record);
    publish();
    return { opened: true, runId: frame.runId, context: contextOf(frame.runId) };
  };

  /** Put `next` in the record (a key's fold, a command's step, a disarmed line); a step change re-arms or disarms its line. */
  const moveTo = (record: FrameRecord, next: PopupFrame): number => {
    const from = record.frame.stepIndex;
    record.frame = next;
    if (next.stepIndex !== from) {
      record.loadingSince = currentStep(next).state.content.kind === 'loading' ? now() : undefined;
      rearm(record, evidenceNow());
    }
    publish();
    return from;
  };

  /** Disarm the record's confirmation line: back to the step it came from (closed when it has none), answered by nothing. */
  function disarm(record: FrameRecord): void {
    const back = backOf(record.frame.spec, record.frame.stepIndex);
    if (back < 0) {
      closeTop(stack.length - stack.indexOf(record), 'escape');
      return;
    }
    const from = moveTo(record, { ...record.frame, stepIndex: back });
    const changed = record.handlers.stepChanged;
    if (changed !== undefined) {
      const { runId } = record.frame;
      guarded(() => changed(contextOf(runId), from, back));
    }
  }

  /**
   * A `Ctrl+Y` that reached the record's confirmation line and does not answer it: it is a resolution on the history (its auto-repeat cannot
   * answer a line it re-arms), the line is disarmed at once, and the command is told why, when the line offered (or was preparing) an answer.
   */
  const refuseChord = (record: FrameRecord, stamp: ChordStamp, reason: ChordRefusal): void => {
    chord.resolved(stamp);
    if (lineOffer(record) === 'nothing') return;
    disarm(record);
    tellRefused(record, reason);
  };

  /**
   * Why a `Ctrl+Y` that reached the record's confirmation line does not answer it, or `undefined` when it does (see the module header). The
   * stamp is the key's own; `typedBefore` is how many keys that are not navigation keys had reached the popup BEFORE it.
   */
  const chordRefusal = (
    record: FrameRecord,
    stamp: ChordStamp,
    typedBefore: number,
  ): ChordRefusal | undefined => {
    const arming = record.chord;
    if (arming === undefined) return 'unseen';
    if (typedBefore > arming.typedWhenArmed) return 'typed';
    const shownAt = arming.guard.shownAt();
    if (shownAt === undefined) return 'unseen';
    if (stamp.now - shownAt > CHORD_STEP_WINDOW_MS) return 'expired';
    // The one chord guard decides the dwell, the quiet gap and the lockout, against the history as it stood before the key that armed the line.
    // Its typeahead layer is off (`CHORD_STEP_GUARD.typeaheadMs` is 0: the `typed` count above replaces it), so the foreign time is not read.
    const answer = arming.guard.decide(
      {
        now: stamp.now,
        previousKeyAt: stamp.previousKeyAt,
        lastForeignKeyAt: stamp.lastForeignKeyAt,
        lastResolvedAt: arming.lastResolvedAt,
      },
      'allow',
      visibility?.(snapshot) === true,
    );
    return answer === 'allow' ? undefined : 'early';
  };

  const contextOf = (runId: number): PopupContext => {
    const record = recordOf(runId);
    const signal = record?.abort.signal ?? AbortSignal.abort();
    return {
      runId,
      signal,
      stepIndex: () => recordOf(runId)?.frame.stepIndex,
      setContent: (stepIndex, content, controls) => {
        const live = recordOf(runId);
        if (live === undefined || stepIndex < 0 || stepIndex >= live.frame.steps.length)
          return false;
        live.frame = withContent(live.frame, stepIndex, content, controls);
        if (stepIndex === live.frame.stepIndex)
          live.loadingSince = content.kind === 'loading' ? now() : undefined;
        publish();
        return true;
      },
      goToStep: (stepIndex) => {
        const live = recordOf(runId);
        if (live === undefined || stepIndex < 0 || stepIndex >= live.frame.steps.length)
          return false;
        moveTo(live, { ...live.frame, stepIndex });
        return true;
      },
      close: () => {
        const at = stack.findIndex((entry) => entry.frame.runId === runId);
        if (at >= 0) closeTop(stack.length - at, 'command');
      },
      openChild: (spec, handlers = {}) => {
        if (disposed) return { opened: false, reason: 'closed' };
        if (top()?.frame.runId !== runId) return { opened: false, reason: 'popup-open' };
        if (stack.length >= 2) {
          notify(refusedOpenText(spec.title, 'depth'));
          return { opened: false, reason: 'depth' };
        }
        return push(spec, handlers);
      },
      notify,
    };
  };

  /** Apply one admitted key's action to the record on top (its stamp is the key's own, `typedBefore` the typing that came before it). */
  const applyKey = (
    record: FrameRecord,
    action: PopupKeyAction,
    stamp: ChordStamp,
    typedBefore: number,
  ): boolean => {
    if (action.kind === 'chord') {
      const offer = lineOffer(record);
      // A line still being prepared is not on screen yet: the key is no answer, and the line goes (the person sees why).
      if (offer === 'preparing') {
        refuseChord(record, stamp, 'unseen');
        return true;
      }
      // A line with nothing to confirm takes no answer and stays (it says what to do instead); the key is still a refused affirmative.
      if (offer === 'nothing') {
        chord.resolved(stamp);
        return true;
      }
      const refusal = chordRefusal(record, stamp, typedBefore);
      if (refusal !== undefined) {
        refuseChord(record, stamp, refusal);
        return true;
      }
      // Answered: the guard stamped the resolution on the host's history, so a held key cannot answer what this answer opens.
      stopExpiry(record.chord);
      const answer = record.handlers.chord;
      const { runId } = record.frame;
      if (answer !== undefined) guarded(() => answer(contextOf(runId)));
      return true;
    }
    const fold = foldPopupAction(record.frame, action, Math.max(1, pageRows?.() ?? 1));
    switch (fold.kind) {
      case 'frame': {
        const from = moveTo(record, fold.frame);
        const to = fold.frame.stepIndex;
        const changed = record.handlers.stepChanged;
        if (to !== from && changed !== undefined) {
          const { runId } = record.frame;
          guarded(() => changed(contextOf(runId), from, to));
        }
        return true;
      }
      case 'chord':
        // Reached only through the branch above (the fold's own chord is the pure reducer's): nothing to do here.
        return true;
      case 'close':
        chord.resolved(stamp);
        closeTop(1, 'escape');
        return true;
      case 'close-all':
        chord.resolved(stamp);
        closeTop(stack.length, 'interrupt');
        return true;
      case 'enter': {
        chord.resolved(stamp);
        const { runId } = record.frame;
        const enter = record.handlers.enter;
        if (enter !== undefined) guarded(() => enter(contextOf(runId), fold.row));
        return true;
      }
      case 'control': {
        // A control letter resolves nothing (it runs a check, arms a line, copies): it is not stamped, so it locks no line it arms.
        const { runId } = record.frame;
        const control = record.handlers.control;
        if (control !== undefined) guarded(() => control(contextOf(runId), fold.key));
        return true;
      }
      case 'unchanged':
        return true;
    }
  };

  const host: PopupHost = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    openForUser: (spec, handlers = {}) => {
      if (disposed) return { opened: false, reason: 'closed' };
      if (stack.length > 0) {
        notify(refusedOpenText(spec.title, 'popup-open'));
        return { opened: false, reason: 'popup-open' };
      }
      const refusal = gate?.();
      if (refusal !== undefined) {
        notify(refusedOpenText(spec.title, refusal));
        return { opened: false, reason: refusal };
      }
      return push(spec, handlers);
    },
    input: (input, key) => {
      const record = top();
      if (record === undefined || disposed) return false;
      // Every key a popup takes is the person's hand at the keyboard: a card that opens next sees it (one key history per host).
      const stamp = chord.stamp();
      chord.foreign(stamp);
      const step = currentStep(record.frame).spec;
      const action = reducePopupKey(input, key, step);
      // A `Ctrl+Y` on a step that is not a confirmation line answers nothing: a refused affirmative, which restarts the lockout, so a key held
      // through the step that arms a line cannot answer that line on its auto-repeat.
      if (action.kind !== 'chord' && reduceChordKey(input, key) === 'allow') chord.resolved(stamp);
      const kind = openingKeyOf(action);
      // Every key that is not a navigation key is evidence against a confirmation line armed before it, seen or not (the line's `typed` rule).
      const typedBefore = record.typed;
      if (kind === 'answer' || kind === 'type') record.typed += 1;
      // A frame nobody has seen takes no key but the ones that leave (it is typing, already counted above), and the opening guard takes none
      // that came too soon. A `Ctrl+Y` dropped there on a confirmation line still disarms it, and the person is told why.
      const seen = kind === 'leave' || visibility?.(snapshot) === true;
      if (!seen || !record.guard.admits(kind, stamp.now)) {
        if (action.kind === 'chord') {
          const appearedAt = record.guard.shownAt();
          const before = !seen || appearedAt === undefined || stamp.now <= appearedAt;
          refuseChord(
            record,
            stamp,
            before || lineOffer(record) === 'preparing' ? 'unseen' : 'early',
          );
        }
        return true;
      }
      // Whether the line offered an answer, read before the key moves the popup: a key typed over it is told as `typed`.
      const offered =
        action.kind === 'disarm' && action.cause === 'typed' && lineOffer(record) !== 'nothing';
      keyStamp = stamp;
      try {
        applyKey(record, action, stamp, typedBefore);
      } finally {
        keyStamp = undefined;
      }
      if (offered) tellRefused(record, 'typed');
      return true;
    },
    paste: (text) => {
      const record = top();
      if (record === undefined || disposed) return false;
      const stamp = chord.stamp();
      chord.foreign(stamp);
      // A paste answers nothing: on a confirmation line it disarms it, seen or not (so it never has to be counted against an answer).
      if (onChordStep(record.frame)) {
        const offered = lineOffer(record) !== 'nothing';
        disarm(record);
        if (offered) tellRefused(record, 'typed');
        return true;
      }
      // Typed text goes only into a text field (§3): a step with no filter takes no paste, and one that is not on screen takes none.
      if (currentStep(record.frame).spec.filter !== true) return true;
      if (visibility?.(snapshot) !== true || !record.guard.admits('type', stamp.now)) return true;
      const line = sanitizeInline(text).replace(/\s+/gu, ' ').slice(0, PASTE_LIMIT);
      const fold = foldPopupAction(record.frame, { kind: 'append', text: line }, 1);
      if (fold.kind === 'frame') {
        record.frame = fold.frame;
        publish();
      }
      return true;
    },
    sheetArrived: () => {
      const record = top();
      if (record === undefined) return;
      const title = stack[0]?.frame.spec.title ?? record.frame.spec.title;
      closeTop(stack.length, 'sheet');
      notify(closedUnansweredText(title, 'sheet'));
    },
    fail: () => {
      const record = top();
      if (record === undefined) return;
      const title = record.frame.spec.title;
      closeTop(stack.length, 'error');
      notify(closedUnansweredText(title, 'error'));
    },
    resized: (columns, rows) => {
      fitsTerminal = popupFits(columns, rows);
      const record = top();
      if (record === undefined) return;
      // The frame is measured again: a confirmation line's dwell restarts at the acknowledgement of the frame drawn at the new size.
      beginLine(record);
      if (fitsTerminal) {
        syncHold();
        return;
      }
      // Below the floor the frame is replaced by a notice. A step that holds a chord or a secret is not left pending behind it.
      if (currentStep(record.frame).spec.holds === undefined) {
        syncHold();
        return;
      }
      const title = record.frame.spec.title;
      closeTop(stack.length, 'resize');
      notify(closedUnansweredText(title, 'resize'));
    },
    closeAll: (reason) => {
      if (stack.length > 0) closeTop(stack.length, reason);
    },
    bindOpenGate: (next) => {
      gate = next;
    },
    bindVisibility: (check) => {
      visibility = check;
    },
    bindPageRows: (rows) => {
      pageRows = rows;
    },
    shown: (frame) => {
      if (frame !== snapshot || !snapshot.open) return;
      const record = top();
      if (record === undefined) return;
      record.guard.shown();
      // Every NEW acknowledged frame of a confirmation line is its dwell origin and the start of its window (the acknowledgement tells only a
      // new frame).
      record.chord?.guard.shown();
      startExpiry(record);
    },
    clock: {
      subscribe: (listener) => {
        clockListeners.add(listener);
        return () => clockListeners.delete(listener);
      },
      read: () => clockText,
    },
    dispose: () => {
      if (disposed) return;
      // First: a command's close hook that opens a popup during the teardown is refused (`closed`), never pushed into a host that is going.
      disposed = true;
      closeTop(stack.length, 'dispose');
      stopClock();
      stopNotices?.();
      channel?.popupHold(undefined);
      listeners.clear();
      clockListeners.clear();
    },
  };
  return host;
}
