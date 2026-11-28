import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CorruptRunEventError,
  createClient,
  createRunHistoryReader,
  createRunHistoryStore,
  createSessionStore,
  isRunHistoryReadError,
  runEvents,
  runMigrations,
  runs,
  SessionDiscoveryBoundaryError,
  UnreadableRunEventLogError,
  workflows,
  type DbClient,
} from '@relavium/db';
import { SessionContextSchema, type AgentSessionRecord } from '@relavium/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatCostShort } from '../render/tui/format.js';
import { seedRun, type SeedRunOptions } from '../test-support.js';
import {
  ATTENTION_FAILED_WINDOW_MS,
  buildHomeSnapshot,
  createHomeStore,
  DEFAULT_HOME_LIMIT,
  HOME_LIMIT_MAX,
  unreadableReasonOf,
  type HomeStoreDeps,
} from './home-store.js';

/** The directory the Home is opened in: the sessions' working directory and the runs' project root. */
const HERE = '/workspace';
const CTX = SessionContextSchema.parse({ workingDir: HERE, fsScopeTier: 'sandboxed' });
const ISO = (ms: number): string => new Date(ms).toISOString();
const T0 = 1_750_000_000_000;
/** The Home's clock: a minute after the seeded runs, so a failed run seeded around `T0` is inside the window. */
const NOW = T0 + 60_000;
const DAY = 86_400_000;

