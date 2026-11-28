import type { ToolPreview } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { formatToolCall } from './chat-projection.js';
import { withGlyphForm } from './glyphs.js';
import { cardStats } from './tool-review-card.js';
import { createReviewDocument } from './tool-review-projection.js';
import { callListView, fullCounts } from './tool-review-screen.js';

/**
 * One notation for a diff count, wherever a person reads one ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §8): `+3 -0`, in plain ASCII (the table must work without Unicode: a minus sign `−` and the `+3/-0 lines` of the tool row were two other
 * ways to say the same thing, side by side on one screen).
 */
const STATS = { addedLines: 3, removedLines: 0, beforeBytes: 0, afterBytes: 6 };

const preview: ToolPreview = {
  kind: 'operation',
  target: 'notes.md',
  fields: [],
  diff: {
    before: null,
    after: 'a\nb\nc\n',
    beforeEndings: 'empty',
    afterEndings: 'lf',
    stats: STATS,
    lines: [
      { kind: 'added', text: 'a', ending: 'lf', after: { line: 1, start: 0, end: 2 } },
      { kind: 'added', text: 'b', ending: 'lf', after: { line: 2, start: 2, end: 4 } },
      { kind: 'added', text: 'c', ending: 'lf', after: { line: 3, start: 4, end: 6 } },
    ],
  },
};

describe('a diff count reads `+3 -0` on every surface that shows one', () => {
  it('on the approval card’s summary row', () => {
    expect(cardStats(createReviewDocument(preview))).toMatch(/^\+3 -0 · \d+ bytes$/u);
  });

  it('on the full view’s counts', () => {
    expect(fullCounts(createReviewDocument(preview))).toMatch(
      /^\+3 -0 · \d+ bytes · 0 masked values$/u,
    );
  });

  it.each([true, false])('on a row of the tool-call list (plain forms %s)', (ascii) => {
    const row = withGlyphForm(ascii, () =>
      callListView({
        calls: [
          {
            callId: 'a',
            toolId: 'edit_file',
            outcome: 'success',
            target: 'notes.md',
            stats: STATS,
          },
        ],
        selected: 0,
        columns: 80,
        terminalRows: 24,
      }),
    ).rows[0]?.text;
    expect(row).toMatch(/\+3 -0$/u);
  });

  it('on the tool row of the transcript, where the count is not followed by a word that the other surfaces do not say', () => {
    const line = formatToolCall(
      { id: 'tc-1', toolId: 'edit_file', resolved: true, outcome: 'success' },
      { callId: 'tc-1', toolId: 'edit_file', outcome: 'success', target: 'notes.md', stats: STATS },
    );
    expect(line).toMatch(/→ notes\.md · \+3 -0$/u);
  });

  it('and never with the minus sign or the slash form', () => {
    const everything = [
      cardStats(createReviewDocument(preview)),
      fullCounts(createReviewDocument(preview)),
      formatToolCall(
        { id: 'tc-1', toolId: 'edit_file', resolved: true, outcome: 'success' },
        { callId: 'tc-1', toolId: 'edit_file', outcome: 'success', stats: STATS },
      ),
    ].join('\n');
    expect(everything).not.toContain('−');
    expect(everything).not.toMatch(/\+\d+\/-\d+/u);
    expect(everything).not.toMatch(/-\d+ lines/u);
  });
});
