/**
 * The chat's frame as data ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §4, MVP-11 step 7a): how tall the full-screen frame is, what the header's second half says, and where it ends. The numbers are written out
 * so a drifted bound shows as a diff: 23 rows at 80×24 are 2 + 16 + 5.
 */
import { describe, expect, it } from 'vitest';

import {
  CHAT_HEADER_ROWS,
  chatFrameRows,
  chatSessionTitle,
  firstUserLine,
  HEADER_TITLE_GAP,
  headerRow,
  PROMPT_BLOCK_ROWS,
} from './chat-layout.js';
import { WORDMARK } from './home-layout.js';
import { displayWidth } from './viewport.js';

const KEY_SHAPED = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUVWX0123456789abcdef'].join('-');
const BIDI = ['‮', '⁦', '‏'];
const ESC = String.fromCharCode(0x1b);

describe('the frame of a full-screen chat is one row short of the terminal', () => {
  it('is rows − 1: 23 rows at 80×24, 29 at 100×30', () => {
    expect(chatFrameRows(24)).toBe(23);
    expect(chatFrameRows(30)).toBe(29);
  });

  it('leaves 16 rows of transcript at 80×24: the frame less the header and the prompt block', () => {
    expect(CHAT_HEADER_ROWS).toBe(2);
    expect(PROMPT_BLOCK_ROWS).toBe(5);
    expect(chatFrameRows(24) - CHAT_HEADER_ROWS - PROMPT_BLOCK_ROWS).toBe(16);
  });

  it('is a whole number of at least one row, whatever the terminal reports', () => {
    expect(chatFrameRows(24.9)).toBe(23);
    expect(chatFrameRows(1)).toBe(1);
    expect(chatFrameRows(0)).toBe(1);
    expect(chatFrameRows(-3)).toBe(1);
    expect(chatFrameRows(Number.NaN)).toBe(1);
    expect(chatFrameRows(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('the session title is the first user line, scrubbed', () => {
  it('is empty before the first message, and reads the first USER line, not a notice or an answer before it', () => {
    expect(chatSessionTitle(undefined)).toBe('');
    expect(chatSessionTitle(firstUserLine([]))).toBe('');
    const transcript = [
      { role: 'notice', text: 'Resumed.' },
      { role: 'assistant', text: 'Hello.' },
      { role: 'user', text: 'Refactor the billing module' },
      { role: 'user', text: 'a second message' },
    ];
    expect(firstUserLine(transcript)).toBe('Refactor the billing module');
    expect(chatSessionTitle(firstUserLine(transcript))).toBe('Refactor the billing module');
  });

  it('is the title the persister derives: one line, collapsed, and at most 40 code points', () => {
    expect(chatSessionTitle('  Add   VAT\n\tto the invoice  ')).toBe('Add VAT to the invoice');
    const long = chatSessionTitle('x'.repeat(100));
    expect(Array.from(long).length).toBeLessThanOrEqual(42);
    expect(chatSessionTitle('   \n ')).toBe('');
  });

  it('carries nothing a first message could use against the header: control and bidirectional characters, host glyphs, a separator', () => {
    // The title keeps the first 40 code points of the message, so what is under test comes first: a later part would be cut before it is read.
    const title = chatSessionTitle(`${ESC}[31m${BIDI.join('')}› ▸ a · b ${ESC}]0;pwned\u0007 end`);
    expect(title).not.toContain(ESC);
    expect(title).not.toContain('\u0007');
    for (const mark of BIDI) expect(title).not.toContain(mark);
    expect(title).not.toContain('›');
    expect(title).not.toContain('▸');
    expect(title).not.toContain(' · ');
    expect(title.length).toBeGreaterThan(0);
  });

  it('carries no secret: a key-shaped first message is not a title', () => {
    // The key is the whole message and fits the 40 code points of a title when it is short enough to be read as one.
    const token = ['sk', 'ABCDEFGHIJKLMNOPQRSTUVWX01'].join('-');
    expect(Array.from(token).length).toBeLessThanOrEqual(40);
    expect(chatSessionTitle(token)).not.toContain(token);
  });
});

describe('the header row has the wordmark at the left edge and the title ending at the last column', () => {
  it('is the wordmark alone with no title, and for a title that reads as nothing', () => {
    expect(headerRow('', 80)).toEqual({ wordmark: WORDMARK, gap: '', title: '' });
    expect(headerRow('   ', 80)).toEqual({ wordmark: WORDMARK, gap: '', title: '' });
  });

  it('is exactly as wide as the terminal with a title: the title ends at the last column', () => {
    for (const columns of [60, 80, 100, 120]) {
      const row = headerRow('Refactor the billing module', columns);
      expect(row.title).toBe('Refactor the billing module');
      expect(displayWidth(row.wordmark + row.gap + row.title), String(columns)).toBe(columns);
    }
  });

  it('cuts a title that is too long at its END, with the host’s ellipsis, and keeps two columns between it and the wordmark', () => {
    const row = headerRow(
      'A title that is far too long to fit beside the wordmark at 40 columns',
      40,
    );
    expect(row.title.endsWith('…')).toBe(true);
    expect(row.gap.length).toBeGreaterThanOrEqual(HEADER_TITLE_GAP);
    expect(displayWidth(row.wordmark + row.gap + row.title)).toBe(40);
    expect(row.title.startsWith('A title')).toBe(true);
  });

  it('has no title where the wordmark and the gap leave no column for one', () => {
    const narrow = displayWidth(WORDMARK) + HEADER_TITLE_GAP;
    expect(headerRow('title', narrow).title).toBe('');
    expect(headerRow('title', narrow + 1).title).toBe('…');
    expect(headerRow('title', Number.NaN).title).toBe('');
  });

  it('measures a title in columns, not characters: a wide character is never split across the last column', () => {
    const row = headerRow('漢字漢字漢字漢字漢字漢字', 30);
    expect(displayWidth(row.wordmark + row.gap + row.title)).toBeLessThanOrEqual(30);
    expect(displayWidth(row.title)).toBeLessThanOrEqual(
      30 - displayWidth(WORDMARK) - HEADER_TITLE_GAP,
    );
  });

  it('scrubs the title it is handed, so a caller that forgot to cannot draw a secret or an escape', () => {
    const row = headerRow(`${KEY_SHAPED} ${ESC}[31mred`, 120);
    expect(row.title).not.toContain(KEY_SHAPED);
    expect(row.title).not.toContain(ESC);
  });
});
