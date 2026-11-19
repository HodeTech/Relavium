import {
  MAX_APPROVAL_REASON_INPUT_CHARS,
  denialReasonDisclosure,
  sanitizeApprovalReason,
} from './chat-projection.js';
import type { CommandCardFacts } from '../../chat/command-facts.js';
import type { ChatKey } from './chat-input.js';
import { isInterruptKey } from './interrupt-keymap.js';
import {
  CARD_KEY_ROWS,
  CARD_MAX_BODY_ROWS,
  CARD_RULE_ROWS,
  CARD_VERB_COLUMNS,
  cardDenialExtraRows,
  cardRowBudget,
  cardWarnings,
} from './tool-review-card.js';
import {
  CARD_CONTEXT_LINES,
  cardStartLine,
  projectReviewPage,
  REVIEW_START,
  type ReviewCursor,
  type ReviewDocument,
  type ReviewField,
  type ReviewPage,
  type SourceRange,
} from './tool-review-projection.js';
import {
  changeJump,
  compareCursors,
  fullOpeningCursor,
  lastPageStart,
  lineRows,
  offPageChangeLanding,
  pageDown,
  pageUp,
  scrollByLines,
  topCursor,
  type ScrollView,
} from './tool-review-scroll.js';
import {
  FULL_DEFAULT_CHROME_ROWS,
  fullBodyRows,
  type InspectionPending,
} from './tool-review-screen.js';

/**
 * How long an approval card must have been continuously on screen — counted from its acknowledged frame — before an
 * affirmative key (`Ctrl+Y`, `Ctrl+G`) counts. A flushed frame is proof the bytes were drawn, not that a person could read them:
 * without a dwell a key pressed ahead (a double tap, a held key, a reflex) approves a card that opened under it.
 * The question card has the same guard for the same reason (`QUESTION_SETTLE_MS`).
 */
export const APPROVAL_SETTLE_MS = 400;
/**
 * How long the person's keyboard must have been quiet — since the previous key of ANY kind, including a key the
 * composer dropped and a key the card swallowed — before an affirmative key counts. A deliberate answer is a single
 * press; a key that follows another within this gap is typing, a double tap or a key repeat.
 */
export const APPROVAL_QUIET_MS = 300;
/**
 * How long after the last FOREIGN key — a key the approval card has no use for: everything typed while no card was open (the
 * composer drops it while a turn runs, which is a person typing the next instruction), everything the card ignores, and every
 * key absorbed by a text field (the search query, the denial reason, the question card's own answer) together with the Enter
 * that submits it — an affirmative chord (`Ctrl+Y`, the first `Ctrl+G`) is refused. Answers are chords precisely because a bare letter cannot be told from typing at all; this layer
 * is the second line behind that rule, for a chord pressed on the heels of typing. Timing alone cannot tell typing from a deliberate press (the quiet gap
 * above is the average gap of a 40 WPM typist), so what the person was doing a moment ago is the evidence: someone who was
 * typing text has not, in the next second and a half, decided to press Allow.
 */
export const APPROVAL_TYPEAHEAD_MS = 1500;
/**
 * How long after a card was resolved BY A KEY (allow, deny, reason) — or after an affirmative key was refused for being inside
 * this very window — an affirmative key is refused. A key held down answers the card, and its first auto-repeat arrives one
 * initial repeat delay later — 250 ms to 1 s on the common desktops and up to 1.8 s on macOS — onto the NEXT card, long after
 * a quiet gap or a dwell has expired, and every later repeat arrives one repeat interval after the one before (as slow as
 * 450 ms or more). The window outlasts the slowest initial delay, and each refused repeat RESTARTS it (the store sets the
 * time to the repeat), so a key that stays down — however slowly the OS repeats it — keeps the next card locked until it has
 * been released for the whole window: the one thing that tells a held key from a deliberate first press on the next card.
 */
export const APPROVAL_LOCKOUT_MS = 2000;
/**
 * The two wider grants are TWO-step answers, and the second step is a DIFFERENT key: the first `Ctrl+G` (this tool or command for the
 * session) or `Ctrl+O` (this exact command for the project, ADR-0118 §1) asks, and only ENTER — no other key between, and pressed
 * at least {@link APPROVAL_CONFIRM_MIN_MS} and at most {@link APPROVAL_CONFIRM_MAX_MS} after the chord — grants. A second press of
 * the same chord can never be the confirmation: the same key twice is what a held key and its auto-repeat produce, whatever the
 * gap between them (PR #99 security sitting H1, when the grant was still a bare `a`, measured a gap-based second `a` granting at
 * 350 ms per key, and a held `a` granting at its first auto-repeat for initial delays of 375 ms to 1 s; the chord keeps that rule,
 * and typing can no longer produce the first press). Any key between — including the other chord — cancels the question, and so
 * does an Enter that comes sooner than the minimum: an Enter that quick follows the letter as typing does, not as the reading of a
 * prompt that has just changed.
 */
export const APPROVAL_CONFIRM_MIN_MS = 800;
export const APPROVAL_CONFIRM_MAX_MS = 5000;

