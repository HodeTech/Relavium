/**
 * The `/cost` popup's words and steps ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §10; MVP-11 step 4b): the report is the notice's facts in the notice's words (one source, `costParts`), what is held and when the control
 * is offered, the confirmation line and the result.
 */
import { LEGACY_COST_SENTINEL } from '@relavium/db';
import { describe, expect, it } from 'vitest';

import { costNotice } from '../chat/repl-info.js';
import { displayWidth } from '../render/tui/viewport.js';
import {
  COST_STEP,
  costControls,
  costReportLines,
  costSpec,
  heldMicrocents,
  releasable,
  releaseContent,
  releaseDoneContent,
  releasedAmount,
} from './cost-popup.js';
import { REPORT_TEXT_COLUMNS } from './report-text.js';
import { COMPLETE, costReading, costRow } from './report.test-support.js';
import type { CostReading } from './report-port.js';

/** What the notice says of a reading: the same call the host's text path makes. */
const noticeOf = (reading: CostReading): string =>
  costNotice(reading.totalCostMicrocents, reading.rows, {
    ...(reading.coverage === undefined ? {} : { coverage: reading.coverage }),
    ...(reading.models === undefined ? {} : { models: reading.models }),
    ...(reading.governor === undefined
      ? {}
      : { durabilityBroken: reading.governor.durabilityBroken }),
  });

const READINGS: Readonly<Record<string, CostReading>> = {
  nothing: costReading(0, undefined, []),
  held: costReading(450),
  twoModels: costReading(0, undefined, [
    costRow({ model: 'claude-opus-4-8', costMicrocents: 7500, callCount: 3 }),
    costRow({ model: 'claude-sonnet-4-6', costMicrocents: 2500, callCount: 1 }),
  ]),
  legacy: costReading(0, undefined, [
    costRow({ model: LEGACY_COST_SENTINEL, isLegacy: true, costMicrocents: 4200, callCount: 0 }),
    costRow({ model: 'claude-opus-4-8', costMicrocents: 6000, callCount: 3, unpricedCalls: 1 }),
  ]),
  broken: costReading(450, { microcents: 450, durabilityBroken: true }),
  usageOnly: {
    ...costReading(0, undefined, [costRow({ model: 'a-model', costMicrocents: 500 })]),
    models: [
      { model: 'a-model', coverage: COMPLETE },
      {
        model: 'usage-only',
        coverage: { unverified: false, pendingInvocations: 1, unknownCalls: 2 },
      },
    ],
  },
};

describe('the report says what costNotice says', () => {
  it.each(Object.entries(READINGS))(
    '%s: at a width nothing wraps at, its lines are the notice’s lines',
    (_name, reading) => {
      expect(costReportLines(reading, 1000).join('\n')).toBe(noticeOf(reading));
    },
  );

  it.each(Object.entries(READINGS))(
    '%s: at the popup’s width no line is wider, a row that is continues indented, and no word is lost',
    (_name, reading) => {
      const lines = costReportLines(reading);
      for (const line of lines)
        expect(displayWidth(line), line).toBeLessThanOrEqual(REPORT_TEXT_COLUMNS);
      const words = (text: string): string[] => text.split(/\s+/u).filter((word) => word !== '');
      expect(words(lines.join(' '))).toEqual(words(noticeOf(reading)));
    },
  );

  it('a row wider than the popup continues under itself, and every continuation is indented', () => {
    const lines = costReportLines(READINGS['legacy'] ?? costReading());
    const continued = lines.filter((line) => line.startsWith('    ') && !line.startsWith('     '));
    expect(continued.length).toBeGreaterThan(0);
    for (const line of lines.slice(1)) expect(line.startsWith('  ')).toBe(true);
  });
});

