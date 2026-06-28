import {
  createClient,
  createRunHistoryReader,
  createSessionStore,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import { SessionContextSchema, type AgentSessionRecord } from '@relavium/shared';
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
    expect(snap.attention.failedRuns).toEqual([
      expect.objectContaining({ runId: 'run-failed', workflowSlug: 'nightly', status: 'failed' }),
    ]);
    // The completed run is the only neutral "Continue" run — the failed + paused runs are in Attention, not here.
    expect(snap.recentRuns.map((r) => r.runId)).toEqual(['run-ok']);
    expect(snap.recentRuns[0]?.workflowSlug).toBe('backup');
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
    });
  });

  it('createHomeStore.read() re-aggregates fresh (a new session appears on the next read)', () => {
    const store = createHomeStore(deps);
    expect(store.read().isEmpty).toBe(true);
    createSessionStore(client.db).createSession(session({ id: 's1' }));
    expect(store.read().recentSessions.map((s) => s.sessionId)).toEqual(['s1']);
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
