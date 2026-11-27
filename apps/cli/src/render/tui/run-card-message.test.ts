/**
 * What the gate card does with the author's message, and with the one gate that takes a value the card cannot
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4): an approval is answered with what is on
 * the screen, so the card spends the rows the terminal leaves it on the message, and when it still has to cut the message it says so, in
 * a line of its own, and says where to read the rest, so a fifth line's instruction is never unread behind an `Approve`.
 *
 * Pure: the projection of a snapshot at a size; no ink, no clock, no host.
 */
import { describe, expect, it } from 'vitest';

import type { RunGate } from '../../home/run-gates.js';
import {
  projectRunCard,
  RUN_CARD_GUTTER,
  RUN_CARD_MESSAGE_MAX_ROWS,
  RUN_CARD_MESSAGE_ROWS,
  type RunCardProjection,
  type RunCardSnapshot,
} from './run-card-model.js';
import { displayWidth } from './viewport.js';

const RUN = 'run-0001';
/** The rows no frame uses: a terminal of 24 lines draws at most 23. */
const MOST_ROWS_AT_24 = 23;

function gate(over: Partial<RunGate> = {}): RunGate {
  return {
    runId: RUN,
    gateId: 'g1',
    nodeId: 'review',
    gateType: 'approval',
    message: 'Ship it?',
    accepts: ['approved', 'rejected'],
    ...over,
  };
}

function snapshotOf(
  gates: readonly RunGate[],
  over: Partial<RunCardSnapshot> = {},
): RunCardSnapshot {
  return {
    runId: RUN,
    gates,
    cursor: 0,
    phase: 'open',
    notice: undefined,
    refused: false,
    ...over,
  };
}

function project(
  gates: readonly RunGate[],
  size: { readonly columns?: number; readonly rows?: number } = {},
  over: Partial<RunCardSnapshot> = {},
  nowMs = 0,
): RunCardProjection {
  return projectRunCard(snapshotOf(gates, over), {
    columns: size.columns ?? 80,
    rows: size.rows ?? 24,
    nowMs,
  });
}

const texts = (projection: RunCardProjection): string[] => projection.rows.map((row) => row.text);
const authorRows = (projection: RunCardProjection): string[] =>
  projection.rows.filter((row) => row.role === 'author').map((row) => row.text);
/** `n` lines, each one row at 80 columns: `line 1 …`. */
const lines = (n: number): string =>
  Array.from({ length: n }, (_, i) => `line ${String(i + 1)} of the message`).join('\n');
const CONTINUES = 'The message continues. To read all of it, run:';

describe('a message that fits the room the terminal leaves', () => {
  it('shows six lines whole at 80×24, with no ellipsis and no word about a rest', () => {
    const projection = project([gate({ message: lines(6) })]);
    expect(authorRows(projection)).toEqual(
      Array.from({ length: 6 }, (_, i) => `${RUN_CARD_GUTTER}line ${String(i + 1)} of the message`),
    );
    expect(texts(projection).join('\n')).not.toContain('…');
    expect(texts(projection).join('\n')).not.toContain('continues');
  });

  it('shows no more than the named bound, however tall the terminal is, and says where the rest is', () => {
    const tall = project([gate({ message: lines(40) })], { rows: 60 });
    const shown = authorRows(tall);
    // The cut row and the lines that follow are host words, not author text: only the kept rows carry the gutter.
    expect(shown.length).toBeLessThan(RUN_CARD_MESSAGE_MAX_ROWS);
    expect(shown.at(-1)).toMatch(/…$/u);
    expect(texts(tall)).toContain(CONTINUES);
    // The bound is the whole block: the kept rows and the two lines that say where the rest is.
    expect(shown.length + 2).toBeLessThanOrEqual(RUN_CARD_MESSAGE_MAX_ROWS);
  });

  it('takes more of a taller terminal than of 80×24, up to the bound', () => {
    const at24 = authorRows(project([gate({ message: lines(40) })])).length;
    const at40 = authorRows(project([gate({ message: lines(40) })], { rows: 40 })).length;
    expect(at40).toBeGreaterThanOrEqual(at24);
    expect(at24, 'a plain card at 80×24 has rows to spare for the message').toBeGreaterThan(
      RUN_CARD_MESSAGE_ROWS,
    );
  });
});

