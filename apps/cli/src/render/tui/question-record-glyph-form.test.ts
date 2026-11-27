import type { AskUserRequest } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { stripTerminalControls } from '../sanitize.js';
import { wrapTranscript } from './chat-projection.js';
import { withGlyphForm } from './glyphs.js';
import { askRecordTranscriptText, questionTranscriptText } from './question-card-record.js';
import type { TranscriptEntry } from './session-view-model.js';
import type { DisplayLine } from './viewport.js';

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
/** The rows with their margin role (unit 9: the record's lead is the role, drawn by the margin in the form of the draw). */
const markedRowsOf = (entry: TranscriptEntry, color: boolean): DisplayLine[] =>
  wrapTranscript([entry], 80, color);

describe('the question record is drawn in ONE form, live or restored', () => {
  it.each([true, false])(
    'draws the same rows for the live and the restored record (colour %s)',
    (color) => {
      // Moved in unit 9: compared with their margin roles, not only their text (the lead is the role now).
      expect(markedRowsOf(restored(), color)).toEqual(markedRowsOf(live(color), color));
    },
  );

  // Moved in unit 9 (the grid): the two tests that pinned the lead's GLYPH at the start of the text (`›` with colour on, `>` off) pin the role now:
  // the lead leaves the text in both forms and is the `yourTurn` margin role, which the margin draws as `›` or `>` by the colour (`marginCell`,
  // `chat-grid.test.ts`), so a restored record built in the Unicode form and a live one built in the plain form cannot differ on the screen.
  it.each([true, false])(
    'leads each asked line with the `yourTurn` margin role, and its text holds neither form of the glyph (colour %s)',
    (color) => {
      for (const entry of [restored(), live(color)]) {
        const rows = markedRowsOf(entry, color);
        const led = rows.filter((row) => row.margin === 'yourTurn');
        expect(led.map((row) => row.text.slice(0, 6))).toEqual(['Asked:', 'Asked:']);
        expect(rows.filter((row) => row.margin !== undefined)).toHaveLength(2);
        const text = rows.map((row) => row.text).join('\n');
        expect(text).not.toContain('›');
        expect(text).not.toContain('> ');
      }
    },
  );

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

  // Moved in unit 9: a glyph that is not the lead of a line is no longer blanked; it is TEXT in the content column, and the margin (the only place
  // a mark is drawn) holds the role of the record's own lead and nothing else.
  // Moved again in review round 1 (S-1, OQ4 as revised): a glyph in the model's words is blanked on the screen; the lead is the margin's.
  it('blanks a glyph that is not at the start of a line of the record, and marks only the lead, in both forms', () => {
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
      const rows = markedRowsOf(entry, color);
      expect(
        rows
          .map((row) => row.text)
          .join('\n')
          .split('›').length - 1,
        String(color),
      ).toBe(0);
      expect(
        rows.filter((row) => row.margin === 'yourTurn'),
        String(color),
      ).toHaveLength(1);
    }
  });
});
