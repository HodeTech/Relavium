/**
 * What `buildHomeSnapshot` asks of its reads and how it folds them (MVP-11 unit 7, round 2; `home-store.ts`): the page it loads and the limit
 * it clamps to, the order of the unreadable runs (newest first, a tie by run id descending, interleaved across the paused, failed and Runs
 * lists), a run placed once when a status moves under the read, a session's unpriced calls summed over its cost rows, and `isEmpty` when a
 * count and a list disagree.
 */
import {
  createClient,
  createRunHistoryReader,
  createSessionStore,
  runEvents,
  runMigrations,
  runs,
  type DbClient,
  type SessionCostRow,
} from '@relavium/db';
import { SessionContextSchema, type AgentSessionRecord } from '@relavium/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { seedRun, type SeedRunOptions } from '../test-support.js';
import {
  buildHomeSnapshot,
  DEFAULT_HOME_LIMIT,
  HOME_LIMIT_MAX,
  type HomeStoreDeps,
} from './home-store.js';

const HERE = '/workspace';
const CTX = SessionContextSchema.parse({ workingDir: HERE, fsScopeTier: 'sandboxed' });
const ISO = (ms: number): string => new Date(ms).toISOString();
const T0 = 1_750_000_000_000;
const NOW = T0 + 60_000;

