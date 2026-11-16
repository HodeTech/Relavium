import { ASK_USER_BOUNDS, type AskUserRequest } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import type { ChatKey } from './chat-input.js';
import {
  buildAnswer,
  currentEntry,
  initialQuestionCard,
  ownTextOf,
  pasteIntoQuestion,
  reduceQuestionKey,
  type QuestionCardState,
  type QuestionKeyAction,
} from './question-card-model.js';

const OPTIONS = [
  { label: 'Alpha', description: 'The first' },
  { label: 'Beta', description: 'The second' },
  { label: 'Gamma', description: 'The third' },
];

const single = { header: 'One', question: 'Which?', multiSelect: false, options: OPTIONS };
const multi = { header: 'Many', question: 'Which ones?', multiSelect: true, options: OPTIONS };

const requestOf = (...questions: AskUserRequest['questions']): AskUserRequest => ({ questions });

const ARROW = {
  up: { upArrow: true },
  down: { downArrow: true },
  left: { leftArrow: true },
  enter: { return: true },
  esc: { escape: true },
  backspace: { backspace: true },
} satisfies Record<string, ChatKey>;

/** Apply a key; return the action, and the next state when the action carries one. */
function press(
  state: QuestionCardState,
  input: string,
  key: ChatKey = {},
  visible = true,
): { action: QuestionKeyAction; state: QuestionCardState } {
  const action = reduceQuestionKey(state, input, key, visible);
  return { action, state: action.kind === 'state' ? action.state : state };
}

/** Apply a sequence of keys, returning the final state and the last action. */
function run(
  start: QuestionCardState,
  keys: readonly (string | ChatKey)[],
): { action: QuestionKeyAction; state: QuestionCardState } {
  let state = start;
  let action: QuestionKeyAction = { kind: 'none' };
  for (const key of keys) {
    ({ action, state } = typeof key === 'string' ? press(state, key) : press(state, '', key));
  }
  return { action, state };
}

const submitted = (result: { action: QuestionKeyAction }) => {
  if (result.action.kind !== 'submit')
    throw new Error(`expected a submit, got ${result.action.kind}`);
  return result.action.answer;
};

describe('the stop keys (ADR-0132 §3, ADR-0115)', () => {
  it.each([
    ['Esc', '', ARROW.esc],
    ['Ctrl-C', 'c', { ctrl: true }],
  ])(
    '%s stops the turn from the list, from the field, and before the frame is acknowledged',
    (_n, input, key) => {
      const start = initialQuestionCard(requestOf(single));
      expect(reduceQuestionKey(start, input, key, true).kind).toBe('stop');
      expect(reduceQuestionKey(start, input, key, false).kind).toBe('stop');
      const open = run(start, [
        { downArrow: true },
        { downArrow: true },
        { downArrow: true },
        ARROW.enter,
      ]).state;
      expect(open.field).toBeDefined();
      expect(reduceQuestionKey(open, input, key, true).kind).toBe('stop');
    },
  );

  it('Ctrl-anything-else and Alt chords do nothing (the card is not a shell)', () => {
    const start = initialQuestionCard(requestOf(single));
    expect(reduceQuestionKey(start, 'a', { ctrl: true }, true).kind).toBe('none');
    expect(reduceQuestionKey(start, 'x', { meta: true }, true).kind).toBe('none');
    expect(reduceQuestionKey(start, 's', { ctrl: true }, true).kind).toBe('none');
  });
});

describe('typed-ahead keys cannot choose (the measured-frame guard)', () => {
  it.each(['1', 's', ' '])('ignores %j until the frame is acknowledged', (input) => {
    const start = initialQuestionCard(requestOf(single));
    expect(reduceQuestionKey(start, input, {}, false).kind).toBe('none');
    expect(reduceQuestionKey(start, '', ARROW.enter, false).kind).toBe('none');
    expect(reduceQuestionKey(start, '', ARROW.down, false).kind).toBe('none');
  });
});

