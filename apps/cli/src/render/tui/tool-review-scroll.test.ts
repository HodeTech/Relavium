/**
 * How the full view moves through a review document (ADR-0134 §5). The motions are pure: a document, a cursor and the
 * geometry of a page in, a cursor out. Every fixture is built the way the engine builds one — the real line diff, then
 * the real `createReviewDocument` — so the lines a motion steps over (a skipped `=before N` copy, a changed line, a
 * target row) are the lines a person's screen is made of, not hand-forged stand-ins.
 *
 * Where a test needs a number it is a literal derived from the fixture's shape (a 30-line file has 14 + 2 + 15 listed
 * lines around its one change); where a motion has a rule (a line, a page, the last full page) a second, plain
 * computation over the listed lines checks every cursor of a fixture against it.
 */
import type { ToolPreview } from '@relavium/core';
import { describe, expect, it, vi } from 'vitest';

// The engine's own line diff. It is not part of the `@relavium/core` barrel (only the built-in tools use it), and a hand-made
// diff is exactly what a fixture here must not be, so the test reaches the one function by its path.
import { diffLines } from '../../../../../packages/core/src/tools/line-diff.js';
import {
  CARD_CONTEXT_LINES,
  CHANGE_SPAN_LINES,
  createReviewDocument,
  projectReviewPage,
  REVIEW_START,
  type ReviewCursor,
  type ReviewDocument,
} from './tool-review-projection.js';
import {
  changeJump,
  compareCursors,
  contextStartLine,
  fullOpeningCursor,
  lastPageStart,
  lineRows,
  offPageChangeLanding,
  pageDown,
  pageUp,
  scrollByLines,
  topCursor,
  type ScrollView,
} from './tool-review-scroll.js';

/**
 * How much work a motion asks of the projection and of the terminal's width function, counted rather than timed: one-line
 * projections (and the row limit each was asked for), and characters measured. Both wrap the real functions.
 */
const counted = vi.hoisted(() => ({ projections: 0, rowLimits: [] as number[], chars: 0 }));
vi.mock('./tool-review-projection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tool-review-projection.js')>();
  return {
    ...actual,
    projectReviewPage: (...args: Parameters<typeof actual.projectReviewPage>) => {
      counted.projections += 1;
      counted.rowLimits.push(args[3]);
      return actual.projectReviewPage(...args);
    },
  };
});
vi.mock('./viewport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./viewport.js')>();
  return {
    ...actual,
    displayWidth: (text: string) => {
      counted.chars += text.length;
      return actual.displayWidth(text);
    },
  };
});
const resetCount = (): void => {
  counted.projections = 0;
  counted.rowLimits.length = 0;
  counted.chars = 0;
};

/** `count` lines `line 1` … `line N`, each line of `edits` replaced by its text. */
const numbered = (count: number, edits: Readonly<Record<number, string>> = {}): string =>
  `${Array.from({ length: count }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join('\n')}\n`;

async function documentOf(
  before: string | null,
  after: string,
  options: {
    readonly target?: string;
    readonly fields?: readonly { readonly name: string; readonly value: string }[];
  } = {},
): Promise<ReviewDocument> {
  const diff = await diffLines(before, after);
  const document = createReviewDocument({
    kind: 'operation',
    ...(options.target === undefined ? {} : { target: options.target }),
    fields: options.fields ?? [],
    diff,
  });
  expect(document.valid, 'the fixture is a reviewable document').toBe(true);
  return document;
}

/** A `count`-line file with some lines replaced: context lines carry both copies, an edit is a removed + an added line. */
const edited = (
  count: number,
  edits: Readonly<Record<number, string>>,
  target: string | undefined = undefined,
): Promise<ReviewDocument> =>
  documentOf(numbered(count), numbered(count, edits), target === undefined ? {} : { target });

const changed = (...lines: number[]): Record<number, string> =>
  Object.fromEntries(lines.map((line) => [line, `LINE ${line} CHANGED`]));

const index = (document: ReviewDocument, label: string): number => {
  const found = document.lines.findIndex((line) => line.label === label);
  if (found < 0) throw new Error(`the fixture has no line ${label}`);
  return found;
};
const at = (document: ReviewDocument, label: string): ReviewCursor => ({
  line: index(document, label),
  offset: 0,
});
const labelAt = (document: ReviewDocument, cursor: ReviewCursor | undefined): string | undefined =>
  cursor === undefined ? undefined : document.lines[cursor.line]?.label;

/** The indexes of the lines the full view lists, in order. */
const listedIndexes = (document: ReviewDocument): number[] =>
  document.lines.flatMap((line, i) => (line.fullSkip === true ? [] : [i]));
/** The labels of the LISTED lines in `[from, to)`: what a person scrolls over between two cursors. */
const listedBetween = (document: ReviewDocument, from: number, to: number): string[] =>
  listedIndexes(document)
    .filter((i) => i >= from && i < to)
    .map((i) => document.lines[i]?.label ?? '');

const VIEW: ScrollView = { columns: 40, rowLimit: 8, reveal: false, numeric: false };
const viewOf = (overrides: Partial<ScrollView> = {}): ScrollView => ({ ...VIEW, ...overrides });

/** What the page the full view would draw from `cursor` says comes next. */
const nextOf = (
  document: ReviewDocument,
  cursor: ReviewCursor,
  view: ScrollView,
): ReviewCursor | undefined =>
  projectReviewPage(
    document,
    cursor,
    view.columns,
    view.rowLimit,
    view.reveal,
    view.numeric,
    false,
    true,
  ).next;
/** How many rows the deduplicated listing takes from `line` to the end of the document. */
const rowsFrom = (document: ReviewDocument, line: number, view: ScrollView): number =>
  projectReviewPage(
    document,
    { line, offset: 0 },
    view.columns,
    100_000,
    view.reveal,
    view.numeric,
    false,
    true,
  ).rows.length;

// A file with a target row and ONE change in the middle. Listed lines, in order: `target`, `=1`…`=14` (14), `-15`, `+15`,
// `=16`…`=30` (15): 32 listed lines, and the `=before N` copy of every context line sits between them, skipped.
const single = await edited(30, changed(15), 'src/a.ts');
// The same file with no target row: its line 0 is the skipped `=before 1`.
const diffOnly = await edited(30, changed(15));
// Three changes far apart (their openings are `=7`, `=27` and `=47`).
const triple = await edited(60, changed(10, 30, 50), 'src/m.ts');

describe('compareCursors', () => {
  it('orders by line first, then by offset', () => {
    expect(compareCursors({ line: 1, offset: 90 }, { line: 2, offset: 0 })).toBeLessThan(0);
    expect(compareCursors({ line: 2, offset: 0 }, { line: 1, offset: 90 })).toBeGreaterThan(0);
    expect(compareCursors({ line: 2, offset: 3 }, { line: 2, offset: 9 })).toBeLessThan(0);
    expect(compareCursors({ line: 2, offset: 9 }, { line: 2, offset: 3 })).toBeGreaterThan(0);
    expect(compareCursors({ line: 2, offset: 3 }, { line: 2, offset: 3 })).toBe(0);
  });
});

describe('topCursor', () => {
  it('is line 0 when line 0 is listed (a target row opens the document)', () => {
    expect(single.lines[0]?.label).toBe('target');
    expect(topCursor(single)).toEqual({ line: 0, offset: 0 });
  });

  it('is the first LISTED line of a diff-only document, whose line 0 is a skipped before copy', () => {
    expect(diffOnly.lines[0]).toMatchObject({ label: '=before 1', fullSkip: true });
    expect(diffOnly.lines[1]?.label).toBe('=1');
    expect(topCursor(diffOnly)).toEqual({ line: 1, offset: 0 });
  });

  it('is line 0 for a new file (nothing before the first line is skipped) and for an empty document', async () => {
    const created = await documentOf(null, 'a\nb\n');
    expect(created.lines[0]?.label).toBe('+1');
    expect(topCursor(created)).toEqual(REVIEW_START);
    const empty = await documentOf(null, '');
    expect(empty.lines).toHaveLength(0);
    expect(topCursor(empty)).toEqual(REVIEW_START);
  });
});

