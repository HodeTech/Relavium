import { describe, expect, it } from 'vitest';

import type { HomeRunRow, HomeSessionRow } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import {
  agentLabel,
  EXIT_GUARD_GLYPH,
  exitGuardLines,
  expiryLabel,
  homeFitsTerminal,
  hostedRunIsLive,
  hostedRunLabel,
  HOME_MIN_COLS,
  HOME_MIN_ROWS,
  runLabel,
  sessionLabel,
  tooSmallMessage,
} from './home-projection.js';
import { formatAgeOfIso, shortId } from '../notation.js';

const NOW = Date.parse('2026-06-28T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const ahead = (ms: number): string => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const HR = 60 * MIN;
const DAY = 24 * HR;

describe('homeFitsTerminal / tooSmallMessage', () => {
  it('passes at exactly the minimum and fails below either dimension', () => {
    expect(homeFitsTerminal(HOME_MIN_COLS, HOME_MIN_ROWS)).toBe(true);
    expect(homeFitsTerminal(HOME_MIN_COLS - 1, HOME_MIN_ROWS)).toBe(false);
    expect(homeFitsTerminal(HOME_MIN_COLS, HOME_MIN_ROWS - 1)).toBe(false);
  });

  it('names both the actual size and the required minimum', () => {
    expect(tooSmallMessage(40, 10)).toBe('Terminal too small (40×10) — resize to at least 80×24.');
  });
});

describe('the age of a stamp on a Home row', () => {
  it('buckets sub-minute / minutes / hours / days, and treats a future skew as "just now"', () => {
    expect(formatAgeOfIso(ago(5_000), NOW)).toBe('just now');
    expect(formatAgeOfIso(ahead(5_000), NOW)).toBe('just now'); // clock skew, not a negative count
    expect(formatAgeOfIso(ago(5 * MIN), NOW)).toBe('5m ago');
    expect(formatAgeOfIso(ago(3 * HR), NOW)).toBe('3h ago');
    expect(formatAgeOfIso(ago(2 * DAY), NOW)).toBe('2d ago');
  });

  it('pins the 60-second bucket boundary (59s is "just now", 60s is "1m ago")', () => {
    expect(formatAgeOfIso(ago(59_000), NOW)).toBe('just now');
    expect(formatAgeOfIso(ago(60_000), NOW)).toBe('1m ago');
  });

  it('returns "" for an unparseable timestamp (the strip renders nothing, never NaN)', () => {
    expect(formatAgeOfIso('not-a-date', NOW)).toBe('');
  });
});

describe('expiryLabel', () => {
  it('is undefined when there is no deadline or it is unparseable', () => {
    expect(expiryLabel(undefined, NOW)).toBeUndefined();
    expect(expiryLabel('nope', NOW)).toBeUndefined();
  });

  it('shows "expired" once past (the Phase-1 in-process-timer caveat) and a forward count otherwise', () => {
    expect(expiryLabel(ago(MIN), NOW)).toBe('expired');
    expect(expiryLabel(ahead(5 * MIN), NOW)).toBe('expires in 5m');
    expect(expiryLabel(ahead(2 * HR), NOW)).toBe('expires in 2h');
  });

  it('is "expired" exactly at now, and floors a sub-second remaining to "in 1s" (never "in 0s")', () => {
    expect(expiryLabel(ahead(0), NOW)).toBe('expired'); // deadline == now ⇒ already due
    expect(expiryLabel(ahead(500), NOW)).toBe('expires in 1s'); // sub-second ⇒ floored to 1s
  });
});

describe('row labels', () => {
  const sessionRow = (over: Partial<HomeSessionRow> = {}): HomeSessionRow => ({
    sessionId: 's1',
    title: 'Plan the launch',
    agentSlug: 'planner',
    modelId: 'claude-opus-4-8',
    status: 'active',
    updatedAt: ago(5 * MIN),
    usageCoverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
    totalCostMicrocents: 120_000_000, // $1.2000 via the canonical 1e8 µ¢→USD conversion
    ...over,
  });

  const runRow = (over: Partial<HomeRunRow> = {}): HomeRunRow => ({
    runId: 'aabbccdd-0000-4000-8000-000000000000',
    workflowSlug: 'deploy',
    status: 'completed',
    createdAt: ago(2 * HR),
    startedAt: ago(2 * HR),
    completedAt: ago(1 * HR),
    usageCoverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
    totalCostMicrocents: 0,
    ...over,
  });

  it('sessionLabel: title · agent · when · cost; falls back to the agent slug when untitled', () => {
    // MVP-11 unit 7: the work page's rows are joined by the legend's own ` · ` (the maintainer's simplified rows).
    expect(sessionLabel(sessionRow(), NOW)).toBe('Plan the launch · planner · 5m ago · $1.2000');
    // Untitled ⇒ the agent slug is the label, shown ONCE (not doubled as title-fallback + trailing field).
    expect(sessionLabel(sessionRow({ title: undefined }), NOW)).toBe('planner · 5m ago · $1.2000');
  });

  it.each([0, 120_000_000])('qualifies both Home monetary leaves at %i microcents', (amount) => {
    const cases = [
      {
        coverage: { unverified: false, pendingInvocations: 1, unknownCalls: 0 },
        unpriced: 0,
        suffix: '1 usage pending',
      },
      {
        coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 2 },
        unpriced: 0,
        suffix: 'usage unknown for 2 calls',
      },
      {
        coverage: { unverified: true, pendingInvocations: 0, unknownCalls: 0 },
        unpriced: 0,
        suffix: 'usage unverified',
      },
      {
        coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
        unpriced: 1,
        suffix: 'price unknown for 1 call',
      },
    ];
    for (const entry of cases) {
      const tuple = {
        totalCostMicrocents: amount,
        usageCoverage: entry.coverage,
        unpricedCalls: entry.unpriced,
      };
      for (const label of [runLabel(runRow(tuple), NOW), sessionLabel(sessionRow(tuple), NOW)]) {
        expect(label).toContain(amount === 0 ? '$0.0000' : '$1.2000');
        expect(label).toContain(entry.suffix);
        expect(label).not.toContain('free');
      }
    }
    const verified = {
      totalCostMicrocents: amount,
      usageCoverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
      unpricedCalls: 0,
    };
    for (const label of [
      runLabel(runRow(verified), NOW),
      sessionLabel(sessionRow(verified), NOW),
    ]) {
      // a field of its own (a run row ends with its short id since MVP-11 unit 7, so the cost is no longer last)
      expect(label.split(' · ')).toContain(amount === 0 ? 'free' : '$1.2000');
    }
  });

  it('sessionLabel sanitizes a title — strips a control seq AND collapses a newline/tab (no forged rows)', () => {
    expect(sessionLabel(sessionRow({ title: 'hi\x1b[31mthere' }), NOW)).toContain('hithere');
    const multi = sessionLabel(sessionRow({ title: 'Plan\nthe\tlaunch' }), NOW);
    expect(multi).not.toMatch(/[\n\t]/); // one physical line — a newline/tab cannot spoof an extra strip row
    expect(multi).not.toContain('\x1b');
    expect(multi).toContain('Plan the launch');
  });

  it('runLabel: completed anchors on completedAt; falls back to a short id with no slug', () => {
    // MVP-11 unit 7: every run row ends with its short id, so a run with no slug is named by that id alone (not twice).
    expect(runLabel(runRow(), NOW)).toBe('deploy · completed · 1h ago · free · aabbccdd');
    expect(runLabel(runRow({ workflowSlug: undefined }), NOW)).toBe(
      `completed · 1h ago · free · ${shortId(runRow().runId)}`,
    );
  });

  it('runLabel: a paused run anchors on startedAt and carries no project marker (every run the Home lists is this directory’s)', () => {
    const paused = runRow({ status: 'paused', startedAt: ago(1 * HR), completedAt: undefined });
    expect(runLabel(paused, NOW)).toBe('deploy · paused · 1h ago · free · aabbccdd');
    expect(runLabel(paused, NOW)).not.toContain('other project');
  });

  it('runLabel: a RUNNING run anchors on startedAt (not completedAt/createdAt)', () => {
    const run = runRow({ status: 'running', startedAt: ago(10 * MIN), completedAt: undefined });
    expect(runLabel(run, NOW)).toBe('deploy · running · 10m ago · free · aabbccdd');
  });

  it('runLabel: a queued run (no started/completed) falls back to createdAt', () => {
    const run = runRow({
      status: 'pending',
      createdAt: ago(3 * MIN),
      startedAt: undefined,
      completedAt: undefined,
    });
    expect(runLabel(run, NOW)).toBe('deploy · pending · 3m ago · free · aabbccdd');
  });

  it('agentLabel: slug · last used', () => {
    expect(agentLabel({ agentSlug: 'coder', lastUsedAt: ago(3 * DAY) }, NOW)).toBe(
      'coder · 3d ago',
    );
  });
});

