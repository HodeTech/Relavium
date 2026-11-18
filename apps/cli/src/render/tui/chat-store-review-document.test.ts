/**
 * How often a review document is built for one tool preview. Building one scans both sides of a diff for
 * secrets and control characters — 260 ms per MiB — so a preview that reaches the store as an event, then as a
 * card, then as a details view must not pay that three times, and a call that no card will ever show (a refused
 * `plan` call) must not pay it at all. The builder is observed through its dominant step, the secret scan.
 */
import type { ToolPreview } from '@relavium/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createChatStore, type ChatStoreController } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { createReviewDocument } from './tool-review-projection.js';

/** Every text the secret scan was given, by length: one entry per scanned field per build. */
const scanned = vi.hoisted(() => ({ lengths: [] as number[] }));
vi.mock('@relavium/llm/scrub-secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@relavium/llm/scrub-secrets')>();
  return {
    ...actual,
    secretMaskRanges: (text: string) => {
      scanned.lengths.push(text.length);
      return actual.secretMaskRanges(text);
    },
  };
});

afterEach(() => {
  scanned.lengths.length = 0;
});

interface Span {
  line: number;
  start: number;
  end: number;
}
type Line = NonNullable<ToolPreview['diff']>['lines'][number];

/**
 * A one-line edit of a `bytes`-sized file, frozen the way the engine's registry delivers it: the preview, its
 * fields, the diff, its stats and every line with its spans.
 */
function frozenEdit(bytes: number, target = 'src/big.ts'): ToolPreview {
  const before: string[] = [];
  for (let size = 0, i = 0; size < bytes; i++) {
    const line = `const value_${i} = compute(${i}, "some typical source line text here");`;
    before.push(line);
    size += line.length + 1;
  }
  const middle = Math.floor(before.length / 2);
  const after = before.map((line, index) => (index === middle ? 'const changed = true;' : line));
  const lines: Line[] = [];
  let beforeAt = 0;
  let afterAt = 0;
  for (let index = 0; index < before.length; index++) {
    const b: Span = {
      line: index + 1,
      start: beforeAt,
      end: (beforeAt += (before[index]?.length ?? 0) + 1),
    };
    const a: Span = {
      line: index + 1,
      start: afterAt,
      end: (afterAt += (after[index]?.length ?? 0) + 1),
    };
    if (index === middle) {
      lines.push(
        Object.freeze({
          kind: 'removed' as const,
          text: before[index] ?? '',
          ending: 'lf' as const,
          before: Object.freeze(b),
        }),
        Object.freeze({
          kind: 'added' as const,
          text: after[index] ?? '',
          ending: 'lf' as const,
          after: Object.freeze(a),
        }),
      );
    } else {
      lines.push(
        Object.freeze({
          kind: 'context' as const,
          text: before[index] ?? '',
          ending: 'lf' as const,
          before: Object.freeze(b),
          after: Object.freeze(a),
        }),
      );
    }
  }
  const beforeText = `${before.join('\n')}\n`;
  const afterText = `${after.join('\n')}\n`;
  return Object.freeze({
    kind: 'operation' as const,
    target,
    fields: Object.freeze([]),
    diff: Object.freeze({
      before: beforeText,
      after: afterText,
      beforeEndings: 'lf' as const,
      afterEndings: 'lf' as const,
      stats: Object.freeze({
        addedLines: 1,
        removedLines: 1,
        beforeBytes: Buffer.byteLength(beforeText),
        afterBytes: Buffer.byteLength(afterText),
      }),
      lines: Object.freeze(lines),
    }),
  });
}

const request = {
  toolId: 'write_file',
  action: 'fs_write' as const,
  preview: { path: 'src/big.ts' },
  unredactedPreview: { path: 'src/big.ts' },
};
const newStore = (): ChatStoreController =>
  createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);

/** Scans of the two diff sides (everything but the short target), counted across every build so far. */
const sideScans = (): number => scanned.lengths.filter((length) => length > 1000).length;

