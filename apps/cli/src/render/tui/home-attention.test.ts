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

import type { ProjectRunGates, RunGatesReader } from '../../home/run-gates.js';
import { seedRun } from '../../test-support.js';
import { displayWidth } from './viewport.js';
import {
  PARKED_RUNS_MAX,
  hostedEndNotice,
  parkedRunLabel,
  parkedRunOverdue,
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
    // Each row also carries when its run parked (the run record's own time: R2 round 2, `parkedSince`): the seed parks at `atMs`.
    const parked = (atMs: number): { readonly parkedSince: string } => ({
      parkedSince: new Date(atMs).toISOString(),
    });
    expect(readParkedRuns(reader, HERE)).toEqual([
      { runId: 'run-c', kind: 'input', gates: 1, workflow: 'wf', ...parked(T0 + 2) },
      { runId: 'run-b', kind: 'review', gates: 1, workflow: 'wf', ...parked(T0 + 1) },
      { runId: 'run-a', kind: 'approval', gates: 1, workflow: 'wf', ...parked(T0) },
    ]);
  });

  it('is one row for a run with several open gates, a budget row for a budget park, and a `media` row for a park on media jobs alone', async () => {
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
      ['run-media', 'media', 0],
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
    runId: 'run-0001-aaaa',
    kind: 'approval',
    gates: 1,
    ...over,
  });

  it('names the gate kind and the first eight characters of the run id, and NO key: the hint row names the focused row’s `Enter` (MVP-11 unit 7)', () => {
    expect(parkedRunLabel(row())).toBe('‖ approval · run-0001');
    expect(parkedRunLabel(row({ kind: 'budget' }))).toBe('‖ budget · run-0001');
    expect(parkedRunLabel(row({ kind: 'input' }))).toBe('‖ input · run-0001');
    expect(parkedRunLabel(row({ kind: 'review' }))).toBe('‖ review · run-0001');
    expect(parkedRunLabel(row({ kind: 'several', gates: 3 }))).toBe('‖ 3 open gates · run-0001');
    expect(parkedRunLabel(row({ kind: 'media', gates: 0 }))).toBe('‖ waiting for media · run-0001');
    expect(parkedRunLabel(row({ kind: 'none', gates: 0 }))).toBe('‖ parked, no gate · run-0001');
    for (const kind of ['approval', 'input', 'review', 'budget', 'several', 'media', 'none'] as const) {
      const label = parkedRunLabel(row({ kind }));
      expect(label, kind).not.toMatch(/Enter|↑\/↓|select/u);
    }
  }); // prettier-ignore

  it('cleans an id that carries a control sequence or a newline', () => {
    const label = parkedRunLabel(row({ runId: 'run\u001b[31m-x\nforged row' }));
    expect(label).not.toContain('\u001b');
    expect(label).not.toContain('\n');
  });
});

/** A parked run as the read returns it: one human gate (or two budget gates) with the deadlines given. */
function readRun(
  runId: string,
  workflowId: string,
  deadlines: {
    readonly human?: readonly (string | undefined)[];
    readonly budget?: readonly (string | undefined)[];
  },
): ProjectRunGates['runs'][number] {
  return {
    runId,
    workflowId,
    degraded: false,
    gates: (deadlines.human ?? []).map((expiresAt, index) => ({
      runId,
      gateId: `h${String(index)}`,
      nodeId: 'n',
      gateType: 'approval' as const,
      message: 'ok?',
      accepts: ['approved', 'rejected'] as const,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    })),
    budgetGates: (deadlines.budget ?? []).map((expiresAt, index) => ({
      gateId: `b${String(index)}`,
      nodeId: 'n',
      allowance: { kind: 'legacy' as const },
      ...(expiresAt === undefined ? {} : { expiresAt }),
    })),
  };
}
const project = (...runs: ProjectRunGates['runs']): ProjectRunGates => ({
  runs,
  degradedRunIds: [],
  truncated: false,
});

