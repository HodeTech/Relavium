/**
 * Review round 3: the detail of a row that is no workflow of the catalogue (unit 8 fix wave 2, O2-11): an invalid file's reason takes at
 * most three rows, cut between words with `…`; a reason that fits is whole.
 */
import { describe, expect, it } from 'vitest';

import { displayWidth } from '../render/tui/viewport.js';
import { unlistedContent, workflowDetailContent } from './home-workflows-popup.js';
import {
  definedRead,
  detailOf,
  invalidWorkflowEntry,
  workflowEntry,
} from './home-popups.test-support.js';
import { POPUP_TEXT_COLUMNS } from './popup-text.js';

function linesOf(content: ReturnType<typeof unlistedContent>): readonly string[] {
  if (content.kind !== 'report') throw new Error('a report');
  return content.lines;
}

describe('the detail of an invalid file', () => {
  const rowOf = (error: string) => {
    const entry = invalidWorkflowEntry('broken', error);
    const row = definedRead([entry]).model.rows[0];
    if (row === undefined) throw new Error('no row');
    return row;
  };

  it('a long reason takes exactly three rows: the last ends with the mark, no row is wider than the text column, no word is cut', () => {
    const reason = Array.from({ length: 60 }, (_, at) => `word${String(at)}`).join(' ');
    const lines = linesOf(unlistedContent(rowOf(reason))).filter((line) => line.includes('word'));
    expect(lines).toHaveLength(3);
    expect(lines[0]?.startsWith('Its file could not be read: word0')).toBe(true);
    expect(lines.at(-1)?.endsWith('…')).toBe(true);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(POPUP_TEXT_COLUMNS);
    const words = lines.join(' ').replace(/…$/u, '').split(/\s+/u);
    for (const word of words.filter((entry) => entry.startsWith('word')))
      expect(reason.split(' ')).toContain(word);
  });

  it('a reason that fits is whole, in one row, with no mark', () => {
    const lines = linesOf(unlistedContent(rowOf('workflow.nodes: required')));
    expect(lines).toContain('Its file could not be read: workflow.nodes: required');
    expect(lines.join('\n')).not.toContain('…');
  });
});

describe('the status words of the last runs are padded to the widest of them, no wider (review round 2, P2-4)', () => {
  const NOW = Date.parse('2026-11-27T12:00:00Z');
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();

  it('every run row’s word is as wide as the widest word, so the ages stand in one column with no gap the words do not need', () => {
    const read = definedRead([workflowEntry('release-notes')]);
    const row = read.model.rows[0];
    if (row === undefined) throw new Error('no row');
    const content = workflowDetailContent(
      {
        row,
        detail: detailOf(),
        runs: [
          { runId: '41ae651d-aaaa', status: 'paused', at: ago(5 * 60_000) },
          { runId: '092e6161-bbbb', status: 'completed', at: ago(48 * 3_600_000) },
          { runId: 'fa7f8a61-cccc', status: 'failed', at: ago(96 * 3_600_000) },
        ],
      },
      NOW,
    );
    if (content.kind !== 'list') throw new Error('a list');
    const words = content.rows
      .filter((entry) => entry.id.startsWith('run:'))
      .map((entry) => entry.statusWord ?? '');
    expect(words).toHaveLength(3);
    const widest = Math.max(...words.map((word) => word.trimEnd().length));
    expect(words.map((word) => displayWidth(word))).toEqual([widest, widest, widest]);
  });
});
