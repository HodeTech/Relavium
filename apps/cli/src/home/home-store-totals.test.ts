import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CorruptRunEventError,
  createClient,
  createRunHistoryReader,
  createSessionStore,
  runEvents,
  runMigrations,
  runs,
  UnreadableRunEventLogError,
  workflows,
  type RunHistoryReader,
  type RunSummaryFilter,
  type RunSummaryRecord,
  type SessionStore,
} from '@relavium/db';
import type { AgentSessionRecord, RunStatus } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { UNVERIFIED_USAGE } from '../history/usage-coverage.js';
import { PARKED_RUNS_MAX, readParkedRuns } from '../render/tui/home-attention.js';
import { ATTENTION_ROWS_MAX } from '../render/tui/home-work-budget.js';
import {
  ATTENTION_FAILED_WINDOW_MS,
  buildHomeSnapshot,
  DEFAULT_HOME_LIMIT,
  HOME_LIMIT_MAX,
  type HomeSnapshot,
} from './home-store.js';
import { readProjectRunGates } from './run-gates.js';

/**
 * The Home's TRUE totals and its exactly-once counting (MVP-11 unit 7; the maintainer: "buradaki sayıları doğru gösterelim"). Property
 * tests over random run sets on a fake store with the db's filter semantics (fixed seeds), and one test over a real `history.db` file:
 *
 * - every run of this directory is counted ONCE: a paused run is Attention (a parked row, or an unreadable one); a failed run created
 *   inside the window is Attention (a failed row, or unreadable); every other run is a Runs row, unless its log turned out unreadable while
 *   the snapshot read it, and then it is an Attention item and no longer a run;
 * - nothing of another directory (or of no directory) is in a list or a count;
 * - rows a section can show plus its `N more` equal its total, for every cap: no section ever loads more rows than its total says, and
 *   when every row is loaded the total is exactly the rows (the counts are what the lists would hold if unbounded);
 * - the totals do not depend on the loaded limit: the sessions' total never, and Attention + Runs never (an unreadable run found among
 *   the Runs rows moves from one to the other, which is the only way the split moves).
 */

const HERE = '/work/here';
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const SINCE = NOW - ATTENTION_FAILED_WINDOW_MS;
const STATUSES: readonly RunStatus[] = [
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
];

type Log = 'ok' | 'corrupt' | 'newer';
interface FakeRun {
  readonly id: string;
  readonly workflowId: string;
  readonly projectRoot: string | undefined;
  readonly status: RunStatus;
  readonly createdAt: number;
  readonly deleted: boolean;
  readonly log: Log;
}
interface FakeSession {
  readonly id: string;
  readonly workingDir: string;
  readonly updatedAt: number;
  readonly deleted: boolean;
}

/** A run set and its sessions, as the fake store holds them. */
interface World {
  readonly runs: readonly FakeRun[];
  readonly sessions: readonly FakeSession[];
}

/** A small deterministic generator (an LCG), so every case is the same on every run. */
function rng(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % n;
  };
}

function pick<T>(items: readonly T[], next: (n: number) => number): T {
  const item = items[next(items.length)];
  if (item === undefined) throw new Error('empty choice');
  return item;
}

/** A random run set around the window's edge, over three directories (one of them none), with damaged and newer logs. */
function randomWorld(seed: number): { runs: FakeRun[]; sessions: FakeSession[] } {
  const next = rng(seed);
  const ages = [
    0,
    1,
    SINCE - NOW - 1,
    SINCE - NOW,
    SINCE - NOW + 1,
    -1_000,
    -3 * 86_400_000,
    -30 * 86_400_000,
  ];
  // `''` stands for a run that recorded no project.
  const roots = [HERE, HERE, '/work/elsewhere', `${HERE}/sub`, ''] as const;
  // Every fifth world is dense and leans to Attention (more paused runs than the eight parked rows, more failed runs than a list loads).
  const dense = seed % 5 === 0;
  const runCount = dense ? 60 + next(60) : next(45);
  const statuses: readonly RunStatus[] = dense
    ? [...STATUSES, 'paused', 'paused', 'failed', 'failed']
    : STATUSES;
  const fakeRuns: FakeRun[] = [];
  for (let index = 0; index < runCount; index++) {
    const roll = next(10);
    const root = pick(roots, next);
    fakeRuns.push({
      id: `r${String(index).padStart(3, '0')}`,
      workflowId: `wf${String(next(3))}`,
      projectRoot: root === '' ? undefined : root,
      status: pick(statuses, next),
      // Shared milliseconds on purpose: the order's id tiebreak is exercised.
      createdAt: NOW + pick(ages, next) - next(3),
      deleted: next(12) === 0,
      log: roll === 0 ? 'corrupt' : roll === 1 ? 'newer' : 'ok',
    });
  }
  const sessions: FakeSession[] = [];
  for (let index = 0; index < next(20); index++) {
    sessions.push({
      id: `s${String(index).padStart(3, '0')}`,
      workingDir: pick([HERE, HERE, '/work/elsewhere'], next),
      updatedAt: NOW - next(5) * 1_000,
      deleted: next(10) === 0,
    });
  }
  return { runs: fakeRuns, sessions };
}

