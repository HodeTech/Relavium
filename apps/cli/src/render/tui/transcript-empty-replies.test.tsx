import { afterEach, describe, expect, it } from 'vitest';

import { chatGrid } from './chat-grid.js';
import { formatTurnSummary, transcriptDocument, transcriptRows } from './chat-projection.js';
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
