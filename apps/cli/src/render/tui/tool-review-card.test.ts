import type { ToolPreview } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import {
  CARD_KEY_ROWS,
  CARD_MIN_TRANSCRIPT_ROWS,
  cardKeyRows,
  cardRowBudget,
  cardScopePhrase,
  cardStats,
  cardVerb,
  cardWarnings,
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

  it('warns about a shortened target with its exact omitted bytes', () => {
    const rows = warn(createReviewDocument(preview({})), {
      shortenedTarget: true,
      targetHiddenBytes: 1234,
    });
    const text = rows.join(' ').replace(/\s+/gu, ' ');
    expect(text).toContain('Target shortened');
    expect(text).toContain('1234 bytes omitted');
    expect(text).toContain('Allow stays locked');
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

  it('explains a lock even when no specific cause is named', () => {
    const rows = warn(createReviewDocument(preview({})), { inspected: false });
    expect(rows.join(' ')).toContain('Allow is locked');
  });

  it('wraps every warning to the width it is given, so the row budget is exact', () => {
    const rows = warn(createReviewDocument(preview({})), {
      shortenedTarget: true,
      targetHiddenBytes: 99,
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
    expect(rows[0]).toBe('[y] Allow   [a] Allow all file writes this session   [n] Deny');
    expect(rows[1]).toBe('[c] Deny + reason   [v] Full diff   Esc stops the turn');
  });
  it('omits "always" when the answer would not be remembered', () => {
    expect(cardKeyRows({ inspected: true, cacheable: false, scope: 'x' })[0]).toBe(
      '[y] Allow   [n] Deny',
    );
  });
  it('does not offer Allow while it is locked, and says why', () => {
    const [answers] = cardKeyRows({ inspected: false, cacheable: true, scope: 'file edits' });
    expect(answers).not.toContain('[y]');
    expect(answers).not.toContain('[a]');
    expect(answers).toContain('[n] Deny');
    expect(answers).toContain('locked');
  });
  it('keeps every row inside 80 columns even for the longest scope phrase', () => {
    const scope = cardScopePhrase('mcp:a-very-long-server:and-a-very-long-tool-name');
    for (const row of cardKeyRows({ inspected: true, cacheable: true, scope })) {
      expect(displayWidth(row)).toBeLessThanOrEqual(78);
    }
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
