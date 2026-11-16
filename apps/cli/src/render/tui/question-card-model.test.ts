import { ASK_USER_BOUNDS, type AskUserRequest } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import type { ChatKey } from './chat-input.js';
import {
  buildAnswer,
  currentEntry,
  firstUnanswered,
  hasReview,
  initialQuestionCard,
  isAnswered,
  isReview,
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

const K = {
  up: { upArrow: true },
  down: { downArrow: true },
  left: { leftArrow: true },
  right: { rightArrow: true },
  enter: { return: true },
  esc: { escape: true },
  backspace: { backspace: true },
  tab: { tab: true },
  shiftTab: { tab: true, shift: true },
  ctrl: { ctrl: true },
} satisfies Record<string, ChatKey>;

type Step = string | ChatKey | readonly [string, ChatKey];

function isPair(step: Step): step is readonly [string, ChatKey] {
  return Array.isArray(step);
}

/** Apply one key; return the action, and the next state when the action carries one. */
function press(
  state: QuestionCardState,
  input: string,
  key: ChatKey = {},
  visible = true,
): { action: QuestionKeyAction; state: QuestionCardState } {
  const action = reduceQuestionKey(state, input, key, visible);
  return { action, state: action.kind === 'state' ? action.state : state };
}

/** Apply a sequence: a string is a typed key, a key object a special key, a tuple `[input, key]` both. */
function run(
  start: QuestionCardState,
  steps: readonly Step[],
): { action: QuestionKeyAction; state: QuestionCardState } {
  let state = start;
  let action: QuestionKeyAction = { kind: 'none' };
  for (const step of steps) {
    if (typeof step === 'string') ({ action, state } = press(state, step));
    else if (isPair(step)) ({ action, state } = press(state, step[0], step[1]));
    else ({ action, state } = press(state, '', step));
  }
  return { action, state };
}

const typed = (text: string): Step[] => [...text];
const downs = (count: number): Step[] => Array<Step>(count).fill(K.down);

const submitted = (result: { action: QuestionKeyAction }) => {
  if (result.action.kind !== 'submit')
    throw new Error(`expected a submit, got ${result.action.kind}`);
  return result.action.answer;
};

/** Move the highlight to the own-answer row of a three-option question. */
const toOwnRow = downs(OPTIONS.length);

describe('the stop keys (ADR-0132 §3, ADR-0115)', () => {
  it.each([
    ['Esc', '', K.esc],
    ['Ctrl-C', 'c', K.ctrl],
  ])(
    '%s stops the turn from the list, the field, the review tab and before the frame is acknowledged',
    (_n, input, key) => {
      const two = initialQuestionCard(requestOf(single, single));
      const inField = run(two, ['x']).state;
      expect(inField.field).toBeDefined();
      const onReview = run(two, [K.right, K.right]).state;
      expect(isReview(onReview)).toBe(true);
      for (const state of [two, inField, onReview]) {
        expect(reduceQuestionKey(state, input, key, true).kind).toBe('stop');
        expect(reduceQuestionKey(state, input, key, false).kind).toBe('stop');
      }
    },
  );

  it('every other Ctrl or Alt chord does nothing (the card is not a shell)', () => {
    const start = initialQuestionCard(requestOf(single));
    expect(reduceQuestionKey(start, 'a', { ctrl: true }, true).kind).toBe('none');
    expect(reduceQuestionKey(start, 'x', { meta: true }, true).kind).toBe('none');
  });
});

describe('Ctrl+S skips — and no bare letter ever does', () => {
  it('skips the whole call from the list, from the open field and from the review tab', () => {
    const two = initialQuestionCard(requestOf(single, single));
    expect(press(two, 's', K.ctrl).action.kind).toBe('skip');
    expect(press(run(two, ['x']).state, 's', K.ctrl).action.kind).toBe('skip');
    expect(press(run(two, [K.right, K.right]).state, 's', K.ctrl).action.kind).toBe('skip');
  });

  it('discards answers already given', () => {
    const answered = run(initialQuestionCard(requestOf(single, single)), ['1']).state;
    expect(isAnswered(answered, 0)).toBe(true);
    expect(press(answered, 's', K.ctrl).action.kind).toBe('skip');
  });

  it('a bare `s` is TEXT: it starts the own-answer field, and inside the field it is a letter', () => {
    const start = initialQuestionCard(requestOf(single));
    const started = press(start, 's');
    expect(started.action.kind).toBe('state');
    expect(started.state.field?.text).toBe('s');
    const sentence = run(start, typed('so it is fine')).state;
    expect(sentence.field?.text).toBe('so it is fine');
    expect(submitted(run(sentence, [K.enter]))).toEqual({
      kind: 'answered',
      answers: [{ selected: [], other: 'so it is fine' }],
    });
  });

  it('does not skip before the frame is acknowledged and settled', () => {
    const start = initialQuestionCard(requestOf(single));
    expect(reduceQuestionKey(start, 's', K.ctrl, false).kind).toBe('none');
  });
});

describe('typed-ahead keys cannot choose (the measured-frame guard)', () => {
  it.each(['1', 'x', ' '])('ignores %j until the frame is acknowledged', (input) => {
    const start = initialQuestionCard(requestOf(single, single));
    expect(reduceQuestionKey(start, input, {}, false).kind).toBe('none');
    expect(reduceQuestionKey(start, '', K.enter, false).kind).toBe('none');
    expect(reduceQuestionKey(start, '', K.down, false).kind).toBe('none');
    expect(reduceQuestionKey(start, '', K.right, false).kind).toBe('none');
  });
});

describe('a single-select question', () => {
  it('starts on the first option with nothing chosen', () => {
    expect(currentEntry(initialQuestionCard(requestOf(single)))).toEqual({
      highlight: 0,
      ticked: [],
      own: undefined,
      draft: undefined,
    });
  });

  it('a digit chooses that option and sends a one-question call', () => {
    expect(submitted(run(initialQuestionCard(requestOf(single)), ['2']))).toEqual({
      kind: 'answered',
      answers: [{ selected: ['Beta'] }],
    });
  });

  it('Enter chooses the HIGHLIGHTED option, not the first', () => {
    expect(submitted(run(initialQuestionCard(requestOf(single)), [K.down, K.enter]))).toEqual({
      kind: 'answered',
      answers: [{ selected: ['Beta'] }],
    });
  });

  it('ignores a digit with no such option, and Space', () => {
    const start = initialQuestionCard(requestOf(single));
    for (const input of ['4', '9', '0', ' ']) expect(press(start, input).action.kind).toBe('none');
  });

  it('the highlight stops at both ends, and the own row is one past the last option', () => {
    const start = initialQuestionCard(requestOf(single));
    expect(currentEntry(run(start, [K.up]).state).highlight).toBe(0);
    expect(currentEntry(run(start, downs(10)).state).highlight).toBe(OPTIONS.length);
  });

  it('a one-question call has no tabs and no review: ← and → do nothing', () => {
    const start = initialQuestionCard(requestOf(single));
    expect(hasReview(start)).toBe(false);
    for (const key of [K.left, K.right, K.tab, K.shiftTab])
      expect(press(start, '', key).action.kind).toBe('none');
  });
});

describe('typing starts the own answer — anywhere on the list (type-to-start)', () => {
  const start = () => initialQuestionCard(requestOf(single));

  it('a letter on ANY row opens the field with that letter and moves the highlight to the own row', () => {
    const fromTop = press(start(), 'h');
    expect(fromTop.state.field?.text).toBe('h');
    expect(currentEntry(fromTop.state).highlight).toBe(OPTIONS.length);
    expect(run(start(), [K.down, 'h']).state.field?.text).toBe('h');
  });

  it('punctuation and non-Latin letters start it too', () => {
    for (const input of ['?', '-', 'ş', '漢', '😀'])
      expect(press(start(), input).state.field?.text).toBe(input);
  });

  it('a digit is still a shortcut (it picks an option) and Space does not start the field', () => {
    expect(press(start(), '4').action.kind).toBe('none');
    expect(press(start(), ' ').action.kind).toBe('none');
    expect(submitted(press(start(), '2'))).toBeDefined();
  });

  it('a chunk of fast typing is text, even if it contains digits', () => {
    expect(press(start(), '12 files').state.field?.text).toBe('12 files');
  });

  it('Enter on the own row opens an empty field; Backspace on SAVED text reopens it for editing', () => {
    const open = run(start(), [...toOwnRow, K.enter]).state;
    expect(open.field).toEqual({ text: '', cursor: 0 });
    const two = initialQuestionCard(requestOf(single, single));
    const saved = run(two, [...typed('hi'), K.enter, K.left]).state;
    expect(currentEntry(saved).own).toBe('hi');
    expect(run(saved, [...toOwnRow, K.backspace]).state.field?.text).toBe('hi');
  });

  it('typing past the limit is refused with a hint on the list too', () => {
    const refused = press(start(), 'x'.repeat(ASK_USER_BOUNDS.ownTextCodePoints + 1));
    expect(refused.state.field).toBeUndefined();
    expect(refused.state.hint).toMatch(/limit/i);
  });
});

describe('the own-answer field', () => {
  const open = (request: AskUserRequest) =>
    run(initialQuestionCard(request), [...toOwnRow, K.enter]).state;

  it('typed characters — letters, digits, `s` — are text, not commands', () => {
    expect(run(open(requestOf(single)), typed('s1 x')).state.field?.text).toBe('s1 x');
  });

  it('Enter accepts non-empty text as THE answer of a single-select question', () => {
    expect(submitted(run(open(requestOf(single)), [...typed('hi'), K.enter]))).toEqual({
      kind: 'answered',
      answers: [{ selected: [], other: 'hi' }],
    });
  });

  it('Enter on empty or blank text returns to the list and changes nothing', () => {
    const result = run(open(requestOf(single)), [' ', ' ', K.enter]);
    expect(result.action.kind).toBe('state');
    expect(result.state.field).toBeUndefined();
    expect(currentEntry(result.state).own).toBeUndefined();
  });

  it('`↑` leaves the field keeping the draft, and reopening restores it', () => {
    const left = run(open(requestOf(single)), [...typed('dr'), K.up]).state;
    expect(left.field).toBeUndefined();
    expect(currentEntry(left).draft).toBe('dr');
    expect(run(left, [K.enter]).state.field?.text).toBe('dr');
  });

  it('the cursor moves inside the field (`←` is not "previous question" there)', () => {
    const state = run(open(requestOf(single, single)), [...typed('ab'), K.left, 'X']).state;
    expect(state.field?.text).toBe('aXb');
    expect(state.index).toBe(0);
  });

  it('Shift+Enter does not insert a newline: the field is one line', () => {
    expect(
      run(open(requestOf(single)), ['a', { return: true, shift: true }, 'b']).state.field?.text,
    ).toBe('ab');
  });

  it('holds the person’s text to its limit: a keystroke past it is refused with a hint, nothing is cut', () => {
    const limit = ASK_USER_BOUNDS.ownTextCodePoints;
    const filled = pasteIntoQuestion(open(requestOf(single)), 'a'.repeat(limit), true);
    expect(filled.field?.text.length).toBe(limit);
    const refused = press(filled, 'b');
    expect(refused.state.field?.text.length).toBe(limit);
    expect(refused.state.hint).toMatch(/limit/i);
  });
});

describe('a multi-select question: saving text is not confirming the question', () => {
  const start = () => initialQuestionCard(requestOf(multi));

  it('digits and Space TOGGLE, and neither advances', () => {
    const afterDigit = press(start(), '1');
    expect(currentEntry(afterDigit.state).ticked).toEqual([0]);
    expect(currentEntry(press(afterDigit.state, '1').state).ticked).toEqual([]);
    expect(currentEntry(run(start(), [K.down, ' ']).state).ticked).toEqual([1]);
  });

  it('Enter with nothing ticked and no text is refused with a hint', () => {
    const result = press(start(), '', K.enter);
    expect(result.action.kind).toBe('state');
    expect(result.state.hint).toMatch(/at least one/i);
  });

  it('Enter confirms the ticks, in option order whatever order they were ticked', () => {
    expect(submitted(run(start(), ['3', '1', K.enter]))).toEqual({
      kind: 'answered',
      answers: [{ selected: ['Alpha', 'Gamma'] }],
    });
  });

  it('THE PERSON’S CASE: tick options, type own text, Enter SAVES it and stays; the next Enter confirms', () => {
    const afterTick = run(start(), ['2']).state;
    const typedOwn = run(afterTick, [...toOwnRow, K.enter, ...typed('and this one')]).state;
    expect(typedOwn.field?.text).toBe('and this one');
    const saved = press(typedOwn, '', K.enter);
    // Saving the text did NOT move on: still on this question, ticks kept, the text counted.
    expect(saved.action.kind).toBe('state');
    expect(saved.state.field).toBeUndefined();
    expect(currentEntry(saved.state)).toMatchObject({ own: 'and this one', ticked: [1] });
    expect(saved.state.hint).toMatch(/Saved/);
    // The second Enter confirms the whole question — and sends a one-question call.
    expect(submitted(press(saved.state, '', K.enter))).toEqual({
      kind: 'answered',
      answers: [{ selected: ['Beta'], other: 'and this one' }],
    });
  });

  it('after saving text the person can keep picking: ticks added later are sent with it', () => {
    const saved = run(start(), [...typed('mine'), K.enter]).state;
    const more = run(saved, [K.up, K.up, K.up, ' ']).state; // up to the first option, tick it
    expect(submitted(run(more, [K.enter]))).toEqual({
      kind: 'answered',
      answers: [{ selected: ['Alpha'], other: 'mine' }],
    });
  });

  it('text alone is a valid multi-select answer', () => {
    expect(submitted(run(start(), [...typed('ok'), K.enter, K.enter]))).toEqual({
      kind: 'answered',
      answers: [{ selected: [], other: 'ok' }],
    });
  });

  it('an empty field on Enter takes saved text back, so the question can return to ticks only', () => {
    const saved = run(start(), ['1', ...toOwnRow, K.enter, ...typed('x'), K.enter]).state;
    expect(currentEntry(saved).own).toBe('x');
    const reopened = run(saved, [K.backspace]).state; // Backspace on the own row reopens the field with 'x'
    expect(reopened.field?.text).toBe('x');
    const cleared = run(reopened, [K.backspace, K.enter]).state; // delete the 'x', Enter on empty
    expect(currentEntry(cleared)).toMatchObject({ own: undefined, draft: undefined });
    // The highlight is still on the own row, where Enter opens the field; from any option Enter confirms the question.
    expect(submitted(run(cleared, [K.up, K.enter]))).toEqual({
      kind: 'answered',
      answers: [{ selected: ['Alpha'] }],
    });
  });

  it('Space on the own row is ignored', () => {
    expect(press(run(start(), toOwnRow).state, ' ').action.kind).toBe('none');
  });

  it('choosing an option after typing own text in a SINGLE-select question replaces it (one answer, never two)', () => {
    const two = initialQuestionCard(requestOf(single, single));
    const afterOwn = run(two, [...typed('hi'), K.enter]).state; // Q1 answered with text, now on Q2
    const back = run(afterOwn, [K.left]).state;
    expect(back.entries[0]).toMatchObject({ own: 'hi' });
    expect(run(back, ['1']).state.entries[0]).toMatchObject({ ticked: [0], own: undefined });
  });
});

describe('several questions are tabs, ending in a Review tab (ADR-0132 §3)', () => {
  const three = () => initialQuestionCard(requestOf(single, multi, single));

  it('has tabs and a review once there is more than one question', () => {
    expect(hasReview(three())).toBe(true);
    expect(isReview(three())).toBe(false);
  });

  it('`→` and `←` browse the questions WITHOUT answering them, and Tab / Shift+Tab do the same', () => {
    const second = run(three(), [K.right]).state;
    expect(second.index).toBe(1);
    expect(isAnswered(second, 0)).toBe(false);
    expect(run(second, [K.left]).state.index).toBe(0);
    expect(run(three(), [K.tab]).state.index).toBe(1);
    expect(run(three(), [K.tab, K.shiftTab]).state.index).toBe(0);
    expect(press(three(), '', K.left).action.kind).toBe('none'); // nothing before the first
  });

  it('`→` from the last question shows the Review tab, and no further', () => {
    const review = run(three(), [K.right, K.right, K.right]).state;
    expect(isReview(review)).toBe(true);
    expect(press(review, '', K.right).action.kind).toBe('none');
  });

  it('answering a question moves to the next tab, and answering the LAST one shows the Review tab — it does not send', () => {
    const afterFirst = run(three(), ['1']);
    expect(afterFirst.state.index).toBe(1);
    expect(afterFirst.action.kind).toBe('state');
    const afterSecond = run(afterFirst.state, ['2', K.enter]);
    expect(afterSecond.state.index).toBe(2);
    const afterThird = run(afterSecond.state, ['1']);
    expect(afterThird.action.kind).toBe('state');
    expect(isReview(afterThird.state)).toBe(true);
  });

  it('Review: Enter sends when everything is answered', () => {
    const review = run(three(), ['1', '2', K.enter, '1']).state;
    expect(submitted(press(review, '', K.enter))).toEqual({
      kind: 'answered',
      answers: [{ selected: ['Alpha'] }, { selected: ['Beta'] }, { selected: ['Alpha'] }],
    });
  });

  it('Review: Enter with an unanswered question goes to it, with a note — it never sends a hole', () => {
    const skipped = run(three(), [K.right, K.right, '1']).state; // only Q3 answered; now on Review
    expect(isReview(skipped)).toBe(true);
    expect(firstUnanswered(skipped)).toBe(0);
    const result = press(skipped, '', K.enter);
    expect(result.action.kind).toBe('state');
    expect(result.state.index).toBe(0);
    expect(result.state.hint).toMatch(/Question 1 is not answered/);
  });

  it('Review: a digit jumps to that question, `←` goes back to the last, and typing does nothing', () => {
    const review = run(three(), ['1', '2', K.enter, '1']).state;
    expect(press(review, '2').state.index).toBe(1);
    expect(press(review, '', K.left).state.index).toBe(2);
    expect(press(review, 'x').action.kind).toBe('none');
    expect(press(review, '9').action.kind).toBe('none');
  });

  it('answers can be changed before sending: go back, choose again, and return to the review', () => {
    const review = run(three(), ['1', '2', K.enter, '1']).state;
    const changed = run(review, ['1', '3']).state; // jump to Q1, choose option 3 → moves on to Q2
    expect(changed.index).toBe(1);
    expect(changed.entries[0]).toMatchObject({ ticked: [2] });
  });

  it('every browsing key keeps the answers already given', () => {
    const state = run(three(), ['2', K.right, K.left, K.left]).state;
    expect(isAnswered(state, 0)).toBe(true);
    expect(state.entries[0]).toMatchObject({ ticked: [1] });
  });

  it('typing on the list of a multi-question call starts the own answer for THAT question', () => {
    const second = run(three(), [K.right]).state;
    expect(press(second, 'q').state.field?.text).toBe('q');
    expect(press(second, 'q').state.index).toBe(1);
  });

  it('a field left open does not follow you to another tab', () => {
    const opened = run(three(), ['x']).state;
    expect(opened.field).toBeDefined();
    expect(run(opened, [K.up, K.right]).state.field).toBeUndefined();
  });

  it('the answer is not built until the Review tab sends it', () => {
    expect(run(three(), ['1']).action.kind).toBe('state');
  });
});

describe('pasting (ADR-0132 §3)', () => {
  const fieldState = () =>
    run(initialQuestionCard(requestOf(single)), [...toOwnRow, K.enter]).state;

  it('into the open field inserts one line: line breaks become spaces and terminal sequences are removed', () => {
    const state = pasteIntoQuestion(fieldState(), 'a\r\nb\u001b[31mred\u001b[0m\tc', true);
    expect(state.field?.text).toBe('a bred c');
    expect(state.field?.text).not.toContain(String.fromCharCode(27));
  });

  it('on the LIST starts the own-answer field with the pasted text, as typing would', () => {
    const state = pasteIntoQuestion(initialQuestionCard(requestOf(single)), 'pasted words', true);
    expect(state.field?.text).toBe('pasted words');
  });

  it('refuses a paste that would pass the limit WHOLE, leaving the text untouched', () => {
    const base = pasteIntoQuestion(
      fieldState(),
      'x'.repeat(ASK_USER_BOUNDS.ownTextCodePoints - 2),
      true,
    );
    const refused = pasteIntoQuestion(base, 'yyy', true);
    expect(refused.field).toBe(base.field);
    expect(refused.hint).toMatch(/limit/i);
  });

  it('counts an astral character once', () => {
    const state = pasteIntoQuestion(
      fieldState(),
      '😀'.repeat(ASK_USER_BOUNDS.ownTextCodePoints),
      true,
    );
    expect([...(state.field?.text ?? '')].length).toBe(ASK_USER_BOUNDS.ownTextCodePoints);
  });

  it('is ignored before the frame is acknowledged and on the Review tab', () => {
    const open = fieldState();
    expect(pasteIntoQuestion(open, 'hello', false)).toBe(open);
    const review = run(initialQuestionCard(requestOf(single, single)), [K.right, K.right]).state;
    expect(pasteIntoQuestion(review, 'hello', true)).toBe(review);
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

describe('isAnswered and buildAnswer', () => {
  it('a single-select question needs exactly one of a choice or text; a multi-select at least one', () => {
    const state = initialQuestionCard(requestOf(single, multi));
    expect(isAnswered(state, 0)).toBe(false);
    expect(isAnswered(state, 1)).toBe(false);
    expect(isAnswered(run(state, ['1']).state, 0)).toBe(true);
    expect(isAnswered(run(state, [K.right, '1']).state, 1)).toBe(true);
  });

  it('reports own text only when it was saved', () => {
    expect(buildAnswer(initialQuestionCard(requestOf(single)))).toEqual({
      kind: 'answered',
      answers: [{ selected: [] }],
    });
  });
});