describe('buildHomeSnapshot (2.5.B Home aggregation; MVP-11 unit 7: this directory, true totals)', () => {
  let client: DbClient;
  let deps: HomeStoreDeps;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    deps = {
      sessions: createSessionStore(client.db),
      runs: createRunHistoryReader(client.db),
      projectRoot: HERE,
      workingDir: HERE,
      now: () => NOW,
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    client.sqlite.close();
  });

  /** Record `root` as the project `runId` was started in (a column the seeding helper does not set). */
  const recordProject = (runId: string, root: string | null): void => {
    client.db.update(runs).set({ projectRoot: root }).where(eq(runs.id, runId)).run();
  };
  /** Seed a run started in `root` (this Home's directory unless told otherwise). */
  const seed = async (opts: SeedRunOptions, root: string | null = HERE): Promise<void> => {
    await seedRun(client.db, opts);
    recordProject(opts.runId, root);
  };
  /** Append one stored row to a run's log: a damaged one (`corrupt`) or one a newer version wrote (`future`). */
  const damage = (runId: string, kind: 'corrupt' | 'future', seq = 900): void => {
    client.db
      .insert(runEvents)
      .values({
        id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
        runId,
        seq,
        eventType: kind === 'corrupt' ? 'node:started' : 'future:usage',
        payloadJson: JSON.stringify(
          kind === 'corrupt'
            ? { type: 'node:started', nodeId: 42 }
            : { type: 'future:usage', runId, sequenceNumber: seq, timestamp: ISO(T0) },
        ),
        ts: T0,
      })
      .run();
  };

  const session = (overrides: Partial<AgentSessionRecord>): AgentSessionRecord => ({
    id: 'sess',
    agentSlug: 'chatter',
    context: CTX,
    status: 'active',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    totalConservativeMicrocents: 0,
    createdAt: ISO(T0),
    updatedAt: ISO(T0),
    ...overrides,
  });

  it('isolates a future discriminator discovered by strict coverage while retaining healthy Home rows', async () => {
    await seed({ slug: 'healthy', runId: 'healthy', state: 'running', atMs: T0 });
    await seed({ slug: 'future', runId: 'future', state: 'running', atMs: T0 + 1 });
    damage('future', 'future');
    const snapshot = buildHomeSnapshot(deps);
    expect(snapshot.recentRuns.map((run) => run.runId)).toEqual(['healthy']);
    // The run is named by what its listing row says, and WHY in the closed vocabulary: written by a newer version.
    expect(snapshot.unreadableRuns).toEqual([
      {
        runId: 'future',
        workflowSlug: 'future',
        status: 'running',
        createdAt: ISO(T0 + 1),
        reason: 'newer-version',
      },
    ]);
    expect(snapshot.failedRuns).toEqual([]);
    // It is one Attention item and no longer a run of the Runs section.
    expect(snapshot.totals).toEqual({ attention: 1, sessions: 0, runs: 1 });
    expect(snapshot.isEmpty).toBe(false);
  });

  it('is empty (first-run welcome path) on a fresh db, with every total zero', () => {
    const snap = buildHomeSnapshot(deps);
    expect(snap.isEmpty).toBe(true);
    expect(snap.recentSessions).toEqual([]);
    expect(snap.recentRuns).toEqual([]);
    expect(snap.failedRuns).toEqual([]);
    expect(snap.recentAgents).toEqual([]);
    expect(snap.unreadableRuns).toEqual([]);
    expect(snap.totals).toEqual({ attention: 0, sessions: 0, runs: 0 });
  });

  it('counts a paused run and a failed run of the window under Attention, labels rows by workflow slug, and lists the rest as Runs', async () => {
    await seed({
      slug: 'deploy',
      runId: 'run-paused',
      state: 'paused',
      atMs: T0 + 3_000,
      gate: { gateId: 'g1', gateType: 'approval', message: 'ship it?' },
    });
    await seed({ slug: 'nightly', runId: 'run-failed', state: 'failed', atMs: T0 + 2_000 });
    await seed({ slug: 'backup', runId: 'run-ok', state: 'completed', atMs: T0 + 1_000 });

    const snap = buildHomeSnapshot(deps);

    // Exact row (not objectContaining) so a dropped/mis-mapped createdAt or cost projection is caught.
    expect(snap.failedRuns).toEqual([
      {
        runId: 'run-failed',
        workflowSlug: 'nightly',
        status: 'failed',
        createdAt: ISO(T0 + 2_000),
        startedAt: ISO(T0 + 2_000),
        completedAt: ISO(T0 + 2_000),
        totalCostMicrocents: 100,
        usageCoverage: { unverified: true, pendingInvocations: 0, unknownCalls: 0 },
        unpricedCalls: 0,
      },
    ]);
    // The completed run is the only Runs row — the failed + paused runs are Attention, not here.
    expect(snap.recentRuns).toEqual([
      {
        runId: 'run-ok',
        workflowSlug: 'backup',
        status: 'completed',
        createdAt: ISO(T0 + 1_000),
        startedAt: ISO(T0 + 1_000),
        completedAt: ISO(T0 + 1_000),
        totalCostMicrocents: 100,
        usageCoverage: { unverified: true, pendingInvocations: 0, unknownCalls: 0 },
        unpricedCalls: 0,
      },
    ]);
    // The paused run is the parked row's (the controller reads it); here it is counted, once.
    expect(snap.totals).toEqual({ attention: 2, sessions: 0, runs: 1 });
    expect(snap.unreadableRuns).toEqual([]);
    expect(snap.isEmpty).toBe(false);
  });

  it('never repeats a failed run in the Runs list (it lives only in Attention)', async () => {
    await seed({ slug: 'a', runId: 'run-bad', state: 'failed', atMs: T0 + 2_000 });
    await seed({ slug: 'a', runId: 'run-good', state: 'completed', atMs: T0 + 1_000 });

    const snap = buildHomeSnapshot(deps);
    expect(snap.failedRuns.map((r) => r.runId)).toEqual(['run-bad']);
    expect(snap.recentRuns.map((r) => r.runId)).toEqual(['run-good']); // NOT run-bad
  });

  it('counts a paused run of every kind (human gate, budget, media) under Attention and never lists it as a run', async () => {
    await seed({
      slug: 'a',
      runId: 'run-budget',
      state: 'paused',
      atMs: T0 + 1_000,
      budgetGateId: 'b1',
    });
    await seed({
      slug: 'a',
      runId: 'run-both',
      state: 'paused',
      atMs: T0 + 2_000,
      budgetGateId: 'b2',
      gate: { gateId: 'g1', gateType: 'approval', message: 'ship it?' },
    });
    await seed({ slug: 'a', runId: 'run-media', state: 'paused', atMs: T0 + 3_000 });

    const snap = buildHomeSnapshot(deps);
    expect(snap.recentRuns).toEqual([]);
    expect(snap.failedRuns).toEqual([]);
    expect(snap.totals).toEqual({ attention: 3, sessions: 0, runs: 0 });
    expect(snap.isEmpty).toBe(false);
  });

  it('a paused run beyond the loaded limit is still counted, and still never a run', async () => {
    for (const [i, id] of ['p-0', 'p-1', 'p-2'].entries()) {
      await seed({
        slug: `wf-${i}`,
        runId: id,
        state: 'paused',
        atMs: T0 + (i + 1) * 1_000,
        gate: { gateId: `g-${i}`, gateType: 'approval', message: 'ok?' },
      });
    }
    const snap = buildHomeSnapshot({ ...deps, limit: 2 });
    expect(snap.recentRuns).toEqual([]);
    expect(snap.totals.attention, 'the total is not the loaded limit').toBe(3);
  });

  it('renders a run whose workflow is soft-deleted with workflowSlug undefined (still surfaced)', async () => {
    await seed({ slug: 'gone', runId: 'run-orphan', state: 'completed', atMs: T0 + 1_000 });
    // Soft-delete the workflow row — its run stays, but the slug lookup drops it, so the row renders unlabeled rather than vanishing.
    client.db.update(workflows).set({ deletedAt: T0 }).where(eq(workflows.slug, 'gone')).run();

    const [row] = buildHomeSnapshot(deps).recentRuns;
    expect(row?.runId).toBe('run-orphan');
    expect(row?.workflowSlug).toBeUndefined();
    expect(row?.status).toBe('completed');
  });

  it('the Runs list fills past newer Attention runs, newest first, and each list is bounded by the limit', async () => {
    await seed({ slug: 'a', runId: 'fail-2', state: 'failed', atMs: T0 + 4_000 });
    await seed({ slug: 'b', runId: 'fail-1', state: 'failed', atMs: T0 + 3_000 });
    await seed({ slug: 'b', runId: 'ok-new', state: 'completed', atMs: T0 + 2_000 });
    await seed({ slug: 'a', runId: 'ok-old', state: 'completed', atMs: T0 + 1_000 });

    const snap = buildHomeSnapshot({ ...deps, limit: 2 });
    expect(snap.recentRuns.map((r) => r.runId)).toEqual(['ok-new', 'ok-old']);
    expect(snap.failedRuns.map((r) => r.runId)).toEqual(['fail-2', 'fail-1']);
  });

  it('a failed run beyond the loaded limit never leaks into the Runs list, and the totals still count it', async () => {
    await seed({ slug: 'a', runId: 'fail-3', state: 'failed', atMs: T0 + 3_000 });
    await seed({ slug: 'a', runId: 'fail-2', state: 'failed', atMs: T0 + 2_500 });
    await seed({ slug: 'a', runId: 'fail-1', state: 'failed', atMs: T0 + 2_000 });
    await seed({ slug: 'a', runId: 'ok-1', state: 'completed', atMs: T0 + 1_000 });

    const snap = buildHomeSnapshot({ ...deps, limit: 2 });
    expect(snap.failedRuns.map((r) => r.runId)).toEqual(['fail-3', 'fail-2']);
    expect(snap.recentRuns.map((r) => r.runId)).toEqual(['ok-1']);
    expect(snap.totals).toEqual({ attention: 3, sessions: 0, runs: 1 });
  });

  it('the Runs list fills when BOTH a failed and a paused run sit above it', async () => {
    await seed({
      slug: 'deploy',
      runId: 'gated',
      state: 'paused',
      atMs: T0 + 4_000,
      gate: { gateId: 'g1', gateType: 'approval', message: 'ship it?' },
    });
    await seed({ slug: 'nightly', runId: 'fail-1', state: 'failed', atMs: T0 + 3_000 });
    await seed({ slug: 'a', runId: 'ok-new', state: 'completed', atMs: T0 + 2_000 });
    await seed({ slug: 'b', runId: 'ok-old', state: 'completed', atMs: T0 + 1_000 });

    const snap = buildHomeSnapshot({ ...deps, limit: 2 });
    expect(snap.failedRuns.map((r) => r.runId)).toEqual(['fail-1']);
    expect(snap.recentRuns.map((r) => r.runId)).toEqual(['ok-new', 'ok-old']);
    expect(snap.totals).toEqual({ attention: 2, sessions: 0, runs: 2 });
  });

  it('trims the Runs list to the limit when more runs exist than it loads, and the total says how many', async () => {
    await seed({ slug: 'a', runId: 'ok-3', state: 'completed', atMs: T0 + 5_000 });
    await seed({ slug: 'a', runId: 'ok-2', state: 'completed', atMs: T0 + 4_000 });
    await seed({ slug: 'a', runId: 'ok-1', state: 'completed', atMs: T0 + 3_000 });
    await seed({ slug: 'a', runId: 'fail-2', state: 'failed', atMs: T0 + 2_000 });
    await seed({ slug: 'a', runId: 'fail-1', state: 'failed', atMs: T0 + 1_000 });

    const snap = buildHomeSnapshot({ ...deps, limit: 2 });
    expect(snap.failedRuns.map((r) => r.runId)).toEqual(['fail-2', 'fail-1']);
    expect(snap.recentRuns.map((r) => r.runId)).toEqual(['ok-3', 'ok-2']);
    expect(snap.totals.runs).toBe(3);
  });

  it('clamps a non-positive limit to 1 and a limit above HOME_LIMIT_MAX to it (the DB ≤0⇒unbounded convention must not leak)', () => {
    const store = createSessionStore(client.db);
    store.createSession(session({ id: 's1', updatedAt: ISO(T0 + 2_000) }));
    store.createSession(session({ id: 's2', updatedAt: ISO(T0 + 1_000) }));
    expect(buildHomeSnapshot({ ...deps, limit: 0 }).recentSessions.map((s) => s.sessionId)).toEqual(
      ['s1'],
    );
    // A limit no page accepts (above the summary page's maximum) is not refused by the Home: it loads the most it can.
    expect(
      buildHomeSnapshot({ ...deps, limit: 10_000 }).recentSessions.map((s) => s.sessionId),
    ).toEqual(['s1', 's2']);
    expect(HOME_LIMIT_MAX * 2).toBeLessThanOrEqual(200);
  });

  it('falls back to the default for an invalid limit (NaN / Infinity / a fraction) — never a broken read', () => {
    const store = createSessionStore(client.db);
    store.createSession(session({ id: 's1', updatedAt: ISO(T0 + 2_000) }));
    store.createSession(session({ id: 's2', updatedAt: ISO(T0 + 1_000) }));
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 2.5]) {
      expect(
        buildHomeSnapshot({ ...deps, limit: bad }).recentSessions.map((s) => s.sessionId),
      ).toEqual(['s1', 's2']);
    }
  });

  it('a running (non-terminal, not parked) run stays a Runs row, never Attention', async () => {
    await seed({ slug: 'a', runId: 'run-live', state: 'running', atMs: T0 + 2_000 });
    await seed({ slug: 'a', runId: 'run-bad', state: 'failed', atMs: T0 + 1_000 });

    const snap = buildHomeSnapshot(deps);
    expect(snap.recentRuns.map((r) => r.runId)).toEqual(['run-live']);
    expect(snap.failedRuns.map((r) => r.runId)).toEqual(['run-bad']);
  });

  it('derives recent agents from the recent sessions — most-recent-first and deduped', () => {
    const store = createSessionStore(client.db);
    store.createSession(session({ id: 's1', agentSlug: 'writer', updatedAt: ISO(T0 + 1_000) }));
    store.createSession(session({ id: 's2', agentSlug: 'coder', updatedAt: ISO(T0 + 3_000) }));
    store.createSession(session({ id: 's3', agentSlug: 'writer', updatedAt: ISO(T0 + 2_000) }));

    const snap = buildHomeSnapshot(deps);
    expect(snap.recentAgents).toEqual([
      { agentSlug: 'coder', lastUsedAt: ISO(T0 + 3_000) },
      { agentSlug: 'writer', lastUsedAt: ISO(T0 + 2_000) },
    ]);
  });

  it('bounds every list to the top-N (indexed `{ limit }`), newest-first, and the session total is not the limit', () => {
    const store = createSessionStore(client.db);
    for (let i = 0; i < 5; i += 1) {
      store.createSession(
        session({ id: `s${i}`, agentSlug: `a${i}`, updatedAt: ISO(T0 + i * 1_000) }),
      );
    }
    const snap = buildHomeSnapshot({ ...deps, limit: 2 });
    expect(snap.recentSessions.map((s) => s.sessionId)).toEqual(['s4', 's3']);
    expect(snap.totals.sessions).toBe(5);
  });

  it('exposes the agent-first session fields (title, agent, status, updatedAt; absent model ⇒ undefined)', () => {
    createSessionStore(client.db).createSession(
      session({ id: 's1', title: 'Plan the launch', agentSlug: 'planner' }),
    );
    const [row] = buildHomeSnapshot(deps).recentSessions;
    // No directory: every session listed is this directory's, and a session row draws none.
    expect(row).toEqual({
      sessionId: 's1',
      title: 'Plan the launch',
      agentSlug: 'planner',
      modelId: undefined,
      status: 'active',
      updatedAt: ISO(T0),
      totalCostMicrocents: 0,
      usageCoverage: { unverified: true, pendingInvocations: 0, unknownCalls: 0 },
      unpricedCalls: 0,
    });
  });

  it('carries the session cost on the row (parity with run rows — the agent-first primary glances with cost)', () => {
    createSessionStore(client.db).createSession(session({ id: 's1', totalCostMicrocents: 4_200 }));
    expect(buildHomeSnapshot(deps).recentSessions[0]?.totalCostMicrocents).toBe(4_200);
  });

  it('createHomeStore.read() re-aggregates fresh (a new session appears on the next read)', () => {
    const store = createHomeStore(deps);
    expect(store.read().isEmpty).toBe(true);
    createSessionStore(client.db).createSession(session({ id: 's1' }));
    expect(store.read().recentSessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(store.read().isEmpty).toBe(false);
    expect(store.read().totals.sessions).toBe(1);
  });

  it('defaults to DEFAULT_HOME_LIMIT when no limit is given', () => {
    const store = createSessionStore(client.db);
    for (let i = 0; i < DEFAULT_HOME_LIMIT + 3; i += 1) {
      store.createSession(
        session({ id: `s${i}`, agentSlug: `a${i}`, updatedAt: ISO(T0 + i * 1_000) }),
      );
    }
    expect(buildHomeSnapshot(deps).recentSessions).toHaveLength(DEFAULT_HOME_LIMIT);
    expect(buildHomeSnapshot(deps).totals.sessions).toBe(DEFAULT_HOME_LIMIT + 3);
  });

  it('names a run whose event log cannot be read instead of showing it as ordinary (#W15-15), with why', async () => {
    // Degrading silently made a damaged run render exactly like a paused run with nothing pending — and the
    // Home is where a user would come to find out WHICH run is broken.
    await seed({ slug: 'demo', runId: 'bad-01', state: 'paused', atMs: T0 });
    damage('bad-01', 'corrupt');

    const snapshot = buildHomeSnapshot(deps);

    expect(snapshot.unreadableRuns).toEqual([
      {
        runId: 'bad-01',
        workflowSlug: 'demo',
        status: 'paused',
        createdAt: ISO(T0),
        reason: 'corrupt-row',
      },
    ]);
    // It is the paused run's ONE Attention item (counted with the paused runs), never also a run.
    expect(snapshot.totals).toEqual({ attention: 1, sessions: 0, runs: 0 });
    // …and NOT the fresh-install welcome: a Home whose only content is a damaged run must not answer "you
    // have nothing", which is this finding in its most misleading form.
    expect(snapshot.isEmpty).toBe(false);
  });

  it('a failed run whose log cannot be read is one Attention item, listed as unreadable and not as a failed row', async () => {
    await seed({ slug: 'nightly', runId: 'fail-ok', state: 'failed', atMs: T0 + 2_000 });
    await seed({ slug: 'nightly', runId: 'fail-bad', state: 'failed', atMs: T0 + 1_000 });
    damage('fail-bad', 'corrupt');

    const snapshot = buildHomeSnapshot(deps);
    expect(snapshot.failedRuns.map((run) => run.runId)).toEqual(['fail-ok']);
    expect(snapshot.unreadableRuns.map((run) => [run.runId, run.reason])).toEqual([
      ['fail-bad', 'corrupt-row'],
    ]);
    expect(snapshot.totals).toEqual({ attention: 2, sessions: 0, runs: 0 });
  });

  describe('a session whose row does not parse', () => {
    /** Three sessions in this directory, the middle one damaged the way a hand edit would: its `context_json` is not JSON. */
    const seedWithOneDamaged = (): void => {
      const sessions = createSessionStore(client.db);
      sessions.createSession(session({ id: 's-old', updatedAt: ISO(T0 + 1_000) }));
      sessions.createSession(session({ id: 's-bad', updatedAt: ISO(T0 + 2_000) }));
      sessions.createSession(session({ id: 's-new', updatedAt: ISO(T0 + 3_000) }));
      client.sqlite
        .prepare("UPDATE agent_sessions SET context_json = 'not json' WHERE id = ?")
        .run('s-bad');
    };

    it('does not throw the Home read out: the row is skipped, counted as unreadable, and the others are listed', () => {
      seedWithOneDamaged();
      const snapshot = buildHomeSnapshot(deps);
      expect(snapshot.recentSessions.map((row) => row.sessionId)).toEqual(['s-new', 's-old']);
      expect(snapshot.unreadableSessions).toBe(1);
      // the total follows the list (rows shown + `N more` = total), and the agents are derived from what could be read
      expect(snapshot.totals.sessions).toBe(2);
      expect(snapshot.isEmpty).toBe(false);
      expect(createHomeStore(deps).read().unreadableSessions).toBe(1);
    });

    it('names nothing on the healthy path (the field is absent, not zero)', () => {
      createSessionStore(client.db).createSession(session({ id: 's-ok' }));
      expect(buildHomeSnapshot(deps)).not.toHaveProperty('unreadableSessions');
    });

    it('a directory whose only session is damaged reads as empty, with the damage counted', () => {
      createSessionStore(client.db).createSession(session({ id: 's-bad' }));
      client.sqlite.prepare("UPDATE agent_sessions SET context_json = 'not json'").run();
      const snapshot = buildHomeSnapshot(deps);
      expect(snapshot.recentSessions).toEqual([]);
      expect(snapshot.unreadableSessions).toBe(1);
      expect(snapshot.totals.sessions).toBe(0);
    });
  });

  describe('this directory only (the maintainer’s ruling: what belongs here is shown, the unrelated is not)', () => {
    it('a run of another project, a run with no project and a session of another directory are in no list and no count', async () => {
      await seed({ slug: 'wf', runId: 'mine', state: 'completed', atMs: T0 + 1 });
      await seed({ slug: 'wf', runId: 'other-ok', state: 'completed', atMs: T0 + 2 }, '/elsewhere');
      await seed({ slug: 'wf', runId: 'other-bad', state: 'failed', atMs: T0 + 3 }, '/elsewhere');
      await seed(
        {
          slug: 'wf',
          runId: 'other-parked',
          state: 'paused',
          atMs: T0 + 4,
          gate: { gateId: 'g', gateType: 'approval', message: 'x' },
        },
        '/elsewhere',
      );
      await seed({ slug: 'wf', runId: 'below', state: 'failed', atMs: T0 + 5 }, `${HERE}/sub`);
      await seed({ slug: 'wf', runId: 'legacy', state: 'failed', atMs: T0 + 6 }, null);
      damage('other-ok', 'corrupt', 901);
      const store = createSessionStore(client.db);
      store.createSession(session({ id: 's-here' }));
      store.createSession(
        session({
          id: 's-there',
          context: SessionContextSchema.parse({
            workingDir: '/elsewhere',
            fsScopeTier: 'sandboxed',
          }),
          updatedAt: ISO(T0 + 9),
        }),
      );

      const snapshot = buildHomeSnapshot(deps);
      const listed = [
        ...snapshot.recentRuns.map((run) => run.runId),
        ...snapshot.failedRuns.map((run) => run.runId),
        ...snapshot.unreadableRuns.map((run) => run.runId),
      ];
      expect(listed).toEqual(['mine']);
      expect(snapshot.recentSessions.map((s) => s.sessionId)).toEqual(['s-here']);
      expect(snapshot.recentAgents).toEqual([{ agentSlug: 'chatter', lastUsedAt: ISO(T0) }]);
      expect(snapshot.totals).toEqual({ attention: 0, sessions: 1, runs: 1 });
    });

    it('a Home with nothing of its own is the empty Home, however much another directory holds', async () => {
      await seed({ slug: 'wf', runId: 'other', state: 'failed', atMs: T0 }, '/elsewhere');
      createSessionStore(client.db).createSession(
        session({
          id: 's-there',
          context: SessionContextSchema.parse({
            workingDir: '/elsewhere',
            fsScopeTier: 'sandboxed',
          }),
        }),
      );
      const snapshot = buildHomeSnapshot(deps);
      expect(snapshot.isEmpty).toBe(true);
      expect(snapshot.totals).toEqual({ attention: 0, sessions: 0, runs: 0 });
    });

    it('reads the runs by the project root a run records and the sessions by the working directory a chat records (as `/resume` does)', async () => {
      // The two spellings of one directory can differ (a symlinked temp directory and its canonical path): each list is read by its own.
      await seed({ slug: 'wf', runId: 'run-here', state: 'completed', atMs: T0 }, '/link/here');
      const store = createSessionStore(client.db);
      store.createSession(
        session({
          id: 's-canonical',
          context: SessionContextSchema.parse({
            workingDir: '/real/here',
            fsScopeTier: 'sandboxed',
          }),
        }),
      );
      const snapshot = buildHomeSnapshot({
        ...deps,
        projectRoot: '/link/here',
        workingDir: '/real/here',
      });
      expect(snapshot.recentRuns.map((run) => run.runId)).toEqual(['run-here']);
      expect(snapshot.recentSessions.map((s) => s.sessionId)).toEqual(['s-canonical']);
      expect(snapshot.totals).toEqual({ attention: 0, sessions: 1, runs: 1 });
      // Swapped, neither list finds anything: the two are not read by one value.
      const swapped = buildHomeSnapshot({
        ...deps,
        projectRoot: '/real/here',
        workingDir: '/link/here',
      });
      expect(swapped.totals).toEqual({ attention: 0, sessions: 0, runs: 0 });
    });

    it('an empty working directory is refused with the session reads’ typed error, before any read', () => {
      const sessions = createSessionStore(client.db);
      const list = vi.fn(sessions.listSessions);
      expect(() =>
        buildHomeSnapshot({
          ...deps,
          sessions: { ...sessions, listSessions: list },
          workingDir: '',
        }),
      ).toThrow(SessionDiscoveryBoundaryError);
      expect(list).not.toHaveBeenCalled();
    });

    it('an empty project root is refused with a typed error: there is no unscoped Home', () => {
      // `projectRoot` is required by the type; a caller in plain JavaScript (or a cwd that came back empty) is refused at the read, never
      // shown every directory's runs as if they were this one's.
      const reader = createRunHistoryReader(client.db);
      const list = vi.fn(reader.listRunSummaries);
      for (const projectRoot of ['', undefined]) {
        let refusal: unknown;
        try {
          buildHomeSnapshot({
            ...deps,
            runs: { ...reader, listRunSummaries: list },
            ...Object.fromEntries([['projectRoot', projectRoot]]),
          });
        } catch (error) {
          refusal = error;
        }
        expect(isRunHistoryReadError(refusal), String(projectRoot)).toBe(true);
        expect(refusal).toMatchObject({ code: 'invalid_filter' });
      }
      expect(list, 'refused before any read').not.toHaveBeenCalled();
    });
  });

  it('a run that changed status between two of the snapshot’s statements is still placed once', async () => {
    // Another terminal fails a run while this snapshot reads: the Runs read (taken later) is handed the run the failed read already
    // placed. It is a failed row, once, and never also a Runs row.
    await seed({ slug: 'wf', runId: 'moving', state: 'failed', atMs: T0 + 2 });
    await seed({ slug: 'wf', runId: 'steady', state: 'completed', atMs: T0 + 1 });
    const reader = createRunHistoryReader(client.db);
    const snapshot = buildHomeSnapshot({
      ...deps,
      runs: {
        ...reader,
        listRunSummaries: (options) => {
          const rows = reader.listRunSummaries(options);
          if (options.exceptStatus !== 'paused') return rows;
          const moved = reader.listRunSummaries({ projectRoot: HERE, status: 'failed', limit: 1 });
          return [...moved.map((run) => ({ ...run, status: 'running' as const })), ...rows];
        },
      },
    });
    expect(snapshot.failedRuns.map((run) => run.runId)).toEqual(['moving']);
    expect(snapshot.recentRuns.map((run) => run.runId)).toEqual(['steady']);
  });

  describe('the failed-run window (ATTENTION_FAILED_WINDOW_MS)', () => {
    it('is seven days', () => {
      expect(ATTENTION_FAILED_WINDOW_MS).toBe(7 * DAY);
    });

    it('a failed run is Attention while it was created within the window (inclusive), and a Runs row once it is older', async () => {
      const since = NOW - ATTENTION_FAILED_WINDOW_MS;
      await seed({ slug: 'wf', runId: 'inside', state: 'failed', atMs: since + 1 });
      await seed({ slug: 'wf', runId: 'edge', state: 'failed', atMs: since });
      await seed({ slug: 'wf', runId: 'outside', state: 'failed', atMs: since - 1 });
      await seed({ slug: 'wf', runId: 'old-ok', state: 'completed', atMs: since - 2 * DAY });

      const snapshot = buildHomeSnapshot(deps);
      expect(snapshot.failedRuns.map((run) => run.runId)).toEqual(['inside', 'edge']);
      // Outside the window it is history: listed as the run it is, with its status word, not dropped.
      expect(snapshot.recentRuns.map((run) => [run.runId, run.status])).toEqual([
        ['outside', 'failed'],
        ['old-ok', 'completed'],
      ]);
      expect(snapshot.totals).toEqual({ attention: 2, sessions: 0, runs: 2 });
    });

    it('is measured against the injected clock, read once per snapshot', async () => {
      await seed({ slug: 'wf', runId: 'f', state: 'failed', atMs: T0 });
      const now = vi.fn(() => T0 + ATTENTION_FAILED_WINDOW_MS + 1);
      const later = buildHomeSnapshot({ ...deps, now });
      expect(later.failedRuns).toEqual([]);
      expect(later.recentRuns.map((run) => run.runId)).toEqual(['f']);
      expect(now).toHaveBeenCalledTimes(1);
    });

    it('a fractional clock is floored to whole milliseconds, never refused as a bound the reader cannot use', async () => {
      // The run created exactly at the floored bound is inside the window (inclusive); the fraction would have made the bound a
      // non-integer, which the reader refuses (`invalid_filter`), and the whole snapshot with it.
      await seed({ slug: 'wf', runId: 'edge', state: 'failed', atMs: T0 });
      await seed({ slug: 'wf', runId: 'before', state: 'failed', atMs: T0 - 1 });
      const snapshot = buildHomeSnapshot({
        ...deps,
        now: () => T0 + ATTENTION_FAILED_WINDOW_MS + 0.75,
      });
      expect(snapshot.failedRuns.map((run) => run.runId)).toEqual(['edge']);
      expect(snapshot.recentRuns.map((run) => run.runId)).toEqual(['before']);
      expect(snapshot.totals).toEqual({ attention: 1, sessions: 0, runs: 1 });
    });

    it('a clock that is not a finite number is refused with the reader’s own error, before any read', () => {
      const reader = createRunHistoryReader(client.db);
      const list = vi.fn(reader.listRunSummaries);
      const count = vi.fn(reader.countRunSummaries);
      for (const clock of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        let refusal: unknown;
        try {
          buildHomeSnapshot({
            ...deps,
            runs: { ...reader, listRunSummaries: list, countRunSummaries: count },
            now: () => clock,
          });
        } catch (error) {
          refusal = error;
        }
        expect(isRunHistoryReadError(refusal), String(clock)).toBe(true);
        expect(refusal).toMatchObject({ code: 'invalid_filter' });
      }
      expect(list, 'refused before any read').not.toHaveBeenCalled();
      expect(count, 'refused before any read').not.toHaveBeenCalled();
    });
  });

  describe('the totals are three counts, none of them a residual filter over the directory’s history', () => {
    it('counts the paused runs, the failed runs of the window and then every run; the Runs total is the difference', async () => {
      await seed({ slug: 'wf', runId: 'p', state: 'paused', atMs: T0 + 3 });
      await seed({ slug: 'wf', runId: 'f', state: 'failed', atMs: T0 + 2 });
      await seed({ slug: 'wf', runId: 'old', state: 'failed', atMs: T0 - 8 * DAY });
      await seed({ slug: 'wf', runId: 'c', state: 'completed', atMs: T0 + 1 });
      const reader = createRunHistoryReader(client.db);
      const count = vi.fn(reader.countRunSummaries);
      const snapshot = buildHomeSnapshot({
        ...deps,
        runs: { ...reader, countRunSummaries: count },
      });
      // Every run of the directory is counted LAST: a run that changes status between the statements is then never subtracted without
      // also being counted, so the difference cannot fall below the truth by it.
      expect(count.mock.calls.map(([filter]) => filter)).toEqual([
        { projectRoot: HERE, status: 'paused' },
        { projectRoot: HERE, status: 'failed', since: NOW - ATTENTION_FAILED_WINDOW_MS },
        { projectRoot: HERE },
      ]);
      expect(snapshot.totals).toEqual({ attention: 2, sessions: 0, runs: 2 });
      // The difference is the Runs section's own filter, counted (the identity the totals rest on).
      expect(snapshot.totals.runs).toBe(
        reader.countRunSummaries({
          projectRoot: HERE,
          exceptStatus: 'paused',
          failedOnlyBefore: NOW - ATTENTION_FAILED_WINDOW_MS,
        }),
      );
    });

    it('the Runs total is never below zero when a counted run leaves before every run is counted (a soft delete between statements)', async () => {
      await seed({ slug: 'wf', runId: 'p', state: 'paused', atMs: T0 + 2 });
      await seed({ slug: 'wf', runId: 'f', state: 'failed', atMs: T0 + 1 });
      const reader = createRunHistoryReader(client.db);
      const snapshot = buildHomeSnapshot({
        ...deps,
        runs: {
          ...reader,
          // The paused run is deleted by another process after it was counted: the last count no longer holds it.
          countRunSummaries: (filter) =>
            reader.countRunSummaries(filter) - (filter.status === undefined ? 1 : 0),
        },
      });
      expect(snapshot.totals).toEqual({ attention: 2, sessions: 0, runs: 0 });
    });
  });

  describe('why a run cannot be read: a closed vocabulary, never an error message', () => {
    it('maps the two per-run log errors to their words and anything else to "could not be read"', () => {
      expect(unreadableReasonOf(new CorruptRunEventError('r', 3, 'node:started', undefined))).toBe(
        'corrupt-row',
      );
      expect(unreadableReasonOf(new UnreadableRunEventLogError('r', [9]))).toBe('newer-version');
      expect(unreadableReasonOf(new Error('a disk said no'))).toBe('could-not-read');
      expect(unreadableReasonOf('not even an error')).toBe('could-not-read');
    });

    it('is total: a value whose type cannot be read without throwing is "could not be read", never a throw', () => {
      const refuse = (): never => {
        throw new Error('this value cannot be inspected');
      };
      // A `code` getter that throws.
      expect(
        unreadableReasonOf(Object.defineProperty(new Error('x'), 'code', { get: refuse })),
      ).toBe('could-not-read');
      // Proxies whose traps throw: the prototype (`instanceof`), the key test (`in`) and the read.
      const target = Object.assign(new Error('x'), { code: 'corrupt_run_event' });
      for (const handler of [
        { getPrototypeOf: refuse },
        { has: refuse },
        { get: refuse },
      ] satisfies ProxyHandler<Error>[])
        expect(unreadableReasonOf(new Proxy(target, handler))).toBe('could-not-read');
    });

    it('a run whose error answers its type once and then throws is named "could not be read", and the snapshot is built', async () => {
      // The per-run read judged each a per-run condition on its first look (a corrupt row, a newer row); reading the type again for the
      // reason throws. That run is an unreadable item with the closed word, and every other run is read as usual.
      await seed({ slug: 'wf', runId: 'paused-1', state: 'paused', atMs: T0 + 3 });
      await seed({ slug: 'wf', runId: 'done-1', state: 'completed', atMs: T0 + 2 });
      await seed({ slug: 'wf', runId: 'done-2', state: 'completed', atMs: T0 + 1 });
      const reader = createRunHistoryReader(client.db);
      /** An error whose `code` answers `code` for the first `answers` reads, and throws after. */
      const fickle = (code: string, answers: number): Error => {
        let reads = 0;
        return Object.defineProperty(new Error('x'), 'code', {
          get: () => {
            reads += 1;
            if (reads <= answers) return code;
            throw new Error('the type cannot be read twice');
          },
        });
      };
      const snapshot = buildHomeSnapshot({
        ...deps,
        runs: {
          ...reader,
          loadRunStateEvents: () => {
            // A getter: the corrupt check reads it once (and degrades); the reason reads it again.
            throw fickle('corrupt_run_event', 1);
          },
          visitRunEventsForReplay: (runId, ...rest) => {
            if (runId !== 'done-1') return reader.visitRunEventsForReplay(runId, ...rest);
            // A Proxy: the corrupt check and the newer-version check each read it once (the second degrades); the reason reads it again.
            const target = Object.assign(new Error('x'), { code: 'unreadable_run_event_log' });
            let reads = 0;
            throw new Proxy(target, {
              get: (inner, key, receiver): unknown => {
                if (key !== 'code') return Reflect.get(inner, key, receiver);
                reads += 1;
                if (reads <= 2) return inner.code;
                throw new Error('the type cannot be read a third time');
              },
            });
          },
        },
      });
      expect(snapshot.unreadableRuns.map((run) => [run.runId, run.reason])).toEqual([
        ['paused-1', 'could-not-read'],
        ['done-1', 'could-not-read'],
      ]);
      expect(snapshot.recentRuns.map((run) => run.runId)).toEqual(['done-2']);
      expect(snapshot.totals).toEqual({ attention: 2, sessions: 0, runs: 1 });
    });

    it('a hostile error message (a path, a secret, a control sequence) never reaches the snapshot', async () => {
      await seed({ slug: 'wf', runId: 'paused-1', state: 'paused', atMs: T0 + 3 });
      await seed({ slug: 'wf', runId: 'failed-1', state: 'failed', atMs: T0 + 2 });
      await seed({ slug: 'wf', runId: 'done-1', state: 'completed', atMs: T0 + 1 });
      const ESC = String.fromCharCode(27);
      const hostile = `/Users/someone/.ssh/id_rsa sk-ant-SECRET-1234 ${ESC}[31mRED`;
      const reader = createRunHistoryReader(client.db);
      const corrupt = (runId: string): never => {
        throw new CorruptRunEventError(runId, 7, hostile, new Error(hostile));
      };
      const snapshot = buildHomeSnapshot({
        ...deps,
        runs: {
          ...reader,
          loadRunStateEvents: (runId) => corrupt(runId),
          visitRunEventsForReplay: (runId) => {
            if (runId === 'failed-1') return corrupt(runId);
            const error = new UnreadableRunEventLogError(runId, [1]);
            error.message = hostile;
            throw error;
          },
        },
      });
      expect(snapshot.unreadableRuns.map((run) => [run.runId, run.reason])).toEqual([
        ['paused-1', 'corrupt-row'],
        ['failed-1', 'corrupt-row'],
        ['done-1', 'newer-version'],
      ]);
      const serialized = JSON.stringify(snapshot);
      for (const fragment of ['id_rsa', 'SECRET', ESC, 'RED', '.ssh'])
        expect(serialized).not.toContain(fragment);
    });

    it('a fault that is not a per-run log error still fails the read: it is never turned into a reason', async () => {
      await seed({ slug: 'wf', runId: 'done-1', state: 'completed', atMs: T0 });
      const reader = createRunHistoryReader(client.db);
      expect(() =>
        buildHomeSnapshot({
          ...deps,
          runs: {
            ...reader,
            visitRunEventsForReplay: () => {
              throw new Error('the database is closed');
            },
          },
        }),
      ).toThrow('the database is closed');
    });
  });

  it('per-run event reads do not grow: one state read per loaded paused run, one usage read per run a list shows or finds unreadable', async () => {
    // The fixed scenario of the W4a probe, run at bb3965c0 against the old unscoped store: 10 state reads and 26 usage reads (36).
    const corruptAt = new Set(['p0', 'p4', 'f3', 'c2']);
    const plan: readonly [string, SeedRunOptions['state'], number, number][] = [
      ['p', 'paused', 10, DAY],
      ['f', 'failed', 12, 2 * DAY],
      ['o', 'failed', 5, 10 * DAY],
      ['c', 'completed', 15, 3 * DAY],
      ['r', 'running', 2, DAY / 2],
    ];
    let seq = 0;
    for (const [prefix, state, count, age] of plan) {
      for (let i = 0; i < count; i++) {
        const runId = `${prefix}${String(i)}`;
        await seed({
          slug: `wf${String(i % 3)}`,
          runId,
          state,
          atMs: NOW - age - i * 1_000,
          ...(state === 'paused'
            ? { gate: { gateId: `g${runId}`, gateType: 'approval' as const, message: 'ok?' } }
            : {}),
        });
        if (corruptAt.has(runId)) damage(runId, 'corrupt', 900 + (seq += 1));
      }
    }
    for (let i = 0; i < 13; i++)
      await seed(
        { slug: 'wf', runId: `x${String(i)}`, state: 'completed', atMs: NOW - DAY / 4 },
        '/elsewhere',
      );

    const reader = createRunHistoryReader(client.db);
    const stateReads = vi.fn(reader.loadRunStateEvents);
    const usageReads = vi.fn(reader.visitRunEventsForReplay);
    const snapshot = buildHomeSnapshot({
      ...deps,
      runs: { ...reader, loadRunStateEvents: stateReads, visitRunEventsForReplay: usageReads },
    });
    // The eight newest paused runs (the parked rows the controller shows) are probed; p0 and p4 cannot be read.
    expect(stateReads).toHaveBeenCalledTimes(DEFAULT_HOME_LIMIT);
    // Failed rows: f0..f8 (f3 cannot be read) = 9; Runs rows: r0, r1, c0..c6 (c2 cannot be read) = 9.
    expect(usageReads).toHaveBeenCalledTimes(18);
    expect(stateReads.mock.calls.length + usageReads.mock.calls.length).toBeLessThanOrEqual(36);
    // Newest first, whichever list found them.
    expect(snapshot.unreadableRuns.map((run) => run.runId)).toEqual(['p0', 'p4', 'f3', 'c2']);
    expect(snapshot.totals).toEqual({ attention: 10 + 12 + 1, sessions: 0, runs: 5 + 15 + 2 - 1 });
  });
});

