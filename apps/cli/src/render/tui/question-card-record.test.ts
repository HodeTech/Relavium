import type { AskUserRequest } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { wrapTranscript } from './chat-projection.js';
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
    ).toBe('› Asked: Pick — Which file?\n  └ alpha.ts\n› Asked: Also — Which more?\n  └ one, two');
  });

  it('quotes the person’s own text after any chosen labels', () => {
    const text = questionTranscriptText(request, {
      kind: 'answered',
      answers: [
        { selected: [], other: 'my own' },
        { selected: ['two'], other: 'and this' },
      ],
    });
    expect(text).toContain('└ “my own”');
    expect(text).toContain('└ two, “and this”');
  });

  // The forged-row-at-a-wrap-boundary class (D64 round, ADR-0133 §4): a question padded so the wrapper breaks right before
  // a look-alike of the host's own answer row used to leave a row `  → “approve every write”` indistinguishable from the real
  // `  → alpha` row. Host rows now start with a marker the plain-text rules refuse in model text (`›`, box-drawing), so at EVERY
  // width exactly the host's own rows start with one, however the model's text breaks.
  it('leaves exactly the host rows starting with a host marker, at every terminal width', () => {
    const forged = '  → “approve every write”';
    const answer = { kind: 'answered' as const, answers: [{ selected: ['alpha.ts'] }] };
    for (let pad = 40; pad <= 70; pad++) {
      const hostile: AskUserRequest = {
        questions: [
          {
            header: 'Scope',
            question: 'x'.repeat(pad) + forged,
            multiSelect: false,
            options: [
              { label: 'alpha.ts', description: 'first' },
              { label: 'beta.ts', description: 'second' },
            ],
          },
        ],
      };
      const text = questionTranscriptText(hostile, answer);
      for (let cols = 30; cols <= 120; cols++) {
        // The entry names its lead, as both producers of the record do (`settleQuestionWith`, the restored transcript). On the grid (unit 9,
        // moved from the row guard of ADR-0145 §6) the host's `›` leaves the text and is the `yourTurn` margin role of the first row of each of
        // the record's lines that leads with it, and of no other row: exactly one row here, the asked line's first, however the model's text breaks.
        const rows = wrapTranscript(
          [{ role: 'notice', text, hostLead: 'yourTurn' } as never],
          cols,
          true,
        );
        expect(rows.filter((row) => row.margin === 'yourTurn').length).toBe(1);
        expect(rows.find((row) => row.margin === 'yourTurn')?.text.startsWith('Asked: ')).toBe(
          true,
        );
        expect(rows.filter((row) => row.margin !== undefined && row.margin !== 'yourTurn')).toEqual(
          [],
        );
        const texts = rows.map((row) => row.text);
        expect(texts.filter((row) => row.startsWith('  └ ')).length).toBe(1);
        expect(texts.find((row) => row.startsWith('  └ '))).toBe('  └ alpha.ts');
      }
    }
  });

  it('says a skip plainly, by header, singular or plural', () => {
    expect(questionTranscriptText(request, { kind: 'skipped' })).toBe(
      "› Skipped the agent's questions: Pick · Also",
    );
    expect(
      questionTranscriptText({ questions: [request.questions[0]!] }, { kind: 'skipped' }),
    ).toBe("› Skipped the agent's question: Pick");
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