describe('a single-select question', () => {
  it('starts on the first option with nothing chosen', () => {
    const start = initialQuestionCard(requestOf(single));
    expect(currentEntry(start)).toEqual({
      highlight: 0,
      ticked: [],
      own: undefined,
      draft: undefined,
    });
  });

  it('a digit chooses that option and submits the last question', () => {
    expect(submitted(run(initialQuestionCard(requestOf(single)), ['2']))).toEqual({
      kind: 'answered',
      answers: [{ selected: ['Beta'] }],
    });
  });

  it('Enter chooses the HIGHLIGHTED option, not the first', () => {
    const answer = submitted(
      run(initialQuestionCard(requestOf(single)), [ARROW.down, ARROW.enter]),
    );
    expect(answer).toEqual({ kind: 'answered', answers: [{ selected: ['Beta'] }] });
  });

  it('ignores a digit with no such option, and Space', () => {
    const start = initialQuestionCard(requestOf(single));
    expect(press(start, '4').action.kind).toBe('none');
    expect(press(start, '9').action.kind).toBe('none');
    expect(press(start, '0').action.kind).toBe('none');
    expect(press(start, ' ').action.kind).toBe('none');
  });

  it('the highlight stops at both ends (no wrap), and the own row is one past the last option', () => {
    const start = initialQuestionCard(requestOf(single));
    expect(currentEntry(run(start, [ARROW.up]).state).highlight).toBe(0);
    const down = run(start, Array<ChatKey>(10).fill(ARROW.down)).state;
    expect(currentEntry(down).highlight).toBe(OPTIONS.length);
  });

  it('`←` is ignored on the first question', () => {
    expect(press(initialQuestionCard(requestOf(single)), '', ARROW.left).action.kind).toBe('none');
  });
});

describe('a multi-select question', () => {
  const start = () => initialQuestionCard(requestOf(multi));

  it('digits and Space TOGGLE, and neither advances', () => {
    const afterDigit = press(start(), '1');
    expect(afterDigit.action.kind).toBe('state');
    expect(currentEntry(afterDigit.state).ticked).toEqual([0]);
    const again = press(afterDigit.state, '1');
    expect(currentEntry(again.state).ticked).toEqual([]);
    const bySpace = run(start(), [ARROW.down, ' ']);
    expect(currentEntry(bySpace.state).ticked).toEqual([1]);
  });

  it('Enter with nothing ticked and no text is refused with a hint, and nothing advances', () => {
    const result = press(start(), '', ARROW.enter);
    expect(result.action.kind).toBe('state');
    expect(result.state.hint).toMatch(/at least one/i);
    expect(result.state.index).toBe(0);
  });

  it('Enter confirms the ticks, in option order whatever order they were ticked', () => {
    const answer = submitted(run(start(), ['3', '1', ARROW.enter]));
    expect(answer).toEqual({ kind: 'answered', answers: [{ selected: ['Alpha', 'Gamma'] }] });
  });

  it('Space on the own row is ignored', () => {
    const onOwn = run(start(), Array<ChatKey>(3).fill(ARROW.down)).state;
    expect(press(onOwn, ' ').action.kind).toBe('none');
  });
});

