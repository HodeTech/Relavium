/**
 * The `ask_user` card's PURE state and key reducer
 * ([ADR-0132](../../../../../docs/decisions/0132-the-model-can-ask-the-user-a-structured-question.md); the key table is in the
 * [contract](../../../../../docs/reference/shared-core/built-in-tools.md#ask-the-user--mvp-3d)). Ink-free, so every edge — the first
 * question, nothing chosen, empty text, a digit with no such option — is unit-tested without mounting React.
 *
 * The card is a small wizard. A call with several questions shows them as TABS the person can move between freely with
 * `←`/`→`, ending in a **Review** tab that lists every answer and sends them; a call with one question has no tabs and no
 * review. Typing anywhere on the list starts the own-answer field, so no bare letter is ever a command: the one command key is
 * `Ctrl+S` (skip). `Ctrl+C` ALWAYS stops the turn and `Esc` stops it unless an own-answer field is open, which it closes first (as at an approval
 * card, ADR-0115), and every other key is ignored
 * until the card's exact frame has been acknowledged and has settled, so a key typed ahead of the card cannot choose. The person's
 * own text is one line, bounded, and a paste that would pass the bound is refused whole — never cut.
 */

import {
  ASK_USER_BOUNDS,
  type AskUserAnswer,
  type AskUserQuestion,
  type AskUserRequest,
} from '@relavium/core';
import { stripTerminalControls } from '@relavium/shared/terminal-safe';

import {
  applyEditorAction,
  editorFromText,
  reduceEditorMotion,
  type ChatKey,
  type EditorState,
} from './chat-input.js';

/** One question's working answer. Indexes are option indexes; `options.length` is the host's own-answer row. */
export interface QuestionEntry {
  /** The highlighted row, `0..options.length` (the last row is the type-your-own row). */
  readonly highlight: number;
  /** Chosen option indexes — at most one for a single-select question. */
  readonly ticked: readonly number[];
  /** The person's accepted own text, if any. */
  readonly own: string | undefined;
  /** Text typed into the field and then left with `↑`: restored when the field reopens, never sent. */
  readonly draft: string | undefined;
}

export interface QuestionCardState {
  readonly request: AskUserRequest;
  /** The tab on screen: a question index, or — for a call with several questions — `questions.length`, the Review tab. */
  readonly index: number;
  readonly entries: readonly QuestionEntry[];
  /** The open own-answer field for the current question, if any. */
  readonly field: EditorState | undefined;
  /** A one-line note ("pick at least one", "saved", "limit reached") shown in the description row; cleared by the next change. */
  readonly hint: string | undefined;
}

export type QuestionKeyAction =
  | { readonly kind: 'state'; readonly state: QuestionCardState }
  | { readonly kind: 'submit'; readonly answer: AskUserAnswer }
  | { readonly kind: 'skip' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'none' };

/**
 * How long a question is on screen before any choosing key counts. The measured-frame acknowledgement proves the frame was
 * flushed to the terminal, not that a person could read it: a held or auto-repeating Enter would otherwise answer every
 * remaining question with its first option within milliseconds. The stop keys never wait.
 */
export const QUESTION_SETTLE_MS = 250;

const HINT_NOTHING_CHOSEN = 'Pick at least one option, or type your own answer.';
const HINT_SAVED = 'Saved. Press Enter to continue, or keep picking.';
const HINT_LIMIT = `Limit reached: ${String(ASK_USER_BOUNDS.ownTextCodePoints)} characters.`;

export function initialQuestionCard(request: AskUserRequest): QuestionCardState {
  return {
    request,
    index: 0,
    entries: request.questions.map(() => ({
      highlight: 0,
      ticked: [],
      own: undefined,
      draft: undefined,
    })),
    field: undefined,
    hint: undefined,
  };
}

export const questionCount = (state: QuestionCardState): number => state.request.questions.length;

/** A call with several questions ends in a Review tab; a call with one question submits straight from its question. */
export const hasReview = (state: QuestionCardState): boolean => questionCount(state) > 1;

export const isReview = (state: QuestionCardState): boolean =>
  hasReview(state) && state.index === questionCount(state);

/** The question on screen. Throws on the Review tab, which has none: callers check {@link isReview} first. */
export function currentQuestion(state: QuestionCardState): AskUserQuestion {
  const question = state.request.questions[state.index];
  if (question === undefined) throw new Error('the question card has no question to show');
  return question;
}

