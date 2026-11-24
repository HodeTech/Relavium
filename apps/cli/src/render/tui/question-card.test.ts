import { ASK_USER_BOUNDS, plainTextRefusal, type AskUserRequest } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { withGlyphForm } from './glyphs.js';
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

const clusterSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (text: string): string[] =>
  [...clusterSegmenter.segment(text)].map((part) => part.segment);

/**
 * The UTF-16 offsets at which a row of `rows` ends or begins INSIDE a grapheme cluster of the rows' concatenation (none for a
 * correct wrap). `Intl.Segmenter` is the oracle, so the check does not share a splitter with the code under test.
 */
function cutsInsideClusters(rows: readonly string[]): number[] {
  const starts = new Set<number>();
  let at = 0;
  for (const cluster of graphemes(rows.join(''))) {
    starts.add(at);
    at += cluster.length;
  }
  starts.add(at);
  const inside: number[] = [];
  let offset = 0;
  for (const row of rows) {
    offset += row.length;
    if (!starts.has(offset)) inside.push(offset);
  }
  return inside;
}

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

  it('never splits a grapheme: no row begins or ends inside a cluster, at any width', () => {
    const family = '👨\u200d👩\u200d👧';
    const texts = [
      `ab${family}cd`,
      'e\u0301e\u0301e\u0301',
      'q\u0307q\u0307x\u0323\u0307',
      '🇯🇵🇺🇸x',
      '👍🏽a👍🏽',
      '1\uFE0F\u20E3a',
      'क्षत्र',
      'a漢\u0301b',
    ];
    for (const text of texts) {
      expect(
        graphemes(text).some((cluster) => [...cluster].length > 1),
        `${JSON.stringify(text)} must contain a multi-code-point cluster or this proves nothing`,
      ).toBe(true);
      for (let width = 1; width <= 9; width += 1) {
        const rows = hardWrap(text, width);
        expect(rows.join(''), `${JSON.stringify(text)} at ${String(width)}`).toBe(text);
        expect(cutsInsideClusters(rows), `${JSON.stringify(text)} at ${String(width)}`).toEqual([]);
      }
    }
    // The cluster the old test used, with the exact rows: the family is one two-cell unit, so it moves whole to the next row.
    expect(hardWrap(`ab${family}cd`, 3)).toEqual(['ab', `${family}c`, 'd']);
  });

  it('the oracle itself can fail: it names a cut that falls inside a cluster', () => {
    expect(cutsInsideClusters(['e', '\u0301x'])).toEqual([1]);
    expect(cutsInsideClusters(['👨\u200d', '👩'])).toEqual([3]);
    expect(cutsInsideClusters(['e\u0301', 'x'])).toEqual([]);
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
  // Multi-code-point clusters the validator ACCEPTS (NFC, no format characters), so they reach the card: a combining mark with
  // no precomposed form, an emoji with a skin-tone modifier, a flag, a keycap, an Indic conjunct. (A ZWJ sequence or a decomposed
  // `e` + U+0301 is REFUSED for model text; the generator once used both and silently fell back to `xxxxxxxx` every time.)
  ['q\u0307', 'x\u0323', 'z\u0303'],
  ['👍🏽', '🇯🇵', '🇺🇸'],
  ['1\uFE0F\u20E3', 'क्ष', 'a'],
];

/**
 * A byte ceiling of 150 holds at most 74 cells of wide clusters, so a text made of clusters alone never wraps at 76 cells. These
 * are mostly one-cell ASCII, which does reach the row boundary, with a cluster in the mix to land on it.
 */
const EDGE_ALPHABETS: readonly (readonly string[])[] = [
  'q\u0307',
  '👍🏽',
  '🇯🇵',
  '1\uFE0F\u20E3',
  'क्ष',
].map((cluster) => [...'abcdefghijkl', cluster]);

/**
 * The longest string over `alphabet` within `maxBytes`, trimmed (the validator forbids edge whitespace). It is admissible by
 * construction, and it PROVES it: a text the real validator refuses is an error in the test, never replaced by a stand-in
 * (a silent stand-in is how the cluster alphabets once went untested).
 */
function longest(random: () => number, alphabet: readonly string[], maxBytes: number): string {
  let out = '';
  for (let guard = 0; guard < 400; guard += 1) {
    const next = alphabet[Math.floor(random() * alphabet.length)] ?? 'x';
    const candidate = out + next;
    if (Buffer.byteLength(candidate, 'utf8') > maxBytes) break;
    out = candidate;
  }
  const trimmed = out.trim();
  const refusal = plainTextRefusal(trimmed, maxBytes);
  if (refusal !== undefined) {
    throw new Error(
      `the generator made ${JSON.stringify(trimmed)}, which the validator refuses: ${refusal}`,
    );
  }
  return trimmed;
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

  it('every alphabet yields text the validator accepts, and the cluster alphabets really carry clusters', () => {
    const multiCodePoint = (text: string): boolean =>
      graphemes(text).some((cluster) => [...cluster].length > 1);
    for (const alphabet of ALPHABETS) {
      const text = longest(mulberry32(11), alphabet, ASK_USER_BOUNDS.questionBytes); // throws on a refusal
      expect(text.length).toBeGreaterThan(8);
      expect(text, 'not the old `xxxxxxxx` stand-in').not.toBe('x'.repeat(8));
    }
    const clustered = ALPHABETS.filter((alphabet) => alphabet.some(multiCodePoint));
    expect(clustered.length).toBeGreaterThanOrEqual(3);
  });

  it('holds for 300 generated calls across alphabets, with every row within the card width and no model text lost', () => {
    const random = mulberry32(20261116);
    let withClusters = 0;
    for (let n = 0; n < 300; n += 1) {
      const request = generate(random, 1 + Math.floor(random() * 4), random() < 0.5);
      if (
        request.questions.some((q) =>
          graphemes(q.question).some((cluster) => [...cluster].length > 1),
        )
      )
        withClusters += 1;
      const cutChecked = new Set<number>();
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
        // Every row of model text starts with the host's gutter; strip it and the rows rejoin to exactly the question.
        expect(questionRows.every((row) => row.startsWith('│ '))).toBe(true);
        expect(questionRows.map((row) => row.slice(2)).join('')).toBe(question.question);
        // ...and no row of it begins or ends inside a grapheme cluster (Intl.Segmenter is the oracle). A question's rows do not
        // depend on the state, so each is checked once per call.
        if (!cutChecked.has(state.index)) {
          cutChecked.add(state.index);
          expect(cutsInsideClusters(questionRows.map((row) => row.slice(2)))).toEqual([]);
        }
        const text = view.body.map((row) => row.text);
        for (const option of question.options)
          expect(text.some((row) => row.endsWith(option.label))).toBe(true);
        const entry = state.entries[state.index];
        const highlighted = question.options[entry?.highlight ?? -1];
        if (highlighted !== undefined && state.hint === undefined)
          expect(text.some((row) => row === `│ ${highlighted.description}`)).toBe(true);
      }
    }
    // The generator really exercised clusters: a question with a multi-code-point cluster in it is most of the calls (174 of 300 at this seed).
    expect(withClusters, 'calls whose question carries a cluster').toBeGreaterThan(100);
  }, 60_000);
});