/**
 * The numbers behind an approval answer, so a test can isolate one guard or switch it off. `settleMs` and `quietMs` are
 * required (a caller always says how the original two layers behave); the others default to the product's real values
 * when left out, and `0` (or `false`) switches that layer off.
 */
export interface ApprovalGuard {
  readonly settleMs: number;
  readonly quietMs: number;
  /** {@link APPROVAL_TYPEAHEAD_MS}. */
  readonly typeaheadMs?: number;
  /** {@link APPROVAL_LOCKOUT_MS}. */
  readonly lockoutMs?: number;
  /** Whether `Ctrl+G` and `Ctrl+O` need the Enter confirmation (default true). `false` makes the first press grant, as before. */
  readonly confirmAlways?: boolean;
}
export const DEFAULT_APPROVAL_GUARD: Required<ApprovalGuard> = Object.freeze({
  settleMs: APPROVAL_SETTLE_MS,
  quietMs: APPROVAL_QUIET_MS,
  typeaheadMs: APPROVAL_TYPEAHEAD_MS,
  lockoutMs: APPROVAL_LOCKOUT_MS,
  confirmAlways: true,
});

/** The numbers a store runs with: every layer named, the omitted ones filled in with the product's real values. */
export function resolveApprovalGuard(guard: ApprovalGuard | undefined): Required<ApprovalGuard> {
  return {
    settleMs: guard?.settleMs ?? DEFAULT_APPROVAL_GUARD.settleMs,
    quietMs: guard?.quietMs ?? DEFAULT_APPROVAL_GUARD.quietMs,
    typeaheadMs: guard?.typeaheadMs ?? DEFAULT_APPROVAL_GUARD.typeaheadMs,
    lockoutMs: guard?.lockoutMs ?? DEFAULT_APPROVAL_GUARD.lockoutMs,
    confirmAlways: guard?.confirmAlways ?? DEFAULT_APPROVAL_GUARD.confirmAlways,
  };
}

/** Which layer refused an affirmative key. `dwell` is the only one that needs no explanation: the card has just appeared. */
export type ApprovalRefusal = 'lockout' | 'typeahead' | 'quiet' | 'dwell';

/**
 * Why an affirmative key (`Ctrl+Y`, `Ctrl+G`, `Ctrl+O`) does NOT count as the person's DELIBERATE answer, or `undefined` when it does. Every layer
 * must pass (`0` switches one off):
 *  - dwell: the review's frame has been on screen for `settleMs` (a review whose frame was never acknowledged has not been
 *    on screen at all);
 *  - quiet: the previous key of ANY kind is at least `quietMs` old;
 *  - typeahead: no FOREIGN key arrived within `typeaheadMs` (what the person was doing a moment ago was typing);
 *  - lockout: no card was resolved by a key — and no affirmative key refused by this very window — within `lockoutMs` (a held
 *    or double-tapped key's carry-over; the store restarts the window with every refused repeat).
 * When several refuse, the one worth telling the person about comes first. Deny and navigation never ask (the caller applies
 * this to an `approve` action only). Every time is on ONE monotonic clock, so a wall-clock step changes nothing.
 */
export function approvalKeyRefusal(
  guard: Required<ApprovalGuard>,
  timing: {
    readonly now: number;
    /** When the review's current frame was acknowledged, or `undefined` when it has not been. */
    readonly shownAt: number | undefined;
    /** When the previous key of any kind arrived, `-Infinity` when there was none. */
    readonly previousKeyAt: number;
    /** When the last foreign key arrived (a refused affirmative key is not one), `-Infinity` when there was none. */
    readonly lastForeignKeyAt: number;
    /** When the last card was resolved by a key, `-Infinity` when none was. */
    readonly lastResolvedAt: number;
  },
): ApprovalRefusal | undefined {
  if (guard.lockoutMs > 0 && timing.now - timing.lastResolvedAt < guard.lockoutMs) return 'lockout';
  if (guard.typeaheadMs > 0 && timing.now - timing.lastForeignKeyAt < guard.typeaheadMs)
    return 'typeahead';
  if (guard.quietMs > 0 && timing.now - timing.previousKeyAt < guard.quietMs) return 'quiet';
  if (
    guard.settleMs > 0 &&
    (timing.shownAt === undefined || timing.now - timing.shownAt < guard.settleMs)
  )
    return 'dwell';
  return undefined;
}