describe('scrollByLines', () => {
  // Over `single` at 8 rows the last full page starts on `=23` (the last 8 listed lines are `=23`…`=30`).
  it('steps over LISTED lines: one down from the target is `=1`, never the skipped copy between', () => {
    expect(single.lines[1]).toMatchObject({ label: '=before 1', fullSkip: true });
    expect(scrollByLines(single, topCursor(single), 1, VIEW)).toEqual(at(single, '=1'));
    expect(scrollByLines(single, at(single, '=1'), -1, VIEW)).toEqual({ line: 0, offset: 0 });
  });

  it('moves several lines at once, in either direction', () => {
    expect(scrollByLines(single, topCursor(single), 5, VIEW)).toEqual(at(single, '=5'));
    expect(scrollByLines(single, at(single, '=10'), -4, VIEW)).toEqual(at(single, '=6'));
    expect(scrollByLines(single, at(single, '=10'), 7, VIEW)).toEqual(at(single, '=16'));
  });

  it('counts the removed and the added line as two listed lines, in document order', () => {
    expect(labelAt(single, scrollByLines(single, at(single, '=14'), 1, VIEW))).toBe('-15');
    expect(labelAt(single, scrollByLines(single, at(single, '=14'), 2, VIEW))).toBe('+15');
    expect(labelAt(single, scrollByLines(single, at(single, '=14'), 3, VIEW))).toBe('=16');
    expect(labelAt(single, scrollByLines(single, at(single, '=16'), -1, VIEW))).toBe('+15');
    expect(labelAt(single, scrollByLines(single, at(single, '=16'), -2, VIEW))).toBe('-15');
    expect(labelAt(single, scrollByLines(single, at(single, '=16'), -3, VIEW))).toBe('=14');
  });

  it('clamps at the top: nothing is above the first listed line', () => {
    expect(scrollByLines(single, topCursor(single), -1, VIEW)).toEqual({ line: 0, offset: 0 });
    expect(scrollByLines(single, at(single, '=5'), -50, VIEW)).toEqual({ line: 0, offset: 0 });
  });

  it('clamps at the first LISTED line of a diff-only document, never on its skipped line 0', () => {
    expect(scrollByLines(diffOnly, at(diffOnly, '=5'), -50, VIEW)).toEqual({ line: 1, offset: 0 });
    expect(scrollByLines(diffOnly, at(diffOnly, '=2'), -1, VIEW)).toEqual(at(diffOnly, '=1'));
    expect(scrollByLines(diffOnly, at(diffOnly, '=1'), -1, VIEW)).toEqual(at(diffOnly, '=1'));
  });

  it('clamps going down at the start of the last full page', () => {
    expect(labelAt(single, lastPageStart(single, VIEW))).toBe('=23');
    expect(scrollByLines(single, at(single, '=20'), 100, VIEW)).toEqual(at(single, '=23'));
    expect(scrollByLines(single, at(single, '=22'), 1, VIEW)).toEqual(at(single, '=23'));
    expect(scrollByLines(single, at(single, '=22'), 2, VIEW)).toEqual(at(single, '=23'));
    expect(scrollByLines(single, at(single, '=22'), 9, VIEW)).toEqual(at(single, '=23'));
  });

  it('does not move at all from the last full page, nor from a cursor already past it', () => {
    expect(scrollByLines(single, at(single, '=23'), 1, VIEW)).toEqual(at(single, '=23'));
    expect(scrollByLines(single, at(single, '=27'), 1, VIEW)).toEqual(at(single, '=27'));
    expect(scrollByLines(single, at(single, '=27'), 100, VIEW)).toEqual(at(single, '=27'));
    // A cursor a search put partway inside a line past the limit is returned as it is, offset and all.
    const inside = { line: index(single, '=27'), offset: 5 };
    expect(scrollByLines(single, inside, 1, VIEW)).toEqual(inside);
  });

  it('is not held back going UP from past the last full page', () => {
    expect(scrollByLines(single, at(single, '=30'), -1, VIEW)).toEqual(at(single, '=29'));
    expect(scrollByLines(single, at(single, '=30'), -10, VIEW)).toEqual(at(single, '=20'));
    expect(scrollByLines(single, at(single, '=27'), -1000, VIEW)).toEqual({ line: 0, offset: 0 });
  });

  describe('a cursor inside a long line', () => {
    // `+2` is 150 characters: at 40 columns it takes five rows, and with a 4-row page it can be cut anywhere inside.
    const long = viewOf({ rowLimit: 4 });
    const stock = documentOf(null, `a\n${'x'.repeat(150)}\nc\nd\ne\n`);

    it('the first step up returns to the start of that line, not to the line before', async () => {
      const document = await stock;
      const start = document.lines[1]?.start ?? 0;
      expect(start, 'the long line starts after the first line of its field').toBe(2);
      const inside = { line: 1, offset: start + 29 };
      expect(scrollByLines(document, inside, -1, long)).toEqual({ line: 1, offset: 0 });
      expect(scrollByLines(document, inside, -2, long)).toEqual({ line: 0, offset: 0 });
      // One character past the start is already "inside"; exactly at the start (and the conventional offset 0) is not.
      expect(scrollByLines(document, { line: 1, offset: start + 1 }, -1, long)).toEqual({
        line: 1,
        offset: 0,
      });
      expect(scrollByLines(document, { line: 1, offset: start }, -1, long)).toEqual({
        line: 0,
        offset: 0,
      });
      expect(scrollByLines(document, { line: 1, offset: 0 }, -1, long)).toEqual({
        line: 0,
        offset: 0,
      });
    });

    it('the same holds on the first line of a field, whose start is 0', async () => {
      const document = await documentOf(null, `${'y'.repeat(150)}\nb\nc\n`);
      expect(scrollByLines(document, { line: 0, offset: 5 }, -1, long)).toEqual({
        line: 0,
        offset: 0,
      });
    });

    it('a step down inside the LAST line leaves the cursor where it is (there is nothing below to step onto)', async () => {
      const document = await documentOf(null, `a\n${'x'.repeat(150)}\n`);
      const start = document.lines[1]?.start ?? 0;
      const inside = { line: 1, offset: start + 29 };
      expect(lastPageStart(document, long)).toEqual({ line: 1, offset: 0 });
      for (const delta of [1, 2, 50])
        for (const view of [long, viewOf({ columns: 32, rowLimit: 100 })]) {
          expect(scrollByLines(document, inside, delta, view), `by ${delta}`).toEqual(inside);
        }
      // At the line's start there is nothing below either; going UP still works from inside it.
      expect(scrollByLines(document, { line: 1, offset: 0 }, 1, long)).toEqual({
        line: 1,
        offset: 0,
      });
      expect(scrollByLines(document, inside, -1, long)).toEqual({ line: 1, offset: 0 });
    });

    it('a step down leaves the line (the limit still applies)', async () => {
      const document = await stock;
      const start = document.lines[1]?.start ?? 0;
      // The last full page of a 4-row page over this document starts on `c`.
      expect(lastPageStart(document, long)).toEqual({ line: 2, offset: 0 });
      expect(scrollByLines(document, { line: 1, offset: start + 29 }, 1, long)).toEqual({
        line: 2,
        offset: 0,
      });
      expect(scrollByLines(document, { line: 1, offset: start + 29 }, 2, long)).toEqual({
        line: 2,
        offset: 0,
      });
    });
  });

  describe('a move up and a jump back, whatever the geometry of the page', () => {
    // A 3-row, an 8-row, a 100-row page, a width too narrow to project at all, and a numeric (code-point) one.
    const views = [
      viewOf({ rowLimit: 3 }),
      viewOf({ rowLimit: 100 }),
      viewOf({ columns: 20 }),
      viewOf({ columns: 32, numeric: true }),
    ];

    it('scrollByLines UP does not depend on it: only a move down is held at the last full page', () => {
      for (const document of [single, triple])
        for (const line of listedIndexes(document)) {
          const cursor = { line, offset: 0 };
          for (const delta of [-1, -3, -12, -100]) {
            const expected = scrollByLines(document, cursor, delta, VIEW);
            for (const view of views)
              expect(
                scrollByLines(document, cursor, delta, view),
                `from ${document.lines[line]?.label} by ${delta} at ${view.rowLimit} rows, ${view.columns} columns`,
              ).toEqual(expected);
          }
        }
    });

    it('the jump back lands on the opening of the previous change, counted in rows for THIS geometry', () => {
      for (const document of [single, triple])
        for (const view of [VIEW, ...views])
          for (const line of listedIndexes(document)) {
            const openings = document.changeStarts.map((start) =>
              contextStartLine(document, start, view),
            );
            const before = openings.filter((opening) => opening < line);
            const result = changeJump(document, { line, offset: 0 }, -1, view);
            expect(
              result,
              `from ${document.lines[line]?.label} at ${view.rowLimit} rows, ${view.columns} columns`,
            ).toEqual(before.length === 0 ? undefined : { line: Math.max(...before), offset: 0 });
          }
    });

    it('the openings really do depend on the geometry (a page too narrow to project gives no context)', () => {
      const narrow = viewOf({ columns: 20 });
      const starts = triple.changeStarts;
      expect(starts.map((start) => contextStartLine(triple, start, narrow))).toEqual(starts);
      expect(
        starts.map((start) =>
          labelAt(triple, { line: contextStartLine(triple, start, VIEW), offset: 0 }),
        ),
      ).toEqual(['=7', '=27', '=47']);
    });
  });

  describe('every cursor and delta of a fixture', () => {
    const views = [VIEW, viewOf({ rowLimit: 3 }), viewOf({ rowLimit: 100 })];
    const deltas = [...Array.from({ length: 25 }, (_, i) => i - 12), -100, 100];
    // The same file with its change two lines from the top, so a skipped copy follows the first listed line.
    const early = edited(30, changed(2), 'src/a.ts');

    it.each([
      ['a document with a target row', single],
      ['a diff-only document', diffOnly],
      ['a document with three changes', triple],
    ])('%s: the result is a listed line, never a skipped copy', (_name, document) => {
      const listed = listedIndexes(document);
      for (const view of views)
        for (const delta of deltas)
          for (const cursor of [REVIEW_START, ...listed.map((line) => ({ line, offset: 0 }))]) {
            const result = scrollByLines(document, cursor, delta, view);
            const context = `from line ${cursor.line} by ${delta} at ${view.rowLimit} rows -> ${result.line}`;
            expect(result.offset, context).toBe(0);
            if (result.line === 0 && cursor.line === 0) continue; // REVIEW_START of a diff-only document stays put
            expect(document.lines[result.line]?.fullSkip, context).not.toBe(true);
          }
    });

    it.each([
      ['a document with a target row', single],
      ['a diff-only document', diffOnly],
      ['a document with three changes', triple],
    ])(
      '%s: matches a plain step over the listed lines, and never passes the last full page going down',
      (_name, document) => {
        const listed = listedIndexes(document);
        for (const view of views) {
          // Every line of these fixtures is one row, so the last full page starts `rowLimit` listed lines from the end.
          const limit = listed[Math.max(0, listed.length - view.rowLimit)] ?? 0;
          expect(lastPageStart(document, view), `the limit at ${view.rowLimit} rows`).toEqual({
            line: limit,
            offset: 0,
          });
          for (const delta of deltas)
            for (const [position, line] of listed.entries()) {
              const target =
                listed[Math.min(listed.length - 1, Math.max(0, position + delta))] ?? line;
              const expected =
                delta > 0 ? (line >= limit ? line : Math.min(target, limit)) : target;
              const result = scrollByLines(document, { line, offset: 0 }, delta, view);
              expect(
                result,
                `from ${document.lines[line]?.label} by ${delta} at ${view.rowLimit} rows`,
              ).toEqual({ line: expected, offset: 0 });
              if (delta > 0 && line <= limit)
                expect(result.line, 'never past the last full page').toBeLessThanOrEqual(limit);
            }
        }
      },
    );

    it('a skipped copy that follows the first listed lines is never returned (change two lines from the top)', async () => {
      const document = await early;
      for (const delta of [-3, -2, -1, 1, 2, 3])
        for (const line of listedIndexes(document)) {
          const result = scrollByLines(document, { line, offset: 0 }, delta, VIEW);
          expect(document.lines[result.line]?.fullSkip).not.toBe(true);
        }
    });
  });
});

describe('lastPageStart', () => {
  it('is the line such that the rows from it to the end fill exactly one page', () => {
    const limit = lastPageStart(single, VIEW);
    expect(labelAt(single, limit)).toBe('=23');
    expect(limit.offset).toBe(0);
    expect(rowsFrom(single, limit.line, VIEW)).toBe(VIEW.rowLimit);
    // One listed line earlier would be one row too many.
    expect(rowsFrom(single, index(single, '=22'), VIEW)).toBe(VIEW.rowLimit + 1);
    expect(labelAt(triple, lastPageStart(triple, VIEW))).toBe('=53');
  });

  it('is the top of a document shorter than a page', () => {
    const roomy = viewOf({ rowLimit: 100 });
    expect(lastPageStart(single, roomy)).toEqual({ line: 0, offset: 0 });
    expect(lastPageStart(single, roomy)).toEqual(topCursor(single));
    // A diff-only document's top is its first LISTED line.
    expect(lastPageStart(diffOnly, roomy)).toEqual({ line: 1, offset: 0 });
  });

  it('is the top when the document is exactly one page, the second listed line when it is one row over', () => {
    expect(single.lines.filter((line) => line.fullSkip !== true)).toHaveLength(32);
    expect(lastPageStart(single, viewOf({ rowLimit: 32 }))).toEqual({ line: 0, offset: 0 });
    expect(labelAt(single, lastPageStart(single, viewOf({ rowLimit: 31 })))).toBe('=1');
  });

  it('is the last line when that line alone fills a page, however much longer it is', async () => {
    const page = viewOf({ columns: 32, rowLimit: 4 });
    // `+3 ` leaves 29 columns a row: 116 characters are exactly four rows, 120 and 400 are more than a page.
    for (const length of [116, 120, 400]) {
      const document = await documentOf(null, `a\nb\n${'x'.repeat(length)}\n`);
      expect(document.lines.map((line) => line.label)).toEqual(['+1', '+2', '+3']);
      expect(lastPageStart(document, page), `a ${length}-character last line`).toEqual({
        line: 2,
        offset: 0,
      });
    }
  });

  it('counts the rows a long line wraps to, at the width of the page', async () => {
    // `+3 ` leaves 29 columns a row, so 58 characters take exactly two rows.
    const document = await documentOf(null, `a\nb\n${'x'.repeat(58)}\nc\nd\n`);
    expect(document.lines.map((line) => line.label)).toEqual(['+1', '+2', '+3', '+4', '+5']);
    // 5 rows: d, c, the two rows of `+3`, then b — a is a sixth row, so the page starts on `b`.
    expect(lastPageStart(document, viewOf({ columns: 32, rowLimit: 5 }))).toEqual({
      line: 1,
      offset: 0,
    });
    // At 80 columns the long line is one row, and all five lines are one page.
    expect(lastPageStart(document, viewOf({ columns: 80, rowLimit: 5 }))).toEqual({
      line: 0,
      offset: 0,
    });
  });

  it('counts a line the way it will be drawn: code points make a non-ASCII line longer', async () => {
    // The `p` view writes a non-ASCII character as its code point, eight columns (`<U+00E9>`): `éééééééé` is three rows of
    // three characters at 32 columns (29 after `+2 `), and `a` is one row. Drawn as it is, the same line is one row.
    const document = await documentOf(null, `a\n${'é'.repeat(8)}\n`);
    const page = viewOf({ columns: 32, rowLimit: 3 });
    expect(rowsFrom(document, 1, page)).toBe(1);
    expect(rowsFrom(document, 1, { ...page, numeric: true })).toBe(3);
    // 1 + 1 rows fit a 3-row page; 1 + 3 do not, so the last full page starts on the long line.
    expect(lastPageStart(document, page)).toEqual({ line: 0, offset: 0 });
    expect(lastPageStart(document, { ...page, numeric: true })).toEqual({ line: 1, offset: 0 });
    // `界` is as wide on screen as it is in code points' eyes: two columns drawn, eight as `<U+754C>`.
    const wide = await documentOf(null, `a\n${'界'.repeat(8)}\n`);
    expect(lastPageStart(wide, { ...page, numeric: true })).toEqual({ line: 1, offset: 0 });
  });

  it('does not widen printable ASCII in the code-point view: the last page is the same', async () => {
    const document = await documentOf(null, 'a\nabcdefgh\n');
    const page = viewOf({ columns: 32, rowLimit: 3 });
    expect(lastPageStart(document, { ...page, numeric: true })).toEqual(
      lastPageStart(document, page),
    );
    expect(lastPageStart(document, { ...page, numeric: true })).toEqual({ line: 0, offset: 0 });
  });

  it('counts a line the way it will be drawn: a revealed mask is as long as the secret, a hidden one a token', async () => {
    // The key is masked to a 20-column token while hidden (one row); revealed it is 64 characters (two rows at 40 columns).
    const secret = `const k = "sk-proj-${'abcdefghij'.repeat(4)}";`;
    const document = await documentOf(null, `a\n${secret}\nc\n`);
    expect(document.masks.length, 'the secret is masked').toBeGreaterThan(0);
    expect(lastPageStart(document, viewOf({ rowLimit: 3 }))).toEqual({ line: 0, offset: 0 });
    expect(lastPageStart(document, viewOf({ rowLimit: 3, reveal: true }))).toEqual({
      line: 1,
      offset: 0,
    });
  });

  it('treats a line whose projection gives up as a full page', () => {
    // 20 columns is below the floor the projection accepts: no line can be projected, so every line is "a page".
    expect(labelAt(single, lastPageStart(single, viewOf({ columns: 20 })))).toBe('=30');
  });

  it('is the start for an empty document', async () => {
    expect(lastPageStart(await documentOf(null, ''), VIEW)).toEqual(REVIEW_START);
  });
});

