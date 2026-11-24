/**
 * The model of the Home's run view ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §5):
 * every state it can be in, with the glyph and the word of each, the disposition card of each way a leg ends (built by the real
 * `describeHostedRunTerminal`, not restated here), the notice rows' bound and sanitize floor, and the one function the controller asks
 * what `Ctrl+C` has to act on. Pure: no ink, no clock, no host.
 */
import type { RunDeparture } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import {
  describeHostedRunTerminal,
  type HostedRunDisposition,
  type HostedRunTerminalInput,
} from '../../home/hosted-run-terminal.js';
import type { HostedLegEnd, RunHostSnapshot } from '../../home/run-host.js';
import {
  RUN_SCREEN_CARD_ROWS,
  RUN_SCREEN_MIN_LIVE_ROWS,
  RUN_SCREEN_NOTICE_ROWS,
  RUN_SCREEN_NOTICE_WIDTH,
  runScreenLeg,
  runScreenModel,
  runScreenPhase,
  type RunScreenInput,
} from './run-screen.js';

const RUN = 'run-0001';
const OTHER = 'run-0002';

const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const running = (runId: string = RUN, cancelling = false): RunHostSnapshot => ({
  launching: false,
  active: { leg: 'start', runId, cancelling },
  last: undefined,
});
/** A leg the engine has not yet named a run for (`runId` is still `undefined` in the host's snapshot). */
const preparing = (cancelling = false): RunHostSnapshot => ({
  launching: false,
  active: { leg: 'start', runId: undefined, cancelling },
  last: undefined,
});

type Departure = Exclude<RunDeparture, { readonly kind: 'continue' }>;
const DETACHED: Departure = {
  kind: 'detached',
  moneyDurability: 'durable',
  effectNeedsAttention: false,
};

/** A leg that ended, with the terminal the real describer gives for these facts. */
function ended(
  over: Partial<HostedRunTerminalInput> = {},
  runId: string = RUN,
  fault?: string,
): HostedLegEnd {
  const input: HostedRunTerminalInput = {
    leg: 'start',
    runId,
    outcome: 'completed',
    durability: 'durable',
    terminalError: undefined,
    departure: DETACHED,
    ...over,
  };
  const terminal = describeHostedRunTerminal(input);
  return {
    leg: input.leg,
    runId,
    terminal,
    handedOff: terminal.disposition === 'paused',
    retirement: 'retired',
    fault,
  };
}
const settled = (end: HostedLegEnd): RunHostSnapshot => ({
  launching: false,
  active: undefined,
  last: end,
});

function model(over: Partial<RunScreenInput> = {}) {
  return runScreenModel({
    runId: RUN,
    snapshot: running(),
    notices: [],
    armed: false,
    columns: 80,
    rows: 24,
    ...over,
  });
}

