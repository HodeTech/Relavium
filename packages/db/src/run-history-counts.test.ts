import type { RunStatus } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import {
  createRunHistoryReader,
  isRunHistoryReadError,
  type RunHistoryReader,
} from './run-history-store.js';
import { runs, workflows } from './schema.js';
import { isoToEpochMs } from './time.js';

/**
 * The read-only count seam of one project's runs and the filters it shares with the keyset page (MVP-11 unit 7: the
 * Home reads THIS directory and says its true totals). Every run is seeded straight into the table, so a fixture states
 * exactly the row a read sees; the count and the page come from the same `createRunHistoryReader` the CLI calls.
 */

const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const HERE = '/work/here';
const STATUSES: readonly RunStatus[] = [
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
];
type CountFilter = Parameters<RunHistoryReader['countRunSummaries']>[0];

describe('countRunSummaries and the filters it shares with listRunSummaries', () => {
  let client: DbClient;
  let reader: RunHistoryReader;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    reader = createRunHistoryReader(client.db);
    client.db
      .insert(workflows)
      .values({ id: 'wf', name: 'wf', slug: 'wf', definition: '{}', createdAt: T0, updatedAt: T0 })
      .run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    client.sqlite.close();
  });

  function seedRun(
    id: string,
    createdAt: number,
    extra: {
      readonly projectRoot?: string | null;
      readonly status?: RunStatus;
      readonly deletedAt?: number;
    } = {},
  ): void {
    client.db
      .insert(runs)
      .values({
        id,
        workflowId: 'wf',
        workflowDefinitionSnapshot: '{}',
        projectRoot: extra.projectRoot === undefined ? HERE : extra.projectRoot,
        status: extra.status ?? 'completed',
        ...(extra.deletedAt === undefined ? {} : { deletedAt: extra.deletedAt }),
        createdAt,
        updatedAt: createdAt,
      })
      .run();
  }

  /** Every id the keyset page lists for `filter`, walked to the end one small page at a time (as a browser does). */
  function walk(filter: CountFilter): string[] {
    const ids: string[] = [];
    let before: { createdAt: number; id: string } | undefined;
    for (let guard = 0; guard < 500; guard++) {
      const page = reader.listRunSummaries({
        ...filter,
        limit: 3,
        ...(before === undefined ? {} : { before }),
      });
      const last = page.at(-1);
      if (last === undefined) return ids;
      ids.push(...page.map((row) => row.id));
      before = { createdAt: isoToEpochMs(last.createdAt), id: last.id };
    }
    throw new Error('the page walk did not terminate');
  }

  /** The typed refusal `read` throws, or `undefined` when it does not throw. */
  function refusalOf(read: () => unknown): unknown {
    try {
      read();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it('counts one project’s runs, never another project’s, a run with no project, or a soft-deleted run', () => {
    seedRun('a', T0 + 1);
    seedRun('b', T0 + 2, { status: 'failed' });
    seedRun('gone', T0 + 3, { deletedAt: T0 + 4 });
    seedRun('other', T0 + 5, { projectRoot: '/work/elsewhere' });
    seedRun('nowhere', T0 + 6, { projectRoot: null });
    seedRun('prefix', T0 + 7, { projectRoot: `${HERE}/sub` });

    expect(reader.countRunSummaries({ projectRoot: HERE })).toBe(2);
    expect(reader.countRunSummaries({ projectRoot: '/work/elsewhere' })).toBe(1);
    expect(reader.countRunSummaries({ projectRoot: '/work/none' })).toBe(0);
  });

  it('counts by status, with an inclusive created-at lower bound', () => {
    seedRun('old-failed', T0 - 1, { status: 'failed' });
    seedRun('edge-failed', T0, { status: 'failed' });
    seedRun('new-failed', T0 + 1, { status: 'failed' });
    seedRun('new-done', T0 + 2);
    seedRun('paused', T0 + 3, { status: 'paused' });

    expect(reader.countRunSummaries({ projectRoot: HERE, status: 'failed' })).toBe(3);
    // `since` is inclusive: a run created at exactly the bound is inside it, one millisecond earlier is not.
    expect(reader.countRunSummaries({ projectRoot: HERE, status: 'failed', since: T0 })).toBe(2);
    expect(reader.countRunSummaries({ projectRoot: HERE, status: 'failed', since: T0 + 1 })).toBe(
      1,
    );
    expect(reader.countRunSummaries({ projectRoot: HERE, since: T0 })).toBe(4);
    expect(reader.countRunSummaries({ projectRoot: HERE, status: 'paused' })).toBe(1);
  });

  it('leaves out a status and keeps a failed run only when it was created before a time (the Home’s Runs section)', () => {
    seedRun('old-failed', T0 - 1, { status: 'failed' });
    seedRun('edge-failed', T0, { status: 'failed' });
    seedRun('done', T0 + 1);
    seedRun('paused', T0 + 2, { status: 'paused' });
    seedRun('running', T0 + 3, { status: 'running' });
    seedRun('cancelled', T0 - 5, { status: 'cancelled' });

    const filter: CountFilter = { projectRoot: HERE, exceptStatus: 'paused', failedOnlyBefore: T0 };
    // Not the paused run; not the failed run created AT the bound (it is not before it); the old failed run and every
    // run of another status are kept, whatever their age.
    expect(walk(filter)).toEqual(['running', 'done', 'old-failed', 'cancelled']);
    expect(reader.countRunSummaries(filter)).toBe(4);
    expect(reader.countRunSummaries({ projectRoot: HERE, exceptStatus: 'paused' })).toBe(5);
    expect(reader.countRunSummaries({ projectRoot: HERE, failedOnlyBefore: T0 })).toBe(5);
  });

  it('the count is the number of rows the page lists for the same filter, for every filter (one WHERE for both)', () => {
    // A deterministic spread: every status, three projects (one of them none), ages on both sides of the bound,
    // shared milliseconds, and soft-deleted rows.
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const roots = [HERE, '/work/elsewhere', null] as const;
    for (let index = 0; index < 90; index++) {
      seedRun(`r${String(index).padStart(3, '0')}`, T0 + (next() % 21) - 10, {
        projectRoot: roots[next() % roots.length] ?? null,
        status: STATUSES[next() % STATUSES.length] ?? 'completed',
        ...(next() % 9 === 0 ? { deletedAt: T0 + 100 } : {}),
      });
    }
    const filters: CountFilter[] = [{ projectRoot: HERE }];
    for (const status of [undefined, ...STATUSES])
      for (const since of [undefined, T0 - 3, T0, T0 + 4])
        for (const exceptStatus of [undefined, 'paused', 'failed'] as const)
          for (const failedOnlyBefore of [undefined, T0 - 2, T0 + 1])
            filters.push({
              projectRoot: HERE,
              ...(status === undefined ? {} : { status }),
              ...(since === undefined ? {} : { since }),
              ...(exceptStatus === undefined ? {} : { exceptStatus }),
              ...(failedOnlyBefore === undefined ? {} : { failedOnlyBefore }),
            });
    for (const filter of filters) {
      expect(reader.countRunSummaries(filter), JSON.stringify(filter)).toBe(walk(filter).length);
    }
  });

  it('refuses a project root that is not a non-empty string, with a typed error whose message names no value', () => {
    seedRun('a', T0);
    for (const projectRoot of ['', undefined, 42, null]) {
      const refusal = refusalOf(() =>
        // A caller in plain JavaScript can pass anything: the seam refuses it rather than count every project.
        Reflect.apply(reader.countRunSummaries, undefined, [{ projectRoot }]),
      );
      expect(isRunHistoryReadError(refusal), String(projectRoot)).toBe(true);
      expect(refusal).toMatchObject({ code: 'invalid_filter' });
    }
  });

  it('refuses a time bound that is not a safe integer, on the count and on the page alike, never reading it as no bound', () => {
    seedRun('a', T0, { status: 'failed' });
    const hostile = 'SECRET-PATH-9';
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      for (const read of [
        () => reader.countRunSummaries({ projectRoot: HERE, since: bad }),
        () => reader.countRunSummaries({ projectRoot: HERE, failedOnlyBefore: bad }),
        () => reader.listRunSummaries({ limit: 5, projectRoot: HERE, since: bad }),
        () => reader.listRunSummaries({ limit: 5, failedOnlyBefore: bad }),
      ]) {
        const refusal = refusalOf(read);
        expect(isRunHistoryReadError(refusal), String(bad)).toBe(true);
        expect(refusal).toMatchObject({ code: 'invalid_filter' });
        if (refusal instanceof Error) expect(refusal.message).not.toContain(String(bad));
      }
    }
    // The project root's text never reaches a refusal either.
    const refusal = refusalOf(() =>
      reader.countRunSummaries({ projectRoot: hostile, since: Number.NaN }),
    );
    expect(refusal instanceof Error ? refusal.message : '').not.toContain(hostile);
  });

  it('is one statement that reads no document column and binds the project root, never interpolating it', () => {
    const hostile = `/work/it's"; DROP TABLE runs; --`;
    seedRun('quoted', T0, { projectRoot: hostile });
    const spy = vi.spyOn(client.sqlite, 'prepare');
    let counted: number;
    let statements: string[];
    try {
      counted = reader.countRunSummaries({ projectRoot: hostile, status: 'completed', since: T0 });
      statements = spy.mock.calls.map(([source]) => source);
    } finally {
      spy.mockRestore();
    }
    expect(counted).toBe(1);
    expect(statements).toHaveLength(1);
    const [statement = ''] = statements;
    expect(statement).not.toContain(hostile);
    expect(statement).not.toContain('DROP');
    for (const column of [
      'workflow_definition_snapshot',
      'input_json',
      'output_json',
      'error_json',
    ])
      expect(statement).not.toContain(column);
  });
});
