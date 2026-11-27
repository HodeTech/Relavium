import { describe, expect, it } from 'vitest';

import { chatGrid } from './chat-grid.js';
import { transcriptRows } from './chat-projection.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, type TranscriptEntry } from './session-view-model.js';
import { createTranscriptAcknowledgement } from './transcript-acknowledgement.js';

/**
 * The measured-frame acknowledgement on the grid (MVP-11 unit 9, plan §4 invariant 7; a fail-closed, consent-adjacent path: a disclosure counts as
 * seen only when every row of it is in the committed viewport window). On the grid the transcript has separator rows between turns and is laid out
 * at the content column, not the terminal's width: `visible()` must count both exactly as the viewport draws them, in one walk over the prefix that
 * includes the notice, or it clears a notice whose last row is clipped.
 */

const CONVERSATION: readonly TranscriptEntry[] = [
  { role: 'user', text: 'first question' },
  { role: 'assistant', text: 'first answer' },
  { role: 'user', text: 'second question' },
  { role: 'assistant', text: 'second answer\nover two lines' },
];

/** A store seeded with a conversation (separator rows between its turns), and a publication of `notice` after it. */
function published(notice: string): {
  readonly store: ChatStoreController;
  readonly proof: ReturnType<typeof createTranscriptAcknowledgement>;
  readonly visible: () => boolean;
} {
  const store = createChatStore(false, { transcript: CONVERSATION }, FULLSCREEN_TRANSCRIPT_BOUND);
  const proof = createTranscriptAcknowledgement(() => store);
  const publication = proof.capture();
  store.notice(notice);
  publication.published();
  return { store, proof, visible: () => publication.visible() };
}

describe('the acknowledgement counts the rows the grid draws', () => {
  it('a notice at the end of a transcript with separator rows: visible in a window that holds all its rows, not one row less', () => {
    const { store, proof, visible } = published('effect disclosure\nsecond row');
    const transcript = store.getSnapshot().state.transcript;
    const rows = transcriptRows(transcript, chatGrid(80));
    // 1 + gap + 1 + gap + 1 + gap + 2 rows of the conversation, then the notice's two rows (a notice hugs the entry above)
    expect(rows.map((row) => row.text)).toEqual([
      'first question',
      '',
      'first answer',
      '',
      'second question',
      '',
      'second answer',
      'over two lines',
      'effect disclosure',
      'second row',
    ]);
    proof.viewport(transcript, 80, 0, rows.length, 80);
    expect(visible()).toBe(true);
    proof.viewport(transcript, 80, rows.length - 2, rows.length, 80);
    expect(visible()).toBe(true);
    // the last row clipped: a count that lost the three separator rows would place the notice three rows up and clear it
    proof.viewport(transcript, 80, 0, rows.length - 1, 80);
    expect(visible()).toBe(false);
    proof.viewport(transcript, 80, rows.length - 1, rows.length, 80);
    expect(visible()).toBe(false);
  });

  it('a notice that wraps at the content column but not at the terminal’s width is two rows: one row in the window is not enough', () => {
    // 75 columns: one row at 80, two at the 68-column content column of an 80-column terminal
    const text = 'w'.repeat(75);
    const { store, proof, visible } = published(text);
    const transcript = store.getSnapshot().state.transcript;
    const rows = transcriptRows(transcript, chatGrid(80));
    expect(rows.slice(-2).map((row) => row.text)).toEqual(['w'.repeat(68), 'w'.repeat(7)]);
    proof.viewport(transcript, 80, rows.length - 2, rows.length - 1, 80);
    expect(visible()).toBe(false);
    proof.viewport(transcript, 80, rows.length - 2, rows.length, 80);
    expect(visible()).toBe(true);
  });

  it('fails closed when the measured width is narrower than the columns, whatever the window', () => {
    const { store, proof, visible } = published('effect disclosure');
    const transcript = store.getSnapshot().state.transcript;
    const rows = transcriptRows(transcript, chatGrid(80));
    proof.viewport(transcript, 80, 0, rows.length, 79);
    expect(visible()).toBe(false);
    proof.viewport(transcript, 80, 0, rows.length, Number.NaN);
    expect(visible()).toBe(false);
    proof.viewport(transcript, 80, 0, rows.length, 80);
    expect(visible()).toBe(true);
  });

  it('is the same at 100 and 120 columns (margin 8, content 84 and 96)', () => {
    for (const columns of [100, 120]) {
      const { store, proof, visible } = published('x'.repeat(90));
      const transcript = store.getSnapshot().state.transcript;
      const rows = transcriptRows(transcript, chatGrid(columns));
      const own = columns === 100 ? 2 : 1; // 90 columns: two rows of an 84-column content, one of a 96-column one
      expect(rows.length).toBe(8 + own);
      proof.viewport(transcript, columns, rows.length - own, rows.length - 1, columns);
      expect(visible(), `${columns}`).toBe(false);
      proof.viewport(transcript, columns, rows.length - own, rows.length, columns);
      expect(visible(), `${columns}`).toBe(true);
    }
  });
});