describe('the own-answer field', () => {
  const open = (request: AskUserRequest) =>
    run(initialQuestionCard(request), [
      ...Array<ChatKey>(OPTIONS.length).fill(ARROW.down),
      ARROW.enter,
    ]).state;

  it('opens on Enter at the own row, empty', () => {
    expect(open(requestOf(single)).field).toEqual({ text: '', cursor: 0 });
  });

  it('typed characters — including `s` and digits — are text, not commands', () => {
    const typed = run(open(requestOf(single)), ['s', '1', ' ', 'x']).state;
    expect(typed.field?.text).toBe('s1 x');
  });

  it('Enter accepts non-empty text as THE answer of a single-select question', () => {
    const answer = submitted(run(open(requestOf(single)), ['h', 'i', ARROW.enter]));
    expect(answer).toEqual({ kind: 'answered', answers: [{ selected: [], other: 'hi' }] });
  });

  it('Enter on empty or blank text returns to the list and changes nothing', () => {
    const result = run(open(requestOf(single)), [' ', ' ', ARROW.enter]);
    expect(result.action.kind).toBe('state');
    expect(result.state.field).toBeUndefined();
    expect(currentEntry(result.state).own).toBeUndefined();
  });

  it('in a multi-select question the text is sent WITH the ticks already made, and ends the question', () => {
    const typed = run(initialQuestionCard(requestOf(multi)), [
      '2',
      ARROW.down,
      ARROW.down,
      ARROW.down,
      ARROW.enter,
      'o',
      'k',
      ARROW.enter,
    ]);
    expect(submitted(typed)).toEqual({
      kind: 'answered',
      answers: [{ selected: ['Beta'], other: 'ok' }],
    });
  });

  it('to tick more AFTER typing, leave the field with `↑` (the draft is kept), tick, and come back to accept', () => {
    const typedFirst = run(open(requestOf(multi)), ['o', 'k', ARROW.up]).state;
    expect(typedFirst.field).toBeUndefined();
    const ticked = run(typedFirst, ['3']).state;
    expect(currentEntry(ticked).ticked).toEqual([2]);
    const back = run(ticked, [ARROW.down, ARROW.down, ARROW.down, ARROW.enter]).state;
    expect(back.field?.text).toBe('ok');
    expect(submitted(run(back, [ARROW.enter]))).toEqual({
      kind: 'answered',
      answers: [{ selected: ['Gamma'], other: 'ok' }],
    });
  });

  it('a multi-select question with only own text is a valid answer', () => {
    expect(submitted(run(open(requestOf(multi)), ['o', 'k', ARROW.enter]))).toEqual({
      kind: 'answered',
      answers: [{ selected: [], other: 'ok' }],
    });
  });

  it('choosing an option after typing own text in a single-select question REPLACES it (one answer, never two)', () => {
    const afterOwn = run(open(requestOf(single, single)), ['h', 'i', ARROW.enter]).state; // question 1 answered, now on 2
    const back = run(afterOwn, [ARROW.left]).state;
    expect(back.entries[0]).toMatchObject({ own: 'hi' });
    const rechosen = run(back, ['1']).state;
    expect(rechosen.entries[0]).toMatchObject({ ticked: [0], own: undefined });
  });

  it('`↑` leaves the field keeping the draft, and reopening restores it', () => {
    const left = run(open(requestOf(single)), ['d', 'r', ARROW.up]).state;
    expect(left.field).toBeUndefined();
    expect(currentEntry(left).draft).toBe('dr');
    const reopened = run(left, [ARROW.enter]).state;
    expect(reopened.field?.text).toBe('dr');
  });

  it('the cursor moves inside the field (`←` is not "previous question" there)', () => {
    const state = run(open(requestOf(single)), ['a', 'b', ARROW.left, 'X']).state;
    expect(state.field?.text).toBe('aXb');
    expect(state.index).toBe(0);
  });

  it('Shift+Enter does not insert a newline: the field is one line', () => {
    const state = run(open(requestOf(single)), ['a', { return: true, shift: true }, 'b']).state;
    expect(state.field?.text).toBe('ab');
  });

  it('holds the person’s text to its limit: a keystroke past it is refused with a hint, nothing is cut', () => {
    const limit = ASK_USER_BOUNDS.ownTextCodePoints;
    let state = open(requestOf(single));
    state = pasteIntoQuestion(state, 'a'.repeat(limit), true);
    expect(state.field?.text.length).toBe(limit);
    const refused = press(state, 'b');
    expect(refused.state.field?.text.length).toBe(limit);
    expect(refused.state.hint).toMatch(/limit/i);
  });
});

describe('pasting into the field', () => {
  const field = () =>
    run(initialQuestionCard(requestOf(single)), [
      ...Array<ChatKey>(OPTIONS.length).fill(ARROW.down),
      ARROW.enter,
    ]).state;

  it('inserts one line: line breaks become spaces and terminal sequences are removed', () => {
    const state = pasteIntoQuestion(field(), 'a\r\nb\u001b[31mred\u001b[0m\tc', true);
    expect(state.field?.text).toBe('a bred c');
    expect(state.field?.text).not.toContain('\u001b');
  });

  it('refuses a paste that would pass the limit WHOLE, leaving the text untouched', () => {
    const base = pasteIntoQuestion(
      field(),
      'x'.repeat(ASK_USER_BOUNDS.ownTextCodePoints - 2),
      true,
    );
    const refused = pasteIntoQuestion(base, 'yyy', true);
    expect(refused.field).toBe(base.field);
    expect(refused.hint).toMatch(/limit/i);
  });

  it('counts an astral character once', () => {
    const state = pasteIntoQuestion(field(), '😀'.repeat(ASK_USER_BOUNDS.ownTextCodePoints), true);
    expect([...(state.field?.text ?? '')].length).toBe(ASK_USER_BOUNDS.ownTextCodePoints);
  });

  it('is ignored with no field open, or before the frame is acknowledged', () => {
    const list = initialQuestionCard(requestOf(single));
    expect(pasteIntoQuestion(list, 'hello', true)).toBe(list);
    const open = field();
    expect(pasteIntoQuestion(open, 'hello', false)).toBe(open);
  });
});

