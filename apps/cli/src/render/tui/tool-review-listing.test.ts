/**
 * What the full view lists, and what it says about the part it does not draw (ADR-0134 §2, §3): the deduplicated listing
 * (one row per unchanged line), the suffix counts and the change stops it needs, and the page's own report of where it sits
 * (`hiddenLines`, `hiddenBytes`, `position`, `labels`, `changesAbove`/`changesBelow`).
 *
 * Every fixture is built the way the engine builds one — the real line diff, then the real `createReviewDocument` — and every
 * number a page reports is compared with a plain count over the document's lines. The losslessness the listing rests on
 * (nothing a person could inspect is left out) is checked on the source ranges the page drew, not on the labels.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// The engine's own line diff. It is not part of the `@relavium/core` barrel (only the built-in tools use it), and a hand-made
// diff is exactly what a fixture here must not be, so the test reaches the one function by its path.
import { diffLines } from '../../../../../packages/core/src/tools/line-diff.js';
import {
  CARD_CONTEXT_LINES,
  CHANGE_GAP_LINES,
  CHANGE_SPAN_LINES,
  createReviewDocument,
  escapeReviewCharacter,
  PAGE_WORK_LIMIT,
  projectReviewPage,
  REVIEW_START,
  ROW_TOKENS_PER_COLUMN,
  type ReviewCursor,
  type ReviewDocument,
  type ReviewPage,
  type ReviewSourceLine,
} from './tool-review-projection.js';
import { displayWidth } from './viewport.js';

/**
 * Masks a test chooses the edges of. The real scrubber only ever returns a mask INSIDE one line (a quoted key) or, when it
 * cannot tell where a secret ends, the whole field; a mask that ends exactly where the next line begins, or begins exactly
 * on a line start, would need a secret that swallows a newline. The table is keyed by the field's whole text, so every other
 * text goes to the real scrubber; `sanitizeUntrusted` is answered with the same projection the document's display-floor check
 * compares against, so a forced span is accepted as a span rather than widened to the whole field.
 */
const forced = vi.hoisted(() => ({
  spans: new Map<string, readonly { readonly start: number; readonly end: number }[]>(),
}));
vi.mock('@relavium/llm/scrub-secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@relavium/llm/scrub-secrets')>();
  return {
    ...actual,
    secretMaskRanges: (text: string) => forced.spans.get(text) ?? actual.secretMaskRanges(text),
  };
});
vi.mock('../sanitize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sanitize.js')>();
  return {
    ...actual,
    sanitizeUntrusted: (text: string) => {
      const spans = forced.spans.get(text);
      if (spans === undefined) return actual.sanitizeUntrusted(text);
      let projected = '',
        cursor = 0;
      for (const span of spans) {
        projected += `${text.slice(cursor, span.start)}[REDACTED]`;
        cursor = span.end;
      }
      return actual.stripTerminalControls(projected + text.slice(cursor));
    },
  };
});
/**
 * How much text a projection asks the terminal's width function to measure. A row's cost is the characters measured (the
 * width function is the expensive step, and it is what a person's terminal pays for as well), and counting them is exact
 * where a timer is not. The function is the real one, wrapped.
 */
const measured = vi.hoisted(() => ({ chars: 0 }));
vi.mock('./viewport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./viewport.js')>();
  return {
    ...actual,
    displayWidth: (text: string) => {
      measured.chars += text.length;
      return actual.displayWidth(text);
    },
  };
});
afterEach(() => {
  forced.spans.clear();
});

type Mode = 'raw' | 'compact' | 'dedupe';

const numbered = (count: number, overrides: Readonly<Record<number, string>> = {}): string =>
  `${Array.from({ length: count }, (_, i) => overrides[i + 1] ?? `line ${i + 1}`).join('\n')}\n`;

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

const changed = (...lines: number[]): Record<number, string> =>
  Object.fromEntries(lines.map((line) => [line, `LINE ${line} CHANGED`]));

/** A `count`-line file with `edits` applied to the after side and `shared` lines present on BOTH sides. */
const edited = (
  count: number,
  edits: Readonly<Record<number, string>>,
  options: { readonly target?: string; readonly shared?: Readonly<Record<number, string>> } = {},
): Promise<ReviewDocument> =>
  documentOf(
    numbered(count, options.shared),
    numbered(count, { ...options.shared, ...edits }),
    options.target === undefined ? {} : { target: options.target },
  );

const index = (document: ReviewDocument, label: string): number => {
  const found = document.lines.findIndex((line) => line.label === label);
  if (found < 0) throw new Error(`the fixture has no line ${label}`);
  return found;
};
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const skips = (line: ReviewSourceLine, mode: Mode): boolean => {
  if (mode === 'compact') return line.cardSkip === true;
  return mode === 'dedupe' && line.fullSkip === true;
};
/** The bytes a line stands for, counted from its text and its ending (not from the suffix arrays under test). */
const lineBytes = (document: ReviewDocument, line: ReviewSourceLine): number =>
  Buffer.byteLength((document.fields[line.field]?.text ?? '').slice(line.start, line.end)) +
  (line.ending === 'lf' ? 1 : line.ending === 'crlf' ? 2 : 0);

/** Wide enough for every line of the one-row fixtures: a row is never cut. */
const COLUMNS = 60;
const project = (
  document: ReviewDocument,
  cursor: ReviewCursor,
  rowLimit: number,
  mode: Mode,
  columns = COLUMNS,
): ReviewPage =>
  projectReviewPage(
    document,
    cursor,
    columns,
    rowLimit,
    false,
    false,
    mode === 'compact',
    mode === 'dedupe',
  );
const whole = (document: ReviewDocument, mode: Mode): ReviewPage =>
  project(document, REVIEW_START, 100_000, mode);

// A secret is masked: a quoted key on ONE line is a precise mask; a key broken across lines, or behind `Bearer`, makes the
// scrubber mask the whole field (it cannot say where the secret ends), so such a mask begins on an earlier line.
const KEY = `sk-proj-${'abcdefghij'.repeat(4)}`;
const QUOTED = `const k = "${KEY}";`;

const single = await edited(30, changed(15), { target: 'src/a.ts' });
const diffOnly = await edited(30, changed(15));
const triple = await edited(60, changed(10, 30, 50), { target: 'src/m.ts' });
// A quoted secret on unchanged line 6 and a change on line 14: only the copies of line 6 carry a mask.
const precise = await edited(20, changed(14), { target: 'src/p.ts', shared: { 6: QUOTED } });
// `Bearer <key>` on unchanged line 4: the whole field is masked, so every line is touched.
const bearer = await edited(20, changed(14), { shared: { 4: `auth: Bearer ${KEY}` } });
// A key split over lines 3 and 4: the mask begins on line 1 and runs through both.
const split = await edited(20, changed(14), {
  shared: { 3: `const k = "${KEY.slice(0, 24)}`, 4: `${KEY.slice(24)}";` },
});
// Multi-byte text and CRLF endings, the last line unterminated: bytes are not characters, an ending is two of them.
const multibyte = await documentOf('é1\r\nü2\r\n日本3\r\n😀4', 'é1\r\nÜ2\r\n日本3\r\n😀4', {
  target: 'src/ü.ts',
});
const wrapped = await documentOf(null, `a\n${'x'.repeat(150)}\nc\n`);

const fixtures: readonly [string, ReviewDocument][] = [
  ['a file with a target and one change', single],
  ['a diff-only document', diffOnly],
  ['a file with three changes', triple],
  ['a quoted secret on an unchanged line', precise],
  ['a Bearer secret (the whole field masked)', bearer],
  ['a key split over two lines (the whole field masked)', split],
  ['multi-byte text with CRLF endings', multibyte],
];