function matches(run: FakeRun, filter: RunSummaryFilter): boolean {
  if (run.deleted) return false;
  if (filter.status !== undefined && run.status !== filter.status) return false;
  if (filter.projectRoot !== undefined && run.projectRoot !== filter.projectRoot) return false;
  if (filter.workflowId !== undefined && run.workflowId !== filter.workflowId) return false;
  if (filter.since !== undefined && run.createdAt < filter.since) return false;
  if (filter.exceptStatus !== undefined && run.status === filter.exceptStatus) return false;
  if (
    filter.failedOnlyBefore !== undefined &&
    run.status === 'failed' &&
    run.createdAt >= filter.failedOnlyBefore
  )
    return false;
  return true;
}

const newestFirst = (a: FakeRun, b: FakeRun): number =>
  b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

function summary(run: FakeRun): RunSummaryRecord {
  return {
    id: run.id,
    workflowId: run.workflowId,
    status: run.status,
    executionMode: 'local',
    triggerType: 'manual',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: new Date(run.createdAt).toISOString(),
    updatedAt: new Date(run.createdAt).toISOString(),
    ...(run.projectRoot === undefined ? {} : { projectRoot: run.projectRoot }),
  };
}

/** The reads the Home store and the controller's parked rows make, over `world`, with the db's semantics; every log read is counted. */
function fakeReader(world: {
  readonly runs: readonly FakeRun[];
}): Pick<
  RunHistoryReader,
  | 'listRunSummaries'
  | 'countRunSummaries'
  | 'loadRunStateEvents'
  | 'loadWorkflowSlugs'
  | 'visitRunEventsForReplay'
  | 'loadRunDetail'
> & { readonly logReads: () => number } {
  let logReads = 0;
  const byId = new Map(world.runs.map((run) => [run.id, run]));
  const readLog = (runId: string, strict: boolean): void => {
    logReads += 1;
    const run = byId.get(runId);
    if (run?.log === 'corrupt') throw new CorruptRunEventError(runId, 1, 'node:started', undefined);
    if (strict && run?.log === 'newer') throw new UnreadableRunEventLogError(runId, [2]);
  };
  return {
    logReads: () => logReads,
    listRunSummaries: (opts) => {
      if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 200)
        throw new Error(`limit ${String(opts.limit)} is refused`);
      const before = opts.before;
      return world.runs
        .filter((run) => matches(run, opts))
        .filter(
          (run) =>
            before === undefined ||
            run.createdAt < before.createdAt ||
            (run.createdAt === before.createdAt && run.id < before.id),
        )
        .sort(newestFirst)
        .slice(0, opts.limit)
        .map(summary);
    },
    countRunSummaries: (filter) => {
      // The Runs total is every run less the two Attention counts: a count by the Runs section's own filter would check the status on
      // every run of the directory's history (MVP-11 unit 7 round 2), so this store refuses one, and the totals below must still be exact.
      if (filter.exceptStatus !== undefined || filter.failedOnlyBefore !== undefined)
        throw new Error('the Runs section is never counted by its own filter');
      return world.runs.filter((run) => matches(run, filter)).length;
    },
    loadRunStateEvents: (runId) => {
      readLog(runId, false);
      return [];
    },
    visitRunEventsForReplay: (runId) => {
      readLog(runId, true);
      const run = byId.get(runId);
      return run === undefined ? undefined : summary(run);
    },
    loadWorkflowSlugs: (ids) => new Map(ids.map((id) => [id, `slug-${id}`])),
    loadRunDetail: () => undefined,
  };
}