describe('one review document per frozen preview', () => {
  it('builds the document once for the preview event and the approval card that follow it', () => {
    const preview = frozenEdit(64 * 1024);
    createReviewDocument(frozenEdit(64 * 1024, 'src/other.ts'));
    const oneBuild = scanned.lengths.length;
    expect(oneBuild, 'a build scans the target and both sides').toBe(3);
    scanned.lengths.length = 0;

    const store = newStore();
    store.applyToolLiveEvent({ phase: 'started', callId: 'c1', toolId: 'write_file' });
    store.applyToolLiveEvent({ phase: 'preview', callId: 'c1', toolId: 'write_file', preview });
    void store.requestApproval(request, true, undefined, { callId: 'c1', preview });

    expect(scanned.lengths, 'event + card is one build').toHaveLength(oneBuild);
    const snapshot = store.getSnapshot();
    expect(snapshot.review?.document, 'the card and the retained display share it').toBe(
      snapshot.toolDisplays.get('c1')?.document,
    );
  });

  it('builds a 4 MiB edit once, however many surfaces need it', () => {
    const preview = frozenEdit(4 * 1024 * 1024);
    const store = newStore();
    store.applyToolLiveEvent({ phase: 'started', callId: 'big', toolId: 'write_file' });
    store.applyToolLiveEvent({ phase: 'preview', callId: 'big', toolId: 'write_file', preview });
    void store.requestApproval(request, true, undefined, { callId: 'big', preview });
    expect(createReviewDocument(preview)).toBe(store.getSnapshot().review?.document);
    expect(sideScans(), 'before and after are each scanned exactly once').toBe(2);
  });

  it('shares the scans of the diff sides with the details view, which adds only its own fields', () => {
    const preview = frozenEdit(64 * 1024);
    const store = newStore();
    store.applyToolLiveEvent({ phase: 'started', callId: 'c2', toolId: 'write_file' });
    store.applyToolLiveEvent({ phase: 'preview', callId: 'c2', toolId: 'write_file', preview });
    store.applyToolLiveEvent({
      phase: 'completed',
      callId: 'c2',
      toolId: 'write_file',
      outcome: 'success',
      summary: 'Wrote src/big.ts',
    });
    expect(sideScans()).toBe(2);
    store.bindReviewVisibility(() => true);
    store.openDetails();
    store.handleReviewInput('', { return: true });
    const details = store.getSnapshot().review;
    expect(details?.kind).toBe('details');
    expect(details?.document?.preview.fields).toContainEqual({
      name: 'Result summary',
      value: 'Wrote src/big.ts',
    });
    expect(details?.document?.lines.some((line) => line.label.startsWith('+'))).toBe(true);
    expect(sideScans(), 'opening the details view did not scan the diff again').toBe(2);
  });

  it('shows a call that has no result yet through the document it already retained', () => {
    const preview = frozenEdit(64 * 1024);
    const store = newStore();
    store.applyToolLiveEvent({ phase: 'preview', callId: 'c3', toolId: 'write_file', preview });
    store.bindReviewVisibility(() => true);
    store.openDetails();
    store.handleReviewInput('', { return: true });
    const snapshot = store.getSnapshot();
    expect(snapshot.review?.document).toBe(snapshot.toolDisplays.get('c3')?.document);
    expect(sideScans()).toBe(2);
  });

  it('still opens details for a preview too large to review, from the empty one it retains', () => {
    const tooLong: ToolPreview = Object.freeze({
      kind: 'operation' as const,
      target: 'x'.repeat(5000),
      fields: Object.freeze([]),
    });
    const store = newStore();
    store.applyToolLiveEvent({
      phase: 'preview',
      callId: 'c4',
      toolId: 'write_file',
      preview: tooLong,
    });
    expect(store.getSnapshot().toolDisplays.get('c4')?.document?.valid).toBe(false);
    store.bindReviewVisibility(() => true);
    store.openDetails();
    store.handleReviewInput('', { return: true });
    expect(store.getSnapshot().review?.document?.valid).toBe(true);
  });

  it('never reuses a document for a preview that could still change', () => {
    const fields = [{ name: 'note', value: 'first' }];
    const preview: ToolPreview = { kind: 'operation', fields };
    const first = createReviewDocument(preview);
    fields[0] = { name: 'note', value: 'second' };
    const second = createReviewDocument(preview);
    expect(second).not.toBe(first);
    expect(second.fields.some((field) => field.text === 'second')).toBe(true);
  });
});

