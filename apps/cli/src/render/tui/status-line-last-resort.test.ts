/**
 * SE7-2 (the scoped security sitting of unit 7): a chat's status line must fit its budget whenever the words that are never cut (the mode and
 * the effort) can fit at all, and a QUALIFIED cost must never be drawn as a clean-looking amount at ANY width. Before the last-resort ladder the
 * pure model stopped at the model's 12-column floor and the provider's 2-column floor, so on a narrow terminal the line was wider than its budget
 * and the view's `truncate-end` cut it inside the cost: `$…`, `$12…`, `$1234.5…` (an amount read without the word that qualifies it). The
 * ladder (after the existing steps): the provider goes, the model is cut below its floor (to 4 columns) and then goes, a qualified cost that
 * still does not fit is the fixed word `unavailable`, and a cost that still does not fit goes last, so the never-cut words are all that is
 * left. The wording and the order of the steps above the last resort are `status-line.test.ts`'s.
 */
import { describe, expect, it } from 'vitest';

import { type ChatStatusInput, statusLine } from './status-line.js';
import { displayWidth } from './viewport.js';

const LONG_MODEL = 'claude-sonnet-4-6-extended-identifier-0123456789-abcdefghij';

const QUALIFIED_COST = {
  full: '$1234.5679 known; usage unverified',
  short: '$1234.5679 known',
  qualified: true,
} as const;
const CLEAN_COST = { full: '$1234.5679', short: '$1234.57', qualified: false } as const;

const base = (over: Partial<ChatStatusInput> = {}): ChatStatusInput => ({
  surface: 'chat',
  provider: 'anthropic',
  model: LONG_MODEL,
  mode: 'ask',
  turns: 12,
  cost: QUALIFIED_COST,
  contextPercent: 41,
  ...over,
});

/** A chat draws its status line at column 0, so its budget is the terminal's width. */
const line = (input: ChatStatusInput, columns: number) => statusLine(input, columns, 0);

const SHAPES: readonly { readonly name: string; readonly input: ChatStatusInput }[] = [
  { name: 'qualified cost, ask', input: base() },
  {
    name: 'qualified cost, accept-edits with an effort',
    input: base({ mode: 'accept-edits', effort: 'high' }),
  },
  { name: 'clean cost, ask', input: base({ cost: CLEAN_COST }) },
  {
    name: 'clean cost, auto with an effort',
    input: base({ cost: CLEAN_COST, mode: 'auto', effort: 'low' }),
  },
  { name: 'qualified cost, no provider', input: base({ provider: undefined }) },
];

/** What is never cut, written independently of the module: the mode word, then the effort after it. */
const neverCut = (input: ChatStatusInput): string =>
  input.effort === undefined ? `${input.mode} mode` : `${input.mode} mode · effort ${input.effort}`;

describe('the chat status line fits its budget whenever the words that are never cut fit (SE7-2)', () => {
  it.each(SHAPES)(
    '$name: from the width of the never-cut words up to 200 columns the line fits',
    ({ input }) => {
      const floor = displayWidth(neverCut(input));
      for (let columns = floor; columns <= 200; columns += 1) {
        const { text } = line(input, columns);
        expect(displayWidth(text), `${String(columns)} columns: ${text}`).toBeLessThanOrEqual(
          columns,
        );
      }
    },
  );

  it.each(SHAPES)(
    '$name: the mode and the effort are whole at every width, narrow or not',
    ({ input }) => {
      for (let columns = 1; columns <= 200; columns += 1) {
        const { text } = line(input, columns);
        expect(text, `${String(columns)} columns`).toContain(neverCut(input));
      }
    },
  );

  it.each(SHAPES)(
    '$name: below the never-cut words the line is exactly those words, nothing wider than them',
    ({ input }) => {
      const floor = displayWidth(neverCut(input));
      for (let columns = 1; columns < floor; columns += 1) {
        expect(line(input, columns).text, `${String(columns)} columns`).toBe(neverCut(input));
      }
    },
  );
});