describe('pageDown', () => {
  it('returns the page cut when it is at or before the last full page', () => {
    const next = nextOf(single, topCursor(single), VIEW);
    expect(labelAt(single, next)).toBe('=8');
    expect(pageDown(single, topCursor(single), next, VIEW)).toEqual(at(single, '=8'));
    // Exactly the last full page is still "at or before".
    expect(pageDown(single, at(single, '=14'), at(single, '=23'), VIEW)).toEqual(at(single, '=23'));
  });

  it('clamps to the last full page when the cut is beyond it', () => {
    const cursor = at(single, '=18');
    const next = nextOf(single, cursor, VIEW);
    expect(labelAt(single, next), 'the page after =18 would start on =26').toBe('=26');
    expect(pageDown(single, cursor, next, VIEW)).toEqual(at(single, '=23'));
  });

  it('is undefined at the end: the page reaches it', () => {
    expect(nextOf(single, at(single, '=23'), VIEW)).toBeUndefined();
    expect(pageDown(single, at(single, '=23'), undefined, VIEW)).toBeUndefined();
    expect(pageDown(single, at(single, '=25'), undefined, VIEW)).toBeUndefined();
  });

  it('is undefined when the cursor is already on the last full page, whatever the cut says', () => {
    expect(pageDown(single, at(single, '=23'), at(single, '=26'), VIEW)).toBeUndefined();
    expect(pageDown(single, at(single, '=24'), at(single, '=26'), VIEW)).toBeUndefined();
    // One line above it, the same cut is clamped to the last full page.
    expect(pageDown(single, at(single, '=22'), at(single, '=26'), VIEW)).toEqual(at(single, '=23'));
  });

  it('carries on inside a long line: the cut is the next page, offset and all', async () => {
    const view = viewOf({ columns: 32, rowLimit: 4 });
    // 150 characters at 29 a row: the first page is `a` and the first three rows of `+2`.
    const document = await documentOf(null, `a\n${'x'.repeat(150)}\nc\n`);
    const start = document.lines[1]?.start ?? 0;
    const next = nextOf(document, REVIEW_START, view);
    expect(next).toEqual({ line: 1, offset: start + 3 * 29 });
    expect(pageDown(document, REVIEW_START, next, view)).toEqual({
      line: 1,
      offset: start + 3 * 29,
    });
    // And the page after that reaches the end: nothing left to page to.
    expect(nextOf(document, next ?? REVIEW_START, view)).toBeUndefined();
    expect(pageDown(document, next ?? REVIEW_START, undefined, view)).toBeUndefined();
  });

  describe('a last line longer than a page', () => {
    // `+3` is ten rows of 29 characters at 32 columns, and the page is four rows: the last full page is that one line.
    const view = viewOf({ columns: 32, rowLimit: 4 });
    const stock = documentOf(null, `a\nb\n${'x'.repeat(290)}\n`);

    it('is its own last full page, and the first page ends two rows into it', async () => {
      const document = await stock;
      expect(lastPageStart(document, view)).toEqual({ line: 2, offset: 0 });
      const start = document.lines[2]?.start ?? 0;
      expect(nextOf(document, REVIEW_START, view)).toEqual({ line: 2, offset: start + 2 * 29 });
    });

    it('PgDn walks through every page of it, each step landing on that page cut, until the end', async () => {
      const document = await stock;
      const start = document.lines[2]?.start ?? 0;
      const visited: ReviewCursor[] = [];
      let cursor: ReviewCursor = REVIEW_START;
      for (let guard = 0; guard < 20; guard++) {
        const cut = nextOf(document, cursor, view);
        const moved = pageDown(document, cursor, cut, view);
        // Each step is exactly the page's own cut: nothing is skipped and nothing is clamped back.
        expect(moved, `from ${JSON.stringify(cursor)}`).toEqual(cut);
        if (moved === undefined) break;
        visited.push(moved);
        cursor = moved;
      }
      // Page 1 is `a`, `b` and two rows of the line; then four rows twice: rows 2–5 and 6–9 reach the end.
      expect(visited).toEqual([
        { line: 2, offset: start + 2 * 29 },
        { line: 2, offset: start + 6 * 29 },
      ]);
      expect(cursor).toEqual({ line: 2, offset: start + 6 * 29 });
    });

    it('takes a cut inside the first line of the last full page, from above it and from its own start', async () => {
      const document = await stock;
      const start = document.lines[2]?.start ?? 0;
      const cut = { line: 2, offset: start + 4 * 29 };
      // The cut is past the limit's offset (`{2, 0}`) but not past its LINE.
      expect(pageDown(document, { line: 0, offset: 0 }, cut, view)).toEqual(cut);
      expect(pageDown(document, { line: 2, offset: 0 }, cut, view)).toEqual(cut);
      expect(pageDown(document, { line: 2, offset: start + 29 }, cut, view)).toEqual(cut);
    });

    it('still clamps a cut on a line beyond the last full page, and stops from on or after it', async () => {
      // `a`, a four-row line, `d`, `e`: the four-row line plus `d` and `e` overflow a 4-row page, so it starts on `d`.
      const document = await documentOf(null, `a\n${'x'.repeat(116)}\nd\ne\n`);
      const limit = lastPageStart(document, view);
      expect(limit).toEqual({ line: 2, offset: 0 });
      const top = { line: 0, offset: 0 };
      const beyond = { line: 3, offset: 0 };
      expect(pageDown(document, top, beyond, view)).toEqual(limit);
      expect(pageDown(document, { line: 1, offset: 0 }, beyond, view)).toEqual(limit);
      expect(pageDown(document, limit, beyond, view)).toBeUndefined();
      expect(pageDown(document, beyond, beyond, view)).toBeUndefined();
      // A cut on the limit's own line, or inside a line above it, is taken as it is.
      expect(pageDown(document, top, limit, view)).toEqual(limit);
      const inside = { line: 1, offset: (document.lines[1]?.start ?? 0) + 87 };
      expect(pageDown(document, top, inside, view)).toEqual(inside);
    });
  });

  it('matches the plain rule for every cursor: the cut, clamped, never past the end', () => {
    const listed = listedIndexes(single);
    const limitPosition = listed.length - VIEW.rowLimit;
    for (const [position, line] of listed.entries()) {
      const cursor = { line, offset: 0 };
      const next = nextOf(single, cursor, VIEW);
      // One row a line: the next page starts `rowLimit` listed lines on, if there are that many.
      const cut = listed[position + VIEW.rowLimit];
      expect(next, `the cut from ${single.lines[line]?.label}`).toEqual(
        cut === undefined ? undefined : { line: cut, offset: 0 },
      );
      let expected: ReviewCursor | undefined;
      if (cut === undefined) expected = undefined;
      else if (position + VIEW.rowLimit <= limitPosition) expected = { line: cut, offset: 0 };
      else expected = position >= limitPosition ? undefined : at(single, '=23');
      expect(pageDown(single, cursor, next, VIEW), `from ${single.lines[line]?.label}`).toEqual(
        expected,
      );
    }
  });
});

describe('pageUp', () => {
  it('goes up about a page: as many listed lines as fill the page', () => {
    expect(pageUp(single, at(single, '=20'), VIEW)).toEqual(at(single, '=13'));
    // Across the change and past skipped copies: +15, -15, =14, =13, =12, =11, =10, =9.
    expect(pageUp(single, at(single, '=16'), VIEW)).toEqual(at(single, '=9'));
    expect(pageUp(single, at(single, '=30'), VIEW)).toEqual(at(single, '=22'));
  });

  it('stops at the top rather than overshooting it', () => {
    expect(pageUp(single, at(single, '=3'), VIEW)).toEqual({ line: 0, offset: 0 });
    expect(pageUp(single, at(single, '=1'), VIEW)).toEqual({ line: 0, offset: 0 });
    expect(pageUp(diffOnly, at(diffOnly, '=3'), VIEW)).toEqual(at(diffOnly, '=1'));
  });

  it('is undefined at the top', () => {
    expect(pageUp(single, topCursor(single), VIEW)).toBeUndefined();
    expect(pageUp(single, REVIEW_START, VIEW)).toBeUndefined();
    expect(pageUp(diffOnly, topCursor(diffOnly), VIEW)).toBeUndefined();
    // The skipped line 0 of a diff-only document is above its top: nothing is up from it either.
    expect(pageUp(diffOnly, REVIEW_START, VIEW)).toBeUndefined();
  });

  it('always moves at least one listed line', () => {
    expect(pageUp(single, at(single, '=20'), viewOf({ rowLimit: 1 }))).toEqual(at(single, '=19'));
    // The line above is a long one that fills the whole page: it is still the line the page goes up to.
    return documentOf(null, `a\n${'x'.repeat(300)}\nc\n`).then((document) => {
      const view = viewOf({ columns: 32, rowLimit: 4 });
      expect(pageUp(document, { line: 2, offset: 0 }, view)).toEqual({ line: 1, offset: 0 });
    });
  });

  it('counts the rows a long line wraps to', async () => {
    // a b c, a two-row line, d, e. A 4-row page up from e is d + the long line + c (1 + 2 + 1), not d, long, c, b.
    const document = await documentOf(null, `a\nb\nc\n${'x'.repeat(58)}\nd\ne\n`);
    expect(document.lines.map((line) => line.label)).toEqual(['+1', '+2', '+3', '+4', '+5', '+6']);
    // `+4` is the two-row line (`+4 ` leaves 29 columns).
    expect(pageUp(document, at(document, '+6'), viewOf({ columns: 32, rowLimit: 4 }))).toEqual(
      at(document, '+3'),
    );
  });

  it('does not take a line that would overflow the page', async () => {
    const document = await documentOf(null, `a\nb\nc\n${'x'.repeat(58)}\nd\ne\n`);
    // d is one row; the two-row line would make three, over a 2-row page: the page goes up to d only.
    expect(pageUp(document, at(document, '+6'), viewOf({ columns: 32, rowLimit: 2 }))).toEqual(
      at(document, '+5'),
    );
  });

  it('returns to the start of the current line first when the cursor is inside a long one', async () => {
    const view = viewOf({ columns: 32, rowLimit: 4 });
    const document = await documentOf(null, `a\n${'x'.repeat(150)}\nc\n`);
    const start = document.lines[1]?.start ?? 0;
    expect(pageUp(document, { line: 1, offset: start + 29 }, view)).toEqual({
      line: 1,
      offset: 0,
    });
    expect(pageUp(document, { line: 1, offset: start + 1 }, view)).toEqual({ line: 1, offset: 0 });
    // From the start of that line (or the conventional offset 0) the page goes up to the line above.
    expect(pageUp(document, { line: 1, offset: start }, view)).toEqual({ line: 0, offset: 0 });
    expect(pageUp(document, { line: 1, offset: 0 }, view)).toEqual({ line: 0, offset: 0 });
    // Inside the first line of a field (start 0) the cursor is still not at the top.
    const first = await documentOf(null, `${'y'.repeat(150)}\nb\n`);
    expect(pageUp(first, { line: 0, offset: 40 }, view)).toEqual({ line: 0, offset: 0 });
  });

  it('matches the plain rule for every cursor: a page of listed lines up, to the top at most', () => {
    const listed = listedIndexes(single);
    for (const [position, line] of listed.entries()) {
      const result = pageUp(single, { line, offset: 0 }, VIEW);
      if (position === 0) {
        expect(result, 'nothing is above the top').toBeUndefined();
        continue;
      }
      expect(result, `from ${single.lines[line]?.label}`).toEqual({
        line: listed[Math.max(0, position - VIEW.rowLimit)],
        offset: 0,
      });
      expect(single.lines[result?.line ?? 0]?.fullSkip).not.toBe(true);
    }
  });
});

