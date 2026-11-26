import type { AskUserRequest } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { stripTerminalControls } from '../sanitize.js';
import { wrapTranscript } from './chat-projection.js';
import { withGlyphForm } from './glyphs.js';
import { askRecordTranscriptText, questionTranscriptText } from './question-card-record.js';
import type { TranscriptEntry } from './session-view-model.js';

/**
 * The scoped security sitting of unit 7, an improvement: the record of an `ask_user` question leads its lines with the host's own `›`, and with
 * colour off the host draws `>` instead (ADR-0145 §5). The live record is built in the form of the colour setting (`withGlyphForm(!color, ...)`),
 * but the record rebuilt from a resumed session was built outside it, so with colour off a restored record drew `›` where the live one drew `>`.
 * The form is decided where the row is drawn, so the two cannot differ.
 */
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
const answer = {
  kind: 'answered' as const,
  answers: [{ selected: ['alpha.ts'] }, { selected: ['two'], other: 'and this' }],
};
const record = {
  status: 'answered' as const,
  items: [
    { header: 'Pick', question: 'Which file?', selected: ['alpha.ts'] },
    { header: 'Also', question: 'Which more?', selected: ['two'], other: 'and this' },
  ],
};

/** What `settleQuestionWith` appends for the live record, and what `restoreSessionTranscript` builds for the stored one. */
const live = (color: boolean): TranscriptEntry => ({
  role: 'notice',
  text: stripTerminalControls(withGlyphForm(!color, () => questionTranscriptText(request, answer))),
  hostLead: 'yourTurn',
});
const restored = (): TranscriptEntry => ({
  role: 'notice',
  text: stripTerminalControls(askRecordTranscriptText(record)),
  hostLead: 'yourTurn',
});

const rowsOf = (entry: TranscriptEntry, color: boolean, cols = 80): string[] =>
  wrapTranscript([entry], cols, color).map((row) => row.text);

describe('the question record is drawn in ONE form, live or restored', () => {
  it.each([true, false])(
    'draws the same rows for the live and the restored record (colour %s)',
    (color) => {
      expect(rowsOf(restored(), color)).toEqual(rowsOf(live(color), color));
    },
  );

  it('leads each asked line with `›` with colour on', () => {
    const rows = rowsOf(restored(), true);
    expect(rows.filter((row) => row.startsWith('› Asked'))).toHaveLength(2);
    expect(rows.join('\n')).not.toContain('>');
  });

  it('leads each asked line with `>` with colour off, and never with `›`', () => {
    const rows = rowsOf(restored(), false);
    expect(rows.filter((row) => row.startsWith('> Asked'))).toHaveLength(2);
    expect(rows.join('\n')).not.toContain('›');
  });

  it('keeps the geometry: the same number of rows and the same widths in both forms, at every width', () => {
    for (let cols = 24; cols <= 120; cols += 1) {
      const colour = rowsOf(restored(), true, cols);
      const plain = rowsOf(restored(), false, cols);
      expect(plain.length, String(cols)).toBe(colour.length);
      expect(
        plain.map((row) => row.length),
        String(cols),
      ).toEqual(colour.map((row) => row.length));
    }
  });

  it('still blanks a glyph that is not at the start of a line of the record, in both forms', () => {
    const hostile = {
      ...record,
      items: [{ header: 'Pick', question: 'a › b', selected: ['x'] }],
    };
    for (const color of [true, false]) {
      const entry: TranscriptEntry = {
        role: 'notice',
        text: askRecordTranscriptText(hostile),
        hostLead: 'yourTurn',
      };
      const rows = rowsOf(entry, color);
      expect(rows.join('\n').split('›').length - 1, String(color)).toBe(color ? 1 : 0);
    }
  });
});