describe('a read-only plan turn builds nothing for a call it refuses', () => {
  it('keeps the target and stats of a previewed call but no review document, and says so in details', () => {
    const preview = frozenEdit(64 * 1024);
    const store = newStore();
    store.setMode('plan');
    store.applyToolLiveEvent({ phase: 'started', callId: 'p1', toolId: 'write_file' });
    store.applyToolLiveEvent({ phase: 'preview', callId: 'p1', toolId: 'write_file', preview });
    expect(scanned.lengths, 'no scan at all').toEqual([]);
    const display = store.getSnapshot().toolDisplays.get('p1');
    expect(display?.document).toBeUndefined();
    expect(display?.target).toBe('src/big.ts');
    expect(display?.stats?.addedLines).toBe(1);

    store.bindReviewVisibility(() => true);
    store.openDetails();
    store.handleReviewInput('', { return: true });
    const fields = store.getSnapshot().review?.document?.preview.fields ?? [];
    expect(fields).toContainEqual({
      name: 'Preview unavailable',
      value: 'Not retained for this call.',
    });
  });

  it('still builds the document for the same preview in every other mode', () => {
    const preview = frozenEdit(64 * 1024);
    for (const mode of ['ask', 'accept-edits', 'auto'] as const) {
      scanned.lengths.length = 0;
      const store = newStore();
      store.setMode(mode);
      store.applyToolLiveEvent({ phase: 'preview', callId: mode, toolId: 'write_file', preview });
      expect(store.getSnapshot().toolDisplays.get(mode)?.document, mode).toBeDefined();
    }
  });

  it('still builds the approval card if a plan-mode footer is stale and a card is requested', () => {
    const preview = frozenEdit(64 * 1024);
    const store = newStore();
    store.setMode('plan');
    store.applyToolLiveEvent({ phase: 'preview', callId: 'p2', toolId: 'write_file', preview });
    void store.requestApproval(request, true, undefined, { callId: 'p2', preview });
    expect(store.getSnapshot().review?.document?.valid).toBe(true);
    expect(store.getSnapshot().review?.document?.lines.length).toBeGreaterThan(0);
  });
});

/** A call that has started and delivered its preview: the details list has a target to say about it. */
function previewedCall(store: ChatStoreController, callId: string, target: string): void {
  store.applyToolLiveEvent({ phase: 'started', callId, toolId: 'write_file' });
  store.applyToolLiveEvent({
    phase: 'preview',
    callId,
    toolId: 'write_file',
    preview: Object.freeze({
      kind: 'operation' as const,
      target,
      fields: Object.freeze([]),
    }),
  });
}

/** The three calls of a conversation, oldest first, each with a target of its own so a test can tell them apart. */
function threeCalls(): ChatStoreController {
  const store = newStore();
  previewedCall(store, 'oldest', 'src/oldest.ts');
  previewedCall(store, 'middle', 'src/middle.ts');
  previewedCall(store, 'newest', 'src/newest.ts');
  store.bindReviewVisibility(() => true);
  return store;
}