describe('the Home snapshot’s reads and their order', () => {
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
    client.sqlite.close();
  });
  const seed = async (opts: SeedRunOptions): Promise<void> => {
    await seedRun(client.db, opts);
    client.db.update(runs).set({ projectRoot: HERE }).where(eq(runs.id, opts.runId)).run();
  };
  let damaged = 0;
  const damage = (runId: string, seq = 900): void => {
    damaged += 1;
    client.db
      .insert(runEvents)
      .values({
        id: `00000000-0000-4000-8000-${String(seq + damaged).padStart(12, '0')}`,
        runId,
        seq,
        eventType: 'node:started',
        payloadJson: JSON.stringify({ type: 'node:started', nodeId: 42 }),
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

  describe('the pages it asks for', () => {
    type ListOptions = Parameters<HomeStoreDeps['runs']['listRunSummaries']>[0];
    const asked = (limit?: number): ListOptions[] => {
      const calls: ListOptions[] = [];
      const reader = createRunHistoryReader(client.db);
      buildHomeSnapshot({
        ...deps,
        ...(limit === undefined ? {} : { limit }),
        runs: {
          ...reader,
          listRunSummaries: (options) => {
            calls.push(options);
            return reader.listRunSummaries(options);
          },
        },
      });
      return calls;
    };
    it('the paused read is the limit; the failed and the Runs reads are a page of twice the limit', () => {
      const calls = asked();
      expect(DEFAULT_HOME_LIMIT).toBe(8);
      expect(calls.map((call) => [call.status ?? call.exceptStatus, call.limit])).toEqual([
        ['paused', 8],
        ['failed', 16],
        ['paused', 16],
      ]);
    });
    it('a limit above the most one list loads is clamped to 100 (a page of the 200 a summary page holds)', () => {
      expect(HOME_LIMIT_MAX).toBe(100);
      expect(asked(100_000).map((call) => call.limit)).toEqual([100, 200, 200]);
      expect(asked(100).map((call) => call.limit)).toEqual([100, 200, 200]);
      expect(asked(99).map((call) => call.limit)).toEqual([99, 198, 198]);
    });
  });

  describe('the unreadable runs are listed newest first, a tie by run id descending', () => {
    it('by creation time, and by id when two runs were created in the same millisecond', async () => {
      await seed({ slug: 'wf', runId: 'bad-a', state: 'paused', atMs: T0 + 1_000 });
      await seed({ slug: 'wf', runId: 'bad-b', state: 'paused', atMs: T0 + 1_000 });
      await seed({ slug: 'wf', runId: 'bad-old', state: 'paused', atMs: T0 });
      await seed({ slug: 'wf', runId: 'bad-new', state: 'paused', atMs: T0 + 2_000 });
      for (const id of ['bad-a', 'bad-b', 'bad-old', 'bad-new']) damage(id);
      expect(buildHomeSnapshot(deps).unreadableRuns.map((run) => run.runId)).toEqual([
        'bad-new',
        'bad-b',
        'bad-a',
        'bad-old',
      ]);
    });
    it('a tie across the lists (one millisecond, a paused, a failed and a completed run) is by id descending, whatever list read them first', async () => {
      await seed({ slug: 'wf', runId: 'tie-a', state: 'paused', atMs: T0 + 1_000 });
      await seed({ slug: 'wf', runId: 'tie-c', state: 'failed', atMs: T0 + 1_000 });
      await seed({ slug: 'wf', runId: 'tie-b', state: 'completed', atMs: T0 + 1_000 });
      for (const id of ['tie-a', 'tie-b', 'tie-c']) damage(id);
      expect(buildHomeSnapshot(deps).unreadableRuns.map((run) => run.runId)).toEqual([
        'tie-c',
        'tie-b',
        'tie-a',
      ]);
    });
    it('the paused, the failed and the Runs lists interleave by time', async () => {
      await seed({ slug: 'wf', runId: 'p-mid', state: 'paused', atMs: T0 + 1_000 });
      await seed({ slug: 'wf', runId: 'f-new', state: 'failed', atMs: T0 + 3_000 });
      await seed({ slug: 'wf', runId: 'c-old', state: 'completed', atMs: T0 });
      await seed({ slug: 'wf', runId: 'f-old', state: 'failed', atMs: T0 + 500 });
      for (const id of ['p-mid', 'f-new', 'c-old', 'f-old']) damage(id);
      expect(buildHomeSnapshot(deps).unreadableRuns.map((run) => run.runId)).toEqual([
        'f-new',
        'p-mid',
        'f-old',
        'c-old',
      ]);
    });
  });

  it('a paused run whose log cannot be read and whom a later statement also returns (its status moved) is placed once, as the unreadable run', async () => {
    await seed({ slug: 'wf', runId: 'moved', state: 'paused', atMs: T0 + 1_000 });
    damage('moved');
    const reader = createRunHistoryReader(client.db);
    const snapshot = buildHomeSnapshot({
      ...deps,
      runs: {
        ...reader,
        listRunSummaries: (options) => {
          const rows = reader.listRunSummaries(options);
          if (options.status !== 'failed') return rows;
          const paused = reader.listRunSummaries({ projectRoot: HERE, status: 'paused', limit: 5 });
          return [...paused.map((run) => ({ ...run, status: 'failed' as const })), ...rows];
        },
      },
    });
    expect(snapshot.unreadableRuns.map((run) => run.runId)).toEqual(['moved']);
    expect(snapshot.attention.failedRuns).toEqual([]);
  });

  it('a failed run that a later statement also returns (its status moved under the read) is placed once, in Attention, and not again in the Runs section', async () => {
    await seed({ slug: 'wf', runId: 'f1', state: 'failed', atMs: T0 + 1_000 });
    await seed({ slug: 'wf', runId: 'c1', state: 'completed', atMs: T0 });
    const reader = createRunHistoryReader(client.db);
    const snapshot = buildHomeSnapshot({
      ...deps,
      runs: {
        ...reader,
        listRunSummaries: (options) => {
          const rows = reader.listRunSummaries(options);
          if (options.exceptStatus !== 'paused') return rows;
          const failed = reader.listRunSummaries({ projectRoot: HERE, status: 'failed', limit: 5 });
          return [...failed, ...rows];
        },
      },
    });
    expect(snapshot.attention.failedRuns.map((run) => run.runId)).toEqual(['f1']);
    expect(snapshot.recentRuns.map((run) => run.runId)).toEqual(['c1']);
  });

  it('a session row carries the SUM of the unpriced calls of its cost rows', () => {
    createSessionStore(client.db).createSession(session({ id: 's1' }));
    const real = createSessionStore(client.db);
    const costRow = (model: string, unpricedCalls: number): SessionCostRow => ({
      model,
      modelCatalogId: undefined,
      inputTokens: 0,
      outputTokens: 0,
      costMicrocents: 0,
      conservativeMicrocents: 0,
      callCount: unpricedCalls,
      unpricedCalls,
      isLegacy: false,
    });
    const snapshot = buildHomeSnapshot({
      ...deps,
      sessions: {
        ...real,
        loadSessionCostBreakdown: (id) => ({
          ...real.loadSessionCostBreakdown(id),
          rows: [costRow('m', 2), costRow('n', 3)],
        }),
      },
    });
    expect(snapshot.recentSessions[0]?.unpricedCalls).toBe(5);
  });

  describe('isEmpty needs both: nothing counted and nothing listed', () => {
    const noRuns = (counts: {
      paused: number;
      failed: number;
      rest: number;
    }): HomeStoreDeps['runs'] => {
      const reader = createRunHistoryReader(client.db);
      return {
        ...reader,
        listRunSummaries: () => [],
        countRunSummaries: (filter) =>
          filter.status === 'paused'
            ? counts.paused
            : filter.status === 'failed'
              ? counts.failed
              : counts.rest,
      };
    };
    const noSessions = (count: number): HomeStoreDeps['sessions'] => ({
      ...createSessionStore(client.db),
      listSessions: () => [],
      countSessions: () => count,
    });
    it.each([
      [{ paused: 1, failed: 0, rest: 0 }, 1],
      [{ paused: 0, failed: 0, rest: 1 }, 1],
      [{ paused: 0, failed: 0, rest: 0 }, 1],
    ])('counted but not listed (%j, %i sessions) is not empty', (counts, sessions) => {
      const snapshot = buildHomeSnapshot({
        ...deps,
        runs: noRuns(counts),
        sessions: noSessions(sessions),
      });
      expect(snapshot.isEmpty).toBe(false);
    });
    it('attention 1 and sessions 1 (they must not cancel) with nothing listed is not empty', () => {
      const snapshot = buildHomeSnapshot({
        ...deps,
        runs: noRuns({ paused: 1, failed: 0, rest: 0 }),
        sessions: noSessions(1),
      });
      expect(snapshot.totals).toEqual({ attention: 1, sessions: 1, runs: 0 });
      expect(snapshot.isEmpty).toBe(false);
    });
    it('sessions 1 and runs 1 counted with nothing listed is not empty', () => {
      const snapshot = buildHomeSnapshot({
        ...deps,
        runs: noRuns({ paused: 0, failed: 0, rest: 1 }),
        sessions: noSessions(1),
      });
      expect(snapshot.totals).toEqual({ attention: 0, sessions: 1, runs: 1 });
      expect(snapshot.isEmpty).toBe(false);
    });
    it('rows listed with every count at zero (a read that raced a count) is not empty, whichever lists hold them', async () => {
      const zero = {
        ...createRunHistoryReader(client.db),
        countRunSummaries: () => 0,
      };
      const zeroSessions = { ...createSessionStore(client.db), countSessions: () => 0 };
      // a session and a failed run: the lengths must add, not cancel
      createSessionStore(client.db).createSession(session({ id: 's1' }));
      await seed({ slug: 'wf', runId: 'f1', state: 'failed', atMs: T0 + 1_000 });
      expect(buildHomeSnapshot({ ...deps, runs: zero, sessions: zeroSessions }).isEmpty).toBe(
        false,
      );
    });
    it('a session and a Runs row, counts at zero', async () => {
      const zero = { ...createRunHistoryReader(client.db), countRunSummaries: () => 0 };
      const zeroSessions = { ...createSessionStore(client.db), countSessions: () => 0 };
      createSessionStore(client.db).createSession(session({ id: 's1' }));
      await seed({ slug: 'wf', runId: 'c1', state: 'completed', atMs: T0 + 1_000 });
      expect(buildHomeSnapshot({ ...deps, runs: zero, sessions: zeroSessions }).isEmpty).toBe(
        false,
      );
    });
    it('an unreadable run alone, counts at zero: a Home whose only content is a damaged run is not a fresh install', async () => {
      const zero = { ...createRunHistoryReader(client.db), countRunSummaries: () => 0 };
      await seed({ slug: 'wf', runId: 'bad', state: 'paused', atMs: T0 + 1_000 });
      damage('bad');
      const snapshot = buildHomeSnapshot({ ...deps, runs: zero });
      expect(snapshot.unreadableRuns.map((run) => run.runId)).toEqual(['bad']);
      expect(snapshot.totals).toEqual({ attention: 0, sessions: 0, runs: 0 });
      expect(snapshot.isEmpty).toBe(false);
    });
    it('a session and an unreadable run, counts at zero', async () => {
      const zero = { ...createRunHistoryReader(client.db), countRunSummaries: () => 0 };
      const zeroSessions = { ...createSessionStore(client.db), countSessions: () => 0 };
      createSessionStore(client.db).createSession(session({ id: 's1' }));
      await seed({ slug: 'wf', runId: 'bad', state: 'paused', atMs: T0 + 1_000 });
      damage('bad');
      expect(buildHomeSnapshot({ ...deps, runs: zero, sessions: zeroSessions }).isEmpty).toBe(
        false,
      );
    });
  });
});