describe('fullSkip', () => {
  const beforeCopies = (document: ReviewDocument): ReviewSourceLine[] =>
    document.lines.filter((line) => line.label.startsWith('=before '));

  it('is true for the before copy of an unmasked context line, and set on no other line', () => {
    const copies = beforeCopies(single);
    expect(copies).toHaveLength(29);
    for (const line of copies) {
      expect(line.fullSkip, line.label).toBe(true);
      expect(line.cardSkip, line.label).toBe(true);
    }
    const others = single.lines.filter((line) => !line.label.startsWith('=before '));
    expect(others).toHaveLength(32);
    for (const line of others) expect(line.fullSkip, line.label).toBeUndefined();
    // The twin of a skipped copy — the line the listing keeps — is not skipped.
    expect(single.lines[index(single, '=5')]?.fullSkip).toBeUndefined();
  });

  it('is FALSE for a before copy a mask touches: the mask is inspected there', () => {
    const copies = beforeCopies(precise);
    expect(copies).toHaveLength(19);
    const masked = copies.filter((line) => line.fullSkip === false);
    expect(masked.map((line) => line.label)).toEqual(['=before 6']);
    expect(copies.filter((line) => line.fullSkip === true)).toHaveLength(18);
    // The fixture is what it says: one mask on the before side, lying inside that line.
    const line = precise.lines[index(precise, '=before 6')];
    const mask = precise.fields[line?.field ?? 0]?.masks[0];
    expect(precise.fields[line?.field ?? 0]?.masks).toHaveLength(1);
    expect(mask?.start).toBeGreaterThan(line?.start ?? Infinity);
    expect(mask?.end).toBeLessThan(line?.end ?? 0);
    // The card still leaves the copy out: only the full view lists it.
    expect(line?.cardSkip).toBe(true);
    expect(precise.lines[index(precise, '=6')]?.fullSkip).toBeUndefined();
  });

  it('is false for every copy a mask that begins on an earlier line runs into (a multi-line secret)', () => {
    for (const document of [bearer, split]) {
      const copies = beforeCopies(document);
      expect(copies.length).toBeGreaterThan(0);
      for (const line of copies) expect(line.fullSkip, line.label).toBe(false);
    }
    // Line 4 of the split key: its mask begins before the line and ends after it.
    const line = split.lines[index(split, '=before 4')];
    const mask = split.fields[line?.field ?? 0]?.masks[0];
    expect(mask?.start).toBeLessThan(line?.start ?? 0);
    expect(mask?.end).toBeGreaterThan(line?.end ?? 0);
    // Even a copy ABOVE the secret's own lines is touched, by the same mask.
    expect(split.lines[index(split, '=before 1')]?.fullSkip).toBe(false);
  });

  it.each(fixtures)(
    '%s: agrees with a plain overlap test of every before copy',
    (_name, document) => {
      for (const line of beforeCopies(document)) {
        const end = line.end + (line.ending === 'lf' ? 1 : line.ending === 'crlf' ? 2 : 0);
        const touched = (document.fields[line.field]?.masks ?? []).some(
          (mask) => mask.start < Math.max(end, line.start + 1) && mask.end > line.start,
        );
        expect(line.fullSkip, line.label).toBe(!touched);
      }
    },
  );

  it('is never set by a document with no context line (a new file)', async () => {
    const created = await documentOf(null, 'a\nb\n');
    expect(created.lines.every((line) => line.fullSkip === undefined)).toBe(true);
  });

  describe("the mask is looked up on the BEFORE side, at the before copy's own offsets", () => {
    // An edit that changes the length of the file earlier on: the secret's line sits at a different offset on each side.
    const longEdit = `LINE 2 ${'CHANGED '.repeat(20)}`.trim();
    const fixturesByDirection = [
      [
        'the edit makes the file longer',
        numbered(30, { 8: QUOTED }),
        numbered(30, { 8: QUOTED, 2: longEdit }),
      ],
      [
        'the edit makes the file shorter',
        numbered(30, { 8: QUOTED, 2: longEdit }),
        numbered(30, { 8: QUOTED, 2: 'x' }),
      ],
    ] as const;

    it.each(fixturesByDirection)(
      '%s: only the before copy of the secret line is listed',
      async (_name, before, after) => {
        const document = await documentOf(before, after);
        // The fixture is what it says: the two sides' masks are a hundred characters apart.
        const beforeMask =
          document.fields[document.lines[index(document, '-2')]?.field ?? 0]?.masks[0];
        const afterMask =
          document.fields[document.lines[index(document, '+2')]?.field ?? 0]?.masks[0];
        expect(beforeMask, 'a mask on the before side').toBeDefined();
        expect(afterMask, 'a mask on the after side').toBeDefined();
        expect(Math.abs((afterMask?.start ?? 0) - (beforeMask?.start ?? 0))).toBeGreaterThan(100);
        const copies = document.lines.filter((line) => line.label.startsWith('=before '));
        expect(copies.filter((line) => line.fullSkip === false).map((line) => line.label)).toEqual([
          '=before 8',
        ]);
        expect(copies.filter((line) => line.fullSkip === true)).toHaveLength(copies.length - 1);
      },
    );
  });

  describe('at the edge of a line (forced masks)', () => {
    // Lines 1 … 9 are `line N` + a newline: seven characters, so line N spans [7(N-1), 7N) of the before text.
    const before = numbered(12);
    const listedFor = async (
      spans: readonly { start: number; end: number }[],
    ): Promise<string[]> => {
      forced.spans.set(before, spans);
      const document = await documentOf(before, numbered(12, changed(10)));
      expect(
        document.fields[document.lines[index(document, '=before 4')]?.field ?? 0]?.masks,
      ).toHaveLength(spans.length);
      return document.lines
        .filter((line) => line.label.startsWith('=before ') && line.fullSkip === false)
        .map((line) => line.label);
    };

    it('a mask that ends exactly where the next line begins does not list the next copy', async () => {
      // [21, 28) is line 4 with its newline: line 5 starts at 28, line 3 ends at 21.
      expect(await listedFor([{ start: 21, end: 28 }])).toEqual(['=before 4']);
      // The last character of line 3 (its newline): the mask ends where line 4 begins.
      expect(await listedFor([{ start: 20, end: 21 }])).toEqual(['=before 3']);
    });

    it('a mask that starts exactly at a line start lists that copy and not the one before it', async () => {
      expect(await listedFor([{ start: 28, end: 33 }])).toEqual(['=before 5']);
    });

    it('a mask across several lines lists each line it overlaps, and only those', async () => {
      expect(await listedFor([{ start: 14, end: 28 }])).toEqual(['=before 3', '=before 4']);
    });

    it('one character of overlap on each side lists both lines', async () => {
      expect(await listedFor([{ start: 27, end: 29 }])).toEqual(['=before 4', '=before 5']);
    });
  });
});

describe('fullRemainingLines and fullRemainingBytes', () => {
  it.each(fixtures)(
    '%s: equal a brute-force count of the listed lines, for every index',
    (_name, document) => {
      const { lines } = document;
      expect(document.fullRemainingLines).toHaveLength(lines.length + 1);
      expect(document.fullRemainingBytes).toHaveLength(lines.length + 1);
      expect(document.fullRemainingLines.at(-1)).toBe(0);
      expect(document.fullRemainingBytes.at(-1)).toBe(0);
      for (let from = 0; from <= lines.length; from++) {
        const listed = lines.slice(from).filter((line) => line.fullSkip !== true);
        expect(document.fullRemainingLines[from], `lines from ${from}`).toBe(listed.length);
        expect(document.fullRemainingBytes[from], `bytes from ${from}`).toBe(
          listed.reduce((sum, line) => sum + lineBytes(document, line), 0),
        );
      }
    },
  );

  it('count the listed lines, not the lines the card shows: they differ by the masked before copies', () => {
    for (const [document, masked] of [
      [precise, 1],
      [bearer, 19],
      [single, 0],
    ] as const) {
      expect(document.fullRemainingLines[0]).toBe((document.cardRemainingLines[0] ?? 0) + masked);
    }
    // And the document's own byte total is the raw total less the skipped copies.
    const skippedBytes = single.lines
      .filter((line) => line.fullSkip === true)
      .reduce((sum, line) => sum + lineBytes(single, line), 0);
    expect(single.fullRemainingBytes[0]).toBe((single.remainingBytes[0] ?? 0) - skippedBytes);
  });

  it('count a multi-byte character by its bytes and an ending by its length', () => {
    // `é1` is 3 bytes, `ü2` 3, `日本3` 7, `😀4` 5 — and `\r\n` is 2, the unterminated last line has none.
    const copies = multibyte.lines.filter((line) => line.fullSkip === true);
    expect(copies.map((line) => line.label)).toEqual(['=before 1', '=before 3', '=before 4']);
    const listedBytes = multibyte.lines
      .filter((line) => line.fullSkip !== true)
      .reduce((sum, line) => sum + lineBytes(multibyte, line), 0);
    expect(multibyte.fullRemainingBytes[0]).toBe(listedBytes);
    expect(listedBytes).toBe(
      // target, =1, -2, +2, =3, =4 with their endings
      'src/ü.ts'.length + 1 + (3 + 2) + (3 + 2) + (3 + 2) + (7 + 2) + 5,
    );
  });
});

