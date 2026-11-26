/**
 * The wording and arithmetic of the full view and the tool-call list ([ADR-0134](../../../../../docs/decisions/0134-the-full-view-and-the-tool-details-are-one-readable-inspection-screen.md)).
 *
 * Pure text, no React: every assertion is on a string or a row count the module returns, and every document is built by
 * the real `createReviewDocument` from a preview shaped the way the engine's line diff delivers it. Each family names, in
 * its header, the one-line production mutation that must break it.
 */
import type { ToolFileDiff, ToolPreview } from '@relavium/core';
import { describe, expect, it, vi } from 'vitest';

import { editedFilePreview } from './fixtures/edit-diff.js';
import { cardKeyRows, cardScopePhrase, type CardKeyInput } from './tool-review-card.js';
import {
  createReviewDocument,
  escapeReviewCharacter,
  projectReviewPage,
  REVIEW_START,
  type ReviewDocument,
  type ReviewPage,
} from './tool-review-projection.js';
import {
  callListCapacity,
  callListView,
  DETAILS_CLOSE_NOTE,
  escapedFit,
  FULL_BODY_ROWS_CAP,
  FULL_PROTECTED_NOTE,
  FULL_SPARE_ROWS,
  FULL_CONFIRM_ANY_ROW,
  FULL_CONFIRM_ENTER_ROW,
  fullAnswerRows,
  fullBodyRows,
  fullChrome,
  fullCounts,
  fullHeaderRows,
  fullNavLegend,
  fullStatusRow,
  fullWarnings,
  type CallListEntry,
  type FullChromeInput,
  type InspectionPending,
  type NavLegendInput,
  type ScreenKind,
} from './tool-review-screen.js';
import { displayWidth } from './viewport.js';

/**
 * What the width measurer was asked, in calls and characters: `escapedFit` is bounded by counting what it measures, which is
 * exact on any machine, where a clock would be a guess. (The measurer itself is the real one, only observed.)
 */
const measured = vi.hoisted(() => ({ calls: 0, characters: 0 }));
vi.mock('./viewport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./viewport.js')>();
  return {
    ...actual,
    displayWidth: (text: string): number => {
      measured.calls++;
      measured.characters += text.length;
      return actual.displayWidth(text);
    },
  };
});

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------------

type DiffLine = ToolFileDiff['lines'][number];
/** One line of a diff: `=` context, `-` removed, `+` added. */
type Op = readonly ['=' | '+' | '-', string];

/**
 * A change as the engine's line diff delivers it (a context line carries both spans, a removed line its before span, an
 * added line its after span, every line LF-terminated), with the stats and the two sides derived from the operations so
 * nothing can disagree with the lines.
 */
function opsPreview(ops: readonly Op[], target = 'src/app.ts'): ToolPreview {
  const before: string[] = [];
  const after: string[] = [];
  const sides = { before: 0, after: 0 };
  const span = (side: 'before' | 'after', line: number, text: string) => {
    const start = sides[side];
    sides[side] += text.length + 1;
    return { line, start, end: sides[side] };
  };
  const lines: DiffLine[] = [];
  for (const [mark, text] of ops) {
    if (mark === '=') {
      before.push(text);
      after.push(text);
      lines.push({
        kind: 'context',
        text,
        ending: 'lf',
        before: span('before', before.length, text),
        after: span('after', after.length, text),
      });
    } else if (mark === '-') {
      before.push(text);
      lines.push({
        kind: 'removed',
        text,
        ending: 'lf',
        before: span('before', before.length, text),
      });
    } else {
      after.push(text);
      lines.push({ kind: 'added', text, ending: 'lf', after: span('after', after.length, text) });
    }
  }
  const bytes = (rows: readonly string[]): number =>
    new TextEncoder().encode(rows.map((row) => `${row}\n`).join('')).byteLength;
  return {
    kind: 'operation',
    target,
    fields: [],
    diff: {
      before: before.map((row) => `${row}\n`).join(''),
      after: after.map((row) => `${row}\n`).join(''),
      beforeEndings: before.length === 0 ? 'empty' : 'lf',
      afterEndings: after.length === 0 ? 'empty' : 'lf',
      stats: {
        addedLines: ops.filter(([mark]) => mark === '+').length,
        removedLines: ops.filter(([mark]) => mark === '-').length,
        beforeBytes: bytes(before),
        afterBytes: bytes(after),
      },
      lines,
    },
  };
}

function documentOf(preview: ToolPreview): ReviewDocument {
  const document = createReviewDocument(preview);
  expect(document.valid, 'a hollow fixture would prove nothing').toBe(true);
  return document;
}

const COUNTS = '+3 -2 · 205 bytes · 0 masked values';
/** Three lines added and two removed, 205 changed bytes (every changed line counts its newline), no secret anywhere. */
const countedDocument = documentOf(
  opsPreview([
    ['=', 'import a'],
    ['=', 'import b'],
    ['-', 'a'.repeat(39)],
    ['-', 'b'.repeat(49)],
    ['+', 'c'.repeat(29)],
    ['+', 'd'.repeat(39)],
    ['+', 'e'.repeat(44)],
    ['=', 'tail'],
  ]),
);

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
/** `n` distinct secrets the display floor masks: `Bearer sk-proj-…` rotated so no two are equal. */
const secret = (index: number): string =>
  `Bearer sk-proj-${ALPHABET.slice(index)}${ALPHABET.slice(0, index)}`;

/**
 * A diff with `count` masked values. Two secrets in one field read as ONE mask (the scan joins what touches), so the second
 * sits on the OTHER side of the diff: a removed line is a before-side field, an added one an after-side field.
 */
function maskedDiff(count: 1 | 2): ReviewDocument {
  const document = documentOf(
    opsPreview([
      ['=', 'head'],
      ...(count === 2 ? [['-', `old = ${secret(1)}`] as const] : []),
      ['+', `key = ${secret(0)}`],
      ['=', 'tail'],
    ]),
  );
  expect(document.masks, 'the fixture must carry exactly the masks it claims').toHaveLength(count);
  return document;
}

/** A call with no diff whose argument fields hold `count` masked values. */
function maskedFields(count: number): ReviewDocument {
  const document = documentOf({
    kind: 'operation',
    target: 'curl',
    fields: Array.from({ length: count }, (_, index) => ({
      name: `header${index}`,
      value: secret(index),
    })),
  });
  expect(document.masks).toHaveLength(count);
  return document;
}

/** A call whose TARGET itself holds a masked value (the target is the document's first field). */
const maskedTarget = documentOf({
  kind: 'operation',
  target: `curl https://example.test/hook -H "Authorization: ${secret(0)}"`,
  fields: [],
});
/** A call with a plain target and a masked value only in a later field. */
const maskedField = documentOf({
  kind: 'operation',
  target: 'curl https://example.test/hook',
  fields: [{ name: 'Authorization', value: secret(0) }],
});

/** A call with nothing to diff and nothing masked. */
const plainCall = documentOf({
  kind: 'operation',
  target: 'git',
  fields: [{ name: 'args', value: '["status"]' }],
});

/** Forty lines, two edits: four changed lines in two changes, far apart. */
const longDocument = documentOf(editedFilePreview(40, { 10: 'ten', 30: 'thirty' }));

type Endings = NonNullable<ToolPreview['diff']>['beforeEndings'];
/** The preview shape the card's own line-endings tests use, so the full view is held to the same cases. */
function endingsPreview(over: {
  before?: string | null;
  after?: string;
  beforeEndings?: Endings;
  afterEndings?: Endings;
}): ToolPreview {
  const after = over.after ?? 'x\n';
  const before = over.before === undefined ? null : over.before;
  const ending = (text: string): 'crlf' | 'lf' | 'none' =>
    text.endsWith('\r\n') ? 'crlf' : text.endsWith('\n') ? 'lf' : 'none';
  const strip = (text: string): string => text.replace(/\r?\n$/u, '');
  const removed =
    before === null || before === ''
      ? []
      : [
          {
            kind: 'removed' as const,
            text: strip(before),
            ending: ending(before),
            before: { line: 1, start: 0, end: before.length },
          },
        ];
  return {
    kind: 'operation',
    target: 'notes.md',
    fields: [],
    diff: {
      before,
      after,
      beforeEndings: over.beforeEndings ?? (before === null ? 'empty' : 'lf'),
      afterEndings: over.afterEndings ?? 'lf',
      stats: {
        addedLines: 1,
        removedLines: removed.length,
        beforeBytes: before === null ? 0 : new TextEncoder().encode(before).byteLength,
        afterBytes: new TextEncoder().encode(after).byteLength,
      },
      lines: [
        ...removed,
        {
          kind: 'added' as const,
          text: strip(after),
          ending: ending(after),
          after: { line: 1, start: 0, end: after.length },
        },
      ],
    },
  };
}

/**
 * Collects what a property violates, so a loop over thousands of cases asserts once and names every offender (a failing
 * property prints its first violations instead of stopping at the first `expect`).
 */
function collect(): {
  readonly check: (ok: boolean, label: () => string) => void;
  readonly none: () => void;
} {
  const found: string[] = [];
  return {
    check: (ok, label) => {
      if (!ok) found.push(label());
    },
    none: () => {
      expect(found.slice(0, 8)).toEqual([]);
    },
  };
}

/** Every width the properties run over, 40 to 200 columns inclusive. */
const WIDTHS = Array.from({ length: 161 }, (_, index) => 40 + index);
/** The columns a row may use: the card's rule, a margin on each side (`columns - 2`). */
const usable = (columns: number): number => columns - 2;
/** The narrowest terminal the product supports (ADR-0134 §7): below it the views truncate what the text cannot fit. */
const FLOOR = 80;

const SAVED_TITLE = 'Deliver saved result — no new filesystem operation';
const IDENTITY = ['tool edit_file', 'action fs_write'] as const;
const NO_PENDING: InspectionPending = { target: false, masks: 0 };