describe('a qualified cost is never an amount without its qualifier, at any width (SE7-2)', () => {
  const AMOUNT = /\$\s?\d[\d,]*(?:\.\d+)?/gu;

  it.each(SHAPES.filter((shape) => shape.input.cost.qualified))(
    '$name: every amount drawn is followed by "known" and none is cut by an ellipsis, from 1 to 200 columns',
    ({ input }) => {
      for (let columns = 1; columns <= 200; columns += 1) {
        const { text } = line(input, columns);
        for (const match of text.matchAll(AMOUNT)) {
          const after = text.slice((match.index ?? 0) + match[0].length);
          expect(after.startsWith(' known'), `${String(columns)} columns: ${text}`).toBe(true);
        }
        expect(text, `${String(columns)} columns`).not.toMatch(/\$[\d.,]*…/u);
      }
    },
  );

  it.each(SHAPES)('$name: no amount is ever cut by an ellipsis, qualified or not', ({ input }) => {
    for (let columns = 1; columns <= 200; columns += 1) {
      expect(line(input, columns).text, `${String(columns)} columns`).not.toMatch(/\$[\d.,]*…/u);
    }
  });
});

describe('the last resort, one step at a time (SE7-2)', () => {
  // The model id is 59 columns wide: its 12-column cut is `claude-so…ij`.
  const input = base({
    cost: { full: '$12.34 known; usage unverified', short: '$12.34 known', qualified: true },
  });

  it('is the line the existing steps leave while that fits: provider and model at their floors, the short cost', () => {
    expect(line(input, 43)).toEqual({
      text: 'a… · claude-so…ij · ask mode · $12.34 known',
      cut: ['turns', 'context', 'cost', 'model', 'provider'],
    });
  });

  it('drops the provider first when the floors do not fit', () => {
    expect(line(input, 42).text).toBe('claude-so…ij · ask mode · $12.34 known');
    expect(line(input, 38).text).toBe('claude-so…ij · ask mode · $12.34 known');
  });

  it('cuts the model below its floor as far as the budget needs, never under 4 columns', () => {
    expect(line(input, 37).text).toBe('claude-s…ij · ask mode · $12.34 known');
    expect(line(input, 33).text).toBe('claud…j · ask mode · $12.34 known');
    expect(line(input, 30).text).toBe('cl…j · ask mode · $12.34 known');
  });

  it('drops the model when 4 columns of it still do not fit, and keeps the amount with its qualifier', () => {
    expect(line(input, 29).text).toBe('ask mode · $12.34 known');
    expect(line(input, 23).text).toBe('ask mode · $12.34 known');
  });

  it('says `unavailable` when even the short qualified cost does not fit but the word does, never a cut amount', () => {
    expect(line(input, 22).text).toBe('ask mode · unavailable');
    const wide = base();
    for (const columns of [22, 24, 26]) {
      expect(line(wide, columns).text, String(columns)).toBe('ask mode · unavailable');
    }
    expect(line(wide, 27).text).toBe('ask mode · $1234.5679 known');
    expect(line(wide, 33).text).toBe('ask mode · $1234.5679 known');
    expect(line(wide, 34).text).toBe('cl…j · ask mode · $1234.5679 known');
  });

  it('drops the cost last, so only the never-cut words are left', () => {
    expect(line(input, 21).text).toBe('ask mode');
    expect(line(input, 8).text).toBe('ask mode');
    expect(line(input, 1).text).toBe('ask mode');
    expect(line(base(), 21).text).toBe('ask mode');
  });

  it('reports what it gave up, once each, in the order it happened', () => {
    expect(line(input, 21).cut).toEqual(['turns', 'context', 'cost', 'model', 'provider']);
    expect(line(input, 42).cut).toEqual(['turns', 'context', 'cost', 'model', 'provider']);
    expect(line(input, 200).cut).toEqual([]);
  });

  it('writes an unqualified cost as its figure while it fits and drops it, never cutting it, when it does not', () => {
    const clean = base({ cost: CLEAN_COST });
    expect(line(clean, 26).text).toBe('cl…j · ask mode · $1234.57');
    expect(line(clean, 25).text).toBe('ask mode · $1234.57');
    expect(line(clean, 19).text).toBe('ask mode · $1234.57');
    expect(line(clean, 18).text).toBe('ask mode');
  });

  it('keeps an effort whole beside the mode while everything else goes', () => {
    const effort = base({ mode: 'accept-edits', effort: 'high' });
    expect(line(effort, 56).text).toBe('accept-edits mode · effort high · $1234.5679 known');
    expect(line(effort, 50).text).toBe('accept-edits mode · effort high · $1234.5679 known');
    expect(line(effort, 49).text).toBe('accept-edits mode · effort high · unavailable');
    expect(line(effort, 45).text).toBe('accept-edits mode · effort high · unavailable');
    expect(line(effort, 44).text).toBe('accept-edits mode · effort high');
    expect(line(effort, 31).text).toBe('accept-edits mode · effort high');
    expect(line(effort, 20).text).toBe('accept-edits mode · effort high');
  });
});
