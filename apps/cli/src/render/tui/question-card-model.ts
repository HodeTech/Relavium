/**
 * The `ask_user` card's PURE state and key reducer
 * ([ADR-0132](../../../../../docs/decisions/0132-the-model-can-ask-the-user-a-structured-question.md); the key table is in the
 * [contract](../../../../../docs/reference/shared-core/built-in-tools.md#ask-the-user--mvp-3d)). Ink-free, so every edge — the first
 * question, nothing chosen, empty text, a digit with no such option — is unit-tested without mounting React.
 *
 * Two rules shape it. `Esc` and `Ctrl-C` ALWAYS stop the turn (as at an approval card, ADR-0115), and every other key is
 * ignored until the card's exact frame has been acknowledged visible, so a key typed ahead of the card cannot choose.
 * The person's own text is one line, bounded, and a paste that would pass the bound is refused whole — never cut.
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
  /** The question being shown. */
  readonly index: number;
  readonly entries: readonly QuestionEntry[];
  /** The open own-text field for the current question, if any. */
  readonly field: EditorState | undefined;
  /** A one-line refusal ("pick at least one", "limit reached") shown in the description row; cleared by the next change. */
  readonly hint: string | undefined;
}

export type QuestionKeyAction =
  | { readonly kind: 'state'; readonly state: QuestionCardState }
  | { readonly kind: 'submit'; readonly answer: AskUserAnswer }
  | { readonly kind: 'skip' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'none' };

const HINT_NOTHING_CHOSEN = 'Pick at least one option, or type your own answer.';
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

/** The question on screen. The request is validated non-empty and `index` never leaves its range. */
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

/** Move past the current question: show the next one, or submit when it was the last. */
function advance(state: QuestionCardState): QuestionKeyAction {
  if (state.index + 1 < state.request.questions.length)
    return {
      kind: 'state',
      state: { ...state, index: state.index + 1, field: undefined, hint: undefined },
    };
  return { kind: 'submit', answer: buildAnswer({ ...state, field: undefined, hint: undefined }) };
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

function reduceListKey(state: QuestionCardState, input: string, key: ChatKey): QuestionKeyAction {
  const question = currentQuestion(state);
  const entry = currentEntry(state);
  const ownRow = question.options.length;
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
  if (key.leftArrow === true)
    return state.index > 0
      ? { kind: 'state', state: { ...state, index: state.index - 1, hint: undefined } }
      : { kind: 'none' };
  if (key.return === true) {
    if (entry.highlight === ownRow)
      return {
        kind: 'state',
        state: { ...state, hint: undefined, field: editorFromText(entry.draft ?? entry.own ?? '') },
      };
    if (!question.multiSelect) return pickOption(state, question, entry, entry.highlight, true);
    if (entry.ticked.length === 0 && entry.own === undefined)
      return { kind: 'state', state: { ...state, hint: HINT_NOTHING_CHOSEN } };
    return advance(state);
  }
  if (input === ' ' && question.multiSelect && entry.highlight < ownRow)
    return pickOption(state, question, entry, entry.highlight, false);
  if (input === 's' && key.ctrl !== true && key.meta !== true) return { kind: 'skip' };
  if (/^[1-9]$/u.test(input)) {
    const optionIndex = Number(input) - 1;
    if (optionIndex < question.options.length)
      return pickOption(state, question, entry, optionIndex, true);
  }
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
    if (text.length === 0)
      return { kind: 'state', state: withEntry(state, { draft: undefined }, { field: undefined }) };
    const accepted = withEntry(
      state,
      {
        own: text,
        draft: undefined,
        ticked: question.multiSelect ? entry.ticked : [],
        highlight: question.options.length,
      },
      { field: undefined },
    );
    // Typing your own answer ends the question in BOTH kinds: in a multi-select question the ticks already made are sent
    // with it. (To tick more after typing, leave the field with `↑` — the draft is kept — tick, and come back.)
    return advance(accepted);
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

/**
 * Reduce one keystroke. `visible` is whether the card's exact frame has been acknowledged visible: until then every key but
 * the stop keys is ignored, so a key typed ahead of the card cannot choose.
 */
export function reduceQuestionKey(
  state: QuestionCardState,
  input: string,
  key: ChatKey,
  visible: boolean,
): QuestionKeyAction {
  if (key.escape === true || (key.ctrl === true && key.meta !== true && input === 'c'))
    return { kind: 'stop' };
  if (key.ctrl === true || key.meta === true) return { kind: 'none' };
  if (!visible) return { kind: 'none' };
  return state.field === undefined
    ? reduceListKey(state, input, key)
    : reduceFieldKey(state, state.field, input, key);
}

/**
 * A bracketed paste into the open field. One line; a paste that would pass the bound is refused WHOLE (a hint, no change) —
 * never cut — and a paste with no field open is ignored.
 */
export function pasteIntoQuestion(
  state: QuestionCardState,
  text: string,
  visible: boolean,
): QuestionCardState {
  if (!visible || state.field === undefined) return state;
  const insert = insertable(text);
  if (insert.length === 0) return state;
  if (codePoints(state.field.text) + codePoints(insert) > ASK_USER_BOUNDS.ownTextCodePoints)
    return { ...state, hint: HINT_LIMIT };
  const field = applyEditorAction(state.field, { kind: 'append', char: insert });
  return { ...state, hint: undefined, field };
}