describe('contextStartLine', () => {
  it('opens up to three LISTED context lines above the change', () => {
    const start = contextStartLine(single, index(single, '-15'));
    expect(listedBetween(single, start, index(single, '-15'))).toEqual(['=12', '=13', '=14']);
    expect(labelAt(single, { line: start, offset: 0 })).toBe('=12');
  });

  it('does not count the skipped before copies between them (they are not rows)', () => {
    // Between =12 and the change sit five lines of the document, three of them listed.
    const change = index(single, '-15');
    const start = contextStartLine(single, change);
    expect(change - start).toBe(5);
    expect(listedBetween(single, start, change)).toHaveLength(3);
  });

  it('stops at a changed line', async () => {
    const document = await edited(40, changed(15, 18), 'src/a.ts');
    const start = contextStartLine(document, index(document, '-18'));
    expect(listedBetween(document, start, index(document, '-18'))).toEqual(['=16', '=17']);
    expect(start, 'the added line above is not crossed').toBeGreaterThan(index(document, '+15'));
  });

  it('stops at the target row and at field rows, which are not context', async () => {
    const withTarget = await edited(20, changed(2), 'src/a.ts');
    const second = contextStartLine(withTarget, index(withTarget, '-2'));
    expect(listedBetween(withTarget, second, index(withTarget, '-2'))).toEqual(['=1']);
    expect(second, 'the target row is not crossed').toBeGreaterThan(0);

    const withFields = await documentOf(numbered(20), numbered(20, changed(3)), {
      target: 'src/a.ts',
      fields: [{ name: 'mode', value: 'overwrite' }],
    });
    const third = contextStartLine(withFields, index(withFields, '-3'));
    expect(listedBetween(withFields, third, index(withFields, '-3'))).toEqual(['=1', '=2']);
    expect(third, 'the field rows are not crossed').toBeGreaterThan(
      index(withFields, 'field value'),
    );
  });

  it('never goes below line 0', async () => {
    // A change on the first line, and a change two lines in, of a diff-only document.
    const first = await edited(20, changed(1));
    expect(contextStartLine(first, index(first, '-1'))).toBe(0);
    const second = await edited(20, changed(2));
    const start = contextStartLine(second, index(second, '-2'));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(listedBetween(second, start, index(second, '-2'))).toEqual(['=1']);
    // A new file: every line is a change, there is no context to go up for.
    const created = await documentOf(null, 'a\nb\nc\n');
    expect(contextStartLine(created, 2)).toBe(2);
    expect(contextStartLine(created, 0)).toBe(0);
  });
});

describe('fullOpeningCursor', () => {
  it('opens on the first change with three listed context lines above it, as the card does', () => {
    const cursor = fullOpeningCursor(single, { targetShortened: false });
    expect(cursor.offset).toBe(0);
    expect(listedBetween(single, cursor.line, index(single, '-15'))).toEqual(['=12', '=13', '=14']);
    expect(fullOpeningCursor(diffOnly, { targetShortened: false }).line).toBe(
      index(diffOnly, '=12'),
    );
  });

  it('opens on the top when the card had to shorten the target (the target is read first)', () => {
    expect(fullOpeningCursor(single, { targetShortened: true })).toEqual({ line: 0, offset: 0 });
    expect(fullOpeningCursor(diffOnly, { targetShortened: true })).toEqual({ line: 1, offset: 0 });
  });

  it('opens on the top when field rows precede the diff (they are the call identity)', async () => {
    const fields = [{ name: 'mode', value: 'overwrite' }];
    const withTarget = await documentOf(numbered(30), numbered(30, changed(15)), {
      target: 'src/a.ts',
      fields,
    });
    expect(withTarget.lines.slice(0, 3).map((line) => line.label)).toEqual([
      'target',
      'field name',
      'field value',
    ]);
    expect(fullOpeningCursor(withTarget, { targetShortened: false })).toEqual({
      line: 0,
      offset: 0,
    });
    // Without a target the first line is the field row.
    const noTarget = await documentOf(numbered(30), numbered(30, changed(15)), { fields });
    expect(noTarget.lines[0]?.label).toBe('field name');
    expect(fullOpeningCursor(noTarget, { targetShortened: false })).toEqual({
      line: 0,
      offset: 0,
    });
  });

  it('opens on the top when there is no change', async () => {
    const same = await edited(10, {}, 'src/a.ts');
    expect(same.firstChangedLine).toBeUndefined();
    expect(fullOpeningCursor(same, { targetShortened: false })).toEqual({ line: 0, offset: 0 });
    const sameDiffOnly = await edited(10, {});
    expect(fullOpeningCursor(sameDiffOnly, { targetShortened: false })).toEqual({
      line: 1,
      offset: 0,
    });
  });

  it('is never negative when the first change is within the first three lines', async () => {
    for (const edits of [changed(1), changed(2), changed(3)])
      for (const target of ['src/a.ts', undefined]) {
        const document = await edited(20, edits, target);
        const cursor = fullOpeningCursor(document, { targetShortened: false });
        expect(cursor.line).toBeGreaterThanOrEqual(0);
        expect(cursor.offset).toBe(0);
        // Whatever precedes the change within three lines is on the page: no listed context line is left out.
        const first = document.firstChangedLine ?? 0;
        const above = Number(Object.keys(edits)[0]) - 1;
        expect(
          listedBetween(document, cursor.line, first).filter((l) => l.startsWith('=')),
        ).toEqual(Array.from({ length: above }, (_, i) => `=${i + 1}`));
      }
  });
});

describe('changeJump', () => {
  const opening = (document: ReviewDocument, label: string): ReviewCursor => at(document, label);

  it('goes to the next change: its opening, three context lines above it', () => {
    const top = topCursor(triple);
    expect(changeJump(triple, top, 1, VIEW)).toEqual(opening(triple, '=7'));
    expect(changeJump(triple, at(triple, '=7'), 1, VIEW)).toEqual(opening(triple, '=27'));
    expect(changeJump(triple, at(triple, '=27'), 1, VIEW)).toEqual(opening(triple, '=47'));
    // From anywhere between, the nearest one after it.
    expect(changeJump(triple, at(triple, '=20'), 1, VIEW)).toEqual(opening(triple, '=27'));
  });

  it('goes to the previous change', () => {
    expect(changeJump(triple, at(triple, '=47'), -1, VIEW)).toEqual(opening(triple, '=27'));
    expect(changeJump(triple, at(triple, '=27'), -1, VIEW)).toEqual(opening(triple, '=7'));
    expect(changeJump(triple, at(triple, '=40'), -1, VIEW)).toEqual(opening(triple, '=27'));
    // From inside a change (on its added line) the previous stop is the opening of THAT change.
    expect(changeJump(triple, at(triple, '+30'), -1, VIEW)).toEqual(opening(triple, '=27'));
    expect(changeJump(triple, at(triple, '+30'), 1, VIEW)).toEqual(opening(triple, '=47'));
  });

  it('is undefined at the ends', () => {
    expect(changeJump(triple, at(triple, '=47'), 1, VIEW)).toBeUndefined();
    expect(changeJump(triple, at(triple, '=55'), 1, VIEW)).toBeUndefined();
    expect(changeJump(triple, at(triple, '=7'), -1, VIEW)).toBeUndefined();
    expect(changeJump(triple, topCursor(triple), -1, VIEW)).toBeUndefined();
  });

  it('is undefined in a document with no change, in both directions', async () => {
    const same = await edited(30, {}, 'src/a.ts');
    expect(changeJump(same, topCursor(same), 1, VIEW)).toBeUndefined();
    expect(changeJump(same, at(same, '=20'), -1, VIEW)).toBeUndefined();
  });

  it('is strictly after: repeated jumps visit every change once, in order, and stop', () => {
    const visited: string[] = [];
    let cursor: ReviewCursor | undefined = topCursor(triple);
    for (let guard = 0; guard < 10; guard++) {
      cursor = changeJump(triple, cursor, 1, VIEW);
      if (cursor === undefined) break;
      visited.push(labelAt(triple, cursor) ?? '');
    }
    expect(visited).toEqual(['=7', '=27', '=47']);

    const back: string[] = [];
    cursor = lastPageStart(triple, VIEW);
    for (let guard = 0; guard < 10; guard++) {
      cursor = changeJump(triple, cursor, -1, VIEW);
      if (cursor === undefined) break;
      back.push(labelAt(triple, cursor) ?? '');
    }
    expect(back).toEqual(['=47', '=27', '=7']);
  });

  describe('a change near the end of the document', () => {
    // The one change is line 58 of 60: its opening is `=55`, but the last full page of eight listed lines starts on `=54`.
    const near = edited(60, changed(58), 'src/n.ts');

    it('lands on the last full page rather than past it', async () => {
      const document = await near;
      expect(labelAt(document, lastPageStart(document, VIEW))).toBe('=54');
      expect(changeJump(document, topCursor(document), 1, VIEW)).toEqual(at(document, '=54'));
      expect(changeJump(document, at(document, '=40'), 1, VIEW)).toEqual(at(document, '=54'));
    });

    it('is undefined when the only change left is already on the last full page', async () => {
      const document = await near;
      expect(changeJump(document, at(document, '=54'), 1, VIEW)).toBeUndefined();
      // Past the limit, and on the opening itself: the change is on the page, there is nowhere to go.
      expect(changeJump(document, at(document, '=55'), 1, VIEW)).toBeUndefined();
      expect(changeJump(document, at(document, '-58'), 1, VIEW)).toBeUndefined();
    });

    it('still goes back to the change from below it', async () => {
      const document = await near;
      expect(changeJump(document, at(document, '=60'), -1, VIEW)).toEqual(at(document, '=55'));
      expect(changeJump(document, at(document, '=54'), -1, VIEW)).toBeUndefined();
    });
  });

  describe('changes close together are one stop', () => {
    // Changed lines 10 and 10 + gap + 1: `gap` unchanged lines between them.
    it('six listed lines between two changes are ONE stop', async () => {
      const document = await edited(60, changed(10, 17), 'src/g.ts');
      expect(listedBetween(document, index(document, '+10') + 1, index(document, '-17'))).toEqual([
        '=11',
        '=12',
        '=13',
        '=14',
        '=15',
        '=16',
      ]);
      expect(changeJump(document, topCursor(document), 1, VIEW)).toEqual(at(document, '=7'));
      expect(changeJump(document, at(document, '=7'), 1, VIEW)).toBeUndefined();
      // And back: the one stop, then nothing before it.
      expect(changeJump(document, at(document, '=40'), -1, VIEW)).toEqual(at(document, '=7'));
    });

    it('seven listed lines between them are TWO stops', async () => {
      const document = await edited(60, changed(10, 18), 'src/g.ts');
      expect(listedBetween(document, index(document, '+10') + 1, index(document, '-18'))).toEqual([
        '=11',
        '=12',
        '=13',
        '=14',
        '=15',
        '=16',
        '=17',
      ]);
      expect(changeJump(document, topCursor(document), 1, VIEW)).toEqual(at(document, '=7'));
      expect(changeJump(document, at(document, '=7'), 1, VIEW)).toEqual(at(document, '=15'));
      expect(changeJump(document, at(document, '=15'), 1, VIEW)).toBeUndefined();
      expect(changeJump(document, at(document, '=40'), -1, VIEW)).toEqual(at(document, '=15'));
      expect(changeJump(document, at(document, '=15'), -1, VIEW)).toEqual(at(document, '=7'));
    });

    it('a run of changed lines is one stop', async () => {
      const document = await edited(60, changed(20, 21, 22), 'src/g.ts');
      expect(changeJump(document, topCursor(document), 1, VIEW)).toEqual(at(document, '=17'));
      expect(changeJump(document, at(document, '=17'), 1, VIEW)).toBeUndefined();
    });
  });

  describe(`a chain of edits is split into changes of at most ${CHANGE_SPAN_LINES} listed lines`, () => {
    // Edits every 6th line: five unchanged lines between them, inside the gap rule, so only the span bound splits them.
    const chain = edited(
      120,
      changed(...Array.from({ length: 20 }, (_, i) => (i + 1) * 6)),
      'src/s.ts',
    );

    it('has several stops, each change spanning no more than the bound', async () => {
      const document = await chain;
      const labels = document.changeStarts.map((line) => document.lines[line]?.label);
      expect(labels).toEqual(['-6', '-42', '-78', '-114']);
      const listed = listedIndexes(document);
      for (const [at, start] of document.changeStarts.entries()) {
        const next = document.changeStarts[at + 1] ?? document.lines.length;
        const last = Math.max(
          ...listed.filter((line) => line < next && document.lines[line]?.changed === true),
        );
        expect(
          listed.filter((line) => line > start && line <= last).length,
          `the change opened by ${labels[at]}`,
        ).toBeLessThanOrEqual(CHANGE_SPAN_LINES);
      }
    });

    it('repeated forward jumps visit every stop once, in order, then stop', async () => {
      const document = await chain;
      const visited: ReviewCursor[] = [];
      let cursor: ReviewCursor | undefined = topCursor(document);
      for (let guard = 0; guard < 20; guard++) {
        cursor = changeJump(document, cursor, 1, VIEW);
        if (cursor === undefined) break;
        visited.push(cursor);
      }
      // The opening of each change: three unchanged lines above its first line.
      expect(visited.map((at) => labelAt(document, at))).toEqual(['=3', '=39', '=75', '=111']);
      for (const [at, stop] of visited.entries())
        expect(stop.line, 'strictly after the one before').toBeGreaterThan(
          visited[at - 1]?.line ?? -1,
        );
      expect(changeJump(document, visited.at(-1) ?? REVIEW_START, 1, VIEW)).toBeUndefined();
    });

    it('repeated backward jumps from the last full page visit them in the other order', async () => {
      const document = await chain;
      const back: (string | undefined)[] = [];
      let cursor: ReviewCursor | undefined = lastPageStart(document, VIEW);
      for (let guard = 0; guard < 20; guard++) {
        cursor = changeJump(document, cursor, -1, VIEW);
        if (cursor === undefined) break;
        back.push(labelAt(document, cursor));
      }
      expect(back).toEqual(['=111', '=75', '=39', '=3']);
    });
  });

  it('only moves to a stop strictly on the right side of the cursor, for every cursor', () => {
    const openings = ['=7', '=27', '=47'].map((label) => index(triple, label));
    for (const line of listedIndexes(triple)) {
      const cursor = { line, offset: 0 };
      const forward = changeJump(triple, cursor, 1, VIEW);
      const next = openings.find((stop) => stop > line);
      expect(forward?.line, `forward from ${triple.lines[line]?.label}`).toBe(next);
      const backward = changeJump(triple, cursor, -1, VIEW);
      const previous = [...openings].reverse().find((stop) => stop < line);
      expect(backward?.line, `backward from ${triple.lines[line]?.label}`).toBe(previous);
    }
  });
});

