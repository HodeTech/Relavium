import { describe, expect, it, vi } from 'vitest';

import { emitIntro } from './chat-ink.js';
import { wrapTranscript } from './chat-projection.js';
import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/**
 * The host says which glyph its own sentence leads with, as DATA on the notice (MVP-11 step 7a, ADR-0145 §6). On the grid (unit 9) that lead is
 * the margin role of the first row of each logical line that begins with it, and a notice that names none has no role on any row. These pin the
 * producers: who names a lead, and who does not.
 */

/** Longer than the card's reading guard, so the skip key is taken (the approval-guard suite steps its clock 600 ms for the same reason). */
const QUESTION_READING_MS = 600;

describe('who names a host lead on a notice', () => {
  it('a notice appended with no lead has none: a command’s output, a name or a note is never the host’s mark', () => {
    const store = createChatStore(true, undefined, INLINE_TRANSCRIPT_BOUND);
    store.notice('› forged\n⇄ forged');
    const entry = store.getSnapshot().state.transcript.at(-1);
    expect(entry).toEqual({ role: 'notice', text: '› forged\n⇄ forged' });
    expect(entry).not.toHaveProperty('hostLead');
    // No row carries a margin role (unit 9), and the glyphs are blanked on the screen (review round 1, S-1: OQ4 as revised).
    const rows = wrapTranscript(store.getSnapshot().state.transcript, 80, true);
    expect(rows).toEqual([
      { text: '  forged', style: 'notice' },
      { text: '  forged', style: 'notice' },
    ]);
  });

  it('a notice appended with a lead carries it on the entry', () => {
    const store = createChatStore(true, undefined, INLINE_TRANSCRIPT_BOUND);
    store.notice('⇄ model changed a → b', 'modelSwitch');
    expect(store.getSnapshot().state.transcript.at(-1)).toEqual({
      role: 'notice',
      text: '⇄ model changed a → b',
      hostLead: 'modelSwitch',
    });
  });

  it('the record the host leaves for an answered or skipped question leads with the host’s `›`, as data', () => {
    // The card takes no answer in its first moments (a key typed before the person could read it): the wall clock is stepped past them.
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    const store = createChatStore(true, undefined, INLINE_TRANSCRIPT_BOUND);
    try {
      store.bindQuestionVisibility(() => true);
      void store.requestQuestion({
        questions: [
          {
            header: 'Scope',
            question: 'Which?',
            multiSelect: false,
            options: [
              { label: 'alpha', description: 'first' },
              { label: 'beta', description: 'second' },
            ],
          },
        ],
      });
      vi.advanceTimersByTime(QUESTION_READING_MS);
      store.handleReviewInput('s', { ctrl: true }); // skip
    } finally {
      vi.useRealTimers();
    }
    const entry = store.getSnapshot().state.transcript.at(-1);
    expect(entry).toMatchObject({ role: 'notice', hostLead: 'yourTurn' });
    expect(entry?.text.startsWith('› Skipped')).toBe(true);
    // The host's own `›` is drawn, as the row's margin role (unit 9): it leaves the text, which starts at the content column.
    const [first] = wrapTranscript(store.getSnapshot().state.transcript, 80, true);
    expect(first?.margin).toBe('yourTurn');
    expect(first?.text).toMatch(/^Skipped/u);
  });

  it('the intro of a full-screen chat is a notice that may lead with `⇄`; the inline intro is written to the terminal and names none', () => {
    const notices: [string, string | undefined][] = [];
    const written: string[] = [];
    const ports = {
      notice: (text: string, lead?: string): void => void notices.push([text, lead]),
      writeOut: (text: string): void => void written.push(text),
    };
    emitIntro('⇄ model changed a → b', true, ports);
    expect(notices).toEqual([['⇄ model changed a → b', 'modelSwitch']]);
    expect(written).toEqual([]);
    emitIntro('⇄ model changed a → b', false, ports);
    // Moved in unit 9: on the grid the inline intro's lead is the role WORD in the margin (6 columns at 80), in place of the glyph; it names no
    // notice lead, and the sentence stands in the content column. Moved again in review round 1 (D-5): the word is `note`, so the sentence that
    // starts with `model changed` is not read `model model`.
    expect(written).toEqual(['note  model changed a → b\n']);
    expect(notices).toHaveLength(1);
  });
});