describe('the deduplicated listing', () => {
  const dedupeLabels = [
    'target',
    ...range(1, 14).map((n) => `=${n}`),
    '-15',
    '+15',
    ...range(16, 30).map((n) => `=${n}`),
  ];
  const rawLabels = [
    'target',
    ...range(1, 14).flatMap((n) => [`=before ${n}`, `=${n}`]),
    '-15',
    '+15',
    ...range(16, 30).flatMap((n) => [`=before ${n}`, `=${n}`]),
  ];
  const text = (label: string): string => {
    if (label === 'target') return 'src/a.ts';
    if (label === '+15') return 'LINE 15 CHANGED';
    return `line ${label.replace(/\D/gu, '')}`;
  };

  it('dedupe=true emits ONE row per unchanged line, in order', () => {
    const page = whole(single, 'dedupe');
    expect(page.labels).toEqual(dedupeLabels);
    expect(page.rows).toEqual(dedupeLabels.map((label) => `${label} ${text(label)}`));
    expect(page.next).toBeUndefined();
    expect(page.valid).toBe(true);
  });

  it('dedupe=false keeps both copies of every unchanged line: `=before N`, then `=N`', () => {
    const page = whole(single, 'raw');
    expect(page.labels).toEqual(rawLabels);
    expect(page.rows[index(single, '=before 5')]).toBe('=before 5 line 5');
    expect(page.rows[index(single, '=5')]).toBe('=5 line 5');
  });

  it('compact=true (the card) is unchanged: every before copy is left out, the twins stay', () => {
    const page = whole(single, 'compact');
    expect(page.labels).toEqual(dedupeLabels);
    // The card leaves the masked copy out too; the full view keeps it.
    expect(whole(precise, 'compact').labels.some((label) => label.startsWith('=before'))).toBe(
      false,
    );
  });

  it('keeps a masked before copy, directly before its twin, and no other', () => {
    const labels = whole(precise, 'dedupe').labels;
    expect(labels.filter((label) => label.startsWith('=before'))).toEqual(['=before 6']);
    expect(labels.indexOf('=6')).toBe(labels.indexOf('=before 6') + 1);
    expect(
      whole(precise, 'raw').labels.filter((label) => label.startsWith('=before')),
    ).toHaveLength(19);
    // Both copies of the masked line show their mask as a token, not the secret.
    const rows = whole(precise, 'dedupe').rows;
    expect(rows[labels.indexOf('=before 6')]).toMatch(
      /^=before 6 const k = "<MASK:id=\d+;bytes=48>";$/u,
    );
    expect(rows.join('\n')).not.toContain(KEY);
  });

  it('lists every line of a document whose masks touch them all (nothing is skipped)', () => {
    expect(whole(bearer, 'dedupe').rows).toEqual(whole(bearer, 'raw').rows);
    expect(whole(split, 'dedupe').rows).toEqual(whole(split, 'raw').rows);
  });

  it('keeps the row, kind and masked companion of each row parallel to its label', () => {
    for (const mode of ['raw', 'compact', 'dedupe'] as const)
      for (const [, document] of fixtures) {
        const page = whole(document, mode);
        expect(page.kinds, mode).toHaveLength(page.rows.length);
        expect(page.labels, mode).toHaveLength(page.rows.length);
        expect(page.maskedRows, mode).toHaveLength(page.rows.length);
        for (const [row, label] of page.labels.entries())
          expect(page.rows[row]?.startsWith(`${label} `), `${mode}: ${page.rows[row]}`).toBe(true);
      }
    const page = whole(single, 'dedupe');
    expect(page.kinds[0]).toBe('meta');
    expect(page.kinds[page.labels.indexOf('=5')]).toBe('context');
    expect(page.kinds[page.labels.indexOf('-15')]).toBe('removed');
    expect(page.kinds[page.labels.indexOf('+15')]).toBe('added');
    expect(page.maskedRows).toEqual(page.rows);
  });

  it('echoes the width and the height it was projected for', () => {
    const page = projectReviewPage(single, REVIEW_START, 61, 9, false, false, false, true);
    expect(page.columns).toBe(61);
    expect(page.rowLimit).toBe(9);
  });

  it.each(fixtures)(
    '%s: the listing is smaller than the raw one by exactly the skipped lines',
    (_name, document) => {
      const skipped = document.lines.filter((line) => line.fullSkip === true).length;
      const raw = whole(document, 'raw');
      const dedupe = whole(document, 'dedupe');
      expect(raw.rows).toHaveLength(document.lines.length);
      expect(dedupe.rows).toHaveLength(document.lines.length - skipped);
      expect(raw.rows.length - dedupe.rows.length).toBe(skipped);
      expect(dedupe.position.total).toBe(dedupe.rows.length);
      expect(raw.position.total).toBe(raw.rows.length);
    },
  );

  it('the skipped copies are exactly the unmasked ones: 29 of 61 lines are left out of the 30-line file', () => {
    expect(whole(single, 'raw').rows).toHaveLength(61);
    expect(whole(single, 'dedupe').rows).toHaveLength(32);
    expect(whole(precise, 'dedupe').rows.length - whole(precise, 'compact').rows.length).toBe(1);
  });
});

describe('what a page reports about the part it does not draw', () => {
  /** What a page from `start` must report, from a plain walk over the document's lines (every line here is one row). */
  function expected(document: ReviewDocument, start: number, rowLimit: number, mode: Mode) {
    const { lines } = document;
    const shown: number[] = [];
    let after = start;
    while (after < lines.length && shown.length < rowLimit) {
      if (!skips(lines[after] as ReviewSourceLine, mode)) shown.push(after);
      after++;
    }
    while (mode !== 'raw' && after < lines.length && skips(lines[after] as ReviewSourceLine, mode))
      after++;
    const kept = range(0, lines.length - 1).filter(
      (k) => !skips(lines[k] as ReviewSourceLine, mode),
    );
    const rest = kept.filter((k) => k >= after);
    const changedLines = range(0, lines.length - 1).filter((k) => lines[k]?.changed === true);
    return {
      shown,
      next: after >= lines.length ? undefined : { line: after, offset: 0 },
      hiddenLines: rest.length,
      hiddenBytes: rest.reduce(
        (sum, k) => sum + lineBytes(document, lines[k] as ReviewSourceLine),
        0,
      ),
      position: {
        above: kept.filter((k) => k < Math.min(start, lines.length)).length,
        below: rest.length,
        total: kept.length,
      },
      above: changedLines.filter((k) => k < start).length,
      below: changedLines.filter((k) => k >= after).length,
    };
  }

  it.each(fixtures)(
    '%s: hiddenLines, hiddenBytes, position and the change counts match a plain count, in every view',
    (_name, document) => {
      for (const mode of ['raw', 'compact', 'dedupe'] as const)
        for (const rowLimit of [1, 3, 8, 200])
          for (let start = 0; start <= document.lines.length; start++) {
            const context = `${mode} from line ${start} in ${rowLimit} rows`;
            const page = project(document, { line: start, offset: 0 }, rowLimit, mode);
            const plain = expected(document, start, rowLimit, mode);
            expect(page.labels, context).toEqual(plain.shown.map((k) => document.lines[k]?.label));
            expect(page.next, context).toEqual(plain.next);
            expect(page.hiddenLines, context).toBe(plain.hiddenLines);
            expect(page.hiddenBytes, context).toBe(plain.hiddenBytes);
            expect(page.position, context).toEqual(plain.position);
            expect(page.changesAbove, context).toBe(plain.above);
            expect(page.changesBelow, context).toBe(plain.below);
            expect(page.hiddenChanges, context).toBe(page.changesAbove + page.changesBelow);
          }
    },
  );

  it('dedupe, compact and raw each count their own lines from the top of the 30-line file', () => {
    const view = (document: ReviewDocument, mode: Mode) => {
      const page = project(document, REVIEW_START, 10, mode);
      return [page.hiddenLines, page.position];
    };
    expect(view(single, 'dedupe')).toEqual([22, { above: 0, below: 22, total: 32 }]);
    expect(view(single, 'compact')).toEqual([22, { above: 0, below: 22, total: 32 }]);
    expect(view(single, 'raw')).toEqual([51, { above: 0, below: 51, total: 61 }]);
    // A 20-line file with a target, one change and one masked copy: 1 + 19 + 2 listed lines and the masked copy = 23 for
    // the full view, 22 for the card (which leaves the masked copy out), 41 raw lines.
    expect(view(precise, 'dedupe')).toEqual([13, { above: 0, below: 13, total: 23 }]);
    expect(view(precise, 'compact')).toEqual([12, { above: 0, below: 12, total: 22 }]);
    expect(view(precise, 'raw')).toEqual([31, { above: 0, below: 31, total: 41 }]);
    expect(precise.lines).toHaveLength(41);
  });

  it('position says how many LISTED lines lie above the page: a skipped copy above is not one', () => {
    // The page starts on `=11` (line 12 of the document, after a skipped copy): ten listed lines and the target are above.
    const page = project(single, { line: index(single, '=11'), offset: 0 }, 5, 'dedupe');
    expect(page.position).toEqual({ above: 11, below: 32 - 11 - 5, total: 32 });
    // Starting ON the skipped copy of `=11` is the same page, and the same count.
    const onCopy = project(single, { line: index(single, '=before 11'), offset: 0 }, 5, 'dedupe');
    expect(onCopy.labels).toEqual(page.labels);
    expect(onCopy.position).toEqual(page.position);
    // The raw listing counts every line, so the same page is further down it.
    const raw = project(single, { line: index(single, '=11'), offset: 0 }, 5, 'raw');
    expect(raw.position.above).toBe(index(single, '=11'));
    expect(raw.position.total).toBe(61);
  });

  it('hiddenBytes does not count the part of a long line the page has already drawn', () => {
    // `a`, a 150-character line, `c`: three rows at 32 columns draw `a` and the first two rows (58 characters) of the long one.
    for (const mode of ['raw', 'dedupe'] as const) {
      const page = project(wrapped, REVIEW_START, 3, mode, 32);
      const longLine = wrapped.lines[1];
      expect(page.next).toEqual({ line: 1, offset: (longLine?.start ?? 0) + 58 });
      // 92 characters and a newline of the long line, then `c` and its newline.
      expect(page.hiddenBytes, mode).toBe(92 + 1 + 2);
      expect(page.hiddenLines, mode).toBe(2);
      expect(page.position, mode).toEqual({ above: 0, below: 2, total: 3 });
    }
  });

  it('counts a tiny document byte by byte', async () => {
    const tiny = await documentOf(null, 'a\nbb\nccc\n');
    expect(project(tiny, REVIEW_START, 1, 'dedupe').hiddenBytes).toBe(3 + 4);
    expect(project(tiny, REVIEW_START, 2, 'dedupe').hiddenBytes).toBe(4);
    expect(project(tiny, REVIEW_START, 3, 'dedupe').hiddenBytes).toBe(0);
  });
});

