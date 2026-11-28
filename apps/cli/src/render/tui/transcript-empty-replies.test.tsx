import { afterEach, describe, expect, it } from 'vitest';

import { chatGrid } from './chat-grid.js';
import {
  entryDrawsRows,
  formatTurnSummary,
  transcriptDocument,
  transcriptEntrySpan,
  transcriptRows,
} from './chat-projection.js';
import type { TranscriptEntry, TurnSummary } from './session-view-model.js';
import { mountStandaloneChat, type ChatMount } from './surface-matrix/chat-host.js';

/**
 * A reply with no words of its own (MVP-11 unit 9, review round 1, C-2 and O-1): a turn stopped (`Esc` during an approval) or failed before its
 * first token, a checkpoint stop, a restored empty final. Its body row was an empty row under a separator (two blank rows together) and the inline
 * renderer printed a lone `agent`. Now the summary is its first row and carries `agent`, and an entry with neither words nor a summary draws no
 * row and no separator. The `/copy` document keeps every line it had.
 */

const GRID = chatGrid(80);
const TOKENS = { input: 3, output: 0 };
const user = (text: string): TranscriptEntry => ({ role: 'user', text });
const empty = (summary?: TurnSummary): TranscriptEntry =>
  summary === undefined
    ? { role: 'assistant', text: '' }
    : { role: 'assistant', text: '', summary };

const ABORTED: TurnSummary = { stopReason: 'aborted', tokensUsed: TOKENS };
const FAILED: TurnSummary = { stopReason: 'stop', tokensUsed: TOKENS, errorCode: 'provider_auth' };
const CHECKPOINT: TurnSummary = {
  stopReason: 'stop',
  tokensUsed: TOKENS,
  errorCode: 'turn_limit',
  stoppedAtCheckpoint: 2,
};

const view = (rows: ReturnType<typeof transcriptRows>): string[] =>
  rows.map((row) => `${row.margin ?? '-'}|${row.text}`);

describe.each([true, false])('an empty reply on the grid (colour %s)', (color) => {
  it.each([
    ['a turn stopped before its first token', ABORTED],
    ['a turn that failed before its first token', FAILED],
    ['a turn stopped at a checkpoint', CHECKPOINT],
  ] as const)('%s: one separator, then the summary as the reply’s first row', (_name, summary) => {
    const rows = transcriptRows([user('do the thing'), empty(summary), user('again')], GRID, color);
    const lines = view(rows);
    expect(lines.slice(0, 3)).toEqual([
      'yourTurn|do the thing',
      '-|',
      `agent|${formatTurnSummary(summary)}`,
    ]);
    expect(lines.at(-2)).toBe('-|');
    expect(lines.at(-1)).toBe('yourTurn|again');
    // never two blank rows together, and no row with only the reply's role and no words
    expect(lines.some((line, index) => line === '-|' && lines[index - 1] === '-|')).toBe(false);
    expect(lines).not.toContain('agent|');
  });

  it('a restored empty final with no summary draws no row and no separator of its own', () => {
    const rows = transcriptRows([user('one'), empty(), user('two')], GRID, color);
    expect(view(rows)).toEqual(['yourTurn|one', '-|', 'yourTurn|two']);
    expect(transcriptRows([empty()], GRID, color)).toEqual([]);
  });

  it('a reply of only white space is an empty reply too', () => {
    const rows = transcriptRows(
      [user('one'), { role: 'assistant', text: '  \n ', summary: ABORTED }],
      GRID,
      color,
    );
    expect(view(rows)).toEqual(['yourTurn|one', '-|', `agent|${formatTurnSummary(ABORTED)}`]);
  });

  it('the documents keep the empty reply’s line', () => {
    expect(transcriptDocument([user('one'), empty(ABORTED)])).toBe(
      `> one\n\n ${formatTurnSummary(ABORTED)}`,
    );
  });
});

describe('the inline renderer prints no lone `agent` and no double blank row', () => {
  const mounts: ChatMount[] = [];
  afterEach(() => {
    for (const mount of mounts.splice(0)) mount.unmount();
  });

  it.each([true, false])('colour %s, 80 columns', async (color) => {
    const mount = mountStandaloneChat(
      { renderer: 'inline', color, size: { cols: 80, rows: 40 } },
      {
        seed: {
          initialRestore: true,
          transcript: [
            user('do the thing'),
            empty(ABORTED),
            empty(),
            user('again'),
            empty(FAILED),
            user('last'),
          ],
        },
      },
    );
    mounts.push(mount);
    await mount.until(() => mount.text().includes('last'));
    await mount.settle();
    const frame = mount.frame().map((row) => row.trimEnd());
    const first = frame.findIndex((row) => row.endsWith('do the thing'));
    const rows = frame.slice(first, frame.findIndex((row) => row.endsWith('last')) + 1);
    expect(rows).not.toContain('agent');
    expect(rows.some((row, index) => row === '' && rows[index - 1] === '')).toBe(false);
    expect(rows.filter((row) => row.startsWith('agent '))).toEqual([
      `agent ${formatTurnSummary(ABORTED)}`,
      `agent ${formatTurnSummary(FAILED)}`,
    ]);
  });
});

