import type { AskUserRequest } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { askRecordTranscriptText, questionTranscriptText } from './question-card-record.js';

const request: AskUserRequest = {
  questions: [
    {
      header: 'Pick',
      question: 'Which file?',
      multiSelect: false,
      options: [
        { label: 'alpha.ts', description: 'first' },
        { label: 'beta.ts', description: 'second' },
      ],
    },
    {
      header: 'Also',
      question: 'Which more?',
      multiSelect: true,
      options: [
        { label: 'one', description: 'one' },
        { label: 'two', description: 'two' },
      ],
    },
  ],
};

describe('the transcript entry (ADR-0132 §6)', () => {
  it('lists each question with what was chosen under it, in order', () => {
    expect(
      questionTranscriptText(request, {
        kind: 'answered',
        answers: [{ selected: ['alpha.ts'] }, { selected: ['one', 'two'] }],
      }),
    ).toBe('Asked: Pick — Which file?\n  → alpha.ts\nAsked: Also — Which more?\n  → one, two');
  });

  it('quotes the person’s own text after any chosen labels', () => {
    const text = questionTranscriptText(request, {
      kind: 'answered',
      answers: [
        { selected: [], other: 'my own' },
        { selected: ['two'], other: 'and this' },
      ],
    });
    expect(text).toContain('→ “my own”');
    expect(text).toContain('→ two, “and this”');
  });

  it('says a skip plainly, by header, singular or plural', () => {
    expect(questionTranscriptText(request, { kind: 'skipped' })).toBe(
      "Skipped the agent's questions: Pick · Also",
    );
    expect(
      questionTranscriptText({ questions: [request.questions[0]!] }, { kind: 'skipped' }),
    ).toBe("Skipped the agent's question: Pick");
  });
});

describe('the entry rebuilt from a stored record (ADR-0133)', () => {
  it('reads exactly as the live entry did, for an answer with choices and own text and for a skip', () => {
    const answer = {
      kind: 'answered' as const,
      answers: [{ selected: ['alpha.ts'] }, { selected: ['two'], other: 'and this' }],
    };
    expect(
      askRecordTranscriptText({
        status: 'answered',
        items: [
          { header: 'Pick', question: 'Which file?', selected: ['alpha.ts'] },
          { header: 'Also', question: 'Which more?', selected: ['two'], other: 'and this' },
        ],
      }),
    ).toBe(questionTranscriptText(request, answer));
    expect(
      askRecordTranscriptText({
        status: 'skipped',
        items: [
          { header: 'Pick', question: 'Which file?' },
          { header: 'Also', question: 'Which more?' },
        ],
      }),
    ).toBe(questionTranscriptText(request, { kind: 'skipped' }));
  });

  it('reads an own-text-only item (an empty or absent choice list) the same way', () => {
    const live = questionTranscriptText(
      { questions: [request.questions[0]!] },
      { kind: 'answered', answers: [{ selected: [], other: 'my own' }] },
    );
    for (const selected of [[], undefined])
      expect(
        askRecordTranscriptText({
          status: 'answered',
          items: [{ header: 'Pick', question: 'Which file?', selected, other: 'my own' }],
        }),
      ).toBe(live);
  });
});