describe('the workflow and the deadline a row carries', () => {
  const EARLY = '2026-11-23T12:05:00.000Z';
  const LATE = '2026-11-23T18:00:00.000Z';

  it('names the workflow by its slug and keeps the earliest deadline among the run`s gates, human and budget alike', () => {
    const rows = parkedRunRows(
      project(
        readRun('r1', 'w1', { human: [LATE, EARLY], budget: ['2026-11-24T00:00:00.000Z'] }),
        readRun('r2', 'w1', { human: [LATE], budget: [EARLY] }),
      ),
      new Map([['w1', 'deploy']]),
    );
    expect(rows.map((row) => [row.runId, row.workflow, row.expiresAt])).toEqual([
      ['r1', 'deploy', EARLY],
      ['r2', 'deploy', EARLY],
    ]);
  });

  it('has no deadline field for a gate with none or one that does not parse, and no workflow for an id with no slug', () => {
    const [row] = parkedRunRows(project(readRun('r1', 'unknown', { human: [undefined, 'soon'] })));
    expect(row).toEqual({ runId: 'r1', kind: 'several', gates: 2 });
    expect(row !== undefined && 'expiresAt' in row).toBe(false);
    expect(row !== undefined && 'workflow' in row).toBe(false);
  });

  it('a real read asks for each workflow`s slug once, and a reader that cannot name workflows gives rows without one', async () => {
    await park('run-a', HERE, [{ gateId: 'g-a', gateType: 'approval' }], T0);
    await park('run-b', HERE, [{ gateId: 'g-b', gateType: 'approval' }], T0 + 1);
    const asked: (readonly string[])[] = [];
    const counting = {
      listRunSummaries: reader.listRunSummaries,
      loadRunDetail: reader.loadRunDetail,
      loadRunStateEvents: reader.loadRunStateEvents,
      loadWorkflowSlugs: (ids: readonly string[]) => {
        asked.push(ids);
        return reader.loadWorkflowSlugs(ids);
      },
    };
    expect(readParkedRuns(counting, HERE).map((row) => row.workflow)).toEqual(['wf', 'wf']);
    expect(asked, 'one lookup, one id (both runs share a workflow)').toHaveLength(1);
    expect(asked[0]).toHaveLength(1);
    const bare: RunGatesReader = {
      listRunSummaries: reader.listRunSummaries,
      loadRunDetail: reader.loadRunDetail,
      loadRunStateEvents: reader.loadRunStateEvents,
    };
    expect(readParkedRuns(bare, HERE).map((row) => row.workflow)).toEqual([undefined, undefined]);
  });

  describe('as words in the row', () => {
    const NOW = Date.parse('2026-11-23T12:00:00.000Z');
    const UUID = '0b8f3a52-9d41-4c6e-8a07-5e2d1c9b7f64';
    const parked = (over: Partial<ParkedRunRow> = {}): ParkedRunRow => ({
      runId: UUID,
      kind: 'approval',
      gates: 1,
      workflow: 'deploy',
      expiresAt: EARLY,
      ...over,
    });

    it('is the workflow, the kind, the deadline and the short id, when there is room (the maintainer’s row)', () => {
      expect(parkedRunLabel(parked(), Number.POSITIVE_INFINITY, NOW)).toBe(
        '‖ deploy · approval · expires in 5m · 0b8f3a52',
      );
    });

    it('says `expired` once the deadline has passed, and the view can tell, so it draws the row red', () => {
      const late = parked({ expiresAt: '2026-11-23T11:00:00.000Z' });
      expect(parkedRunLabel(late, Number.POSITIVE_INFINITY, NOW)).toBe(
        '‖ deploy · approval · expired · 0b8f3a52',
      );
      expect(parkedRunOverdue(late, NOW)).toBe(true);
      expect(parkedRunOverdue(parked(), NOW)).toBe(false);
      expect(parkedRunOverdue(parked({ expiresAt: undefined }), NOW)).toBe(false);
    });

    it('has no deadline words without a clock, none for a run with no deadline, and no workflow word when the read could not name it', () => {
      expect(parkedRunLabel(parked())).toBe('‖ deploy · approval · 0b8f3a52');
      expect(parkedRunLabel(parked({ expiresAt: undefined }), 200, NOW)).not.toContain('expire');
      expect(parkedRunLabel(parked({ workflow: undefined }), 200, NOW)).toBe(
        '‖ approval · expires in 5m · 0b8f3a52',
      );
    });

    it('a narrow row gives up the workflow’s tail first, then the deadline, then the id, and never the kind', () => {
      const wide = parked({ workflow: 'nightly-release-pipeline-for-the-eu-region' });
      // the name is bounded to 40 columns however wide the row
      expect(parkedRunLabel(wide, Number.POSITIVE_INFINITY, NOW)).toBe(
        '‖ nightly-release-pipeline-for-the-eu-reg… · approval · expires in 5m · 0b8f3a52',
      );
      // 70 columns (80 less the margin and the row's indent): the name keeps all the room the rest leaves it
      expect(parkedRunLabel(wide, 70, NOW)).toBe(
        '‖ nightly-release-pipeline-for-… · approval · expires in 5m · 0b8f3a52',
      );
      // down to its floor (12 columns) with everything else kept...
      expect(parkedRunLabel(wide, 52, NOW)).toBe('‖ nightly-rel… · approval · expires in 5m · 0b8f3a52');
      // ...then the deadline goes (and the name has its room back), then the id, then the name below its floor
      expect(parkedRunLabel(wide, 51, NOW)).toBe('‖ nightly-release-pipeline-f… · approval · 0b8f3a52');
      expect(parkedRunLabel(wide, 40, NOW)).toBe('‖ nightly-release… · approval · 0b8f3a52');
      expect(parkedRunLabel(wide, 26, NOW)).toBe('‖ nightly-rele… · approval');
      expect(parkedRunLabel(wide, 20, NOW)).toBe('‖ nightl… · approval');
      expect(parkedRunLabel(wide, 12, NOW)).toBe('‖ approval');
      for (let columns = 12; columns <= 120; columns += 1) {
        const label = parkedRunLabel(wide, columns, NOW);
        expect(label, `${String(columns)} columns: the kind`).toContain('approval');
        expect(displayWidth(label), `${String(columns)} columns`).toBeLessThanOrEqual(columns);
      }
    }); // prettier-ignore

    it('cuts a wide-character workflow by display columns, with an ellipsis', () => {
      const wide = parkedRunLabel(parked({ workflow: '日本語'.repeat(30) }), 200, NOW);
      const slug = wide.slice(2).split(' · ')[0] ?? '';
      expect(displayWidth(slug)).toBeLessThanOrEqual(40);
      expect(slug.endsWith('…')).toBe(true);
    });

    it('cleans a workflow slug that carries a control sequence or a newline', () => {
      const label = parkedRunLabel(parked({ workflow: 'dep\u001b[31mloy\nforged' }), 200, NOW);
      expect(label).not.toContain('\u001b');
      expect(label).not.toContain('\n');
    });
  });
});