function fakeSessions(world: {
  readonly sessions: readonly FakeSession[];
}): Pick<SessionStore, 'listSessions' | 'countSessions' | 'loadSessionCostBreakdown'> {
  const live = (dir: string | undefined): FakeSession[] =>
    world.sessions
      .filter((s) => !s.deleted && (dir === undefined || s.workingDir === dir))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
  const record = (s: FakeSession): AgentSessionRecord => ({
    id: s.id,
    agentSlug: `agent-${s.id.slice(-1)}`,
    context: { workingDir: s.workingDir, fsScopeTier: 'sandboxed' },
    status: 'active',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    totalConservativeMicrocents: 0,
    createdAt: new Date(s.updatedAt).toISOString(),
    updatedAt: new Date(s.updatedAt).toISOString(),
  });
  return {
    listSessions: (opts) =>
      live(opts?.workingDir)
        .slice(0, opts?.limit ?? Number.POSITIVE_INFINITY)
        .map(record),
    countSessions: (opts) => live(opts.workingDir).length,
    loadSessionCostBreakdown: () => ({
      totalCostMicrocents: 0,
      rows: [],
      coverage: UNVERIFIED_USAGE,
      models: [],
    }),
  };
}

/** What this directory holds, written out from the world (not read back through the store). */
function expectedSets(world: { readonly runs: readonly FakeRun[] }): {
  readonly paused: ReadonlySet<string>;
  readonly failedInWindow: ReadonlySet<string>;
  readonly runsSection: ReadonlySet<string>;
} {
  const here = world.runs.filter((run) => !run.deleted && run.projectRoot === HERE);
  return {
    paused: new Set(here.filter((run) => run.status === 'paused').map((run) => run.id)),
    failedInWindow: new Set(
      here.filter((run) => run.status === 'failed' && run.createdAt >= SINCE).map((run) => run.id),
    ),
    runsSection: new Set(
      here
        .filter(
          (run) => run.status !== 'paused' && !(run.status === 'failed' && run.createdAt >= SINCE),
        )
        .map((run) => run.id),
    ),
  };
}

/** The rows each section can show: Attention is the controller's parked rows, the unreadable runs and the failed runs. */
function sectionRows(
  snapshot: HomeSnapshot,
  parked: readonly { readonly runId: string }[],
): { readonly attention: readonly string[]; readonly sessions: number; readonly runs: number } {
  return {
    attention: [
      ...parked.map((row) => row.runId),
      ...snapshot.unreadableRuns.map((run) => run.runId),
      ...snapshot.failedRuns.map((run) => run.runId),
    ],
    sessions: snapshot.recentSessions.length,
    runs: snapshot.recentRuns.length,
  };
}

/** Rows shown + `N more` = the total for every cap: N is never negative, and a section that shows all it loaded and has loaded all says 0. */
function expectOverflowTrue(total: number, available: number, label: string): void {
  for (let cap = 0; cap <= available + 2; cap++) {
    const shown = Math.min(cap, available);
    const more = total - shown;
    expect(more, `${label}: cap ${String(cap)}`).toBeGreaterThanOrEqual(0);
    expect(shown + more, `${label}: cap ${String(cap)}`).toBe(total);
  }
}

type Sets = ReturnType<typeof expectedSets>;

/** Every run is placed once, each where its status and age say, and an unreadable run nowhere but among the unreadable rows. */
function expectPlacedOnce(
  snapshot: HomeSnapshot,
  parked: readonly { readonly runId: string }[],
  sets: Sets,
  label: string,
): void {
  const rows = sectionRows(snapshot, parked);
  // Exactly once: no run is in two places, and every listed run is this directory's.
  const listed = [...rows.attention, ...snapshot.recentRuns.map((run) => run.runId)];
  expect(new Set(listed).size, label).toBe(listed.length);
  const here = (id: string): boolean =>
    sets.paused.has(id) || sets.failedInWindow.has(id) || sets.runsSection.has(id);
  expect(
    listed.filter((id) => !here(id)),
    label,
  ).toEqual([]);
  // A paused run is never a failed or a recent run; a failed run of the window is never a recent run.
  expect(
    snapshot.recentRuns.filter((run) => !sets.runsSection.has(run.runId)),
    label,
  ).toEqual([]);
  expect(
    snapshot.failedRuns.filter((run) => !sets.failedInWindow.has(run.runId)),
    label,
  ).toEqual([]);
  // An unreadable run is an unreadable row only: never also a parked, failed or recent row.
  const unreadable = new Set(snapshot.unreadableRuns.map((run) => run.runId));
  const drawn = [
    ...parked.map((row) => row.runId),
    ...snapshot.failedRuns.map((run) => run.runId),
    ...snapshot.recentRuns.map((run) => run.runId),
  ];
  expect(
    drawn.filter((id) => unreadable.has(id)),
    label,
  ).toEqual([]);
}

