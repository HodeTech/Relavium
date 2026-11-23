/**
 * The Home's Attention rows for parked runs
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §7): one row per paused run of THIS
 * project, none for another directory's run, and none when nothing is paused. The reads run over a real in-memory `history.db`; the
 * bound runs over a scripted reader so that twenty parked runs cost nothing to build.
 */
import {
  createClient,
  createRunHistoryReader,
  runEvents,
  runMigrations,
  type DbClient,
  type RunHistoryReader,
  type RunSummaryRecord,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunGatesReader } from '../../home/run-gates.js';
import { seedRun } from '../../test-support.js';
import {
  PARKED_RUNS_MAX,
  parkedRunLabel,
  parkedRunRows,
  readParkedRuns,
  type ParkedRunRow,
} from './home-attention.js';

const HERE = '/work/here';
const THERE = '/work/there';
const T0 = 1_750_000_000_000;

let client: DbClient;
let reader: RunHistoryReader;

beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  reader = createRunHistoryReader(client.db);
});
afterEach(() => {
  client.sqlite.close();
});

function inProject(runId: string, root: string): void {
  client.sqlite.prepare('UPDATE runs SET project_root = ? WHERE id = ?').run(root, runId);
}

async function park(
  runId: string,
  root: string,
  gates: readonly { gateId: string; gateType: 'approval' | 'input' | 'review' }[],
  atMs: number,
): Promise<void> {
  await seedRun(client.db, { slug: 'wf', runId, state: 'paused', atMs, gates });
  inProject(runId, root);
}

describe('one row per paused run of this project', () => {
  it('names each run, the kind of gate it waits on, newest first', async () => {
    await park('run-a', HERE, [{ gateId: 'g-a', gateType: 'approval' }], T0);
    await park('run-b', HERE, [{ gateId: 'g-b', gateType: 'review' }], T0 + 1);
    await park('run-c', HERE, [{ gateId: 'g-c', gateType: 'input' }], T0 + 2);
    expect(readParkedRuns(reader, HERE)).toEqual([
      { runId: 'run-c', kind: 'input', gates: 1 },
      { runId: 'run-b', kind: 'review', gates: 1 },
      { runId: 'run-a', kind: 'approval', gates: 1 },
    ]);
  });

  it('is one row for a run with several open gates, a budget row for a budget park, and a row that says there is no gate for a media park', async () => {
    await park(
      'run-many',
      HERE,
      [
        { gateId: 'g1', gateType: 'approval' },
        { gateId: 'g2', gateType: 'review' },
      ],
      T0,
    );
    await seedRun(client.db, {
      slug: 'wf',
      runId: 'run-budget',
      state: 'paused',
      atMs: T0 + 1,
      budgetGateId: 'b1',
    });
    inProject('run-budget', HERE);
    await seedRun(client.db, { slug: 'wf', runId: 'run-media', state: 'paused', atMs: T0 + 2 });
    inProject('run-media', HERE);
    const rows = readParkedRuns(reader, HERE);
    expect(rows.map((row) => [row.runId, row.kind, row.gates])).toEqual([
      ['run-media', 'none', 0],
      ['run-budget', 'budget', 1],
      ['run-many', 'several', 2],
    ]);
  });

  it('none for a run of another project, and none for a run that is not paused', async () => {
    await park('run-here', HERE, [{ gateId: 'g1', gateType: 'approval' }], T0);
    await park('run-there', THERE, [{ gateId: 'g2', gateType: 'approval' }], T0 + 1);
    await seedRun(client.db, { slug: 'wf', runId: 'run-done', state: 'completed', atMs: T0 + 2 });
    inProject('run-done', HERE);
    const rows = readParkedRuns(reader, HERE);
    expect(rows.map((row) => row.runId)).toEqual(['run-here']);
    expect(JSON.stringify(rows)).not.toContain('run-there');
    expect(JSON.stringify(rows)).not.toContain('run-done');
  });

  it('none for a run of another project handed back anyway by a reader that ignores the project filter', async () => {
    await park('run-here', HERE, [{ gateId: 'g1', gateType: 'approval' }], T0);
    await park('run-there', THERE, [{ gateId: 'g2', gateType: 'approval' }], T0 + 1);
    const careless: RunGatesReader = {
      ...reader,
      listRunSummaries: ({ limit, status, before }) =>
        reader.listRunSummaries({
          limit,
          ...(status === undefined ? {} : { status }),
          ...(before === undefined ? {} : { before }),
        }),
    };
    expect(
      careless.listRunSummaries({ limit: 10, status: 'paused', projectRoot: HERE }),
      'the careless reader does hand both back',
    ).toHaveLength(2);
    const rows = readParkedRuns(careless, HERE);
    expect(rows.map((row) => row.runId)).toEqual(['run-here']);
  });
});

