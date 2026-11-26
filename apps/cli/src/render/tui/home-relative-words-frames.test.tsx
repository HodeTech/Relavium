/**
 * The relative words of the Home move with the clock, with no key (MVP-11 unit 7, round 2: observation F8). A landing whose head reads
 * `expires in 5m` is repainted by the Home's own timer as the minutes pass: `expires in 4m`, then `expired` (in red once overdue), and the work
 * page's `waiting 2h` and `failed 1h ago` the same, with the clock and the timer scripted. The words are the frame's, drawn by the real
 * `RootApp` over the real controller (`mountHome`): nothing here asks the controller what it would say.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { HomeRunRow, HomeSnapshot } from '../../home/home-store.js';
import type { ParkedRunRow } from './home-attention.js';
import { RELATIVE_WORDS_REPAINT_MS } from './home-controller.js';
import { KEYS, mountHome, type HomeMount } from './surface-matrix/home-host.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const failed: HomeRunRow = {
  runId: 'f1000000-0000-4000-8000-000000000000',
  workflowSlug: 'nightly',
  status: 'failed',
  createdAt: new Date(NOW - 3 * HOUR).toISOString(),
  startedAt: undefined,
  completedAt: new Date(NOW - HOUR).toISOString(),
  totalCostMicrocents: 0,
};
const snapshot = (failedRuns: readonly HomeRunRow[]): HomeSnapshot => ({
  failedRuns,
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: failedRuns.length + 1, sessions: 0, runs: 0 },
  isEmpty: false,
});
const gated = (over: Partial<ParkedRunRow> = {}): ParkedRunRow => ({
  runId: 'p1000000-0000-4000-8000-000000000000',
  kind: 'approval',
  gates: 1,
  workflow: 'release-notes',
  expiresAt: new Date(NOW + 5 * MINUTE).toISOString(),
  parkedSince: new Date(NOW - 2 * HOUR).toISOString(),
  ...over,
});

/** A clock and a scheduler that move only when a test says so. */
function clock() {
  let now = NOW;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    nowMs: (): number => now,
    schedule: (run: () => void, delayMs: number): (() => void) => {
      const id = next;
      next += 1;
      timers.set(id, { at: now + delayMs, run });
      return () => {
        timers.delete(id);
      };
    },
    /** Move the clock forward, firing every timer that falls due on the way, in order. */
    advance: (ms: number): void => {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].run();
      }
      now = end;
    },
    pending: (): number => timers.size,
  };
}

let open: HomeMount | undefined;
afterEach(() => {
  open?.unmount();
  open = undefined;
});

function landing(
  parked: ParkedRunRow,
  failedRuns: readonly HomeRunRow[] = [],
): { readonly home: HomeMount; readonly time: ReturnType<typeof clock> } {
  const time = clock();
  const home = mountHome(
    { renderer: 'alt', color: false, size: { cols: 120, rows: 40 } },
    {
      snapshot: snapshot(failedRuns),
      props: { nowMs: time.nowMs },
      deps: {
        schedule: time.schedule,
        gateCards: {
          list: () => [parked],
          read: () => undefined,
          resume: () => new Promise(() => {}),
          guard: { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 },
        },
      },
    },
  );
  open = home;
  return { home, time };
}

const hintOf = (home: HomeMount): string =>
  home
    .text()
    .split('\n')
    .find((row) => row.includes('[Ctrl+C] exit')) ?? '';

describe('page 1: a deadline in the head counts down with no key', () => {
  it('`expires in 5m` becomes `expires in 4m` and then `expired`, the Home repainting itself', async () => {
    const { home, time } = landing(gated());
    await home.settle();
    expect(hintOf(home)).toContain('↓ release-notes needs approval · expires in 5m');
    expect(time.pending(), 'the repaint timer is armed').toBeGreaterThan(0);

    // a minute and a half later (three ticks): the deadline is 3m30s away
    time.advance(RELATIVE_WORDS_REPAINT_MS * 3);
    await home.until(() => hintOf(home).includes('expires in 3m'));
    expect(hintOf(home)).toContain('↓ release-notes needs approval · expires in 3m');
    expect(hintOf(home)).not.toContain('expires in 5m');

    // past the deadline (11 more ticks, to 5m): the head says so, with no key and no read
    time.advance(RELATIVE_WORDS_REPAINT_MS * 11);
    await home.until(() => hintOf(home).includes('expired'));
    expect(hintOf(home)).toContain('↓ release-notes needs approval · expired');
    expect(hintOf(home)).not.toContain('expires in');
  });

  it('a head with a failed run reads `failed 1h ago` and then `failed 2h ago`', async () => {
    const { home, time } = landing(gated({ expiresAt: undefined }), [failed]);
    await home.settle();
    // the parked run with no deadline outranks the failed one on page 1 (no time there); take it out of the way by looking at page 2
    home.key(KEYS.down);
    await home.settle();
    const row = (): string =>
      home
        .text()
        .split('\n')
        .find((line) => line.includes('failed')) ?? '';
    expect(row()).toContain('failed 1h ago');
    time.advance(HOUR + RELATIVE_WORDS_REPAINT_MS);
    await home.until(() => row().includes('failed 2h ago'));
    expect(row()).toContain('failed 2h ago');
  });
});

describe('page 2: how long a run has waited moves with the clock', () => {
  it('`waiting 2h` becomes `waiting 3h` an hour later, with no key', async () => {
    const { home, time } = landing(gated({ expiresAt: undefined }));
    await home.settle();
    home.key(KEYS.down);
    await home.settle();
    const row = (): string =>
      home
        .text()
        .split('\n')
        .find((line) => line.includes('release-notes')) ?? '';
    expect(row()).toContain('approval · waiting 2h · p1000000');
    time.advance(HOUR + RELATIVE_WORDS_REPAINT_MS);
    await home.until(() => row().includes('waiting 3h'));
    expect(row()).toContain('approval · waiting 3h · p1000000');
  });

  it('a row with a deadline counts it down in its slot (`expires in 5m` then `expires in 4m`)', async () => {
    const { home, time } = landing(gated());
    await home.settle();
    home.key(KEYS.down);
    await home.settle();
    const row = (): string =>
      home
        .text()
        .split('\n')
        .find((line) => line.includes('release-notes')) ?? '';
    expect(row()).toContain('approval · expires in 5m · p1000000');
    time.advance(MINUTE + RELATIVE_WORDS_REPAINT_MS);
    await home.until(() => row().includes('expires in 3m'));
    expect(row()).toContain('approval · expires in 3m · p1000000');
  });
});
