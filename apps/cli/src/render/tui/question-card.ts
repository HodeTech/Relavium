/**
 * The `ask_user` card's PURE projection: state in, rows out
 * ([ADR-0132](../../../../../docs/decisions/0132-the-model-can-ask-the-user-a-structured-question.md) §2–§3). Ink-free, so the
 * guarantee the ADR rests on — the worst admissible call fits the twelve-row card at 80×24 — is a unit test over this
 * function, not a hope about a layout engine.
 *
 * A question tab's body is at most nine rows: progress/header (1) + question (≤ 2) + options (≤ 4) + the host's own-answer row
 * (1) + the highlighted row's description or hint (1). The Review tab is shorter (a title, one row per question, a hint). Every
 * model-authored line is HARD-wrapped by display width (never word-wrapped, because word wrapping can spend a third row on 150
 * bytes), so an over-long unbroken word is broken, not cut — and every row of model text sits behind the host's gutter `│ `.
 */

import { ASK_USER_BOUNDS, ASK_USER_OWN_ANSWER_GLYPH } from '@relavium/core';

import {
  currentEntry,
  currentQuestion,
  hasReview,
  isAnswered,
  isReview,
  questionCount,
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
  | 'chosen'
  | 'highlight'
  | 'own'
  | 'description'
  | 'hint'
  | 'field'
  | 'pending';

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
const OWN_DESCRIPTION = 'Just start typing — it is sent to the model.';
const STOP_ROW = 'Esc or Ctrl+C stops the turn';
/** With the own-answer field open `Esc` closes it first (ADR-0115 §3), so only `Ctrl+C` is the stop key there. */
const FIELD_STOP_ROW = 'Esc closes · Ctrl+C stops the turn';
/**
 * Said only where a write needs no card (`accept-edits`, `auto`): there an answer is the person's only lever and it is not a
 * veto — nothing in the card otherwise tells them the agent may still act (ADR-0132 §6).
 */
const GUIDE_NOTE = ' · an answer is guidance, not a veto';
/**
 * The host's gutter. EVERY row of model-authored text (the question, the highlighted description) starts with it, and the
 * glyph is refused inside model text, so column 0 of a wrapped line belongs to the renderer: a forged option row can neither
 * begin at the start of the question nor at any later wrap boundary. Host text (hints, the own-row note) is NOT behind it, so
 * the gutter always means "the agent wrote this".
 */
const GUTTER = '│ ';
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

/** The first `width` columns of `text`, with a trailing ellipsis when it was cut. */
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

/** The tab strip: one dot per question (filled once answered, bracketed when on screen) and the Review tab. */
function tabs(state: QuestionCardState): string {
  const dots = state.request.questions.map((_, index) => {
    const dot = isAnswered(state, index) ? '●' : '○';
    return state.index === index ? `[${dot}]` : dot;
  });
  return `${dots.join(' ')} · ${isReview(state) ? '[Review]' : 'Review'}`;
}

function optionRow(
  state: QuestionCardState,
  entry: QuestionEntry,
  index: number,
  width: number,
): QuestionCardRow {
  const question = currentQuestion(state);
  const option = question.options[index];
  const chosen = entry.ticked.includes(index);
  const cursor = entry.highlight === index ? '›' : ' ';
  const prefix = `${cursor} ${String(index + 1)} ${mark(question.multiSelect, chosen)} `;
  const text = hardWrap(`${prefix}${option?.label ?? ''}`, width)[0] ?? '';
  return { text, tone: entry.highlight === index ? 'highlight' : chosen ? 'chosen' : 'option' };
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
    tone: entry.highlight === index ? 'highlight' : chosen ? 'chosen' : 'own',
  };
}

/** What a question's answer reads as on the Review tab: the chosen labels, then the person's own text in quotes. */
function summaryOf(state: QuestionCardState, index: number): string {
  const question = state.request.questions[index];
  const entry = state.entries[index];
  if (question === undefined || entry === undefined) return '';
  const labels = [...entry.ticked]
    .sort((a, b) => a - b)
    .flatMap((optionIndex) => {
      const option = question.options[optionIndex];
      return option === undefined ? [] : [option.label];
    });
  return [...labels, ...(entry.own === undefined ? [] : [`“${entry.own}”`])].join(', ');
}

