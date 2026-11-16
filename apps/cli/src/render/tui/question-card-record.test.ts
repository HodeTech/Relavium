import type { AskUserRequest } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { questionTranscriptText } from './question-card-record.js';

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