describe('the states of the view', () => {
  it.each([
    {
      name: 'a leg that has not named its run yet',
      snapshot: preparing(),
      phase: 'launching',
      leg: 'executing',
      glyph: '◌',
      word: 'starting',
    },
    {
      name: 'a launch before the leg exists',
      snapshot: { ...IDLE, launching: true },
      phase: 'launching',
      leg: 'executing',
      glyph: '◌',
      word: 'starting',
    },
    {
      name: 'the leg executing',
      snapshot: running(),
      phase: 'running',
      leg: 'executing',
      glyph: '▶',
      word: 'running',
    },
    {
      name: 'the stop requested',
      snapshot: running(RUN, true),
      phase: 'cancelling',
      leg: 'cancelling',
      glyph: '■',
      word: 'cancelling',
    },
    {
      name: 'a stop requested while the leg is still preparing',
      snapshot: preparing(true),
      phase: 'cancelling',
      leg: 'cancelling',
      glyph: '■',
      word: 'cancelling',
    },
    {
      name: 'a host with no record of the run',
      snapshot: IDLE,
      phase: 'replaced',
      leg: 'none',
      glyph: '○',
      word: 'not held',
    },
    {
      name: 'no host at all',
      snapshot: undefined,
      phase: 'replaced',
      leg: 'none',
      glyph: '○',
      word: 'not held',
    },
    {
      name: 'another run executing',
      snapshot: running(OTHER),
      phase: 'replaced',
      leg: 'none',
      glyph: '○',
      word: 'not held',
    },
    {
      name: 'another run having ended since',
      snapshot: settled(ended({}, OTHER)),
      phase: 'replaced',
      leg: 'none',
      glyph: '○',
      word: 'not held',
    },
  ] as const)('$name: $phase, $glyph $word', ({ snapshot, phase, leg, glyph, word }) => {
    const m = model({ snapshot });
    expect(m.phase).toBe(phase);
    expect(runScreenPhase(RUN, snapshot)).toBe(phase);
    expect(m.leg).toBe(leg);
    expect(runScreenLeg(RUN, snapshot)).toBe(leg);
    expect(m.glyph).toBe(glyph);
    expect(m.word).toBe(word);
    expect(m.header).toContain(`${glyph} ${word}`);
    expect(m.header, 'the run id is always in the title').toContain(`run ${RUN}`);
  });

  it("a leg still preparing is another run's once this run has ended here", () => {
    const snapshot: RunHostSnapshot = { ...settled(ended({})), launching: true };
    expect(runScreenPhase(RUN, snapshot)).toBe('replaced');
    expect(runScreenLeg(RUN, snapshot)).toBe('none');
  });

  it('a resumed leg is named as such in the title', () => {
    const snapshot: RunHostSnapshot = {
      launching: false,
      active: { leg: 'resume', runId: RUN, cancelling: false },
      last: undefined,
    };
    expect(model({ snapshot }).header).toBe('▶ running  ·  run run-0001  ·  resumed');
    expect(model({ snapshot: running() }).header).toBe('▶ running  ·  run run-0001');
  });

  it('says what the view is waiting for, and for how long a stop can take', () => {
    expect(model({ snapshot: preparing() }).status).toBe('Preparing the run…');
    expect(model({ snapshot: running(RUN, true) }).status).toBe(
      'Cancelling · the run stops at its next safe point (up to 10 s)',
    );
    expect(model({ snapshot: running() }).status).toBeUndefined();
    expect(model({ snapshot: IDLE }).status).toContain('no longer held by the Home');
  });

  it('the paused handoff is a settled leg that says the run waits for an answer', () => {
    const m = model({ snapshot: settled(ended({ outcome: 'paused' })) });
    expect(m.phase).toBe('settled');
    expect(m.leg, 'a parked run has no leg to cancel').toBe('none');
    expect(m.glyph).toBe('‖');
    expect(m.word).toBe('paused');
    expect(m.card?.rows.join(' ')).toContain('paused and waiting for an answer');
    expect(m.card?.rows.join(' ')).toContain('Open the run to continue it.');
  });
});