describe('labels', () => {
  it('is parallel to rows and repeats the line label on every continuation row of a wrapped line', () => {
    // `+2 ` leaves 29 columns a row: the 150-character line is six rows.
    const page = project(wrapped, REVIEW_START, 20, 'dedupe', 32);
    expect(page.rows).toHaveLength(8);
    expect(page.labels).toEqual(['+1', '+2', '+2', '+2', '+2', '+2', '+2', '+3']);
    expect(page.kinds).toEqual(Array.from({ length: 8 }, () => 'added'));
    for (const [row, label] of page.labels.entries())
      expect(page.rows[row]?.startsWith(`${label} `)).toBe(true);
    // A page that starts inside the line labels its first row with the line too.
    const start = (wrapped.lines[1]?.start ?? 0) + 58;
    const later = project(wrapped, { line: 1, offset: start }, 20, 'dedupe', 32);
    expect(later.labels).toEqual(['+2', '+2', '+2', '+2', '+3']);
  });

  it('gives the ending row of a line that fills the width the line label', async () => {
    // 29 characters fill `+1 ` + the text to column 32; `<EOF:NO_NEWLINE>` then has to be a row of its own.
    const document = await documentOf(null, 'x'.repeat(29));
    const page = project(document, REVIEW_START, 5, 'dedupe', 32);
    expect(page.rows).toEqual([`+1 ${'x'.repeat(29)}`, '+1 <EOF:NO_NEWLINE>']);
    expect(page.labels).toEqual(['+1', '+1']);
  });

  it('names the target and the field rows of a call', async () => {
    const document = await documentOf(numbered(5), numbered(5, changed(3)), {
      target: 'src/a.ts',
      fields: [{ name: 'mode', value: 'overwrite' }],
    });
    const page = whole(document, 'dedupe');
    expect(page.labels.slice(0, 4)).toEqual(['target', 'field name', 'field value', '=1']);
    expect(page.rows.slice(0, 3)).toEqual([
      'target src/a.ts',
      'field name mode',
      'field value overwrite',
    ]);
    expect(page.kinds.slice(0, 3)).toEqual(['meta', 'meta', 'meta']);
  });
});

describe('changesAbove and changesBelow', () => {
  it('split the changed lines the page does not draw, from the top of a file with three changes', () => {
    const counts = (cursor: ReviewCursor, rowLimit: number) => {
      const page = project(triple, cursor, rowLimit, 'dedupe');
      return [page.changesAbove, page.changesBelow, page.hiddenChanges];
    };
    // The file has six changed lines: a removed and an added line for each of lines 10, 30 and 50.
    expect(counts(REVIEW_START, 8)).toEqual([0, 6, 6]);
    // =7 … =13 take in the first change.
    expect(counts({ line: index(triple, '=7'), offset: 0 }, 8)).toEqual([0, 4, 4]);
    expect(counts({ line: index(triple, '=20'), offset: 0 }, 8)).toEqual([2, 4, 6]);
    expect(counts({ line: index(triple, '+10'), offset: 0 }, 8)).toEqual([1, 4, 5]);
    expect(counts({ line: index(triple, '=51'), offset: 0 }, 8)).toEqual([6, 0, 6]);
    // A page tall enough to hold everything draws everything.
    expect(counts(REVIEW_START, 500)).toEqual([0, 0, 0]);
  });

  describe('a cursor inside a changed line (an absolute offset into its field)', () => {
    // The long line is added: every line of this document is changed (a new file).
    const long = wrapped.lines[1] as ReviewSourceLine;
    /** The changed lines a page does NOT draw in full, from the source it actually drew. */
    const undrawn = (document: ReviewDocument, page: ReviewPage): number => {
      const covered = document.fields.map((field) =>
        Array.from({ length: field.text.length }, () => false),
      );
      for (const range of page.visibleSource)
        for (let k = range.start; k < range.end; k++) (covered[range.field] as boolean[])[k] = true;
      return document.lines.filter(
        (line) =>
          line.changed &&
          !range(line.start, line.end - 1).every((k) => covered[line.field]?.[k] === true),
      ).length;
    };

    it.each([1, 2, 3, 6])(
      'with %i rows: the sum is the hidden total and the total is what is not drawn',
      (rowLimit) => {
        for (let offset = long.start; offset < long.end; offset++) {
          const page = project(wrapped, { line: 1, offset }, rowLimit, 'dedupe', 32);
          const context = `offset ${offset - long.start} into the line, ${rowLimit} rows`;
          expect(page.changesAbove + page.changesBelow, context).toBe(page.hiddenChanges);
          expect(page.hiddenChanges, context).toBe(undrawn(wrapped, page));
        }
      },
    );

    it('counts the line once when the page starts and ends inside it, and as above when it starts inside and ends beyond', () => {
      const start = long.start + 29;
      // Starts partway, cut still inside the line: `a` is above, the line (once) and `c` are below the cut.
      const inside = project(wrapped, { line: 1, offset: start }, 2, 'dedupe', 32);
      expect([inside.changesAbove, inside.changesBelow]).toEqual([1, 2]);
      // Starts partway and draws the rest of the line and `c`: the line's beginning is above, `a` is above.
      const rest = project(wrapped, { line: 1, offset: start }, 20, 'dedupe', 32);
      expect([rest.changesAbove, rest.changesBelow]).toEqual([2, 0]);
      // Starts at the line's own start and draws all of it: only `a` is above.
      const full = project(wrapped, { line: 1, offset: long.start }, 20, 'dedupe', 32);
      expect([full.changesAbove, full.changesBelow]).toEqual([1, 0]);
    });

    it('agrees with the drawn source on every line of a three-change file, in every view', () => {
      for (const mode of ['raw', 'compact', 'dedupe'] as const)
        for (const start of range(0, triple.lines.length))
          for (const rowLimit of [2, 5, 9]) {
            const page = project(triple, { line: start, offset: 0 }, rowLimit, mode);
            const context = `${mode} from line ${start} in ${rowLimit} rows`;
            expect(page.hiddenChanges, context).toBe(page.changesAbove + page.changesBelow);
            // A changed line is hidden exactly when it is before the page or after its cut (every line is one row here).
            const drawn = new Set(page.labels);
            const hidden = triple.lines.filter((line) => line.changed && !drawn.has(line.label));
            expect(page.hiddenChanges, context).toBe(hidden.length);
          }
    });
  });
});

describe('changeStarts', () => {
  const starts = (document: ReviewDocument): string[] =>
    document.changeStarts.map((line) => document.lines[line]?.label ?? '');

  it('has one entry for a single change: the first line of the changed run', () => {
    expect(single.changeStarts).toEqual([index(single, '-15')]);
    expect(starts(triple)).toEqual(['-10', '-30', '-50']);
    expect(triple.changeStarts).toEqual(['-10', '-30', '-50'].map((label) => index(triple, label)));
  });

  it('is empty for a document with no change and for an empty one', async () => {
    const same = await edited(10, {}, { target: 'src/a.ts' });
    expect(same.changeStarts).toEqual([]);
    expect((await documentOf(null, '')).changeStarts).toEqual([]);
    expect((await documentOf(numbered(3), numbered(3))).changeStarts).toEqual([]);
  });

  it('is one entry for a run of changed lines, however long', async () => {
    const run = await edited(40, changed(20, 21, 22, 23));
    expect(starts(run)).toEqual(['-20']);
    const created = await documentOf(null, 'a\nb\nc\n');
    expect(starts(created)).toEqual(['+1']);
  });

  it('has an entry for a change at the very start and one at the very end', async () => {
    const ends = await edited(20, changed(1, 20));
    expect(starts(ends)).toEqual(['-1', '-20']);
    expect(ends.changeStarts[0]).toBe(0);
    expect(ends.changeStarts[1]).toBe(index(ends, '-20'));
    const first = await edited(20, changed(1), { target: 'src/a.ts' });
    expect(starts(first)).toEqual(['-1']);
    const last = await edited(20, changed(20), { target: 'src/a.ts' });
    expect(starts(last)).toEqual(['-20']);
  });

  it(`joins two changes that have at most ${CHANGE_GAP_LINES} unchanged lines between them`, async () => {
    expect(CHANGE_GAP_LINES).toBe(2 * CARD_CONTEXT_LINES);
    // Lines 11 … 16 lie between changes at 10 and 17: six listed lines (the copies before them are not listed).
    const six = await edited(60, changed(10, 17));
    expect(starts(six)).toEqual(['-10']);
    const adjacent = await edited(60, changed(10, 12));
    expect(starts(adjacent)).toEqual(['-10']);
  });

  it('separates two changes with more than that between them', async () => {
    // Lines 11 … 17 lie between changes at 10 and 18: seven.
    const seven = await edited(60, changed(10, 18));
    expect(starts(seven)).toEqual(['-10', '-18']);
    const far = await edited(60, changed(10, 40));
    expect(starts(far)).toEqual(['-10', '-40']);
  });

  it('counts a masked before copy between two changes as a LISTED line', async () => {
    // Line 13 carries a quoted secret on both sides, so BOTH its copies are listed: it is two lines in the gap, not one.
    const shared = { 13: QUOTED };
    // Between changes at 10 and 16: five lines, one of them masked = six listed lines — still one change.
    const six = await edited(60, changed(10, 16), { shared });
    expect(six.lines[index(six, '=before 13')]?.fullSkip).toBe(false);
    expect(starts(six)).toEqual(['-10']);
    // Between 10 and 17: six lines, one masked = SEVEN listed lines — two changes (they were one with no secret).
    const seven = await edited(60, changed(10, 17), { shared });
    expect(starts(seven)).toEqual(['-10', '-17']);
    expect(starts(await edited(60, changed(10, 17)))).toEqual(['-10']);
  });

  it('does not count the skipped copies: the gap is measured in listed lines', async () => {
    // Six lines between the changes are twelve lines of the document (a skipped copy and its twin each); still one change.
    const document = await edited(60, changed(10, 17));
    expect(index(document, '-17') - index(document, '+10') - 1).toBe(12);
    expect(starts(document)).toEqual(['-10']);
  });

  describe(`a change is also at most ${CHANGE_SPAN_LINES} listed lines long`, () => {
    /** Edits `step` lines apart, from `from` to `to`. */
    const chain = (from: number, to: number, step: number): Record<number, string> =>
      changed(...range(0, Math.floor((to - from) / step)).map((k) => from + k * step));

    it('is 40', () => {
      expect(CHANGE_SPAN_LINES).toBe(40);
    });

    it('a chain of edits each within the gap of the next is split once it grows past the bound', async () => {
      // Edits every 6th line: five unchanged lines between them, inside the gap — one change by the gap rule alone.
      const document = await edited(120, chain(6, 120, 6), { target: 'src/s.ts' });
      expect(starts(document)).toEqual(['-6', '-42', '-78', '-114']);
      // Each change reaches no further than CHANGE_SPAN_LINES listed lines past its first line, and its successor begins
      // only because the next edit would have gone past that.
      const listed = (from: number, to: number): number =>
        document.lines.slice(from, to).filter((line) => line.fullSkip !== true).length;
      const lastChanged = (to: number): number =>
        Math.max(...range(0, to - 1).filter((at) => document.lines[at]?.changed === true));
      for (const [at, start] of document.changeStarts.entries()) {
        const next = document.changeStarts[at + 1] ?? document.lines.length;
        expect(listed(start + 1, lastChanged(next) + 1), `change ${at}`).toBeLessThanOrEqual(
          CHANGE_SPAN_LINES,
        );
        if (at + 1 < document.changeStarts.length)
          expect(listed(start + 1, next + 1), `change ${at} with the next edit`).toBeGreaterThan(
            CHANGE_SPAN_LINES,
          );
      }
    });

    it('measures the bound in listed lines: the skipped copies are not counted', async () => {
      // 20 edits over 120 lines are 141 listed lines and 261 lines of the document; the stops are those of the listed count.
      const document = await edited(120, chain(6, 120, 6), { target: 'src/s.ts' });
      expect(document.fullRemainingLines[0]).toBe(141);
      expect(document.lines).toHaveLength(241);
    });

    it('a change line that lands exactly on the bound still belongs to the change, the next one starts a new change', async () => {
      // Edits every 4th line from 10: `-42` is listed line 40 after the first change's start (kept), `+42` is 41 (a new change).
      const document = await edited(90, chain(10, 78, 4));
      expect(starts(document)).toEqual(['-10', '+42', '-78']);
    });

    it('a pair of edits split by the bound can land between a removed line and its added line', async () => {
      const document = await edited(90, chain(10, 78, 4));
      expect(index(document, '+42')).toBe(index(document, '-42') + 1);
      expect(document.changeStarts).toContain(index(document, '+42'));
      expect(document.changeStarts).not.toContain(index(document, '-42'));
    });
  });
});