const RUN_ID = '0b8c2f4e-9d4a-4f6e-8a51-3c7d1e2f9a60';
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const running = (cancelling: boolean): RunHostSnapshot => ({
  launching: false,
  active: { leg: 'start', runId: RUN_ID, cancelling },
  last: undefined,
});
const ENDED_LAST: RunHostSnapshot = {
  launching: false,
  active: undefined,
  last: {
    leg: 'start',
    runId: RUN_ID,
    terminal: {
      disposition: 'completed',
      safety: undefined,
      headline: 'Run completed.',
      remedy: undefined,
    },
    handedOff: false,
    retirement: 'retired',
    fault: undefined,
  },
};

describe('the run row of the strip (ADR-0139 §3)', () => {
  it('shows the active run’s id and its state as a word, behind a glyph, in one line', () => {
    expect(hostedRunLabel(running(false))).toBe(
      `◐ ${shortId(RUN_ID)}  ·  running  ·  Enter show it`,
    );
    expect(hostedRunLabel(running(true))).toBe(
      `■ ${shortId(RUN_ID)}  ·  cancelling  ·  Enter show it`,
    );
    expect(hostedRunLabel(running(false))).not.toContain('\n');
  });

  it('says it is starting while the engine has not named the run yet', () => {
    expect(hostedRunLabel({ launching: true, active: undefined, last: undefined })).toBe(
      '◌ run  ·  starting',
    );
    expect(
      hostedRunLabel({
        launching: true,
        active: { leg: 'start', runId: undefined, cancelling: false },
        last: undefined,
      }),
    ).toBe('◌ run  ·  starting');
  });

  it('is nothing at all when no run is active: no host, an idle host, and a host whose last leg ended', () => {
    expect(hostedRunLabel(undefined)).toBeUndefined();
    expect(hostedRunLabel(IDLE)).toBeUndefined();
    expect(hostedRunLabel(ENDED_LAST)).toBeUndefined();
  });

  it('strips terminal control sequences from the id', () => {
    const label = hostedRunLabel({
      launching: false,
      active: { leg: 'start', runId: 'run-\u001b[31mred\u001b[0m', cancelling: false },
      last: undefined,
    });
    expect(label).not.toContain('\u001b');
  });

  it('reads one meaning of "active": a leg preparing, executing or cancelling', () => {
    expect(hostedRunIsLive(undefined)).toBe(false);
    expect(hostedRunIsLive(IDLE)).toBe(false);
    expect(hostedRunIsLive(ENDED_LAST)).toBe(false);
    expect(hostedRunIsLive({ launching: true, active: undefined, last: undefined })).toBe(true);
    expect(hostedRunIsLive(running(false))).toBe(true);
    expect(hostedRunIsLive(running(true))).toBe(true);
  });
});

