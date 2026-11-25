/**
 * The popup host of ONE terminal host (the Home, or a stand-alone chat): the external store that owns the open popups and every rule of
 * [ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §2, §3 and §5 that is not drawing.
 * The Home controller and the chat hosts route keys and pastes to it and ask it to open a popup; they hold no popup logic. The frame is drawn
 * by the one overlay slot (`popup-slot.tsx`), which also measures it and tells this store when a frame was seen.
 *
 * **Opening** (§2). A popup opens only on the person's command ({@link PopupHost.openForUser}: there is no other way in, so a system event
 * cannot open one), and only when the host's gate says no turn runs, no card or sheet is open and no two-step is armed. A refused open says so
 * in ONE notification and opens nothing. A host that has bound no gate (it is not mounted yet, or it has unbound it on the way out) refuses
 * every open as `closed`: the gate fails closed, as the acknowledgement does when no visibility check is bound.
 *
 * **One key history** (§2). Every key and paste a popup takes is stamped on the host's ONE key history (`ChordHistory`, shared with the chat
 * store's approval guards and the Home's chord cards) as typing, and a key that RESOLVES something as a resolution: `Enter` on a step that
 * answers it, `Esc` or `Ctrl+C` that closes a popup, a `Ctrl+Y` that answered a confirmation line, and a `Ctrl+Y` that answered nothing (on a
 * line that refused it, or on any step that is not a line: a refused affirmative, so a held key keeps restarting the lockout). A control letter
 * (`[r]`, `[d]`, `[c]`) resolves nothing and is not stamped: it is not what a key held through the popup could answer a card with. So a key
 * typed into a popup is seen by the guards of a card that opens next, and a key held through a popup cannot answer that card.
 *
 * **The opening guard** (§3, `opening-guard.ts`) is applied to every popup: a key before the first measured and flushed frame is dropped, nothing
 * answers for half a second after it appeared, and an answer needs a key that arrived after it did. The leaving keys always work. A control
 * letter is an answer too: on a popup that opened on its confirmation line, a `Ctrl+Y` refused at once disarms the line to the step before it,
 * and a `[d]` that follows inside the popup's first half second is dropped like any answer there (the notification says `[d] asks again`, and
 * it does from that half second on). The settle is not shortened for it: it is the one rule that keeps a reflex chain typed before the popup
 * appeared from acting on it.
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
 * **Notifications** (§2). While a popup is open the host's notification is drawn in the popup's own legend row, beside its way back, so the
 * popup host says whether the channel is held (`NotificationChannel.popupHold`): while the step offers a chord answer or holds a secret, or the
 * frame is not drawn (below the floor), and not otherwise. A new or expired notification is a new frame; one drawn in a frame the slot
 * acknowledged is seen (`NotificationChannel.seen`: a hold drops it rather than replaying it later); and what a popup says (`PopupContext.notify`)
 * is discarded when that popup closes, because it speaks of that popup's keys.
 *
 * **A confirmation line** (§3, §8; a step with `chord`) is answered by `Ctrl+Y` through the approval card's own chord guard (`chord-guard.ts`,
 * {@link CHORD_STEP_GUARD}), on top of the opening guard. The `Ctrl+Y` counts only when the line's exact frame is measured and flushed on screen
 * now, at least the confirmation constant (800 ms) after THAT frame was acknowledged (the dwell origin is the acknowledgement, never the key that
 * armed the line, and a new frame of the line, a resize, a re-measure or a notification, restarts it), within the confirmation window
 * ({@link CHORD_STEP_WINDOW_MS}, counted from the same acknowledgement), after a quiet gap, outside the lockout of a key that resolved something
 * before the key that armed the line (for a popup that OPENS on its line, before it opened, the last key before the open counting as one), and
 * only when no key that is not a navigation key reached the popup since the line was armed (a key dropped because its frame was not seen yet
 * counts). A `Ctrl+Y` that does not count, the one the frame or the opening guard dropped and a held key's repeat or release included, DISARMS
 * the line at once, is stamped as a resolution and is told to the command (`chordRefused`, with why), so a held key's auto-repeat can never
 * answer it, nor a line it re-arms, and the person sees why. Every other key but the navigation keys, and a paste, disarms it too (a typed
 * one is told as `typed`; `Esc` and `Ctrl+C` are cancels and are not). When the window runs out the host disarms the line itself and tells it as
 * `expired`, so a line never offers an answer it can no longer take. Nothing but the command's own `chord` handler hears an answer.
 *
 * **The whole line, or no answer** (§8: the line names what leaves and to whom). The rule is the host's, for every line (`/doctor`'s and
 * `/cost`'s alike), whatever the command measured: a line offers its answer only while its report is WHOLLY on the page its frame is drawn on,
 * every line of it on the page and none of them wider, as drawn, than the page's row (`lineFitsPage`, read against the rows and the inner width
 * the slot binds from the one geometry). A line cut short (`▼ N more`, e.g. inline, where a page is ten rows) or with a row cut by the ellipsis
 * offers none: its legend names no `Ctrl+Y`, a `Ctrl+Y` on it is a refused affirmative that leaves it as it is (the command says why in its own
 * words), and the channel is not held for it. A line that offered its answer on its last acknowledged frame and is cut on a new one (a resize
 * that made the page shorter or narrower) is disarmed at once and told as `cut`.
 *
 * **A line with no step to go back to** closes its popup when it is disarmed. The command is still told why, and what it says about it in that
 * call is raised on the host's own channel (drawn on the hint row once the popup is gone), not as the closed popup's, which would end with it.
 */