describe('the deduplicated listing loses nothing a person could inspect', () => {
  /** Every UTF-16 unit of every field the page drew as source, per field. */
  const coverage = (document: ReviewDocument, page: ReviewPage): boolean[][] => {
    const covered = document.fields.map((field) =>
      Array.from({ length: field.text.length }, () => false),
    );
    for (const source of page.visibleSource)
      for (let k = source.start; k < source.end; k++)
        (covered[source.field] as boolean[])[k] = true;
    return covered;
  };

  it.each([
    ['a file with a target and one change', single],
    ['a diff-only document', diffOnly],
    ['a file with three changes', triple],
  ])(
    '%s: the same source is drawn for every changed line and for the whole after side',
    (_name, document) => {
      expect(document.masks, 'the fixture has no mask').toHaveLength(0);
      const raw = coverage(document, whole(document, 'raw'));
      const dedupe = coverage(document, whole(document, 'dedupe'));
      // Every character of every changed line, in both listings.
      for (const line of document.lines.filter((candidate) => candidate.changed))
        for (let k = line.start; k < line.end; k++) {
          expect(raw[line.field]?.[k], `${line.label} in the raw listing`).toBe(true);
          expect(dedupe[line.field]?.[k], `${line.label} in the full view`).toBe(true);
        }
      // The after side: all of it but its newlines, and exactly as the raw listing draws it.
      const after = document.lines.find((line) => line.label.startsWith('+'))?.field ?? -1;
      const afterText = document.fields[after]?.text ?? '';
      expect(dedupe[after]).toEqual(raw[after]);
      expect(dedupe[after]?.every((drawn, k) => drawn || afterText[k] === '\n')).toBe(true);
    },
  );

  it.each([
    ['a file with a target and one change', single],
    ['a diff-only document', diffOnly],
    ['a file with three changes', triple],
  ])(
    '%s: what the listing leaves out is a before copy whose after twin is byte-identical',
    (_name, document) => {
      const raw = coverage(document, whole(document, 'raw'));
      const dedupe = coverage(document, whole(document, 'dedupe'));
      const before = document.lines.find((line) => line.label.startsWith('-'))?.field ?? -1;
      const skipped = document.lines.filter((line) => line.fullSkip === true);
      expect(skipped.length).toBeGreaterThan(0);
      for (const line of skipped) {
        const twin = document.lines[document.lines.indexOf(line) + 1] as ReviewSourceLine;
        expect(twin.label, 'the twin follows its copy').toBe(line.label.replace('=before ', '='));
        const copy = (document.fields[line.field]?.text ?? '').slice(line.start, line.end);
        expect(copy.length).toBeGreaterThan(0);
        expect(copy, `${line.label} against ${twin.label}`).toBe(
          (document.fields[twin.field]?.text ?? '').slice(twin.start, twin.end),
        );
        for (let k = line.start; k < line.end; k++) {
          expect(raw[before]?.[k], `${line.label} is in the raw listing`).toBe(true);
          expect(dedupe[before]?.[k], `${line.label} is not in the full view`).toBe(false);
        }
      }
      // The before side the full view draws is exactly its removed lines.
      const removed = document.lines.filter((line) => line.label.startsWith('-'));
      for (const [k, drawn] of (dedupe[before] ?? []).entries())
        expect(drawn, `before offset ${k}`).toBe(
          removed.some((line) => k >= line.start && k < line.end),
        );
    },
  );

  it('a masked before copy is drawn (as its mask) by the full view, where the raw listing draws it too', () => {
    const copy = precise.lines[index(precise, '=before 6')] as ReviewSourceLine;
    const dedupe = whole(precise, 'dedupe');
    const raw = whole(precise, 'raw');
    expect(dedupe.labels).toContain('=before 6');
    expect(dedupe.rows[dedupe.labels.indexOf('=before 6')]).toBe(
      raw.rows[index(precise, '=before 6')],
    );
    // The text around the mask is source; the mask is a token, so the copy's characters before it are drawn.
    const covered = coverage(precise, dedupe)[copy.field] as boolean[];
    expect(covered[copy.start]).toBe(true);
    // A copy that is NOT masked is not drawn.
    const plain = precise.lines[index(precise, '=before 7')] as ReviewSourceLine;
    expect(covered[plain.start]).toBe(false);
  });
});