describe('the exit-guard card text (ADR-0139 §6)', () => {
  it('says what leaving does and what each key does, in words, within 80 columns', () => {
    const lines = exitGuardLines('confirm', running(false), 10);
    expect(lines[0]).toBe(`${EXIT_GUARD_GLYPH.warning} A workflow run is executing: ${RUN_ID}.`);
    expect(lines.join('\n')).toContain('a stopped run cannot be resumed');
    expect(lines.at(-1)).toBe('[Ctrl+Y] stop the run and leave · Esc / [Ctrl+C] / [Ctrl+N] stay');
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(78);
  });

  it('says the run is already stopping, and names the wait', () => {
    const lines = exitGuardLines('confirm', running(true), 13);
    expect(lines[0]).toBe(`${EXIT_GUARD_GLYPH.warning} The run is stopping: ${RUN_ID}.`);
    expect(lines[1]).toContain('(about 13s)');
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(78);
  });

  it('a stopping run’s legend drops its bound only when the whole of it is wider than the card: exactly as wide it stays whole, one column narrower it gives the bound up', () => {
    const whole = exitGuardLines('confirm', running(true), 13)[1] ?? '';
    expect(whole).toContain('(about 13s)');
    const exact = [...whole].length; // plain ASCII: columns are characters
    expect(exitGuardLines('confirm', running(true), 13, false, exact)[1]).toBe(whole);
    const narrower = exitGuardLines('confirm', running(true), 13, false, exact - 1)[1] ?? '';
    expect(narrower).not.toContain('(about');
    expect(narrower).toContain('Ctrl+Y');
    expect(narrower, 'the way back is never the part that is cut').toContain('stay');
  });

  it('says the run has ended when it ended while the card was up', () => {
    expect(exitGuardLines('confirm', IDLE, 10)[0]).toBe(
      `${EXIT_GUARD_GLYPH.ended} The run has ended.`,
    );
  });

  it('says it is stopping once the person confirmed, and for how long the Home waits', () => {
    const lines = exitGuardLines('stopping', running(true), 13);
    expect(lines[0]).toBe(`${EXIT_GUARD_GLYPH.stopping} Stopping the run…`);
    expect(lines[1]).toContain('within about 13s');
  });
});