export interface ToolReviewState {
  readonly kind: 'approval' | 'details';
  readonly screen: 'card' | 'full' | 'list';
  readonly callId: string | undefined;
  readonly document: ReviewDocument | undefined;
  readonly cursor: ReviewCursor;
  readonly reveal: boolean;
  readonly numeric: boolean;
  readonly inspected: readonly SourceRange[];
  readonly requiredTarget: SourceRange | undefined;
  readonly query: string | undefined;
  readonly searching: boolean;
  readonly selected: number;
  readonly denial: string | undefined;
  readonly message: string;
  /** A command's standing, directory, warnings and the answers its card offers (ADR-0118 §1); absent for any other call. */
  readonly facts?: CommandCardFacts;
}
export function initialToolReview(
  kind: 'approval' | 'details',
  callId?: string,
  document?: ReviewDocument,
  facts?: CommandCardFacts,
): ToolReviewState {
  return {
    ...(facts === undefined ? {} : { facts }),
    kind,
    screen: initialReviewScreen(kind, document),
    callId,
    document,
    // Details open on the document's first LISTED line: a cursor never rests on a copy the full view leaves out.
    cursor: kind === 'details' && document !== undefined ? topCursor(document) : REVIEW_START,
    reveal: false,
    numeric: false,
    inspected: [],
    requiredTarget: undefined,
    query: undefined,
    searching: false,
    selected: 0,
    denial: undefined,
    message: '',
  };
}
/**
 * Whether every requirement for an affirmative answer has been met. `shownTarget` is the target requirement of the
 * page being drawn (`ReviewPage.requiredTarget`): the state only learns it once a frame is acknowledged, so a card
 * that reads the lock from the state alone would offer Allow for one frame (and for the first frame after a resize
 * that shortens the target). Passing what the card draws makes the legend, the warning and the keys agree.
 */
export function reviewInspected(state: ToolReviewState, shownTarget?: SourceRange): boolean {
  const pending = inspectionPending(state, shownTarget);
  return !pending.target && pending.masks === 0;
}
/**
 * What of the inspection an affirmative answer needs is still owed, by cause: the whole target (when the card had to shorten
 * it) and the masked ranges that must be revealed and drawn. {@link reviewInspected} is exactly "nothing owed", so the lock
 * sentence the full view prints and the lock the keys enforce are one definition.
 */
export function inspectionPending(
  state: ToolReviewState,
  shownTarget?: SourceRange,
): InspectionPending {
  const seen = coverage(state.inspected);
  const target = state.requiredTarget ?? shownTarget;
  return {
    target: target !== undefined && !seen(target),
    masks: (state.document?.required ?? []).filter((required) => !seen(required)).length,
  };
}
/**
 * A test for "has this range been drawn": `inspected` is kept merged and sorted by `acknowledgeToolReview`, so the one range that
 * could cover a required one is the last whose start is not after it — a binary search instead of a scan of every range for
 * every requirement (thousands of masks). A list that is not in that shape (a hand-built state) is scanned, as it always was.
 */
function coverage(inspected: readonly SourceRange[]): (required: SourceRange) => boolean {
  let ordered = true;
  for (let index = 1; index < inspected.length && ordered; index++) {
    const before = inspected[index - 1];
    const range = inspected[index];
    if (before === undefined || range === undefined) continue;
    ordered =
      before.field < range.field || (before.field === range.field && before.end < range.start);
  }
  if (!ordered)
    return (required) =>
      inspected.some(
        (range) =>
          range.field === required.field &&
          range.start <= required.start &&
          range.end >= required.end,
      );
  return (required) => {
    let low = 0;
    let high = inspected.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const range = inspected[middle];
      if (
        range !== undefined &&
        (range.field < required.field ||
          (range.field === required.field && range.start <= required.start))
      )
        low = middle + 1;
      else high = middle;
    }
    const range = inspected[low - 1];
    return range?.field === required.field && range.end >= required.end;
  };
}
export function acknowledgeToolReview(state: ToolReviewState, page: ReviewPage): ToolReviewState {
  if (!page.valid) return state;
  const requiredTarget = state.requiredTarget ?? page.requiredTarget;
  const intersect = (
    shown: readonly SourceRange[],
    required: readonly SourceRange[],
  ): SourceRange[] =>
    shown.flatMap((source) =>
      required.flatMap((range) => {
        if (source.field !== range.field) return [];
        const start = Math.max(source.start, range.start),
          end = Math.min(source.end, range.end);
        return start < end ? [{ field: source.field, start, end }] : [];
      }),
    );
  const needed =
    state.screen !== 'full'
      ? []
      : [
          ...(state.reveal ? intersect(page.shown, state.document?.required ?? []) : []),
          ...intersect(page.visibleSource, requiredTarget === undefined ? [] : [requiredTarget]),
        ];
  const merged = [...state.inspected, ...needed].sort(
    (a, b) => a.field - b.field || a.start - b.start || a.end - b.end,
  );
  const inspected: SourceRange[] = [];
  for (const range of merged) {
    const last = inspected.at(-1);
    if (last?.field === range.field && range.start <= last.end)
      inspected[inspected.length - 1] = { ...last, end: Math.max(last.end, range.end) };
    else inspected.push(range);
  }
  if (inspected.length > 8192)
    return {
      ...state,
      requiredTarget,
      message: 'Inspection limit exceeded — narrow the change.',
      inspected: [],
    };
  if (
    requiredTarget === state.requiredTarget &&
    JSON.stringify(inspected) === JSON.stringify(state.inspected)
  )
    return state;
  return { ...state, requiredTarget, inspected };
}
export type ReviewKeyAction =
  | { readonly kind: 'state'; readonly state: ToolReviewState }
  | { readonly kind: 'approve'; readonly scope: 'once' | 'always' | 'remember' }
  | { readonly kind: 'deny'; readonly reason?: string }
  | { readonly kind: 'abort' | 'copy' | 'close' | 'select' | 'none' };