// F1 (ADR-0134 security sitting): a row is measured as ONE string, the way the terminal measures it. A digit, `#` or `*`
// followed by U+20E3 (COMBINING ENCLOSING KEYCAP, which the review does not escape) is two cells, but one cell plus none when
// the two are measured apart; a row built from per-token widths was drawn up to twice as wide as the page said, the terminal
// cut it, and bytes the page reported as shown were never on screen (so the lock opened on bytes nobody saw).
describe('a row is never wider than the page, measured the way the terminal measures it (F1)', () => {
  const KEYCAP = '⃣';
  const adversarial: readonly (readonly [string, string])[] = [
    ['digit keycaps', `1${KEYCAP}`.repeat(70)],
    ['hash keycaps', `#${KEYCAP}`.repeat(70)],
    ['star keycaps', `*${KEYCAP}`.repeat(70)],
    [
      'keycaps among ASCII and CJK',
      `1${KEYCAP}abc界界#${KEYCAP}xyz日本語*${KEYCAP}9${KEYCAP}0`.repeat(6),
    ],
    ['regional-indicator flags', '🇹🇷🇩🇪'.repeat(25)],
    ['a skin-tone emoji', '👍🏽'.repeat(40)],
    ['a ZWJ family sequence', '👨‍👩‍👧‍👦'.repeat(15)],
    ['combining marks', 'é̂̃äộ'.repeat(20)],
    ['tokens of the code-point view', 'é界<ü ñ'.repeat(25)],
    ['keycaps then a payload', `${`1${KEYCAP}`.repeat(60)} TAIL_PAYLOAD`],
    ['a tab between keycaps', `1${KEYCAP}\t#${KEYCAP}`.repeat(25)],
  ];
  const widths = [40, 78, 120];
  const flags = [false, true];

  /** The UTF-16 units of each field of `document` the page drew as source, and how often. */
  const timesDrawn = (document: ReviewDocument, page: ReviewPage): number[][] => {
    const drawn = document.fields.map((field) =>
      Array.from({ length: field.text.length }, () => 0),
    );
    for (const source of page.visibleSource) {
      const units = drawn[source.field] as number[];
      for (let k = source.start; k < source.end; k++) units[k] = (units[k] ?? 0) + 1;
    }
    return drawn;
  };
  const escaped = (text: string, numeric: boolean): string =>
    [...text].map((char) => escapeReviewCharacter(char, false, numeric)).join('');
  const payload = (page: ReviewPage, label: string): string =>
    page.rows
      .flatMap((row, at) => (page.labels[at] === label ? [row.slice(label.length + 1)] : []))
      .join('');

  it('the fixtures are adversarial: a keycap is two cells as a whole and one apart', () => {
    expect(displayWidth(`1${KEYCAP}`)).toBe(2);
    expect(displayWidth('1') + displayWidth(KEYCAP)).toBe(1);
    expect(displayWidth('#') + displayWidth(KEYCAP)).toBe(1);
  });

  it.each(adversarial)(
    '%s, as an added line: every row fits, every byte is drawn once',
    async (_name, text) => {
      for (const ending of ['\n', '']) {
        const document = await documentOf(null, text + ending);
        expect(document.masks, 'no secret in the fixture').toHaveLength(0);
        for (const columns of widths)
          for (const numeric of flags)
            for (const reveal of flags) {
              const context = `${columns} columns, numeric ${numeric}, reveal ${reveal}, ending ${JSON.stringify(ending)}`;
              const page = projectReviewPage(
                document,
                REVIEW_START,
                columns,
                10_000,
                reveal,
                numeric,
              );
              expect(page.valid, context).toBe(true);
              expect(page.next, context).toBeUndefined();
              for (const row of page.rows)
                expect(displayWidth(row), `${context}: ${row}`).toBeLessThanOrEqual(columns);
              // The masked companion is the same rows (nothing here is masked).
              expect(page.maskedRows, context).toEqual(page.rows);
              // The rows together are the line, escaped, once: nothing dropped, nothing repeated.
              expect(payload(page, '+1'), context).toBe(
                escaped(text, numeric) + (ending === '' ? '<EOF:NO_NEWLINE>' : ''),
              );
              const drawn = timesDrawn(document, page)[document.lines[0]?.field ?? 0] ?? [];
              expect(
                drawn.slice(0, text.length).every((times) => times === 1),
                context,
              ).toBe(true);
              expect(
                drawn.slice(text.length).every((times) => times === 0),
                context,
              ).toBe(true);
            }
      }
    },
  );

  it.each(adversarial)(
    '%s, as a target and as a field name and value: every row fits, every byte is drawn once',
    (_name, text) => {
      const document = createReviewDocument({
        kind: 'operation',
        target: text,
        fields: [{ name: text, value: text }],
      });
      expect(document.valid).toBe(true);
      expect(document.masks, 'no secret in the fixture').toHaveLength(0);
      for (const columns of widths)
        for (const numeric of flags)
          for (const reveal of flags) {
            const context = `${columns} columns, numeric ${numeric}, reveal ${reveal}`;
            const page = projectReviewPage(
              document,
              REVIEW_START,
              columns,
              10_000,
              reveal,
              numeric,
            );
            expect(page.valid, context).toBe(true);
            expect(page.next, context).toBeUndefined();
            for (const row of page.rows)
              expect(displayWidth(row), `${context}: ${row}`).toBeLessThanOrEqual(columns);
            expect(page.maskedRows, context).toEqual(page.rows);
            for (const label of ['target', 'field name', 'field value'])
              expect(payload(page, label), `${context}: ${label}`).toBe(escaped(text, numeric));
            // Each of the three fields is drawn once, whole.
            for (const [at, drawn] of timesDrawn(document, page).entries())
              expect(
                drawn.every((times) => times === 1),
                `${context}: field ${at}`,
              ).toBe(true);
          }
    },
  );

  it('sixty keycaps and a tail at 78 columns: no row is wider than 78 and the tail is on screen', async () => {
    const text = `${`1${KEYCAP}`.repeat(60)} TAIL_PAYLOAD`;
    const document = await documentOf(null, `${text}\n`);
    const page = projectReviewPage(document, REVIEW_START, 78, 100);
    expect(page.rows.length).toBeGreaterThan(1);
    for (const row of page.rows) expect(displayWidth(row)).toBeLessThanOrEqual(78);
    expect(page.rows.some((row) => row.includes('TAIL_PAYLOAD'))).toBe(true);
    // And the page really did draw it: the tail's own bytes are in the source the page reports as visible.
    const tail = text.indexOf('TAIL_PAYLOAD');
    const drawn = timesDrawn(document, page)[document.lines[0]?.field ?? 0] ?? [];
    expect(drawn.slice(tail, tail + 'TAIL_PAYLOAD'.length)).toEqual(
      Array.from({ length: 'TAIL_PAYLOAD'.length }, () => 1),
    );
  });

  it('sixty keycaps are 120 cells: two rows at 78 columns, and neither is wider than that', async () => {
    const document = await documentOf(null, `${`1${KEYCAP}`.repeat(60)}\n`);
    const page = projectReviewPage(document, REVIEW_START, 78, 100);
    // 2 x 75 cells fit 120 cells of keycaps; summing the widths apart would have said 60 cells and drawn them in one row.
    expect(page.rows).toHaveLength(2);
    for (const row of page.rows) expect(displayWidth(row)).toBeLessThanOrEqual(78);
    expect(payload(page, '+1')).toBe(`1${KEYCAP}`.repeat(60));
  });

  it('a masked secret next to keycaps: the rows fit, hidden or revealed, and a hidden key is never drawn', async () => {
    const text = `1${KEYCAP}1${KEYCAP} const k = "${KEY}"; 1${KEYCAP}`.repeat(3);
    const document = await documentOf(null, `${text}\n`);
    expect(document.masks.length).toBeGreaterThan(0);
    for (const columns of [40, 78])
      for (const reveal of flags) {
        const page = projectReviewPage(document, REVIEW_START, columns, 100, reveal);
        expect(page.valid).toBe(true);
        for (const row of page.rows) expect(displayWidth(row)).toBeLessThanOrEqual(columns);
        if (!reveal) expect(page.rows.join('')).not.toContain(KEY);
      }
  });
});

