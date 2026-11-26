/**
 * What a narrow work-page row gives up, and in which order, width by width (MVP-11 unit 7, round 2; `fitRow` in `home-projection.ts`).
 * A run's row gives up its workflow's tail first (down to 12 columns), then its cost, then its age, then its id, and never the status word;
 * a session's row gives up its cost, then its age, then its title's tail, then its agent. Each ladder is the row at every width from one column
 * up, run together where the row is the same: `[from, to, row]`. A shift of one column anywhere moves an entry, and the row at the width it
 * moved at is in the failure.
 */
import { describe, expect, it } from 'vitest';

import {
  fitRow,
  ROW_NAME_COLUMNS,
  ROW_NAME_FLOOR,
  RUN_ROW_FIT,
  SESSION_ROW_FIT,
  type RowField,
  type RowFit,
} from './home-projection.js';

type Step = readonly [from: number, to: number, row: string];

/** The row at every width from 1 to `last`, the widths that draw the same row run together. */
function ladder(
  lead: string | undefined,
  fields: readonly RowField[],
  fit: RowFit,
  last: number,
): readonly Step[] {
  const steps: [number, number, string][] = [];
  for (let width = 1; width <= last; width += 1) {
    const row = fitRow(lead, fields, width, fit);
    const previous = steps.at(-1);
    if (previous?.[2] === row) previous[1] = width;
    else steps.push([width, width, row]);
  }
  return steps;
}

const runFields = (name: string | undefined, glued = false): readonly RowField[] => [
  ...(name === undefined ? [] : [{ text: name, role: 'name' as const }]),
  { text: 'failed', role: 'keep' as const },
  { text: '2h ago', role: 'age' as const, ...(glued ? { glued: true } : {}) },
  { text: '$0.12', role: 'cost' as const },
  { text: '3f9a1c2e', role: 'detail' as const },
];
const sessionFields = (title: string | undefined): readonly RowField[] => [
  ...(title === undefined ? [] : [{ text: title, role: 'name' as const }]),
  { text: '$0.12', role: 'cost' as const },
  { text: '2h ago', role: 'age' as const },
  { text: 'chatter', role: 'detail' as const },
];

describe('a run’s row: the workflow’s tail, then the cost, then the age, then the id; the status word never', () => {
  it('a short workflow, behind a glyph', () => {
    expect(ladder('✗', runFields('release'), RUN_ROW_FIT, 60)).toEqual([
      [1, 1, '✗'],
      [2, 2, '✗…'],
      [3, 3, '✗ …'],
      [4, 4, '✗ f…'],
      [5, 5, '✗ fa…'],
      [6, 6, '✗ fai…'],
      [7, 7, '✗ fail…'],
      [8, 12, '✗ failed'],
      [13, 13, '✗ r… · failed'],
      [14, 14, '✗ re… · failed'],
      [15, 15, '✗ rel… · failed'],
      [16, 16, '✗ rele… · failed'],
      [17, 17, '✗ relea… · failed'],
      [18, 28, '✗ release · failed'],
      [29, 37, '✗ release · failed · 3f9a1c2e'],
      [38, 45, '✗ release · failed · 2h ago · 3f9a1c2e'],
      [46, 60, '✗ release · failed · 2h ago · $0.12 · 3f9a1c2e'],
    ]);
  });

  it('a workflow of 13 columns, with no glyph: its tail goes down to the floor of 12 before the next field goes', () => {
    expect(ladder(undefined, runFields('release-notes'), RUN_ROW_FIT, 60)).toEqual([
      [1, 1, 'f'],
      [2, 2, 'f…'],
      [3, 3, 'fa…'],
      [4, 4, 'fai…'],
      [5, 5, 'fail…'],
      [6, 10, 'failed'],
      [11, 11, 'r… · failed'],
      [12, 12, 're… · failed'],
      [13, 13, 'rel… · failed'],
      [14, 14, 'rele… · failed'],
      [15, 15, 'relea… · failed'],
      [16, 16, 'releas… · failed'],
      [17, 17, 'release… · failed'],
      [18, 18, 'release-… · failed'],
      [19, 19, 'release-n… · failed'],
      [20, 20, 'release-no… · failed'],
      [21, 21, 'release-not… · failed'],
      [22, 31, 'release-notes · failed'],
      [32, 32, 'release-not… · failed · 3f9a1c2e'],
      [33, 40, 'release-notes · failed · 3f9a1c2e'],
      [41, 41, 'release-not… · failed · 2h ago · 3f9a1c2e'],
      [42, 48, 'release-notes · failed · 2h ago · 3f9a1c2e'],
      [49, 49, 'release-not… · failed · 2h ago · $0.12 · 3f9a1c2e'],
      [50, 60, 'release-notes · failed · 2h ago · $0.12 · 3f9a1c2e'],
    ]);
  });

  it('a glued age (`failed 2h ago`) goes as the age goes, and the separator before it with it', () => {
    expect(ladder('✗', runFields('release-notes', true), RUN_ROW_FIT, 60).slice(-7)).toEqual([
      [24, 33, '✗ release-notes · failed'],
      [34, 34, '✗ release-not… · failed · 3f9a1c2e'],
      [35, 40, '✗ release-notes · failed · 3f9a1c2e'],
      [41, 41, '✗ release-not… · failed 2h ago · 3f9a1c2e'],
      [42, 48, '✗ release-notes · failed 2h ago · 3f9a1c2e'],
      [49, 49, '✗ release-not… · failed 2h ago · $0.12 · 3f9a1c2e'],
      [50, 60, '✗ release-notes · failed 2h ago · $0.12 · 3f9a1c2e'],
    ]);
  });

  it.each([
    ['no workflow', undefined],
    ['a workflow of blanks', '   '],
  ])(
    'with %s the row is the status word and what else it has, and nothing stands in for the name',
    (_why, name) => {
      expect(ladder('✗', runFields(name), RUN_ROW_FIT, 40)).toEqual([
        [1, 1, '✗'],
        [2, 2, '✗…'],
        [3, 3, '✗ …'],
        [4, 4, '✗ f…'],
        [5, 5, '✗ fa…'],
        [6, 6, '✗ fai…'],
        [7, 7, '✗ fail…'],
        [8, 18, '✗ failed'],
        [19, 27, '✗ failed · 3f9a1c2e'],
        [28, 35, '✗ failed · 2h ago · 3f9a1c2e'],
        [36, 40, '✗ failed · 2h ago · $0.12 · 3f9a1c2e'],
      ]);
    },
  );

  it('a workflow past its 40 columns is cut to 40 however wide the row, and its id and status stay', () => {
    expect(ROW_NAME_COLUMNS).toBe(40);
    expect(ROW_NAME_FLOOR).toBe(12);
    const wide = (name: string): string =>
      fitRow(undefined, [{ text: name, role: 'name' }], 200, RUN_ROW_FIT);
    expect(wide('n'.repeat(40))).toBe('n'.repeat(40));
    expect(wide('n'.repeat(41))).toBe(`${'n'.repeat(39)}…`);
    expect(wide('n'.repeat(90))).toBe(`${'n'.repeat(39)}…`);
  });
});