describe('no row when nothing is paused', () => {
  it('an empty history has no row', () => {
    expect(readParkedRuns(reader, HERE)).toEqual([]);
  });

  it('a project whose runs all finished has no row', async () => {
    await seedRun(client.db, { slug: 'wf', runId: 'run-ok', state: 'completed', atMs: T0 });
    await seedRun(client.db, { slug: 'wf', runId: 'run-bad', state: 'failed', atMs: T0 + 1 });
    inProject('run-ok', HERE);
    inProject('run-bad', HERE);
    expect(readParkedRuns(reader, HERE)).toEqual([]);
  });

  it('a project that only another directory parks in has no row', async () => {
    await park('run-there', THERE, [{ gateId: 'g', gateType: 'approval' }], T0);
    expect(readParkedRuns(reader, HERE)).toEqual([]);
  });
});

describe('a run whose log cannot be read', () => {
  it('gets no row (its gates are unknown), and the readable runs keep theirs', async () => {
    await park('run-good', HERE, [{ gateId: 'g1', gateType: 'approval' }], T0);
    await park('run-bad', HERE, [{ gateId: 'g2', gateType: 'approval' }], T0 + 1);
    client.db
      .insert(runEvents)
      .values({
        id: '00000000-0000-4000-8000-0000000000f1',
        runId: 'run-bad',
        seq: 900,
        eventType: 'node:started',
        payloadJson: JSON.stringify({ type: 'node:started', nodeId: 42 }),
        ts: 0,
      })
      .run();
    expect(readParkedRuns(reader, HERE).map((row) => row.runId)).toEqual(['run-good']);
  });
});

function summary(index: number): RunSummaryRecord {
  return {
    id: `run-${String(index).padStart(3, '0')}`,
    workflowId: 'wf',
    status: 'paused',
    executionMode: 'local',
    triggerType: 'manual',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: new Date(T0 - index).toISOString(),
    updatedAt: new Date(T0 - index).toISOString(),
    projectRoot: HERE,
  };
}

describe('the bound', () => {
  it('keeps at most PARKED_RUNS_MAX rows, the newest, and never reads more runs than that', () => {
    const asked: number[] = [];
    const scripted: RunGatesReader = {
      ...reader,
      listRunSummaries: (options) => {
        asked.push(options.limit);
        return Array.from({ length: 20 }, (_, index) => summary(index));
      },
      loadRunStateEvents: () => [],
    };
    const rows = readParkedRuns(scripted, HERE);
    expect(rows).toHaveLength(PARKED_RUNS_MAX);
    expect(rows[0]?.runId).toBe('run-000');
    expect(rows.at(-1)?.runId).toBe(`run-${String(PARKED_RUNS_MAX - 1).padStart(3, '0')}`);
    expect(asked).toHaveLength(1);
  });

  it('parkedRunRows drops a degraded run and keeps the order of the read', () => {
    const rows = parkedRunRows({
      runs: [
        { runId: 'a', workflowId: 'w', gates: [], budgetGates: [], degraded: true },
        { runId: 'b', workflowId: 'w', gates: [], budgetGates: [], degraded: false },
      ],
      degradedRunIds: ['a'],
      truncated: false,
    });
    expect(rows).toEqual([{ runId: 'b', kind: 'none', gates: 0 }]);
  });
});

describe('the label', () => {
  const row = (over: Partial<ParkedRunRow> = {}): ParkedRunRow => ({
    runId: 'run-0001',
    kind: 'approval',
    gates: 1,
    ...over,
  });

  it('names the id, the gate kind and, on the focused row, the key that opens the card', () => {
    expect(parkedRunLabel(row(), true)).toBe('‖ run-0001  ·  approval gate  ·  Enter opens');
    expect(parkedRunLabel(row({ kind: 'budget' }), true)).toContain('budget gate');
    expect(parkedRunLabel(row({ kind: 'input' }), true)).toContain('input gate');
    expect(parkedRunLabel(row({ kind: 'review' }), true)).toContain('review gate');
    expect(parkedRunLabel(row({ kind: 'several', gates: 3 }), true)).toContain('3 open gates');
  });

  it('says how to reach a row that is not focused instead of offering Enter for it', () => {
    const label = parkedRunLabel(row(), false);
    expect(label).toBe('‖ run-0001  ·  approval gate  ·  ↓ selects');
    expect(label).not.toContain('Enter');
  });

  it('a run with no gate to decide says so, and its key explains instead of opening a card', () => {
    const label = parkedRunLabel(row({ kind: 'none', gates: 0 }), true);
    expect(label).toContain('no gate to decide');
    expect(label).toContain('Enter says why');
    expect(label).not.toContain('Enter opens');
  });

  it('cleans an id that carries a control sequence or a newline', () => {
    const label = parkedRunLabel(row({ runId: 'run\u001b[31m-x\nforged row' }), false);
    expect(label).not.toContain('\u001b');
    expect(label).not.toContain('\n');
  });
});