// The cursor a person lands on is the cursor the next arrow key moves from: it must be a LISTED line, or the first press
// of an arrow key moves the cursor from a skipped copy to the line drawn right after it and the screen does not change.
describe('a cursor the opening and the jumps produce is on a listed line', () => {
  // A change two lines from the top has only ONE listed context line above it: the copy before that line is skipped.
  const cases: readonly [string, string | undefined][] = [
    ['a document with a target row', 'src/a.ts'],
    ['a diff-only document', undefined],
  ];
  const draw = (document: ReviewDocument, cursor: ReviewCursor): readonly string[] =>
    projectReviewPage(document, cursor, VIEW.columns, VIEW.rowLimit, false, false, false, true)
      .rows;

  it.each(cases)('%s: the cursor the full view opens on', async (_name, target) => {
    const document = await edited(30, changed(2), target);
    const opening = fullOpeningCursor(document, { targetShortened: false });
    expect(document.lines[opening.line]?.fullSkip).not.toBe(true);
  });

  it.each(cases)('%s: the cursor of the jump to the first change', async (_name, target) => {
    const document = await edited(30, changed(2), target);
    const jump = changeJump(document, topCursor(document), 1, VIEW);
    // From the top the change is already on the page the top draws, so a jump either stays or lands on a listed line.
    if (jump !== undefined) expect(document.lines[jump.line]?.fullSkip).not.toBe(true);
  });

  it.each(cases)(
    '%s: the first arrow key down after the opening moves the screen',
    async (_name, target) => {
      const document = await edited(30, changed(2), target);
      const opening = fullOpeningCursor(document, { targetShortened: false });
      const down = scrollByLines(document, opening, 1, VIEW);
      expect(draw(document, down)).not.toEqual(draw(document, opening));
    },
  );
});

// With a view the context above a change is counted in ROWS as well as lines: prose and Markdown lines wrap, and three
// context lines of six rows would fill a whole screen and leave the change off the page it opens. The context may take at
// most `max(3, floor(rowLimit / 3))` rows (and 3 lines); without a view it is the three lines it always was.
describe('the context above a change, counted in rows', () => {
  /** Lines `L1 …` of `rows` rows each at 32 columns (`=N ` leaves 29 cells); the last line is edited to one short line. */
  const prose = (count: number, rows: number, target: string | undefined = 'src/p.md') => {
    const text = (n: number): string => `L${n}${'w'.repeat(29 * (rows - 1) + 3)}`;
    const before = `${Array.from({ length: count }, (_, i) => text(i + 1)).join('\n')}\n`;
    const after = `${Array.from({ length: count }, (_, i) => (i + 1 === count ? 'NEW' : text(i + 1))).join('\n')}\n`;
    return documentOf(before, after, target === undefined ? {} : { target });
  };
  const geometry = (rowLimit: number): ScrollView => ({
    columns: 32,
    rowLimit,
    reveal: false,
    numeric: false,
  });
  /** The listed context lines `contextStartLine` puts above the last change, as labels. */
  const context = (document: ReviewDocument, view?: ScrollView): string[] => {
    const change = document.firstChangedLine ?? 0;
    return listedBetween(document, contextStartLine(document, change, view), change);
  };

  it('the fixtures wrap to the rows they say', async () => {
    for (const rows of [1, 2, 3, 6]) {
      const document = await prose(9, rows);
      expect(lineRows(document, index(document, '=8'), geometry(14)), `${rows} rows`).toBe(rows);
    }
  });

  it('one-row lines keep three context lines when the budget allows it', async () => {
    const document = await prose(9, 1);
    // rowLimit 14 gives a budget of 4 rows, 24 gives 8: either way the three-line cap is what stops the context.
    expect(context(document, geometry(14))).toEqual(['=6', '=7', '=8']);
    expect(context(document, geometry(24))).toEqual(['=6', '=7', '=8']);
  });

  it('two-row lines keep two lines of a 4-row budget, and three of an 8-row one', async () => {
    const document = await prose(9, 2);
    expect(context(document, geometry(14))).toEqual(['=7', '=8']);
    expect(context(document, geometry(24))).toEqual(['=6', '=7', '=8']);
  });

  it('three-row lines keep two lines of an 8-row budget', async () => {
    const document = await prose(9, 3);
    expect(context(document, geometry(24))).toEqual(['=7', '=8']);
  });

  it('six-row lines keep no context in a 4-row budget: the change line is the opening', async () => {
    const document = await prose(9, 6);
    const change = index(document, '-9');
    expect(contextStartLine(document, change, geometry(14))).toBe(change);
    expect(context(document, geometry(14))).toEqual([]);
    // An 8-row budget takes one six-row line, not two.
    expect(context(document, geometry(24))).toEqual(['=8']);
  });

  it('a small page still gets a budget of three rows', async () => {
    const one = await prose(9, 1);
    const two = await prose(9, 2);
    for (const rowLimit of [3, 4, 5, 8]) {
      expect(context(one, geometry(rowLimit)), `1-row lines, ${rowLimit} rows`).toEqual([
        '=6',
        '=7',
        '=8',
      ]);
      expect(context(two, geometry(rowLimit)), `2-row lines, ${rowLimit} rows`).toEqual(['=8']);
    }
    // Twelve rows is the first page whose third is a fourth row.
    expect(context(two, geometry(12))).toEqual(['=7', '=8']);
  });

  it('without a view the context is three lines however many rows they take', async () => {
    for (const rows of [1, 2, 6]) {
      const document = await prose(9, rows);
      const change = index(document, '-9');
      expect(
        listedBetween(document, contextStartLine(document, change), change),
        `${rows} rows`,
      ).toEqual(['=6', '=7', '=8']);
    }
  });

  it('never lands on a copy the full view does not list, whichever rule stopped the walk', async () => {
    // Two-row lines stop at the row budget right after passing a skipped copy; a change on line 3 stops at the target row.
    const rowsStop = await prose(9, 2);
    const rowsStart = contextStartLine(rowsStop, index(rowsStop, '-9'), geometry(14));
    expect(rowsStop.lines[rowsStart]?.fullSkip).not.toBe(true);
    expect(rowsStop.lines[rowsStart]?.label).toBe('=7');
    const early = await prose(3, 1);
    for (const view of [geometry(14), geometry(3), undefined]) {
      const start = contextStartLine(early, index(early, '-3'), view);
      expect(early.lines[start]?.fullSkip, `${view?.rowLimit} rows`).not.toBe(true);
      expect(listedBetween(early, start, index(early, '-3'))).toEqual(['=1', '=2']);
    }
  });

  describe('the opening page contains the first changed row', () => {
    const draw = (document: ReviewDocument, cursor: ReviewCursor, rowLimit: number) =>
      projectReviewPage(document, cursor, 32, rowLimit, false, false, false, true);

    it('fullOpeningCursor with a view opens on the change; without one the page is all context', async () => {
      const document = await prose(9, 6);
      const view = geometry(14);
      const without = fullOpeningCursor(document, { targetShortened: false });
      expect(draw(document, without, 14).kinds.every((kind) => kind === 'context')).toBe(true);
      const opening = fullOpeningCursor(document, { targetShortened: false, view });
      expect(opening).toEqual(at(document, '-9'));
      const page = draw(document, opening, 14);
      expect(page.kinds[0]).toBe('removed');
      expect(page.kinds).toContain('added');
    });

    it('the target and the field rows still keep the top, view or not', async () => {
      const document = await prose(9, 6);
      expect(fullOpeningCursor(document, { targetShortened: true, view: geometry(14) })).toEqual({
        line: 0,
        offset: 0,
      });
    });

    it('changeJump with a view lands on a page that shows the change', async () => {
      const document = await prose(9, 6);
      const view = geometry(14);
      const landing = changeJump(document, topCursor(document), 1, view);
      expect(landing).toBeDefined();
      const page = draw(document, landing ?? REVIEW_START, 14);
      expect(page.kinds).toContain('removed');
      expect(page.kinds).toContain('added');
    });

    it('one-row lines open exactly as before: three context lines, then the change', async () => {
      const document = await prose(9, 1);
      const opening = fullOpeningCursor(document, { targetShortened: false, view: geometry(14) });
      expect(listedBetween(document, opening.line, index(document, '-9'))).toEqual([
        '=6',
        '=7',
        '=8',
      ]);
      expect(opening).toEqual(fullOpeningCursor(document, { targetShortened: false }));
    });
  });
});