describe('the disposition card', () => {
  const CASES: readonly {
    readonly disposition: HostedRunDisposition;
    readonly over: Partial<HostedRunTerminalInput>;
    readonly glyph: string;
    readonly word: string;
    readonly says: string;
  }[] = [
    { disposition: 'completed', over: {}, glyph: '✓', word: 'completed', says: 'completed.' },
    {
      disposition: 'failed',
      over: { outcome: 'failed' },
      glyph: '✗',
      word: 'failed',
      says: 'relavium logs run-0001',
    },
    {
      disposition: 'cancelled',
      over: { outcome: 'cancelled' },
      glyph: '⊘',
      word: 'cancelled',
      says: 'cannot be resumed',
    },
    {
      disposition: 'paused',
      over: { outcome: 'paused' },
      glyph: '‖',
      word: 'paused',
      says: 'waiting for an answer',
    },
    {
      disposition: 'uncertain',
      over: { departure: { ...DETACHED, moneyDurability: 'uncertain' } },
      glyph: '⚠',
      word: 'needs attention',
      says: 'Do not repeat paid work',
    },
    {
      disposition: 'taken_over',
      over: { outcome: undefined, durability: 'uncertain' },
      glyph: '⚠',
      word: 'taken over',
      says: 'taken over by another process',
    },
    {
      disposition: 'settled',
      over: { leg: 'resume', outcome: undefined },
      glyph: '✓',
      word: 'already settled',
      says: 'nothing to resume',
    },
  ];

  it.each(CASES)("$disposition: $glyph $word, with the describer's own words", (c) => {
    const end = ended(c.over);
    expect(end.terminal.disposition, 'the case builds the disposition it names').toBe(
      c.disposition,
    );
    const m = model({ snapshot: settled(end) });
    expect(m.phase).toBe('settled');
    expect(m.leg).toBe('none');
    expect(m.glyph).toBe(c.glyph);
    expect(m.word).toBe(c.word);
    expect(m.card?.disposition).toBe(c.disposition);
    expect(m.card?.rows.join(' ')).toContain(c.says);
    // The headline is the describer's, not a restatement of it.
    expect((m.card?.rows ?? []).join(' ').replace(/\s+/g, ' ')).toContain(
      end.terminal.headline.split(' ').slice(0, 4).join(' '),
    );
    expect(m.keys).toBe('Esc / Ctrl+C close');
  });

  it('carries the reason a fault ended the leg, once, after the remedy', () => {
    const m = model({ snapshot: settled(ended({ outcome: 'failed' }, RUN, 'disk is full')) });
    expect(m.card?.rows.at(-1)).toBe('Reason: disk is full');
  });

  it('has no card while the leg executes, cancels or is replaced: it appears only once the leg settled', () => {
    for (const snapshot of [running(), running(RUN, true), preparing(), IDLE, running(OTHER)])
      expect(model({ snapshot }).card, JSON.stringify(snapshot)).toBeUndefined();
  });

  it("has no card while a RESUMED leg runs, although the earlier leg's end is still held by the host", () => {
    const snapshot: RunHostSnapshot = {
      launching: false,
      active: { leg: 'resume', runId: RUN, cancelling: false },
      last: ended({ outcome: 'paused' }),
    };
    const m = model({ snapshot });
    expect(m.phase).toBe('running');
    expect(m.word).toBe('running');
    expect(m.leg).toBe('executing');
    expect(m.card, "the card is the leg's end, and this leg has not ended").toBeUndefined();
    expect(m.keys).toBe('Ctrl+C twice cancels the run · Esc leaves it running');
  });

  it('is bounded: a headline, remedy and reason that are very long take at most the card budget', () => {
    const longId = 'r'.repeat(300);
    const end = ended({ outcome: 'failed' }, longId, 'x '.repeat(400));
    const m = runScreenModel({
      runId: longId,
      snapshot: settled(end),
      notices: [],
      armed: false,
      columns: 80,
      rows: 24,
    });
    expect(m.card?.rows.length).toBeLessThanOrEqual(RUN_SCREEN_CARD_ROWS);
    for (const row of m.card?.rows ?? []) expect(Array.from(row).length).toBeLessThanOrEqual(78);
  });

  it("is secret-free and control-free: nothing but the describer's words and the sanitized id reach it", () => {
    const hostile = 'run\u001b[31m-\u009b2J\nforged\u202e';
    const m = runScreenModel({
      runId: hostile,
      snapshot: settled(ended({ outcome: 'failed' }, hostile, 'bad\u001b]52;c;Zm9v\u0007\nline')),
      notices: [],
      armed: false,
      columns: 80,
      rows: 24,
    });
    const all = [m.header, ...(m.card?.rows ?? [])].join('\n');
    // eslint-disable-next-line no-control-regex -- the assertion is that no control survives
    expect(all).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/u);
  });
});

describe('the notice rows', () => {
  const lines = (count: number): readonly string[] =>
    Array.from({ length: count }, (_, i) => `notice ${String(i)}`);

  it('shows the newest few, oldest first, and counts what came before them', () => {
    const m = model({ notices: lines(50) });
    expect(m.notices).toEqual(['notice 47', 'notice 48', 'notice 49']);
    expect(m.earlierNotices).toBe(47);
  });

  it('is bounded at the named constant, however many the ring holds', () => {
    expect(RUN_SCREEN_NOTICE_ROWS).toBe(3);
    for (const count of [0, 1, 3, 4, 50, 5000])
      expect(model({ notices: lines(count) }).notices.length).toBeLessThanOrEqual(
        RUN_SCREEN_NOTICE_ROWS,
      );
    expect(model({ notices: lines(2) }).notices).toEqual(['notice 0', 'notice 1']);
    expect(model({ notices: lines(2) }).earlierNotices).toBe(0);
  });

  it('cuts a long line and strips controls, again, whatever the ring did', () => {
    const m = model({
      notices: [`${'w'.repeat(500)}`, 'a\u001b[2Jb\u0007\nc\u009b2Jd\u202e', '   ', ''],
    });
    expect(Array.from(m.notices[0] ?? '').length).toBe(RUN_SCREEN_NOTICE_WIDTH);
    expect(m.notices[0]?.endsWith('…')).toBe(true);
    // The second line lost its controls and its line break; the blank ones are not rows.
    expect(m.notices).toHaveLength(2);
    // eslint-disable-next-line no-control-regex -- the assertion is that no control survives
    expect(m.notices.join('')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/u);
    expect(m.earlierNotices).toBe(0);
  });
});