/**
 * What an answer key says. Every key that answers an approval card is a CTRL CHORD, never a bare letter: while a turn runs
 * the person is often typing the next instruction, and a letter typed at a card that has just appeared is
 * indistinguishable from a deliberate press — "yes do it" would approve a write with its first letter, "can you" would open
 * the reason box, "now" would deny the call. No amount of timing tells typing from a decision (see the guard below), so the
 * keys are ones typing cannot produce: the same rule the question card applies to its skip key (`Ctrl+S`, ADR-0132 — it was
 * a bare `s` until a manual test showed the collision). Ctrl+A is deliberately not an answer: it is the line-start key of
 * every readline habit and the prefix of GNU screen.
 *
 *  - `Ctrl+Y` — allow this call once;
 *  - `Ctrl+G` — ask for the session-wide grant (a TWO-step answer: ENTER, never another chord, confirms — see
 *    {@link APPROVAL_CONFIRM_MIN_MS});
 *  - `Ctrl+O` — a command card only: ask to remember this exact command for this project (a TWO-step answer, like `Ctrl+G`);
 *  - `Ctrl+N` — deny;
 *  - `Ctrl+R` — deny with a reason (opens the reason box on the card).
 */
export type ReviewAnswer = 'allow' | 'always' | 'remember' | 'deny' | 'reason';
export function reviewAnswerKey(input: string, key: ChatKey): ReviewAnswer | undefined {
  if (key.ctrl !== true || key.meta === true) return undefined;
  switch (input) {
    case 'y':
      return 'allow';
    case 'g':
      return 'always';
    case 'o':
      return 'remember';
    case 'n':
      return 'deny';
    case 'r':
      return 'reason';
    default:
      return undefined;
  }
}

/** All navigation/reveal transitions invalidate the current frame before another key can approve. */
export function reduceToolReviewKey(
  state: ToolReviewState,
  input: string,
  key: ChatKey,
  visible: boolean,
  page: ReviewPage | undefined,
  cacheable: boolean,
  callCount: number,
  rememberOffered = false,
): ReviewKeyAction {
  // `Ctrl+C` stops, everywhere (ADR-0115 §1): it rejects the approval and stops the turn, or closes a details view. `Esc` steps
  // back ONE level (§3): inside the reason box or the search box of an approval it closes the box and returns to where it opened,
  // the typed text discarded, the call still pending; only with no box open does it reject the call and stop the turn.
  if (isInterruptKey(input, key)) return { kind: state.kind === 'approval' ? 'abort' : 'close' };
  if (key.escape) {
    if (state.kind !== 'approval') return { kind: 'close' };
    if (state.denial !== undefined) return reviewChange(state, { denial: undefined, message: '' });
    if (state.searching)
      return reviewChange(state, { searching: false, query: undefined, message: '' });
    return { kind: 'abort' };
  }
  if (key.ctrl || key.meta) {
    // A chord answers only an approval card, and never where a text field owns the keyboard: inside the reason box or the
    // search box (or the call list) a chord is not an answer, whatever the letter.
    const answer = state.kind === 'approval' ? reviewAnswerKey(input, key) : undefined;
    if (answer === undefined || isTypingIntoReview(state) || state.screen === 'list')
      return { kind: 'none' };
    // `Ctrl+N` is a plain deny — it grants nothing — so it needs no acknowledged frame: a person who cannot read the
    // review (an unreadable identity, a terminal too small) must still be able to refuse it without stopping the
    // turn. Every answer that GRANTS something stays behind the visible frame.
    if (answer === 'deny') return { kind: 'deny' };
    return visible
      ? reduceApprovalAnswer(state, answer, page, cacheable, rememberOffered)
      : { kind: 'none' };
  }
  const modal = reduceModalReviewKey(state, input, key, visible, callCount);
  if (modal !== undefined) return modal;
  // A command the review cannot hold has nothing to open: its full view would be the same refusal on a blank screen.
  if (
    input === 'v' &&
    state.screen === 'card' &&
    !(state.facts !== undefined && state.document?.valid === false)
  )
    return reviewChange(state, {
      screen: 'full',
      // The full view opens where the card does — on the first change — unless the target the card shortened must be read
      // first; a page the card has not drawn yet (no frame) cannot say, so it opens at the top.
      cursor:
        state.document === undefined
          ? REVIEW_START
          : fullOpeningCursor(state.document, {
              targetShortened:
                page === undefined || (state.requiredTarget ?? page.requiredTarget) !== undefined,
              // The card's geometry stands in for the full view's (a little smaller): the change must be on the page it opens.
              ...(page === undefined
                ? {}
                : {
                    view: {
                      columns: page.columns,
                      rowLimit: page.rowLimit,
                      reveal: false,
                      numeric: false,
                    },
                  }),
            }),
    });
  if (state.screen === 'full' && input === 'p')
    return reviewChange(state, { numeric: !state.numeric });
  if (!visible) return { kind: 'none' };
  if (state.screen === 'full') {
    const navigation = reduceFullReviewKey(state, input, key, page);
    if (navigation.kind !== 'none') return navigation;
  }
  // A bare letter answers nothing — not `y`, `a`, `n` or `c` — so typing at a card never decides it; it is a foreign key.
  return { kind: 'none' };
}