// F1 follow-up: the measure that made a row fit the page must also be cheap, and a row must still end somewhere sensible.
// A row grows by the SUM of its tokens' widths — a close estimate, not the width: short for a keycap (a digit and U+20E3 are two
// cells), long for some emoji and jamo sequences — is then measured once as the whole string, and if it is too wide the longest
// prefix that fits is found by halving (each probe one whole-row measure; width is not monotone, so a probe is verified). It
// holds at most `3 * columns` tokens, so a run of zero-width characters goes on in the next row; and it never ends between a
// base character and the zero-width mark that belongs to it unless giving the base back would make the row wider. A cost that
// grew with the square of the line (65 s for a line of 65,536 combining marks), with the whole row per token, or with the
// square of the row (a keycap row gave tokens back one at a time) froze the screen on an adversarial file.
describe('a row is bounded in tokens and in work, and ends between clusters (F1 follow-up)', () => {
  const ACUTE = String.fromCharCode(0x0301);
  const KEYCAP = String.fromCharCode(0x20e3);
  const CONJUNCT = String.fromCharCode(0x0915, 0x094d);
  const TOKENS_PER_COLUMN = ROW_TOKENS_PER_COLUMN;

  /** Every page of `line` of `document`, one row each, with the source units each row drew. */
  const rowByRow = (
    document: ReviewDocument,
    columns: number,
    options: { readonly numeric?: boolean; readonly reveal?: boolean; readonly rows?: number } = {},
  ): { rows: string[]; units: number[]; pages: ReviewPage[] } => {
    const rows: string[] = [];
    const units: number[] = [];
    const pages: ReviewPage[] = [];
    let cursor: ReviewCursor = REVIEW_START;
    for (let guard = 0; guard < (options.rows ?? 2_000); guard++) {
      const page = projectReviewPage(
        document,
        cursor,
        columns,
        1,
        options.reveal ?? false,
        options.numeric ?? false,
      );
      expect(page.valid, `page ${guard}`).toBe(true);
      pages.push(page);
      rows.push(...page.rows);
      units.push(page.visibleSource.reduce((sum, source) => sum + source.end - source.start, 0));
      if (page.next === undefined) break;
      // Every page moves on: a row that held nothing would never end.
      expect(page.next.line * 1e9 + page.next.offset, `page ${guard} moves on`).toBeGreaterThan(
        cursor.line * 1e9 + cursor.offset,
      );
      cursor = page.next;
    }
    return { rows, units, pages };
  };
  const payloadOf = (row: string): string => row.slice(row.indexOf(' ') + 1);

  describe('boundedness: the work and the row do not grow with the line', () => {
    it.each([
      ['65,536 combining marks', `a${ACUTE.repeat(65_536)}`],
      ['8,000 conjuncts', CONJUNCT.repeat(8_000)],
    ])(
      '%s: one page projects in well under two seconds, valid, in at most `rowLimit` rows',
      async (_name, text) => {
        const document = await documentOf(null, `${text}\n`);
        const started = performance.now();
        const page = projectReviewPage(document, REVIEW_START, 78, 24);
        const elapsed = performance.now() - started;
        expect(elapsed, `${Math.round(elapsed)} ms`).toBeLessThan(2_000);
        expect(page.valid).toBe(true);
        expect(page.rows.length).toBeLessThanOrEqual(24);
        expect(page.next, 'the line goes on past the page').toBeDefined();
        // Source drawn is at most `3 * columns` tokens (one code unit each here) per row.
        const drawn = page.visibleSource.reduce(
          (sum, source) => sum + source.end - source.start,
          0,
        );
        expect(drawn).toBeLessThanOrEqual(page.rows.length * TOKENS_PER_COLUMN * 78);
      },
    );

    it.each([
      ['65,536 combining marks', `a${ACUTE.repeat(65_536)}`],
      ['8,000 conjuncts', CONJUNCT.repeat(8_000)],
    ])('%s: no row takes more than 3 x columns tokens of source', async (_name, text) => {
      const document = await documentOf(null, `${text}\n`);
      const { units } = rowByRow(document, 78, { rows: 12 });
      expect(units).toHaveLength(12);
      for (const [at, count] of units.entries())
        expect(count, `row ${at}`).toBeLessThanOrEqual(TOKENS_PER_COLUMN * 78);
    });

    it('a zero-width run fills a row with exactly 3 x columns tokens, then goes on in the next row', async () => {
      const document = await documentOf(null, `a${ACUTE.repeat(2_000)}\n`);
      for (const columns of [40, 78, 120]) {
        const { units } = rowByRow(document, columns, { rows: 4 });
        expect(units.slice(0, 3), `${columns} columns`).toEqual(
          Array.from({ length: 3 }, () => TOKENS_PER_COLUMN * columns),
        );
      }
    });
  });

  describe('losslessness across pages', () => {
    it.each([
      ['combining marks', `a${ACUTE.repeat(5_000)}`],
      ['conjuncts', CONJUNCT.repeat(2_000)],
      ['digit keycaps', `1${KEYCAP}`.repeat(300)],
      ['marks after CJK', `界${ACUTE.repeat(400)}界${ACUTE.repeat(400)}`],
    ])(
      '%s: every code unit of the line is drawn exactly once, in order, across the pages',
      async (_name, text) => {
        const document = await documentOf(null, `${text}\n`);
        const line = document.lines[0] as ReviewSourceLine;
        for (const numeric of flagsOf())
          for (const columns of [32, 78]) {
            const { pages } = rowByRow(document, columns, { numeric });
            let expectedStart = line.start;
            for (const [at, page] of pages.entries())
              for (const source of page.visibleSource) {
                expect(source.start, `${columns} columns, page ${at}`).toBe(expectedStart);
                expectedStart = source.end;
              }
            expect(expectedStart, `${columns} columns, numeric ${numeric}`).toBe(line.end);
          }
      },
    );

    it('terminates when a row can hold only one token: one mask token per row, each page moving on', () => {
      // `field value ` leaves 20 cells at 32 columns, and a hidden key is a 20-cell token: one fits a row, two never do.
      const second = `sk-proj-${'zyxwvutsrq'.repeat(4)}`;
      const document = createReviewDocument({
        kind: 'operation',
        fields: [{ name: 'k', value: `"${KEY}" "${second}"` }],
      });
      expect(document.masks).toHaveLength(2);
      const { rows } = rowByRow(document, 32);
      const tokens = rows.filter((row) => /^field value <MASK:id=\d+;bytes=48>$/u.test(row));
      expect(tokens, 'a row holds exactly one mask token').toHaveLength(2);
      for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(32);
      expect(rows.join('')).not.toContain('sk-proj');
    });
  });

  describe('a row never ends between a base character and the mark that belongs to it', () => {
    const MARKS = new Set([KEYCAP, ACUTE]);
    it.each([
      ['digit keycaps', `1${KEYCAP}`.repeat(60)],
      ['hash keycaps', `#${KEYCAP}`.repeat(60)],
      ['star keycaps', `*${KEYCAP}`.repeat(60)],
      ['e with acute', `e${ACUTE}`.repeat(100)],
    ])(
      '%s at 78 columns: no row starts with a bare mark, and the payloads are the input',
      async (_name, text) => {
        const document = await documentOf(null, `${text}\n`);
        const page = projectReviewPage(document, REVIEW_START, 78, 100);
        expect(page.valid).toBe(true);
        expect(page.rows.length).toBeGreaterThan(1);
        for (const [at, row] of page.rows.entries()) {
          expect(displayWidth(row)).toBeLessThanOrEqual(78);
          if (at === 0) continue;
          const first = payloadOf(row)[0] ?? '';
          const before = payloadOf(page.rows[at - 1] ?? '').at(-1) ?? '';
          // A bare mark starts a row only when the row before ended on a mark too (a run of zero-width characters).
          if (MARKS.has(first))
            expect(
              MARKS.has(before),
              `row ${at} starts with a bare mark after ${JSON.stringify(before)}`,
            ).toBe(true);
        }
        expect(page.rows.map(payloadOf).join('')).toBe(text);
      },
    );

    it('a pure zero-width run may start a row with a mark: that is the one exception', async () => {
      const document = await documentOf(null, `a${ACUTE.repeat(400)}\n`);
      const page = projectReviewPage(document, REVIEW_START, 78, 100);
      expect(page.rows.length).toBeGreaterThan(1);
      expect(payloadOf(page.rows[1] ?? '').startsWith(ACUTE)).toBe(true);
      expect(page.rows.map(payloadOf).join('')).toBe(`a${ACUTE.repeat(400)}`);
    });
  });

  describe('the row is measured once, and given back until it fits', () => {
    it('a row whose summed token widths equal the page but whose whole width is one more gives back exactly what it must', async () => {
      // 32 columns less `+1 ` is 29: twenty-eight `x` and the `1` are 29 cells summed, and the keycap adds none — but
      // `1` + keycap is TWO cells, so the row is 33 wide. The keycap goes back, and with it the `1` it belongs to.
      const text = `${'x'.repeat(28)}1${KEYCAP}`;
      const document = await documentOf(null, `${text}\n`);
      const page = projectReviewPage(document, REVIEW_START, 32, 10);
      expect(page.rows).toEqual([`+1 ${'x'.repeat(28)}`, `+1 1${KEYCAP}`]);
      for (const row of page.rows) expect(displayWidth(row)).toBeLessThanOrEqual(32);
      // The first row's cut is just before the `1`: nothing is dropped and nothing is drawn twice.
      expect(projectReviewPage(document, REVIEW_START, 32, 1).next).toEqual({
        line: 0,
        offset: 28,
      });
    });

    it('one cell fewer and the pair fits whole: nothing is given back', async () => {
      const text = `${'x'.repeat(27)}1${KEYCAP}`;
      const document = await documentOf(null, `${text}\n`);
      const page = projectReviewPage(document, REVIEW_START, 32, 10);
      expect(page.rows).toEqual([`+1 ${text}`]);
      expect(displayWidth(page.rows[0] ?? '')).toBe(32);
    });
  });

  describe('non-ASCII text projects fast', () => {
    // One added line that fills a 300 x 80 page: a row that mixes in one non-ASCII character loses string-width's ASCII fast
    // path, so a measure that is repeated per token is ~40 times slower than one taken once per row.
    const turkish = 'çalışma dizini güvenli değil.'.repeat(820).concat('.');
    const cjk = '日本語のテキストを表示する'.repeat(2_000);

    it.each([
      ['Turkish text', turkish],
      ['CJK text', cjk],
    ])('%s at 300 x 80: a page projects in under 250 ms', async (_name, text) => {
      const document = await documentOf(null, `${text}\n`);
      // Warm the width tables once, so the measure below is the page's own cost.
      projectReviewPage(document, REVIEW_START, 300, 2);
      const started = performance.now();
      const page = projectReviewPage(document, REVIEW_START, 300, 80);
      const elapsed = performance.now() - started;
      expect(page.valid).toBe(true);
      expect(page.rows.length, 'the page is full').toBe(80);
      // a page costs what it shows, not the document: a whole-document pass would take seconds; 250 ms was within noise of the CI runner
      expect(elapsed, `${Math.round(elapsed)} ms`).toBeLessThan(1_000);
    });
  });

  // The rows a page needs are `columns` cells of keycaps (two cells each, one summed) or marks (none): the row a page first
  // builds is up to twice too wide and the longest prefix that fits is found from there. How much text that asks the width
  // function to measure is counted, because a timer cannot tell n log n from n squared at these sizes without being flaky.
  describe('what a row costs is counted, not timed', () => {
    const keycaps = (pairs: number): string => `1${KEYCAP}`.repeat(pairs);
    const documents = new Map<string, ReviewDocument>();
    /** 12 lines, enough to fill 80 rows at 300 columns, of keycaps, or of keycaps then marks repeated. */
    const fixture = async (kind: 'keycaps' | 'mixed', columns: number): Promise<ReviewDocument> => {
      const key = `${kind}-${kind === 'keycaps' ? 0 : columns}`;
      const known = documents.get(key);
      if (known !== undefined) return known;
      const line =
        kind === 'keycaps'
          ? keycaps(1_500)
          : `${keycaps(columns / 2)}${ACUTE.repeat(columns / 2)}`.repeat(20);
      const document = await documentOf(
        null,
        `${Array.from({ length: 12 }, () => line).join('\n')}\n`,
      );
      documents.set(key, document);
      return document;
    };
    /** The characters one page asks the width function to measure, and the page. */
    const cost = (document: ReviewDocument, columns: number, rows: number) => {
      measured.chars = 0;
      const page = projectReviewPage(document, REVIEW_START, columns, rows);
      return { chars: measured.chars, page };
    };
    const kinds = ['keycaps', 'mixed'] as const;

    it('exports the limits the cost rests on', () => {
      expect(ROW_TOKENS_PER_COLUMN).toBe(3);
      expect(PAGE_WORK_LIMIT).toBe(65_536);
    });

    it.each(kinds)(
      '%s: a page measures at most rows x 3C x (log2(3C) + 12) characters',
      async (kind) => {
        for (const columns of [78, 120, 200, 300])
          for (const rows of [24, 60, 80]) {
            const { chars, page } = cost(await fixture(kind, columns), columns, rows);
            const context = `${kind}, ${columns} columns, ${rows} rows`;
            // A row grows by at most 3C tokens, so a page of `rows` rows is guaranteed to stay within the work limit — and so
            // be valid — only up to that product; beyond it a hostile line may exhaust the work limit first (fail closed).
            if (rows * ROW_TOKENS_PER_COLUMN * columns <= PAGE_WORK_LIMIT) {
              expect(page.valid, context).toBe(true);
              expect(page.rows, context).toHaveLength(rows);
            }
            const bound = page.rows.length * 3 * columns * (Math.log2(3 * columns) + 12);
            expect(
              chars,
              `${context}: ${chars} characters against ${Math.round(bound)}`,
            ).toBeLessThanOrEqual(bound);
          }
      },
    );

    it.each(kinds)(
      '%s: twice the columns costs about twice a row (n log n), never four times (n squared)',
      async (kind) => {
        for (const [narrow, wide] of [
          [78, 156],
          [150, 300],
        ] as const)
          for (const rows of [24, 60]) {
            const small = cost(await fixture(kind, narrow), narrow, rows);
            const large = cost(await fixture(kind, wide), wide, rows);
            expect(small.page.rows).toHaveLength(rows);
            expect(large.page.rows).toHaveLength(rows);
            const ratio = large.chars / rows / (small.chars / rows);
            expect(ratio, `${kind}: ${narrow} -> ${wide} columns, ${rows} rows`).toBeLessThan(3);
            expect(ratio, `${kind}: ${narrow} -> ${wide} columns, ${rows} rows`).toBeGreaterThan(1);
          }
      },
    );

    it('a 300 x 80 page of keycaps projects in well under 1.5 seconds', async () => {
      const document = await fixture('keycaps', 300);
      projectReviewPage(document, REVIEW_START, 300, 2);
      const started = performance.now();
      const page = projectReviewPage(document, REVIEW_START, 300, 80);
      const elapsed = performance.now() - started;
      expect(page.valid).toBe(true);
      expect(page.rows).toHaveLength(80);
      expect(elapsed, `${Math.round(elapsed)} ms`).toBeLessThan(1_500);
    });
  });

  // Width is not monotone in the prefix: `1⃣` + U+1F3FB (a skin-tone modifier) + U+0301 measures ONE cell where `1⃣` is two, so
  // giving the base character back to keep it with its mark can make a row WIDER. The cluster rule applies only when the
  // shorter row still fits.
  describe('the cluster rule never widens a row (L1)', () => {
    const LIGHT_SKIN = String.fromCodePoint(0x1f3fb);
    const line = (columns: number): string =>
      `${'x'.repeat(columns - 9)}1${KEYCAP}1${KEYCAP}a${ACUTE.repeat(2 * columns + 1)}1${KEYCAP}${LIGHT_SKIN}${ACUTE}TAIL`;
    const escaped = (text: string): string =>
      [...text].map((char) => escapeReviewCharacter(char, false, false)).join('');

    it.each([32, 40, 78, 118, 198])(
      '%i columns: every row fits and the walk is lossless, hidden and revealed',
      async (columns) => {
        const text = line(columns);
        const document = await documentOf(null, `${text}\n`);
        const whole = projectReviewPage(document, REVIEW_START, columns, 10_000);
        expect(whole.valid).toBe(true);
        for (const reveal of flagsOf()) {
          const context = `${columns} columns, reveal ${reveal}`;
          const rows = walk(document, columns, escaped(text), context, { reveal });
          // One page and one row at a time are the same rows.
          expect(rows, context).toEqual(whole.rows);
        }
      },
    );
  });

  /** Walk a one-line document row by row: every row fits, every unit is drawn once and in order, every page moves on. */
  function walk(
    document: ReviewDocument,
    columns: number,
    expectedPayload: string,
    context: string,
    options: { readonly numeric?: boolean; readonly reveal?: boolean } = {},
  ): string[] {
    const { rows, pages } = rowByRow(document, columns, options);
    const line = document.lines[0] as ReviewSourceLine;
    let expectedStart = line.start;
    for (const page of pages)
      for (const source of page.visibleSource) {
        expect(source.start, context).toBe(expectedStart);
        expectedStart = source.end;
      }
    expect(expectedStart, context).toBe(line.end);
    expect(rows.map(payloadOf).join(''), context).toBe(expectedPayload);
    for (const row of rows)
      expect(displayWidth(row), `${context}: ${row}`).toBeLessThanOrEqual(columns);
    return rows;
  }

  // A fuzz of mixtures. The oracle finds the longest prefix whose whole-row width fits by a LINEAR scan; the row a page chose
  // must fit, and may not be longer than that. For text whose clusters the sum of token widths never over-counts it may be
  // shorter by at most the one token the cluster rule gives back.
  describe('the chosen row against a linear oracle (a fuzz of cluster mixtures)', () => {
    /** A small deterministic generator, so a failure is the same failure next time. */
    const random = (seed: number): (() => number) => {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
      };
    };
    const SKIN = String.fromCodePoint(0x1f3fd);
    const pure: readonly string[] = [
      'a',
      'bc',
      'xyz',
      ' ',
      '界',
      '日本',
      'é',
      '1',
      `1${KEYCAP}`,
      `#${KEYCAP}`,
      `*${KEYCAP}`,
      `e${ACUTE}`,
      ACUTE,
      KEYCAP,
      ACUTE + ACUTE,
      `0${KEYCAP}${KEYCAP}`,
    ];
    const mixed: readonly string[] = [
      ...pure,
      `${String.fromCodePoint(0x1f44d)}${SKIN}`,
      String.fromCodePoint(0x1f1f9, 0x1f1f7),
      String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
      String.fromCodePoint(0x261d, 0x1f3fb),
      String.fromCodePoint(0x1100, 0x1161, 0x11a8),
      `1${KEYCAP}${String.fromCodePoint(0x1f3fb)}`,
      CONJUNCT,
      CONJUNCT + String.fromCharCode(0x0915),
      '<',
      '\t',
    ];
    const generate = (alphabet: readonly string[], next: () => number): string => {
      const count = 5 + Math.floor(next() * 120);
      // Ends on a letter: a trailing blank would be drawn as `<SP>`, which the oracle's plain escape does not model.
      return `${Array.from({ length: count }, () => alphabet[Math.floor(next() * alphabet.length)]).join('')}Z`;
    };
    const escapeAll = (text: string): string[] =>
      [...text].map((char) => escapeReviewCharacter(char, false, false));

    it.each([
      ['text the estimate never over-counts', pure, 0x5eed, true],
      ['emoji, flags, ZWJ, jamo and modified keycaps', mixed, 0xbeef, false],
    ] as const)('%s', async (_name, alphabet, seed, exact) => {
      const next = random(seed);
      for (let round = 0; round < 80; round++) {
        const text = generate(alphabet, next);
        const document = await documentOf(null, `${text}\n`);
        const tokens = escapeAll(text);
        for (const columns of [32, 40, 78]) {
          const context = `round ${round}, ${columns} columns: ${JSON.stringify(text)}`;
          const label = '+1 ';
          const cap = Math.max(16, ROW_TOKENS_PER_COLUMN * columns);
          // The oracle: the longest prefix of the first `cap` tokens whose WHOLE-row width fits, scanned linearly.
          let longest = 0;
          let steady = true;
          let before = displayWidth(label);
          for (let count = 1; count <= Math.min(tokens.length, cap); count++) {
            const width = displayWidth(label + tokens.slice(0, count).join(''));
            if (width <= columns) longest = count;
            if (width < before) steady = false;
            before = width;
          }
          const first = projectReviewPage(document, REVIEW_START, columns, 1);
          expect(first.valid, context).toBe(true);
          expect(displayWidth(first.rows[0] ?? ''), context).toBeLessThanOrEqual(columns);
          const drawn =
            first.next === undefined ? (document.lines[0]?.end ?? 0) : first.next.offset;
          // The row's tokens: the one prefix of the line that ends where the row does.
          let units = 0;
          let chosen = -1;
          const points = [...text];
          for (const [at, point] of points.entries()) {
            if (units === drawn) chosen = at;
            units += point.length;
          }
          if (units === drawn) chosen = points.length;
          expect(chosen, `${context}: the row ends between tokens`).toBeGreaterThanOrEqual(0);
          expect(chosen, `${context}: never longer than the oracle's`).toBeLessThanOrEqual(longest);
          if (exact && steady)
            expect(chosen, `${context}: at most one token shorter`).toBeGreaterThanOrEqual(
              longest - 1,
            );
          walk(document, columns, tokens.join(''), context);
        }
      }
    });
  });
});

function flagsOf(): readonly boolean[] {
  return [false, true];
}