/** The totals, written out from the world: the runs of the Runs section found unreadable move to Attention. */
function expectTotals(snapshot: HomeSnapshot, world: World, sets: Sets, label: string): number {
  const moved = snapshot.unreadableRuns.filter((run) => sets.runsSection.has(run.runId)).length;
  expect(snapshot.totals, label).toEqual({
    attention: sets.paused.size + sets.failedInWindow.size + moved,
    sessions: world.sessions.filter((s) => !s.deleted && s.workingDir === HERE).length,
    runs: sets.runsSection.size - moved,
  });
  return moved;
}

/** Which of the cases a property must hold over this world reached (so a generator that never reaches one is seen). */
function casesReached(
  snapshot: HomeSnapshot,
  world: World,
  sets: Sets,
  moved: number,
): readonly string[] {
  const cases: [string, boolean][] = [
    ['movedToAttention', moved > 0],
    ['unreadablePaused', snapshot.unreadableRuns.some((run) => run.status === 'paused')],
    ['unreadableFailed', snapshot.unreadableRuns.some((run) => sets.failedInWindow.has(run.runId))],
    [
      'failedOnTheEdge',
      world.runs.some((run) => run.projectRoot === HERE && run.createdAt === SINCE),
    ],
    ['oldFailedAsRun', snapshot.recentRuns.some((run) => run.status === 'failed')],
    ['morePausedThanParked', sets.paused.size > PARKED_RUNS_MAX],
    ['otherDirectoryRuns', world.runs.some((run) => run.projectRoot !== HERE)],
  ];
  return cases.filter(([, hit]) => hit).map(([name]) => name);
}