describe('the key line', () => {
  it('says that Ctrl+C twice cancels the run and Esc leaves it running; armed, that one more press cancels', () => {
    expect(model().keys).toBe('Ctrl+C twice cancels the run · Esc leaves it running');
    expect(model({ armed: true }).keys).toBe(
      'Ctrl+C again cancels the run · Esc leaves it running',
    );
    expect(model({ armed: true, snapshot: preparing() }).keys).toContain('Ctrl+C again');
  });

  it('never says a press cancels when the leg is not executing, armed or not', () => {
    expect(model({ armed: true, snapshot: running(RUN, true) }).keys).toBe(
      'Waiting for the run to stop · Esc leaves the view',
    );
    for (const snapshot of [settled(ended({})), IDLE, running(OTHER)])
      expect(model({ armed: true, snapshot }).keys).toBe('Esc / Ctrl+C close');
  });
});

describe('fitting the terminal', () => {
  const STATES: readonly { readonly name: string; readonly snapshot: RunHostSnapshot }[] = [
    { name: 'running', snapshot: running() },
    { name: 'cancelling', snapshot: running(RUN, true) },
    { name: 'launching', snapshot: preparing() },
    { name: 'completed card', snapshot: settled(ended({})) },
    {
      name: 'the longest card (money and effect, a fault)',
      snapshot: settled(
        ended(
          { departure: { ...DETACHED, moneyDurability: 'uncertain', effectNeedsAttention: true } },
          'a'.repeat(36),
          'a fault message '.repeat(20),
        ),
      ),
    },
    { name: 'replaced', snapshot: IDLE },
  ];

  it.each(STATES)(
    '$name at 80×24: the rows it asks for are never more than the terminal less one',
    ({ snapshot }) => {
      const m = model({ snapshot, notices: Array.from({ length: 50 }, (_, i) => `n${String(i)}`) });
      expect(m.fits).toBe(true);
      const asked =
        1 +
        (m.status === undefined ? 0 : 1) +
        m.liveRows +
        m.notices.length +
        (m.earlierNotices > 0 ? 1 : 0) +
        (m.card?.rows.length ?? 0) +
        1;
      expect(asked).toBeLessThanOrEqual(23);
      expect(m.liveRows).toBeGreaterThanOrEqual(RUN_SCREEN_MIN_LIVE_ROWS);
    },
  );

  it('gives the live output more room when there is no card, and less when there is one', () => {
    const none = model({ snapshot: running() }).liveRows;
    const withCard = model({ snapshot: settled(ended({ outcome: 'failed' })) }).liveRows;
    expect(none).toBeGreaterThan(withCard);
  });

  it('below 80×24 is the enlarge line and the key line, with no live output, notices or card', () => {
    const m = model({
      columns: 60,
      rows: 20,
      snapshot: settled(ended({})),
      notices: ['a notice'],
    });
    expect(m.fits).toBe(false);
    expect(m.tooSmall).toBe('Terminal too small (60×20) — resize to at least 80×24.');
    expect(m.liveRows).toBe(0);
    expect(m.notices).toEqual([]);
    expect(m.card).toBeUndefined();
    expect(m.keys).toBe('Esc / Ctrl+C close');
    // Still a state with a glyph and a word, and still the key line of that state.
    expect(model({ columns: 79, rows: 24 }).keys).toContain('Ctrl+C twice cancels the run');
    expect(model({ columns: 80, rows: 23 }).fits).toBe(false);
  });
});