/**
 * Whether `input` is an affirmative answer key (`Ctrl+Y`, `Ctrl+G`) on a card that can be answered: a key the card OWNS even
 * when it does not count (it was refused by a guard, the frame is not yet visible, Allow is locked). Such a key is never
 * "foreign" — a person who pressed it a little early must be able to press it again — and inside the reason box or the
 * search box, where every key is text, it is not an answer key at all.
 */
export function isAffirmativeReviewKey(
  state: ToolReviewState,
  input: string,
  key: ChatKey,
): boolean {
  const answer = reviewAnswerKey(input, key);
  return (
    state.kind === 'approval' &&
    state.screen !== 'list' &&
    state.denial === undefined &&
    !state.searching &&
    // `Ctrl+O` belongs to a command card only: on any other card it stays the foreign key it always was.
    (answer === 'allow' ||
      answer === 'always' ||
      (answer === 'remember' && state.facts !== undefined))
  );
}

/**
 * Whether `key` is ENTER where it can CONFIRM the session-wide grant: on the card or the full view of an approval, and nowhere
 * a text field owns it — in the denial-reason box Enter denies, in the search box it submits the query, in the details list it
 * selects. Enter answers nothing else: the confirmation also needs the question to be open (the store), so this is a
 * necessary condition, never a sufficient one.
 */
export function isAlwaysConfirmKey(state: ToolReviewState, key: ChatKey): boolean {
  return (
    state.kind === 'approval' &&
    state.screen !== 'list' &&
    state.denial === undefined &&
    !state.searching &&
    key.return === true &&
    !key.ctrl &&
    !key.meta
  );
}

/**
 * Whether the person is typing text into the review — the denial-reason box or the search query — where every key is a
 * character, a deletion or the Enter that submits: typing, whatever the key says (a `Ctrl+Y` in a reason is not an answer, and a
 * person who was just typing a sentence has not, a moment later, decided to press Allow).
 */
export function isTypingIntoReview(state: ToolReviewState): boolean {
  return state.denial !== undefined || state.searching;
}

export function toolReviewTarget(
  state: ToolReviewState,
  columns: number,
  rows: number,
): ReviewPage | undefined {
  const document = state.document;
  const line = document?.preview.target === undefined ? undefined : document.lines[0];
  if (document === undefined || line === undefined) return undefined;
  const target = {
    ...document,
    lines: [line],
    remainingBytes: [
      document.fields[line.field] === undefined
        ? 0
        : new TextEncoder().encode(document.fields[line.field]?.text ?? '').byteLength,
      0,
    ],
  };
  return projectReviewPage(
    target,
    REVIEW_START,
    // The card's title row is `<verb> <target>`: project into what the longest verb leaves, so nothing the
    // projection calls shown is cut by the row it is drawn in.
    Math.max(0, columns - 2 - CARD_VERB_COLUMNS),
    Math.max(1, Math.min(2, rows - 16)),
    false,
    false,
  );
}
/**
 * The part of the target the title rows cannot hold, as a range the person must have had on screen before an affirmative
 * answer — or `undefined` when the whole target fits. Both screens and the page read it from here, so the card's lock, the
 * full view's lock sentence and the keys agree before any frame has been acknowledged.
 */
export function reviewRequiredTarget(
  state: ToolReviewState,
  columns: number,
  rows: number,
): SourceRange | undefined {
  const document = state.document;
  const target = toolReviewTarget(state, columns, rows);
  const shortened = target?.next !== undefined || target?.valid === false;
  const line = document?.preview.target === undefined ? undefined : document.lines[0];
  return shortened && line !== undefined
    ? { field: line.field, start: line.start, end: line.end }
    : undefined;
}
/**
 * @param chromeRows the rows the full view spends around its body ({@link fullChrome}'s `rows`); the view that draws the
 *   chrome says how many it is, so the body is exactly what is left. Without it a fixed allowance stands in (a test, a probe).
 */