// The last full page is asked for by every key that moves down, so it is computed once per document and geometry.
describe('lastPageStart is memoised per document and geometry', () => {
  const fresh = (document: ReviewDocument, view: ScrollView): ReviewCursor =>
    // A copy is a different document object: it has no cache entry, so this is the plain computation.
    lastPageStart({ ...document }, view);

  it('repeated calls with the same document and geometry return the same cursor', () => {
    const first = lastPageStart(single, VIEW);
    expect(lastPageStart(single, VIEW)).toEqual(first);
    expect(first).toEqual(at(single, '=23'));
    // It is the cached cursor itself, not a recomputation.
    expect(lastPageStart(single, VIEW)).toBe(first);
  });

  describe('each field of the geometry has its own entry (no cross-contamination)', () => {
    const secret = `const k = "sk-proj-${'abcdefghij'.repeat(4)}";`;
    const cases: readonly [string, Promise<ReviewDocument>, ScrollView, ScrollView][] = [
      [
        'rowLimit',
        edited(30, changed(15), 'src/a.ts'),
        viewOf({ rowLimit: 3 }),
        viewOf({ rowLimit: 8 }),
      ],
      [
        'columns',
        documentOf(null, `a\n${'x'.repeat(150)}\nc\n`),
        viewOf({ columns: 32, rowLimit: 5 }),
        viewOf({ columns: 80, rowLimit: 5 }),
      ],
      [
        'numeric',
        documentOf(null, `a\n${'é'.repeat(8)}\n`),
        viewOf({ columns: 32, rowLimit: 3 }),
        viewOf({ columns: 32, rowLimit: 3, numeric: true }),
      ],
      [
        'reveal',
        documentOf(null, `a\n${secret}\nc\n`),
        viewOf({ rowLimit: 3 }),
        viewOf({ rowLimit: 3, reveal: true }),
      ],
    ];

    it.each(cases)(
      '%s: a result is never served for the other value',
      async (_name, pending, one, other) => {
        const document = await pending;
        const expectedOne = fresh(document, one);
        const expectedOther = fresh(document, other);
        expect(expectedOne, 'the two geometries really do give different last pages').not.toEqual(
          expectedOther,
        );
        // Warm one entry, then ask for the other, and each again.
        expect(lastPageStart(document, one)).toEqual(expectedOne);
        expect(lastPageStart(document, other)).toEqual(expectedOther);
        expect(lastPageStart(document, one)).toEqual(expectedOne);
        expect(lastPageStart(document, other)).toEqual(expectedOther);
      },
    );
  });

  it('a different document object never shares an entry, even for the same geometry', () => {
    const cut: ReviewDocument = { ...single, lines: single.lines.slice(0, 20) };
    const whole = lastPageStart(single, VIEW);
    const part = lastPageStart(cut, VIEW);
    expect(whole).toEqual(at(single, '=23'));
    expect(part).not.toEqual(whole);
    expect(part).toEqual(fresh(cut, VIEW));
    // And in the other order.
    const cutFirst: ReviewDocument = { ...triple, lines: triple.lines.slice(0, 30) };
    expect(lastPageStart(cutFirst, VIEW)).toEqual(fresh(cutFirst, VIEW));
    expect(lastPageStart(triple, VIEW)).toEqual(at(triple, '=53'));
    expect(lastPageStart(single, VIEW)).toEqual(whole);
  });

  it('keeps answering correctly past the entries it holds for one document', () => {
    // Twelve geometries for one document, twice: the cache is bounded, the answers are not.
    for (let pass = 0; pass < 2; pass++)
      for (let rowLimit = 1; rowLimit <= 12; rowLimit++) {
        const view = viewOf({ rowLimit });
        expect(lastPageStart(triple, view), `${rowLimit} rows, pass ${pass}`).toEqual(
          fresh(triple, view),
        );
      }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Finding a change by halving (security sitting 4, review round 4): the landing line of a change strictly increases with
// the change's index (the context walk stops at a changed line), so `changeJump` halves over `changeStarts` instead of
// projecting the context of every change; `offPageChangeLanding` halves over the suffix counts of changed lines.
// ---------------------------------------------------------------------------------------------------------------------

/** A small deterministic generator, so a failure is the same failure next time. */
const generator = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/**
 * A random file: short and wrapping lines, with no target or one, and edits that are single, sparse, dense runs or a chain a
 * few lines apart (merged by the gap rule, split by the span bound, or separate). Built with the real line diff.
 */
async function randomDocument(next: () => number): Promise<ReviewDocument> {
  const count = 14 + Math.floor(next() * 90);
  const wrapped = next() < 0.5;
  const text = (n: number): string =>
    `L${n}${wrapped && next() < 0.5 ? 'w'.repeat(20 + Math.floor(next() * 130)) : ''}`;
  const lines = Array.from({ length: count }, (_, i) => text(i + 1));
  const edits = new Map<number, string>();
  const mode = Math.floor(next() * 4);
  if (mode === 0) edits.set(1 + Math.floor(next() * count), 'EDITED');
  else if (mode === 1)
    for (let at = 2 + Math.floor(next() * 8); at <= count; at += 7 + Math.floor(next() * 12))
      edits.set(at, `EDIT ${at}`);
  else if (mode === 2)
    for (let run = 0; run < 1 + Math.floor(next() * 4); run++) {
      const first = 1 + Math.floor(next() * count);
      for (let at = first; at < Math.min(count + 1, first + 1 + Math.floor(next() * 12)); at++)
        edits.set(at, `RUN ${at}`);
    }
  else {
    const step = 2 + Math.floor(next() * 5);
    for (let at = 1 + Math.floor(next() * step); at <= count; at += step)
      edits.set(at, `CHAIN ${at}`);
  }
  const before = `${lines.join('\n')}\n`;
  const after = `${lines.map((line, i) => edits.get(i + 1) ?? line).join('\n')}\n`;
  return documentOf(before, after, next() < 0.5 ? { target: 'src/r.ts' } : {});
}

const randomViews: readonly ScrollView[] = [
  { columns: 32, rowLimit: 5, reveal: false, numeric: false },
  { columns: 40, rowLimit: 14, reveal: false, numeric: false },
  { columns: 80, rowLimit: 24, reveal: false, numeric: false },
  { columns: 32, rowLimit: 3, reveal: false, numeric: false },
];
/**
 * The geometries a person can have: a page of at least four rows (a 3-row context budget leaves room for the first line of a
 * change). A page of three rows or fewer cannot be reached at the 80 x 24 floor, and there a context of three lines fills it.
 */
const walkViews: readonly ScrollView[] = [
  { columns: 32, rowLimit: 5, reveal: false, numeric: false },
  { columns: 40, rowLimit: 14, reveal: false, numeric: false },
  { columns: 80, rowLimit: 24, reveal: false, numeric: false },
  { columns: 32, rowLimit: 4, reveal: false, numeric: false },
];
const randomDocuments: ReviewDocument[] = [];
{
  const next = generator(0xc0ffee);
  for (let round = 0; round < 14; round++) randomDocuments.push(await randomDocument(next));
}

describe('changeJump finds the change by halving: the same result as a linear scan', () => {
  /** The plain scan: evaluate every change, take the first target after the cursor (or the last before it). */
  const scan = (
    document: ReviewDocument,
    cursor: ReviewCursor,
    direction: 1 | -1,
    view: ScrollView,
  ): ReviewCursor | undefined => {
    const targets = document.changeStarts.map((start) => contextStartLine(document, start, view));
    if (direction === 1) {
      const target = targets.find((line) => line > cursor.line);
      if (target === undefined) return undefined;
      const limit = lastPageStart(document, view);
      const landing: ReviewCursor =
        compareCursors({ line: target, offset: 0 }, limit) > 0
          ? limit
          : { line: target, offset: 0 };
      return landing.line > cursor.line ? landing : undefined;
    }
    const before = targets.filter((line) => line < cursor.line);
    return before.length === 0 ? undefined : { line: Math.max(...before), offset: 0 };
  };

  it('the fixtures are varied: single and many changes, merged, split and separate', () => {
    const counts = randomDocuments.map((document) => document.changeStarts.length);
    expect(Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(4);
    expect(randomDocuments.some((document) => document.preview.target !== undefined)).toBe(true);
    expect(randomDocuments.some((document) => document.preview.target === undefined)).toBe(true);
  });

  it.each([
    ['a file with one change', single],
    ['a file with three changes', triple],
    ['a diff-only file', diffOnly],
  ])('%s: both directions from every line, in every geometry', (_name, document) => {
    for (const view of randomViews)
      for (const line of range(0, document.lines.length))
        for (const direction of [1, -1] as const) {
          const cursor = { line, offset: 0 };
          expect(
            changeJump(document, cursor, direction, view),
            `from line ${line}, direction ${direction}, ${view.columns}x${view.rowLimit}`,
          ).toEqual(scan(document, cursor, direction, view));
        }
  });

  it('random documents: both directions from every listed line, in two geometries each', () => {
    for (const [at, document] of randomDocuments.entries())
      for (const view of [
        randomViews[at % 4] as ScrollView,
        randomViews[(at + 1) % 4] as ScrollView,
      ])
        for (const line of [0, ...listedIndexes(document), document.lines.length])
          for (const direction of [1, -1] as const) {
            const cursor = { line, offset: 0 };
            expect(
              changeJump(document, cursor, direction, view),
              `document ${at}, line ${line}, direction ${direction}, ${view.columns}x${view.rowLimit}`,
            ).toEqual(scan(document, cursor, direction, view));
          }
  });
});

/** `from` … `to`, inclusive. */
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

// A document built as the engine's line diff delivers one — but past the size the engine's own diff will review (it refuses
// a thousand scattered edits), because what is under test is how the work grows with the number of changes. The forgery is
// checked against the real diff at a size the engine accepts.
describe('the cost of a jump is counted: it grows with the logarithm of the changes, not with their number', () => {
  type DiffLine = NonNullable<ToolPreview['diff']>['lines'][number];
  const forged = (changes: number, gap: number, context: (n: number) => string) => {
    const total = changes * (gap + 1);
    const before: string[] = [];
    const after: string[] = [];
    const lines: DiffLine[] = [];
    let beforeAt = 0;
    let afterAt = 0;
    for (let n = 1; n <= total; n++) {
      const original = context(n);
      const edit = n % (gap + 1) === 0;
      const replacement = edit ? `EDIT ${n}` : original;
      before.push(original);
      after.push(replacement);
      const was = { line: n, start: beforeAt, end: (beforeAt += original.length + 1) };
      const now = { line: n, start: afterAt, end: (afterAt += replacement.length + 1) };
      if (edit)
        lines.push(
          { kind: 'removed', text: original, ending: 'lf', before: was },
          { kind: 'added', text: replacement, ending: 'lf', after: now },
        );
      else lines.push({ kind: 'context', text: original, ending: 'lf', before: was, after: now });
    }
    const beforeText = `${before.join('\n')}\n`;
    const afterText = `${after.join('\n')}\n`;
    const preview: ToolPreview = {
      kind: 'operation',
      target: 'src/big.md',
      fields: [],
      diff: {
        before: beforeText,
        after: afterText,
        beforeEndings: 'lf',
        afterEndings: 'lf',
        stats: {
          addedLines: changes,
          removedLines: changes,
          beforeBytes: Buffer.byteLength(beforeText),
          afterBytes: Buffer.byteLength(afterText),
        },
        lines,
      },
    };
    return { preview, beforeText, afterText };
  };
  const short = (n: number): string => `L${n}`;
  const wrapping = (n: number): string => `L${n} ${'w'.repeat(38)}`;
  const WIDE: ScrollView = { columns: 32, rowLimit: 24, reveal: false, numeric: false };

  it('the forged diff is the one the engine builds, at a size the engine accepts', async () => {
    const { preview, beforeText, afterText } = forged(300, 7, wrapping);
    const real = await diffLines(beforeText, afterText);
    expect(preview.diff?.lines).toEqual(real.lines);
    expect(preview.diff?.stats).toEqual(real.stats);
    expect(createReviewDocument(preview).changeStarts).toHaveLength(300);
  });

  /** One jump from the middle of the document, with `lastPageStart` already computed: what the jump itself projects. */
  const jumpCost = (document: ReviewDocument, direction: 1 | -1, view: ScrollView) => {
    lastPageStart(document, view);
    resetCount();
    const middle = { line: Math.floor(document.lines.length / 2), offset: 0 };
    const result = changeJump(document, middle, direction, view);
    return { projections: counted.projections, chars: counted.chars, result, middle };
  };

  it.each([
    ['one-row context lines', short, 2_000, 20_000],
    ['wrapped context lines', wrapping, 300, 3_000],
  ] as const)(
    '%s: one jump projects O(log n) lines, and ten times the changes costs under twice as much',
    (_name, context, small, large) => {
      const little = createReviewDocument(forged(small, 7, context).preview);
      const big = createReviewDocument(forged(large, 7, context).preview);
      expect(little.changeStarts).toHaveLength(small);
      expect(big.changeStarts).toHaveLength(large);
      if (context === wrapping)
        expect(lineRows(big, index(big, '=5'), WIDE), 'the context lines wrap').toBe(2);
      for (const direction of [1, -1] as const) {
        const a = jumpCost(little, direction, WIDE);
        const b = jumpCost(big, direction, WIDE);
        expect(a.result, 'the jump lands').toBeDefined();
        expect(b.result, 'the jump lands').toBeDefined();
        // Each change examined projects at most its three context lines; halving examines about log2(n) + 1 of them.
        const allowed = (n: number): number => CARD_CONTEXT_LINES * (Math.ceil(Math.log2(n)) + 2);
        expect(a.projections, `${small} changes, direction ${direction}`).toBeLessThanOrEqual(
          allowed(small),
        );
        expect(b.projections, `${large} changes, direction ${direction}`).toBeLessThanOrEqual(
          allowed(large),
        );
        expect(b.projections / a.projections, `direction ${direction}`).toBeLessThan(2);
        expect(b.chars / a.chars, `direction ${direction}, characters`).toBeLessThan(2);
      }
    },
  );

  describe('a context line is measured only up to the rows the budget has left', () => {
    // One context line of 50,000 characters wraps to well over a thousand rows at 40 columns; the page is 24 rows, so the
    // budget is max(3, floor(24 / 3)) = 8 rows, and one line may be measured to at most 9 rows.
    const view: ScrollView = { columns: 40, rowLimit: 24, reveal: false, numeric: false };
    const budget = Math.max(CARD_CONTEXT_LINES, Math.floor(view.rowLimit / 3));
    const huge = documentOf(
      `a\nb\n${'x'.repeat(50_000)}\nchanged\nz\n`,
      `a\nb\n${'x'.repeat(50_000)}\nCHANGED\nz\n`,
      { target: 'src/h.md' },
    );

    it('asks the projection for at most budget + 1 rows, and measures about that many rows of text', async () => {
      const document = await huge;
      resetCount();
      const start = contextStartLine(document, index(document, '-4'), view);
      // The first context line above the change is the huge one: it does not fit, so there is no context at all.
      expect(start).toBe(index(document, '-4'));
      expect(counted.rowLimits).toHaveLength(1);
      for (const rowLimit of counted.rowLimits) expect(rowLimit).toBeLessThanOrEqual(budget + 1);
      expect(counted.chars, `${counted.chars} characters`).toBeLessThanOrEqual(
        (budget + 1) * 3 * view.columns,
      );
    });

    it('a second line is measured only up to what the first left', async () => {
      const document = await documentOf(
        `a\n${'y'.repeat(60)}\n${'z'.repeat(60)}\nb\nchanged\nz\n`,
        `a\n${'y'.repeat(60)}\n${'z'.repeat(60)}\nb\nCHANGED\nz\n`,
      );
      resetCount();
      contextStartLine(document, index(document, '-5'), view);
      // `b` is one row, then each 60-character line is two rows: the limits asked are budget + 1, then what is left + 1.
      expect(counted.rowLimits.slice(0, 3)).toEqual([budget + 1, budget, budget - 2]);
    });
  });
});

describe('offPageChangeLanding: where a Tab lands to show the nearest changed line the page does not draw', () => {
  const draw = (document: ReviewDocument, cursor: ReviewCursor, view: ScrollView) =>
    projectReviewPage(
      document,
      cursor,
      view.columns,
      view.rowLimit,
      view.reveal,
      view.numeric,
      false,
      true,
    );
  /** The page the full view draws from `cursor` and the landing a forward Tab asks for. */
  const forward = (document: ReviewDocument, cursor: ReviewCursor, view: ScrollView) => {
    const page = draw(document, cursor, view);
    return { page, landing: offPageChangeLanding(document, cursor, 1, view, page.next) };
  };
  const SCREEN: ScrollView = { columns: 78, rowLimit: 16, reveal: false, numeric: false };

  describe("a change longer than a page (the sitting's tab-tail case)", () => {
    // Three context lines, a 30-line insertion, ten unchanged lines, a one-line change: at 80 x 24 (16 body rows) the first
    // page shows the context and thirteen of the thirty added lines, and the old Tab jumped to the one-line change.
    const before = `${['L1', 'L2', 'L3', ...range(1, 10).map((n) => `G${n}`), 'T1', 'E1', 'E2'].join('\n')}\n`;
    const after = `${[
      'L1',
      'L2',
      'L3',
      ...range(1, 30).map((n) => `N${n}`),
      ...range(1, 10).map((n) => `G${n}`),
      'T1 changed',
      'E1',
      'E2',
    ].join('\n')}\n`;
    const tail = documentOf(before, after, { target: 'src/a.ts' });

    it('the forward landing shows the first added line the page did not draw', async () => {
      const document = await tail;
      const cursor = fullOpeningCursor(document, { targetShortened: false, view: SCREEN });
      expect(labelAt(document, cursor)).toBe('=1');
      const { page, landing } = forward(document, cursor, SCREEN);
      expect(page.labels.slice(-1)).toEqual(['+16']);
      expect(page.next).toEqual(at(document, '+17'));
      expect(landing).toEqual(at(document, '+17'));
      expect(draw(document, landing ?? REVIEW_START, SCREEN).labels[0]).toBe('+17');
    });

    it('the old jump skips what the page did not draw, so the nearer of the two is the landing', async () => {
      const document = await tail;
      const cursor = fullOpeningCursor(document, { targetShortened: false, view: SCREEN });
      const { landing } = forward(document, cursor, SCREEN);
      const jumped = changeJump(document, cursor, 1, SCREEN);
      expect(jumped, 'the jump lands on the one-line change').toBeDefined();
      // It lands on the last full page, past added lines the first page never drew.
      expect(jumped?.line).toBeGreaterThan(index(document, '+17'));
      expect(compareCursors(landing ?? REVIEW_START, jumped ?? REVIEW_START)).toBeLessThan(0);
    });
  });

  describe('edits every fifth line', () => {
    const dense = edited(60, changed(...range(1, 12).map((n) => n * 5)), 'src/d.ts');

    it('lands on the opening of the nearest changed line the page does not draw', async () => {
      const document = await dense;
      const view = viewOf({ columns: 40, rowLimit: 14 });
      const cursor = fullOpeningCursor(document, { targetShortened: false, view });
      expect(labelAt(document, cursor)).toBe('=2');
      const { page, landing } = forward(document, cursor, view);
      // The page ends after `=13`; the nearest undrawn changed line is `-15`, and its opening is three context lines above.
      expect(page.labels.at(-1)).toBe('=13');
      expect(labelAt(document, landing)).toBe('=12');
      const shown = draw(document, landing ?? REVIEW_START, view).labels;
      expect(shown.slice(0, 5)).toEqual(['=12', '=13', '=14', '-15', '+15']);
      // No changed line between the cursor and the landing was left undrawn.
      const skipped = document.lines
        .slice(cursor.line, landing?.line ?? 0)
        .filter((line) => line.changed)
        .map((line) => line.label);
      expect(skipped.every((label) => page.labels.includes(label))).toBe(true);
    });
  });

  describe('wrapped context lines: the opening uses the row budget', () => {
    /** Fourteen lines of three rows at 32 columns, the `at`th replaced by one short line. */
    const prose = (editAt: number) => {
      const text = (n: number): string => `L${n}${'w'.repeat(29 * 2 + 3)}`;
      const lines = range(1, 14).map(text);
      return documentOf(
        `${lines.join('\n')}\n`,
        `${lines.map((line, i) => (i + 1 === editAt ? 'NEW' : line)).join('\n')}\n`,
        { target: 'src/p.md' },
      );
    };
    const geometry: ScrollView = { columns: 32, rowLimit: 14, reveal: false, numeric: false };

    it('a 4-row budget keeps one three-row context line, not three', async () => {
      const document = await prose(9);
      const { page, landing } = forward(document, REVIEW_START, geometry);
      expect(page.next?.line, 'the page is cut inside line 5').toBe(index(document, '=5'));
      expect(labelAt(document, landing)).toBe('=8');
      expect(
        labelAt(document, { line: contextStartLine(document, index(document, '-9')), offset: 0 }),
      ).toBe('=6');
      const shown = draw(document, landing ?? REVIEW_START, geometry);
      expect(shown.kinds).toContain('removed');
      expect(shown.kinds).toContain('added');
    });

    it('is held at the last full page when the opening is past it', async () => {
      const document = await prose(13);
      const { landing } = forward(document, REVIEW_START, geometry);
      const limit = lastPageStart(document, geometry);
      expect(labelAt(document, limit)).toBe('=11');
      expect(landing).toEqual(limit);
    });

    it('backward: a page up from just below the nearest changed line above, counted in rows', async () => {
      const document = await prose(9);
      const landing = offPageChangeLanding(document, at(document, '+9'), -1, geometry, undefined);
      // Three-row lines: `-9`, `=8`, `=7` and `=6` are 12 rows, and a fifth line would be 15 over a 14-row page.
      expect(landing).toEqual(at(document, '=6'));
      expect(draw(document, landing ?? REVIEW_START, geometry).kinds).toContain('removed');
    });
  });

  describe('forward: undefined', () => {
    const cursor = at(single, '=5');

    it('without a cut: the page reaches the end', () => {
      expect(offPageChangeLanding(single, cursor, 1, VIEW, undefined)).toBeUndefined();
      const last = lastPageStart(single, VIEW);
      expect(forward(single, last, VIEW).landing).toBeUndefined();
    });

    it('when no changed line is at or after the cut', () => {
      expect(offPageChangeLanding(single, cursor, 1, VIEW, at(single, '=20'))).toBeUndefined();
      expect(offPageChangeLanding(single, cursor, 1, VIEW, at(single, '+15'))).toEqual(
        at(single, '+15'),
      );
      expect(offPageChangeLanding(single, cursor, 1, VIEW, at(single, '=16'))).toBeUndefined();
    });

    it('when the result is not strictly after the cursor', () => {
      // The opening of `-15` is `=12`, which is behind a cursor on `=13`, so the landing is the cut — here the cursor itself.
      const inside = at(single, '=13');
      expect(offPageChangeLanding(single, inside, 1, VIEW, inside)).toBeUndefined();
      expect(offPageChangeLanding(single, inside, 1, VIEW, at(single, '=14'))).toEqual(
        at(single, '=14'),
      );
      // A cursor at the last full page with a cut before it: held at the limit, which is the cursor.
      const limit = lastPageStart(single, VIEW);
      expect(offPageChangeLanding(single, limit, 1, VIEW, at(single, '=10'))).toBeUndefined();
    });
  });

  describe('backward, the mirror', () => {
    it('lands a page up from just below the nearest changed line above the cursor, so that line ends the page', () => {
      const lastRow = (
        document: ReviewDocument,
        landing: ReviewCursor | undefined,
      ): string | undefined => draw(document, landing ?? REVIEW_START, VIEW).labels.at(-1);
      // From `=16` the nearest changed line is `+15`: the eight listed lines `=9` … `-15`, `+15` end on it.
      const first = offPageChangeLanding(single, at(single, '=16'), -1, VIEW, undefined);
      expect(first).toEqual(at(single, '=9'));
      expect(lastRow(single, first)).toBe('+15');
      // From `+15` it is `-15`.
      const second = offPageChangeLanding(single, at(single, '+15'), -1, VIEW, undefined);
      expect(second).toEqual(at(single, '=8'));
      expect(lastRow(single, second)).toBe('-15');
      // From `=20` of the three-change file it is `+10`, with only the top of the file above it: the page ends on it.
      const third = offPageChangeLanding(triple, at(triple, '=20'), -1, VIEW, undefined);
      expect(third).toEqual(at(triple, '=4'));
      expect(lastRow(triple, third)).toBe('+10');
    });

    it('a single isolated change above: the landing page ends on its changed row, at several page heights', () => {
      for (const [document, from, aimed] of [
        [single, '=25', '+15'],
        [single, '=30', '+15'],
        [triple, '=40', '+30'],
        [triple, '=59', '+50'],
      ] as const)
        for (const rowLimit of [4, 5, 8, 14]) {
          const view = viewOf({ rowLimit });
          const landing = offPageChangeLanding(document, at(document, from), -1, view, undefined);
          expect(landing, `from ${from}, ${rowLimit} rows`).toBeDefined();
          const page = draw(document, landing ?? REVIEW_START, view);
          expect(page.labels.at(-1), `from ${from}, ${rowLimit} rows`).toBe(aimed);
          expect(page.rows, `from ${from}, ${rowLimit} rows`).toHaveLength(rowLimit);
        }
    });

    it('is undefined at the top and when no changed line is above', () => {
      expect(offPageChangeLanding(single, topCursor(single), -1, VIEW, undefined)).toBeUndefined();
      expect(offPageChangeLanding(single, at(single, '=3'), -1, VIEW, undefined)).toBeUndefined();
      expect(offPageChangeLanding(single, at(single, '-15'), -1, VIEW, undefined)).toBeUndefined();
    });

    it('never lands on or after the cursor, from any line', () => {
      for (const document of [single, triple, ...randomDocuments])
        for (const view of randomViews)
          for (const line of range(0, document.lines.length)) {
            const result = offPageChangeLanding(document, { line, offset: 0 }, -1, view, undefined);
            if (result !== undefined) expect(result.line).toBeLessThan(line);
          }
    });
  });

  describe('every changed line is on some landing page', () => {
    /** The model's choice: the nearer of the jump and the off-page landing. */
    const nearer = (
      jumped: ReviewCursor | undefined,
      off: ReviewCursor | undefined,
      forwardWalk: boolean,
    ): ReviewCursor | undefined => {
      if (jumped === undefined) return off;
      if (off === undefined) return jumped;
      return compareCursors(off, jumped) < 0 === forwardWalk ? off : jumped;
    };
    const changedLabels = (document: ReviewDocument): string[] =>
      document.lines.filter((line) => line.changed).map((line) => line.label);
    const walkForward = (document: ReviewDocument, view: ScrollView) => {
      const seen = new Set<string>();
      let cursor = topCursor(document);
      let steps = 0;
      for (; steps < 5_000; steps++) {
        const page = draw(document, cursor, view);
        for (const label of page.labels) seen.add(label);
        const landing = nearer(
          changeJump(document, cursor, 1, view),
          offPageChangeLanding(document, cursor, 1, view, page.next),
          true,
        );
        if (landing === undefined) break;
        expect(compareCursors(landing, cursor), `step ${steps}`).toBeGreaterThan(0);
        cursor = landing;
      }
      return { seen, steps };
    };
    const walkBackward = (document: ReviewDocument, view: ScrollView) => {
      const seen = new Set<string>();
      let cursor = lastPageStart(document, view);
      let steps = 0;
      for (; steps < 5_000; steps++) {
        const page = draw(document, cursor, view);
        for (const label of page.labels) seen.add(label);
        const landing = nearer(
          changeJump(document, cursor, -1, view),
          offPageChangeLanding(document, cursor, -1, view, page.next),
          false,
        );
        if (landing === undefined) break;
        expect(compareCursors(landing, cursor), `step ${steps}`).toBeLessThan(0);
        cursor = landing;
      }
      return { seen, steps };
    };

    describe('a new file of consecutive added lines is paged through, not crawled', () => {
      // A hundred added lines and nothing else: one run of changed lines with no context, so the nearest changed line above is
      // always the line just above the cursor. A landing that opens on it moves one line a press; a landing that ENDS the
      // page on it moves a page.
      const created = documentOf(
        null,
        `${range(1, 100)
          .map((n) => `row ${n}`)
          .join('\n')}\n`,
      );

      it.each([
        ['80 x 24', viewOf({ columns: 78, rowLimit: 16 })],
        ['40 x 14', viewOf({ columns: 38, rowLimit: 10 })],
      ])(
        '%s: from the end, Shift+Tab reaches the top in about lines / page rows presses',
        async (_name, view) => {
          const document = await created;
          expect(document.lines).toHaveLength(100);
          const labels = document.lines.map((line) => line.label);
          const seen = new Set<string>();
          let cursor = lastPageStart(document, view);
          const start = draw(document, cursor, view);
          for (const label of start.labels) seen.add(label);
          let presses = 0;
          for (; presses < 200; presses++) {
            const aimed = Math.max(0, cursor.line - 1);
            const jumped = changeJump(document, cursor, -1, view);
            const off = offPageChangeLanding(document, cursor, -1, view, start.next);
            const landing = nearer(jumped, off, false);
            if (landing === undefined) break;
            expect(landing.line, `press ${presses}: strictly backward`).toBeLessThan(cursor.line);
            const page = draw(document, landing, view);
            for (const label of page.labels) seen.add(label);
            // The line it was aiming at — the one just above the old cursor — is drawn.
            expect(page.labels, `press ${presses}`).toContain(labels[aimed]);
            if (landing === off && landing.line > 0)
              // A page up from just below it: the aimed line ends the page (unless the top clamps it).
              expect(page.labels.at(-1), `press ${presses}: the aimed line ends the page`).toBe(
                labels[aimed],
              );
            else if (landing !== off)
              // Or the nearer jump to the start of the change the cursor is in.
              expect(document.changeStarts, `press ${presses}: a jump lands on a change`).toContain(
                landing.line,
              );
            cursor = landing;
          }
          expect(presses, 'the walk ends').toBeLessThan(200);
          expect(cursor, 'it reaches the top').toEqual({ line: 0, offset: 0 });
          expect(presses, `${presses} presses`).toBeLessThanOrEqual(
            1.5 * Math.ceil(100 / view.rowLimit),
          );
          for (const label of labels) expect(seen.has(label), label).toBe(true);
        },
      );
    });

    it.each([
      ['a file with one change', single],
      ['a file with three changes', triple],
      ['a diff-only file', diffOnly],
    ])('%s', (_name, document) => {
      for (const view of walkViews) {
        const ahead = walkForward(document, view);
        expect(ahead.steps, 'the walk ends').toBeLessThan(5_000);
        for (const label of changedLabels(document))
          expect(ahead.seen.has(label), `forward, ${view.columns}x${view.rowLimit}: ${label}`).toBe(
            true,
          );
        const back = walkBackward(document, view);
        expect(back.steps, 'the walk ends').toBeLessThan(5_000);
        for (const label of changedLabels(document))
          expect(back.seen.has(label), `backward, ${view.columns}x${view.rowLimit}: ${label}`).toBe(
            true,
          );
      }
    });

    it('a change longer than any page, a chain of edits, and a line that wraps to many pages', async () => {
      const long = await documentOf(null, `a\n${'x'.repeat(900)}\n${'y'.repeat(40)}\nc\n`);
      const chain = await edited(120, changed(...range(1, 20).map((n) => n * 6)), 'src/s.ts');
      for (const document of [long, chain])
        for (const view of walkViews) {
          const ahead = walkForward(document, view);
          const back = walkBackward(document, view);
          expect(ahead.steps).toBeLessThan(5_000);
          expect(back.steps).toBeLessThan(5_000);
          for (const label of changedLabels(document)) {
            expect(
              ahead.seen.has(label),
              `forward ${view.columns}x${view.rowLimit}: ${label}`,
            ).toBe(true);
            expect(
              back.seen.has(label),
              `backward ${view.columns}x${view.rowLimit}: ${label}`,
            ).toBe(true);
          }
        }
    });

    it('random documents, both ways, in two geometries each', () => {
      for (const [at, document] of randomDocuments.entries())
        for (const view of [
          walkViews[at % 4] as ScrollView,
          walkViews[(at + 2) % 4] as ScrollView,
        ]) {
          const ahead = walkForward(document, view);
          const back = walkBackward(document, view);
          expect(ahead.steps, `document ${at}`).toBeLessThan(5_000);
          expect(back.steps, `document ${at}`).toBeLessThan(5_000);
          for (const label of changedLabels(document)) {
            expect(
              ahead.seen.has(label),
              `document ${at}, forward ${view.columns}x${view.rowLimit}: ${label}`,
            ).toBe(true);
            expect(
              back.seen.has(label),
              `document ${at}, backward ${view.columns}x${view.rowLimit}: ${label}`,
            ).toBe(true);
          }
        }
    });
  });

  describe('the nearest changed line is found as a linear scan finds it', () => {
    /** The plain scan the halving over the suffix counts must agree with. */
    const firstChangedAtOrAfter = (document: ReviewDocument, from: number): number | undefined => {
      for (let line = Math.max(0, from); line < document.lines.length; line++)
        if (document.lines[line]?.changed === true) return line;
      return undefined;
    };
    const lastChangedBefore = (document: ReviewDocument, before: number): number | undefined => {
      for (let line = Math.min(before, document.lines.length) - 1; line >= 0; line--)
        if (document.lines[line]?.changed === true) return line;
      return undefined;
    };

    it('forward, for every cut and every other cursor line, in random documents', () => {
      for (const [at, document] of randomDocuments.entries()) {
        const view = randomViews[at % 4] as ScrollView;
        const limit = lastPageStart(document, view);
        for (const cutLine of range(0, document.lines.length + 1))
          for (let line = 0; line <= document.lines.length; line += 3) {
            const cursor = { line, offset: 0 };
            const cut = { line: cutLine, offset: 0 };
            const undrawn = firstChangedAtOrAfter(document, cutLine);
            let expected: ReviewCursor | undefined;
            if (undrawn !== undefined) {
              const opening = contextStartLine(document, undrawn, view);
              const landing = opening > line ? { line: opening, offset: 0 } : cut;
              const reached = compareCursors(landing, limit) > 0 ? limit : landing;
              expected = compareCursors(reached, cursor) > 0 ? reached : undefined;
            }
            expect(
              offPageChangeLanding(document, cursor, 1, view, cut),
              `document ${at}, cursor line ${line}, cut line ${cutLine}`,
            ).toEqual(expected);
          }
      }
    });

    it('forward, with no cut: undefined', () => {
      for (const document of randomDocuments)
        expect(offPageChangeLanding(document, REVIEW_START, 1, VIEW, undefined)).toBeUndefined();
    });

    it('backward, for every cursor line, in random documents', () => {
      for (const [at, document] of randomDocuments.entries()) {
        const view = randomViews[at % 4] as ScrollView;
        for (const line of range(0, document.lines.length + 1)) {
          const above = lastChangedBefore(document, line);
          let expected: ReviewCursor | undefined;
          if (above !== undefined) {
            // A page up from the line just below it, so that line ends the page; accepted only if it is before the cursor.
            const earlier = pageUp(document, { line: above + 1, offset: 0 }, view);
            expected = earlier !== undefined && earlier.line < line ? earlier : undefined;
          }
          expect(
            offPageChangeLanding(document, { line, offset: 0 }, -1, view, undefined),
            `document ${at}, cursor line ${line}`,
          ).toEqual(expected);
        }
      }
    });
  });
});
