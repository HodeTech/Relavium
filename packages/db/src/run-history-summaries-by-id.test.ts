import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import {
  createRunHistoryReader,
  isRunHistoryReadError,
  MAX_RUN_SUMMARY_IDS,
  type RunHistoryReader,
} from './run-history-store.js';
import { runs, workflows } from './schema.js';

/**
 * `loadRunSummariesByIds` ([ADR-0140](../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §5, MVP-8 step 4): the summaries of a bounded list of run ids, which is how the History tab reads the runs a person pinned. Every run is
 * seeded straight into the table, so a fixture states exactly the row the read sees; the read is the same `createRunHistoryReader` the CLI calls.
 */

const T0 = Date.parse('2026-06-23T10:00:00.000Z');
const BLOB_COLUMNS = ['workflow_definition_snapshot', 'input_json', 'output_json', 'error_json'];

describe('loadRunSummariesByIds (the pinned runs of the History tab)', () => {
  let client: DbClient;
  let reader: RunHistoryReader;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    reader = createRunHistoryReader(client.db);
    client.db
      .insert(workflows)
      .values({
        id: 'wf-a',
        name: 'alpha',
        slug: 'alpha',
        definition: '{}',
        createdAt: T0,
        updatedAt: T0,
      })
      .run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    client.sqlite.close();
  });

  function seedRun(
    id: string,
    extra: { readonly projectRoot?: string; readonly deletedAt?: number } = {},
  ): void {
    client.db
      .insert(runs)
      .values({
        id,
        workflowId: 'wf-a',
        workflowDefinitionSnapshot: '{"snapshot":"frozen"}',
        projectRoot: extra.projectRoot ?? null,
        status: 'completed',
        inputJson: '{"secret":"input"}',
        outputJson: '{"out":1}',
        errorJson: '{"err":1}',
        ...(extra.deletedAt === undefined ? {} : { deletedAt: extra.deletedAt }),
        createdAt: T0,
        updatedAt: T0,
      })
      .run();
  }

  /** The SQL every statement prepared while `fn` runs. */
  function statementsOf(fn: () => unknown): string[] {
    const spy = vi.spyOn(client.sqlite, 'prepare');
    try {
      fn();
      return spy.mock.calls.map(([source]) => source);
    } finally {
      spy.mockRestore();
    }
  }

  it('returns the summary of each run named, keyed by id, with the project it recorded', () => {
    seedRun('run-a', { projectRoot: '/work/p1' });
    seedRun('run-b');
    const found = reader.loadRunSummariesByIds(['run-a', 'run-b']);
    expect([...found.keys()].sort()).toEqual(['run-a', 'run-b']);
    expect(found.get('run-a')).toMatchObject({
      id: 'run-a',
      status: 'completed',
      projectRoot: '/work/p1',
    });
    expect(found.get('run-b')).not.toHaveProperty('projectRoot');
  });

  it('leaves out an id that names no run, and a run that was soft-deleted, without an error', () => {
    seedRun('run-a');
    seedRun('run-gone', { deletedAt: T0 + 1 });
    const found = reader.loadRunSummariesByIds(['run-a', 'run-gone', 'run-never']);
    expect([...found.keys()]).toEqual(['run-a']);
  });

  it('accepts exactly the cap and refuses one id more, as a typed error and not a truncation', () => {
    seedRun('run-a');
    // The literals are the claim: the cap is 200 and 201 is refused, whatever the constant is changed to.
    expect(MAX_RUN_SUMMARY_IDS).toBe(200);
    const ids = Array.from({ length: 200 }, (_, index) => `run-${String(index)}`);
    expect(reader.loadRunSummariesByIds(ids).size).toBe(0);
    let caught: unknown;
    try {
      const over = [...ids, 'run-a'];
      expect(over).toHaveLength(201);
      reader.loadRunSummariesByIds(over);
    } catch (cause) {
      caught = cause;
    }
    expect(isRunHistoryReadError(caught)).toBe(true);
    expect(isRunHistoryReadError(caught) && caught.code).toBe('too_many_run_ids');
  });

  it('issues no statement for an empty list', () => {
    expect(statementsOf(() => reader.loadRunSummariesByIds([]))).toEqual([]);
    expect(reader.loadRunSummariesByIds([]).size).toBe(0);
  });

  it('selects summary columns only: no frozen snapshot and no JSON document', () => {
    seedRun('run-a');
    const statements = statementsOf(() => reader.loadRunSummariesByIds(['run-a']));
    expect(statements).toHaveLength(1);
    const text = statements[0] ?? '';
    for (const column of BLOB_COLUMNS) expect(text).not.toContain(column);
    const found = reader.loadRunSummariesByIds(['run-a']).get('run-a');
    expect(found).toBeDefined();
    for (const key of ['inputJson', 'outputJson', 'errorJson'])
      expect(found).not.toHaveProperty(key);
  });

  it('is a primary-key lookup: no scan, no temp b-tree', () => {
    const statements = statementsOf(() => reader.loadRunSummariesByIds(['run-a', 'run-b']));
    expect(statements).toHaveLength(1);
    const sqlText = statements[0] ?? '';
    const placeholders = sqlText.match(/\?/gu)?.length ?? 0;
    const plan = client.sqlite
      .prepare(`EXPLAIN QUERY PLAN ${sqlText}`)
      .all(...Array.from({ length: placeholders }, () => null))
      .map((row) =>
        typeof row === 'object' && row !== null && 'detail' in row && typeof row.detail === 'string'
          ? row.detail
          : '',
      )
      .join('\n');
    expect(plan).toMatch(/SEARCH runs USING INDEX sqlite_autoindex_runs_1/u);
    expect(plan).not.toMatch(/SCAN runs/u);
    expect(plan).not.toContain('TEMP B-TREE');
  });
});