export function toolReviewPage(
  state: ToolReviewState,
  columns: number,
  rows: number,
  chromeRows?: number,
): ReviewPage | undefined {
  const document = state.document;
  if (document === undefined || state.screen === 'list') return undefined;
  const target = toolReviewTarget(state, columns, rows);
  const shortenedTarget = target?.next !== undefined || target?.valid === false;
  const targetLine = document.preview.target === undefined ? undefined : document.lines[0];
  const requiredTarget = reviewRequiredTarget(state, columns, rows);
  const card = state.screen === 'card';
  const denialRows =
    state.denial === undefined ? 0 : denialReasonDisclosure(Math.max(1, columns - 2)).length;
  // The card's lock is read from what the card draws (the shortened target), not only from what an acknowledged
  // frame has recorded, so its very first frame already says Allow is locked.
  // Only the card draws its lock from this; the full view's chrome counts its own pending inspection once per frame.
  const inspected = card ? reviewInspected(state, requiredTarget) : true;
  // The docked card (ADR-0129) spends up to half the terminal: its title, one summary row, its warnings, the two
  // key rows and any denial capture are chrome; every other row is diff body. The full view's chrome is counted by
  // `fullChrome` (ADR-0134) and handed in.
  const cardRowsFor = (changesNotShown: number, linesNotShown: number): number => {
    const cardChrome =
      CARD_RULE_ROWS +
      Math.max(1, target?.rows.length ?? 0) +
      // The tool-identity row: a command card has none (its title already says `Run`, and its warnings say what is not shown),
      // which is the row it needs for its facts.
      (state.facts === undefined ? 1 : 0) +
      cardWarnings({
        document,
        shortenedTarget,
        targetHiddenBytes: target?.hiddenBytes ?? 0,
        inspected,
        changesNotShown,
        linesNotShown,
        columns: Math.max(1, columns - 2),
        commandFacts: state.facts,
        denialOpen: state.denial !== undefined,
      }).length +
      (state.denial === undefined ? CARD_KEY_ROWS : cardDenialExtraRows(denialRows) + 1) +
      // A command card keeps the note's row free from its first frame: a refusal note must not take a row from the command and with
      // it the answers that are offered only while every row is on screen.
      (state.message === '' && state.facts === undefined ? 0 : 1);
    return Math.min(CARD_MAX_BODY_ROWS, cardRowBudget(rows) - cardChrome);
  };
  const fullRows = fullBodyRows(
    rows,
    chromeRows ?? FULL_DEFAULT_CHROME_ROWS + (state.searching ? 1 : 0),
  );
  // The card opens on the change (with a little context above it), not on the file's first rows. The full view starts
  // where the person's own cursor is — which `v` sets to the same first change — and lists each unchanged line once.
  const opening: ReviewCursor =
    card && targetLine !== undefined ? { line: 1, offset: 0 } : state.cursor;
  // The card's context is counted in rows as well as lines: wrapped lines (prose) could otherwise fill the whole card.
  const estimate = card ? cardRowsFor(0, 0) : 0;
  const openLine = card
    ? cardStartLine(document, opening.line, {
        budgetRows: Math.max(CARD_CONTEXT_LINES, Math.floor(estimate / 3)),
        rowsOf: (index) =>
          lineRows(document, index, {
            columns: Math.max(0, columns - 2),
            rowLimit: Math.max(1, estimate),
            reveal: state.reveal,
            numeric: state.numeric,
          }),
      })
    : opening.line;
  const start = openLine === opening.line ? opening : { line: openLine, offset: 0 };
  const project = (bodyRows: number): ReviewPage =>
    projectReviewPage(
      document,
      start,
      Math.max(0, columns - 2),
      Math.max(1, card ? bodyRows : fullRows),
      state.reveal,
      state.numeric,
      card,
      !card,
    );
  let page = project(cardRowsFor(0, 0));
  // A change (or, without a diff, a line of the call) the body cannot reach gets its own warning row, which the body
  // must make room for — and a shorter body can leave more out, so size it for the count it will print until that
  // count stops moving.
  for (let pass = 0; card && pageLeftOut(document, page) > 0 && pass < 3; pass++) {
    const smaller = project(cardRowsFor(page.hiddenChanges, page.hiddenLines));
    const settled = pageLeftOut(document, smaller) === pageLeftOut(document, page);
    page = smaller;
    if (settled) break;
  }
  return {
    ...page,
    ...(requiredTarget === undefined ? {} : { requiredTarget }),
    valid: page.valid && (state.screen !== 'card' || target?.valid !== false),
  };
}

function initialReviewScreen(
  kind: ToolReviewState['kind'],
  document: ReviewDocument | undefined,
): ToolReviewState['screen'] {
  if (kind === 'approval') return 'card';
  return document === undefined ? 'list' : 'full';
}
function reviewChange(state: ToolReviewState, patch: Partial<ToolReviewState>): ReviewKeyAction {
  return { kind: 'state', state: { ...state, ...patch } };
}
function reduceDenialKey(state: ToolReviewState, input: string, key: ChatKey): ReviewKeyAction {
  const denial = state.denial ?? '';
  if (key.return) {
    const reason = sanitizeApprovalReason(denial);
    return reason === undefined ? { kind: 'deny' } : { kind: 'deny', reason };
  }
  if (key.backspace || key.delete)
    return reviewChange(state, { denial: denial.slice(0, -([...denial].at(-1)?.length ?? 1)) });
  // Preserve the original submitted explanation through redaction. One overflow
  // code point makes the submission omit the whole reason rather than echo a raw prefix.
  if ([...input].length === 1 && denial.length <= MAX_APPROVAL_REASON_INPUT_CHARS)
    return reviewChange(state, { denial: denial + input });
  return { kind: 'none' };
}
/** How far PgUp and PgDn move the selection of the tool-call list. */
const LIST_PAGE = 10;
function reduceListKey(state: ToolReviewState, key: ChatKey, callCount: number): ReviewKeyAction {
  const last = Math.max(0, callCount - 1);
  const select = (selected: number): ReviewKeyAction =>
    reviewChange(state, { selected: Math.min(last, Math.max(0, selected)) });
  if (key.upArrow) return select(state.selected - 1);
  if (key.downArrow) return select(state.selected + 1);
  if (key.pageUp) return select(state.selected - LIST_PAGE);
  if (key.pageDown) return select(state.selected + LIST_PAGE);
  if (key.home) return select(0);
  if (key.end) return select(last);
  if (key.return) return { kind: 'select' };
  return { kind: 'none' };
}