/**
 * Review round 2 (C2-4, M2-1, M2-2): an entry that draws no row is not what the next entry follows, so a transcript that STARTS with one has no
 * blank row at its top (the full-screen walk, the measured span and the inline renderer alike); and a reply made only of the host's marker
 * glyphs, which the row blanks, is an empty reply (no lone `agent`).
 */
describe.each([true, false])(
  'row-less entries at the top of the transcript (colour %s)',
  (color) => {
    const F = String.fromCodePoint(0x115f);
    const ROW_LESS: readonly (readonly [string, TranscriptEntry])[] = [
      ['an empty reply', empty()],
      ['a reply of white space', { role: 'assistant', text: ' \n  ' }],
      ['a reply of fillers the screen drops', { role: 'assistant', text: F.repeat(3) }],
      ['a reply of only the host’s marker glyphs', { role: 'assistant', text: '›' }],
      ['a reply of marker glyphs and spaces', { role: 'assistant', text: '▸ ▸' }],
      ['a tool entry with no call', { role: 'tools', text: '', calls: [] }],
    ];

    it.each(ROW_LESS)(
      '%s, then a turn: the turn is the first row, with no separator above it',
      (_name, entry) => {
        expect(view(transcriptRows([entry, user('hi')], GRID, color))).toEqual(['yourTurn|hi']);
        expect(view(transcriptRows([entry, entry, user('hi')], GRID, color))).toEqual([
          'yourTurn|hi',
        ]);
        expect(transcriptEntrySpan([entry, user('hi')], 1, GRID, color)).toEqual({
          start: 0,
          end: 1,
        });
        expect(entryDrawsRows(entry, GRID, color)).toBe(false);
      },
    );

    it('after a turn, the marker-only reply draws no row: no separator and no lone `agent`', () => {
      for (const text of ['›', '▸ ▸', '⇄'])
        expect(
          view(transcriptRows([user('hi'), { role: 'assistant', text }], GRID, color)),
        ).toEqual(['yourTurn|hi']);
      // with a summary, the summary is its first row, as for any empty reply
      expect(
        view(
          transcriptRows(
            [user('hi'), { role: 'assistant', text: '›', summary: ABORTED }],
            GRID,
            color,
          ),
        ),
      ).toEqual(['yourTurn|hi', '-|', `agent|${formatTurnSummary(ABORTED)}`]);
    });

    it('a row-less entry between two turns still leaves one separator, the second turn’s', () => {
      expect(view(transcriptRows([user('one'), empty(), user('two')], GRID, color))).toEqual([
        'yourTurn|one',
        '-|',
        'yourTurn|two',
      ]);
      expect(entryDrawsRows(user('one'), GRID, color)).toBe(true);
    });
  },
);

describe('the inline renderer passes over a row-less entry when it looks for the entry above', () => {
  const mounts: ChatMount[] = [];
  afterEach(() => {
    for (const mount of mounts.splice(0)) mount.unmount();
  });

  it.each([true, false])(
    'colour %s: no separator before the first turn, one between turns',
    async (color) => {
      const mount = mountStandaloneChat(
        { renderer: 'inline', color, size: { cols: 80, rows: 40 } },
        {
          seed: {
            initialRestore: true,
            transcript: [
              empty(),
              { role: 'assistant', text: '›' },
              user('first'),
              { role: 'tools', text: '', calls: [] },
              empty(),
              user('second'),
            ],
          },
        },
      );
      mounts.push(mount);
      await mount.until(() => mount.text().includes('second'));
      await mount.settle();
      const frame = mount.frame().map((row) => row.trimEnd());
      const first = frame.findIndex((row) => row.endsWith('first'));
      const second = frame.findIndex((row) => row.endsWith('second'));
      // the rows above the first turn: nothing of the row-less entries (a seeded chat prints no header, so nothing at all)
      expect(frame.slice(0, first)).toEqual([]);
      expect(frame.slice(first, second + 1)).toEqual(['you   first', '', 'you   second']);
      expect(frame).not.toContain('agent');
    },
  );
});