// ---------------------------------------------------------------------------------------------------------------------
// fullCounts
// Mutation: drop `+` from `+${…addedLines}` / swap added and removed / print `bytes` from `sourceBytes` / return '' for a diff.
// ---------------------------------------------------------------------------------------------------------------------
describe('fullCounts — the change, its bytes and its masked values, always (ADR-0134 §3)', () => {
  it('states the lines added and removed, the changed bytes and the masked values, in that order', () => {
    expect(countedDocument.changedBytes, 'the fixture sums to the bytes it claims').toBe(205);
    expect(fullCounts(countedDocument)).toBe('+3 -2 · 205 bytes · 0 masked values');
  });

  it('says `1 masked value` in the singular and `N masked values` otherwise, a zero included', () => {
    expect(fullCounts(maskedDiff(1))).toMatch(/ · 1 masked value$/u);
    expect(fullCounts(maskedDiff(1))).not.toContain('values');
    expect(fullCounts(maskedDiff(2))).toMatch(/ · 2 masked values$/u);
    expect(fullCounts(countedDocument)).toMatch(/ · 0 masked values$/u);
  });

  it('says nothing for a call that has no diff and no mask: a zero is not displayed as a fact there', () => {
    expect(fullCounts(plainCall)).toBe('');
    expect(fullCounts(undefined)).toBe('');
  });

  it('says only the masked values for a call that has no diff but carries masks', () => {
    expect(fullCounts(maskedFields(1))).toBe('1 masked value');
    expect(fullCounts(maskedFields(3))).toBe('3 masked values');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// fullHeaderRows
// Mutation: `gap >= 2` -> `gap >= 1` / `>= 3` (boundary tests); `displayWidth(identity) <= width` -> `<` / `<= width + 1`
// (the identity-on-one-row boundary); always `[head, ...input.identity]` or always `[head, identity]`; shorten the identity
// rows (long-identity test); `title` cut to the width.
// ---------------------------------------------------------------------------------------------------------------------
describe('fullHeaderRows — one row when it fits, stacked when it does not, the identity never cut', () => {
  const left = `Review · ${IDENTITY.join(' · ')}`;

  it('puts the title, the identity and the counts on ONE row, the counts flush right', () => {
    const rows = fullHeaderRows({
      title: 'Review',
      counts: COUNTS,
      identity: IDENTITY,
      columns: 80,
    });
    expect(rows).toEqual([
      'Review · tool edit_file · action fs_write  +3 -2 · 205 bytes · 0 masked values',
    ]);
    expect(displayWidth(rows[0] ?? '')).toBe(usable(80));
  });

  it('pads with spaces so the counts end at the right edge, whatever the width', () => {
    for (const columns of [90, 120, 200]) {
      const [row, ...rest] = fullHeaderRows({
        title: 'Review',
        counts: COUNTS,
        identity: IDENTITY,
        columns,
      });
      expect(rest, `${columns} columns`).toEqual([]);
      expect(row?.startsWith(left), `${columns} columns`).toBe(true);
      expect(row?.endsWith(COUNTS), `${columns} columns`).toBe(true);
      expect(displayWidth(row ?? ''), `${columns} columns`).toBe(usable(columns));
      const middle = (row ?? '').slice(left.length, (row ?? '').length - COUNTS.length);
      expect(middle.trim(), `${columns} columns: only spaces between`).toBe('');
      expect(middle.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('goes to one row at exactly two spaces of gap and stacks one column earlier', () => {
    const need = displayWidth(left) + displayWidth(COUNTS) + 2;
    expect(need, 'the fixture sits on the 80-column floor').toBe(usable(80));
    const fits = fullHeaderRows({
      title: 'Review',
      counts: COUNTS,
      identity: IDENTITY,
      columns: need + 2,
    });
    expect(fits).toHaveLength(1);
    const stacked = fullHeaderRows({
      title: 'Review',
      counts: COUNTS,
      identity: IDENTITY,
      columns: need + 1,
    });
    expect(stacked).toHaveLength(2);
    expect(stacked[1]).toBe(IDENTITY.join(' · '));
  });

  it('stacks: the title with the counts first, then the identity on ONE row, joined by the separator', () => {
    const rows = fullHeaderRows({
      title: 'Review',
      counts: COUNTS,
      identity: IDENTITY,
      columns: 70,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.startsWith('Review')).toBe(true);
    expect(rows[0]?.endsWith(COUNTS)).toBe(true);
    expect(displayWidth(rows[0] ?? '')).toBe(usable(70));
    expect(rows[1]).toBe('tool edit_file · action fs_write');
  });

  describe('the identity moves under the title as one row only while that row fits the usable width', () => {
    // A joined identity of exactly 60 columns: 5 + 37 + 3 + 15.
    const identity = [`tool ${'a'.repeat(37)}`, 'action fs_write'];
    const joined = identity.join(' · ');
    const stackedAt = (columns: number) =>
      fullHeaderRows({ title: 'Review', counts: COUNTS, identity, columns });

    it('puts it on one row when it fits exactly, with the counts flush right on the row above', () => {
      expect(displayWidth(joined), 'the fixture is the width it claims').toBe(60);
      const rows = stackedAt(62);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toBe(joined);
      expect(displayWidth(rows[0] ?? '')).toBe(60);
      expect(rows[0]?.startsWith('Review')).toBe(true);
      expect(rows[0]?.endsWith(COUNTS)).toBe(true);
    });

    it('keeps one row per identity part, each UNCHANGED, when it is one column too wide', () => {
      const rows = stackedAt(61);
      expect(rows).toHaveLength(3);
      expect(rows.slice(1)).toEqual(identity);
      expect(displayWidth(rows[0] ?? '')).toBe(usable(61));
      expect(rows[0]?.endsWith(COUNTS)).toBe(true);
    });

    it('draws a single identity part as its own row under the title, which keeps its counts', () => {
      const rows = fullHeaderRows({
        title: 'Review',
        counts: COUNTS,
        identity: ['tool deliver'],
        columns: 58,
      });
      expect(rows).toHaveLength(2);
      expect(rows[1]).toBe('tool deliver');
      expect(rows[0]?.endsWith(COUNTS)).toBe(true);
      expect(displayWidth(rows[0] ?? '')).toBe(usable(58));
    });
  });

  it('never cuts an identity that is wider than the screen: it takes a row of its own', () => {
    const long = `tool ${'x'.repeat(200)}`;
    const rows = fullHeaderRows({
      title: 'Review',
      counts: COUNTS,
      identity: [long, 'action fs_write'],
      columns: 80,
    });
    expect(rows).toHaveLength(3);
    expect(rows[1], 'the whole identity, not a prefix of it').toBe(long);
    expect(displayWidth(rows[1] ?? '')).toBeGreaterThan(usable(80));
    expect(rows[2]).toBe('action fs_write');
    expect(rows[0], 'the first row is the title and the counts, nothing of the identity').toBe(
      `Review${' '.repeat(usable(80) - 'Review'.length - COUNTS.length)}${COUNTS}`,
    );
  });

  it('does not pad a title that has no counts, and moves the identity under it only when it does not fit beside it', () => {
    expect(
      fullHeaderRows({ title: 'Details', counts: '', identity: IDENTITY, columns: 80 }),
    ).toEqual(['Details · tool edit_file · action fs_write']);
    expect(
      fullHeaderRows({ title: 'Details', counts: '', identity: IDENTITY, columns: 40 }),
    ).toEqual(['Details', 'tool edit_file · action fs_write']);
  });

  it('is only the title when there is no identity (a saved result), unshortened', () => {
    expect(fullHeaderRows({ title: SAVED_TITLE, counts: '', identity: [], columns: 80 })).toEqual([
      SAVED_TITLE,
    ]);
    const rows = fullHeaderRows({
      title: SAVED_TITLE,
      counts: '',
      identity: ['tool deliver'],
      columns: 80,
    });
    expect(rows).toEqual([`${SAVED_TITLE} · tool deliver`]);
    expect(displayWidth(rows[0] ?? '')).toBeLessThanOrEqual(usable(80));
  });

  it('keeps the counts on the floor: at 80 columns the standard header always shows them', () => {
    for (const title of ['Review', 'Details']) {
      const rows = fullHeaderRows({ title, counts: COUNTS, identity: IDENTITY, columns: FLOOR });
      expect(rows.join('\n'), title).toContain(COUNTS);
    }
  });

  describe('property: no header row is wider than columns - 2, except an identity row that cannot be shortened', () => {
    const identities: readonly (readonly string[])[] = [
      [],
      IDENTITY,
      ['tool mcp:a-fairly-long-server:and-a-long-tool-name', 'outcome outcome unknown'],
      [`tool ${'t'.repeat(60)}`, 'action fs_write'],
      [`tool ${'u'.repeat(300)}`, `action ${'v'.repeat(120)}`],
    ];
    const countsSet = [COUNTS, '1 masked value', ''];
    it.each(['Review', 'Details'])('holds for the title %s at 40..200 columns', (title) => {
      const { check, none } = collect();
      for (const columns of WIDTHS)
        for (const identity of identities)
          for (const counts of countsSet) {
            const rows = fullHeaderRows({ title, counts, identity, columns });
            const label = (what: string) => () =>
              `${what}: ${title} @${columns} ${identity.join('|').slice(0, 20)} [${counts}]`;
            check(rows.length > 0, label('a header has a row'));
            for (const [index, row] of rows.entries())
              // Too wide: it must be an identity row (never the title row), moved to a row of its own, whole.
              check(
                displayWidth(row) <= usable(columns) || (index > 0 && identity.includes(row)),
                label(`only an identity row on its own row may be too wide (${row.length} wide)`),
              );
            // Nothing of the identity is ever lost: a single row holds all of it; a stacked header carries it as ONE row
            // exactly when that row fits, and as the parts, unchanged, when it does not.
            const joined = identity.join(' · ');
            check(
              rows.length > 1
                ? JSON.stringify(rows.slice(1)) ===
                    JSON.stringify(displayWidth(joined) <= usable(columns) ? [joined] : identity)
                : (rows[0] ?? '').includes(joined),
              label('the identity is whole'),
            );
          }
      none();
    });
    it('holds for the saved-result title wherever the title itself fits (52 columns and up)', () => {
      const { check, none } = collect();
      for (const columns of WIDTHS.filter((width) => usable(width) >= displayWidth(SAVED_TITLE)))
        for (const identity of identities) {
          const rows = fullHeaderRows({ title: SAVED_TITLE, counts: '', identity, columns });
          for (const [index, row] of rows.entries())
            check(
              displayWidth(row) <= usable(columns) || (index > 0 && identity.includes(row)),
              () => `saved result @${columns}: ${row.slice(0, 30)}`,
            );
        }
      none();
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// fullWarnings
// Mutation: drop the `input.kind === 'approval'` guard (details prints a lock); swap `one` (singular/plural); drop
// `endingsWarning`'s call or the `flatMap(wrapWords…)`; print the mask lock when `masks === 0`; the masked-target sentence
// on a constant (`masked ? … : …` forced either way) or on any mask instead of one on the target's field; either target
// sentence reverted to `press Home.` without the PgDn way out.
// ---------------------------------------------------------------------------------------------------------------------
describe('fullWarnings — only the warnings that apply, each naming its cause and its way out', () => {
  const TARGET_LOCK =
    '⚠ Allow is locked until the whole target has been on screen — press Home and page through it (PgDn).';
  const MASK_LOCK_ONE =
    '⚠ Allow is locked until the masked value has been revealed — press [r], then scroll over it.';
  const MASK_LOCK_MANY =
    '⚠ Allow is locked until every masked value has been revealed — press [r], then scroll over each.';
  const warnings = (
    over: {
      kind?: ScreenKind;
      document?: ReviewDocument | undefined;
      pending?: InspectionPending;
      columns?: number;
    } = {},
  ) =>
    fullWarnings({
      kind: over.kind ?? 'approval',
      document: over.document,
      pending: over.pending ?? NO_PENDING,
      columns: over.columns ?? 200,
    });

  it('says nothing when nothing is pending and nothing changed convention', () => {
    expect(warnings({ document: countedDocument })).toEqual([]);
    expect(warnings()).toEqual([]);
    expect(warnings({ document: documentOf(endingsPreview({})) })).toEqual([]);
  });

  it('names the target lock, with the key that clears it, while the whole target has not been on screen', () => {
    expect(warnings({ pending: { target: true, masks: 0 } })).toEqual([TARGET_LOCK]);
  });

  it('names PgDn as the way out of a target longer than the body: `press Home` alone does nothing there', () => {
    const plain = warnings({ pending: { target: true, masks: 0 } }).join(' ');
    expect(plain).toContain('press Home and page through it (PgDn)');
    expect(plain).not.toMatch(/press Home\.$/u);
  });

  describe('a target that hides a masked value says Home, then [r], then PgDn', () => {
    const MASKED_TARGET_LOCK =
      '⚠ Allow is locked until the whole target has been on screen — press Home, reveal its masked value with [r], and page through it (PgDn).';
    const targetLocked = { target: true, masks: 0 };

    it('has the premise: the first line of the document is the target, and a mask sits on its field', () => {
      expect(maskedTarget.lines[0]?.label).toBe('target');
      expect(maskedTarget.masks.some((mask) => mask.field === maskedTarget.lines[0]?.field)).toBe(
        true,
      );
      expect(maskedField.masks.some((mask) => mask.field === maskedField.lines[0]?.field)).toBe(
        false,
      );
    });

    it('says it, in one row at a wide width, when the pending target carries a mask', () => {
      expect(warnings({ document: maskedTarget, pending: targetLocked })).toEqual([
        MASKED_TARGET_LOCK,
      ]);
    });

    it('keeps the plain sentence when the target has no mask: a mask in a LATER field is the mask lock’s business', () => {
      expect(warnings({ document: maskedField, pending: targetLocked })).toEqual([TARGET_LOCK]);
      expect(warnings({ document: countedDocument, pending: targetLocked })).toEqual([TARGET_LOCK]);
      expect(warnings({ document: undefined, pending: targetLocked })).toEqual([TARGET_LOCK]);
    });

    it('says nothing about the target once it has been on screen, whatever it hides', () => {
      expect(warnings({ document: maskedTarget, pending: NO_PENDING })).toEqual([]);
    });

    it('says it before the mask lock when both are owed, and never on a details screen', () => {
      expect(warnings({ document: maskedTarget, pending: { target: true, masks: 1 } })).toEqual([
        MASKED_TARGET_LOCK,
        MASK_LOCK_ONE,
      ]);
      expect(warnings({ kind: 'details', document: maskedTarget, pending: targetLocked })).toEqual(
        [],
      );
    });

    it('wraps to the usable width at 40..200 columns without losing a word', () => {
      const { check, none } = collect();
      for (const columns of WIDTHS) {
        const rows = warnings({ document: maskedTarget, pending: targetLocked, columns });
        for (const row of rows)
          check(displayWidth(row) <= usable(columns), () => `@${columns}: ${row}`);
        check(
          rows.join(' ').replace(/\s+/gu, ' ') === MASKED_TARGET_LOCK,
          () => `@${columns}: ${rows.join('|')}`,
        );
      }
      none();
    });
  });

  it('names the mask lock in the singular for one masked value and the plural for several', () => {
    expect(warnings({ pending: { target: false, masks: 1 } })).toEqual([MASK_LOCK_ONE]);
    expect(warnings({ pending: { target: false, masks: 2 } })).toEqual([MASK_LOCK_MANY]);
    expect(warnings({ pending: { target: false, masks: 40 } })).toEqual([MASK_LOCK_MANY]);
  });

  it('says both locks, the target first, when both are owed', () => {
    expect(warnings({ pending: { target: true, masks: 3 } })).toEqual([
      TARGET_LOCK,
      MASK_LOCK_MANY,
    ]);
  });

  it('never prints a lock on a details screen, whatever is pending: nothing there can be answered', () => {
    for (const pending of [
      { target: true, masks: 0 },
      { target: false, masks: 4 },
      { target: true, masks: 4 },
    ])
      expect(
        warnings({ kind: 'details', pending, document: countedDocument }),
        JSON.stringify(pending),
      ).toEqual([]);
    const rows = warnings({
      kind: 'details',
      pending: { target: true, masks: 4 },
      document: documentOf(
        endingsPreview({ before: 'a\r\n', after: 'a\n', beforeEndings: 'crlf' }),
      ),
    });
    expect(rows.join(' ')).not.toMatch(/lock/iu);
  });

  describe('the line-endings sentence appears only for a change of convention (the card’s cases)', () => {
    const rowsFor = (
      over: Parameters<typeof endingsPreview>[0],
      kind: ScreenKind = 'approval',
    ): readonly string[] => {
      const document = documentOf(endingsPreview(over));
      return warnings({ document, kind });
    };

    it.each([
      ['a CRLF file edited as CRLF', { before: 'a\r\n', after: 'b\r\n' }, 'crlf', 'crlf'],
      [
        'a CRLF line that gains a blank CRLF line',
        { before: 'a\r\n', after: 'a\r\n\r\n' },
        'crlf',
        'crlf',
      ],
      ['a bare-CR file left unchanged', { before: 'a\rb\rc', after: 'a\rb\rc' }, 'none', 'none'],
      ['a new LF file', { before: null, after: 'x\n' }, 'empty', 'lf'],
    ] as const)('stays silent for %s', (_name, text, beforeEndings, afterEndings) => {
      expect(rowsFor({ ...text, beforeEndings, afterEndings })).toEqual([]);
    });

    it.each([
      ['CRLF to LF', { before: 'a\r\n', after: 'a\n' }, 'crlf', 'lf', '⚠ Line endings: CRLF → LF.'],
      [
        'LF to mixed',
        { before: 'a\n', after: 'a\nb\r\n' },
        'lf',
        'mixed',
        '⚠ Line endings: LF → mixed.',
      ],
      [
        'mixed to mixed',
        { before: 'a\nb\r\nc', after: 'a\nb\r\nd' },
        'mixed',
        'mixed',
        '⚠ Line endings: mixed → mixed.',
      ],
      [
        'a final newline added to a multi-line LF file',
        { before: 'a\nb', after: 'a\nb\n' },
        'lf',
        'lf',
        '⚠ Line endings: final newline added.',
      ],
      [
        'a final newline dropped from a multi-line LF file',
        { before: 'a\nb\n', after: 'a\nb' },
        'lf',
        'lf',
        '⚠ Line endings: final newline removed.',
      ],
      [
        'a new CRLF file',
        { before: null, after: 'a\r\n', afterEndings: 'crlf' },
        'empty',
        'crlf',
        '⚠ Line endings: CRLF.',
      ],
    ] as const)(
      'warns for %s, on an approval and on details alike',
      (_name, text, beforeEndings, afterEndings, expected) => {
        const over = { ...text, beforeEndings, afterEndings };
        expect(rowsFor(over, 'approval')).toEqual([expected]);
        expect(rowsFor(over, 'details')).toEqual([expected]);
      },
    );

    it('comes after the locks, never before them', () => {
      const document = documentOf(
        endingsPreview({ before: 'a\r\n', after: 'a\n', beforeEndings: 'crlf' }),
      );
      expect(warnings({ document, pending: { target: true, masks: 1 } })).toEqual([
        TARGET_LOCK,
        MASK_LOCK_ONE,
        '⚠ Line endings: CRLF → LF.',
      ]);
    });
  });

  describe('everything is wrapped to the usable width, whatever the width', () => {
    const document = documentOf(
      endingsPreview({ before: 'a\r\n', after: 'a\n', beforeEndings: 'crlf' }),
    );
    const all = [TARGET_LOCK, MASK_LOCK_MANY, '⚠ Line endings: CRLF → LF.'];

    it('keeps every row inside columns - 2 at 40..200 columns, and loses no word to the wrapping', () => {
      for (const columns of WIDTHS) {
        const rows = warnings({ document, pending: { target: true, masks: 2 }, columns });
        for (const row of rows)
          expect(displayWidth(row), `@${columns}: ${row}`).toBeLessThanOrEqual(usable(columns));
        expect(rows.join(' ').replace(/\s+/gu, ' '), `@${columns}`).toBe(all.join(' '));
      }
    });

    it('indents a continuation row two columns and starts every warning on a row of its own', () => {
      const rows = warnings({ document, pending: { target: true, masks: 2 }, columns: 40 });
      expect(rows.length).toBeGreaterThan(3);
      const starts = rows.filter((row) => row.startsWith('⚠'));
      expect(starts).toHaveLength(3);
      for (const row of rows.filter((candidate) => !candidate.startsWith('⚠')))
        expect(row.startsWith('  ')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// fullStatusRow
// Mutation: `Math.floor` -> `Math.round` (a 99.5% page reads 100%); drop `Math.max(1, …)`; drop the `changedLines > 0`
// guard; swap the order of the modes and the changes; remove either side of the above/below filter; remove or reorder a
// tier of `tiers`; `displayWidth(row) <= width` -> `<` / `<= width + 1` / never checked; drop the bare-rule fallback.
// ---------------------------------------------------------------------------------------------------------------------
describe('fullStatusRow — how far down the page reaches, which changes are off it, and the modes not to forget', () => {
  const pageOf = (document: ReviewDocument, rowLimit = 10, cursor = REVIEW_START): ReviewPage =>
    projectReviewPage(document, cursor, 80, rowLimit, false, false, false, true);
  /** A real page, with only the numbers the status row reads replaced, so the arithmetic is tested on its own. */
  const placed = (
    position: { above: number; below: number; total: number },
    changes: { above: number; below: number } = { above: 0, below: 0 },
  ): ReviewPage => ({
    ...pageOf(longDocument),
    position,
    changesAbove: changes.above,
    changesBelow: changes.below,
  });
  const status = (
    over: {
      page?: ReviewPage | undefined;
      document?: ReviewDocument | undefined;
      revealed?: boolean;
      numeric?: boolean;
      columns?: number;
    } = {},
  ): string =>
    fullStatusRow({
      page: 'page' in over ? over.page : placed({ above: 0, below: 0, total: 10 }),
      document: 'document' in over ? over.document : longDocument,
      revealed: over.revealed ?? false,
      numeric: over.numeric ?? false,
      columns: over.columns ?? 140,
    });
  const text = (row: string): string => row.replace(/^─+/u, '').replace(/─+$/u, '').trim();

  describe('the percentage', () => {
    it('is 100 when nothing is below the page, and when the listing is empty', () => {
      expect(text(status({ page: placed({ above: 30, below: 0, total: 40 }) }))).toMatch(/^100%/u);
      expect(text(status({ page: placed({ above: 0, below: 0, total: 0 }) }))).toMatch(/^100%/u);
    });

    it('is the share of the listing the page reaches, rounded DOWN', () => {
      expect(text(status({ page: placed({ above: 0, below: 33, total: 43 }) }))).toMatch(/^23%/u);
      expect(text(status({ page: placed({ above: 20, below: 10, total: 40 }) }))).toMatch(/^75%/u);
      expect(text(status({ page: placed({ above: 0, below: 1, total: 3 }) }))).toMatch(/^66%/u);
    });

    it('never reads 100 while something is still below the page', () => {
      // 199 of 200 reached is 99.5: rounding would say 100 and tell the person the document ends here.
      expect(text(status({ page: placed({ above: 0, below: 1, total: 200 }) }))).toMatch(/^99%/u);
      expect(text(status({ page: placed({ above: 0, below: 1, total: 1000 }) }))).toMatch(/^99%/u);
    });

    it('is at least 1 once a page is drawn, however long the listing', () => {
      expect(text(status({ page: placed({ above: 0, below: 999, total: 1000 }) }))).toMatch(/^1%/u);
      expect(text(status({ page: placed({ above: 0, below: 5000, total: 5001 }) }))).toMatch(
        /^1%/u,
      );
    });
  });

  describe('the changed lines that are off the page', () => {
    const off = (above: number, below: number): string =>
      text(status({ page: placed({ above: 5, below: 5, total: 40 }, { above, below }) }));
    // 35 of the 40 listed lines are reached, 87.5% rounded down.

    it('names the count on each side', () => {
      expect(off(2, 4)).toBe('87% · changed lines off this page: 2 above, 4 below');
    });
    it('leaves out a side with none', () => {
      expect(off(3, 0)).toBe('87% · changed lines off this page: 3 above');
      expect(off(0, 7)).toBe('87% · changed lines off this page: 7 below');
    });
    it('says every changed line is on the page when none is off it', () => {
      expect(off(0, 0)).toBe('87% · every changed line is on this page');
    });
    it('says nothing about changes for a document that has no changed line, whatever the page claims', () => {
      for (const document of [plainCall, maskedFields(2), undefined]) {
        const row = text(
          status({
            page: placed({ above: 5, below: 5, total: 40 }, { above: 0, below: 0 }),
            document,
          }),
        );
        expect(row).toBe('87%');
        expect(row).not.toContain('changed');
      }
      const lying = text(
        status({
          page: placed({ above: 5, below: 5, total: 40 }, { above: 1, below: 1 }),
          document: plainCall,
        }),
      );
      expect(lying).toBe('87%');
    });
  });

  describe('the view modes come BEFORE the change counts, so a narrow terminal cuts the counts and not the modes', () => {
    const page = placed({ above: 0, below: 33, total: 43 }, { above: 2, below: 4 });
    it('says `masked values revealed (view only)` and `Unicode code points` between the percentage and the counts', () => {
      expect(text(status({ page, revealed: true, numeric: true }))).toBe(
        '23% · masked values revealed (view only) · Unicode code points · changed lines off this page: 2 above, 4 below',
      );
    });
    it('says each alone', () => {
      expect(text(status({ page, revealed: true }))).toBe(
        '23% · masked values revealed (view only) · changed lines off this page: 2 above, 4 below',
      );
      expect(text(status({ page, numeric: true }))).toBe(
        '23% · Unicode code points · changed lines off this page: 2 above, 4 below',
      );
    });
    it('keeps every mode on screen at the 80-column floor with the changes SHORTENED to fit, never cut', () => {
      const row = status({ page, revealed: true, numeric: true, columns: FLOOR });
      expect(row).toBe(
        `─ 23% · revealed (view only) · code points · changed: 2 above, 4 below ${'─'.repeat(7)}`,
      );
      expect(displayWidth(row)).toBe(usable(FLOOR));
      expect(row.indexOf('revealed'), 'the modes come before the counts').toBeLessThan(
        row.indexOf('changed'),
      );
    });
    it('shows a mode even when no page was drawn', () => {
      expect(text(status({ page: undefined, revealed: true }))).toBe(
        'masked values revealed (view only)',
      );
      expect(text(status({ page: undefined, numeric: true }))).toBe('Unicode code points');
      expect(text(status({ page: undefined, revealed: true, numeric: true }))).toBe(
        'masked values revealed (view only) · Unicode code points',
      );
    });
  });

  describe('the row itself', () => {
    it('is only a rule when there is no page and no mode, and is never empty', () => {
      expect(status({ page: undefined, columns: 80 })).toBe('─'.repeat(usable(80)));
      for (const columns of [1, 2, 3, 4, 10]) {
        const row = status({ page: undefined, columns });
        expect(row.length, `@${columns}`).toBeGreaterThan(0);
        expect(row, `@${columns}`).toMatch(/^─+$/u);
      }
    });

    it('is exactly columns - 2 wide when its words fit, with the words between rule glyphs', () => {
      const row = status({
        page: placed({ above: 0, below: 33, total: 43 }, { above: 0, below: 4 }),
        columns: 80,
      });
      expect(row).toBe(`─ 23% · changed lines off this page: 4 below ${'─'.repeat(33)}`);
      expect(displayWidth(row)).toBe(usable(80));
    });
  });

  describe('the row is FITTED to the usable width, in tiers, never cut by the renderer', () => {
    /** A status row of `words` on a rule exactly `columns - 2` wide. */
    const ruled = (words: string, columns: number): string =>
      `─ ${words} ${'─'.repeat(usable(columns) - displayWidth(words) - 3)}`;
    const placedAt = (above: number, below: number): ReviewPage =>
      placed({ above: 0, below: 33, total: 43 }, { above, below });
    const at80 = (over: { revealed?: boolean; numeric?: boolean; above: number; below: number }) =>
      status({
        page: placedAt(over.above, over.below),
        revealed: over.revealed ?? false,
        numeric: over.numeric ?? false,
        columns: FLOOR,
      });

    it('tier 1: long modes and long changes, when they fit', () => {
      expect(at80({ numeric: true, above: 2, below: 4 })).toBe(
        ruled('23% · Unicode code points · changed lines off this page: 2 above, 4 below', FLOOR),
      );
      expect(at80({ above: 2, below: 4 })).toBe(
        ruled('23% · changed lines off this page: 2 above, 4 below', FLOOR),
      );
      expect(at80({ numeric: true, above: 0, below: 0 })).toBe(
        ruled('23% · Unicode code points · every changed line is on this page', FLOOR),
      );
    });

    it('tier 2: long modes, the changes shortened, when the long changes do not fit beside them', () => {
      expect(at80({ revealed: true, above: 12, below: 34 })).toBe(
        ruled('23% · masked values revealed (view only) · changed: 12 above, 34 below', FLOOR),
      );
      expect(at80({ revealed: true, above: 0, below: 0 })).toBe(
        ruled('23% · masked values revealed (view only) · all changes shown', FLOOR),
      );
    });

    it('tier 3: short modes and short changes, when the long modes do not fit either', () => {
      expect(at80({ revealed: true, numeric: true, above: 2, below: 4 })).toBe(
        ruled('23% · revealed (view only) · code points · changed: 2 above, 4 below', FLOOR),
      );
      expect(at80({ revealed: true, numeric: true, above: 0, below: 0 })).toBe(
        ruled('23% · revealed (view only) · code points · all changes shown', FLOOR),
      );
    });

    it('tier 4: short modes and NO changes, when even the short changes do not fit', () => {
      expect(at80({ revealed: true, numeric: true, above: 12345, below: 67890 })).toBe(
        ruled('23% · revealed (view only) · code points', FLOOR),
      );
    });

    it('tier 5: the bare rule with the percentage, when not even the short modes fit', () => {
      const narrow = status({
        page: placedAt(2, 4),
        revealed: true,
        numeric: true,
        columns: 40,
      });
      expect(narrow).toBe(ruled('23%', 40));
      expect(status({ page: undefined, revealed: true, numeric: true, columns: 20 })).toBe(
        '─'.repeat(usable(20)),
      );
    });

    it('drops the changes before it shortens a mode, and shortens a mode before it drops one', () => {
      // 60 columns: both modes in their short form fit, the short changes do not.
      expect(status({ page: placedAt(2, 4), revealed: true, numeric: true, columns: 60 })).toBe(
        ruled('23% · revealed (view only) · code points', 60),
      );
      // 50 columns, one mode: the long mode is gone but the short one stays; the changes went first.
      expect(status({ page: placedAt(12, 34), revealed: true, columns: 50 })).toBe(
        ruled('23% · revealed (view only)', 50),
      );
    });

    describe('property: for every combination, at 40..200 columns, the row fits and says what a person must not forget', () => {
      const reached = { above: 0, below: 33, total: 43 };
      const positions = [
        { above: 0, below: 0, total: 10 },
        reached,
        { above: 0, below: 999, total: 1000 },
      ];
      const both = { above: 2, below: 4 };
      const changeSets = [
        { above: 0, below: 0 },
        { above: 2, below: 0 },
        { above: 0, below: 4 },
        both,
        { above: 12345, below: 67890 },
      ];

      it.each([
        [true, true],
        [true, false],
        [false, true],
        [false, false],
      ] as const)(
        'is exactly columns - 2 wide for changes (above, below, none) × percent × document, from 80 columns up — revealed=%s numeric=%s',
        (revealed, numeric) => {
          const { check, none } = collect();
          let cases = 0;
          for (const columns of WIDTHS.filter((width) => width >= FLOOR))
            for (const position of positions)
              for (const [document, changes] of [
                ...changeSets.map((set) => [longDocument, set] as const),
                // No changed line: the page's counts must not be said, whatever they are.
                [plainCall, both] as const,
              ]) {
                cases++;
                const row = fullStatusRow({
                  page: placed(position, changes),
                  document,
                  revealed,
                  numeric,
                  columns,
                });
                check(
                  displayWidth(row) === usable(columns),
                  () =>
                    `@${columns} ${JSON.stringify(position)} ${JSON.stringify(changes)}: ${displayWidth(row)} wide: ${row}`,
                );
              }
          none();
          expect(cases).toBeGreaterThan(2_000);
        },
      );

      it('is exactly columns - 2 wide below the floor too, down to 40 columns', () => {
        const { check, none } = collect();
        for (const columns of WIDTHS.filter((width) => width < FLOOR))
          for (const revealed of [true, false])
            for (const numeric of [true, false])
              for (const changes of changeSets) {
                const row = fullStatusRow({
                  page: placed(reached, changes),
                  document: longDocument,
                  revealed,
                  numeric,
                  columns,
                });
                check(
                  displayWidth(row) === usable(columns),
                  () =>
                    `@${columns} rev=${revealed} num=${numeric} ${JSON.stringify(changes)}: ${row}`,
                );
              }
        none();
      });

      it('is never wider than the usable width from 80 columns up, with no page too', () => {
        const { check, none } = collect();
        for (const columns of WIDTHS.filter((width) => width >= FLOOR))
          for (const revealed of [true, false])
            for (const numeric of [true, false])
              for (const page of [undefined, placed(reached, both)]) {
                const row = fullStatusRow({
                  page,
                  document: longDocument,
                  revealed,
                  numeric,
                  columns,
                });
                check(
                  displayWidth(row) <= usable(columns),
                  () => `@${columns} rev=${revealed} num=${numeric}: ${row}`,
                );
              }
        none();
      });

      it('never says the changes without every mode that is on, and names a mode before the changes', () => {
        const { check, none } = collect();
        for (const columns of WIDTHS)
          for (const revealed of [true, false])
            for (const numeric of [true, false])
              for (const changes of changeSets) {
                const row = fullStatusRow({
                  page: placed(reached, changes),
                  document: longDocument,
                  revealed,
                  numeric,
                  columns,
                });
                const changeAt = row.search(/changed|all changes shown|every changed line/u);
                const label = () => `@${columns} rev=${revealed} num=${numeric}: ${row}`;
                if (changeAt >= 0) {
                  if (revealed) {
                    check(
                      /revealed \(view only\)/u.test(row),
                      () => `${label()}: lost the revealed mode`,
                    );
                    check(row.search(/revealed \(view only\)/u) < changeAt, label);
                  }
                  if (numeric) {
                    check(/code points/u.test(row), () => `${label()}: lost the code-point mode`);
                    check(row.search(/code points/u) < changeAt, label);
                  }
                }
                check(row.startsWith('─ 23% '), () => `${label()}: the percentage comes first`);
              }
        none();
      });
    });
  });

  it('is derived from a real page: at the top of two far-apart changes, all four changed lines are below', () => {
    const top = pageOf(longDocument);
    expect(text(status({ page: top, columns: FLOOR }))).toMatch(
      /^\d+% · changed lines off this page: 4 below$/u,
    );
    const end = pageOf(longDocument, 10, { line: longDocument.lines.length - 3, offset: 0 });
    expect(text(status({ page: end, columns: FLOOR }))).toMatch(
      /^100% · changed lines off this page: 4 above$/u,
    );
    const whole = pageOf(longDocument, 200);
    expect(text(status({ page: whole, columns: FLOOR }))).toBe(
      '100% · every changed line is on this page',
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// fullNavLegend
// Mutation: drop any `if (input.has…)` guard (an item appears that does nothing); swap `revealed ? … : …`; change `<=` in
// `packRows` to `<`; pack `[...move, ...tools]` as one list (the groups share a row); push '[b] Back…' into the legend;
// change the legend separator.
// ---------------------------------------------------------------------------------------------------------------------
describe('fullNavLegend — the card’s `[key] words` style, two groups, only the keys that do something here', () => {
  const ALL: NavLegendInput = {
    hasChanges: true,
    hasMasks: true,
    canCopy: true,
    revealed: false,
    numeric: false,
    columns: 140,
  };
  const GAP = ' · ';
  const MOVE_ROW = '↑/↓ scroll · PgUp/PgDn page · Home/End top/end · Tab/Shift+Tab changes';
  const TOOLS_ROW = '[/] search · [r] reveal masked · [p] Unicode codes · [c] copy page';
  const items = (over: Partial<NavLegendInput> = {}): readonly string[] =>
    fullNavLegend({ ...ALL, ...over }).flatMap((row) => row.split(GAP));
  /** The movement group the contract spells out, built from the flags alone. */
  const moveItems = (flags: NavLegendInput): readonly string[] => [
    '↑/↓ scroll',
    'PgUp/PgDn page',
    'Home/End top/end',
    ...(flags.hasChanges ? ['Tab/Shift+Tab changes'] : []),
  ];
  /** The inspection group, likewise. */
  const toolItems = (flags: NavLegendInput): readonly string[] => [
    '[/] search',
    ...(flags.hasMasks ? [flags.revealed ? '[r] hide masked' : '[r] reveal masked'] : []),
    flags.numeric ? '[p] back to text' : '[p] Unicode codes',
    ...(flags.canCopy ? ['[c] copy page'] : []),
  ];

  it('is two rows, movement then inspection, when every key applies and the width allows', () => {
    expect(fullNavLegend(ALL)).toEqual([MOVE_ROW, TOOLS_ROW]);
  });

  it('keeps each group on ONE row at the 80-column floor', () => {
    expect(
      displayWidth(MOVE_ROW),
      'the fixture is the longest the floor must hold',
    ).toBeLessThanOrEqual(usable(FLOOR));
    expect(fullNavLegend({ ...ALL, columns: FLOOR })).toEqual([MOVE_ROW, TOOLS_ROW]);
  });

  it('offers Tab only when there is a change to go to', () => {
    expect(items({ hasChanges: false })).not.toContain('Tab/Shift+Tab changes');
    expect(items({ hasChanges: true })).toContain('Tab/Shift+Tab changes');
    expect(fullNavLegend({ ...ALL, hasChanges: false })[0]).toBe(
      '↑/↓ scroll · PgUp/PgDn page · Home/End top/end',
    );
  });

  it('offers `r` only when something is masked, and says what it will do next', () => {
    expect(items({ hasMasks: false }).filter((item) => item.startsWith('[r]'))).toEqual([]);
    expect(
      items({ hasMasks: false, revealed: true }).filter((item) => item.startsWith('[r]')),
    ).toEqual([]);
    expect(items({ hasMasks: true, revealed: false })).toContain('[r] reveal masked');
    expect(items({ hasMasks: true, revealed: true })).toContain('[r] hide masked');
    expect(items({ hasMasks: true, revealed: true })).not.toContain('[r] reveal masked');
  });

  it('offers `[c] copy page` only when a clipboard is bound', () => {
    expect(items({ canCopy: false }).filter((item) => item.startsWith('[c]'))).toEqual([]);
    expect(items({ canCopy: true })).toContain('[c] copy page');
  });

  it('says what `p` will switch to', () => {
    expect(items({ numeric: false })).toContain('[p] Unicode codes');
    expect(items({ numeric: true })).toContain('[p] back to text');
    expect(items({ numeric: true })).not.toContain('[p] Unicode codes');
  });

  it('never offers `b`: it sits with the answers on an approval and with the close note on details', () => {
    for (const columns of [40, 80, 140])
      for (const hasChanges of [true, false])
        for (const hasMasks of [true, false])
          for (const rows of [fullNavLegend({ ...ALL, columns, hasChanges, hasMasks })]) {
            expect(rows.join('\n')).not.toMatch(/\[b\]/u);
            expect(rows.join('\n')).not.toMatch(/back to/iu);
          }
  });

  it('always offers scrolling, paging, the ends, search and the code-point switch', () => {
    expect(items({ hasChanges: false, hasMasks: false, canCopy: false })).toEqual([
      '↑/↓ scroll',
      'PgUp/PgDn page',
      'Home/End top/end',
      '[/] search',
      '[p] Unicode codes',
    ]);
  });

  it('never lets the two groups share a row, however wide the terminal', () => {
    const rows = fullNavLegend({ ...ALL, columns: 400 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toContain('[/]');
    expect(rows[1]).not.toContain('↑/↓');
  });

  it('packs into more rows on a narrow terminal than on a wide one', () => {
    expect(fullNavLegend({ ...ALL, columns: 60 }).length).toBeGreaterThan(
      fullNavLegend({ ...ALL, columns: 140 }).length,
    );
    expect(fullNavLegend({ ...ALL, columns: 60 })).toEqual([
      '↑/↓ scroll · PgUp/PgDn page · Home/End top/end',
      'Tab/Shift+Tab changes',
      '[/] search · [r] reveal masked · [p] Unicode codes',
      '[c] copy page',
    ]);
  });

  describe('property: over 40..200 columns and every combination of what applies', () => {
    const flagSets: NavLegendInput[] = [];
    for (const hasChanges of [true, false])
      for (const hasMasks of [true, false])
        for (const canCopy of [true, false])
          for (const revealed of [true, false])
            for (const numeric of [true, false])
              flagSets.push({ hasChanges, hasMasks, canCopy, revealed, numeric, columns: 80 });
    const flagLabel = (flags: NavLegendInput, columns: number): string =>
      `@${columns} ${JSON.stringify({ ...flags, columns: undefined })}`;

    it('no row is wider than columns - 2, no key is split, and each group keeps the legend’s own order', () => {
      const { check, none } = collect();
      for (const columns of WIDTHS)
        for (const flags of flagSets) {
          const rows = fullNavLegend({ ...flags, columns });
          for (const row of rows)
            check(
              displayWidth(row) <= usable(columns),
              () => `${flagLabel(flags, columns)}: too wide: ${row}`,
            );
          check(
            JSON.stringify(rows.flatMap((row) => row.split(GAP))) ===
              JSON.stringify([...moveItems(flags), ...toolItems(flags)]),
            () =>
              `${flagLabel(flags, columns)}: the keys or their order differ: ${JSON.stringify(rows)}`,
          );
        }
      none();
    });

    it('never puts a movement key and an inspection key on one row, and lists the movement rows first', () => {
      const { check, none } = collect();
      for (const columns of WIDTHS)
        for (const flags of flagSets) {
          const moves = new Set(moveItems(flags));
          const kinds = fullNavLegend({ ...flags, columns }).map((row) => {
            const parts = row.split(GAP);
            return parts.every((part) => moves.has(part))
              ? 'move'
              : parts.every((part) => !moves.has(part))
                ? 'tools'
                : 'mixed';
          });
          check(
            !kinds.includes('mixed'),
            () => `${flagLabel(flags, columns)}: a row mixes the groups`,
          );
          check(
            /^(?:move,)+tools(?:,tools)*$/u.test(kinds.join(',')),
            () =>
              `${flagLabel(flags, columns)}: the groups are not movement-then-tools: ${kinds.join(',')}`,
          );
        }
      none();
    });

    it('is packed greedily within a group: the first key of a row would not have fitted on the row above', () => {
      const { check, none } = collect();
      for (const columns of WIDTHS)
        for (const flags of flagSets) {
          const moves = new Set(moveItems(flags));
          const rows = fullNavLegend({ ...flags, columns });
          for (let index = 1; index < rows.length; index++) {
            const previous = rows[index - 1] ?? '';
            const first = (rows[index] ?? '').split(GAP)[0] ?? '';
            const sameGroup = moves.has(first) === moves.has(previous.split(GAP)[0] ?? '');
            if (!sameGroup) continue;
            check(
              displayWidth(`${previous}${GAP}${first}`) > usable(columns),
              () =>
                `${flagLabel(flags, columns)}: "${first}" fits on the row above, so the row was broken early`,
            );
          }
        }
      none();
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// fullAnswerRows
// Mutation: return `rows` unchanged for a non-confirm question (the card's Ctrl+R / [v] come back); return the confirm
// rows on the wrong flag; return one row; reword the second row; give the locked row the card's wording.
// ---------------------------------------------------------------------------------------------------------------------
describe('fullAnswerRows — the card’s two rows, without the keys only the card has', () => {
  const DENY_ROW = '[Ctrl+N] Deny · [b] back to the card · [Ctrl+C] stops the turn · Esc back';
  const scopes = [
    'file writes',
    'file edits',
    cardScopePhrase('mcp:a-very-long-server:and-a-very-long-tool-name'),
  ];

  it('keeps the card’s grants row and replaces the second row with the refusals and the way back that exist here', () => {
    const input: CardKeyInput = { inspected: true, cacheable: true, scope: 'file edits' };
    expect(fullAnswerRows(input)).toEqual([
      '[Ctrl+Y] Allow · [Ctrl+G] Allow all file edits this session',
      DENY_ROW,
    ]);
    expect(fullAnswerRows(input)[0]).toBe(cardKeyRows(input)[0]);
  });

  it('says only Allow when an "always" answer would not be remembered', () => {
    expect(fullAnswerRows({ inspected: true, cacheable: false, scope: 'x' })).toEqual([
      '[Ctrl+Y] Allow',
      DENY_ROW,
    ]);
  });

  it('says Allow is locked and points at the warning above, and still offers Deny, while the inspection is owed', () => {
    for (const cacheable of [true, false])
      expect(fullAnswerRows({ inspected: false, cacheable, scope: 'file edits' })).toEqual([
        '(Allow is locked — see the warning above)',
        DENY_ROW,
      ]);
  });

  it('does not borrow the card’s own locked wording: the full view names the cause in its warning row', () => {
    const input: CardKeyInput = { inspected: false, cacheable: true, scope: 'file edits' };
    expect(cardKeyRows(input)[0], 'the card keeps its wording').toBe(
      '(Allow is locked until you inspect the change)',
    );
    expect(fullAnswerRows(input)[0]).not.toBe(cardKeyRows(input)[0]);
    expect(fullAnswerRows(input)[0]).not.toContain('Ctrl+Y');
    expect(displayWidth(fullAnswerRows(input)[0])).toBeLessThanOrEqual(78);
  });

  it('keeps the card’s confirmation rows when the session-wide grant waits, locked or not', () => {
    const input: CardKeyInput = {
      inspected: false,
      cacheable: true,
      scope: 'file edits',
      confirmAlways: true,
    };
    // The question is the card's, word for word; only the second row differs: Esc steps back here and Ctrl+C stops (ADR-0137 §4).
    expect(fullAnswerRows(input)[0]).toBe(cardKeyRows(input)[0]);
    expect(fullAnswerRows(input)[1]).toBe(FULL_CONFIRM_ANY_ROW);
  });

  it('offers neither the denial reason nor the full diff: they are keys of the card, and this is the full view', () => {
    for (const inspected of [true, false])
      for (const cacheable of [true, false]) {
        const second = fullAnswerRows({ inspected, cacheable, scope: 'file writes' })[1];
        expect(second).not.toContain('Ctrl+R');
        expect(second).not.toContain('[v]');
        expect(second).not.toContain('full diff');
      }
  });

  it('names `[b] back to the card` in the second row, whether or not Allow is offered: back is never locked', () => {
    for (const inspected of [true, false])
      for (const cacheable of [true, false])
        expect(fullAnswerRows({ inspected, cacheable, scope: 'file writes' })[1]).toContain(
          '[b] back to the card',
        );
  });

  it('is always exactly two rows, so the chrome never changes height with the question', () => {
    for (const inspected of [true, false])
      for (const cacheable of [true, false])
        for (const confirmAlways of [true, false, undefined])
          for (const scope of scopes)
            expect(
              fullAnswerRows({
                inspected,
                cacheable,
                scope,
                ...(confirmAlways === undefined ? {} : { confirmAlways }),
              }),
            ).toHaveLength(2);
  });

  it('keeps both rows inside 78 columns for the longest scope phrase', () => {
    for (const scope of scopes)
      for (const row of fullAnswerRows({ inspected: true, cacheable: true, scope }))
        expect(displayWidth(row)).toBeLessThanOrEqual(78);
  });

  // Moved from the card's tests: `fullViewConfirmLegend` ("the full view asks the same question as the card, in one row that
  // fits") is gone; the full view draws the card's own question row and its own second row, which says what Esc and Ctrl+C do HERE
  // (the card's `Esc stops the turn` would be false on the full view, where Esc steps back, ADR-0137 §4).
  describe('while the session-wide grant waits for its Enter (the card’s question, its own second row)', () => {
    it('asks the card’s question in its first row, and says in its second what the keys do on the full view', () => {
      for (const scope of scopes) {
        const input: CardKeyInput = {
          inspected: true,
          cacheable: true,
          scope,
          confirmAlways: true,
        };
        expect(fullAnswerRows(input)[0]).toBe(cardKeyRows(input)[0]);
        expect(fullAnswerRows(input)[1]).not.toBe(cardKeyRows(input)[1]);
      }
      expect(
        fullAnswerRows({
          inspected: true,
          cacheable: true,
          scope: 'file writes',
          confirmAlways: true,
        }),
      ).toEqual([
        'Press Enter to allow all file writes this session',
        'any other key cancels · [Ctrl+C] stops the turn · Esc back',
      ]);
    });

    it('never tells the full view that Esc stops the turn: it steps back there, and the stop key Ctrl+C stays named', () => {
      for (const confirm of [{ confirmAlways: true }, { confirmRemember: true }] as const)
        for (const command of [true, false]) {
          const rows = fullAnswerRows({
            inspected: true,
            cacheable: true,
            scope: 'file writes',
            ...(command ? { command: true } : {}),
            ...confirm,
          });
          expect(rows[1], JSON.stringify({ confirm, command })).not.toContain('Esc stops');
          expect(rows[1]).toContain('Esc back');
          expect(rows[1]).toContain('[Ctrl+C] stops the turn');
        }
      // an Enter confirms a command's question, and any key a tool's
      expect(
        fullAnswerRows({
          inspected: true,
          cacheable: true,
          scope: 'x',
          command: true,
          confirmAlways: true,
        })[1],
      ).toBe(FULL_CONFIRM_ENTER_ROW);
      expect(
        fullAnswerRows({ inspected: true, cacheable: true, scope: 'x', confirmRemember: true })[1],
      ).toBe(FULL_CONFIRM_ENTER_ROW);
    });

    it('fits each row in 78 columns for the longest scope phrase, so "any other key cancels" is never cut off', () => {
      const scope = cardScopePhrase('mcp:a-very-long-server:and-a-very-long-tool-name');
      for (const extra of [{}, { command: true }, { confirmRemember: true, confirmAlways: false }])
        for (const row of fullAnswerRows({
          inspected: true,
          cacheable: true,
          scope,
          confirmAlways: true,
          ...extra,
        }))
          expect(displayWidth(row)).toBeLessThanOrEqual(78);
    });

    it('offers no `[b]` while it waits either: the card’s two rows are the whole question', () => {
      const rows = fullAnswerRows({
        inspected: true,
        cacheable: true,
        scope: 'file edits',
        confirmAlways: true,
      });
      expect(rows.join('\n')).not.toContain('[b]');
    });

    it('offers no Ctrl+Y / Ctrl+G / Ctrl+N / [v] while it waits: every other key cancels', () => {
      const rows = fullAnswerRows({
        inspected: true,
        cacheable: true,
        scope: 'file edits',
        confirmAlways: true,
      });
      expect(rows.join('\n')).not.toMatch(/\[(?:Ctrl\+[YGNR]|[ynvc])\]/u);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// fullChrome
// Mutation: drop any `+ 1` from `rows` (status rule, the always-reserved message row, note), count `warnings` twice, forget
// `input.searching`; give the details kind the approval note or answers; drop the nav legend's rows from the sum.
// ---------------------------------------------------------------------------------------------------------------------
describe('fullChrome — the rows the screen spends outside the body, counted once', () => {
  const base: FullChromeInput = {
    kind: 'approval',
    title: 'Review',
    columns: 80,
    document: countedDocument,
    identity: IDENTITY,
    hasTarget: true,
    pending: NO_PENDING,
    nav: { hasChanges: true, hasMasks: false, canCopy: true, revealed: false, numeric: false },
    keys: { inspected: true, cacheable: true, scope: 'file edits' },
    searching: false,
  };
  /** The rows of the parts, summed the way the screen draws them — not read from `rows`. */
  const summed = (chrome: ReturnType<typeof fullChrome>): number =>
    chrome.header.length +
    (chrome.hasTarget ? 1 : 0) +
    chrome.warnings.length +
    1 + // the status rule
    chrome.nav.length +
    chrome.answers.length +
    1 + // the message row: always reserved, empty or not
    1 + // the closing note
    (chrome.searching ? 1 : 0);

  it('counts a plain approval at 80 columns as nine rows: header, target, rule, message, two legend rows, two answers, a note', () => {
    const chrome = fullChrome(base);
    expect(chrome.header).toHaveLength(1);
    expect(chrome.warnings).toEqual([]);
    expect(chrome.nav).toHaveLength(2);
    expect(chrome.answers).toHaveLength(2);
    expect(chrome.rows).toBe(1 + 1 + 0 + 1 + 1 + 2 + 2 + 1);
    expect(chrome.rows).toBe(9);
  });

  it('counts a details screen at 80 columns as seven rows: it has no answers', () => {
    const chrome = fullChrome({
      ...base,
      kind: 'details',
      title: 'Details',
      document: plainCall,
      keys: undefined,
    });
    expect(chrome.answers).toEqual([]);
    expect(chrome.rows).toBe(1 + 1 + 0 + 1 + 1 + 2 + 0 + 1);
    expect(chrome.rows).toBe(7);
  });

  it('always reserves the message row, so a note that comes and goes never moves the body', () => {
    for (const kind of ['approval', 'details'] as const)
      for (const searching of [true, false]) {
        const chrome = fullChrome({
          ...base,
          kind,
          searching,
          keys: kind === 'details' ? undefined : base.keys,
        });
        // Everything but the message row, counted from the parts that are returned.
        const withoutMessage =
          chrome.header.length +
          (chrome.hasTarget ? 1 : 0) +
          chrome.warnings.length +
          1 +
          chrome.nav.length +
          chrome.answers.length +
          1 +
          (chrome.searching ? 1 : 0);
        expect(chrome.rows, `${kind} searching=${String(searching)}`).toBe(withoutMessage + 1);
      }
  });

  it('adds one row for a search and one for a target, and no more', () => {
    const plain = fullChrome(base).rows;
    expect(fullChrome({ ...base, searching: true }).rows).toBe(plain + 1);
    expect(fullChrome({ ...base, hasTarget: false }).rows).toBe(plain - 1);
    expect(fullChrome({ ...base, hasTarget: false, searching: true }).rows).toBe(plain);
  });

  it('counts the target row of a document that has a target, on an approval and on details alike', () => {
    const targeted = documentOf({ kind: 'operation', target: 'src/app.ts', fields: [] });
    expect(targeted.preview.target).toBe('src/app.ts');
    for (const kind of ['approval', 'details'] as const) {
      const input = {
        ...base,
        kind,
        title: kind === 'details' ? 'Details' : 'Review',
        document: targeted,
        keys: kind === 'details' ? undefined : base.keys,
      };
      const withTarget = fullChrome({ ...input, hasTarget: true });
      const without = fullChrome({ ...input, hasTarget: false });
      expect(withTarget.hasTarget, kind).toBe(true);
      expect(withTarget.rows - without.rows, `${kind}: exactly one row for the target`).toBe(1);
    }
  });

  it('adds exactly the warning rows a lock takes', () => {
    const plain = fullChrome(base);
    const locked = fullChrome({ ...base, pending: { target: true, masks: 2 } });
    expect(locked.warnings.length).toBeGreaterThan(0);
    expect(locked.rows - plain.rows).toBe(locked.warnings.length);
  });

  it('equals the sum of the parts it returns, for every shape the screen can take', () => {
    const identities: readonly (readonly string[])[] = [
      [],
      IDENTITY,
      [`tool ${'z'.repeat(150)}`, 'outcome success'],
    ];
    const documents: readonly (ReviewDocument | undefined)[] = [
      undefined,
      countedDocument,
      maskedDiff(2),
      plainCall,
      documentOf(endingsPreview({ before: 'a\r\n', after: 'a\n', beforeEndings: 'crlf' })),
    ];
    const pendings: readonly InspectionPending[] = [
      NO_PENDING,
      { target: true, masks: 0 },
      { target: true, masks: 3 },
    ];
    const navs = [
      base.nav,
      { hasChanges: false, hasMasks: true, canCopy: false, revealed: true, numeric: true },
    ];
    const keySets: readonly CardKeyInput[] = [
      { inspected: true, cacheable: true, scope: 'file edits' },
      { inspected: false, cacheable: false, scope: 'x' },
      { inspected: true, cacheable: true, scope: 'file writes', confirmAlways: true },
    ];
    let cases = 0;
    const { check, none } = collect();
    for (const columns of [40, 60, 80, 100, 140, 200])
      for (const identity of identities)
        for (const document of documents)
          for (const pending of pendings)
            for (const nav of navs)
              for (const hasTarget of [true, false])
                for (const searching of [true, false])
                  for (const kind of ['approval', 'details'] as const) {
                    const chrome = fullChrome({
                      ...base,
                      kind,
                      columns,
                      identity,
                      document,
                      pending,
                      nav,
                      hasTarget,
                      searching,
                      keys: kind === 'details' ? undefined : keySets[cases % keySets.length],
                    });
                    const case_ = cases++;
                    check(
                      chrome.rows === summed(chrome),
                      () =>
                        `${kind} @${columns} case ${case_}: rows ${chrome.rows} != ${summed(chrome)}`,
                    );
                  }
    none();
    expect(cases).toBeGreaterThan(1000);
  });

  it('carries the flags it was given, so the view draws exactly the rows that were counted', () => {
    const chrome = fullChrome({ ...base, hasTarget: false, searching: true });
    expect([chrome.hasTarget, chrome.searching]).toEqual([false, true]);
    expect('hasMessage' in chrome, 'the message row is reserved, not a flag').toBe(false);
  });

  it('puts the counts in the header and takes its warnings, legend and answers from the same functions the screen uses', () => {
    const chrome = fullChrome({ ...base, pending: { target: true, masks: 0 } });
    expect(chrome.header.join('\n')).toContain(COUNTS);
    expect(chrome.warnings).toEqual(
      fullWarnings({
        kind: 'approval',
        document: countedDocument,
        pending: { target: true, masks: 0 },
        columns: 80,
      }),
    );
    expect(chrome.nav).toEqual(fullNavLegend({ ...base.nav, columns: 80 }));
    expect(chrome.answers).toEqual(
      fullAnswerRows({ inspected: true, cacheable: true, scope: 'file edits' }),
    );
  });

  it('ends an approval on the protected-path note and a details screen on the close note, which has no answers', () => {
    const approval = fullChrome(base);
    expect(approval.note).toBe('Approval cannot override protected-path or permission denials.');
    expect(approval.note).toBe(FULL_PROTECTED_NOTE);
    expect(approval.answers).toHaveLength(2);
    expect(approval.answers[1], 'the way back sits with the answers').toContain(
      '[b] back to the card',
    );
    expect(approval.nav.join('\n'), 'and not in the legend').not.toContain('[b]');

    const details = fullChrome({ ...base, kind: 'details', title: 'Details', keys: undefined });
    expect(details.note).toBe('[b] back to the list · viewing never executes a tool · Esc close');
    expect(details.note).toBe(DETAILS_CLOSE_NOTE);
    expect(details.answers).toEqual([]);
    expect(details.note, 'the way back sits with the close note').toContain('[b] back to the list');
    expect(details.nav.join('\n'), 'and not in the legend').not.toContain('[b]');
    expect(details.header[0]).toMatch(/^Details/u);
  });

  it('asks the session-wide question in the same two answer rows, so the chrome does not change height while it waits', () => {
    const waiting = fullChrome({
      ...base,
      keys: { inspected: true, cacheable: true, scope: 'file edits', confirmAlways: true },
    });
    expect(waiting.answers).toEqual([
      'Press Enter to allow all file edits this session',
      'any other key cancels · [Ctrl+C] stops the turn · Esc back',
    ]);
    expect(waiting.rows).toBe(fullChrome(base).rows);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// fullBodyRows
// Mutation: drop `FULL_SPARE_ROWS` from the subtraction; drop `Math.max(1, …)`; subtract the chrome twice; drop the
// `Math.min(FULL_BODY_ROWS_CAP, …)` or change the cap.
// ---------------------------------------------------------------------------------------------------------------------
describe('fullBodyRows — what a terminal leaves once the chrome and the spare row are taken', () => {
  it('is the terminal’s rows minus the chrome minus the one spare row', () => {
    expect(FULL_SPARE_ROWS).toBe(1);
    expect(fullBodyRows(24, 8)).toBe(15);
    expect(fullBodyRows(40, 10)).toBe(29);
  });

  it('is capped at FULL_BODY_ROWS_CAP rows on a tall terminal, and is rows - 1 - chrome below the cap', () => {
    expect(FULL_BODY_ROWS_CAP).toBe(200);
    expect(fullBodyRows(400, 9)).toBe(200);
    expect(fullBodyRows(1000, 30)).toBe(200);
    // Exactly at and around the cap: 210 rows - 1 spare - 9 chrome = 200.
    expect(fullBodyRows(210, 9)).toBe(200);
    expect(fullBodyRows(209, 9)).toBe(199);
    expect(fullBodyRows(211, 9)).toBe(200);
    for (let terminal = 24; terminal <= 400; terminal += 7)
      expect(fullBodyRows(terminal, 9), `${terminal} rows`).toBe(
        Math.min(200, terminal - FULL_SPARE_ROWS - 9),
      );
  });

  it('is never below one row, however much chrome there is', () => {
    expect(fullBodyRows(24, 22)).toBe(1);
    expect(fullBodyRows(24, 23)).toBe(1);
    expect(fullBodyRows(24, 60)).toBe(1);
    expect(fullBodyRows(5, 5)).toBe(1);
    expect(fullBodyRows(0, 0)).toBe(1);
  });

  it('leaves the screen at least one row shorter than the terminal whenever the body is not clamped', () => {
    for (let terminal = 10; terminal <= 80; terminal++)
      for (let chrome = 4; chrome <= 14; chrome++) {
        const body = fullBodyRows(terminal, chrome);
        if (terminal - 1 - chrome >= 1) {
          expect(body + chrome, `${terminal} rows, ${chrome} chrome`).toBe(
            terminal - FULL_SPARE_ROWS,
          );
          expect(body + chrome).toBeLessThan(terminal);
        } else expect(body).toBe(1);
      }
  });

  it('gives the 80×24 floor a body of 14–17 rows for the chrome the screen really has (ADR-0134 §3)', () => {
    const chrome = fullChrome({
      kind: 'approval',
      title: 'Review',
      columns: 80,
      document: countedDocument,
      identity: IDENTITY,
      hasTarget: true,
      pending: NO_PENDING,
      nav: { hasChanges: true, hasMasks: false, canCopy: true, revealed: false, numeric: false },
      keys: { inspected: true, cacheable: true, scope: 'file edits' },
      searching: false,
    });
    const body = fullBodyRows(24, chrome.rows);
    expect(body).toBeGreaterThanOrEqual(14);
    expect(body).toBeLessThanOrEqual(17);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// escapedFit
// Mutation: `displayWidth(out + token) > budget` -> a sum of token widths (a keycap run overflows); `keep === 'middle'`
// ignored or its `width >= 5` guard dropped; the tail cut inside a token; map `char` straight through
// (`escapeReviewCharacter` bypassed); cut `text` before escaping; drop the `width <= 0` guard.
// ---------------------------------------------------------------------------------------------------------------------
describe('escapedFit — safe for a terminal row, cut to a width, an escape token never split', () => {
  it('writes a control character, an escape, a bidi override and `<` as visible tokens', () => {
    expect(escapedFit('a\x07b', 40)).toBe('a<U+0007>b');
    expect(escapedFit('a\x1b[31mb', 40)).toBe('a<U+001B>[31mb');
    expect(escapedFit('a\u202eb', 40)).toBe('a<U+202E>b');
    expect(escapedFit('<b>', 40)).toBe('<U+003C>b>');
    expect(escapedFit('a\tb', 40)).toBe('a<TAB>b');
  });

  it('leaves ordinary and wide text as it is, and adds no ellipsis when the text fits', () => {
    expect(escapedFit('src/app.ts', 10)).toBe('src/app.ts');
    expect(escapedFit('日本語', 6)).toBe('日本語');
    expect(escapedFit('', 5)).toBe('');
    expect(escapedFit('a\x07', '<U+0007>'.length + 1)).toBe('a<U+0007>');
    expect(escapedFit('abc', 3)).toBe('abc');
  });

  it('cuts with a single ellipsis and stays inside the width when the text does not fit', () => {
    expect(escapedFit('abcdefghij', 5)).toBe('abcd…');
    expect(escapedFit('abcdefghij', 9)).toBe('abcdefgh…');
    expect(escapedFit('ab', 1)).toBe('…');
    expect(escapedFit('a', 1)).toBe('a');
  });

  it('counts a wide character as two columns', () => {
    expect(escapedFit('日本語日本語', 7)).toBe('日本語…');
    expect(escapedFit('日本語日本語', 6)).toBe('日本…');
    expect(escapedFit('日本語日本語', 5)).toBe('日本…');
    expect(escapedFit('日本語日本語', 4)).toBe('日…');
    expect(escapedFit('日本語日本語', 2)).toBe('…');
    expect(escapedFit('a日b', 4)).toBe('a日b');
  });

  it('is the empty string for a width of zero or less', () => {
    for (const width of [0, -1, -40]) expect(escapedFit('anything at all', width)).toBe('');
    expect(escapedFit('', 0)).toBe('');
  });

  it('never cuts an escape token in half: a token that does not fit is dropped whole', () => {
    // `<U+202E>` is eight columns wide: at width 5 nothing of it can be drawn, and `<U+20` must not appear.
    expect(escapedFit('ab\u202ecd', 5)).toBe('ab…');
    expect(escapedFit('\u202e', 7)).toBe('…');
    expect(escapedFit('\u202e', 8)).toBe('<U+202E>');
  });

  it('property: every cut is a whole-token prefix, within the width, ending in an ellipsis only when something was cut', () => {
    const samples = [
      'plain text of some length',
      'a\x1b[31mred\x1b[0m<tag>\u202eevil\u202c',
      '\x07\x07\x07\x07\x07',
      '日本語のテキスト<b>日本語',
      'tab\there\tand<more>',
    ];
    const whole = (token: string): boolean => /^(?:<U\+[0-9A-F]{4,6}>|<TAB>|[^<])$/u.test(token);
    for (const sample of samples) {
      const full = escapedFit(sample, 10_000);
      expect(full.includes('…'), 'the full text carries no ellipsis of its own').toBe(false);
      const fullTokens = full.match(/<U\+[0-9A-F]{4,6}>|<TAB>|[^<]/gu) ?? [];
      expect(fullTokens.join('')).toBe(full);
      for (let width = 1; width <= displayWidth(full) + 2; width++) {
        const out = escapedFit(sample, width);
        const label = `${JSON.stringify(sample)} @${width}`;
        expect(displayWidth(out), label).toBeLessThanOrEqual(width);
        const cut = out.endsWith('…');
        expect(cut, `${label}: an ellipsis exactly when the full text did not fit`).toBe(
          displayWidth(full) > width,
        );
        const kept = cut ? out.slice(0, -1) : out;
        const keptTokens = kept.match(/<U\+[0-9A-F]{4,6}>|<TAB>|[^<]/gu) ?? [];
        expect(keptTokens.join(''), `${label}: no half token`).toBe(kept);
        expect(keptTokens.every(whole), label).toBe(true);
        expect(full.startsWith(kept), `${label}: a prefix of the full escaped text`).toBe(true);
        // Maximal: the next token would not have fitted beside the ellipsis (measured as the string it would make).
        const next = fullTokens[keptTokens.length];
        if (cut && next !== undefined)
          expect(
            displayWidth(kept + next),
            `${label}: the cut is as late as it can be`,
          ).toBeGreaterThan(width - 1);
      }
    }
  });
});

/** Splits escaped text into the tokens `escapedFit` works in: an escape token is one piece, anything else one code point. */
const escapeTokens = (escaped: string): readonly string[] =>
  escaped.match(/<U\+[0-9A-F]{4,6}>|<TAB>|<SP>|[^<]/gu) ?? [];
const isTokenPrefix = (tokens: readonly string[], text: string): boolean =>
  tokens.some((_, count) => tokens.slice(0, count).join('') === text) || tokens.join('') === text;
const isTokenSuffix = (tokens: readonly string[], text: string): boolean =>
  tokens.some((_, count) => tokens.slice(count).join('') === text) || text === '';

const KEYCAPS = (count: number): string => '1\u20e3'.repeat(count);
const FLAGS = '🇹🇷🇯🇵🇺🇸🇩🇪'.repeat(4);
const CJK = '日本語のファイル名/日本語のテキスト'.repeat(3);

describe('escapedFit measures the WHOLE cut string, not the sum of its tokens (a digit and U+20E3 are two cells together)', () => {
  it('has the premise: a keycap cluster is wider than its tokens add up to', () => {
    expect(displayWidth('1\u20e3')).toBeGreaterThan(displayWidth('1') + displayWidth('\u20e3'));
    expect(displayWidth(KEYCAPS(10))).toBe(20);
  });

  it('cuts a run of keycaps at the width of the string it leaves, with a single ellipsis, and never leaves a digit without its keycap', () => {
    expect(escapedFit(KEYCAPS(10), 20)).toBe(KEYCAPS(10));
    expect(escapedFit(KEYCAPS(10), 21)).toBe(KEYCAPS(10));
    // A digit whose keycap did not fit is dropped with it: nine columns, not ten, and no bare `1` before the ellipsis.
    expect(escapedFit(KEYCAPS(10), 11)).toBe(`${KEYCAPS(5)}…`);
    expect(escapedFit(KEYCAPS(10), 10)).toBe(`${KEYCAPS(4)}…`);
    expect(escapedFit(KEYCAPS(10), 9)).toBe(`${KEYCAPS(4)}…`);
    expect(escapedFit(KEYCAPS(10), 5)).toBe(`${KEYCAPS(2)}…`);
    expect(escapedFit(KEYCAPS(10), 3)).toBe(`${KEYCAPS(1)}…`);
    expect(escapedFit(KEYCAPS(10), 1)).toBe('…');
  });

  it('never returns more than the width, for keycaps, flags, CJK and a mixture, at every width 1..120', () => {
    const { check, none } = collect();
    const samples = [
      ...[1, 2, 3, 7, 12, 40].map(KEYCAPS),
      FLAGS,
      CJK,
      `src/${KEYCAPS(6)}/${FLAGS}/${CJK}.ts`,
    ];
    for (const sample of samples)
      for (let width = 1; width <= 120; width++)
        for (const keep of ['start', 'middle'] as const) {
          const out = escapedFit(sample, width, keep);
          check(
            displayWidth(out) <= width,
            () =>
              `${keep} @${width} ${JSON.stringify(sample.slice(0, 12))}: ${displayWidth(out)} wide`,
          );
        }
    none();
  });

  it('property: every cut is a whole-token prefix of the full text, with the keycaps, flags and CJK included', () => {
    const { check, none } = collect();
    for (const sample of [KEYCAPS(15), FLAGS, CJK, `a<${KEYCAPS(3)}\u202e${FLAGS}`]) {
      const full = escapedFit(sample, 10_000);
      const tokens = escapeTokens(full);
      for (let width = 1; width <= displayWidth(full) + 2; width++) {
        const out = escapedFit(sample, width);
        const cut = out.endsWith('…');
        const kept = cut ? out.slice(0, -1) : out;
        check(cut === displayWidth(full) > width, () => `@${width}: ellipsis iff it did not fit`);
        check(isTokenPrefix(tokens, kept), () => `@${width}: not a whole-token prefix: ${out}`);
      }
    }
    none();
  });
});

describe('escapedFit keep: "middle" — a path keeps its name', () => {
  const PATH = 'src/components/deeply/nested/folder/ReviewScreen.tsx';

  it('keeps about a third of the start and the end, with one ellipsis between, within the width', () => {
    expect(escapedFit(PATH, 24, 'middle')).toBe('src/com…ReviewScreen.tsx');
    expect(escapedFit(PATH, 30, 'middle')).toBe('src/compo…der/ReviewScreen.tsx');
    expect(escapedFit(PATH, 40, 'middle')).toBe('src/component…ed/folder/ReviewScreen.tsx');
    expect(escapedFit(PATH, 10, 'middle')).toBe('src…en.tsx');
    expect(escapedFit(PATH, 5, 'middle')).toBe('s…tsx');
  });

  it('keeps the whole final path segment at every width that has room for it', () => {
    for (let width = 24; width < displayWidth(PATH); width++) {
      const out = escapedFit(PATH, width, 'middle');
      expect(out.endsWith('ReviewScreen.tsx'), `@${width}: ${out}`).toBe(true);
      expect(out.startsWith('src/'.slice(0, 3)), `@${width}: the head too`).toBe(true);
      expect(out.split('…'), `@${width}: one ellipsis`).toHaveLength(2);
    }
  });

  it('keeps the start and the end of the text, a smaller piece of each, at the widths with no room for the whole name', () => {
    for (let width = 5; width < 24; width++) {
      const out = escapedFit(PATH, width, 'middle');
      const [head = '', tail = ''] = out.split('…');
      expect(head.length, `@${width}: a head`).toBeGreaterThan(0);
      expect(tail.length, `@${width}: a tail`).toBeGreaterThan(1);
      expect(PATH.startsWith(head), `@${width}: ${out}`).toBe(true);
      expect(PATH.endsWith(tail), `@${width}: ${out}`).toBe(true);
      expect(displayWidth(out), `@${width}`).toBeLessThanOrEqual(width);
    }
  });

  it('is identical to start mode when the text fits, and returns it whole', () => {
    for (let width = displayWidth(PATH); width <= displayWidth(PATH) + 8; width++) {
      expect(escapedFit(PATH, width, 'middle')).toBe(PATH);
      expect(escapedFit(PATH, width, 'middle')).toBe(escapedFit(PATH, width));
    }
    expect(escapedFit('a\x07b/c', 40, 'middle')).toBe(escapedFit('a\x07b/c', 40));
  });

  it('falls back to start mode below 5 columns, where there is no room for two pieces', () => {
    for (const width of [1, 2, 3, 4]) {
      expect(escapedFit(PATH, width, 'middle'), `@${width}`).toBe(escapedFit(PATH, width));
    }
    expect(escapedFit(PATH, 4, 'middle')).toBe('src…');
    expect(escapedFit(PATH, 0, 'middle')).toBe('');
    expect(escapedFit(PATH, -3, 'middle')).toBe('');
  });

  it('property: a head, an ellipsis, a tail — each a whole-token piece of the text — within the width, for any width 1..120', () => {
    const { check, none } = collect();
    const samples = [
      PATH,
      `src/${KEYCAPS(8)}/deep/${KEYCAPS(8)}.ts`,
      `${CJK}/ファイル.ts`,
      'dir/\u202eevil<tag>/\x07name\x1b[31m.ts',
      `${FLAGS}/${FLAGS}.ts`,
    ];
    for (const sample of samples) {
      const full = escapedFit(sample, 10_000);
      const tokens = escapeTokens(full);
      for (let width = 1; width <= 120; width++) {
        const out = escapedFit(sample, width, 'middle');
        const label = (what: string) => () =>
          `${what}: @${width} ${JSON.stringify(sample.slice(0, 14))} -> ${out}`;
        check(displayWidth(out) <= width, label('too wide'));
        if (displayWidth(full) <= width) {
          check(
            out === full && out === escapedFit(sample, width),
            label('a text that fits is returned whole'),
          );
          continue;
        }
        if (width < 5) {
          check(out === escapedFit(sample, width), label('below 5 columns it is start mode'));
          continue;
        }
        const parts = out.split('…');
        check(parts.length === 2, label('exactly one ellipsis'));
        const [head = '', tail = ''] = parts;
        check(isTokenPrefix(tokens, head), label('the head is a whole-token prefix'));
        check(isTokenSuffix(tokens, tail), label('the tail is a whole-token suffix'));
        check(head.length + tail.length > 0, label('keeps something of the text'));
      }
    }
    none();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// escapedFit is bounded
// Mutation: measure the whole string once per token again (quadratic: the measured-characters bound fails, a 100,000-character
// text measures millions); drop `if (kept.length >= cap) break` (a long zero-width run is no longer cut at the cap); take the
// cap from the text instead of the width; skip the `while (kept.length > 0 && … > width) kept.pop()` retraction.
// ---------------------------------------------------------------------------------------------------------------------
/** The combining acute accent, built from its code so no source tooling can fold it into its base letter. */
const MARK = String.fromCharCode(0x301);

/** The old, quadratic `escapedFit`, kept here as an oracle: it measured the whole string it was building, once per token. */
function referenceEscapedFit(text: string, width: number, keep: 'start' | 'middle'): string {
  if (width <= 0) return '';
  const tokens = [...text].map((char) => escapeReviewCharacter(char, false));
  const whole = tokens.join('');
  if (displayWidth(whole) <= width) return whole;
  const head = (budget: number): string => {
    let out = '';
    for (const token of tokens) {
      if (displayWidth(out + token) > budget) break;
      out += token;
    }
    return out;
  };
  if (keep === 'middle' && width >= 5) {
    const first = head(Math.floor((width - 1) / 3));
    let last = '';
    for (let index = tokens.length - 1; index >= 0; index--) {
      const token = tokens[index] ?? '';
      if (displayWidth(`${first}…${token}${last}`) > width) break;
      last = token + last;
    }
    const joined = `${first}…${last}`;
    if (displayWidth(joined) <= width) return joined;
  }
  return `${head(width - 1)}…`;
}

describe('escapedFit is bounded: what it costs follows the width, not the length of the text', () => {
  /** What `work` asked the measurer, from a clean count. */
  const measure = (work: () => void): { calls: number; characters: number } => {
    measured.calls = 0;
    measured.characters = 0;
    work();
    return { calls: measured.calls, characters: measured.characters };
  };
  const timed = (work: () => void): number => {
    const start = performance.now();
    work();
    return performance.now() - start;
  };

  describe('a 512-character target of a base letter and 511 combining marks', () => {
    const MARKED = `a${MARK.repeat(511)}`;
    const SPREAD = `a${MARK}`.repeat(256);

    it('has the premise: 512 characters, one cell wide as it stands, 256 cells wide as 256 marked letters', () => {
      expect(MARKED).toHaveLength(512);
      expect(displayWidth(MARKED)).toBe(1);
      expect(SPREAD).toHaveLength(512);
      expect(displayWidth(SPREAD)).toBe(256);
    });

    it('is returned whole when it is one cell wide, within the width, at 5..120 columns, in well under 200 ms', () => {
      const widths = Array.from({ length: 116 }, (_, index) => 5 + index);
      const outs: string[] = [];
      const elapsed = timed(() => {
        for (const width of widths) outs.push(escapedFit(MARKED, width));
      });
      expect(elapsed, 'all 116 widths, in total').toBeLessThan(200);
      for (const [index, out] of outs.entries()) {
        expect(displayWidth(out), `@${widths[index]}`).toBeLessThanOrEqual(widths[index] ?? 0);
        expect(out).toBe(MARKED);
      }
    });

    it('is cut to the width, ending in an ellipsis, as a whole-token prefix, at 5..120 columns, in well under 200 ms', () => {
      const widths = Array.from({ length: 116 }, (_, index) => 5 + index);
      const outs: string[] = [];
      const elapsed = timed(() => {
        for (const width of widths) outs.push(escapedFit(SPREAD, width));
      });
      expect(elapsed, 'all 116 widths, in total').toBeLessThan(200);
      const tokens = escapeTokens(SPREAD);
      for (const [index, out] of outs.entries()) {
        const width = widths[index] ?? 0;
        expect(displayWidth(out), `@${width}`).toBeLessThanOrEqual(width);
        expect(out.endsWith('…'), `@${width}: ${out.length} characters`).toBe(true);
        expect(isTokenPrefix(tokens, out.slice(0, -1)), `@${width}: a whole-token prefix`).toBe(
          true,
        );
        expect(SPREAD.startsWith(out.slice(0, -1)), `@${width}`).toBe(true);
      }
    });

    it('in middle mode keeps a head and a tail, within the width, in well under 200 ms', () => {
      const widths = Array.from({ length: 116 }, (_, index) => 5 + index);
      const outs: string[] = [];
      const elapsed = timed(() => {
        for (const width of widths) outs.push(escapedFit(SPREAD, width, 'middle'));
      });
      expect(elapsed, 'all 116 widths, in total').toBeLessThan(200);
      const tokens = escapeTokens(SPREAD);
      for (const [index, out] of outs.entries()) {
        const width = widths[index] ?? 0;
        expect(displayWidth(out), `@${width}`).toBeLessThanOrEqual(width);
        const parts = out.split('…');
        expect(parts, `@${width}: one ellipsis`).toHaveLength(2);
        const [head = '', tail = ''] = parts;
        expect(head.length, `@${width}: a head`).toBeGreaterThan(0);
        expect(tail.length, `@${width}: a tail`).toBeGreaterThan(0);
        expect(isTokenPrefix(tokens, head), `@${width}: head`).toBe(true);
        expect(isTokenSuffix(tokens, tail), `@${width}: tail`).toBe(true);
      }
    });
  });

  describe('a zero-width run', () => {
    it('of 10,000 marks returns promptly and within the width, at any width', () => {
      const run = MARK.repeat(10_000);
      expect(displayWidth(run)).toBe(0);
      for (const keep of ['start', 'middle'] as const)
        for (const width of [1, 5, 20, 120]) {
          let out = '';
          const elapsed = timed(() => {
            out = escapedFit(run, width, keep);
          });
          expect(elapsed, `${keep} @${width}`).toBeLessThan(200);
          expect(displayWidth(out), `${keep} @${width}`).toBeLessThanOrEqual(width);
        }
    });

    it('longer than the cap is cut with the ellipsis, and the cap is three pieces per column at each end', () => {
      // A visible letter, 10,000 marks, then thirty visible letters: wider than 20 columns, so it must be cut.
      const text = `a${MARK.repeat(10_000)}${'b'.repeat(30)}`;
      expect(displayWidth(text)).toBe(31);
      const width = 20;
      const cap = Math.max(16, 3 * width);
      const start = escapedFit(text, width);
      expect(start.endsWith('…')).toBe(true);
      expect(displayWidth(start)).toBeLessThanOrEqual(width);
      expect(start.startsWith('a')).toBe(true);
      expect(start.length, 'at most the cap of pieces, plus the ellipsis').toBeLessThanOrEqual(
        cap + 1,
      );
      const middle = escapedFit(text, width, 'middle');
      expect(displayWidth(middle)).toBeLessThanOrEqual(width);
      expect(middle.length, 'the cap at each end').toBeLessThanOrEqual(2 * cap + 1);
      expect(middle.endsWith('bbbbbbbb'), 'the tail still comes from the end').toBe(true);
    });

    it('of a thousand marks between two words keeps both words’ ends within the width', () => {
      const text = `start${MARK.repeat(1000)}middle${MARK.repeat(1000)}end of a long target`;
      // 31 cells of visible text: at 40 columns and up it fits whole, so the widths that cut it are below.
      for (const width of [5, 10, 20, 30]) {
        const out = escapedFit(text, width, 'middle');
        expect(displayWidth(out), `@${width}`).toBeLessThanOrEqual(width);
        expect(out.length, `@${width}`).toBeLessThanOrEqual(2 * Math.max(16, 3 * width) + 1);
      }
    });
  });

  describe('the cost is measured, not timed', () => {
    it.each([
      ['an ASCII path', (length: number) => `src/${'x'.repeat(length - 8)}.ts`],
      ['CJK', (length: number) => '日'.repeat(length)],
      ['escape tokens', (length: number) => '<'.repeat(length)],
      ['marked letters', (length: number) => `a${MARK}`.repeat(length / 2)],
      ['a zero-width run', (length: number) => MARK.repeat(length)],
      [
        'a letter, a zero-width run, then letters',
        (length: number) => `a${MARK.repeat(length)}${'b'.repeat(30)}`,
      ],
    ] as const)(
      'measures about the text once and at most a width’s worth besides, for %s, in both modes, at 60 columns',
      (_name, build) => {
        const width = 60;
        for (const length of [1_000, 10_000, 40_000])
          for (const keep of ['start', 'middle'] as const) {
            const text = build(length);
            const { calls, characters } = measure(() => {
              escapedFit(text, width, keep);
            });
            // The whole is measured once. A per-token measurer would add a text-length multiple of the width (millions).
            const escaped = [...text].map((char) => escapeReviewCharacter(char, false)).join('');
            expect(
              characters,
              `${keep} ${length} characters: ${characters} measured over ${calls} calls`,
            ).toBeLessThanOrEqual(escaped.length + 40 * width * width);
            expect(calls, `${keep} ${length} characters`).toBeLessThanOrEqual(8 * width * width);
          }
      },
    );

    it.each([
      ['ASCII', (length: number) => 'x'.repeat(length)],
      ['a zero-width run', (length: number) => `a${MARK.repeat(length)}${'b'.repeat(30)}`],
    ] as const)(
      'does not measure more for a text ten times longer, for %s: the work follows the width',
      (_name, build) => {
        for (const keep of ['start', 'middle'] as const) {
          const small = measure(() => {
            escapedFit(build(10_000), 60, keep);
          });
          const large = measure(() => {
            escapedFit(build(100_000), 60, keep);
          });
          expect(large.calls, `${keep}: the number of measurements`).toBeLessThanOrEqual(
            small.calls,
          );
          // Only the single measurement of the whole string grows, once, with the text.
          expect(large.characters - small.characters, keep).toBeLessThanOrEqual(
            2 * (100_000 - 10_000),
          );
        }
      },
    );
  });

  describe('the cap is per end and changes no ordinary result', () => {
    const ascii200 = `${'src/components/nested/'.repeat(9).slice(0, 184)}ReviewScreen.tsx`;
    const samples = [
      ascii200,
      'src/components/deeply/nested/folder/ReviewScreen.tsx',
      `${CJK}/ファイル.ts`,
      'dir/\u202eevil<tag>/\x07name\x1b[31m.ts',
      'plain text of some length',
      `日本語${'x'.repeat(150)}/ファイル.ts`,
    ];

    it('has the premise: the ASCII path is 200 characters', () => {
      expect(ascii200).toHaveLength(200);
    });

    it('equals the old quadratic algorithm for ordinary text, in both modes, at widths 1..120', () => {
      const { check, none } = collect();
      for (const sample of samples)
        for (const keep of ['start', 'middle'] as const)
          for (let width = 1; width <= 120; width++) {
            const out = escapedFit(sample, width, keep);
            check(
              out === referenceEscapedFit(sample, width, keep),
              () =>
                `${keep} @${width} ${JSON.stringify(sample.slice(0, 16))}: ${JSON.stringify(out)} != ${JSON.stringify(referenceEscapedFit(sample, width, keep))}`,
            );
          }
      none();
    });

    it('keeps the exact middle cuts of the 200-character path at widths 5..60 that the old algorithm made', () => {
      // The cap is max(16, 3 × width) pieces per end: far above what a width needs, so a cut is the same as without it.
      expect(escapedFit(ascii200, 5, 'middle')).toBe('s…tsx');
      expect(escapedFit(ascii200, 10, 'middle')).toBe('src…en.tsx');
      expect(escapedFit(ascii200, 24, 'middle')).toBe('src/com…ReviewScreen.tsx');
      expect(escapedFit(ascii200, 40, 'middle')).toBe('src/component…d/src/compReviewScreen.tsx');
      expect(escapedFit(ascii200, 60, 'middle')).toBe(
        'src/components/nest…mponents/nested/src/compReviewScreen.tsx',
      );
      for (let width = 5; width <= 60; width++) {
        const out = escapedFit(ascii200, width, 'middle');
        expect(displayWidth(out), `@${width}`).toBeLessThanOrEqual(width);
        expect(out.split('…'), `@${width}`).toHaveLength(2);
        expect(out.endsWith('ReviewScreen.tsx') || width < 24, `@${width}: ${out}`).toBe(true);
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// escapedFit on clusters: cost, a base never parted from its mark, and the verification of an estimate
// Mutation: pop one piece and re-measure the whole each time (cost: the measured-characters bound and the 150/300 ratio fail);
// `keepsCluster` returned unchanged (a start cut ends on a bare digit; the middle head ends on one); the tail's `while (…
// === 0) reversed.pop()` dropped (the tail opens with a bare U+20E3); the halving's `fits(count)` verification skipped (a
// keycap run overflows the width); the halving searching `[0, count]` only by the estimate.
// ---------------------------------------------------------------------------------------------------------------------
/** What `work` asked the measurer, from a clean count. */
function countMeasured(work: () => void): { calls: number; characters: number } {
  measured.calls = 0;
  measured.characters = 0;
  work();
  return { calls: measured.calls, characters: measured.characters };
}

describe('escapedFit on a keycap run costs the text times its logarithm, counted (not timed)', () => {
  // A keycap is a digit and U+20E3: two cells together, one apart — the estimate by pieces is short by half, so the cut has
  // to be searched for. Popping a piece and measuring again would cost the square of the width.
  const texts: readonly (readonly [string, string])[] = [
    ['512 characters of keycaps', KEYCAPS(256)],
    ['510 characters of keycaps each followed by a mark', `1⃣${MARK}`.repeat(170)],
  ];
  const WIDTHS_300 = Array.from({ length: 296 }, (_, index) => 5 + index);

  it.each(texts)(
    'measures at most length × (log2 length + 12) + a constant, at 5..300 columns, in both modes — %s',
    (_name, text) => {
      const bound = text.length * (Math.log2(text.length) + 12) + 2_000;
      const { check, none } = collect();
      for (const keep of ['start', 'middle'] as const)
        for (const width of WIDTHS_300) {
          const { characters } = countMeasured(() => {
            escapedFit(text, width, keep);
          });
          check(
            characters <= bound,
            () => `${keep} @${width}: measured ${characters} characters, over ${Math.round(bound)}`,
          );
        }
      none();
    },
  );

  it.each(texts)(
    'costs less than three times as much at 300 columns as at 150, in both modes — %s',
    (_name, text) => {
      for (const keep of ['start', 'middle'] as const) {
        const narrow = countMeasured(() => {
          escapedFit(text, 150, keep);
        });
        const wide = countMeasured(() => {
          escapedFit(text, 300, keep);
        });
        expect(narrow.characters, keep).toBeGreaterThan(0);
        expect(
          wide.characters / narrow.characters,
          `${keep}: ${wide.characters} / ${narrow.characters}`,
        ).toBeLessThan(3);
      }
    },
  );

  it('still returns a result within the width at every one of those widths', () => {
    const { check, none } = collect();
    for (const [, text] of texts)
      for (const keep of ['start', 'middle'] as const)
        for (const width of WIDTHS_300) {
          const out = escapedFit(text, width, keep);
          check(displayWidth(out) <= width, () => `${keep} @${width}: ${displayWidth(out)} wide`);
        }
    none();
  });
});

describe('escapedFit never separates a base from the zero-width mark after it', () => {
  const REVIEW_SAMPLE = `src/${KEYCAPS(20)}/f.ts`;
  const ZERO_WIDTH = (character: string): boolean => displayWidth(character) === 0;

  it('reads the review’s sample at 12 columns as a head, an ellipsis and a tail that opens on a digit, not on its keycap', () => {
    const out = escapedFit(REVIEW_SAMPLE, 12, 'middle');
    expect(out).toBe(`src…${KEYCAPS(1)}/f.ts`);
    expect(displayWidth(out)).toBeLessThanOrEqual(12);
    const [, tail = ''] = out.split('…');
    expect([...tail][0], 'the tail does not begin with a bare keycap').not.toBe('⃣');
    expect([...tail][0]).not.toBe(MARK);
  });

  it('keeps the review’s sample within the width and its head and tail clean at every width 5..120', () => {
    const { check, none } = collect();
    const text = [...REVIEW_SAMPLE];
    for (let width = 5; width <= 120; width++) {
      const out = escapedFit(REVIEW_SAMPLE, width, 'middle');
      check(displayWidth(out) <= width, () => `@${width}: ${displayWidth(out)} wide`);
      if (!out.includes('…')) continue;
      const [head = '', tail = ''] = out.split('…');
      const first = [...tail][0] ?? '';
      check(
        first === '' || !ZERO_WIDTH(first),
        () => `@${width}: the tail opens on a mark: ${out}`,
      );
      const headCharacters = [...head];
      const last = headCharacters.at(-1);
      const next = text[headCharacters.length];
      check(
        headCharacters.length < 2 ||
          last === undefined ||
          next === undefined ||
          ZERO_WIDTH(last) ||
          !ZERO_WIDTH(next),
        () => `@${width}: the head ends on a base whose mark was cut: ${out}`,
      );
    }
    none();
  });

  describe('property: over keycap, accent, flag, CJK and mixed text, at 5..120 columns', () => {
    const samples: readonly (readonly [string, string])[] = [
      ['keycaps', KEYCAPS(40)],
      ['accented letters', `a${MARK}b${MARK}c${MARK}`.repeat(25)],
      ['letters, each with two marks', `e${MARK}${MARK}`.repeat(40)],
      ['flags', FLAGS],
      ['CJK', CJK],
      ['a path of keycaps', `src/${KEYCAPS(20)}/f.ts`],
      ['a path of accents', `dir/${`e${MARK}`.repeat(30)}/${`o${MARK}`.repeat(10)}.ts`],
      ['a mixture', `日本${KEYCAPS(6)}/á${MARK}${FLAGS}/e${MARK}.ts`],
    ];

    it.each(samples)(
      'a start cut never ends on a base whose mark follows it in the text, and a middle cut opens its tail on no mark and closes its head on no stranded base — %s',
      (_name, sample) => {
        const { check, none } = collect();
        const text = [...sample];
        for (let width = 5; width <= 120; width++) {
          const start = escapedFit(sample, width);
          if (start.endsWith('…')) {
            const kept = [...start.slice(0, -1)];
            const last = kept.at(-1);
            const next = text[kept.length];
            // A single piece may stay: dropping it would leave nothing but the ellipsis.
            check(
              kept.length < 2 ||
                last === undefined ||
                next === undefined ||
                ZERO_WIDTH(last) ||
                !ZERO_WIDTH(next),
              () =>
                `start @${width}: ends on a base whose mark was left out: ${JSON.stringify(start)}`,
            );
          }
          const middle = escapedFit(sample, width, 'middle');
          if (middle.includes('…') && middle !== start) {
            const [head = '', tail = ''] = middle.split('…');
            const first = [...tail][0] ?? '';
            check(
              first === '' || !ZERO_WIDTH(first),
              () => `middle @${width}: the tail opens on a mark: ${JSON.stringify(middle)}`,
            );
            const headCharacters = [...head];
            const last = headCharacters.at(-1);
            const next = text[headCharacters.length];
            check(
              headCharacters.length < 2 ||
                last === undefined ||
                next === undefined ||
                ZERO_WIDTH(last) ||
                !ZERO_WIDTH(next),
              () =>
                `middle @${width}: the head ends on a base whose mark was cut: ${JSON.stringify(middle)}`,
            );
          }
          check(displayWidth(start) <= width, () => `start @${width}: ${displayWidth(start)} wide`);
          check(
            displayWidth(middle) <= width,
            () => `middle @${width}: ${displayWidth(middle)} wide`,
          );
        }
        none();
      },
    );
  });
});

describe('escapedFit verifies its estimate, in both directions: the whole decides, not the sum of the pieces', () => {
  // `☝🏻` (a hand and a skin-tone modifier), a decomposed Hangul syllable and a keycap with a modifier: the pieces add up to
  // MORE than the cluster is wide, where a keycap's pieces add up to LESS. Either way the cut must be measured as a whole.
  const JAMO = '한';
  const samples: readonly (readonly [string, string])[] = [
    ['a hand with a skin tone', '☝🏻'.repeat(40)],
    ['decomposed Hangul', JAMO.repeat(30)],
    ['a keycap with a skin tone', '1⃣🏻'.repeat(40)],
  ];

  it.each(samples)(
    'has the premise that the pieces add up to more than the whole — %s',
    (_name, sample) => {
      const parts = [...sample].reduce((sum, character) => sum + displayWidth(character), 0);
      expect(parts).toBeGreaterThan(displayWidth(sample));
    },
  );

  it.each(samples)(
    'gives a result within the width, in both modes, at every width 1..120 — %s',
    (_name, sample) => {
      const { check, none } = collect();
      for (const keep of ['start', 'middle'] as const)
        for (let width = 1; width <= 120; width++) {
          const out = escapedFit(sample, width, keep);
          check(displayWidth(out) <= width, () => `${keep} @${width}: ${displayWidth(out)} wide`);
        }
      none();
    },
  );

  // KNOWN LIMIT (decided 2026-11-17, recorded in deferred-tasks.md): the estimate is the sum of the pieces' own widths, and for
  // these clusters it counts MORE than the whole is wide, so the cut can be shorter than the room allows (a keycap with a skin
  // tone fills 4 columns of a 10-column room). It wastes columns; it never overflows, loses a byte or splits a cluster. An
  // upward probe was judged not worth its complexity for text that is rare in a tool's target. So the property is one third.
  it.each(samples)(
    'a result that is within the width, non-empty, a whole-token cut, and at least ONE THIRD as long as the linear-scan oracle’s (known limit: the estimate over-counts these clusters, so the cut can be shorter than the room) — %s',
    (_name, sample) => {
      const tokens = escapeTokens(escapedFit(sample, 10_000));
      const { check, none } = collect();
      for (const keep of ['start', 'middle'] as const)
        for (const width of [5, 6, 7, 10, 13, 20, 37, 60]) {
          const out = escapedFit(sample, width, keep);
          const label = (what: string) => () =>
            `${keep} @${width}: ${what}: ${JSON.stringify(out)}`;
          check(displayWidth(out) <= width, label('within the width'));
          check([...out].length > 1, label('non-empty: more than the ellipsis'));
          // A whole-token cut: the start is a whole-token prefix, the end (middle mode) a whole-token suffix.
          const [head = '', tail = ''] = out.split('…');
          check(isTokenPrefix(tokens, head), label('the head is a whole-token prefix'));
          check(keep === 'start' ? tail === '' : isTokenSuffix(tokens, tail), label('the tail'));
          const oracle = [...referenceEscapedFit(sample, width, keep)].length;
          check(
            [...out].length >= Math.floor(oracle / 3),
            () =>
              `${keep} @${width}: ${[...out].length} pieces, under a third of the oracle's ${oracle}`,
          );
        }
      none();
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// escapedFit: the cluster rule gives way to the width, and a lone mark never opens a tail
// Mutation: `startFit` returning `shorter.join('')` unconditionally (the cluster rule without the fit check: 22 sitting cases
// come out one cell WIDER than the width); the tail loop's guard `reversed.length > 0` back to `> 1` (a lone keycap mark opens
// the tail and composes with the ellipsis: `a…⃣`).
// ---------------------------------------------------------------------------------------------------------------------
describe('escapedFit gives the base back when the shorter cut would not fit (width is not monotone)', () => {
  // `1⃣` is two cells and `1⃣🏻` is one: a cut that drops a trailing base so as not to part it from its mark can be one cell
  // WIDER than the cut it was made from, so the rule only applies while the shorter cut and the ellipsis still fit.
  const KEYCAP = '1⃣';
  const MODIFIER = String.fromCodePoint(0x1f3fb);
  const sittingInput = (width: number, keycaps: number, marks: number): string =>
    'x'.repeat(width - 3 - 2 * keycaps) +
    KEYCAP.repeat(keycaps) +
    'a' +
    MARK.repeat(marks) +
    KEYCAP +
    MODIFIER +
    MARK +
    'TAIL';

  it('has the premise: a keycap is two cells, and the same keycap with a modifier is one', () => {
    expect(displayWidth(KEYCAP)).toBe(2);
    expect(displayWidth(KEYCAP + MODIFIER)).toBe(1);
    expect(displayWidth(MARK)).toBe(0);
  });

  it('keeps a start cut within the width, ending in an ellipsis, for the security sitting’s input at widths 8..120, 1..6 keycaps and every mark count around the cap', () => {
    const { check, none } = collect();
    let cases = 0;
    for (const width of [8, 13, 22, 40, 60, 77, 78, 120])
      for (let keycaps = 1; keycaps <= 6; keycaps++) {
        if (width - 3 - 2 * keycaps < 0) continue;
        // The modifier is the last piece under the cap of 3 × width pieces when the marks number about 2 × width; every count
        // from a little under that to a little past 3 × width is tried, so the cap falls on every piece of the tail in turn.
        for (let marks = 2 * width - 8; marks <= 3 * width + 8; marks++) {
          cases++;
          const out = escapedFit(sittingInput(width, keycaps, marks), width);
          check(
            displayWidth(out) <= width,
            () => `@${width} k=${keycaps} M=${marks}: ${displayWidth(out)} wide`,
          );
          check(out.endsWith('…'), () => `@${width} k=${keycaps} M=${marks}: no ellipsis`);
        }
      }
    none();
    expect(cases).toBeGreaterThan(1_500);
  });

  it('does the same in middle mode', () => {
    const { check, none } = collect();
    for (const width of [8, 13, 22, 40, 60, 77, 78, 120])
      for (let keycaps = 1; keycaps <= 6; keycaps += 5) {
        if (width - 3 - 2 * keycaps < 0) continue;
        for (let marks = 2 * width - 6; marks <= 3 * width + 8; marks++) {
          const out = escapedFit(sittingInput(width, keycaps, marks), width, 'middle');
          check(
            displayWidth(out) <= width,
            () => `@${width} k=${keycaps} M=${marks}: ${displayWidth(out)} wide`,
          );
        }
      }
    none();
  });
});

describe('escapedFit never opens a tail on a lone zero-width mark', () => {
  const KEYCAP_MARK = '⃣';
  const ZERO_WIDTH = (character: string): boolean => displayWidth(character) === 0;

  it.each([
    ['a, a tab and a keycap mark', `a\t${KEYCAP_MARK}`],
    ['a, `<` and a keycap mark', `a<${KEYCAP_MARK}`],
    ['a, a tab and an acute mark', `a\t${MARK}`],
    ['a, `<` and an acute mark', `a<${MARK}`],
  ] as const)(
    'cuts %s to `a…` or leaves it whole, never to a tail that opens on the mark, at 5..12 columns',
    (_name, text) => {
      const whole = escapedFit(text, 10_000);
      for (let width = 5; width <= 12; width++) {
        const out = escapedFit(text, width, 'middle');
        expect(displayWidth(out), `@${width}`).toBeLessThanOrEqual(width);
        if (displayWidth(whole) <= width) expect(out, `@${width}: it fits`).toBe(whole);
        else {
          // The tail piece before the mark (`<TAB>`, `<U+003C>`) cannot fit, so the mark has no base to compose with.
          expect(out, `@${width}`).toBe('a…');
          const [, tail = ''] = out.split('…');
          expect(ZERO_WIDTH([...tail][0] ?? 'a'), `@${width}: the tail opens on a mark`).toBe(
            false,
          );
        }
      }
    },
  );

  it('pins the exact cuts of the two review inputs: `a…` below the width that holds the whole', () => {
    expect(escapedFit(`a\t${KEYCAP_MARK}`, 5, 'middle')).toBe('a…');
    expect(escapedFit(`a<${KEYCAP_MARK}`, 8, 'middle')).toBe('a…');
    expect(escapedFit(`a\t${KEYCAP_MARK}`, 6, 'middle')).toBe(`a<TAB>${KEYCAP_MARK}`);
    expect(escapedFit(`a<${KEYCAP_MARK}`, 9, 'middle')).toBe(`a<U+003C>${KEYCAP_MARK}`);
  });

  describe('property: every string of up to four pieces over a small alphabet, at widths 1..8, in both modes', () => {
    // ASCII, a tab, `<`, a keycap mark, an acute mark, a wide CJK letter and a whole keycap (a digit and its mark).
    const alphabet = ['a', '\t', '<', KEYCAP_MARK, MARK, '日', '1⃣'];
    const levels: string[][] = [['']];
    for (let length = 1; length <= 4; length++)
      levels.push(
        (levels[length - 1] ?? []).flatMap((prefix) => alphabet.map((piece) => prefix + piece)),
      );
    const all = levels.flat().filter((text) => text.length > 0);

    it('has the premise: 2,800 strings, the alphabet to the fourth power and below', () => {
      expect(all).toHaveLength(7 + 49 + 343 + 2_401);
    });

    it.each([1, 2, 3, 4, 5, 6, 7, 8])(
      'within the width, one ellipsis when cut, a whole-token head and tail, a tail that opens on no mark, no stranded base when the shorter cut fits — width %i',
      (width) => {
        const { check, none } = collect();
        for (const text of all) {
          const full = escapedFit(text, 10_000);
          const tokens = escapeTokens(full);
          for (const keep of ['start', 'middle'] as const) {
            const out = escapedFit(text, width, keep);
            const label = (what: string) => () =>
              `${keep} @${width} ${JSON.stringify(text)} -> ${JSON.stringify(out)}: ${what}`;
            check(displayWidth(out) <= width, label(`${displayWidth(out)} wide`));
            if (!out.includes('…')) {
              check(out === full, label('uncut text is returned whole'));
              continue;
            }
            check(out.split('…').length === 2, label('exactly one ellipsis'));
            const [head = '', tail = ''] = out.split('…');
            check(isTokenPrefix(tokens, head), label('the head is a whole-token prefix'));
            check(isTokenSuffix(tokens, tail), label('the tail is a whole-token suffix'));
            if (keep === 'start') check(tail === '', label('a start cut has no tail'));
            check(
              tail === '' || !ZERO_WIDTH([...tail][0] ?? 'a'),
              label('the tail opens on a mark'),
            );
            // No cut ends on a base whose mark was left out, unless taking that base back would not fit.
            const headTokens = escapeTokens(head);
            const last = headTokens.at(-1);
            const next = tokens[headTokens.length];
            if (
              headTokens.length > 1 &&
              last !== undefined &&
              next !== undefined &&
              !ZERO_WIDTH(last) &&
              ZERO_WIDTH(next)
            )
              check(
                displayWidth(`${headTokens.slice(0, -1).join('')}…`) > width,
                label('the head ends on a base whose mark was cut, though the shorter cut fits'),
              );
          }
        }
        none();
      },
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// callListCapacity / callListView
// Mutation: `LIST_CHROME_ROWS` or `FULL_SPARE_ROWS` dropped (height / capacity); selection window `Math.floor(capacity / 2)`
// -> 0; `room >= TARGET_MIN` -> `room > 0`; `TOOL_COLUMN_MAX` -> 40; the `sanitizeUntrustedInline`/`escapedFit` calls bypassed.
// The target is cut with `keep: 'middle'`: `escapedFit(call.target, room, 'middle')` -> `escapedFit(call.target, room)` fails.
// ---------------------------------------------------------------------------------------------------------------------
const stats = (addedLines: number, removedLines: number): NonNullable<CallListEntry['stats']> => ({
  addedLines,
  removedLines,
  beforeBytes: 1,
  afterBytes: 1,
});
const call = (index: number, over: Partial<CallListEntry> = {}): CallListEntry => ({
  callId: `c${index}`,
  toolId: 'edit_file',
  outcome: 'success',
  target: `src/file${index}.ts`,
  ...over,
});
/** `left`, spaces, `right` flush to a row `width` wide. */
const flushed = (left: string, right: string, width: number): string =>
  `${left}${' '.repeat(width - displayWidth(left) - displayWidth(right))}${right}`;
const view = (
  calls: readonly CallListEntry[],
  selected = 0,
  over: { columns?: number; terminalRows?: number } = {},
) =>
  callListView({
    calls,
    selected,
    columns: over.columns ?? 80,
    terminalRows: over.terminalRows ?? 24,
  });

describe('callListCapacity — how many calls fit', () => {
  it('is the terminal’s rows minus the spare row minus the title, status and hint rows', () => {
    expect(callListCapacity(24)).toBe(20);
    expect(callListCapacity(40)).toBe(36);
    expect(callListCapacity(8)).toBe(4);
  });
  it('is never below one call, however short the terminal', () => {
    for (const rows of [4, 3, 1, 0, -3]) expect(callListCapacity(rows)).toBe(1);
    expect(callListCapacity(5)).toBe(1);
    expect(callListCapacity(6)).toBe(2);
  });
});

describe('callListView — the list of a conversation’s tool calls (ADR-0134 §6)', () => {
  describe('an empty list', () => {
    it('says why there is nothing, and that Esc closes it', () => {
      const empty = view([]);
      expect(empty.title).toBe('Tool calls');
      expect(empty.rows).toEqual([]);
      expect(empty.empty).toBe('No tool calls yet. Earlier sessions keep no previews.');
      expect(displayWidth(empty.empty ?? '')).toBeLessThanOrEqual(usable(FLOOR));
      expect(empty.status).toBe('');
      expect(empty.hint).toBe('Esc close');
      expect(empty.height).toBe(3);
    });
    it('has no `empty` text once there is a call', () => {
      expect(view([call(0)]).empty).toBeUndefined();
    });
  });

  describe('the rows', () => {
    it('lists the calls oldest first, so the newest is at the bottom', () => {
      const calls = [0, 1, 2, 3].map((index) => call(index, { toolId: `tool_${index}` }));
      const rows = view(calls, 3).rows;
      expect(rows).toHaveLength(4);
      expect(rows.map((row) => /tool_(\d)/u.exec(row.text)?.[1])).toEqual(['0', '1', '2', '3']);
    });

    it('marks the selected row with `›` and no other, and flags it in the row data', () => {
      const calls = [0, 1, 2].map((index) => call(index));
      for (const selected of [0, 1, 2]) {
        const rows = view(calls, selected).rows;
        expect(rows.map((row) => row.selected)).toEqual(
          [0, 1, 2].map((index) => index === selected),
        );
        expect(rows.map((row) => row.text.slice(0, 2))).toEqual(
          [0, 1, 2].map((index) => (index === selected ? '› ' : '  ')),
        );
      }
    });

    it('clamps a selection outside the list to the nearest call', () => {
      const calls = [0, 1, 2].map((index) => call(index));
      expect(view(calls, -5).rows.map((row) => row.selected)).toEqual([true, false, false]);
      expect(view(calls, 99).rows.map((row) => row.selected)).toEqual([false, false, true]);
      expect(view(calls, 99).status).toBe('call 3 of 3');
    });

    describe('a mark and, where the mark is not enough, a word, per outcome', () => {
      const cases = [
        ['success', '✓', '', 'ok'],
        ['failure', '✗', 'failed', 'bad'],
        ['denied', '⊘', 'denied', 'warn'],
        ['unknown', '?', 'outcome unknown', 'warn'],
        ['running', '…', 'running', 'dim'],
      ] as const;

      it.each(cases)('%s reads `%s %s` and is toned %s', (outcome, mark, word, tone) => {
        const [bare] = view([call(0, { outcome })]).rows;
        const left = `› ${mark} edit_file  src/file0.ts`;
        expect(bare?.text).toBe(word === '' ? left : flushed(left, word, usable(80)));
        expect(bare?.tone).toBe(tone);
        const [counted] = view([call(0, { outcome, stats: stats(3, 2) })]).rows;
        expect(counted?.text).toBe(
          flushed(left, word === '' ? '+3 -2' : `+3 -2 · ${word}`, usable(80)),
        );
      });
    });

    it('draws `+a -r` flush right for a call that changed a file, and nothing for one that did not', () => {
      const [changed, untouched] = view([call(0, { stats: stats(12, 0) }), call(1)], 0).rows;
      expect(changed?.text).toBe(flushed('› ✓ edit_file  src/file0.ts', '+12 -0', usable(80)));
      expect(displayWidth(changed?.text ?? '')).toBe(usable(80));
      expect(untouched?.text).toBe('  ✓ edit_file  src/file1.ts');
    });

    it('never says what a call returned: only its tool, its target, its change and its outcome', () => {
      // A real display carries its result summary; a result can hold a secret, and it is read in the details view, masked.
      const display = {
        ...call(0, { outcome: 'failure', stats: stats(1, 1) }),
        summary: 'RESULT-BODY-WITH-A-SECRET',
      };
      const [row] = view([display]).rows;
      expect(row?.text).toBe(flushed('› ✗ edit_file  src/file0.ts', '+1 -1 · failed', usable(80)));
      expect(row?.text).not.toContain('RESULT');
    });
  });

  describe('the tool column', () => {
    it('is as wide as the longest tool name in view, so the targets line up', () => {
      const rows = view([
        call(0, { toolId: 'edit_file', target: 'a.ts' }),
        call(1, { toolId: 'write_file', target: 'b.ts' }),
      ]).rows;
      expect(rows.map((row) => row.text)).toEqual(['› ✓ edit_file   a.ts', '  ✓ write_file  b.ts']);
      expect(rows[0]?.text.indexOf('a.ts')).toBe(rows[1]?.text.indexOf('b.ts'));
    });

    it('cuts a long tool name to 22 columns, ellipsis included, and keeps the column for every row', () => {
      const long = `mcp:${'x'.repeat(60)}`;
      const rows = view([
        call(0, { toolId: long, target: 'a.ts' }),
        call(1, { toolId: 'edit_file', target: 'b.ts' }),
      ]).rows;
      const cut = `${long.slice(0, 21)}…`;
      expect(displayWidth(cut)).toBe(22);
      expect(rows[0]?.text).toBe(`› ✓ ${cut}  a.ts`);
      expect(rows[1]?.text).toBe(`  ✓ edit_file${' '.repeat(22 - 'edit_file'.length)}  b.ts`);
      expect(rows[0]?.text.indexOf('a.ts')).toBe(rows[1]?.text.indexOf('b.ts'));
    });

    it('does not widen the column for a name of exactly 22 columns', () => {
      const exact = 'a'.repeat(22);
      expect(view([call(0, { toolId: exact, target: 't' })]).rows[0]?.text).toBe(`› ✓ ${exact}  t`);
    });
  });

  describe('the target gets what is left, and is left out when less than 8 columns remain', () => {
    const wide = 'src/very/long/target/path.ts';
    const lone = (columns: number) =>
      view([call(0, { target: wide })], 0, { columns }).rows[0]?.text;

    it('is left out at 7 columns of room and drawn, cut to its 8, at 8', () => {
      // `› ✓ edit_file` is 13 columns; the target needs a two-column gap and then its room.
      expect(lone(24)).toBe('› ✓ edit_file');
      expect(lone(25)).toBe('› ✓ edit_file  sr…th.ts');
      expect(displayWidth(lone(25) ?? '')).toBe(usable(25));
    });

    it('is shown whole when it fits the room exactly, and cut in the middle with one ellipsis when it is a column longer', () => {
      // 80 columns: width 78, head 13, `+3 -2` 5 plus its 2-column gap, 2-column gap before the target: room 56.
      const fits = 'a'.repeat(56);
      const [exact] = view([call(0, { target: fits, stats: stats(3, 2) })]).rows;
      expect(exact?.text).toBe(flushed(`› ✓ edit_file  ${fits}`, '+3 -2', usable(80)));
      const [over] = view([call(0, { target: `${fits}b`, stats: stats(3, 2) })]).rows;
      // A third of the 55 columns that are not the ellipsis for the start, the rest for the end.
      expect(over?.text).toBe(
        flushed(`› ✓ edit_file  ${'a'.repeat(18)}…${'a'.repeat(36)}b`, '+3 -2', usable(80)),
      );
      expect(displayWidth(over?.text ?? '')).toBe(usable(80));
    });

    describe('a long path is cut in the MIDDLE, so the file name stays', () => {
      const path = 'src/components/deeply/nested/folder/ReviewScreen.tsx';

      it('keeps its basename and its head, with one ellipsis between', () => {
        // 47 columns: width 45, head 13, no right text: room 30.
        const text = view([call(0, { target: path })], 0, { columns: 47 }).rows[0]?.text;
        expect(text).toBe('› ✓ edit_file  src/compo…der/ReviewScreen.tsx');
        expect(text?.endsWith('ReviewScreen.tsx')).toBe(true);
        expect(displayWidth(text ?? '')).toBe(usable(47));
      });

      it('shows the whole path when it fits', () => {
        expect(view([call(0, { target: path })]).rows[0]?.text).toBe(`› ✓ edit_file  ${path}`);
      });

      it('keeps the basename at every width that has room for it, beside the stats and the outcome word', () => {
        const { check, none } = collect();
        for (const columns of WIDTHS) {
          const [row] = view(
            [call(0, { target: path, outcome: 'failure', stats: stats(3, 2) })],
            0,
            { columns },
          ).rows;
          const text = row?.text ?? '';
          // `> ✗ edit_file` (13) + gap + target + gap + `+3 -2 · failed` (14) + gap: the target's room.
          const room = usable(columns) - 13 - 14 - 2 - 2;
          check(displayWidth(text) <= usable(columns), () => `@${columns}: too wide: ${text}`);
          check(text.endsWith('+3 -2 · failed'), () => `@${columns}: lost the outcome: ${text}`);
          if (room >= 24)
            check(text.includes('ReviewScreen.tsx'), () => `@${columns}: lost the name: ${text}`);
        }
        none();
      });
    });

    describe('a target of keycaps, flags or CJK never makes a row wider than the screen, and the outcome word survives', () => {
      const targets = [KEYCAPS(60), FLAGS.repeat(4), CJK, `src/${KEYCAPS(10)}/${FLAGS}/${CJK}.ts`];

      it.each(targets.map((target, index) => [index, target] as const))(
        'holds at 40..200 columns for a failed, a denied and a counted call — target %i',
        (_index, target) => {
          const { check, none } = collect();
          for (const columns of WIDTHS)
            for (const [outcome, word] of [
              ['failure', 'failed'],
              ['denied', 'denied'],
            ] as const)
              for (const withStats of [true, false]) {
                const [row] = view(
                  [
                    call(
                      0,
                      withStats ? { target, outcome, stats: stats(3, 2) } : { target, outcome },
                    ),
                  ],
                  0,
                  { columns },
                ).rows;
                const text = row?.text ?? '';
                check(
                  displayWidth(text) <= usable(columns),
                  () => `@${columns} ${outcome}: ${displayWidth(text)} wide: ${text}`,
                );
                check(text.endsWith(word), () => `@${columns} ${outcome}: lost "${word}": ${text}`);
              }
          none();
        },
      );

      it('draws a run of keycaps within the room it was given and keeps `failed` flush right', () => {
        for (const columns of [40, 80, 120, 200]) {
          const [row] = view([call(0, { target: KEYCAPS(60), outcome: 'failure' })], 0, {
            columns,
          }).rows;
          expect(displayWidth(row?.text ?? ''), `@${columns}`).toBeLessThanOrEqual(usable(columns));
          expect(row?.text.endsWith('failed'), `@${columns}`).toBe(true);
        }
      });
    });

    it('gives a call with no target no target column at all', () => {
      const [row] = view([{ callId: 'c0', toolId: 'edit_file', outcome: 'success' }]).rows;
      expect(row?.text).toBe('› ✓ edit_file');
    });

    it('keeps a call’s outcome word when there is no room left for a target', () => {
      // 28 columns: width 26, head 13, `failed` 6 plus its gap 2 and the target gap 2 leave 3: under the 8 a target needs.
      const [row] = view([call(0, { outcome: 'failure', target: wide })], 0, { columns: 28 }).rows;
      expect(row?.text).toBe(flushed('› ✗ edit_file', 'failed', usable(28)));
    });
  });

  describe('every model-named string is escaped before it is drawn', () => {
    const hostileTool = 'ev\x1b[31mil\x07\u202e<x>';
    const hostileTarget = 'a\x1b[2Jb\x07c\u202ed<e>';
    const hostile = [
      call(0, {
        toolId: hostileTool,
        target: hostileTarget,
        stats: stats(1, 1),
        outcome: 'denied',
      }),
    ];
    const rawHazard = /[\p{C}\u2028\u2029]|<(?!U\+[0-9A-F]{4,6}>|TAB>)/u;

    it('draws no control character, escape, bidi override or bare `<` from a tool id or a target', () => {
      const { check, none } = collect();
      for (const columns of WIDTHS) {
        const [row] = view(hostile, 0, { columns }).rows;
        check(
          row !== undefined && !rawHazard.test(row.text),
          () => `@${columns}: ${JSON.stringify(row?.text)}`,
        );
      }
      none();
    });

    it('shows a target’s hazards as visible tokens', () => {
      const [row] = view([call(0, { target: hostileTarget })]).rows;
      expect(row?.text).toContain('a<U+001B>[2Jb<U+0007>c<U+202E>d<U+003C>e>');
    });

    it('writes a tool id’s `<` as a token and never lets its hazards through', () => {
      const [row] = view([call(0, { toolId: hostileTool })]).rows;
      expect(row?.text).toContain('<U+003C>x>');
      expect(row?.text).not.toContain('\x1b');
      expect(row?.text).not.toContain('\x07');
      expect(row?.text).not.toContain('\u202e');
    });

    it('does not let a cut land inside a token', () => {
      const { check, none } = collect();
      for (const columns of WIDTHS) {
        const [row] = view(
          [call(0, { target: `${'\u202e'.repeat(12)}<<<<`, toolId: '<<<<<<<<' })],
          0,
          { columns },
        ).rows;
        check(row !== undefined && !rawHazard.test(row.text), () => `@${columns}: ${row?.text}`);
      }
      none();
    });
  });

  describe('the selection window and the status row', () => {
    const thirty = Array.from({ length: 30 }, (_, index) => call(index));
    const targets = (selected: number, over: { terminalRows?: number } = {}): readonly string[] =>
      view(thirty, selected, over).rows.map(
        (row) => /src\/file(\d+)\.ts/u.exec(row.text)?.[1] ?? '?',
      );
    const range = (from: number, to: number): readonly string[] =>
      Array.from({ length: to - from + 1 }, (_, index) => String(from + index));

    it('shows the first page when the first call is selected, and says how many are newer', () => {
      const list = view(thirty, 0);
      expect(targets(0)).toEqual(range(0, 19));
      expect(list.rows[0]?.selected).toBe(true);
      expect(list.status).toBe('call 1 of 30 · 10 newer below');
    });

    it('shows the last page when the last call is selected, and says how many are older', () => {
      const list = view(thirty, 29);
      expect(targets(29)).toEqual(range(10, 29));
      expect(list.rows.at(-1)?.selected).toBe(true);
      expect(list.status).toBe('call 30 of 30 · 10 older above');
    });

    it('keeps a call in the middle in the middle of the window, with both sides counted', () => {
      const list = view(thirty, 15);
      expect(targets(15)).toEqual(range(5, 24));
      expect(list.rows[10]?.selected).toBe(true);
      expect(list.status).toBe('call 16 of 30 · 5 older above · 5 newer below');
    });

    it('shows every call, and counts nothing above or below, when they all fit', () => {
      const five = thirty.slice(0, 5);
      const list = view(five, 2);
      expect(list.rows).toHaveLength(5);
      expect(list.status).toBe('call 3 of 5');
      const exact = thirty.slice(0, 20);
      expect(view(exact, 19).status).toBe('call 20 of 20');
      expect(view(exact, 0).status).toBe('call 1 of 20');
      expect(view([call(0)], 0).status).toBe('call 1 of 1');
    });

    it('follows the selection on a terminal that fits a single call', () => {
      const list = view(thirty.slice(0, 5), 2, { terminalRows: 5 });
      expect(list.rows).toHaveLength(1);
      expect(list.rows[0]?.text).toContain('src/file2.ts');
      expect(list.status).toBe('call 3 of 5 · 2 older above · 2 newer below');
    });

    it('property: for any selection the window holds the selected call, once, in order, and the counts add up', () => {
      for (const count of [1, 2, 19, 20, 21, 30, 64])
        for (const terminalRows of [8, 24, 40]) {
          const calls = Array.from({ length: count }, (_, index) => call(index));
          const capacity = callListCapacity(terminalRows);
          for (let selected = 0; selected < count; selected++) {
            const list = view(calls, selected, { terminalRows });
            const label = `${count} calls, ${terminalRows} rows, selected ${selected}`;
            const shown = list.rows.map((row) => Number(/src\/file(\d+)\.ts/u.exec(row.text)?.[1]));
            expect(shown.length, label).toBe(Math.min(count, capacity));
            expect(shown, `${label}: consecutive, oldest first`).toEqual(
              Array.from({ length: shown.length }, (_, index) => (shown[0] ?? 0) + index),
            );
            expect(
              list.rows.filter((row) => row.selected),
              label,
            ).toHaveLength(1);
            expect(shown[list.rows.findIndex((row) => row.selected)], label).toBe(selected);
            const older = shown[0] ?? 0;
            const newer = count - older - shown.length;
            expect(list.status, label).toBe(
              [
                `call ${selected + 1} of ${count}`,
                ...(older > 0 ? [`${older} older above`] : []),
                ...(newer > 0 ? [`${newer} newer below`] : []),
              ].join(' · '),
            );
            expect(list.height, `${label}: the whole list is the rows and three more`).toBe(
              list.rows.length + 3,
            );
          }
        }
    });
  });

  describe('the whole list', () => {
    it('is the rows plus the title, the status and the hint: height = rows + 3', () => {
      for (const count of [1, 2, 7, 25]) {
        const list = view(
          Array.from({ length: count }, (_, index) => call(index)),
          0,
        );
        expect(list.height).toBe(list.rows.length + 3);
      }
    });

    it('is never as tall as the terminal: one row stays spare', () => {
      for (const terminalRows of [5, 6, 10, 24, 40])
        for (const count of [1, 3, 30, 100]) {
          const list = view(
            Array.from({ length: count }, (_, index) => call(index)),
            0,
            { terminalRows },
          );
          expect(
            list.height + FULL_SPARE_ROWS,
            `${count} calls on ${terminalRows} rows`,
          ).toBeLessThanOrEqual(terminalRows);
        }
    });

    it('names its keys', () => {
      const list = view([call(0)]);
      expect(list.title).toBe('Tool calls');
      expect(list.hint).toBe(
        '↑/↓, PgUp/PgDn select · Enter open · Home/End oldest/newest · Esc close',
      );
    });

    it('names PgUp/PgDn, and is a single row that fits the 80-column floor', () => {
      const { hint } = view([call(0)]);
      expect(hint).toContain('PgUp/PgDn');
      expect(hint).not.toContain('\n');
      expect(displayWidth(hint)).toBeLessThanOrEqual(usable(FLOOR));
      expect(view([call(0)], 0, { columns: FLOOR }).hint).toBe(hint);
    });
  });

  describe('property: no row is wider than columns - 2', () => {
    const fixtures: readonly (readonly CallListEntry[])[] = [
      [
        call(0),
        call(1, { outcome: 'failure' }),
        call(2, { outcome: 'denied', stats: stats(3, 2) }),
      ],
      [
        call(0, {
          toolId: `mcp:${'x'.repeat(80)}`,
          target: 'src/'.concat('deep/'.repeat(40), 'file.ts'),
        }),
        call(1, { outcome: 'unknown', stats: stats(120, 3400) }),
        call(2, { outcome: 'running', target: '日本語のファイル名'.repeat(6) }),
        call(3, { toolId: '日本語', stats: stats(1, 1) }),
      ],
      [
        call(0, {
          toolId: '\u202e<<<<<<<<<<<<<<<<<<<<<<<<',
          target: '\x1b[31m'.repeat(20),
          outcome: 'failure',
        }),
      ],
      [
        call(0, { target: KEYCAPS(60), outcome: 'failure' }),
        call(1, { target: `${FLAGS}${FLAGS}`, outcome: 'denied', stats: stats(5, 5) }),
        call(2, { target: CJK, stats: stats(1, 1) }),
        call(3, { target: `src/${KEYCAPS(8)}/ReviewScreen.tsx`, outcome: 'unknown' }),
      ],
      Array.from({ length: 40 }, (_, index) =>
        call(index, index % 2 === 0 ? { stats: stats(index, 1) } : {}),
      ),
    ];

    it.each(fixtures.map((calls, index) => [index, calls] as const))(
      'holds at 40..200 columns for every outcome, every kind of name and every selection — fixture %i',
      (_index, calls) => {
        const { check, none } = collect();
        for (const columns of WIDTHS)
          for (const selected of calls.length > 10
            ? [20]
            : [0, Math.floor(calls.length / 2), calls.length - 1])
            for (const row of view(calls, selected, { columns }).rows)
              check(displayWidth(row.text) <= usable(columns), () => `@${columns}: ${row.text}`);
        none();
      },
    );

    it('holds for the empty sentence and its hint on the 80-column floor and above', () => {
      const { check, none } = collect();
      for (const columns of WIDTHS.filter((width) => width >= FLOOR)) {
        const empty = view([], 0, { columns });
        check(
          displayWidth(empty.empty ?? '') <= usable(columns),
          () => `@${columns}: ${empty.empty}`,
        );
        check(displayWidth(empty.hint) <= usable(columns), () => `@${columns}: ${empty.hint}`);
      }
      none();
    });

    it.each(fixtures.map((calls, index) => [index, calls] as const))(
      'holds for the status row and the hint on the 80-column floor and above — fixture %i',
      (_index, calls) => {
        const { check, none } = collect();
        for (const columns of WIDTHS.filter((width) => width >= FLOOR))
          for (const selected of [0, Math.floor(calls.length / 2), calls.length - 1]) {
            // A short terminal: the status and the hint do not depend on how many rows are drawn, only on the window.
            const list = view(calls, selected, { columns, terminalRows: 8 });
            check(
              displayWidth(list.status) <= usable(columns),
              () => `@${columns}: ${list.status}`,
            );
            check(displayWidth(list.hint) <= usable(columns), () => `@${columns}: ${list.hint}`);
          }
        none();
      },
    );
  });
});