/** Of two landings for one `Tab`, the one nearer in the direction of travel (either may be absent). */
function nearerLanding(
  jumped: ReviewCursor | undefined,
  off: ReviewCursor | undefined,
  forward: boolean,
): ReviewCursor | undefined {
  if (jumped === undefined) return off;
  if (off === undefined) return jumped;
  return compareCursors(off, jumped) < 0 === forward ? off : jumped;
}

function reduceFullReviewKey(
  state: ToolReviewState,
  input: string,
  key: ChatKey,
  page: ReviewPage | undefined,
): ReviewKeyAction {
  const document = state.document;
  // Inspection keys: they change what is shown, never what is answered. Revealing is offered only where something is masked.
  if (input === 'r')
    return document !== undefined && document.masks.length > 0
      ? reviewChange(state, { reveal: !state.reveal, message: '' })
      : { kind: 'none' };
  if (input === '/') return reviewChange(state, { searching: true, query: '' });
  if (input === 'c') return { kind: 'copy' };
  if (input === 'b')
    return state.kind === 'approval'
      ? reviewChange(state, {
          screen: 'card',
          reveal: false,
          numeric: false,
          message: '',
          cursor: REVIEW_START,
        })
      : reviewChange(state, {
          screen: 'list',
          reveal: false,
          numeric: false,
          message: '',
          document: undefined,
          callId: undefined,
          requiredTarget: undefined,
          inspected: [],
          cursor: REVIEW_START,
        });
  if (document === undefined || page === undefined) return { kind: 'none' };
  // Movement. The geometry is the page's own, so a page, an `End` and a scroll agree with what is drawn.
  const view: ScrollView = {
    columns: page.columns,
    rowLimit: page.rowLimit,
    reveal: state.reveal,
    numeric: state.numeric,
  };
  // A key that cannot move still answers: it takes down a note that is no longer true (`No later change`, a clipboard note)
  // instead of leaving it on screen — and a key that does nothing at all is `none`, typing evidence like any other.
  const stale = (): ReviewKeyAction =>
    state.message === '' ? { kind: 'none' } : reviewChange(state, { message: '' });
  const go = (cursor: ReviewCursor | undefined, missing?: string): ReviewKeyAction => {
    if (cursor === undefined)
      return missing === undefined ? stale() : reviewChange(state, { message: missing });
    if (compareCursors(cursor, state.cursor) === 0) return stale();
    return reviewChange(state, { cursor, message: '' });
  };
  if (key.home) return go(topCursor(document));
  if (key.end) return go(lastPageStart(document, view));
  if (key.upArrow || input === 'k') return go(scrollByLines(document, state.cursor, -1, view));
  if (key.downArrow || input === 'j') return go(scrollByLines(document, state.cursor, 1, view));
  if (key.pageUp) return go(pageUp(document, state.cursor, view));
  if (key.pageDown || input === ' ') return go(pageDown(document, state.cursor, page.next, view));
  if (key.tab) {
    const forward = key.shift !== true;
    const direction = forward ? 1 : -1;
    // Two candidates: the opening of the next change that opens elsewhere, and the nearest changed line this page does not
    // draw (the rest of a change longer than a page, or one the wrapped lines above push down). The NEARER one wins, so no
    // changed line is ever stepped over: every landing shows the next one not yet seen.
    const jumped = changeJump(document, state.cursor, direction, view);
    const off = offPageChangeLanding(document, state.cursor, direction, view, page.next);
    const landing = nearerLanding(jumped, off, forward);
    if (landing !== undefined) return go(landing);
    // Changed lines remain but neither lands (a partly drawn line, the last page): page toward them rather than say there is none.
    if (forward && page.changesBelow > 0)
      return go(pageDown(document, state.cursor, page.next, view), 'No later change');
    if (!forward && page.changesAbove > 0)
      return go(pageUp(document, state.cursor, view), 'No earlier change');
    return go(undefined, forward ? 'No later change' : 'No earlier change');
  }
  return { kind: 'none' };
}
/**
 * Whether the page being drawn shows everything an "always" answer would cover. For a diff that is every changed line
 * (the unchanged rows around them are context, not what the grant is about); for a preview without one it is every line
 * of the call — nothing cut off below the page and, on the full view, nothing above it. Evaluated on whichever screen
 * is drawn: a page of the full view shows only its own rows, so paging is the way to read the rest, not a way to have
 * read it.
 */