export function currentEntry(state: QuestionCardState): QuestionEntry {
  const entry = state.entries[state.index];
  if (entry === undefined) throw new Error('the question card has no entry for its question');
  return entry;
}

/** Whether question `index` carries a complete answer: one choice or text (single-select), or at least one of either (multi). */
export function isAnswered(state: QuestionCardState, index: number): boolean {
  const entry = state.entries[index];
  const question = state.request.questions[index];
  if (entry === undefined || question === undefined) return false;
  const chosen = entry.ticked.length + (entry.own === undefined ? 0 : 1);
  return question.multiSelect ? chosen >= 1 : chosen === 1;
}

/** The first question that still needs an answer, or `undefined` when every one has one. */
export function firstUnanswered(state: QuestionCardState): number | undefined {
  for (let index = 0; index < questionCount(state); index += 1)
    if (!isAnswered(state, index)) return index;
  return undefined;
}

function withEntry(
  state: QuestionCardState,
  patch: Partial<QuestionEntry>,
  rest: Partial<QuestionCardState> = {},
): QuestionCardState {
  const entries = state.entries.map((entry, index) =>
    index === state.index ? { ...entry, ...patch } : entry,
  );
  return { ...state, entries, hint: undefined, ...rest };
}

/** The person's own text as one line: terminal sequences removed, every line break a space, trimmed. */
export function ownTextOf(raw: string): string {
  return stripTerminalControls(raw)
    .replace(/[\r\n\t\u2028\u2029]+/gu, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
}

/** What typing or pasting inserts into the field: the same cleaning, but whitespace is kept (a typed space is real). */
function insertable(raw: string): string {
  return stripTerminalControls(raw)
    .replace(/[\r\n\t\u2028\u2029]/gu, ' ')
    .replace(/\p{Cc}/gu, '');
}

const codePoints = (text: string): number => [...text].length;

/** The answer the card has collected, in question order. */
export function buildAnswer(state: QuestionCardState): AskUserAnswer {
  return {
    kind: 'answered',
    answers: state.request.questions.map((question, index) => {
      const entry = state.entries[index];
      const labels = [...(entry?.ticked ?? [])]
        .sort((a, b) => a - b)
        .flatMap((optionIndex) => {
          const option = question.options[optionIndex];
          return option === undefined ? [] : [option.label];
        });
      return entry?.own === undefined
        ? { selected: labels }
        : { selected: labels, other: entry.own };
    }),
  };
}

/** Move to another tab, keeping every answer. */
function goTo(state: QuestionCardState, index: number): QuestionCardState {
  const last = hasReview(state) ? questionCount(state) : questionCount(state) - 1;
  return {
    ...state,
    index: Math.max(0, Math.min(last, index)),
    field: undefined,
    hint: undefined,
  };
}

/** A question was answered: show the next tab, or — for a one-question call — send. */
function advance(state: QuestionCardState): QuestionKeyAction {
  if (!hasReview(state))
    return { kind: 'submit', answer: buildAnswer({ ...state, field: undefined, hint: undefined }) };
  return { kind: 'state', state: goTo(state, state.index + 1) };
}

function toggled(ticked: readonly number[], optionIndex: number): readonly number[] {
  return ticked.includes(optionIndex)
    ? ticked.filter((value) => value !== optionIndex)
    : [...ticked, optionIndex];
}

/** Choose (single-select) or toggle (multi-select) the option, the same effect for a digit and for `Enter`/`Space`. */
function pickOption(
  state: QuestionCardState,
  question: AskUserQuestion,
  entry: QuestionEntry,
  optionIndex: number,
  advancing: boolean,
): QuestionKeyAction {
  if (question.multiSelect) {
    return {
      kind: 'state',
      state: withEntry(state, {
        ticked: toggled(entry.ticked, optionIndex),
        highlight: optionIndex,
      }),
    };
  }
  const chosen = withEntry(state, {
    ticked: [optionIndex],
    own: undefined,
    highlight: optionIndex,
  });
  return advancing ? advance(chosen) : { kind: 'state', state: chosen };
}

/** Confirm a multi-select question: it needs at least one choice or text of the person's own. */
function confirmMulti(state: QuestionCardState): QuestionKeyAction {
  return isAnswered(state, state.index)
    ? advance(state)
    : { kind: 'state', state: { ...state, hint: HINT_NOTHING_CHOSEN } };
}

/** Open the own-answer field on the current question, with `typed` already inserted (type-to-start) or empty (Enter). */
function openField(state: QuestionCardState, typed: string): QuestionCardState {
  const question = currentQuestion(state);
  const entry = currentEntry(state);
  const base = editorFromText(entry.draft ?? entry.own ?? '');
  const insert = insertable(typed);
  if (codePoints(base.text) + codePoints(insert) > ASK_USER_BOUNDS.ownTextCodePoints)
    return { ...state, hint: HINT_LIMIT };
  const field =
    insert.length === 0 ? base : applyEditorAction(base, { kind: 'append', char: insert });
  return withEntry(state, { highlight: question.options.length }, { field });
}

/** A printable, non-shortcut key — or a chunk of fast typing — that should start the person's own answer. */
function isTyping(input: string, key: ChatKey): boolean {
  if (input.length === 0 || key.ctrl === true || key.meta === true) return false;
  if (key.return === true || key.escape === true || key.tab === true) return false;
  if (input.length === 1 && (input === ' ' || /^[0-9]$/u.test(input))) return false; // Space ticks; a digit picks
  return true;
}

function reduceListKey(state: QuestionCardState, input: string, key: ChatKey): QuestionKeyAction {
  const question = currentQuestion(state);
  const entry = currentEntry(state);
  const ownRow = question.options.length;
  if (hasReview(state)) {
    if (key.leftArrow === true || (key.tab === true && key.shift === true))
      return state.index > 0
        ? { kind: 'state', state: goTo(state, state.index - 1) }
        : { kind: 'none' };
    if (key.rightArrow === true || (key.tab === true && key.shift !== true))
      return { kind: 'state', state: goTo(state, state.index + 1) };
  }
  if (key.upArrow === true)
    return {
      kind: 'state',
      state: withEntry(state, { highlight: Math.max(0, entry.highlight - 1) }),
    };
  if (key.downArrow === true)
    return {
      kind: 'state',
      state: withEntry(state, { highlight: Math.min(ownRow, entry.highlight + 1) }),
    };
  if (key.return === true) {
    if (entry.highlight === ownRow) {
      // Multi-select with text already saved: Enter CONFIRMS the question (typing or Backspace edits the text).
      if (question.multiSelect && entry.own !== undefined) return confirmMulti(state);
      return { kind: 'state', state: openField(state, '') };
    }
    return question.multiSelect
      ? confirmMulti(state)
      : pickOption(state, question, entry, entry.highlight, true);
  }
  if (
    (key.backspace === true || key.delete === true) &&
    entry.highlight === ownRow &&
    entry.own !== undefined
  )
    return { kind: 'state', state: openField(state, '') };
  if (/^[1-9]$/u.test(input)) {
    const optionIndex = Number(input) - 1;
    if (optionIndex < question.options.length)
      return pickOption(state, question, entry, optionIndex, true);
    return { kind: 'none' };
  }
  if (input === ' ' && question.multiSelect && entry.highlight < ownRow)
    return pickOption(state, question, entry, entry.highlight, false);
  // Type-to-start: anything printable begins the person's own answer, wherever the highlight is.
  if (isTyping(input, key)) return { kind: 'state', state: openField(state, input) };
  return { kind: 'none' };
}

function reduceFieldKey(
  state: QuestionCardState,
  field: EditorState,
  input: string,
  key: ChatKey,
): QuestionKeyAction {
  const question = currentQuestion(state);
  const entry = currentEntry(state);
  if (key.upArrow === true)
    return {
      kind: 'state',
      state: withEntry(
        state,
        { draft: field.text.length === 0 ? undefined : field.text },
        { field: undefined },
      ),
    };
  if (key.return === true && key.shift !== true) {
    const text = ownTextOf(field.text);
    // An empty field is how a person TAKES BACK text they had accepted: it clears it (and the draft), so a multi-select
    // question can return to ticks only.
    if (text.length === 0)
      return {
        kind: 'state',
        state: withEntry(state, { draft: undefined, own: undefined }, { field: undefined }),
      };
    const saved = withEntry(
      state,
      {
        own: text,
        draft: undefined,
        ticked: question.multiSelect ? entry.ticked : [],
        highlight: question.options.length,
      },
      { field: undefined },
    );
    // Single-select: the text IS the answer, so move on. Multi-select: saving the text is separate from confirming the
    // question — the person may still tick more — so it stays here, and the next Enter confirms.
    return question.multiSelect
      ? { kind: 'state', state: { ...saved, hint: HINT_SAVED } }
      : advance(saved);
  }
  const action = reduceEditorMotion(input, key);
  if (action === undefined || action.kind === 'newline') return { kind: 'none' };
  if (action.kind === 'append') {
    const text = insertable(action.char);
    if (text.length === 0) return { kind: 'none' };
    if (codePoints(field.text) + codePoints(text) > ASK_USER_BOUNDS.ownTextCodePoints)
      return { kind: 'state', state: { ...state, hint: HINT_LIMIT } };
    return {
      kind: 'state',
      state: {
        ...state,
        hint: undefined,
        field: applyEditorAction(field, { ...action, char: text }),
      },
    };
  }
  return {
    kind: 'state',
    state: { ...state, hint: undefined, field: applyEditorAction(field, action) },
  };
}

function reduceReviewKey(state: QuestionCardState, input: string, key: ChatKey): QuestionKeyAction {
  if (key.leftArrow === true || (key.tab === true && key.shift === true))
    return { kind: 'state', state: goTo(state, state.index - 1) };
  if (key.return === true) {
    const missing = firstUnanswered(state);
    if (missing === undefined) return { kind: 'submit', answer: buildAnswer(state) };
    return {
      kind: 'state',
      state: {
        ...goTo(state, missing),
        hint: `Question ${String(missing + 1)} is not answered yet.`,
      },
    };
  }
  if (/^[1-9]$/u.test(input)) {
    const target = Number(input) - 1;
    if (target < questionCount(state)) return { kind: 'state', state: goTo(state, target) };
  }
  return { kind: 'none' };
}

/**
 * Reduce one keystroke. `visible` is whether the card's exact frame has been acknowledged visible and has settled: until
 * then every key but the stop keys is ignored, so a key typed ahead of the card cannot choose.
 */
export function reduceQuestionKey(
  state: QuestionCardState,
  input: string,
  key: ChatKey,
  visible: boolean,
): QuestionKeyAction {
  // `Ctrl+C` stops wherever the person is. `Esc` steps back one level (ADR-0115 §3): it closes an open own-answer field, the typed
  // text discarded and the call still pending, and stops the turn only when there is nothing left to close.
  if (key.ctrl === true && key.meta !== true && input === 'c') return { kind: 'stop' };
  if (key.escape === true) {
    if (state.field === undefined) return { kind: 'stop' };
    return { kind: 'state', state: withEntry(state, { draft: undefined }, { field: undefined }) };
  }
  if (!visible) return { kind: 'none' };
  // `Ctrl+S` skips the whole call. It is the ONLY command key: no bare letter is one, so typing never skips.
  if (key.ctrl === true && key.meta !== true && input === 's') return { kind: 'skip' };
  if (key.ctrl === true || key.meta === true) return { kind: 'none' };
  if (isReview(state)) return reduceReviewKey(state, input, key);
  return state.field === undefined
    ? reduceListKey(state, input, key)
    : reduceFieldKey(state, state.field, input, key);
}

/**
 * A bracketed paste. Into the open field it inserts one line; on the list it starts the own-answer field with the pasted text
 * (as typing would); on the Review tab it is ignored. A paste that would pass the bound is refused WHOLE (a hint, no change) —
 * never cut.
 */
export function pasteIntoQuestion(
  state: QuestionCardState,
  text: string,
  visible: boolean,
): QuestionCardState {
  if (!visible || isReview(state)) return state;
  if (state.field === undefined) return openField(state, text);
  const insert = insertable(text);
  if (insert.length === 0) return state;
  if (codePoints(state.field.text) + codePoints(insert) > ASK_USER_BOUNDS.ownTextCodePoints)
    return { ...state, hint: HINT_LIMIT };
  const field = applyEditorAction(state.field, { kind: 'append', char: insert });
  return { ...state, hint: undefined, field };
}
