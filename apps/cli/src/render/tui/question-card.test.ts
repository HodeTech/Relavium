import { ASK_USER_BOUNDS, plainTextRefusal, type AskUserRequest } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { cardRowBudget, CARD_KEY_ROWS, CARD_RULE_ROWS } from './tool-review-card.js';
import {
  initialQuestionCard,
  reduceQuestionKey,
  type QuestionCardState,
} from './question-card-model.js';
import {
  hardWrap,
  projectQuestionCard,
  questionRule,
  QUESTION_CARD_MAX_BODY_ROWS,
} from './question-card.js';
import { displayWidth } from './viewport.js';

/** The 80×24 floor: the card's twelve rows are a rule, two key rows and nine body rows. */
const COLUMNS = 80;
const WIDTH = COLUMNS - 2;

describe('the card budget this layout is derived from (ADR-0132 §2)', () => {
  it('twelve rows at 80×24 leave exactly nine for the body', () => {
    expect(cardRowBudget(24) - CARD_RULE_ROWS - CARD_KEY_ROWS).toBe(QUESTION_CARD_MAX_BODY_ROWS);
    expect(QUESTION_CARD_MAX_BODY_ROWS).toBe(9);
  });
});

describe('hardWrap', () => {
  it('breaks at the column, never word-wraps, and loses nothing', () => {
    expect(hardWrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(hardWrap('abcdefghij', 4).join('')).toBe('abcdefghij');
  });

  it('breaks an over-long unbroken word instead of leaving it past the edge', () => {
    const rows = hardWrap('x'.repeat(200), WIDTH);
    expect(rows.map((row) => displayWidth(row)).every((cells) => cells <= WIDTH)).toBe(true);
    expect(rows.join('')).toBe('x'.repeat(200));
  });

  it('moves a wide character that does not fit to the next row (that row is one short, never over)', () => {
    expect(hardWrap('a漢b', 2)).toEqual(['a', '漢', 'b']);
    expect(hardWrap('漢漢', 3)).toEqual(['漢', '漢']);
  });

  it('never splits a grapheme: an emoji sequence and a combining mark stay whole', () => {
    const family = '👨\u200d👩\u200d👧';
    expect(hardWrap(`ab${family}cd`, 4).join('')).toBe(`ab${family}cd`);
    expect(hardWrap('e\u0301e\u0301e\u0301', 1).join('')).toBe('e\u0301e\u0301e\u0301');
  });

  it('returns one empty row for an empty string', () => {
    expect(hardWrap('', 10)).toEqual(['']);
  });
});

/* --- generating admissible calls --- */

/** A small deterministic PRNG, so a failure reproduces. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABETS: readonly (readonly string[])[] = [
  ['a', 'b', 'c', 'd', 'e', ' '],
  ['x'],
  ['漢', '字', '日'],
  ['😀', '🚀'],
  ['é', 'ñ', 'ü', ' '],
  ['w', 'i', 'd', 'e', 'W', 'M'],
  ['a\u0301', 'e\u0302', 'o\u0308'],
  ['👨\u200d👩\u200d👧', 'x'],
];

/** The longest string over `alphabet` within `maxBytes` that the real validator accepts (so it is admissible by construction). */
function longest(random: () => number, alphabet: readonly string[], maxBytes: number): string {
  let out = '';
  for (let guard = 0; guard < 400; guard += 1) {
    const next = alphabet[Math.floor(random() * alphabet.length)] ?? 'x';
    const candidate = out + next;
    if (Buffer.byteLength(candidate, 'utf8') > maxBytes) break;
    out = candidate;
  }
  // The validator forbids edge whitespace and a leading marker; repair the generated text, never the validator.
  const trimmed = out.trim();
  return plainTextRefusal(trimmed, maxBytes) === undefined
    ? trimmed
    : 'x'.repeat(Math.min(maxBytes, 8));
}

function generate(random: () => number, questionCount: number, multi: boolean): AskUserRequest {
  const pick = (maxBytes: number): string => {
    const alphabet = ALPHABETS[Math.floor(random() * ALPHABETS.length)] ?? ['x'];
    return longest(random, alphabet, maxBytes);
  };
  return {
    questions: Array.from({ length: questionCount }, (_, q) => ({
      header: pick(ASK_USER_BOUNDS.headerBytes),
      question: pick(ASK_USER_BOUNDS.questionBytes),
      multiSelect: multi && q % 2 === 0,
      options: Array.from({ length: 4 }, (_, o) => ({
        // Labels must differ; a numeric suffix is ASCII and tiny, and the budget leaves room for it.
        label: `${pick(ASK_USER_BOUNDS.labelBytes - 3)}${String(o)}`,
        description: pick(ASK_USER_BOUNDS.descriptionBytes),
      })),
    })),
  };
}

/** Every state of the card worth projecting: each highlight, the open field with a full line, a hint, ticks, later questions. */
function statesOf(request: AskUserRequest): QuestionCardState[] {
  const base = initialQuestionCard(request);
  const states: QuestionCardState[] = [];
  for (let index = 0; index < request.questions.length; index += 1) {
    const question = request.questions[index];
    if (question === undefined) continue;
    for (let highlight = 0; highlight <= question.options.length; highlight += 1) {
      const entries = base.entries.map((entry, i) =>
        i === index
          ? { ...entry, highlight, ticked: question.multiSelect ? [0, 1, 2, 3] : [highlight] }
          : entry,
      );
      states.push({ ...base, index, entries });
      states.push({
        ...base,
        index,
        entries,
        hint: 'Pick at least one option, or type your own answer.',
      });
      states.push({
        ...base,
        index,
        entries: entries.map((entry, i) =>
          i === index ? { ...entry, own: 'o'.repeat(500) } : entry,
        ),
      });
      states.push({
        ...base,
        index,
        entries,
        field: { text: 'ж'.repeat(ASK_USER_BOUNDS.ownTextCodePoints), cursor: 500 },
      });
    }
  }
  return states;
}

describe('the worst admissible call fits the card at 80×24 (ADR-0132 §2, the claim the ADR rests on)', () => {
  it('a question of exactly the byte ceiling takes at most two rows, for every alphabet', () => {
    for (const alphabet of ALPHABETS) {
      const random = mulberry32(7);
      const question = longest(random, alphabet, ASK_USER_BOUNDS.questionBytes);
      expect(hardWrap(question, WIDTH).length).toBeLessThanOrEqual(2);
    }
  });

  it('the maximal ASCII call: 150-byte question, four 60-byte labels, 72-byte descriptions', () => {
    const request: AskUserRequest = {
      questions: [
        {
          header: 'h'.repeat(ASK_USER_BOUNDS.headerBytes),
          question: 'q'.repeat(ASK_USER_BOUNDS.questionBytes),
          multiSelect: true,
          options: Array.from({ length: 4 }, (_, i) => ({
            label: `${'l'.repeat(ASK_USER_BOUNDS.labelBytes - 1)}${String(i)}`,
            description: 'd'.repeat(ASK_USER_BOUNDS.descriptionBytes),
          })),
        },
      ],
    };
    for (const state of statesOf(request)) {
      const view = projectQuestionCard(state, COLUMNS);
      expect(view.body.length).toBeLessThanOrEqual(QUESTION_CARD_MAX_BODY_ROWS);
      expect(view.body.length + CARD_RULE_ROWS + CARD_KEY_ROWS).toBeLessThanOrEqual(
        cardRowBudget(24),
      );
    }
  });

  it('holds for 300 generated calls across alphabets, with every row within the card width and no model text lost', () => {
    const random = mulberry32(20261116);
    for (let n = 0; n < 300; n += 1) {
      const request = generate(random, 1 + Math.floor(random() * 4), random() < 0.5);
      for (const state of statesOf(request)) {
        const view = projectQuestionCard(state, COLUMNS);
        expect(view.body.length).toBeLessThanOrEqual(QUESTION_CARD_MAX_BODY_ROWS);
        const rows = [view.rule, ...view.body.map((row) => row.text), ...view.keys];
        for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(COLUMNS);
        const question = request.questions[state.index];
        if (question === undefined) throw new Error('fixture');
        // Nothing the model sent is cut: the question rows rejoin to the question, every label appears whole, and the
        // highlighted option's description appears whole (the own row and a hint show their own host text).
        const questionRows = view.body
          .filter((row) => row.tone === 'question')
          .map((row) => row.text);
        expect(questionRows.join('')).toBe(question.question);
        const text = view.body.map((row) => row.text);
        for (const option of question.options)
          expect(text.some((row) => row.endsWith(option.label))).toBe(true);
        const entry = state.entries[state.index];
        const highlighted = question.options[entry?.highlight ?? -1];
        if (highlighted !== undefined && state.hint === undefined)
          expect(text.some((row) => row.trim() === highlighted.description)).toBe(true);
      }
    }
  }, 60_000);
});

describe('what the card says', () => {
  const request: AskUserRequest = {
    questions: [
      {
        header: 'Pick',
        question: 'Which file?',
        multiSelect: false,
        options: [
          { label: 'alpha.ts', description: 'The first file' },
          { label: 'beta.ts', description: 'The second file' },
        ],
      },
      {
        header: 'Also',
        question: 'Which more?',
        multiSelect: true,
        options: [
          { label: 'one', description: 'Number one' },
          { label: 'two', description: 'Number two' },
        ],
      },
    ],
  };

  it('opens with the fixed rule: a question from the agent, not an approval', () => {
    const view = projectQuestionCard(initialQuestionCard(request), COLUMNS);
    expect(view.rule).toBe(questionRule(COLUMNS));
    expect(view.rule).toContain('Question from the agent');
    expect(view.rule).toContain('not an approval');
    expect(view.rule).not.toMatch(/approval needed/i);
    // The approval card's rule is built the same way: one column short of the terminal, never over it.
    expect(displayWidth(view.rule)).toBeLessThanOrEqual(COLUMNS - 1);
  });

  it('shows the header with `n of m` for several questions and without it for one', () => {
    expect(projectQuestionCard(initialQuestionCard(request), COLUMNS).body[0]?.text).toBe(
      'Pick  1 of 2',
    );
    const one = initialQuestionCard({ questions: [request.questions[0] ?? request.questions[1]!] });
    expect(projectQuestionCard(one, COLUMNS).body[0]?.text).toBe('Pick');
  });

  it('draws the numbers, the cursor and the ticks itself, and the own row with its own glyph and no number', () => {
    const view = projectQuestionCard(initialQuestionCard(request), COLUMNS);
    const rows = view.body.map((row) => row.text);
    expect(rows).toContain('› 1 ( ) alpha.ts');
    expect(rows).toContain('  2 ( ) beta.ts');
    expect(rows.some((row) => row.includes('✎ Type your own answer…'))).toBe(true);
    expect(rows.find((row) => row.includes('✎'))).not.toMatch(/\d/);
  });

  it('marks ticks differently from the highlight, in both kinds', () => {
    const state = initialQuestionCard(request);
    const entries = state.entries.map((entry, i) => (i === 0 ? { ...entry, ticked: [1] } : entry));
    const single = projectQuestionCard({ ...state, entries }, COLUMNS).body.map((row) => row.text);
    expect(single).toContain('  2 (•) beta.ts');
    expect(single).toContain('› 1 ( ) alpha.ts');
    const second = {
      ...state,
      index: 1,
      entries: state.entries.map((entry, i) => (i === 1 ? { ...entry, ticked: [0] } : entry)),
    };
    expect(projectQuestionCard(second, COLUMNS).body.map((row) => row.text)).toContain(
      '› 1 [x] one',
    );
  });

  it('shows the highlighted option’s description, and the own row says the text is sent to the model', () => {
    const state = initialQuestionCard(request);
    const first = projectQuestionCard(state, COLUMNS).body.at(-1);
    expect(first).toMatchObject({ tone: 'description', text: '  The first file' });
    const onOwn = {
      ...state,
      entries: state.entries.map((entry, i) => (i === 0 ? { ...entry, highlight: 2 } : entry)),
    };
    expect(projectQuestionCard(onOwn, COLUMNS).body.at(-1)?.text).toMatch(/sent to the model/i);
  });

  it('shows a hint in place of the description, in the hint tone', () => {
    const view = projectQuestionCard(
      { ...initialQuestionCard(request), hint: 'Pick one.' },
      COLUMNS,
    );
    expect(view.body.at(-1)).toMatchObject({ tone: 'hint', text: '  Pick one.' });
  });

  it('shows the open field with a block cursor and the tail of a long line, and a counter near the limit', () => {
    const state = initialQuestionCard(request);
    const short = projectQuestionCard({ ...state, field: { text: 'hello', cursor: 5 } }, COLUMNS);
    expect(short.body.find((row) => row.tone === 'field')?.text).toContain('hello█');
    const long = projectQuestionCard(
      { ...state, field: { text: `${'a'.repeat(450)}END`, cursor: 453 } },
      COLUMNS,
    );
    const row = long.body.find((r) => r.tone === 'field')?.text ?? '';
    expect(row).toContain('END█');
    expect(row).toContain('…');
    expect(row).toContain('453/500');
    expect(displayWidth(row)).toBeLessThanOrEqual(WIDTH);
  });

  it('shows accepted own text on the own row, ticked', () => {
    const state = initialQuestionCard(request);
    const entries = state.entries.map((entry, i) =>
      i === 0 ? { ...entry, own: 'my answer' } : entry,
    );
    const rows = projectQuestionCard({ ...state, entries }, COLUMNS).body.map((row) => row.text);
    expect(rows.some((row) => row.includes('(•) ✎ my answer'))).toBe(true);
  });

  it('keeps the key rows to two: the answer keys, then the stop keys', () => {
    const state = initialQuestionCard(request);
    const first = projectQuestionCard(state, COLUMNS).keys;
    expect(first[0]).toMatch(/1-4 or Enter choose/);
    expect(first[0]).toMatch(/s skip all/);
    expect(first[0]).not.toMatch(/back/);
    expect(first[1]).toBe('Esc or Ctrl-C stops the turn');
    const second = projectQuestionCard({ ...state, index: 1 }, COLUMNS).keys[0];
    expect(second).toMatch(/Space or 1-4 tick/);
    expect(second).toMatch(/← back/);
    const inField = projectQuestionCard({ ...state, field: { text: '', cursor: 0 } }, COLUMNS)
      .keys[0];
    expect(inField).toMatch(/Enter accept/);
    expect(inField).not.toMatch(/s skip/); // `s` is a letter in the field
  });

  it('never offers the approval keys', () => {
    const view = projectQuestionCard(initialQuestionCard(request), COLUMNS);
    const everything = [view.rule, ...view.body.map((row) => row.text), ...view.keys].join('\n');
    expect(everything).not.toMatch(/\[y\]|\[a\]|\[n\]|\[c\]|always|approve|deny/i);
  });

  it('round-trips with the reducer: a key that changes the highlight changes the projection', () => {
    const state = initialQuestionCard(request);
    const action = reduceQuestionKey(state, '', { downArrow: true }, true);
    if (action.kind !== 'state') throw new Error('fixture');
    expect(projectQuestionCard(action.state, COLUMNS).body.map((row) => row.text)).toContain(
      '› 2 ( ) beta.ts',
    );
  });
});