describe('a session’s row: the cost, then the age, then the title’s tail, then the agent', () => {
  it('a short title behind a glyph', () => {
    const steps = ladder('›', sessionFields('Fix the login bug'), SESSION_ROW_FIT, 60);
    expect(steps.slice(0, 3)).toEqual([
      [1, 3, '›'],
      [4, 4, '› F…'],
      [5, 5, '› Fi…'],
    ]);
    expect(steps.slice(-8)).toEqual([
      [24, 24, '› Fix the log… · chatter'],
      [25, 25, '› Fix the logi… · chatter'],
      [26, 26, '› Fix the login… · chatter'],
      [27, 27, '› Fix the login … · chatter'],
      [28, 28, '› Fix the login b… · chatter'],
      [29, 37, '› Fix the login bug · chatter'],
      [38, 45, '› Fix the login bug · 2h ago · chatter'],
      [46, 60, '› Fix the login bug · $0.12 · 2h ago · chatter'],
    ]);
    expect(fitRow('›', sessionFields('Fix the login bug'), 23, SESSION_ROW_FIT)).toBe(
      '› Fix the login bug',
    );
  });

  it('a title is not bounded to 40 columns: two titles that differ at their end do not read the same on a wide row', () => {
    const title = (end: string): string => `${'t'.repeat(60)}${end}`;
    expect(fitRow('›', sessionFields(title(' part 1')), 200, SESSION_ROW_FIT)).toContain('part 1');
    expect(fitRow('›', sessionFields(title(' part 2')), 200, SESSION_ROW_FIT)).toContain('part 2');
  });

  it('no title: the agent, then the age, then the cost', () => {
    expect(ladder('›', sessionFields(undefined), SESSION_ROW_FIT, 40)).toEqual([
      [1, 8, '›'],
      [9, 17, '› chatter'],
      [18, 25, '› 2h ago · chatter'],
      [26, 40, '› $0.12 · 2h ago · chatter'],
    ]);
  });
});

describe('the width itself', () => {
  const fields: readonly RowField[] = [
    { text: 'abc', role: 'name' },
    { text: 'ok', role: 'keep' },
  ];

  it('a row exactly as wide as the room keeps every field, and one column less does not', () => {
    expect(fitRow(undefined, fields, 8)).toBe('abc · ok');
    expect(fitRow(undefined, fields, 7)).not.toBe('abc · ok');
  });

  it('a width below one is one column, a fraction is floored, and a width that is not a number is no limit', () => {
    const one: readonly RowField[] = [{ text: 'abcdef', role: 'name' }];
    expect(fitRow(undefined, one, 0)).toBe(fitRow(undefined, one, 1));
    expect(fitRow(undefined, one, -3)).toBe(fitRow(undefined, one, 1));
    expect(fitRow(undefined, one, 3.9)).toBe(fitRow(undefined, one, 3));
    expect(fitRow(undefined, one, 3.2)).toBe(fitRow(undefined, one, 3));
    expect(fitRow(undefined, one, Number.NaN)).toBe('abcdef');
    expect(fitRow(undefined, one, Number.POSITIVE_INFINITY)).toBe('abcdef');
  });

  it('a name of blanks is no name, so a row shows what else it has', () => {
    const named = (name: string): readonly RowField[] => [
      { text: name, role: 'name' },
      { text: 'failed', role: 'keep' },
    ];
    expect(fitRow(undefined, named('   '), 40)).toBe('failed');
    expect(fitRow(undefined, named('x'), 40)).toBe('x · failed');
  });
});
