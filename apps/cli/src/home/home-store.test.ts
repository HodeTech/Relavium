import {
  createClient,
  createRunHistoryReader,
  createSessionStore,
  runMigrations,
  workflows,
  type DbClient,
} from '@relavium/db';
import { SessionContextSchema, type AgentSessionRecord } from '@relavium/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { seedRun } from '../test-support.js';
import {
  buildHomeSnapshot,
  createHomeStore,
  DEFAULT_HOME_LIMIT,
  type HomeStoreDeps,
} from './home-store.js';

const CTX = SessionContextSchema.parse({ workingDir: '/workspace', fsScopeTier: 'sandboxed' });
const ISO = (ms: number): string => new Date(ms).toISOString();
const T0 = 1_750_000_000_000;

describe('buildHomeSnapshot (2.5.B Home aggregation)', () => {
  let client: DbClient;
  let deps: HomeStoreDeps;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    deps = { sessions: createSessionStore(client.db), runs: createRunHistoryReader(client.db) };
  });
  afterEach(() => {
    client.sqlite.close();
  });

  const session = (overrides: Partial<AgentSessionRecord>): AgentSessionRecord => ({
    id: 'sess',
    agentSlug: 'chatter',
    context: CTX,
    status: 'active',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: ISO(T0),
    updatedAt: ISO(T0),
    ...overrides,
  });

  it('is empty (first-run welcome path) on a fresh db', () => {
    const snap = buildHomeSnapshot(deps);
    expect(snap.isEmpty).toBe(true);
    expect(snap.recentSessions).toEqual([]);
    expect(snap.recentRuns).toEqual([]);
    expect(snap.attention.gates).toEqual([]);
    expect(snap.attention.failedRuns).toEqual([]);
    expect(snap.recentAgents).toEqual([]);
  });

  it('lifts pending gates (first) and failed runs into Attention, labeled by workflow slug', async () => {
    await seedRun(client.db, {
      slug: 'deploy',
      runId: 'run-paused',
      state: 'paused',
      atMs: T0 + 3_000,
      gate: { gateId: 'g1', gateType: 'approval', message: 'ship it?' },
    });
    await seedRun(client.db, {
      slug: 'nightly',
      runId: 'run-failed',
      state: 'failed',
      atMs: T0 + 2_000,
    });
    await seedRun(client.db, {
      slug: 'backup',
      runId: 'run-ok',
      state: 'completed',
      atMs: T0 + 1_000,
    });

    const snap = buildHomeSnapshot(deps);

    expect(snap.attention.gates).toEqual([
      {
        runId: 'run-paused',
        workflowSlug: 'deploy',
        gateId: 'g1',
        gateType: 'approval',
        nodeId: 'g',
        message: 'ship it?',
        expiresAt: undefined,
      },
    ]);
    // Exact row (not objectContaining) so a dropped/mis-mapped createdAt or cost projection is caught.
    expect(snap.attention.failedRuns).toEqual([
      {
        runId: 'run-failed',
        workflowSlug: 'nightly',
        status: 'failed',
        createdAt: ISO(T0 + 2_000),
        startedAt: ISO(T0 + 2_000),
        completedAt: ISO(T0 + 2_000),
        totalCostMicrocents: 100,
      },
    ]);
    // The completed run is the only neutral "Continue" run — the failed + paused runs are in Attention, not here.
    expect(snap.recentRuns).toEqual([
      {
        runId: 'run-ok',
        workflowSlug: 'backup',
        status: 'completed',
        createdAt: ISO(T0 + 1_000),
        startedAt: ISO(T0 + 1_000),
        completedAt: ISO(T0 + 1_000),
        totalCostMicrocents: 100,
      },
    ]);
    expect(snap.isEmpty).toBe(false);
  });

  it('never repeats a failed run in the Continue list (it lives only in Attention)', async () => {
    await seedRun(client.db, { slug: 'a', runId: 'run-bad', state: 'failed', atMs: T0 + 2_000 });
    await seedRun(client.db, {
      slug: 'a',
      runId: 'run-good',
      state: 'completed',
      atMs: T0 + 1_000,
    });

    const snap = buildHomeSnapshot(deps);
    expect(snap.attention.failedRuns.map((r) => r.runId)).toEqual(['run-bad']);
    expect(snap.recentRuns.map((r) => r.runId)).toEqual(['run-good']); // NOT run-bad
  });

  it('keeps a BUDGET-paused run in Continue (it is not a human gate)', async () => {
    await seedRun(client.db, {
      slug: 'a',
      runId: 'run-budget',
      state: 'paused',
      atMs: T0 + 1_000,
      budgetGateId: 'budget-1',
    });

    const snap = buildHomeSnapshot(deps);
    expect(snap.attention.gates).toEqual([]); // a budget gate is the `relavium budget resume` surface, not here
    expect(snap.recentRuns.map((r) => r.runId)).toEqual(['run-budget']);
  });

  it('surfaces every human gate on a run (multi-gate fan-out) and lifts the run out of Continue', async () => {
    await seedRun(client.db, {
      slug: 'deploy',
      runId: 'run-multi',
      state: 'paused',
      atMs: T0 + 1_000,
      gates: [
        { gateId: 'g1', gateType: 'approval', message: 'approve A?' },
        { gateId: 'g2', gateType: 'review', message: 'review B?' },
      ],
    });

    const snap = buildHomeSnapshot(deps);
    // Both gates surface, each labeled with the run's slug; the flatMap fans one paused run out to two rows.
    expect(snap.attention.gates.map((g) => g.gateId)).toEqual(['g1', 'g2']);
    expect(
      snap.attention.gates.every((g) => g.runId === 'run-multi' && g.workflowSlug === 'deploy'),
    ).toBe(true);
    expect(snap.recentRuns).toEqual([]); // the gated run is not repeated in Continue
  });

  it('on a run with BOTH a budget and a human gate: surfaces only the human gate, excludes the run from Continue', async () => {
    await seedRun(client.db, {
      slug: 'a',
      runId: 'run-both',
      state: 'paused',
      atMs: T0 + 1_000,
      budgetGateId: 'budget-1',
      gate: { gateId: 'g1', gateType: 'approval', message: 'ship it?' },
    });

    const snap = buildHomeSnapshot(deps);
    expect(snap.attention.gates.map((g) => g.gateId)).toEqual(['g1']); // budget gate excluded, human surfaced
    expect(snap.recentRuns).toEqual([]); // the human gate still lifts the run out of Continue
  });

  it('renders a run whose workflow is soft-deleted with workflowSlug undefined (still surfaced)', async () => {
    await seedRun(client.db, {
      slug: 'gone',
      runId: 'run-orphan',
      state: 'completed',
      atMs: T0 + 1_000,
    });
    // Soft-delete the workflow row — its run stays (listRuns filters runs.deletedAt, not the workflow's), but
    // the slug lookup drops it, so the row renders unlabeled rather than vanishing.
    client.db.update(workflows).set({ deletedAt: T0 }).where(eq(workflows.slug, 'gone')).run();

    const [row] = buildHomeSnapshot(deps).recentRuns;
    expect(row?.runId).toBe('run-orphan');
    expect(row?.workflowSlug).toBeUndefined();
    expect(row?.status).toBe('completed');
  });

  it('Continue backfills past newer attention runs (the over-fetch compensates) in newest-first order', async () => {
    // limit 2; the 2 NEWEST runs are failed (attention) ahead of 2 older completed runs. The over-fetch
    // (limit + #attention) widens the window so Continue still fills to 2 with the older completed runs.
    await seedRun(client.db, { slug: 'a', runId: 'fail-2', state: 'failed', atMs: T0 + 4_000 });
    await seedRun(client.db, { slug: 'b', runId: 'fail-1', state: 'failed', atMs: T0 + 3_000 });
    await seedRun(client.db, { slug: 'b', runId: 'ok-new', state: 'completed', atMs: T0 + 2_000 });
    await seedRun(client.db, { slug: 'a', runId: 'ok-old', state: 'completed', atMs: T0 + 1_000 });

    const snap = buildHomeSnapshot({ ...deps, limit: 2 });
    expect(snap.recentRuns.map((r) => r.runId)).toEqual(['ok-new', 'ok-old']); // backfilled + newest-first
    expect(snap.attention.failedRuns.map((r) => r.runId)).toEqual(['fail-2', 'fail-1']); // bounded to limit 2
  });

  it('a failed run beyond the attention display cap still never leaks into Continue (status-based exclusion)', async () => {
    // 3 failed runs but limit 2: attention shows only the 2 newest failed, yet NO failed run may appear in
    // Continue — `recentRuns` excludes by STATUS, not by the (capped) displayed-failed id set. (It may under-fill
    // in this deep-burst edge; that is accepted — what must never happen is a failed run shown as "continuable".)
    await seedRun(client.db, { slug: 'a', runId: 'fail-3', state: 'failed', atMs: T0 + 3_000 });
    await seedRun(client.db, { slug: 'a', runId: 'fail-2', state: 'failed', atMs: T0 + 2_500 });
    await seedRun(client.db, { slug: 'a', runId: 'fail-1', state: 'failed', atMs: T0 + 2_000 });
    await seedRun(client.db, { slug: 'a', runId: 'ok-1', state: 'completed', atMs: T0 + 1_000 });

    const snap = buildHomeSnapshot({ ...deps, limit: 2 });
    // Exact (not a vacuous negative): ok-1 IS within the over-fetched window (limit 2 + 2 failed = 4), so it
    // must appear; an empty result would be over-filtering, not the accepted deep-burst under-fill. And no
    // failed run (incl. the beyond-cap fail-1) may leak in.
    expect(snap.recentRuns.map((r) => r.runId)).toEqual(['ok-1']);
  });

  it('Continue backfills when BOTH a failed and a human-gated run consume attention slots (combined overFetch)', async () => {
    // The over-fetch is failedRunRecords.length + humanGatedRunIds.size — this fixture makes BOTH terms non-zero
    // (1 failed + 1 gated), so a regression dropping either term would leave Continue empty instead of filled.
    await seedRun(client.db, {
      slug: 'deploy',
      runId: 'gated',
      state: 'paused',
      atMs: T0 + 4_000,
      gate: { gateId: 'g1', gateType: 'approval', message: 'ship it?' },
    });
    await seedRun(client.db, {
      slug: 'nightly',
      runId: 'fail-1',
      state: 'failed',
      atMs: T0 + 3_000,
    });
    await seedRun(client.db, { slug: 'a', runId: 'ok-new', state: 'completed', atMs: T0 + 2_000 });
    await seedRun(client.db, { slug: 'b', runId: 'ok-old', state: 'completed', atMs: T0 + 1_000 });

    const snap = buildHomeSnapshot({ ...deps, limit: 2 });
    expect(snap.attention.gates.map((g) => g.gateId)).toEqual(['g1']);
    expect(snap.attention.failedRuns.map((r) => r.runId)).toEqual(['fail-1']);
    expect(snap.recentRuns.map((r) => r.runId)).toEqual(['ok-new', 'ok-old']); // both overFetch terms applied
  });

  it('trims recentRuns to the limit when OLDER failed runs widen the window past `limit` neutral survivors', async () => {
    // 2 OLD failed runs widen overFetch to 2 (window = limit 2 + 2 = 4), but the 4 NEWEST rows are all neutral —
    // so the status filter removes nothing from the window and `.slice(0, limit)` is the SOLE active trimmer.
    await seedRun(client.db, { slug: 'a', runId: 'ok-3', state: 'completed', atMs: T0 + 5_000 });
    await seedRun(client.db, { slug: 'a', runId: 'ok-2', state: 'completed', atMs: T0 + 4_000 });
    await seedRun(client.db, { slug: 'a', runId: 'ok-1', state: 'completed', atMs: T0 + 3_000 });
    await seedRun(client.db, { slug: 'a', runId: 'fail-2', state: 'failed', atMs: T0 + 2_000 });
    await seedRun(client.db, { slug: 'a', runId: 'fail-1', state: 'failed', atMs: T0 + 1_000 });

    const snap = buildHomeSnapshot({ ...deps, limit: 2 });
    expect(snap.attention.failedRuns.map((r) => r.runId)).toEqual(['fail-2', 'fail-1']);
    expect(snap.recentRuns.map((r) => r.runId)).toEqual(['ok-3', 'ok-2']); // sliced from 3 survivors to 2
  });

  it('clamps a non-positive limit to 1 (the DB ≤0⇒unbounded convention must not leak to the Home)', () => {
    const store = createSessionStore(client.db);
    store.createSession(session({ id: 's1', updatedAt: ISO(T0 + 2_000) }));
    store.createSession(session({ id: 's2', updatedAt: ISO(T0 + 1_000) }));
    // limit 0 would otherwise read every session unbounded; the clamp makes it a coherent single-row strip.
    expect(buildHomeSnapshot({ ...deps, limit: 0 }).recentSessions.map((s) => s.sessionId)).toEqual(
      ['s1'],
    );
  });

  it('a running (non-terminal, non-gated) run stays neutral in Continue, never in Attention', async () => {
    await seedRun(client.db, { slug: 'a', runId: 'run-live', state: 'running', atMs: T0 + 2_000 });
    await seedRun(client.db, { slug: 'a', runId: 'run-bad', state: 'failed', atMs: T0 + 1_000 });

    const snap = buildHomeSnapshot(deps);
    expect(snap.recentRuns.map((r) => r.runId)).toEqual(['run-live']);
    expect(snap.attention.failedRuns.map((r) => r.runId)).toEqual(['run-bad']);
    expect(snap.attention.gates).toEqual([]);
  });

  it('derives recent agents from the recent sessions — most-recent-first and deduped', () => {
    const store = createSessionStore(client.db);
    store.createSession(session({ id: 's1', agentSlug: 'writer', updatedAt: ISO(T0 + 1_000) }));
    store.createSession(session({ id: 's2', agentSlug: 'coder', updatedAt: ISO(T0 + 3_000) }));
    store.createSession(session({ id: 's3', agentSlug: 'writer', updatedAt: ISO(T0 + 2_000) }));

    const snap = buildHomeSnapshot(deps);
    // 'writer' was used twice (s1 @1000, s3 @2000) and 'coder' once (s2 @3000). The list is one row per agent,
    // ordered by each agent's MOST-RECENT use: coder (@3000) before writer (its newest is s3 @2000).
    expect(snap.recentAgents).toEqual([
      { agentSlug: 'coder', lastUsedAt: ISO(T0 + 3_000) },
      { agentSlug: 'writer', lastUsedAt: ISO(T0 + 2_000) },
    ]);
  });

  it('bounds every list to the top-N (indexed `{ limit }`), newest-first', () => {
    const store = createSessionStore(client.db);
    for (let i = 0; i < 5; i += 1) {
      store.createSession(
        session({ id: `s${i}`, agentSlug: `a${i}`, updatedAt: ISO(T0 + i * 1_000) }),
      );
    }
    const snap = buildHomeSnapshot({ ...deps, limit: 2 });
    expect(snap.recentSessions.map((s) => s.sessionId)).toEqual(['s4', 's3']); // newest two only
  });

  it('exposes the agent-first session fields (title, agent, status, updatedAt; absent model ⇒ undefined)', () => {
    // `modelId` is left unset (a catalog FK governs it — the established `makeSession` pattern avoids seeding a
    // model_catalog row); the row projects it as `undefined`, which is what the Home renders for an unset model.
    createSessionStore(client.db).createSession(
      session({ id: 's1', title: 'Plan the launch', agentSlug: 'planner' }),
    );
    const [row] = buildHomeSnapshot(deps).recentSessions;
    expect(row).toEqual({
      sessionId: 's1',
      title: 'Plan the launch',
      agentSlug: 'planner',
      modelId: undefined,
      status: 'active',
      updatedAt: ISO(T0),
      totalCostMicrocents: 0,
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
    expect(store.read().isEmpty).toBe(false); // a session-only db must flip the recentSessions arm of isEmpty
  });

  it('defaults to DEFAULT_HOME_LIMIT when no limit is given', () => {
    const store = createSessionStore(client.db);
    for (let i = 0; i < DEFAULT_HOME_LIMIT + 3; i += 1) {
      store.createSession(
        session({ id: `s${i}`, agentSlug: `a${i}`, updatedAt: ISO(T0 + i * 1_000) }),
      );
    }
    expect(buildHomeSnapshot(deps).recentSessions).toHaveLength(DEFAULT_HOME_LIMIT);
  });
});