describe('a grapheme cluster at the wrap boundary stays whole in the card (ADR-0132 §2)', () => {
  // The question rows are 76 cells wide (80 columns, two of margin, two of gutter): these put a cluster across that edge.
  const CLUSTERS = ['👍🏽', '🇯🇵', '1\uFE0F\u20E3', 'क्ष', 'q\u0307', 'x\u0323'];
  const ROW_CELLS = COLUMNS - 2 - 2;

  function questionRowsOf(text: string): string[] {
    const request: AskUserRequest = {
      questions: [
        {
          header: 'Edge',
          question: text,
          multiSelect: false,
          options: [
            { label: 'one', description: 'First' },
            { label: 'two', description: 'Second' },
          ],
        },
      ],
    };
    return projectQuestionCard(initialQuestionCard(request), COLUMNS)
      .body.filter((row) => row.tone === 'question')
      .map((row) => row.text.slice(2));
  }

  it('no cut falls inside a cluster, for every cluster at every offset around the edge', () => {
    for (const cluster of CLUSTERS) {
      for (let before = ROW_CELLS - 6; before <= ROW_CELLS + 2; before += 1) {
        const text = `${'a'.repeat(before)}${cluster}bc`;
        expect(plainTextRefusal(text, ASK_USER_BOUNDS.questionBytes), 'admissible').toBeUndefined();
        const rows = questionRowsOf(text);
        expect(rows.join(''), `${JSON.stringify(cluster)} after ${String(before)}`).toBe(text);
        expect(
          cutsInsideClusters(rows),
          `${JSON.stringify(cluster)} after ${String(before)}`,
        ).toEqual([]);
      }
    }
  });

  it('generated questions that really wrap: no cut falls inside a cluster', () => {
    const random = mulberry32(20261121);
    let wrapped = 0;
    for (let n = 0; n < 200; n += 1) {
      const alphabet = EDGE_ALPHABETS[n % EDGE_ALPHABETS.length] ?? [];
      const text = longest(random, alphabet, ASK_USER_BOUNDS.questionBytes); // throws on a refusal
      const rows = questionRowsOf(text);
      expect(rows.join('')).toBe(text);
      expect(cutsInsideClusters(rows), JSON.stringify(text)).toEqual([]);
      if (rows.length > 1) wrapped += 1;
    }
    expect(wrapped, 'the calls whose question needed a second row').toBeGreaterThan(150);
  });

  it('a wide cluster that does not fit the room left moves whole to the next row', () => {
    for (const cluster of ['👍🏽', '🇯🇵']) {
      const rows = questionRowsOf(`${'a'.repeat(ROW_CELLS - 1)}${cluster}b`);
      expect(rows).toEqual(['a'.repeat(ROW_CELLS - 1), `${cluster}b`]);
    }
  });
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

  it('shows the header with the tab strip for several questions and without it for one', () => {
    expect(projectQuestionCard(initialQuestionCard(request), COLUMNS).body[0]?.text).toBe(
      '│ Pick  [○] ○ · Review',
    );
    const one = initialQuestionCard({ questions: [request.questions[0] ?? request.questions[1]!] });
    expect(projectQuestionCard(one, COLUMNS).body[0]?.text).toBe('│ Pick');
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
    expect(first).toMatchObject({ tone: 'description', text: '│ The first file' });
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
    expect(view.body.at(-1)).toMatchObject({ tone: 'hint', text: '  Pick one.' }); // host text: no gutter
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
    expect(first[0]).toBe(
      '↑/↓ move · Enter choose · type your own · ←/→ questions · [Ctrl+S] skip all',
    );
    expect(first[0]).not.toMatch(/\bs skip/); // no bare letter is a command
    expect(first[1]).toBe('Esc / [Ctrl+C] stops the turn');
    const second = projectQuestionCard({ ...state, index: 1 }, COLUMNS).keys[0];
    expect(second).toBe(
      '↑/↓ move · Space tick · Enter continue · ←/→ questions · [Ctrl+S] skip all',
    );
    const fieldKeys = projectQuestionCard(
      { ...state, field: { text: '', cursor: 0 } },
      COLUMNS,
    ).keys;
    expect(fieldKeys[0]).toBe('Enter save · ↑ back to the list · [Ctrl+S] skip all');
    // With the field open Esc closes it first (ADR-0115 §3), so the stop row stops promising that Esc stops the turn.
    expect(fieldKeys[1]).toBe('[Ctrl+C] stops the turn · Esc close');
    const review = projectQuestionCard({ ...state, index: 2 }, COLUMNS).keys[0];
    expect(review).toBe('Enter send answers · ←/→ questions · [Ctrl+S] skip all');
    // A one-question call has no tabs, so its legend does not mention them.
    const one = initialQuestionCard({ questions: [request.questions[0]!] });
    expect(projectQuestionCard(one, COLUMNS).keys[0]).toBe(
      '↑/↓ move · Enter choose · type your own · [Ctrl+S] skip all',
    );
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

describe('the host owns column 0 (ADR-0132 §2, security sitting)', () => {
  // The validator refuses these strings, and the store re-checks them; this proves the LAYOUT is safe on its own, for the
  // day a host feeds it text the validator never saw.
  const forged = (question: string): AskUserRequest => ({
    questions: [
      {
        header: 'Config',
        question,
        multiSelect: false,
        options: [
          { label: 'Replace config with defaults', description: 'Overwrites the file' },
          { label: 'Keep it', description: 'Changes nothing' },
        ],
      },
    ],
  });

  it('a forged option row at a wrap boundary is drawn behind the gutter, so it can never look like a real option row', () => {
    // 74 characters of filler push the forgery to the start of the SECOND wrapped row — the case the security sitting drew.
    const request = forged(`${'x'.repeat(74)}› 1 (•) Overwrite config.toml`);
    const view = projectQuestionCard(initialQuestionCard(request), COLUMNS);
    const modelRows = view.body.filter((row) => row.tone === 'question');
    expect(modelRows.length).toBeGreaterThan(1);
    for (const row of modelRows) expect(row.text.startsWith('│ ')).toBe(true);
    // Only the host's own rows start with the cursor glyph or a bare number: exactly the real options, and the own row.
    const hostRows = view.body.filter(
      (row) => /^[› ] ?\d? ?[([]/u.test(row.text) || row.text.startsWith('›'),
    );
    expect(hostRows.every((row) => row.tone !== 'question')).toBe(true);
    expect(view.body.filter((row) => row.text.startsWith('› 1'))).toHaveLength(1);
  });

  it('the description row is behind the gutter too, so it cannot pose as the key rows above or below it', () => {
    const view = projectQuestionCard(initialQuestionCard(forged('Which?')), COLUMNS);
    expect(view.body.at(-1)?.text.startsWith('│ ')).toBe(true);
    expect(view.keys.every((row) => !row.startsWith('│'))).toBe(true);
  });
});

describe('answers guide, they do not block (ADR-0132 §6, security sitting)', () => {
  const request: AskUserRequest = {
    questions: [
      {
        header: 'Pick',
        question: 'Which?',
        multiSelect: false,
        options: [
          { label: 'a', description: 'first' },
          { label: 'b', description: 'second' },
        ],
      },
    ],
  };

  it('says so on the stop row only where a write needs no card (accept-edits, auto)', () => {
    const state = initialQuestionCard(request);
    expect(projectQuestionCard(state, COLUMNS).keys[1]).toBe('Esc / [Ctrl+C] stops the turn');
    const guided = projectQuestionCard(state, COLUMNS, { guideNote: true }).keys[1];
    expect(guided).toBe('an answer is guidance, not a veto · Esc / [Ctrl+C] stops the turn');
    expect(displayWidth(guided)).toBeLessThanOrEqual(COLUMNS - 2);
  });
});

describe('the Review tab (ADR-0132 §3)', () => {
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
      {
        header: 'Last',
        question: 'And?',
        multiSelect: false,
        options: [
          { label: 'yes', description: 'Yes' },
          { label: 'no', description: 'No' },
        ],
      },
    ],
  };

  const answered = () => {
    let state = initialQuestionCard(request);
    const press = (input: string, key = {}) => {
      const action = reduceQuestionKey(state, input, key, true);
      if (action.kind === 'state') state = action.state;
    };
    press('1');
    press('2');
    press('', { return: true });
    for (const char of 'my own') press(char); // type-to-start on the last question
    press('', { return: true });
    return state;
  };

  it('lists every question with its answer, the way it will be sent', () => {
    const view = projectQuestionCard(answered(), COLUMNS);
    const rows = view.body.map((row) => row.text);
    expect(rows[0]).toBe('Review your answers  ● ● ● · [Review]');
    expect(rows[1]).toBe('● 1 Pick → alpha.ts');
    expect(rows[2]).toBe('● 2 Also → two');
    expect(rows[3]).toBe('● 3 Last → “my own”');
    // the keys are the key row's: a closing row that said them again in other words (`send them`, `[1-3] change one`) is not drawn
    expect(rows).toHaveLength(4);
    expect(rows.join('\n')).not.toMatch(/send them|change one|\[1-3\]/u);
    expect(view.keys[0]).toBe('Enter send answers · ←/→ questions · [Ctrl+S] skip all');
  });

  it('marks an unanswered question and shows the note the reducer left', () => {
    const state = initialQuestionCard(request);
    const review = { ...state, index: 3, hint: 'Question 1 is not answered yet.' };
    const rows = projectQuestionCard(review, COLUMNS).body;
    expect(rows[1]).toMatchObject({ text: '○ 1 Pick → not answered yet', tone: 'pending' });
    expect(rows.at(-1)).toMatchObject({ text: 'Question 1 is not answered yet.', tone: 'hint' });
  });

  it('fits: at most a title, four answers and a note, every row inside the card width', () => {
    const four: AskUserRequest = {
      questions: Array.from({ length: 4 }, (_, i) => ({
        header: 'h'.repeat(24),
        question: `q${String(i)}`,
        multiSelect: true,
        options: [
          { label: 'l'.repeat(60), description: 'a' },
          { label: 'm'.repeat(60), description: 'b' },
        ],
      })),
    };
    let state = { ...initialQuestionCard(four), index: 4 };
    state = {
      ...state,
      entries: state.entries.map((entry) => ({ ...entry, ticked: [0, 1], own: 'o'.repeat(500) })),
    };
    const view = projectQuestionCard(state, COLUMNS);
    expect(view.body.length).toBeLessThanOrEqual(QUESTION_CARD_MAX_BODY_ROWS);
    for (const row of view.body) expect(displayWidth(row.text)).toBeLessThanOrEqual(COLUMNS - 2);
  });

  it('the tab strip fills in as questions are answered and brackets the tab on screen', () => {
    const state = initialQuestionCard(request);
    expect(projectQuestionCard(state, COLUMNS).body[0]?.text).toBe('│ Pick  [○] ○ ○ · Review');
    const after = {
      ...state,
      index: 1,
      entries: state.entries.map((e, i) => (i === 0 ? { ...e, ticked: [0] } : e)),
    };
    expect(projectQuestionCard(after, COLUMNS).body[0]?.text).toBe('│ Also  ● [○] ○ · Review');
  });

  it('colours a chosen option differently from a plain one and from the highlight', () => {
    const state = initialQuestionCard(request);
    const entries = state.entries.map((e, i) => (i === 0 ? { ...e, ticked: [1] } : e));
    const rows = projectQuestionCard({ ...state, entries }, COLUMNS).body;
    expect(rows.find((row) => row.text.includes('beta.ts'))?.tone).toBe('chosen');
    expect(rows.find((row) => row.text.includes('alpha.ts'))?.tone).toBe('highlight');
  });
});

/**
 * ADR-0132 §3: the Review tab "lists every answer as it will be sent". Enter sends the whole text, so the tab shows the whole
 * text, wrapped over the rows the card's body bound leaves; where even that cannot hold it, the row says how many characters it
 * hides. It was one clipped line per answer (review finding V6a-04).
 */
describe('the Review tab shows the whole answer, or says how much it hides (ADR-0132 §3)', () => {
  const GLYPH_ROW = /^[●○] /u;
  const NOTICE = /… (\d+) more characters? not shown$/u;

  function requestOf(count: number): AskUserRequest {
    return {
      questions: Array.from({ length: count }, (_, i) => ({
        header: `Notes${String(i + 1)}`,
        question: `q${String(i + 1)}`,
        multiSelect: false,
        options: [
          { label: 'yes', description: 'Yes' },
          { label: 'no', description: 'No' },
        ],
      })),
    };
  }

  /** The Review tab with each question answered by its own text (`undefined` leaves it unanswered). */
  function reviewOf(own: readonly (string | undefined)[]): QuestionCardState {
    const base = initialQuestionCard(requestOf(own.length));
    return {
      ...base,
      index: own.length,
      entries: base.entries.map((entry, i) => {
        const text = own[i];
        return text === undefined ? entry : { ...entry, own: text };
      }),
    };
  }

  /** The line one answer would be on a single, unbounded row. */
  const fullLine = (index: number, text: string): string =>
    `● ${String(index + 1)} Notes${String(index + 1)} → “${text}”`;

  /** The rows of the answers alone: the title above them is not part of any answer (the tab has no closing row unless a hint is up). */
  const answerRowsOf = (state: QuestionCardState): string[] =>
    projectQuestionCard(state, COLUMNS)
      .body.slice(1)
      .map((row) => row.text);

  /** Group the answer rows by answer: a row that starts with a dot begins one, an indented row continues the last. */
  function grouped(rows: readonly string[]): string[][] {
    const groups: string[][] = [];
    for (const row of rows) {
      if (GLYPH_ROW.test(row)) groups.push([row]);
      else groups.at(-1)?.push(row);
    }
    return groups;
  }

  /** What a group shows of its line, and how many characters it says it hides (0 when it says nothing). */
  function readGroup(group: readonly string[]): {
    readonly shown: string;
    readonly hidden: number;
  } {
    const text = group.map((row, at) => (at === 0 ? row : row.slice(4)));
    const last = text.at(-1) ?? '';
    const match = NOTICE.exec(last);
    if (match === null) return { shown: text.join(''), hidden: 0 };
    const kept = last.slice(0, last.length - match[0].length - 1); // the row is `${kept} ${notice}`
    return { shown: [...text.slice(0, -1), kept].join(''), hidden: Number(match[1]) };
  }

  it('an answer that fits the rows left is shown whole, wrapped under its own row', () => {
    const own = 'word '.repeat(30).trim(); // 149 characters: one clipped line before
    const rows = answerRowsOf(reviewOf([own, 'ok']));
    const [first, second] = grouped(rows);
    expect(first?.length).toBe(3);
    expect(first?.slice(1).every((row) => row.startsWith('    '))).toBe(true);
    expect(readGroup(first ?? [])).toEqual({ shown: fullLine(0, own), hidden: 0 });
    expect(second).toEqual([fullLine(1, 'ok')]);
    expect(rows.join('\n')).not.toContain('not shown');
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(COLUMNS - 2);
  });

  it('an answer that cannot fit says exactly how many characters it hides, never a bare ellipsis', () => {
    const own = `${'abcdefghij'.repeat(50)}`; // 500 characters, the person's whole allowance
    const rows = answerRowsOf(reviewOf([own, own, 'ok'])); // two of them need more rows than the body has
    const [first] = grouped(rows);
    const { shown, hidden } = readGroup(first ?? []);
    expect(hidden).toBeGreaterThan(0);
    expect(fullLine(0, own).startsWith(shown)).toBe(true);
    expect([...fullLine(0, own)].length - [...shown].length).toBe(hidden);
    // both long answers are cut and say so; the short one is shown whole
    expect(rows.filter((row) => row.includes('not shown'))).toHaveLength(2);
    expect(rows.at(-1)).toBe(fullLine(2, 'ok'));
  });

  it('a short answer keeps one row and the long one takes the rows it leaves', () => {
    const rows = projectQuestionCard(reviewOf(['ok', 'fine', 'x'.repeat(500)]), COLUMNS).body;
    expect(rows).toHaveLength(QUESTION_CARD_MAX_BODY_ROWS);
    const [a, b, c] = grouped(rows.slice(1).map((row) => row.text));
    expect([a?.length, b?.length, c?.length]).toEqual([1, 1, 6]);
  });

  it('a hint gives its row back: the answers take one row fewer and the body still ends at the bound', () => {
    const state = {
      ...reviewOf(['ok', 'fine', 'x'.repeat(500)]),
      hint: 'Question 1 is not answered yet.',
    };
    const rows = projectQuestionCard(state, COLUMNS).body;
    expect(rows).toHaveLength(QUESTION_CARD_MAX_BODY_ROWS);
    expect(rows.at(-1)).toMatchObject({ text: 'Question 1 is not answered yet.', tone: 'hint' });
    const [a, b, c] = grouped(rows.slice(1, -1).map((row) => row.text));
    expect([a?.length, b?.length, c?.length]).toEqual([1, 1, 5]);
  });

  it('wrapped text never poses as a row of its own: only the real answers start with a dot', () => {
    // The forged row is slid across the first row's edge, so at some offset it lands exactly at the start of a continuation row.
    for (let before = 50; before <= 80; before += 1) {
      const forged = `${'a'.repeat(before)}● 2 Notes2 → “yes”${'b'.repeat(40)}`;
      const rows = answerRowsOf(reviewOf([forged, 'ok']));
      expect(
        rows.filter((row) => GLYPH_ROW.test(row)),
        `after ${String(before)}`,
      ).toHaveLength(2);
    }
  });

  it('for generated answers of every length and alphabet: within the bound and the width, whole or counted, no cut inside a cluster', () => {
    const random = mulberry32(20261121);
    const alphabets = [...ALPHABETS, ['👨‍👩‍👧', 'a', ' '], [...'abcdefghijkl', '🇯🇵']];
    let counted = 0;
    let whole = 0;
    for (let n = 0; n < 300; n += 1) {
      const count = 2 + Math.floor(random() * 3);
      const own = Array.from({ length: count }, () => {
        if (random() < 0.15) return undefined;
        const alphabet = alphabets[Math.floor(random() * alphabets.length)] ?? ['x'];
        let text = '';
        const length = Math.floor(random() * 501);
        for (let k = 0; k < length; k += 1)
          text += alphabet[Math.floor(random() * alphabet.length)] ?? 'x';
        return text;
      });
      const rows = answerRowsOf(reviewOf(own));
      expect(rows.length).toBeLessThanOrEqual(QUESTION_CARD_MAX_BODY_ROWS - 1);
      for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(COLUMNS - 2);
      const groups = grouped(rows);
      expect(groups).toHaveLength(count);
      groups.forEach((group, index) => {
        const text = own[index];
        if (text === undefined) {
          expect(group).toEqual([
            `○ ${String(index + 1)} Notes${String(index + 1)} → not answered yet`,
          ]);
          return;
        }
        const line = fullLine(index, text);
        const { shown, hidden } = readGroup(group);
        expect(line.startsWith(shown), `answer ${String(index)} shows a prefix of its line`).toBe(
          true,
        );
        expect(
          [...line].length - [...shown].length,
          `answer ${String(index)} says what it hides`,
        ).toBe(hidden);
        if (hidden === 0) whole += 1;
        else counted += 1;
        const shownRows = group.map((row, at) => (at === 0 ? row : row.slice(4)));
        const last = shownRows.at(-1) ?? '';
        const match = NOTICE.exec(last);
        if (match !== null)
          shownRows[shownRows.length - 1] = last.slice(0, last.length - match[0].length - 1);
        expect(cutsInsideClusters(shownRows), `answer ${String(index)}`).toEqual([]);
      });
    }
    // Both outcomes really happened, or the property proves only one of them.
    expect(whole).toBeGreaterThan(100);
    expect(counted).toBeGreaterThan(30);
  });
});

describe('the stop row gives up the note, never the key that leaves (round-1 fix)', () => {
  const request: AskUserRequest = {
    questions: [
      {
        header: 'Pick',
        question: 'Which?',
        multiSelect: false,
        options: [
          { label: 'a', description: 'first' },
          { label: 'b', description: 'second' },
        ],
      },
    ],
  };
  const NOTE = 'an answer is guidance, not a veto';
  const state = initialQuestionCard(request);
  const inField: QuestionCardState = { ...state, field: { text: '', cursor: 0 } };

  it('keeps `stops the turn` whole at 50, 60 and 66 columns, where the note no longer fits, and keeps both at 67', () => {
    for (const columns of [50, 60, 66]) {
      const row = projectQuestionCard(state, columns, { guideNote: true }).keys[1];
      expect(row, `${String(columns)} columns`).toBe('Esc / [Ctrl+C] stops the turn');
      expect(row).not.toContain(NOTE);
      expect(displayWidth(row)).toBeLessThanOrEqual(columns - 2);
    }
    const whole = projectQuestionCard(state, 67, { guideNote: true }).keys[1];
    expect(whole).toBe(`${NOTE} · Esc / [Ctrl+C] stops the turn`);
    expect(displayWidth(whole)).toBe(65);
  });

  it('the note goes first and the exit last, with the room to hold both', () => {
    const row = projectQuestionCard(state, COLUMNS, { guideNote: true }).keys[1];
    expect(row.startsWith(NOTE)).toBe(true);
    expect(row.endsWith('stops the turn')).toBe(true);
  });

  it('the own-answer field row keeps `Esc close`, and `[Ctrl+C] stops the turn`, as the note gives way', () => {
    for (const columns of [38, 40, 50, 60, 66, 67, 80]) {
      const row = projectQuestionCard(inField, columns, { guideNote: true }).keys[1];
      expect(row, `${String(columns)} columns`).toContain('Esc close');
      expect(row, `${String(columns)} columns`).toContain('[Ctrl+C] stops the turn');
      expect(displayWidth(row)).toBeLessThanOrEqual(columns - 2);
    }
    expect(projectQuestionCard(inField, 50, { guideNote: true }).keys[1]).toBe(
      '[Ctrl+C] stops the turn · Esc close',
    );
    expect(projectQuestionCard(inField, 80, { guideNote: true }).keys[1]).toBe(
      `[Ctrl+C] stops the turn · ${NOTE} · Esc close`,
    );
    // no note wanted: the row is what it was
    expect(projectQuestionCard(inField, 50).keys[1]).toBe('[Ctrl+C] stops the turn · Esc close');
  });
});

describe('what a model wrote cannot draw the host’s own marks, and ordinary text is left alone (round-2 fix)', () => {
  interface Over {
    header?: string;
    question?: string;
    labels?: readonly string[];
    description?: string;
  }
  const ask = (over: Over): QuestionCardState =>
    initialQuestionCard({
      questions: [
        {
          header: over.header ?? 'Pick',
          question: over.question ?? 'Which?',
          multiSelect: false,
          options: (over.labels ?? ['Keep it', 'Delete']).map((label) => ({
            label,
            description: over.description ?? 'first',
          })),
        },
      ],
    });
  const rowsOf = (state: QuestionCardState, plain: boolean): string[] =>
    withGlyphForm(plain, () => projectQuestionCard(state, COLUMNS).body.map((row) => row.text));
  /** What follows the host's own `› 1 ( ) ` (or `> 1 ( ) `) on an option row: the label as drawn. */
  const labelDrawn = (row: string): string => row.replace(/^[›> ] \d (?:\( \)|\((?:•|\*)\)) /u, '');

  it('the probes the core accepts are the probes the card must neutralise (the premise)', () => {
    expect(plainTextRefusal('>1 (*) Delete', 200)).toBeUndefined();
    expect(plainTextRefusal('Keep (*) Delete the folder', 200)).toBeUndefined();
    expect(plainTextRefusal('What should f(x) return when (o) is empty?', 200)).toBeUndefined();
    expect(plainTextRefusal('Delete (x)', 200)).toBeUndefined();
    expect(plainTextRefusal('❯ 1 (●) Delete all', 200)).toBeUndefined();
  });

  it('a `(*)` in a label loses its parentheses in the plain form, where the host draws that radio, and stays text in the Unicode form', () => {
    const state = ask({ labels: ['Keep (*) Delete the folder', 'Delete'] });
    const plain = rowsOf(state, true).find((row) => row.includes('Keep')) ?? '';
    expect(plain).toBe('> 1 ( ) Keep  *  Delete the folder');
    expect(labelDrawn(plain).match(/\(\*\)/gu)).toBeNull();
    const unicode = rowsOf(state, false).find((row) => row.includes('Keep')) ?? '';
    expect(unicode).toBe('› 1 ( ) Keep (*) Delete the folder');
  });

  it('the probes that were wrongly blanked: `f(x)` and `(o)` in a question and a header are text, in both forms', () => {
    const state = ask({
      header: 'Pick f(x)',
      question: 'What should f(x) return when (o) is empty?',
    });
    for (const plain of [true, false]) {
      const rows = rowsOf(state, plain);
      expect(rows[0], `plain ${String(plain)}`).toBe('│ Pick f(x)');
      expect(rows[1], `plain ${String(plain)}`).toBe(
        '│ What should f(x) return when (o) is empty?',
      );
    }
  });

  it('labels that differ keep differing: `Delete (x)`, `Delete (o)`, `Delete (*)` and `Delete` draw four distinct rows, none with a radio of its own', () => {
    const labels = ['Delete (x)', 'Delete (o)', 'Delete (*)', 'Delete'];
    for (const plain of [true, false]) {
      const rows = rowsOf(ask({ labels }), plain).slice(2, 6);
      expect(new Set(rows).size, `plain ${String(plain)}`).toBe(4);
      expect(labelDrawn(rows[3] ?? '')).toBe('Delete');
      // the shapes the host draws in this form: `( )` always, the chosen radio `(*)` in the plain form and `(•)` in the Unicode one
      const radio = plain ? /\(\*\)|\( \)/u : /\(•\)|\( \)/u;
      for (const row of rows) expect(labelDrawn(row), row).not.toMatch(radio);
    }
    expect(rowsOf(ask({ labels }), true).slice(2, 6).map(labelDrawn)).toEqual([
      'Delete (x)',
      'Delete (o)',
      'Delete  * ',
      'Delete',
    ]);
  });

  it('a lookalike of the host’s cursor row in the header is drawn behind the host’s gutter, never at column 0, with its host glyphs blanked', () => {
    const headers = [
      '˃ 1 (∗) Delete',
      '❯ 1 (●) Delete all',
      '＞1 （*） Delete',
      '>1 (*) Delete',
      '> 1 ( ) Keep it',
    ];
    for (const plain of [true, false])
      for (const header of headers) {
        const row = rowsOf(ask({ header }), plain)[0] ?? '';
        expect(row.startsWith('│ '), `${header} (plain ${String(plain)})`).toBe(true);
        expect(row, header).not.toMatch(/[❯●]/u);
      }
    expect(rowsOf(ask({ header: '❯ 1 (●) Delete all' }), true)[0]).toBe('│   1     Delete all');
    expect(rowsOf(ask({ header: '❯ 1 (●) Delete all' }), false)[0]).toBe('│   1     Delete all');
  });

  it('every string a model wrote is held to the rule: the question, a label and the highlighted description', () => {
    const state = ask({
      question: 'Pick (*) or ❯ (●)',
      labels: ['A (*) ❯', 'B'],
      description: 'Why (*) ❯ (●)',
    });
    const plain = rowsOf(state, true);
    const unicode = rowsOf(state, false);
    // the question and the description (the highlighted option's) are behind the gutter, and say nothing the host says
    expect(plain[1]?.trimEnd()).toBe('│ Pick  *  or');
    expect(plain.at(-1)?.trimEnd()).toBe('│ Why  *');
    expect(unicode[1]?.trimEnd()).toBe('│ Pick (*) or');
    expect(unicode.at(-1)?.trimEnd()).toBe('│ Why (*)');
    // the label is the third row of the card (header, question, then the options)
    expect(labelDrawn(plain[2] ?? '').trimEnd()).toBe('A  *');
    expect(labelDrawn(unicode[2] ?? '').trimEnd()).toBe('A (*)');
  });

  it('the host cursor `>` at the start of a header is blanked in the plain form only; a `>` elsewhere is text', () => {
    expect(rowsOf(ask({ header: '>1 (*) Delete' }), true)[0]).toBe('│  1  *  Delete');
    expect(rowsOf(ask({ header: '>1 (*) Delete' }), false)[0]).toBe('│ >1 (*) Delete');
    const state = ask({ header: 'a > b', labels: ['>x then', 'y'], description: 'x > 1' });
    const text = rowsOf(state, true).join('\n');
    expect(text).toContain('a > b');
    expect(text).toContain('>x then');
    expect(text).toContain('x > 1');
  });

  it('the Review tab holds model text to the same rule: a header and a chosen label', () => {
    const two = initialQuestionCard({
      questions: [
        {
          header: 'Head (*)',
          question: 'Which?',
          multiSelect: false,
          options: [
            { label: 'Keep (x) (*) it', description: 'first' },
            { label: 'Delete', description: 'second' },
          ],
        },
        {
          header: '❯ Also',
          question: 'And?',
          multiSelect: false,
          options: [
            { label: 'c', description: 'third' },
            { label: 'd', description: 'fourth' },
          ],
        },
      ],
    });
    const answered: QuestionCardState = {
      ...two,
      index: 2,
      entries: two.entries.map((entry, index) => (index === 0 ? { ...entry, ticked: [0] } : entry)),
    };
    expect(rowsOf(answered, true).slice(1)).toEqual([
      '+ 1 Head  *  → Keep (x)  *  it',
      'o 2   Also → not answered yet',
    ]);
    expect(rowsOf(answered, false).slice(1)).toEqual([
      '● 1 Head (*) → Keep (x) (*) it',
      '○ 2   Also → not answered yet',
    ]);
  });
});

describe('the current dot of the tab strip is not a key token without colour (round-1 fix)', () => {
  const request: AskUserRequest = {
    questions: [
      {
        header: 'Pick',
        question: 'Which?',
        multiSelect: false,
        options: [
          { label: 'a', description: 'first' },
          { label: 'b', description: 'second' },
        ],
      },
      {
        header: 'Also',
        question: 'And?',
        multiSelect: false,
        options: [
          { label: 'c', description: 'third' },
          { label: 'd', description: 'fourth' },
        ],
      },
    ],
  };
  const head = (state: QuestionCardState, plain: boolean): string =>
    withGlyphForm(plain, () => projectQuestionCard(state, COLUMNS).body[0]?.text ?? '');

  it('is `<o>` and `<+>` in the plain form and `[○]` and `[●]` with the Unicode form', () => {
    const state = initialQuestionCard(request);
    expect(head(state, true)).toBe('│ Pick  <o> o · Review');
    expect(head(state, false)).toBe('│ Pick  [○] ○ · Review');
    const answered: QuestionCardState = {
      ...state,
      entries: state.entries.map((entry, index) =>
        index === 0 ? { ...entry, ticked: [0] } : entry,
      ),
    };
    expect(head(answered, true)).toBe('│ Pick  <+> o · Review');
    expect(head(answered, false)).toBe('│ Pick  [●] ○ · Review');
    expect(head({ ...answered, index: 1 }, true)).toBe('│ Also  + <o> · Review');
  });

  it('the plain header holds no bracketed letter or sign that the legend would write as a key', () => {
    const state = initialQuestionCard(request);
    expect(head(state, true)).not.toMatch(/\[[a-z+]\]/u);
    const review = withGlyphForm(
      true,
      () => projectQuestionCard({ ...state, index: 2 }, COLUMNS).body[0]?.text,
    );
    expect(review).not.toMatch(/\[[a-z+]\]/u);
  });
});