describe('the Home’s totals over random run sets (fake store, fixed seeds)', () => {
  it('every run of this directory is counted once, nothing else is counted, and no section loads more than its total', () => {
    // How often each case came up across the seeds: a generator that never reached one would make the property vacuous for it.
    const reached = new Map<string, number>();
    for (let seed = 1; seed <= 300; seed++) {
      const world = randomWorld(seed);
      const reader = fakeReader(world);
      const limit = 1 + (seed % (DEFAULT_HOME_LIMIT + 2));
      const snapshot = buildHomeSnapshot({
        sessions: fakeSessions(world),
        runs: reader,
        projectRoot: HERE,
        workingDir: HERE,
        now: () => NOW,
        limit,
      });
      // The controller's own parked rows, read the way the Home reads them, from the same store.
      const parked = readParkedRuns(reader, HERE);
      const sets = expectedSets(world);
      const label = `seed ${String(seed)}, limit ${String(limit)}`;
      expectPlacedOnce(snapshot, parked, sets, label);
      const moved = expectTotals(snapshot, world, sets, label);
      const rows = sectionRows(snapshot, parked);
      expectOverflowTrue(snapshot.totals.attention, rows.attention.length, `${label} attention`);
      expectOverflowTrue(snapshot.totals.sessions, rows.sessions, `${label} sessions`);
      expectOverflowTrue(snapshot.totals.runs, rows.runs, `${label} runs`);
      expect(snapshot.isEmpty, label).toBe(
        snapshot.totals.attention + snapshot.totals.sessions + snapshot.totals.runs === 0,
      );
      for (const name of casesReached(snapshot, world, sets, moved))
        reached.set(name, (reached.get(name) ?? 0) + 1);
    }
    for (const name of [
      'movedToAttention',
      'unreadablePaused',
      'unreadableFailed',
      'failedOnTheEdge',
      'oldFailedAsRun',
      'morePausedThanParked',
      'otherDirectoryRuns',
    ])
      expect(reached.get(name) ?? 0, `the generator reached "${name}"`).toBeGreaterThan(3);
  });

  it('with every row loaded, each section’s rows are exactly its total (the counts are what the lists would hold if unbounded)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const world = randomWorld(seed);
      const reader = fakeReader(world);
      const snapshot = buildHomeSnapshot({
        sessions: fakeSessions(world),
        runs: reader,
        projectRoot: HERE,
        workingDir: HERE,
        now: () => NOW,
        limit: HOME_LIMIT_MAX,
      });
      // Every parked run of this directory, unbounded (the controller keeps eight; here the comparison wants them all).
      const allParked = readProjectRunGates(reader, HERE).runs.filter((run) => !run.degraded);
      const rows = sectionRows(snapshot, allParked);
      const label = `seed ${String(seed)}`;
      expect(rows.attention.length, label).toBe(snapshot.totals.attention);
      expect(rows.sessions, label).toBe(snapshot.totals.sessions);
      expect(rows.runs, label).toBe(snapshot.totals.runs);
    }
  });

  it('the totals do not depend on the loaded limit: sessions never, Attention + Runs never, and the split only by the unreadable runs found', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const world = randomWorld(seed);
      const at = (limit: number): HomeSnapshot =>
        buildHomeSnapshot({
          sessions: fakeSessions(world),
          runs: fakeReader(world),
          projectRoot: HERE,
          workingDir: HERE,
          now: () => NOW,
          limit,
        });
      const whole = at(HOME_LIMIT_MAX);
      for (const limit of [1, 2, 3, DEFAULT_HOME_LIMIT]) {
        const part = at(limit);
        const label = `seed ${String(seed)}, limit ${String(limit)}`;
        expect(part.totals.sessions, label).toBe(whole.totals.sessions);
        expect(part.totals.attention + part.totals.runs, label).toBe(
          whole.totals.attention + whole.totals.runs,
        );
        const healthyWorld = world.runs.every((run) => run.log === 'ok');
        if (healthyWorld) expect(part.totals, label).toEqual(whole.totals);
      }
    }
  });

  it('one Home limit: the parked rows and the work page’s Attention cap are the store’s eight, not three eights that happen to agree', () => {
    // The parked rows take the store's constant (one source); the work page's cap lives in a fenced data module that does not import the
    // store, so it is tied here: the work page shows at most as many Attention rows as one list of the store loads.
    expect(PARKED_RUNS_MAX).toBe(DEFAULT_HOME_LIMIT);
    expect(ATTENTION_ROWS_MAX).toBe(DEFAULT_HOME_LIMIT);
  });

  it('the parked rows the controller shows and the paused runs the store probes are the same runs (both read the newest eight)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const world = randomWorld(seed);
      const reader = fakeReader(world);
      const snapshot = buildHomeSnapshot({
        sessions: fakeSessions(world),
        runs: reader,
        projectRoot: HERE,
        workingDir: HERE,
        now: () => NOW,
      });
      const parked = readParkedRuns(reader, HERE).map((row) => row.runId);
      const probedUnreadable = snapshot.unreadableRuns
        .filter((run) => run.status === 'paused')
        .map((run) => run.runId);
      const newestPaused = world.runs
        .filter((run) => !run.deleted && run.projectRoot === HERE && run.status === 'paused')
        .sort(newestFirst)
        .slice(0, PARKED_RUNS_MAX)
        .map((run) => run.id);
      expect([...parked, ...probedUnreadable].sort(), `seed ${String(seed)}`).toEqual(
        [...newestPaused].sort(),
      );
    }
  });
});