describe('several questions', () => {
  const two = () => initialQuestionCard(requestOf(single, multi));

  it('advances through them and submits one entry per question, in order', () => {
    const answer = submitted(run(two(), ['1', '2', '3', ARROW.enter]));
    expect(answer).toEqual({
      kind: 'answered',
      answers: [{ selected: ['Alpha'] }, { selected: ['Beta', 'Gamma'] }],
    });
  });

  it('`←` returns to the previous question keeping its answer, and the answer can be changed', () => {
    const second = run(two(), ['1']).state;
    expect(second.index).toBe(1);
    const back = run(second, [ARROW.left]).state;
    expect(back.index).toBe(0);
    expect(currentEntry(back).ticked).toEqual([0]);
    const answer = submitted(run(back, ['3', '1', ARROW.enter]));
    expect(answer).toMatchObject({ answers: [{ selected: ['Gamma'] }, { selected: ['Alpha'] }] });
  });

  it('`s` skips the whole call and discards answers already given', () => {
    const second = run(two(), ['1']).state;
    expect(press(second, 's').action.kind).toBe('skip');
  });

  it('the answer is not built until the last question is confirmed', () => {
    expect(run(two(), ['1']).action.kind).toBe('state');
  });
});

describe('ownTextOf — the person’s text as one clean line', () => {
  it.each([
    ['  hello  ', 'hello'],
    ['a\nb', 'a b'],
    ['a\r\n\r\nb', 'a b'],
    ['red\u001b[31m!\u001b[0m', 'red!'],
    ['tab\there', 'tab here'],
    ['sep\u2028x', 'sep x'],
    ['   ', ''],
  ])('%j → %j', (raw, clean) => {
    expect(ownTextOf(raw)).toBe(clean);
  });
});

describe('buildAnswer', () => {
  it('reports own text only when it was accepted', () => {
    const start = initialQuestionCard(requestOf(single));
    expect(buildAnswer(start)).toEqual({ kind: 'answered', answers: [{ selected: [] }] });
  });
});

describe('taking back text the person accepted (review)', () => {
  const open = (request: AskUserRequest) =>
    run(initialQuestionCard(request), [
      ...Array<ChatKey>(OPTIONS.length).fill(ARROW.down),
      ARROW.enter,
    ]).state;

  it('an empty field on Enter clears accepted own text and its draft — a multi-select question can return to ticks only', () => {
    // Accept own text in a two-question call (so the first question stays open to revisit), come back, empty it.
    const two = requestOf(multi, single);
    let state = run(open(two), ['o', 'k', ARROW.enter]).state;
    expect(state.index).toBe(1); // typing your own answer ends the question
    state = run(state, [ARROW.left]).state;
    expect(currentEntry(state).own).toBe('ok');
    state = run(state, [ARROW.enter]).state; // the highlight is on the own row: reopen with 'ok'
    expect(state.field?.text).toBe('ok');
    state = run(state, [ARROW.backspace, ARROW.backspace]).state;
    state = run(state, [ARROW.enter]).state; // empty Enter
    expect(state.field).toBeUndefined();
    expect(currentEntry(state)).toMatchObject({ own: undefined, draft: undefined });
    state = run(state, [ARROW.up, ' ']).state; // tick an option
    const answer = submitted(run(state, [ARROW.enter, '1']));
    expect(answer).toMatchObject({ answers: [{ selected: [expect.any(String)] }, {}] });
    expect((answer as { answers: { other?: string }[] }).answers[0]?.other).toBeUndefined();
  });
});