describe('a message that does not fit', () => {
  it('ends the last kept row in an ellipsis and says, in a line of its own, where the rest can be read', () => {
    const projection = project([gate({ message: lines(30) })]);
    const shown = authorRows(projection);
    expect(shown.at(-1)).toMatch(/…$/u);
    expect(shown.at(-1)?.startsWith(RUN_CARD_GUTTER)).toBe(true);
    expect(texts(projection)).toContain(CONTINUES);
    expect(texts(projection)).toContain(`  relavium gate list ${RUN}`);
    // The line that says it is the card's own, in the dim role of the card's facts, never behind the author's gutter.
    const remedy = projection.rows.find((row) => row.text === CONTINUES);
    expect(remedy?.role).toBe('fact');
    expect(remedy?.text.startsWith(RUN_CARD_GUTTER)).toBe(false);
  });

  it('keeps every key it had: the message being cut takes nothing away from the answer chords', () => {
    const projection = project([gate({ message: lines(30) })]);
    expect(projection.rows.at(-1)?.text).toBe(
      '[Ctrl+Y] Approve · [Ctrl+N] Reject · Esc leaves it pending',
    );
  });

  it('fits 80×24 whatever else the card shows: an overdue gate, six gates and a long notice', () => {
    const at = '2026-11-23T12:00:00.000Z';
    const gates = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
      gate({ gateId: id, message: lines(30), expiresAt: at, timeoutAction: 'reject' }),
    );
    const projection = project(
      gates,
      {},
      { cursor: 3, notice: `Another run is executing: ${'run-9 '.repeat(60)}` },
      Date.parse(at) + 1,
    );
    // The message takes exactly what the rest of the card leaves of the terminal, so the card fills the 23 rows and no more.
    expect(projection.rows).toHaveLength(MOST_ROWS_AT_24);
    // Seven rows: the expired gate's facts no longer spend one on the stored timestamp (`Overdue since …`), and the sheet's heavy rule
    // (ADR-0147 §1, unit 8) takes one of the eight the message had.
    expect(authorRows(projection)).toHaveLength(7);
    expect(texts(projection)).toContain(CONTINUES);
    for (const row of projection.rows) expect(displayWidth(row.text)).toBeLessThanOrEqual(78);
    expect(projection.rows.at(-1)?.text).toContain('Esc leaves it pending');
  });

  it('a message that is exactly as long as the room is not cut', () => {
    // A plain approval card at 80×24 has 19 rows left of the 23, and the bound is 12: twelve lines fit, thirteen do not.
    expect(
      texts(project([gate({ message: lines(RUN_CARD_MESSAGE_MAX_ROWS) })])).join('\n'),
    ).not.toContain('continues');
    expect(
      texts(project([gate({ message: lines(RUN_CARD_MESSAGE_MAX_ROWS + 1) })])).join('\n'),
    ).toContain('continues');
  });

  it('puts no command in the line when the recorded ids are not shell-inert, and still says where to read', () => {
    const projection = project([gate({ runId: 'run;rm -rf ~', message: lines(30) })]);
    const all = texts(projection).join('\n');
    expect(all).toContain('The message continues. To read all of it, run relavium gate list');
    expect(all).toContain('with the id of this run.');
    expect(all).not.toContain('rm -rf');
    expect(all).not.toContain(`relavium gate list run`);
  });

  it('cuts a message of wide characters by display columns: no row is wider than the card, and none is split mid-character', () => {
    const wide = Array.from(
      { length: 20 },
      (_, i) => `${String(i)} ${'日本語の長い文章です。'.repeat(8)}`,
    ).join('\n');
    const projection = project([gate({ message: wide })]);
    const shown = authorRows(projection);
    expect(shown.length).toBeGreaterThan(1);
    for (const row of projection.rows) expect(displayWidth(row.text)).toBeLessThanOrEqual(78);
    expect(shown.at(-1)).toMatch(/…$/u);
    expect(texts(projection)).toContain(CONTINUES);
    // An emoji sequence is one cell group: it is never cut apart by the wrap or by the ellipsis.
    const family = '👨‍👩‍👧‍👦';
    const emoji = project([
      gate({ message: Array.from({ length: 30 }, () => family.repeat(30)).join('\n') }),
    ]);
    for (const row of emoji.rows) expect(displayWidth(row.text)).toBeLessThanOrEqual(78);
  });

  it('is a budget gate`s nothing: it has no author text, so there is nothing to cut', () => {
    const budget = {
      runId: RUN,
      gateId: 'b1',
      nodeId: 'writer',
      allowance: { kind: 'amount', microcents: 4_200_000 },
      accepts: ['approved', 'rejected'],
    } as const;
    const projection = projectRunCard(
      { runId: RUN, gates: [budget], cursor: 0, phase: 'open', notice: undefined, refused: false },
      { columns: 80, rows: 24, nowMs: 0 },
    );
    expect(authorRows(projection)).toEqual([]);
    expect(texts(projection).join('\n')).not.toContain('continues');
  });
});

