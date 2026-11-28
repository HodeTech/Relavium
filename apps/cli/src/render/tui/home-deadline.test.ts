/**
 * A deadline is passed by ONE rule (MVP-11 unit 7, round 2 cleanup): `deadlinePassed` (a deadline AT the clock has passed). The words of a
 * deadline (`expires in 5m`, `expired`), the red of an overdue row, the Attention order's overdue mark and the gate card's state all read it, so at
 * every instant around a deadline the four agree, and the card says the deadline in the very words the work page's row and page 1 use.
 */
import { describe, expect, it } from 'vitest';

import type { RunGate } from '../../home/run-gates.js';
import { attentionOrder, parkedRunOverdue, type ParkedRunRow } from './home-attention.js';
import { snapshotOf } from './home-controller.test-support.js';
import { deadlinePassed, expiryLabel } from './home-deadline.js';
import { projectRunCard, type RunCardSnapshot } from './run-card-model.js';

const DEADLINE = '2026-11-26T12:00:00.000Z';
const AT = Date.parse(DEADLINE);
/** Instants around the deadline: hours, a minute and a second before it, the millisecond before, the instant itself, and after it. */
const OFFSETS = [-3_600_000, -60_000, -1_000, -1, 0, 1, 1_000, 60_000, 3_600_000];

const parked: ParkedRunRow = {
  runId: 'run-0123456789',
  kind: 'approval',
  gates: 1,
  workflow: 'release-notes',
  expiresAt: DEADLINE,
};
const noDeadline: RunGate = {
  runId: 'run-0123456789',
  gateId: 'g1',
  nodeId: 'node-a',
  gateType: 'approval',
  message: 'Approve?',
  accepts: ['approved', 'rejected'],
};
const gate: RunGate = { ...noDeadline, expiresAt: DEADLINE };
const card: RunCardSnapshot = {
  runId: gate.runId,
  gates: [gate],
  cursor: 0,
  phase: 'open',
  notice: undefined,
  refused: false,
};
const stateAt = (nowMs: number): string =>
  projectRunCard(card, { columns: 80, rows: 24, nowMs }).state;

describe('deadlinePassed', () => {
  it('has passed at the instant of the deadline and after it, and not a millisecond before', () => {
    expect(deadlinePassed(DEADLINE, AT - 1)).toBe(false);
    expect(deadlinePassed(DEADLINE, AT)).toBe(true);
    expect(deadlinePassed(DEADLINE, AT + 1)).toBe(true);
  });

  it('has no deadline to pass without a text, or with a text that is no date', () => {
    for (const none of [undefined, '', 'soon', 'not a date']) {
      expect(deadlinePassed(none, AT), String(none)).toBe(false);
      expect(expiryLabel(none, AT), String(none)).toBeUndefined();
    }
  });
});

describe('the words, the row, the order and the card agree at every instant around a deadline', () => {
  it.each(OFFSETS)('%i ms from the deadline', (offset) => {
    const now = AT + offset;
    const passed = deadlinePassed(DEADLINE, now);
    expect(passed, 'the rule itself: a deadline at the clock has passed').toBe(offset >= 0);
    expect(expiryLabel(DEADLINE, now) === 'expired', 'the words').toBe(passed);
    expect(parkedRunOverdue(parked, now), 'the row’s red').toBe(passed);
    expect(attentionOrder([parked], snapshotOf({}), now)[0]?.overdue, 'the order’s mark').toBe(
      passed,
    );
    expect(stateAt(now) === 'overdue', 'the card’s state').toBe(passed);
  });
});

describe('the gate card says the deadline in the work page’s own words', () => {
  it.each(OFFSETS)('%i ms from the deadline', (offset) => {
    const now = AT + offset;
    const words = expiryLabel(DEADLINE, now);
    const rows = projectRunCard(card, { columns: 80, rows: 24, nowMs: now }).rows.map(
      (row) => row.text,
    );
    expect(rows).toContain(`node node-a · approval gate · ${words ?? ''}`);
    expect(rows.join('\n'), 'the stored timestamp is never drawn').not.toContain(DEADLINE);
  });

  it('draws no deadline at all for a gate with none, or one that is no date', () => {
    for (const withText of [noDeadline, { ...noDeadline, expiresAt: 'soon' }]) {
      const open: RunCardSnapshot = { ...card, gates: [withText] };
      const rows = projectRunCard(open, { columns: 80, rows: 24, nowMs: AT }).rows.map(
        (row) => row.text,
      );
      expect(rows, String(withText.expiresAt)).toContain('node node-a · approval gate');
      expect(rows.join('\n')).not.toContain('soon');
    }
  });
});
