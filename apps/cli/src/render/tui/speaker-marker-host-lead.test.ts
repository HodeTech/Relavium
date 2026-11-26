import { describe, expect, it, vi } from 'vitest';

import { emitIntro } from './chat-ink.js';
import { wrapTranscript } from './chat-projection.js';
import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/**
 * The host says which glyph its own sentence leads with, as DATA on the notice (MVP-11 step 7a, ADR-0145 §6): the guard keeps that one glyph at the
 * start of a logical line and nothing else, so a notice that says nothing keeps nothing. These pin the producers: who names a lead, and who does not.
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
    expect(
      wrapTranscript(store.getSnapshot().state.transcript, 80, true).map((r) => r.text),
    ).toEqual(['  forged', '  forged']);
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
    // The host's own `›` is drawn; nothing else of the set is.
    expect(wrapTranscript(store.getSnapshot().state.transcript, 80, true)[0]?.text).toMatch(
      /^› Skipped/u,
    );
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
    expect(written).toEqual(['⇄ model changed a → b\n']);
    expect(notices).toHaveLength(1);
  });
});