function pageShowsWhatItGrants(state: ToolReviewState, page: ReviewPage): boolean {
  if (state.document?.preview.diff !== undefined) return page.hiddenChanges === 0;
  const startsAtTop =
    state.screen !== 'full' || (state.cursor.line === 0 && state.cursor.offset === 0);
  return startsAtTop && page.next === undefined;
}
/**
 * Whether the card may offer — and the keys accept — an "always" answer. It is session-wide, so it is offered only
 * when the page currently drawn shows everything it would cover ({@link pageShowsWhatItGrants}); no page, no grant.
 * The card, the full view's legend and the keys all ask this one function, so they cannot disagree.
 */
export function reviewOffersAlways(
  state: ToolReviewState,
  page: ReviewPage | undefined,
  cacheable: boolean,
): boolean {
  return cacheable && page !== undefined && pageShowsWhatItGrants(state, page);
}
/**
 * What the card's body leaves out, in the unit its warning counts: changed lines for a diff, lines of the call for a
 * preview without one. The two are never both non-zero, so one number sizes the warning row.
 */
export function pageLeftOut(document: ReviewDocument, page: ReviewPage): number {
  return document.preview.diff === undefined ? page.hiddenLines : page.hiddenChanges;
}
/** The answer a chord gave, on a card whose frame is visible. `deny` never reaches here (it needs no frame). */
function reduceApprovalAnswer(
  state: ToolReviewState,
  answer: ReviewAnswer,
  page: ReviewPage | undefined,
  cacheable: boolean,
  rememberOffered: boolean,
): ReviewKeyAction {
  if (answer === 'reason') {
    return state.screen === 'card' ? reviewChange(state, { denial: '' }) : { kind: 'none' };
  }
  if (answer === 'deny') return { kind: 'deny' };
  if (
    reviewInspected(state, page?.requiredTarget) &&
    page?.valid !== false &&
    (answer === 'allow' ||
      reviewOffersAlways(state, page, answer === 'remember' ? rememberOffered : cacheable))
  )
    return { kind: 'approve', scope: answer === 'allow' ? 'once' : answer };
  return { kind: 'none' };
}

function reduceSearchKey(state: ToolReviewState, input: string, key: ChatKey): ReviewKeyAction {
  if (key.return) {
    const query = state.query ?? '';
    if (state.document === undefined || query.length === 0)
      return reviewChange(state, { searching: false });
    const cursor = findReviewMatch(state.document, state.cursor, query, state.reveal);
    if (cursor === undefined)
      return reviewChange(state, { searching: false, message: 'No later visible match' });
    return reviewChange(state, { cursor, searching: false, message: 'Match found' });
  }
  if (key.backspace || key.delete)
    return reviewChange(state, { query: (state.query ?? '').slice(0, -1) });
  if (input.length > 0 && [...input].length === 1 && (state.query?.length ?? 0) < 256)
    return reviewChange(state, { query: (state.query ?? '') + input });
  return { kind: 'none' };
}
function findReviewMatch(
  document: ReviewDocument,
  cursor: ReviewCursor,
  query: string,
  reveal: boolean,
): ReviewCursor | undefined {
  for (let index = cursor.line; index < document.lines.length; index++) {
    const line = document.lines[index];
    // A copy the full view does not list has an identical twin that it does: the match is found there, where the page can show it.
    if (line === undefined || line.fullSkip === true) continue;
    const field = document.fields[line.field];
    if (field === undefined) continue;
    const start = Math.max(line.start, index === cursor.line ? cursor.offset : 0);
    const offset = findLineMatch(field, start, line.end, query, reveal);
    if (offset !== undefined) return { line: index, offset };
  }
  return undefined;
}
function findLineMatch(
  field: ReviewField,
  start: number,
  end: number,
  query: string,
  reveal: boolean,
): number | undefined {
  // Search only this line; a field can contain a complete multi-MiB diff side.
  const source = field.text.slice(start, end);
  let from = 0;
  while (from <= source.length - query.length) {
    const relative = source.indexOf(query, from);
    if (relative < 0) break;
    const found = start + relative;
    const maskEnd = reveal ? undefined : intersectingMaskEnd(field, found, query.length);
    if (maskEnd === undefined) return found;
    // Every start before this mask ends intersects it, including overlaps.
    from = Math.max(relative + 1, maskEnd - start);
  }
  return undefined;
}
function intersectingMaskEnd(
  field: ReviewField,
  found: number,
  length: number,
): number | undefined {
  let low = 0,
    high = field.masks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((field.masks[middle]?.end ?? 0) <= found) low = middle + 1;
    else high = middle;
  }
  const mask = field.masks[low];
  return mask !== undefined && mask.start < found + length ? mask.end : undefined;
}

function reduceModalReviewKey(
  state: ToolReviewState,
  input: string,
  key: ChatKey,
  visible: boolean,
  callCount: number,
): ReviewKeyAction | undefined {
  if (state.denial !== undefined)
    return visible ? reduceDenialKey(state, input, key) : { kind: 'none' };
  if (state.screen === 'list')
    return visible ? reduceListKey(state, key, callCount) : { kind: 'none' };
  if (state.searching) return visible ? reduceSearchKey(state, input, key) : { kind: 'none' };
  return undefined;
}