describe('the Home’s totals over a real history.db file', () => {
  it('counts equal what the unbounded lists hold, every run once, on the real store', () => {
    const root = mkdtempSync(join(tmpdir(), 'relavium-home-totals-'));
    const client = createClient(join(root, 'history.db'));
    try {
      runMigrations(client.db, { dbPath: client.path });
      client.db
        .insert(workflows)
        .values({
          id: 'wf',
          name: 'wf',
          slug: 'wf',
          definition: '{}',
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
      const world = randomWorld(4242);
      // A fixed spread on top of the random one, so the real file always holds every case at least once.
      const fixed: FakeRun[] = [
        {
          id: 'z-paused',
          workflowId: 'wf',
          projectRoot: HERE,
          status: 'paused',
          createdAt: NOW - 5,
          deleted: false,
          log: 'ok',
        },
        {
          id: 'z-paused-bad',
          workflowId: 'wf',
          projectRoot: HERE,
          status: 'paused',
          createdAt: NOW - 6,
          deleted: false,
          log: 'corrupt',
        },
        {
          id: 'z-edge',
          workflowId: 'wf',
          projectRoot: HERE,
          status: 'failed',
          createdAt: SINCE,
          deleted: false,
          log: 'ok',
        },
        {
          id: 'z-old-failed',
          workflowId: 'wf',
          projectRoot: HERE,
          status: 'failed',
          createdAt: SINCE - 1,
          deleted: false,
          log: 'ok',
        },
        {
          id: 'z-newer',
          workflowId: 'wf',
          projectRoot: HERE,
          status: 'completed',
          createdAt: NOW - 7,
          deleted: false,
          log: 'newer',
        },
        {
          id: 'z-there',
          workflowId: 'wf',
          projectRoot: '/work/elsewhere',
          status: 'failed',
          createdAt: NOW - 8,
          deleted: false,
          log: 'ok',
        },
        {
          id: 'z-none',
          workflowId: 'wf',
          projectRoot: undefined,
          status: 'paused',
          createdAt: NOW - 9,
          deleted: false,
          log: 'ok',
        },
      ];
      const all = [...world.runs.map((run) => ({ ...run, workflowId: 'wf' })), ...fixed];
      client.db.transaction((tx) => {
        for (const run of all) {
          tx.insert(runs)
            .values({
              id: run.id,
              workflowId: 'wf',
              workflowDefinitionSnapshot: '{}',
              projectRoot: run.projectRoot ?? null,
              status: run.status,
              ...(run.deleted ? { deletedAt: NOW } : {}),
              createdAt: run.createdAt,
              updatedAt: run.createdAt,
            })
            .run();
          if (run.log !== 'ok')
            tx.insert(runEvents)
              .values({
                id: `ev-${run.id}`,
                runId: run.id,
                seq: 1,
                eventType: run.log === 'corrupt' ? 'node:started' : 'future:usage',
                payloadJson: JSON.stringify(
                  run.log === 'corrupt'
                    ? { type: 'node:started', nodeId: 42 }
                    : {
                        type: 'future:usage',
                        runId: run.id,
                        sequenceNumber: 1,
                        timestamp: new Date(NOW).toISOString(),
                      },
                ),
                ts: NOW,
              })
              .run();
        }
      });
      const sessionStore = createSessionStore(client.db);
      for (const s of world.sessions)
        sessionStore.createSession({
          id: s.id,
          agentSlug: 'chatter',
          context: { workingDir: s.workingDir, fsScopeTier: 'sandboxed' },
          status: 'active',
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCostMicrocents: 0,
          totalConservativeMicrocents: 0,
          createdAt: new Date(NOW).toISOString(),
          updatedAt: new Date(s.updatedAt).toISOString(),
          ...(s.deleted ? { deletedAt: new Date(NOW).toISOString() } : {}),
        });

      const reader = createRunHistoryReader(client.db);
      const snapshot = buildHomeSnapshot({
        sessions: sessionStore,
        runs: reader,
        projectRoot: HERE,
        workingDir: HERE,
        now: () => NOW,
        limit: HOME_LIMIT_MAX,
      });
      const sets = expectedSets({ runs: all });
      const allParked = readProjectRunGates(reader, HERE).runs.filter((run) => !run.degraded);
      const rows = sectionRows(snapshot, allParked);
      expect(new Set(rows.attention).size).toBe(rows.attention.length);
      expect(rows.attention.length).toBe(snapshot.totals.attention);
      expect(snapshot.recentRuns.length).toBe(snapshot.totals.runs);
      expect(snapshot.recentSessions.length).toBe(snapshot.totals.sessions);
      // The arithmetic against the world, and the fixed cases where they land.
      const moved = snapshot.unreadableRuns.filter((run) => sets.runsSection.has(run.runId)).length;
      expect(snapshot.totals).toEqual({
        attention: sets.paused.size + sets.failedInWindow.size + moved,
        sessions: world.sessions.filter((s) => !s.deleted && s.workingDir === HERE).length,
        runs: sets.runsSection.size - moved,
      });
      // The Runs total is a difference of three counts; SQLite counting the Runs section's own filter on the same file says the same.
      expect(snapshot.totals.runs + moved).toBe(
        reader.countRunSummaries({
          projectRoot: HERE,
          exceptStatus: 'paused',
          failedOnlyBefore: SINCE,
        }),
      );
      const reasons = new Map(snapshot.unreadableRuns.map((run) => [run.runId, run.reason]));
      expect(reasons.get('z-paused-bad')).toBe('corrupt-row');
      expect(reasons.get('z-newer')).toBe('newer-version');
      expect(allParked.map((run) => run.runId)).toContain('z-paused');
      expect(snapshot.failedRuns.map((run) => run.runId)).toContain('z-edge');
      expect(snapshot.recentRuns.map((run) => run.runId)).toContain('z-old-failed');
      const everyId = [...rows.attention, ...snapshot.recentRuns.map((run) => run.runId)];
      for (const away of ['z-there', 'z-none']) expect(everyId).not.toContain(away);
    } finally {
      client.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