describe('the line a chat gets when a hosted leg ends behind it', () => {
  const RUN_ID = '3f2a9c1e-7b64-4d0a-9c11-5a2e8f6d0b13';
  const end = (disposition: Parameters<typeof hostedEndNotice>[0]['disposition']) => ({
    runId: RUN_ID,
    disposition,
  });
  const row = (over: Partial<ParkedRunRow> = {}): ParkedRunRow => ({
    runId: RUN_ID,
    kind: 'approval',
    gates: 1,
    workflow: 'deploy',
    ...over,
  });

  it('says a run is waiting at a gate, with its workflow and a glyph and a word', () => {
    expect(hostedEndNotice(end('paused'), row())).toBe(
      '‖ deploy is waiting at a gate. Leave this chat to answer it on the Home.',
    );
  });

  it('says a run waits for media jobs, or is only paused, by what its row waits on; with no row yet it says the gate', () => {
    expect(hostedEndNotice(end('paused'), row({ kind: 'media', gates: 0 }))).toBe(
      '‖ deploy is waiting for media jobs. Leave this chat to continue it on the Home.',
    );
    expect(hostedEndNotice(end('paused'), row({ kind: 'none', gates: 0 }))).toBe(
      '‖ deploy paused. Leave this chat to see it on the Home.',
    );
    expect(hostedEndNotice(end('paused'), undefined)).toBe(
      '‖ run 3f2a9c1e is waiting at a gate. Leave this chat to answer it on the Home.',
    );
  });

  it('says a run completed or failed, named by the first eight characters of its id when no row names it', () => {
    expect(hostedEndNotice(end('completed'), undefined)).toBe(
      '✓ run 3f2a9c1e completed. Leave this chat to see it on the Home.',
    );
    expect(hostedEndNotice(end('failed'), undefined)).toBe(
      '✗ run 3f2a9c1e failed. Leave this chat to see it on the Home.',
    );
  });

  it.each(['cancelled', 'uncertain', 'taken_over', 'settled'] as const)(
    'says nothing for a leg that ended %s: the person asked for it, or the exit line carries it',
    (disposition) => {
      expect(hostedEndNotice(end(disposition), row())).toBeUndefined();
    },
  );

  it('carries no control sequence, newline or path from a workflow slug or a run id', () => {
    const line = hostedEndNotice(
      { runId: 'run\u001b]0;x\u0007\nforged', disposition: 'completed' },
      row({ runId: 'run', workflow: 'wf\u001b[2J\nforged' }),
    );
    expect(line).toBeDefined();
    // eslint-disable-next-line no-control-regex -- the assertion is that no control survives
    expect(line).not.toMatch(/[\u0000-\u001f\u007f]/u);
  });
});