// ADR-0134 §6: the list opened on the OLDEST call, so a person who had just watched a tool run had to press End to ask about it.
describe('openDetails opens the tool-call list on the newest call (ADR-0134 §6)', () => {
  it('selects the last of several calls: selected = count − 1 and the call id of the newest', () => {
    const store = threeCalls();
    store.openDetails();
    const review = store.getSnapshot().review;
    expect(review?.kind).toBe('details');
    expect(review?.screen).toBe('list');
    expect(review?.selected).toBe(2);
    expect(review?.callId).toBe('newest');

    const many = newStore();
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) previewedCall(many, id, `src/${id}.ts`);
    many.openDetails();
    expect(many.getSnapshot().review?.selected).toBe(6);
    expect(many.getSnapshot().review?.callId).toBe('g');
  });

  it('selects the only call when there is one: index 0, and its id', () => {
    const store = newStore();
    previewedCall(store, 'only', 'src/only.ts');
    store.openDetails();
    const review = store.getSnapshot().review;
    expect(review?.screen).toBe('list');
    expect(review?.selected).toBe(0);
    expect(review?.callId).toBe('only');
  });

  it('opens an empty list on no call at all: index 0, no call id, and Enter opens nothing', () => {
    const store = newStore();
    store.bindReviewVisibility(() => true);
    store.openDetails();
    const review = store.getSnapshot().review;
    expect(review?.kind).toBe('details');
    expect(review?.screen).toBe('list');
    expect(review?.selected).toBe(0);
    expect(review?.callId).toBeUndefined();
    store.handleReviewInput('', { return: true });
    expect(store.getSnapshot().review?.screen, 'there is nothing to open').toBe('list');
    expect(store.getSnapshot().review?.document).toBeUndefined();
  });

  it('means the call that STARTED last, not the one that was updated last', () => {
    const store = newStore();
    previewedCall(store, 'first', 'src/first.ts');
    previewedCall(store, 'second', 'src/second.ts');
    // The first call finishes after the second began: its row is updated, but it does not move to the bottom.
    store.applyToolLiveEvent({
      phase: 'completed',
      callId: 'first',
      toolId: 'write_file',
      outcome: 'success',
      summary: 'Wrote src/first.ts',
    });
    store.openDetails();
    expect(store.getSnapshot().review?.callId).toBe('second');
    expect(store.getSnapshot().review?.selected).toBe(1);
  });

  it('opens the details of that newest call on Enter', () => {
    const store = threeCalls();
    store.openDetails();
    store.handleReviewInput('', { return: true });
    const review = store.getSnapshot().review;
    expect(review?.kind).toBe('details');
    expect(review?.screen).toBe('full');
    expect(review?.callId).toBe('newest');
    expect(review?.document?.preview.target).toBe('src/newest.ts');
  });

  it('opens the OLDEST call when Home is pressed first, and the newest again after End', () => {
    const store = threeCalls();
    store.openDetails();

    store.handleReviewInput('', { home: true });
    expect(store.getSnapshot().review?.screen).toBe('list');
    expect(store.getSnapshot().review?.selected).toBe(0);
    expect(store.getSnapshot().review?.callId).toBe('oldest');
    store.handleReviewInput('', { return: true });
    const oldest = store.getSnapshot().review;
    expect(oldest?.screen).toBe('full');
    expect(oldest?.callId).toBe('oldest');
    expect(oldest?.document?.preview.target).toBe('src/oldest.ts');

    store.handleReviewInput('b', {});
    expect(store.getSnapshot().review?.screen, 'b goes back to the list').toBe('list');
    store.handleReviewInput('', { end: true });
    expect(store.getSnapshot().review?.selected).toBe(2);
    expect(store.getSnapshot().review?.callId).toBe('newest');
    store.handleReviewInput('', { return: true });
    expect(store.getSnapshot().review?.document?.preview.target).toBe('src/newest.ts');
  });

  it('moves one call at a time from the newest: Up selects the middle call, and Enter opens it', () => {
    const store = threeCalls();
    store.openDetails();
    store.handleReviewInput('', { upArrow: true });
    expect(store.getSnapshot().review?.selected).toBe(1);
    expect(store.getSnapshot().review?.callId).toBe('middle');
    store.handleReviewInput('', { return: true });
    expect(store.getSnapshot().review?.document?.preview.target).toBe('src/middle.ts');
  });
});
