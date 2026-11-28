/**
 * Review round 3: the priorities of `dockedTurnRows` that `docked-turn-rows.test.ts` leaves open. The host's own rows (the warnings' row, the
 * interrupt note) keep their room before any tool line does, the newest tool lines fill what they leave, and a room smaller than the host's own rows
 * keeps the newest of them; the reasoning needs two rows (its header and one of its body) to show any of its body.
 */
import { describe, expect, it } from 'vitest';

import { dockedTurnRows, type ReasoningPanel } from './chat-projection.js';
import { glyph, withGlyphForm } from './glyphs.js';

function rowsOf(
  input: Partial<{
    warnings: readonly string[];
    toolLines: readonly string[];
    reasoning: ReasoningPanel | undefined;
    interrupt: string | undefined;
    columns: number;
    maxRows: number;
  }>,
) {
  return withGlyphForm(false, () =>
    dockedTurnRows({
      warnings: [],
      toolLines: [],
      reasoning: undefined,
      interrupt: undefined,
      columns: 40,
      maxRows: 9,
      ...input,
    }),
  );
}
const calls = (count: number): string[] =>
  Array.from({ length: count }, (_, at) => `call ${String(at + 1)}`);

describe('dockedTurnRows: the host’s rows keep their room before the tool lines do', () => {
  it('the warning and the interrupt note fill the room exactly: no tool line takes either row', () => {
    const rows = rowsOf({
      warnings: ['cut'],
      toolLines: calls(3),
      interrupt: 'Interrupting',
      maxRows: 2,
    });
    expect(rows.map((row) => row.tone)).toEqual(['warning', 'note']);
  });

  it('a warning and more calls than rows: the warning stays on top and the NEWEST calls fill the rest', () => {
    const rows = rowsOf({ warnings: ['cut'], toolLines: calls(12), maxRows: 9 });
    expect(rows).toHaveLength(9);
    expect(rows[0]?.tone).toBe('warning');
    expect(rows.slice(1).map((row) => row.text)).toEqual(calls(12).slice(-8));
  });

  it('a warning, an interrupt note and more calls than rows: both host rows stay, with the newest calls between', () => {
    const rows = rowsOf({
      warnings: ['cut'],
      toolLines: calls(12),
      interrupt: 'Interrupting',
      maxRows: 5,
    });
    expect(rows.map((row) => row.tone)).toEqual(['warning', 'tool', 'tool', 'tool', 'note']);
    expect(rows.slice(1, 4).map((row) => row.text)).toEqual(['call 10', 'call 11', 'call 12']);
  });

  it('a room smaller than the host’s own rows keeps the newest of them: the interrupt note, then nothing', () => {
    const input = { warnings: ['cut'], interrupt: 'Interrupting', toolLines: calls(2) };
    expect(rowsOf({ ...input, maxRows: 1 }).map((row) => row.text)).toEqual(['Interrupting']);
    expect(rowsOf({ ...input, maxRows: 0 })).toEqual([]);
    expect(
      rowsOf({ warnings: ['cut'], toolLines: calls(2), maxRows: 1 }).map((r) => r.tone),
    ).toEqual(['warning']);
  });

  it('the warnings are one row, two columns between them, the newest first', () => {
    const [row] = rowsOf({ warnings: ['older', 'newer'] });
    expect(row?.text).toBe(`${glyph('warning')} newer  ${glyph('warning')} older`);
  });
});

describe('dockedTurnRows: the reasoning shows its body from the second row it has', () => {
  const reasoning: ReasoningPanel = {
    header: 'Reasoning',
    body: ['one', 'two', 'three', 'four', 'five'].join('\n'),
  };

  it('two rows left: the header and the newest line of the body, cut mark first', () => {
    const rows = rowsOf({ toolLines: calls(1), reasoning, maxRows: 3 });
    expect(rows.map((row) => row.text)).toEqual(['call 1', 'Reasoning', '  …five']);
  });

  it('one row left: the header alone', () => {
    const rows = rowsOf({ toolLines: calls(2), reasoning, maxRows: 3 });
    expect(rows.map((row) => row.text)).toEqual(['call 1', 'call 2', 'Reasoning']);
  });

  it('no row left: nothing of the reasoning', () => {
    const rows = rowsOf({ toolLines: calls(3), reasoning, maxRows: 3 });
    expect(rows.map((row) => row.text)).toEqual(['call 1', 'call 2', 'call 3']);
  });
});