import { sanitizeInline } from '../render/sanitize.js';
import {
  chordOf,
  createChordGuard,
  createChordHistory,
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
import {
  POPUP_FLOOR,
  POPUP_NOTICE_MAX_COLUMNS,
  popupFits,
  popupInnerWidth,
  type PopupPlacement,
} from './geometry.js';
import type { NotificationChannel, Schedule } from './notifications.js';
import { unrefTimer } from './notifications.js';
import { createOpeningGuard, type OpeningGuard } from './opening-guard.js';
import {
  backOf,
  currentStep,
  foldPopupAction,
  lineFitsPage,
  onChordStep,
  openFrame,
  openingKeyOf,
  reducePopupKey,
  visitStep,
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
 * prepared (`unseen`); the opening guard's settle time or a guard layer refused it (`early`: the dwell, the quiet gap or the lockout, and a held
 * key's repeat or release); the confirmation window had passed (`expired`, also when the host disarms a line nobody answered in time); a key
 * that is not a navigation key reached the popup after the line was armed (`typed`, also when such a key or a paste disarms the line); or a
 * line that was wholly on its page is not any more (`cut`: a new frame, a smaller page after a resize, draws it cut short, and the host
 * disarms it). Each one disarms the line.
 */
export type ChordRefusal = 'unseen' | 'early' | 'expired' | 'typed' | 'cut';

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
  /**
   * One line for the host's notification channel, drawn in the popup's legend row. It belongs to THIS popup: it is discarded, shown or waiting,
   * when the popup closes (it speaks of the popup's keys), and nothing is said once it is closed.
   */
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
   * The host's live notification while a popup is open: the frame draws it in its legend row in place of the legend's keys, before the way
   * back (the hint row it is drawn on otherwise is under the popup). Part of the identity: a new or expired notification is a new frame.
   * Absent with no popup open.
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
  /**
   * The host's gate: why a popup may not open now (a turn, a card, a sheet, an armed two-step), or `undefined`. Read at each open. With no gate
   * bound every open is refused as `closed`.
   */
  readonly bindOpenGate: (gate: (() => PopupRefusal | undefined) | undefined) => void;
  /** The acknowledgement's check: whether this exact snapshot is measured and flushed on screen now. */
  readonly bindVisibility: (check: ((snapshot: PopupHostSnapshot) => boolean) | undefined) => void;
  /**
   * The rows of the page the current step's body is drawn in (a list's window, a report's page), from the slot's geometry: a page moves by it,
   * and a confirmation line offers its answer only while its report fits it whole. Unbound ⇒ no bound (no frame is drawn).
   */
  readonly bindPageRows: (rows: (() => number) | undefined) => void;
  /**
   * The columns a row of the current step's body may use (the inner width), from the same geometry, bound next to the page's rows: a
   * confirmation line offers its answer only while none of its lines is wider, as drawn, than this. Unbound ⇒ no bound (no frame is drawn).
   */
  readonly bindInnerWidth: (columns: (() => number) | undefined) => void;
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
 * The most columns a notification the HOST raises when no popup is left open may take: it is drawn on the hint row, and it is bounded by the
 * inner width of a standard popup at the floor (66) so that, if a popup opens while it is still shown, the popup's legend row cuts only its
 * end (`frame-model.ts`), never the way back. A notification raised while a popup stays open fits {@link POPUP_NOTICE_MAX_COLUMNS} instead.
 */
const HINT_NOTICE_MAX_COLUMNS = popupInnerWidth(POPUP_FLOOR.columns, 'standard');

/**
 * A popup's title and the words after it as one notification of at most `columns` (it is one row): the title is cut first, with the ellipsis,
 * never the words that say what happened.
 */
function titled(title: string, rest: string, columns: number): string {
  const room = columns - displayWidth(rest);
  return `${clipLine(sanitizeInline(title), Math.max(1, room))}${rest}`;
}

/**
 * What a refused open says (one notification; ADR-0148 §2). The words name the reason, never a key: the legend owns those. A refusal because
 * a popup is already open is drawn in THAT popup's legend row, beside its way back ({@link POPUP_NOTICE_MAX_COLUMNS}); every other one is
 * raised with no popup open, on the hint row.
 */
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
  const columns =
    reason === 'popup-open' || reason === 'depth'
      ? POPUP_NOTICE_MAX_COLUMNS
      : HINT_NOTICE_MAX_COLUMNS;
  return titled(title, ` cannot open now: ${why[reason]}`, columns);
}

/** What a popup closed by the system says: the whole stack is closed then, so it is drawn on the hint row. */
export function closedUnansweredText(title: string, reason: 'sheet' | 'error' | 'resize'): string {
  const why: Readonly<Record<typeof reason, string>> = {
    sheet: ' closed: a question needs your answer',
    error: ' closed: it could not be shown',
    resize: ' closed: terminal too small, nothing was answered',
  };
  return titled(title, why[reason], HINT_NOTICE_MAX_COLUMNS);
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
  /** Whether the line's last acknowledged frame offered its answer (it was wholly on its page): a later frame that cuts it disarms it. */
  offered: boolean;
}

/** What the key history said just before a key (its stamp), or now when no key moved the popup. */
type ArmingEvidence = Pick<ChordStamp, 'lastResolvedAt'>;

/**
 * What a confirmation line shows: an answer to give (`answer`: its report wholly on the page its frame is drawn on), one still being prepared
 * (`preparing`), or nothing that can be confirmed (`nothing`: an empty or failed state, or a report cut short or with no line).
 */
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
  let innerWidth: (() => number) | undefined;
  let runSeq = 0;
  let disposed = false;
  let clockText: string | undefined;
  let cancelClock: (() => void) | undefined;
  /** Whether the terminal holds a popup at its last known size (a frame below the floor is a notice, with no legend row to draw a notification). */
  let fitsTerminal = true;
  /** The stamp of the key being handled, while it is: a step a handler moves to during it is armed against what came before THAT key. */
  let keyStamp: ChordStamp | undefined;

  const top = (): FrameRecord | undefined => stack.at(-1);

  /** What the history says now, for a line armed by no key (a command that moved there on its own). */
  const evidenceNow = (): ArmingEvidence => keyStamp ?? { lastResolvedAt: history.lastResolvedAt };

  /**
   * What a popup that OPENS on its confirmation line (`/doctor --deep`, `/cost --release`) is armed against, when no key of a popup opened
   * it: the most recent key before the open counts as a resolution, whatever it was. The keys that typed the command went to the composer,
   * which stamps them as keys and never as resolutions, so a `Ctrl+Y` held there while the popup's code loads would otherwise reach the line
   * with no lockout to meet: now its first repeat, and any key at all within the lockout of the last one, is refused as `early`, as on the
   * line `[d]` arms after a refused `Ctrl+Y`. A child opened by a popup's own key is armed against what came before THAT key, as a line its
   * key moves to is.
   *
   * Today this is `previousKeyAt`: every writer of the shared history (the chord guard's `resolved` and `decide`, the chat store's review,
   * question and checkpoint cards) records a resolution at the time of a key it stamped first, so no resolution is later than the last key.
   * That is a property of those writers, not of this module, and the history is a mutable record they share: the larger of the two is taken so
   * that a writer that ever records a resolution with no key, or on a clock ahead of the keys', still locks the line. It is never weaker than
   * either time.
   */
  const openingEvidence = (): ArmingEvidence =>
    keyStamp ?? { lastResolvedAt: Math.max(history.lastResolvedAt, history.previousKeyAt) };

  /**
   * The rows the page of the top popup's step draws (the slot binds its geometry's), or no bound with no frame drawn: then the visibility
   * check, which sees nothing, decides alone.
   */
  const pageNow = (): number => pageRows?.() ?? Number.POSITIVE_INFINITY;

  /** The columns a row of that page may use (the slot binds its geometry's inner width next to the rows), or no bound with no frame drawn. */
  const widthNow = (): number => innerWidth?.() ?? Number.POSITIVE_INFINITY;

  /** What the record's confirmation line offers now, read against the page its frame is drawn on (the host's rule: `lineFitsPage`). */
  const lineOffer = (record: FrameRecord): LineOffer => {
    const content = currentStep(record.frame).state.content;
    if (content.kind === 'loading') return 'preparing';
    return lineFitsPage(content, pageNow(), widthNow()) ? 'answer' : 'nothing';
  };

  /** Whether the record's line is a report (what a line that offers nothing then is: one its page does not hold whole), not an empty or failed state. */
  const isReport = (record: FrameRecord): boolean =>
    currentStep(record.frame).state.content.kind === 'report';

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
      offered: false,
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

  /**
   * Close the top `count` popups, each with `reason`: abort its work, drop what it held (what it said on the notification channel included:
   * it was about its own keys), tell its command.
   */
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
    for (const record of closed) channel?.discard(record);
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

  /**
   * Tell the command why its line went away unanswered (never an answer). A line with no step to go back to closed its popup as it was
   * disarmed: the closed popup's context says nothing more (its words would be discarded with it), so what the command says in THIS call is
   * raised on the host's own channel, drawn on the hint row once the popup is gone, and nothing it says later through that context is.
   */
  const tellRefused = (record: FrameRecord, reason: ChordRefusal): void => {
    const refused = record.handlers.chordRefused;
    if (refused === undefined) return;
    const { runId } = record.frame;
    const context = contextOf(runId);
    if (recordOf(runId) !== undefined) {
      guarded(() => refused(context, reason));
      return;
    }
    let telling = true;
    const closing: PopupContext = {
      ...context,
      notify: (text) => {
        if (telling) notify(text);
      },
    };
    try {
      guarded(() => refused(closing, reason));
    } finally {
      telling = false;
    }
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
    // A popup that opens ON its confirmation line (`/doctor --deep`) is armed as it opens: every key after this moment is evidence, and the last
    // key before it starts the lockout.
    rearm(record, openingEvidence());
    stack.push(record);
    publish();
    return { opened: true, runId: frame.runId, context: contextOf(frame.runId) };
  };

  /**
   * Put `next` in the record (a key's fold, a command's step, a disarmed line); a step change re-arms or disarms its line, and the step moved
   * to counts as visited (the rail marks it done once the popup leaves it forward).
   */
  const moveTo = (record: FrameRecord, next: PopupFrame): number => {
    const from = record.frame.stepIndex;
    record.frame = visitStep(next);
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
      // What a popup says is about it: it is discarded when the popup closes, and a popup that is already closed says nothing more.
      notify: (text) => {
        const live = recordOf(runId);
        if (live !== undefined) channel?.notify(text, live);
      },
    };
  };

  /**
   * A `Ctrl+Y` that reached the record's confirmation line (an admitted key: its stamp is the key's own, `typedBefore` the typing that came
   * before it): it answers the line only through every layer of its guard.
   */
  const answerChord = (
    record: FrameRecord,
    action: Extract<PopupKeyAction, { readonly kind: 'chord' }>,
    stamp: ChordStamp,
    typedBefore: number,
  ): void => {
    const offer = lineOffer(record);
    // A line still being prepared is not on screen yet: the key is no answer, and the line goes (the person sees why).
    if (offer === 'preparing') {
      refuseChord(record, stamp, 'unseen');
      return;
    }
    // A line with nothing that can be confirmed (an empty or failed state, a report cut short) takes no answer and stays (it says what to do
    // instead, and the legend names no answer); the key is still a refused affirmative.
    if (offer === 'nothing') {
      chord.resolved(stamp);
      return;
    }
    // A held key's repeat or release is never a first press: it is refused as a key that came too soon, whatever the guard would say.
    const refusal = action.held === true ? 'early' : chordRefusal(record, stamp, typedBefore);
    if (refusal !== undefined) {
      refuseChord(record, stamp, refusal);
      return;
    }
    // Answered: the guard stamped the resolution on the host's history, so a held key cannot answer what this answer opens.
    stopExpiry(record.chord);
    const answer = record.handlers.chord;
    const { runId } = record.frame;
    if (answer !== undefined) guarded(() => answer(contextOf(runId)));
  };

  /** A fold that leaves the popup open in another state: put it in, and tell the command when the step changed. */
  const applyFrame = (record: FrameRecord, next: PopupFrame): void => {
    const from = moveTo(record, next);
    const to = next.stepIndex;
    const changed = record.handlers.stepChanged;
    if (to !== from && changed !== undefined) {
      const { runId } = record.frame;
      guarded(() => changed(contextOf(runId), from, to));
    }
  };

  /** Apply one admitted key's action to the record on top (its stamp is the key's own, `typedBefore` the typing that came before it). */
  const applyKey = (
    record: FrameRecord,
    action: PopupKeyAction,
    stamp: ChordStamp,
    typedBefore: number,
  ): void => {
    if (action.kind === 'chord') {
      answerChord(record, action, stamp, typedBefore);
      return;
    }
    const fold = foldPopupAction(record.frame, action, Math.max(1, pageRows?.() ?? 1));
    const { runId } = record.frame;
    switch (fold.kind) {
      case 'frame':
        applyFrame(record, fold.frame);
        return;
      case 'close':
        chord.resolved(stamp);
        closeTop(1, 'escape');
        return;
      case 'close-all':
        chord.resolved(stamp);
        closeTop(stack.length, 'interrupt');
        return;
      case 'enter': {
        chord.resolved(stamp);
        const enter = record.handlers.enter;
        if (enter !== undefined) guarded(() => enter(contextOf(runId), fold.row));
        return;
      }
      case 'control': {
        // A control letter resolves nothing (it runs a check, arms a line, copies): it is not stamped, so it locks no line it arms.
        const control = record.handlers.control;
        if (control !== undefined) guarded(() => control(contextOf(runId), fold.key));
        return;
      }
      case 'unchanged':
        return;
    }
  };

  /**
   * Why a `Ctrl+Y` the frame or the opening guard dropped did not count: before the popup's first frame, on a frame nobody has seen, at the
   * very moment it appeared or on a line still being prepared it was `unseen`; after the popup appeared, inside its settle time, `early`.
   */
  const droppedChordReason = (
    record: FrameRecord,
    seen: boolean,
    stamp: ChordStamp,
  ): ChordRefusal => {
    const appearedAt = record.guard.shownAt();
    const before = !seen || appearedAt === undefined || stamp.now <= appearedAt;
    return before || lineOffer(record) === 'preparing' ? 'unseen' : 'early';
  };

  /**
   * The admission of one key (§3): a frame nobody has seen takes no key but the ones that leave (it is typing, already counted), and the
   * opening guard takes none that came too soon. A `Ctrl+Y` dropped there on a confirmation line still disarms it, and the person is told why.
   */
  const admitKey = (record: FrameRecord, action: PopupKeyAction, stamp: ChordStamp): boolean => {
    const kind = openingKeyOf(action);
    const seen = kind === 'leave' || visibility?.(snapshot) === true;
    if (seen && record.guard.admits(kind, stamp.now)) return true;
    if (action.kind === 'chord')
      refuseChord(record, stamp, droppedChordReason(record, seen, stamp));
    return false;
  };

  /** Apply an admitted key, then tell the command when a key typed over its line disarmed it (read before the key moved the popup). */
  const dispatchKey = (
    record: FrameRecord,
    action: PopupKeyAction,
    stamp: ChordStamp,
    typedBefore: number,
  ): void => {
    const offered =
      action.kind === 'disarm' && action.cause === 'typed' && lineOffer(record) !== 'nothing';
    keyStamp = stamp;
    try {
      applyKey(record, action, stamp, typedBefore);
    } finally {
      keyStamp = undefined;
    }
    if (offered) tellRefused(record, 'typed');
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
      // No gate bound is no permission: a host that never said what may not open (or unbound it) opens nothing, as no visibility check sees nothing.
      const refusal = gate === undefined ? 'closed' : gate();
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
      const action = reducePopupKey(input, key, currentStep(record.frame).spec);
      // A `Ctrl+Y` on a step that is not a confirmation line answers nothing: a refused affirmative, which restarts the lockout, so a key held
      // through the step that arms a line cannot answer that line on its auto-repeat (its repeat and its release included).
      if (action.kind !== 'chord' && chordOf(input, key) === 'allow') chord.resolved(stamp);
      // A key that would answer is evidence against a confirmation line armed before it, seen or not (the line's `typed` rule). On a line every
      // other key but the navigation keys disarms it, so these are the only keys the count can still hold against one.
      const typedBefore = record.typed;
      if (openingKeyOf(action) === 'answer') record.typed += 1;
      if (admitKey(record, action, stamp)) dispatchKey(record, action, stamp, typedBefore);
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
    bindInnerWidth: (columns) => {
      innerWidth = columns;
    },
    shown: (frame) => {
      if (frame !== snapshot || !snapshot.open) return;
      const record = top();
      if (record === undefined) return;
      // The notification this frame drew in its legend row has been seen: a hold that begins now drops it instead of replaying it.
      if (snapshot.notice !== undefined) channel?.seen(snapshot.notice);
      record.guard.shown();
      const arming = record.chord;
      if (arming === undefined) return;
      // A line whose last acknowledged frame offered its answer and whose page no longer holds it whole (a resize made the page smaller) is
      // disarmed at once, with the reason: it is never left on screen cut short and armed.
      const offer = lineOffer(record);
      if (arming.offered && offer === 'nothing' && isReport(record)) {
        disarm(record);
        tellRefused(record, 'cut');
        return;
      }
      arming.offered = offer === 'answer';
      // Every NEW acknowledged frame of a confirmation line is its dwell origin and the start of its window (the acknowledgement tells only a
      // new frame).
      arming.guard.shown();
      startExpiry(record);
      // The page this frame is drawn on decides whether the line offers its answer, and so whether the channel is held.
      syncHold();
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
