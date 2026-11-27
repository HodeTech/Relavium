/**
 * `dockedTurnRows` as a function ([ADR-0147](../../../../../docs/decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md)
 * §1: the in-flight turn stays above a docked sheet): the rows the host draws, each pinned on its own, because `sheet-docked-turn.test.tsx` mounts a
 * whole chat and only sees the tool lines, the reasoning header and a plain warning. Review round 2: removing the clip, the warning scrub,
 * the warnings' newest-first order, the reasoning body or the interrupt note left that file green.
 */
import { describe, expect, it } from 'vitest';

import { dockedTurnRows, type ReasoningPanel } from './chat-projection.js';
import { withGlyphForm } from './glyphs.js';
import { displayWidth } from './viewport.js';

const ESC = String.fromCharCode(27);

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

describe('dockedTurnRows: what stays above a docked sheet', () => {
  it('the lead row’s warnings are ONE row, the newest first, each with its terminal controls stripped', () => {
    const rows = rowsOf({ warnings: ['first old', `second ${ESC}[31mnew${ESC}[0m`] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tone).toBe('warning');
    const text = rows[0]?.text ?? '';
    expect(text).not.toContain(ESC);
    expect(text.indexOf('second new')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('first old')).toBeGreaterThan(text.indexOf('second new'));
  });

  it('every row is cut to the columns it is given, whatever its role', () => {
    const long = 'x'.repeat(200);
    const rows = rowsOf({
      columns: 20,
      warnings: [long],
      toolLines: [long],
      reasoning: { header: long, body: long },
      interrupt: long,
    });
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) expect(displayWidth(row.text), row.tone).toBeLessThanOrEqual(20);
  });

  it('a tool line is a `tool` row, in the order the turn made them', () => {
    const rows = rowsOf({ toolLines: ['-> read_file ok', '-> edit_file ok'] });
    expect(rows.map((row) => [row.tone, row.text])).toEqual([
      ['tool', '-> read_file ok'],
      ['tool', '-> edit_file ok'],
    ]);
  });

  it('the reasoning panel is its header and then its body, wrapped to the columns, line by line', () => {
    // Unit 8 fix wave 2 (S2-2): the body is set in by two columns and at most three of its rows stay above a docked sheet, the newest, `…`
    // where the rest was cut. This body wraps to four rows at 10 columns (`alpha`, `beta`, `gamma`, `delta`): the last three are kept.
    const rows = rowsOf({
      columns: 10,
      reasoning: { header: 'Reasoning', body: 'alpha beta gamma\ndelta' },
    });
    const texts = rows.map((row) => row.text.trim());
    expect(rows.every((row) => row.tone === 'reasoning')).toBe(true);
    expect(texts[0]).toBe('Reasoning');
    expect(texts.slice(1)).toEqual(['…beta', 'gamma', 'delta']);
    expect(texts.length, 'the body wrapped: more than one row of it').toBeGreaterThan(2);
    expect(rows.slice(1).every((row) => row.text.startsWith('  '))).toBe(true);
    for (const row of rows) expect(displayWidth(row.text)).toBeLessThanOrEqual(10);
    // A body that fits in three rows is drawn whole, with no mark.
    const short = rowsOf({ columns: 40, reasoning: { header: 'Reasoning', body: 'alpha\nbeta' } });
    expect(short.map((row) => row.text)).toEqual(['Reasoning', '  alpha', '  beta']);
  });

  it('the host’s rows come first: the warning, the interrupt note and the newest calls keep their rows, the reasoning takes what is left (S2-2)', () => {
    const body = Array.from({ length: 12 }, (_, at) => `model line ${String(at + 1)}`).join('\n');
    const toolLines = Array.from({ length: 6 }, (_, at) => `call ${String(at + 1)}`);
    const all = rowsOf({
      warnings: ['cut'],
      toolLines,
      reasoning: { header: 'Reasoning', body },
      interrupt: 'Interrupting',
      maxRows: 9,
    });
    expect(all.map((row) => row.tone)).toEqual([
      'warning',
      'tool',
      'tool',
      'tool',
      'tool',
      'tool',
      'tool',
      'reasoning',
      'note',
    ]);
    // With room to spare the reasoning shows its header and three rows of its body, never more.
    const roomy = rowsOf({
      toolLines: ['call 1'],
      reasoning: { header: 'Reasoning', body },
      maxRows: 9,
    });
    expect(roomy.map((row) => row.text.trim())).toEqual([
      'call 1',
      'Reasoning',
      '…model line 10',
      'model line 11',
      'model line 12',
    ]);
    // More calls than rows: the newest calls, and no reasoning at all.
    const many = rowsOf({
      toolLines: Array.from({ length: 12 }, (_, at) => `call ${String(at + 1)}`),
      reasoning: { header: 'Reasoning', body },
      maxRows: 9,
    });
    expect(many.map((row) => row.text)).toEqual(
      Array.from({ length: 9 }, (_, at) => `call ${String(at + 4)}`),
    );
  });

  it('a header with no body is one row', () => {
    expect(rowsOf({ reasoning: { header: 'Reasoning · [Ctrl+T] show' } })).toHaveLength(1);
  });

  it('the interrupt note is the last row, a `note`', () => {
    const rows = rowsOf({ toolLines: ['-> read_file ok'], interrupt: 'Interrupting' });
    expect(rows.at(-1)).toEqual({ text: 'Interrupting', tone: 'note' });
  });

  it('at most `maxRows` are kept and they are the NEWEST, the interrupt note included', () => {
    const toolLines = Array.from({ length: 6 }, (_, at) => `call ${String(at + 1)}`);
    expect(rowsOf({ toolLines, maxRows: 3 }).map((row) => row.text)).toEqual([
      'call 4',
      'call 5',
      'call 6',
    ]);
    expect(rowsOf({ toolLines, interrupt: 'Interrupting', maxRows: 2 }).map((r) => r.text)).toEqual(
      ['call 6', 'Interrupting'],
    );
    expect(rowsOf({ toolLines, maxRows: 0 })).toEqual([]);
    expect(rowsOf({ toolLines, maxRows: 100 })).toHaveLength(6);
  });
});
