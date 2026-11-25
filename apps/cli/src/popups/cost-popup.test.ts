/**
 * The `/cost` popup's words and steps ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §10; MVP-11 step 4b): the report is the notice's facts in the notice's words (one source, `costParts`), what is held and when the control
 * is offered, the confirmation line and the result.
 */
import { LEGACY_COST_SENTINEL } from '@relavium/db';
import { describe, expect, it } from 'vitest';

import { costNotice, costParts } from '../chat/repl-info.js';
import { CLI_ERROR_POLICY, CliError, type CliErrorCode } from '../process/cli-error.js';
import { displayWidth } from '../render/tui/viewport.js';
import {
  COST_STEP,
  costControls,
  costReportLines,
  costSpec,
  heldMicrocents,
  NOTHING_HELD,
  RELEASE_FAILED,
  releasable,
  releaseContent,
  releaseDoneContent,
  releaseFailedContent,
  releasedAmount,
  releaseRefusedText,
  TURN_IN_FLIGHT,
  TURN_IN_FLIGHT_NOTICE,
  turnInFlightContent,
} from './cost-popup.js';
import { costReadFailedContent } from './cost-session.js';
import { openFrame, railOf } from './popup-reducer.js';
import type { ChordRefusal } from './popup-host.js';
import { POPUP_NOTICE_MAX_COLUMNS } from './geometry.js';
import { POPUP_TEXT_COLUMNS } from './popup-text.js';
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
        expect(displayWidth(line), line).toBeLessThanOrEqual(POPUP_TEXT_COLUMNS);
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

  it('offers the release for a held estimate and for nothing else: a record known not to be durable, with nothing held, has nothing to release', () => {
    expect(releasable(costReading(0, undefined, []))).toBe(false);
    expect(costControls(costReading(0, undefined, []))).toEqual([{ key: 'c', verb: 'copy' }]);
    expect(releasable(costReading(450))).toBe(true);
    expect(costControls(costReading(450))).toEqual([
      { key: 'r', verb: 'release held estimates' },
      { key: 'c', verb: 'copy' },
    ]);
    // The warning is a fact of the report's text; with nothing held `[r]` would only lead to "nothing to release".
    const broken = costReading(0, { microcents: 0, durabilityBroken: true }, []);
    expect(releasable(broken)).toBe(false);
    expect(costControls(broken)).toEqual([{ key: 'c', verb: 'copy' }]);
    expect(costReportLines(broken).join(' ')).toContain('could not be written durably');
    expect(releasable(costReading(0, { microcents: 0, durabilityBroken: false }, []))).toBe(false);
    // Held in the governor alone (the record could not be written) it is offered, whether or not the record is known broken.
    expect(releasable(costReading(0, { microcents: 700, durabilityBroken: true }, []))).toBe(true);
    expect(releasable(costReading(0, { microcents: 700, durabilityBroken: false }, []))).toBe(true);
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

describe('the total wraps like every other line (the notice’s words, the popup’s width)', () => {
  it('a total wider than the popup continues on the next line and no word is lost', () => {
    const reading: CostReading = {
      ...costReading(0, undefined, []),
      coverage: { unverified: true, pendingInvocations: 12, unknownCalls: 34 },
    };
    const total = costParts(reading.totalCostMicrocents, reading.rows, {
      ...(reading.coverage === undefined ? {} : { coverage: reading.coverage }),
    }).total;
    // The precondition: this total is wider than the popup, so a report that did not wrap it would draw it cut.
    expect(displayWidth(total)).toBeGreaterThan(POPUP_TEXT_COLUMNS);
    const lines = costReportLines(reading);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines)
      expect(displayWidth(line), line).toBeLessThanOrEqual(POPUP_TEXT_COLUMNS);
    expect(lines.join(' ').replaceAll(/\s+/gu, ' ')).toContain(total);
  });
});

describe('the rail follows the path (rail: path)', () => {
  it('names only the steps from the first to the current one: the report alone, then the report and the line, then all three', () => {
    const names = (onRelease: boolean, step?: number) => {
      const frame = openFrame(costSpec('chat', onRelease), 1);
      return railOf({ ...frame, stepIndex: step ?? frame.stepIndex });
    };
    expect(names(false).names).toEqual(['Cost']);
    expect(names(true)).toEqual({ names: ['Cost', 'Release'], index: 1 });
    expect(names(false, COST_STEP.done)).toEqual({ names: ['Cost', 'Release', 'Done'], index: 2 });
    expect(costSpec('chat', false).rail).toBe('path');
  });
});

describe('every text the popup composes fits the popup at the 80-column floor', () => {
  const REASONS: Readonly<Record<ChordRefusal, true>> = {
    unseen: true,
    early: true,
    expired: true,
    typed: true,
  };

  /** The room a line has: the popup's text columns, and two fewer where the frame puts a glyph in front of it (an error’s first line). */
  const ROOM = POPUP_TEXT_COLUMNS;

  it.each([
    ['NOTHING_HELD', NOTHING_HELD],
    ['TURN_IN_FLIGHT', TURN_IN_FLIGHT],
    ['RELEASE_FAILED', RELEASE_FAILED],
  ])('%s: each of its two lines fits, with room for the glyph of an error', (_name, texts) => {
    expect(displayWidth(texts.what)).toBeLessThanOrEqual(ROOM - 2);
    expect(displayWidth(texts.next)).toBeLessThanOrEqual(ROOM);
  });

  it('the empty, in-flight and failed contents carry exactly those lines, and none of them says what the legend already says', () => {
    expect(releaseContent(costReading(0, undefined, []))).toEqual({
      kind: 'empty',
      ...NOTHING_HELD,
    });
    expect(turnInFlightContent()).toEqual({ kind: 'empty', ...TURN_IN_FLIGHT });
    expect(releaseFailedContent()).toEqual({ kind: 'error', ...RELEASE_FAILED });
    for (const texts of [NOTHING_HELD, TURN_IN_FLIGHT, RELEASE_FAILED])
      expect(`${texts.what} ${texts.next}`).not.toMatch(/\bEsc\b/u);
  });

  it('the read failure names the code and fits whatever the code is', () => {
    const isCode = (code: string): code is CliErrorCode => code in CLI_ERROR_POLICY;
    const codes = Object.keys(CLI_ERROR_POLICY).filter(isCode);
    expect(codes.length).toBeGreaterThan(5);
    for (const code of codes) {
      const content = costReadFailedContent(new CliError(code, 'x'));
      expect(content.what, code).toContain(code);
      expect(displayWidth(content.what), code).toBeLessThanOrEqual(ROOM - 2);
      expect(displayWidth(content.next)).toBeLessThanOrEqual(ROOM);
    }
    expect(displayWidth(costReadFailedContent(new Error('x')).what)).toBeLessThanOrEqual(ROOM - 2);
  });

  it('every notification fits the legend row, and says that nothing was released and why', () => {
    expect(displayWidth(TURN_IN_FLIGHT_NOTICE)).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
    for (const reason of Object.keys(REASONS) as ChordRefusal[]) {
      const text = releaseRefusedText(reason);
      expect(displayWidth(text), reason).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
      expect(text, reason).toMatch(/^Not released: /u);
    }
  });
});