describe('a gate that takes a typed value', () => {
  const input = (over: Partial<RunGate> = {}): RunGate =>
    gate({
      gateType: 'input',
      accepts: ['input_provided', 'rejected'],
      runId: '0b8f3a52-9d41-4c6e-8a07-5e2d1c9b7f64',
      gateId: 'collect-the-token',
      message: 'Paste the deploy token',
      ...over,
    });

  it('shows the whole shell command that takes the value, wrapped, with its `--input <json>` placeholder', () => {
    const projection = project([input()]);
    const all = texts(projection);
    expect(all.join('\n')).toContain(
      'This gate takes a typed value, which this card cannot take. In a shell:',
    );
    const command = all.find((row) => row.startsWith('input: relavium gate '));
    expect(command, 'the command starts on its own row').toBeDefined();
    // Cut at the width it would end before `--input`: wrapped, every word of it is on screen.
    const joined = all.join(' ');
    expect(joined).toContain('--gate collect-the-token --input <json>');
    for (const row of projection.rows) expect(displayWidth(row.text)).toBeLessThanOrEqual(78);
  });

  it('keeps the placeholder a shell would refuse as pasted, rather than a value that would resolve the gate with a literal', () => {
    const joined = texts(project([input()])).join(' ');
    expect(joined).toContain('--input <json>');
    expect(joined).not.toContain("--input '<json>'");
  });

  it('says that rejecting continues the run, as an approval gate does, and offers its one key', () => {
    const projection = project([input()]);
    expect(texts(projection)).toContain(
      'Rejecting does not stop the run: the workflow routes on a rejection.',
    );
    expect(projection.rows.at(-1)?.text).toBe('[Ctrl+N] Reject · Esc leaves it pending');
  });

  it('names the flags only when the recorded ids would not be a safe command, and still fits', () => {
    const projection = project([input({ runId: 'run;rm -rf ~', gateId: 'g 1' })]);
    const joined = texts(projection).join(' ');
    expect(joined).toContain(
      'Use relavium gate with the recorded run and gate IDs and --input <json>',
    );
    expect(joined).not.toContain('rm -rf');
    for (const row of projection.rows) expect(displayWidth(row.text)).toBeLessThanOrEqual(78);
  });

  it('fits 80×24 with a long message, an overdue deadline, six gates and a notice', () => {
    const at = '2026-11-23T12:00:00.000Z';
    const gates = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
      input({ gateId: `gate-${id}`, message: lines(30), expiresAt: at, timeoutAction: 'reject' }),
    );
    const projection = project(
      gates,
      {},
      { cursor: 2, notice: `Another run is executing: ${'run-9 '.repeat(60)}` },
      Date.parse(at) + 1,
    );
    expect(projection.rows.length).toBeLessThanOrEqual(MOST_ROWS_AT_24);
    expect(texts(projection)).toContain(CONTINUES);
    expect(texts(projection).join(' ')).toContain('--input <json>');
  });
});
