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
  reduceToolReviewKey,
  reviewInspected,
  toolReviewPage,
  toolReviewTarget,
} from './tool-review-model.js';
import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { transcriptDocument, wrapTranscript } from './chat-projection.js';

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
const page = (preview: ToolPreview, reveal = false) =>
  projectReviewPage(createReviewDocument(preview), REVIEW_START, 78, 20, reveal);

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
    expect(page(replacement('x \t\n', 'x·\n')).rows.join('\n')).toContain('x<SP><TAB><LF>');
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
    expect(reduceToolReviewKey(state, 'y', {}, true, card, true, 0).kind).toBe('none');
    const full = reduceToolReviewKey(state, 'v', {}, true, card, true, 0);
    if (full.kind !== 'state') throw new Error('expected full view');
    state = full.state;
    const reveal = reduceToolReviewKey(state, 'r', {}, true, page(document.preview), true, 0);
    if (reveal.kind !== 'state') throw new Error('expected reveal');
    state = reveal.state;
    expect(reviewInspected(state)).toBe(false);
    expect(reduceToolReviewKey(state, 'y', {}, false, undefined, true, 0).kind).toBe('none');
    state = acknowledgeToolReview(state, projectReviewPage(document, REVIEW_START, 78, 20, true));
    expect(reviewInspected(state)).toBe(true);
    expect(
      reduceToolReviewKey(state, 'y', {}, true, page(document.preview, true), true, 0),
    ).toEqual({ kind: 'approve', scope: 'once' });
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
    expect(reduceToolReviewKey(state, 'y', {}, false, undefined, true, 0).kind).toBe('none');
    expect(reduceToolReviewKey(state, 'a', { meta: true }, true, undefined, true, 0).kind).toBe(
      'none',
    );
    expect(reduceToolReviewKey(state, 'a', {}, true, undefined, false, 0).kind).toBe('none');
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

it('opens the retained summary after the actual aggregate preview budget evicts a document', () => {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const full = replacement('a'.repeat(8 * 1024 * 1024), 'b'.repeat(8 * 1024 * 1024));
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
  const opened = reduceToolReviewKey(state, 'c', {}, true, undefined, false, 0);
  if (opened.kind !== 'state') throw new Error('missing reason view');
  const typed = reduceToolReviewKey(opened.state, 'x', {}, true, undefined, false, 0);
  if (typed.kind !== 'state') throw new Error('missing reason text');
  expect(reduceToolReviewKey(typed.state, '', { return: true }, true, undefined, false, 0)).toEqual(
    { kind: 'deny', reason: 'x' },
  );
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
  expect(reduceToolReviewKey(state, 'y', {}, true, card, false, 0).kind).toBe('none');
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
    reduceToolReviewKey(state, 'y', {}, true, toolReviewPage(state, 80, 24), false, 0),
  ).toEqual({ kind: 'approve', scope: 'once' });
  expect(
    createReviewDocument({ kind: 'operation', target: 'x'.repeat(4097), fields: [] }).valid,
  ).toBe(false);
});

it('keeps a short fully visible target eligible for one-key approval on the acknowledged card', () => {
  const state = initialToolReview(
    'approval',
    'short',
    createReviewDocument({ kind: 'operation', target: 'safe.txt', fields: [] }),
  );
  const page = toolReviewPage(state, 80, 24);
  if (page === undefined) throw new Error('missing short card');
  const acknowledged = acknowledgeToolReview(state, page);
  expect(acknowledged.requiredTarget).toBeUndefined();
  expect(reduceToolReviewKey(acknowledged, 'y', {}, true, page, false, 0)).toEqual({
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
