/**
 * The `ask_user` card's PURE projection: state in, rows out
 * ([ADR-0132](../../../../../docs/decisions/0132-the-model-can-ask-the-user-a-structured-question.md) §2–§3). Ink-free, so the
 * guarantee the ADR rests on — the worst admissible call fits the twelve-row card at 80×24 — is a unit test over this
 * function, not a hope about a layout engine.
 *
 * The body is at most nine rows: progress/header (1) + question (≤ 2) + options (≤ 4) + the host's own-answer row (1) + the
 * highlighted row's description or hint (1). Every model-authored line is HARD-wrapped by display width (never word-wrapped,
 * because word wrapping can spend a third row on 150 bytes), so an over-long unbroken word is broken, not cut.
 */

import { ASK_USER_BOUNDS, ASK_USER_OWN_ANSWER_GLYPH } from '@relavium/core';

import {
  currentEntry,
  currentQuestion,
  type QuestionCardState,
  type QuestionEntry,
} from './question-card-model.js';
import { displayWidth } from './viewport.js';

/** The most body rows the card ever draws (twelve minus the rule and the two key rows). */
export const QUESTION_CARD_MAX_BODY_ROWS = 9;

export type QuestionRowTone =
  | 'header'
  | 'question'
  | 'option'
  | 'highlight'
  | 'own'
  | 'description'
  | 'hint'
  | 'field';

export interface QuestionCardRow {
  readonly text: string;
  readonly tone: QuestionRowTone;
}

export interface QuestionCardView {
  readonly rule: string;
  readonly body: readonly QuestionCardRow[];
  /** Always two rows: the answer keys, then the stop keys. */
  readonly keys: readonly [string, string];
}

const RULE_LABEL = ' Question from the agent · not an approval ';
const OWN_PLACEHOLDER = 'Type your own answer…';
const OWN_DESCRIPTION = 'Type your own answer. It is sent to the model.';
const STOP_ROW = 'Esc or Ctrl-C stops the turn';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const ASCII_LINE = /^[\x20-\x7e]*$/u;

/** The thin rule that opens the card, fixed host text the model cannot touch. */
export function questionRule(columns: number): string {
  return `─${RULE_LABEL}${'─'.repeat(Math.max(1, columns - 2 - displayWidth(RULE_LABEL)))}`;
}

/**
 * Hard-wrap `text` to rows of at most `width` display columns, breaking at a grapheme boundary. A wide grapheme that does
 * not fit the room left on a row starts the next row (that row is then one column short — never wider than `width`).
 */
export function hardWrap(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  if (ASCII_LINE.test(text)) {
    // Printable ASCII is one column per code unit: slice, no segmentation.
    const rows: string[] = [];
    for (let at = 0; at < text.length; at += limit) rows.push(text.slice(at, at + limit));
    return rows.length === 0 ? [''] : rows;
  }
  const rows: string[] = [];
  let row = '';
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const cells = displayWidth(segment);
    if (used + cells > limit && row.length > 0) {
      rows.push(row);
      row = '';
      used = 0;
    }
    row += segment;
    used += cells;
  }
  if (row.length > 0 || rows.length === 0) rows.push(row);
  return rows;
}

/** The LAST `width` columns of `text` (the end of a long own-text line, so the cursor stays visible), with a leading ellipsis. */
function tail(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  const graphemes = [...segmenter.segment(text)].map((part) => part.segment);
  let out = '';
  let used = 1; // the ellipsis
  for (let index = graphemes.length - 1; index >= 0; index -= 1) {
    const segment = graphemes[index] ?? '';
    const cells = displayWidth(segment);
    if (used + cells > width) break;
    out = segment + out;
    used += cells;
  }
  return `…${out}`;
}

/** The first `width` columns of `text`, with a trailing ellipsis when it was cut — for the accepted own text shown in a row. */
function head(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 1; // the ellipsis
  for (const { segment } of segmenter.segment(text)) {
    const cells = displayWidth(segment);
    if (used + cells > width) break;
    out += segment;
    used += cells;
  }
  return `${out}…`;
}

function mark(multiSelect: boolean, chosen: boolean): string {
  if (multiSelect) return chosen ? '[x]' : '[ ]';
  return chosen ? '(•)' : '( )';
}

function optionRow(
  state: QuestionCardState,
  entry: QuestionEntry,
  index: number,
  width: number,
): QuestionCardRow {
  const question = currentQuestion(state);
  const option = question.options[index];
  const cursor = entry.highlight === index ? '›' : ' ';
  const prefix = `${cursor} ${String(index + 1)} ${mark(question.multiSelect, entry.ticked.includes(index))} `;
  const text = hardWrap(`${prefix}${option?.label ?? ''}`, width)[0] ?? '';
  return { text, tone: entry.highlight === index ? 'highlight' : 'option' };
}

function ownRow(state: QuestionCardState, entry: QuestionEntry, width: number): QuestionCardRow {
  const question = currentQuestion(state);
  const index = question.options.length;
  const cursor = entry.highlight === index ? '›' : ' ';
  const chosen = entry.own !== undefined;
  const prefix = `${cursor}   ${mark(question.multiSelect, chosen)} ${ASK_USER_OWN_ANSWER_GLYPH} `;
  const room = Math.max(1, width - displayWidth(prefix));
  if (state.field !== undefined) {
    const counter =
      [...state.field.text].length >= 400
        ? ` ${String([...state.field.text].length)}/${String(ASK_USER_BOUNDS.ownTextCodePoints)}`
        : '';
    const typed = tail(`${state.field.text}█`, Math.max(1, room - displayWidth(counter)));
    return { text: `${prefix}${typed}${counter}`, tone: 'field' };
  }
  const label = entry.own ?? OWN_PLACEHOLDER;
  return {
    text: `${prefix}${head(label, room)}`,
    tone: entry.highlight === index ? 'highlight' : 'own',
  };
}

function keyRows(state: QuestionCardState, columns: number): readonly [string, string] {
  const question = currentQuestion(state);
  const back = state.index > 0 ? ' · ← back' : '';
  const first =
    state.field === undefined
      ? question.multiSelect
        ? `↑↓ move · Space or 1-4 tick · Enter confirm · s skip all${back}`
        : `↑↓ move · 1-4 or Enter choose · s skip all${back}`
      : 'Enter accept · ↑ back to the list';
  return [head(first, columns - 2), STOP_ROW];
}

/** Project the card. `columns` is the terminal width; the drawable width is two less (the card's own margin). */
export function projectQuestionCard(state: QuestionCardState, columns: number): QuestionCardView {
  const width = Math.max(1, columns - 2);
  const question = currentQuestion(state);
  const entry = currentEntry(state);
  const total = state.request.questions.length;
  const progress = total > 1 ? `  ${String(state.index + 1)} of ${String(total)}` : '';
  const body: QuestionCardRow[] = [
    { text: hardWrap(`${question.header}${progress}`, width)[0] ?? '', tone: 'header' },
    ...hardWrap(question.question, width).map(
      (text): QuestionCardRow => ({ text, tone: 'question' }),
    ),
    ...question.options.map((_, index) => optionRow(state, entry, index, width)),
    ownRow(state, entry, width),
  ];
  const ownIndex = question.options.length;
  const describe =
    state.hint ??
    (entry.highlight === ownIndex
      ? OWN_DESCRIPTION
      : (question.options[entry.highlight]?.description ?? ''));
  body.push({
    text: `  ${head(describe, Math.max(1, width - 2))}`,
    tone: state.hint === undefined ? 'description' : 'hint',
  });
  return { rule: questionRule(columns), body, keys: keyRows(state, columns) };
}
