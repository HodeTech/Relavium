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

import { ASK_USER_BOUNDS } from '@relavium/core';

import {
  currentEntry,
  currentQuestion,
  hasReview,
  isAnswered,
  isReview,
  type QuestionCardState,
  type QuestionEntry,
} from './question-card-model.js';
import {
  exitKey,
  fitLegend,
  type LegendExit,
  type LegendItem,
  type OptionalItem,
  LEGEND_SEPARATOR,
  legend,
  legendItems,
} from './legend.js';
import { blankHostMarks, glyph, plainFormInForce } from './glyphs.js';
import { sheetRule } from './sheet-frame.js';
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

const RULE_LABEL = 'Question from the agent · not an approval';
const OWN_PLACEHOLDER = 'Type your own answer…';
const OWN_DESCRIPTION = 'Just start typing — it is sent to the model.';
/** `Esc` and `Ctrl+C` both stop the turn: the key that leaves says so, and what it does. */
export const QUESTION_STOP: LegendExit = exitKey.decide('stops the turn', ['Esc', 'Ctrl+C']);
/** With the own-answer field open `Esc` closes it first (ADR-0115 §3), so only `Ctrl+C` is the stop key there. */
const FIELD_STOP_KEY: LegendItem = { keys: 'Ctrl+C', verb: 'stops the turn', role: 'warn' };
const FIELD_EXIT: LegendExit = exitKey.close();
/**
 * Said only where a write needs no card (`accept-edits`, `auto`): there an answer is the person's only lever and it is not a
 * veto — nothing in the card otherwise tells them the agent may still act (ADR-0132 §6).
 */
const GUIDE_NOTE: LegendItem = { text: 'an answer is guidance, not a veto' };
/**
 * The host's gutter. EVERY row of model-authored text (the header, the question, the highlighted description) starts with it, and
 * the glyph is refused inside model text, so column 0 of a wrapped line belongs to the renderer: a forged option row can neither
 * begin at the start of the header or of the question nor at any later wrap boundary (the header was drawn at column 0 until a
 * lookalike of the host's cursor row there, `˃ 1 (∗)`, was shown to pass for it). Host text (hints, the own-row note) is NOT
 * behind it, so the gutter means "the agent wrote this", and the tab strip that follows the header on its row is the one host
 * text beside it.
 */
const GUTTER = '│ ';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const ASCII_LINE = /^[\x20-\x7e]*$/u;

/**
 * The heavy rule that opens the card (ADR-0147 §1), fixed host text the model cannot touch, with the wait clock on its right (`clock`, the host's
 * display value; empty: none). As wide as the thin rule it replaced, so the card's rows do not move; the label survives word for word.
 */
export function questionRule(columns: number, clock = ''): string {
  return sheetRule(RULE_LABEL, clock, Math.max(1, columns - 1)).text;
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
  return chosen ? `(${glyph('bullet')})` : '( )';
}

/**
 * The tab strip: one dot per question (filled once answered) and the Review tab. The dot on screen is bracketed, but in the plain form
 * it is drawn `<o>` and `<+>`, not `[o]` and `[+]`: a letter in brackets is a key under the legend's grammar, and `o` really types into the
 * own-answer field (ADR-0145 §3).
 */
