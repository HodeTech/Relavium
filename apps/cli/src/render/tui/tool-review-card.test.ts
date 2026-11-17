import type { ToolPreview } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import {
  CARD_KEY_ROWS,
  CARD_LOCKOUT_NOTE,
  CARD_MIN_TRANSCRIPT_ROWS,
  CARD_TYPEAHEAD_NOTE,
  cardKeyRows,
  cardRowBudget,
  cardScopePhrase,
  cardStats,
  cardVerb,
  cardWarnings,
  fullViewConfirmLegend,
  wrapWords,
} from './tool-review-card.js';
import { createReviewDocument } from './tool-review-projection.js';
import { displayWidth } from './viewport.js';

type Endings = NonNullable<ToolPreview['diff']>['beforeEndings'];

function preview(over: {
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

const warn = (document: ReturnType<typeof createReviewDocument>, over = {}) =>
  cardWarnings({
    document,
    shortenedTarget: false,
    targetHiddenBytes: 0,
    inspected: true,
    changesNotShown: 0,
    columns: 78,
    ...over,
  });

describe('cardRowBudget (ADR-0129 §2)', () => {
  it('is twelve rows at the 80×24 floor and leaves the transcript its minimum', () => {
    expect(cardRowBudget(24)).toBe(12);
    for (const rows of [24, 30, 40, 60, 100]) {
      expect(cardRowBudget(rows)).toBeLessThanOrEqual(rows - CARD_MIN_TRANSCRIPT_ROWS - 4);
    }
  });
  it('grows with the terminal but never past three fifths of it', () => {
    expect(cardRowBudget(40)).toBe(24);
    expect(cardRowBudget(60)).toBe(36);
    expect(cardRowBudget(24)).toBeLessThanOrEqual(Math.floor((24 * 3) / 5));
  });
});

describe('cardVerb', () => {
  it('says what the call does in one word', () => {
    expect(cardVerb('write_file', 'fs_write', preview({ before: null }))).toBe('Create');
    expect(cardVerb('write_file', 'fs_write', preview({ before: 'old\n' }))).toBe('Overwrite');
    expect(cardVerb('edit_file', 'fs_write', preview({ before: 'old\n' }))).toBe('Edit');
    expect(cardVerb('run_command', 'process', undefined)).toBe('Run');
    expect(cardVerb('http_request', 'egress', undefined)).toBe('Request');
    expect(cardVerb('read_clipboard', 'os', undefined)).toBe('Use');
  });
});

describe('cardStats', () => {
  it('gives the added/removed lines and changed bytes, or nothing without a diff', () => {
    const document = createReviewDocument(preview({ after: 'hello\n' }));
    expect(cardStats(document)).toBe('+1 −0 · 6 bytes');
    expect(cardStats(createReviewDocument({ kind: 'operation', fields: [] }))).toBe('');
    expect(cardStats(undefined)).toBe('');
  });
});

describe('cardWarnings — only what applies (ADR-0129 §3)', () => {
  it('is empty for a clean change: a zero is not displayed as a fact', () => {
    expect(warn(createReviewDocument(preview({})))).toEqual([]);
    expect(warn(createReviewDocument(preview({ before: 'a\n', beforeEndings: 'lf' })))).toEqual([]);
  });

  // PR #99 security sitting E2: a clipped argument vector has no changed lines to count, yet its hidden tail is what runs.
  it('names the lines of a call without a diff that the card cannot show, and how to read them', () => {
    const document = createReviewDocument({
      kind: 'operation',
      target: 'git',
      fields: [{ name: 'args', value: '["status"]' }],
    });
    expect(warn(document, { linesNotShown: 3 })).toEqual([
      '\u26a0 3 lines of this call are not shown \u2014 press [v] for the full view.',
    ]);
    expect(warn(document, { linesNotShown: 1 }), 'singular for one').toEqual([
      '\u26a0 1 line of this call is not shown \u2014 press [v] for the full view.',
    ]);
    expect(warn(document, { linesNotShown: 0 }), 'a zero is not displayed as a fact').toEqual([]);
    expect(warn(document), 'the count is optional').toEqual([]);
  });

  it('leaves a diff to its changed-line warning: the line count is not a second warning for it', () => {
    const document = createReviewDocument(preview({}));
    expect(warn(document, { linesNotShown: 5 })).toEqual([]);
    expect(warn(document, { linesNotShown: 5, changesNotShown: 2 })).toEqual([
      '\u26a0 2 changed lines not shown \u2014 press [v] for the full diff.',
    ]);
  });

  it('wraps the line warning to the card width like every other warning', () => {
    const document = createReviewDocument({ kind: 'operation', target: 'git', fields: [] });
    const rows = warn(document, { linesNotShown: 12, columns: 40 });
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(40);
    expect(rows.join(' ').replace(/\s+/gu, ' ')).toContain(
      '12 lines of this call are not shown \u2014 press [v] for the full view.',
    );
  });

  it('warns about a shortened target with its exact omitted bytes, and says Allow stays locked until it is read', () => {
    const rows = warn(createReviewDocument(preview({})), {
      shortenedTarget: true,
      targetHiddenBytes: 1234,
      inspected: false,
    });
    const text = rows.join(' ').replace(/\s+/gu, ' ');
    expect(text).toContain('Target shortened');
    expect(text).toContain('1234 bytes omitted');
    expect(text).toContain('Allow stays locked');
  });

  // the lock sentence is an instruction to unlock; once the person has inspected, it contradicts the
  // key row that now offers Allow.
  it('keeps the fact of a shortened target after inspection but no longer says Allow is locked', () => {
    const rows = warn(createReviewDocument(preview({})), {
      shortenedTarget: true,
      targetHiddenBytes: 1234,
      inspected: true,
    });
    const text = rows.join(' ').replace(/\s+/gu, ' ');
    expect(text).toContain('Target shortened');
    expect(text).toContain('1234 bytes omitted');
    expect(text).not.toMatch(/lock/iu);
  });

  it('keeps the fact of a masked value after inspection but no longer says Allow is locked', () => {
    const document = createReviewDocument(
      preview({ after: 'token = Bearer sk-proj-abcdefghijklmnopqrstuvw\n' }),
    );
    expect(document.required.length).toBeGreaterThan(0);
    const text = warn(document, { inspected: true }).join(' ').replace(/\s+/gu, ' ');
    expect(text).toMatch(/1 masked value in this change/u);
    expect(text).not.toMatch(/lock/iu);
    const locked = warn(document, { inspected: false }).join(' ').replace(/\s+/gu, ' ');
    expect(locked).toContain('Allow stays locked');
  });

  it('warns about masked values that must be inspected, with their count', () => {
    const document = createReviewDocument(
      preview({ after: 'token = Bearer sk-proj-abcdefghijklmnopqrstuvw\n' }),
    );
    const text = warn(document, { inspected: false }).join(' ').replace(/\s+/gu, ' ');
    expect(document.required.length).toBeGreaterThan(0);
    expect(text).toMatch(/1 masked value in this change/u);
    expect(text).toContain('[v]');
    expect(text).toContain('[r]');
  });

  it('states a non-LF line-ending convention, and a conversion between two conventions', () => {
    expect(
      warn(createReviewDocument(preview({ after: 'a\r\n', afterEndings: 'crlf' }))).join(' '),
    ).toContain('Line endings: CRLF.');
    const converted = warn(
      createReviewDocument(
        preview({ before: 'a\n', beforeEndings: 'lf', after: 'a\r\n', afterEndings: 'crlf' }),
      ),
    ).join(' ');
    expect(converted).toContain('Line endings: LF → CRLF.');
    expect(
      warn(createReviewDocument(preview({ after: 'a', afterEndings: 'none' }))).join(' '),
    ).toContain('no final newline');
  });

  // the core diff now classifies `a\nb` (an LF file whose last line has no newline) as lf, not mixed, so
  // an ordinary one-line edit of such a file carries no line-endings warning; a real mixture still does.
  it('does not warn about line endings for an all-LF file whose last line has no newline', () => {
    const lf = preview({ before: 'a\nb', after: 'a\nc', beforeEndings: 'lf', afterEndings: 'lf' });
    expect(warn(createReviewDocument(lf))).toEqual([]);
    const mixed = preview({
      before: 'a\nb\r\nc',
      after: 'a\nb\r\nd',
      beforeEndings: 'mixed',
      afterEndings: 'mixed',
    });
    expect(warn(createReviewDocument(mixed)).join(' ')).toContain('Line endings: mixed → mixed.');
  });

  // D64 round 2, D5: the warning used to fire on any non-LF side (a CRLF file edited as CRLF, `a\rb\rc` left alone) and
  // stayed silent when only the final newline was added or dropped in an LF file, where both sides read `lf`.
  describe('line-endings warning says only what changed (D5)', () => {
    const endingsRows = (over: Parameters<typeof preview>[0]): string[] => {
      const document = createReviewDocument(preview(over));
      expect(document.valid, 'a hollow fixture would prove nothing').toBe(true);
      return warn(document).filter((row) => row.includes('Line endings'));
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
    ] as const)('stays silent for %s', (_name, text, beforeEndings, afterEndings) => {
      expect(endingsRows({ ...text, beforeEndings, afterEndings })).toEqual([]);
    });

    it.each([
      [
        'CRLF to LF',
        { before: 'a\r\n', after: 'a\n' },
        'crlf',
        'lf',
        '\u26a0 Line endings: CRLF \u2192 LF.',
      ],
      [
        'LF to mixed',
        { before: 'a\n', after: 'a\nb\r\n' },
        'lf',
        'mixed',
        '\u26a0 Line endings: LF \u2192 mixed.',
      ],
      [
        'mixed to CRLF',
        { before: 'a\nb\r\n', after: 'a\r\n' },
        'mixed',
        'crlf',
        '\u26a0 Line endings: mixed \u2192 CRLF.',
      ],
      [
        'mixed to mixed',
        { before: 'a\nb\r\nc', after: 'a\nb\r\nd' },
        'mixed',
        'mixed',
        '\u26a0 Line endings: mixed \u2192 mixed.',
      ],
      [
        'a final newline added to a multi-line LF file',
        { before: 'a\nb', after: 'a\nb\n' },
        'lf',
        'lf',
        '\u26a0 Line endings: final newline added.',
      ],
      [
        'a final newline dropped from a multi-line LF file',
        { before: 'a\nb\n', after: 'a\nb' },
        'lf',
        'lf',
        '\u26a0 Line endings: final newline removed.',
      ],
      [
        'a final newline added to a CRLF file',
        { before: 'a\r\nb', after: 'a\r\nb\r\n' },
        'crlf',
        'crlf',
        '\u26a0 Line endings: final newline added.',
      ],
    ] as const)('warns for %s', (_name, text, beforeEndings, afterEndings, expected) => {
      expect(endingsRows({ ...text, beforeEndings, afterEndings })).toEqual([expected]);
    });
  });

  it('names the changed lines the card cannot show, with the way to read them', () => {
    const document = createReviewDocument(preview({}));
    expect(warn(document, { changesNotShown: 0 })).toEqual([]);
    expect(warn(document, { changesNotShown: 1 })).toEqual([
      '\u26a0 1 changed line not shown \u2014 press [v] for the full diff.',
    ]);
    expect(warn(document, { changesNotShown: 193 })).toEqual([
      '\u26a0 193 changed lines not shown \u2014 press [v] for the full diff.',
    ]);
  });

  it('explains a lock even when no specific cause is named', () => {
    const rows = warn(createReviewDocument(preview({})), { inspected: false });
    expect(rows.join(' ')).toContain('Allow is locked');
  });

  it('wraps every warning to the width it is given, so the row budget is exact', () => {
    const rows = warn(createReviewDocument(preview({})), {
      shortenedTarget: true,
      targetHiddenBytes: 99,
      inspected: false,
      columns: 40,
    });
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(40);
  });
});

describe('wrapWords', () => {
  it('never splits a word and indents a continuation row', () => {
    const rows = wrapWords('alpha beta gamma delta', 11);
    expect(rows).toEqual(['alpha beta', '  gamma', '  delta']);
  });
  it('keeps a word wider than the width on its own row rather than dropping it', () => {
    expect(wrapWords('abcdefghijklmnop', 8)).toEqual(['abcdefghijklmnop']);
  });
});

describe('cardKeyRows (ADR-0129 §5)', () => {
  it('names the scope of "always" and what Esc does, in exactly two rows', () => {
    const rows = cardKeyRows({ inspected: true, cacheable: true, scope: 'file writes' });
    expect(rows).toHaveLength(CARD_KEY_ROWS);
    expect(rows[0]).toBe('[Ctrl+Y] Allow   [Ctrl+G] Allow all file writes this session');
    expect(rows[1]).toBe(
      '[Ctrl+N] Deny   [Ctrl+R] Deny + reason   [v] Full diff   Esc stops the turn',
    );
  });
  it('omits "always" when the answer would not be remembered', () => {
    const rows = cardKeyRows({ inspected: true, cacheable: false, scope: 'x' });
    expect(rows[0]).toBe('[Ctrl+Y] Allow');
    expect(rows[0]).not.toContain('Ctrl+G');
    // Deny stays on the second row: the refusals do not depend on what would be remembered.
    expect(rows[1]).toBe(
      '[Ctrl+N] Deny   [Ctrl+R] Deny + reason   [v] Full diff   Esc stops the turn',
    );
  });
  it('does not offer Allow while it is locked, and says why', () => {
    const [answers, refusals] = cardKeyRows({
      inspected: false,
      cacheable: true,
      scope: 'file edits',
    });
    expect(answers).toBe('(Allow is locked until you inspect the change)');
    expect(answers).not.toContain('Ctrl+Y');
    expect(answers).not.toContain('Ctrl+G');
    expect(answers).toContain('locked');
    // Deny is never locked: it is on the second row, whole.
    expect(refusals).toContain('[Ctrl+N] Deny');
    expect(refusals).toContain('[Ctrl+R] Deny + reason');
  });
  it('names no bare letter as an answer in any state: the answers are chords, and a bare letter answers nothing', () => {
    const states = [
      { inspected: true, cacheable: true },
      { inspected: true, cacheable: false },
      { inspected: false, cacheable: true },
      { inspected: true, cacheable: true, confirmAlways: true },
    ];
    for (const state of states)
      for (const row of cardKeyRows({ ...state, scope: 'file writes' }))
        expect(row, JSON.stringify(state)).not.toMatch(/\[[yanc]\]/u);
  });
  it('keeps every row inside 80 columns even for the longest scope phrase', () => {
    const scope = cardScopePhrase('mcp:a-very-long-server:and-a-very-long-tool-name');
    for (const row of cardKeyRows({ inspected: true, cacheable: true, scope })) {
      expect(displayWidth(row)).toBeLessThanOrEqual(78);
    }
  });
});

// PR #99 corrective sitting G1 and security sitting H1: the session-wide grant asks twice and is confirmed by ENTER (a second
// `Ctrl+G` is a held key); while it waits the card says what the next key does, in the same two rows, with the same
// scope phrase the one-step legend uses.
describe('cardKeyRows while the session-wide grant waits for its confirmation (G1, H1)', () => {
  it('asks for Enter, names what it grants and what cancels it, in exactly two rows', () => {
    const rows = cardKeyRows({
      inspected: true,
      cacheable: true,
      scope: 'file writes',
      confirmAlways: true,
    });
    expect(rows).toHaveLength(CARD_KEY_ROWS);
    expect(rows[0]).toBe('Press Enter to allow all file writes this session');
    expect(rows[1]).toBe('Any other key cancels \u00b7 Esc stops the turn');
    expect(rows.join('\n'), 'a second Ctrl+G is no longer the confirmation').not.toContain(
      'Ctrl+G',
    );
  });
  it('offers no Ctrl+Y / Ctrl+N / Ctrl+R / [v] while it waits: every other key cancels the question', () => {
    const rows = cardKeyRows({
      inspected: true,
      cacheable: true,
      scope: 'file edits',
      confirmAlways: true,
    });
    expect(rows.join('\n')).not.toMatch(/\[(?:Ctrl\+[YGNR]|[ynvc])\]/u);
  });
  it('keeps both rows inside 78 columns for the longest scope phrase, so "any other key cancels" is never cut off', () => {
    const scope = cardScopePhrase('mcp:a-very-long-server:and-a-very-long-tool-name');
    for (const row of cardKeyRows({ inspected: true, cacheable: true, scope, confirmAlways: true }))
      expect(displayWidth(row)).toBeLessThanOrEqual(78);
  });
  it('is the one-step legend when no question is pending (the default)', () => {
    expect(
      cardKeyRows({ inspected: true, cacheable: true, scope: 'x', confirmAlways: false }),
    ).toEqual(cardKeyRows({ inspected: true, cacheable: true, scope: 'x' }));
  });
  it('says the same in the full view, in one row that fits 80 columns for the common scopes', () => {
    expect(fullViewConfirmLegend('file writes')).toBe(
      'Press Enter to allow all file writes this session \u00b7 any other key cancels',
    );
    for (const scope of ['file writes', 'file edits'])
      expect(displayWidth(fullViewConfirmLegend(scope))).toBeLessThanOrEqual(80);
  });
  it('has two refusal notes that each fit one row of the card and say what to do', () => {
    for (const note of [CARD_TYPEAHEAD_NOTE, CARD_LOCKOUT_NOTE]) {
      expect(displayWidth(note), note).toBeLessThanOrEqual(78);
      expect(note).toContain('press again');
    }
  });
  it('words the typing note for keys typed BEFORE the answer, not only while the card was open (H1)', () => {
    expect(CARD_TYPEAHEAD_NOTE).toBe(
      'Keys were typed just before this answer \u2014 wait a moment, then press again.',
    );
    expect(CARD_TYPEAHEAD_NOTE).not.toContain('while this card was open');
    expect(CARD_LOCKOUT_NOTE).toBe(
      'This card opened right after your last answer \u2014 wait, then press again.',
    );
  });
});

describe('cardScopePhrase', () => {
  it('uses plain words for the built-in file tools and truncates a long id', () => {
    expect(cardScopePhrase('write_file')).toBe('file writes');
    expect(cardScopePhrase('edit_file')).toBe('file edits');
    expect(cardScopePhrase('http_request')).toBe('http_request calls');
    expect([...cardScopePhrase('x'.repeat(40))].length).toBeLessThanOrEqual(22);
  });
});