it('Home qualifies the atomic current amount when another SQLite writer settles after discovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-home-usage-race-'));
  const readerClient = createClient(join(root, 'history.db'));
  const writerClient = createClient(readerClient.path);
  try {
    runMigrations(readerClient.db, { dbPath: readerClient.path });
    let id = 0;
    const writer = createRunHistoryStore(writerClient.db, {
      uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
      now: () => T0,
      workflow: { slug: 'race', name: 'race', definitionJson: '{}' },
      projectRoot: HERE,
    });
    const workflowId = await writer.resolveWorkflowId('race');
    const envelope = { runId: 'race', timestamp: ISO(T0) };
    const invocation = { producerId: 'p', ordinal: 1, dispatchId: 'd', round: 0, chainAttempt: 1 };
    await writer.persistEvent({
      ...envelope,
      type: 'run:started',
      workflowId,
      inputs: {},
      executionMode: 'local',
      sequenceNumber: 0,
    });
    await writer.persistEvent({
      ...envelope,
      type: 'cost:coverage_started',
      basis: 'complete',
      sequenceNumber: 1,
    });
    await writer.persistEvent({
      ...envelope,
      type: 'node:started',
      nodeId: 'n',
      nodeType: 'agent',
      sequenceNumber: 2,
    });
    await writer.persistEvent({
      ...envelope,
      type: 'cost:usage_pending',
      nodeId: 'n',
      model: 'm',
      invocation,
      sequenceNumber: 3,
    });
    const reader = createRunHistoryReader(readerClient.db);
    let discoveredCost: number | undefined;
    let settlement: Promise<void> | undefined;
    const snapshot = buildHomeSnapshot({
      sessions: createSessionStore(readerClient.db),
      projectRoot: HERE,
      workingDir: HERE,
      now: () => NOW,
      runs: {
        ...reader,
        listRunSummaries: (options) => {
          const rows = reader.listRunSummaries(options);
          const discovered = rows.find((row) => row.id === 'race');
          if (discovered !== undefined) discoveredCost = discovered.totalCostMicrocents;
          return rows;
        },
        visitRunEventsForReplay: (...args) => {
          settlement = writer.persistEvent({
            ...envelope,
            type: 'cost:attempt_settled',
            attemptNumber: 1,
            nodeId: 'n',
            model: 'm',
            invocation,
            inputTokens: 10,
            outputTokens: 5,
            costMicrocents: 70_000,
            cumulativeCostMicrocents: 70_000,
            priced: true,
            sequenceNumber: 4,
          });
          expect(writer.loadRun('race')?.totalCostMicrocents).toBe(70_000);
          return reader.visitRunEventsForReplay(...args);
        },
      },
    });
    await settlement;
    expect(discoveredCost).toBe(0);
    const row = snapshot.recentRuns[0];
    expect(row).toMatchObject({
      runId: 'race',
      totalCostMicrocents: 70_000,
      usageCoverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
    });
    if (row === undefined) throw new Error('Home omitted the settled run');
    expect(formatCostShort(row.totalCostMicrocents, row.usageCoverage, row.unpricedCalls)).not.toBe(
      'free',
    );
  } finally {
    writerClient.sqlite.close();
    readerClient.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});