function tabs(state: QuestionCardState): string {
  const plain = plainFormInForce();
  const dots = state.request.questions.map((_, index) => {
    const dot = glyph(isAnswered(state, index) ? 'answered' : 'pending');
    if (state.index !== index) return dot;
    return plain ? `<${dot}>` : `[${dot}]`;
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
  const cursor = entry.highlight === index ? glyph('selection') : ' ';
  const prefix = `${cursor} ${String(index + 1)} ${mark(question.multiSelect, chosen)} `;
  const text = hardWrap(`${prefix}${blankHostMarks(option?.label ?? '')}`, width)[0] ?? '';
  return { text, tone: entry.highlight === index ? 'highlight' : chosen ? 'chosen' : 'option' };
}

function ownRow(state: QuestionCardState, entry: QuestionEntry, width: number): QuestionCardRow {
  const question = currentQuestion(state);
  const index = question.options.length;
  const cursor = entry.highlight === index ? glyph('selection') : ' ';
  const chosen = entry.own !== undefined;
  const prefix = `${cursor}   ${mark(question.multiSelect, chosen)} ${glyph('pencil')} `;
  const room = Math.max(1, width - displayWidth(prefix));
  if (state.field !== undefined) {
    const counter =
      [...state.field.text].length >= 400
        ? ` ${String([...state.field.text].length)}/${String(ASK_USER_BOUNDS.ownTextCodePoints)}`
        : '';
    const typed = tail(
      `${state.field.text}${glyph('caret')}`,
      Math.max(1, room - displayWidth(counter)),
    );
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
      return option === undefined ? [] : [blankHostMarks(option.label)];
    });
  return [...labels, ...(entry.own === undefined ? [] : [`“${entry.own}”`])].join(', ');
}

/**
 * The first key row: the keys that answer, the optional ones dropped (the lowest priority first) when they do not fit, and the whole row
 * cut with an ellipsis only when the essentials alone are too wide. The stop keys are on the second row, so the room this row has is the
 * width, not the width less the exit's.
 */
function answerRow(
  essentials: readonly LegendItem[],
  optional: readonly OptionalItem[],
  width: number,
): string {
  const exitRoom = LEGEND_SEPARATOR.length + displayWidth(legend([], QUESTION_STOP));
  const kept = fitLegend(essentials, optional, QUESTION_STOP, width + exitRoom, displayWidth);
  return head(legendItems(kept).text, width);
}

function keyRows(
  state: QuestionCardState,
  columns: number,
  guideNote: boolean,
): readonly [string, string] {
  const width = columns - 2;
  const several = hasReview(state);
  const skip: LegendItem = { keys: 'Ctrl+S', verb: 'skip all' };
  const questions: LegendItem = { keys: '←/→', verb: 'questions' };
  let first: string;
  if (isReview(state)) {
    first = answerRow([{ keys: 'Enter', verb: 'send answers' }, questions, skip], [], width);
  } else if (state.field !== undefined) {
    first = answerRow(
      [{ keys: 'Enter', verb: 'save' }, { keys: '↑', verb: 'back to the list' }, skip],
      [],
      width,
    );
  } else if (currentQuestion(state).multiSelect) {
    first = answerRow(
      [
        { keys: '↑/↓', verb: 'move' },
        { keys: 'Space', verb: 'tick' },
        { keys: 'Enter', verb: 'continue' },
      ],
      [...(several ? [{ item: questions, priority: 2 }] : []), { item: skip, priority: 1 }],
      width,
    );
  } else {
    first = answerRow(
      [
        { keys: '↑/↓', verb: 'move' },
        { keys: 'Enter', verb: 'choose' },
      ],
      [
        { item: { text: 'type your own' }, priority: 3 },
        ...(several ? [{ item: questions, priority: 2 }] : []),
        { item: skip, priority: 1 },
      ],
      width,
    );
  }
  return [first, head(stopRow(state, guideNote, width), width)];
}

/**
 * The second key row: the keys that stop, and the note that an answer is guidance where one is wanted. The keys that leave are required and
 * the note is the one thing that gives way, so in a narrow terminal it is the note that is dropped and the exit that stays whole (the old
 * order cut the exit and kept the note: `…Esc / [Ctrl…`). Written by {@link fitLegend}, the one fit-to-width rule.
 */
function stopRow(state: QuestionCardState, guideNote: boolean, width: number): string {
  const inField = state.field !== undefined && !isReview(state);
  const exit = inField ? FIELD_EXIT : QUESTION_STOP;
  const required = inField ? [FIELD_STOP_KEY] : [];
  const note: readonly OptionalItem[] = guideNote ? [{ item: GUIDE_NOTE, priority: 1 }] : [];
  return legend(fitLegend(required, note, exit, width, displayWidth), exit);
}

/** The Review tab's rows for answers: the body bound minus its title, and minus its closing hint when it has one (otherwise the row is theirs). */
const REVIEW_ANSWER_ROWS = QUESTION_CARD_MAX_BODY_ROWS - 1;
/** A wrapped answer continues under its own row, indented, so column 0 stays the host's (no answer text can pose as a new row). */
const REVIEW_INDENT = '    ';

/** `text` as rows, the first `firstWidth` columns wide and the rest `restWidth`, each cut at a grapheme boundary. */
function wrapRows(text: string, firstWidth: number, restWidth: number): string[] {
  const first = hardWrap(text, firstWidth)[0] ?? '';
  const rest = text.slice(first.length);
  return rest === '' ? [first] : [first, ...hardWrap(rest, restWidth)];
}

/** How many rows each answer is given out of `budget`: one each, then the rest to whichever still needs the most. */
function shareRows(needs: readonly number[], budget: number): number[] {
  const given = needs.map(() => 1);
  for (let spare = budget - needs.length; spare > 0; spare -= 1) {
    let pick = -1;
    let most = 0;
    needs.forEach((need, index) => {
      const unmet = need - (given[index] ?? 1);
      if (unmet > most) {
        most = unmet;
        pick = index;
      }
    });
    if (pick < 0) break;
    given[pick] = (given[pick] ?? 1) + 1;
  }
  return given;
}

/** What the last shown row of a cut answer says it left out: a count, never a bare ellipsis. */
function hiddenNotice(hidden: number): string {
  return `… ${String(hidden)} more character${hidden === 1 ? '' : 's'} not shown`;
}

/**
 * One answer's rows within `allowed` rows. An answer that fits is shown whole; one that does not ends its last row with the
 * number of characters (code points) it left out, so the Review tab never shows less than it will send without saying so.
 */
function answerRows(lines: readonly string[], allowed: number, width: number): string[] {
  const indent = (line: string, at: number): string =>
    at === 0 ? line : `${REVIEW_INDENT}${line}`;
  if (lines.length <= allowed) return lines.map((line, at) => indent(line, at));
  const shown = lines.slice(0, allowed);
  const last = shown.length - 1;
  const total = [...lines.join('')].length;
  const lastWidth = last === 0 ? width : width - REVIEW_INDENT.length;
  const room = Math.max(0, lastWidth - displayWidth(hiddenNotice(total)) - 1);
  let kept = '';
  let used = 0;
  for (const { segment } of segmenter.segment(shown[last] ?? '')) {
    const cells = displayWidth(segment);
    if (used + cells > room) break;
    kept += segment;
    used += cells;
  }
  const before = [...shown.slice(0, last).join('')].length + [...kept].length;
  const rows = [...shown.slice(0, last), `${kept} ${hiddenNotice(total - before)}`];
  return rows.map((row, at) => head(indent(row, at), width));
}

/**
 * The Review tab: every answer as it will be sent, wrapped over as many rows as the body bound leaves (a short answer takes one,
 * a long one takes what the short ones left), and where even that is not enough the answer says how much it hides. The title and
 * the closing hint (when there is one) are one row each; the keys are the first key row's, never repeated in the body.
 */
function projectReview(state: QuestionCardState, width: number): readonly QuestionCardRow[] {
  const rest = Math.max(1, width - REVIEW_INDENT.length);
  const answers = state.request.questions.map((question, index) => {
    const answered = isAnswered(state, index);
    const line = `${glyph(answered ? 'answered' : 'pending')} ${String(index + 1)} ${blankHostMarks(question.header)} → ${answered ? summaryOf(state, index) : 'not answered yet'}`;
    return {
      tone: answered ? ('chosen' as const) : ('pending' as const),
      lines: wrapRows(line, width, rest),
    };
  });
  const allowed = shareRows(
    answers.map((answer) => answer.lines.length),
    REVIEW_ANSWER_ROWS - (state.hint === undefined ? 0 : 1),
  );
  const rows: QuestionCardRow[] = [
    // The same title line as the question pages (ADR-0147 §1): behind the gutter, the strip flush right.
    { text: headerRow(state, 'Review your answers', width), tone: 'header' },
    ...answers.flatMap((answer, index) =>
      answerRows(answer.lines, allowed[index] ?? 1, width).map(
        (text): QuestionCardRow => ({ text, tone: answer.tone }),
      ),
    ),
  ];
  // The keys of this tab are the first key row's (`Enter send answers · ←/→ questions · [Ctrl+S] skip all`): a second row that said them
  // again in other words (`send them`, `[1-2] change one`) is not drawn. The one thing this row can still say is a hint.
  if (state.hint !== undefined) rows.push({ text: head(state.hint, width), tone: 'hint' });
  return rows;
}

/**
 * The card's title line (ADR-0147 §1): the header behind the gutter on the left and the question strip (host text: the dots and `Review`) flush
 * right, when both fit `width` with two columns between them; otherwise the strip follows the header as before, on the header's first row.
 */
function headerRow(state: QuestionCardState, header: string, width: number): string {
  const gutterWidth = displayWidth(GUTTER);
  if (!hasReview(state)) return `${GUTTER}${hardWrap(header, width - gutterWidth)[0] ?? ''}`;
  const strip = tabs(state);
  const left = `${GUTTER}${header}`;
  const gap = width - displayWidth(left) - displayWidth(strip);
  if (gap >= 2) return `${left}${' '.repeat(gap)}${strip}`;
  return `${GUTTER}${hardWrap(`${header}  ${strip}`, width - gutterWidth)[0] ?? ''}`;
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
  const body: QuestionCardRow[] = [
    { text: headerRow(state, blankHostMarks(question.header), width), tone: 'header' },
    ...hardWrap(blankHostMarks(question.question), width - gutterWidth).map(
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
      text: `${GUTTER}${head(blankHostMarks(highlighted.description), Math.max(1, width - gutterWidth))}`,
      tone: 'description',
    });
  }
  return { rule: questionRule(columns), body, keys };
}