/** Pick the legend parts that fit, dropping the least important optional ones first; the essentials always stay. */
function legend(essentials: readonly string[], optional: readonly string[], width: number): string {
  const join = (extra: readonly string[]): string => [...essentials, ...extra].join(' · ');
  let keep = [...optional];
  while (keep.length > 0 && displayWidth(join(keep)) > width) keep = keep.slice(0, -1);
  return head(join(keep), width);
}

function keyRows(
  state: QuestionCardState,
  columns: number,
  guideNote: boolean,
): readonly [string, string] {
  const width = columns - 2;
  const several = hasReview(state);
  let first: string;
  if (isReview(state)) {
    first = legend(['Enter send answers', '←→ questions', 'Ctrl+S skip all'], [], width);
  } else if (state.field !== undefined) {
    first = legend(['Enter save', '↑ back to the list', 'Ctrl+S skip all'], [], width);
  } else if (currentQuestion(state).multiSelect) {
    first = legend(
      ['↑↓ move', 'Space tick', 'Enter continue'],
      [...(several ? ['←→ questions'] : []), 'Ctrl+S skip all'],
      width,
    );
  } else {
    first = legend(
      ['↑↓ move', 'Enter choose'],
      ['type your own', ...(several ? ['←→ questions'] : []), 'Ctrl+S skip all'],
      width,
    );
  }
  const stop = state.field !== undefined && !isReview(state) ? FIELD_STOP_ROW : STOP_ROW;
  return [first, head(guideNote ? `${stop}${GUIDE_NOTE}` : stop, width)];
}

/** The Review tab: every answer on one row, the way it will be sent, and what to do next. */
function projectReview(state: QuestionCardState, width: number): readonly QuestionCardRow[] {
  const rows: QuestionCardRow[] = [
    { text: head(`Review your answers  ${tabs(state)}`, width), tone: 'header' },
  ];
  state.request.questions.forEach((question, index) => {
    const answered = isAnswered(state, index);
    const line = `${answered ? '●' : '○'} ${String(index + 1)} ${question.header} → ${answered ? summaryOf(state, index) : 'not answered yet'}`;
    rows.push({ text: head(line, width), tone: answered ? 'chosen' : 'pending' });
  });
  rows.push({
    text: head(
      state.hint === undefined
        ? `Enter sends them · ←→ or 1-${String(questionCount(state))} to change one`
        : state.hint,
      width,
    ),
    tone: state.hint === undefined ? 'description' : 'hint',
  });
  return rows;
}

/** Project the card. `columns` is the terminal width; the drawable width is two less (the card's own margin). */
export function projectQuestionCard(
  state: QuestionCardState,
  columns: number,
  options: { readonly guideNote?: boolean } = {},
): QuestionCardView {
  const width = Math.max(1, columns - 2);
  const gutterWidth = displayWidth(GUTTER);
  const keys = keyRows(state, columns, options.guideNote === true);
  if (isReview(state))
    return { rule: questionRule(columns), body: projectReview(state, width), keys };
  const question = currentQuestion(state);
  const entry = currentEntry(state);
  const progress = hasReview(state) ? `  ${tabs(state)}` : '';
  const body: QuestionCardRow[] = [
    { text: hardWrap(`${question.header}${progress}`, width)[0] ?? '', tone: 'header' },
    ...hardWrap(question.question, width - gutterWidth).map(
      (text): QuestionCardRow => ({ text: `${GUTTER}${text}`, tone: 'question' }),
    ),
    ...question.options.map((_, index) => optionRow(state, entry, index, width)),
    ownRow(state, entry, width),
  ];
  const ownIndex = question.options.length;
  const highlighted = question.options[entry.highlight];
  if (state.hint !== undefined) {
    body.push({ text: `  ${head(state.hint, Math.max(1, width - 2))}`, tone: 'hint' });
  } else if (entry.highlight === ownIndex || highlighted === undefined) {
    body.push({ text: `  ${head(OWN_DESCRIPTION, Math.max(1, width - 2))}`, tone: 'description' });
  } else {
    body.push({
      text: `${GUTTER}${head(highlighted.description, Math.max(1, width - gutterWidth))}`,
      tone: 'description',
    });
  }
  return { rule: questionRule(columns), body, keys };
}