describe('what is held, and when the release is offered', () => {
  it('is the larger of the rows’ estimates and the live governor’s, in micro-cents', () => {
    expect(heldMicrocents(costReading(0, undefined, []))).toBe(0);
    expect(heldMicrocents(costReading(450))).toBe(450);
    // Two rows add up.
    expect(
      heldMicrocents(
        costReading(0, undefined, [
          costRow({ model: 'a', conservativeMicrocents: 100 }),
          costRow({ model: 'b', conservativeMicrocents: 250 }),
        ]),
      ),
    ).toBe(350);
    // The governor holds what the record could not write.
    expect(heldMicrocents(costReading(0, { microcents: 700, durabilityBroken: true }, []))).toBe(
      700,
    );
    expect(heldMicrocents(costReading(450, { microcents: 100 }))).toBe(450);
  });

  it('offers the release for a held estimate or a record known not to be durable, and for nothing else', () => {
    expect(releasable(costReading(0, undefined, []))).toBe(false);
    expect(costControls(costReading(0, undefined, []))).toEqual([{ key: 'c', verb: 'copy' }]);
    expect(releasable(costReading(450))).toBe(true);
    expect(costControls(costReading(450))).toEqual([
      { key: 'r', verb: 'release held estimates' },
      { key: 'c', verb: 'copy' },
    ]);
    expect(releasable(costReading(0, { microcents: 0, durabilityBroken: true }, []))).toBe(true);
    expect(releasable(costReading(0, { microcents: 0, durabilityBroken: false }, []))).toBe(false);
  });
});

describe('the confirmation line and the result', () => {
  it('the line names the amount in its exact notation, what changes and that it cannot be undone', () => {
    const content = releaseContent(costReading(450));
    if (content.kind !== 'report') throw new Error('a line');
    const text = content.lines.join(' ').replaceAll(/\s+/gu, ' ');
    expect(text).toContain('This lifts about $0.0000045 of estimated-but-unconfirmed spend');
    expect(text).toContain('from this session’s cap, so later turns can spend that much more.');
    expect(text.endsWith('It cannot be undone.')).toBe(true);
    // The amount is never rounded down: 1,999,999 micro-cents is $0.01999999, not $0.0200.
    const odd = releaseContent(costReading(1_999_999));
    expect(odd.kind === 'report' && odd.lines.join(' ')).toContain('$0.01999999');
  });

  it('with nothing held the step is an empty state, which takes no chord', () => {
    expect(releaseContent(costReading(0, undefined, [])).kind).toBe('empty');
  });

  it('the result says what was released and the total read again; the larger half is the amount', () => {
    expect(releasedAmount({ durable: 450, live: 450 })).toBe(450);
    expect(releasedAmount({ durable: 0, live: 700 })).toBe(700);
    expect(releasedAmount({ durable: 300, live: undefined })).toBe(300);
    const done = releaseDoneContent({ durable: 450, live: 450 }, costReading(0, undefined, []));
    if (done.kind !== 'report') throw new Error('a report');
    expect(done.lines[0]).toBe('Released ~$0.0000045 back to the cap.');
    expect(done.lines.join('\n')).toContain('Session cost: $0.0001');
    const zero = releaseDoneContent({ durable: 0, live: undefined }, undefined);
    expect(zero.kind === 'report' && zero.lines[0]).toBe(
      'Nothing was held against the cap, so nothing was released.',
    );
  });
});

describe('the spec', () => {
  it('has the report, a chord step that holds its answer, and a final result; a typed release opens on the line', () => {
    const spec = costSpec('chat', false);
    expect(spec.steps.map((step) => step.name)).toEqual(['Cost', 'Release', 'Done']);
    expect(spec.steps[COST_STEP.release]).toMatchObject({
      holds: 'chord',
      chord: { verb: 'release' },
      back: COST_STEP.cost,
    });
    expect(spec.steps[COST_STEP.done]).toMatchObject({ final: true, enter: 'close' });
    expect(spec.initialStep).toBe(COST_STEP.cost);
    expect(costSpec('chat', true).initialStep).toBe(COST_STEP.release);
    // The report is not offered a control before its reading says something is held.
    expect(spec.steps[COST_STEP.cost]?.controls).toBeUndefined();
    // The copy outlasts the release and the scroll hint on a short legend row.
    expect(spec.steps[COST_STEP.cost]?.legendKeep).toEqual(['c', 'r']);
  });
});
