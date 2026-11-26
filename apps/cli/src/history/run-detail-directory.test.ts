/**
 * What a run's detail says of WHERE the run was started and WHICH workflow it was (MVP-11 unit 7, the History detail's `r`, W4c): the one
 * read that decides whether `r` is offered. The detail names the directory by a closed word (`here`, `elsewhere`, `unrecorded`), never by the
 * stored path, and carries the workflow's slug as a key for the catalog to match, never to draw. Every claim runs over a real in-memory
 * `history.db`, as `run-detail-source.test.ts` does.
 *
 * It also proves what `r` can never read: the detail's reader has four reads, and none of them is the run's inputs (ADR-0113: a run's
 * inputs are not shown and not reused) or its resume snapshot.
 */
import {
  createClient,
  createRunHistoryReader,
  runMigrations,
  type DbClient,
  type RunHistoryReader,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { seedRun } from '../test-support.js';
import {
  createRunDetailLoader,
  readRunDetail,
  type RunDetailLoad,
  type RunDetailRead,
} from './run-detail-source.js';

const T0 = 1_750_000_000_000;
const HOME_DIRECTORY = '/work/app';

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

function ready(load: RunDetailLoad): RunDetailRead {
  if (load.kind !== 'ready') throw new Error(`the detail is ${load.kind}`);
  return load.detail;
}

const seed = async (runId: string, slug = 'wf', projectRoot?: string): Promise<void> => {
  await seedRun(client.db, { slug, runId, state: 'completed', atMs: T0 });
  if (projectRoot !== undefined)
    client.sqlite.prepare('UPDATE runs SET project_root = ? WHERE id = ?').run(projectRoot, runId);
};

const read = (runId: string, projectRoot: string | undefined = HOME_DIRECTORY): RunDetailRead =>
  ready(readRunDetail({ reader, runId, terminalHeld: false, projectRoot }));

describe('the detail says where the run was started, against the directory the Home is in', () => {
  it('is `here` for a run recorded under the Home’s own directory', async () => {
    await seed('run-here', 'wf', HOME_DIRECTORY);
    expect(read('run-here').directory).toBe('here');
  });

  it('is `elsewhere` for a run recorded under another directory, and never for a directory that only starts with the Home’s', async () => {
    await seed('run-other', 'wf', '/work/other');
    await seed('run-prefix', 'wf', `${HOME_DIRECTORY}-two`);
    await seed('run-child', 'wf', `${HOME_DIRECTORY}/sub`);
    expect(read('run-other').directory).toBe('elsewhere');
    expect(read('run-prefix').directory, 'a longer name is not this directory').toBe('elsewhere');
    expect(read('run-child').directory, 'a directory under this one is not this directory').toBe(
      'elsewhere',
    );
  });

  it('is `unrecorded` for a run with no directory (unknown is never `here`), the empty text included', async () => {
    await seed('run-none', 'wf');
    await seed('run-empty', 'wf', '');
    expect(read('run-none').directory).toBe('unrecorded');
    expect(read('run-empty').directory).toBe('unrecorded');
  });

  it('says nothing when the read was not told the Home’s directory, so `r` is not offered on a guess', async () => {
    await seed('run-blind', 'wf', HOME_DIRECTORY);
    const blind = ready(readRunDetail({ reader, runId: 'run-blind', terminalHeld: false }));
    expect(blind.directory).toBeUndefined();
  });

  it('never carries the stored path: the read holds the closed word only', async () => {
    await seed('run-secret', 'wf', '/private/operator/secret-project');
    const detail = read('run-secret');
    expect(JSON.stringify(detail)).not.toContain('secret-project');
    expect(detail.directory).toBe('elsewhere');
  });

  it('is told the Home’s directory by the loader the Home builds', async () => {
    await seed('run-loaded', 'wf', HOME_DIRECTORY);
    await seed('run-loaded-other', 'wf', '/work/other');
    const load = createRunDetailLoader({
      reader,
      listHeld: () => Promise.resolve([]),
      projectRoot: HOME_DIRECTORY,
    });
    expect(ready(await load('run-loaded')).directory).toBe('here');
    expect(ready(await load('run-loaded-other')).directory).toBe('elsewhere');
  });
});

describe('the detail carries the run’s workflow slug as a key, and loses it when the workflow was deleted', () => {
  it('is the slug the run was recorded under', async () => {
    await seed('run-slug', 'release-notes', HOME_DIRECTORY);
    expect(read('run-slug').workflowSlug).toBe('release-notes');
  });

  it('is absent for a workflow that was soft-deleted: the run no longer names a workflow of the project', async () => {
    await seed('run-gone', 'retired', HOME_DIRECTORY);
    client.sqlite.prepare('UPDATE workflows SET deleted_at = ? WHERE slug = ?').run(T0, 'retired');
    expect(read('run-gone').workflowSlug).toBeUndefined();
  });
});

describe('the reads behind a detail never include the run’s inputs or its resume snapshot (ADR-0113)', () => {
  /** The reader, with every property it is asked for recorded: a read that is not one of the four fails the test that made it. */
  function recording() {
    const asked: string[] = [];
    const proxy = new Proxy(reader, {
      get(target, property): unknown {
        asked.push(String(property));
        const read: unknown = Reflect.get(target, property);
        return read;
      },
    });
    return { proxy, asked };
  }

  it('asks for the run, its steps, its events and its workflow slug, and for nothing else, with the directory known', async () => {
    await seed('run-reads', 'wf', HOME_DIRECTORY);
    const { proxy, asked } = recording();
    const load = createRunDetailLoader({
      reader: proxy,
      listHeld: () => Promise.resolve([]),
      projectRoot: HOME_DIRECTORY,
    });
    expect(ready(await load('run-reads')).directory).toBe('here');
    expect(new Set(asked)).toEqual(
      new Set(['loadRunDetail', 'listStepSummaries', 'loadRunEventsAfter', 'loadWorkflowSlugs']),
    );
    expect(asked.join(' ')).not.toMatch(/input|resume|snapshot/iu);
  });

  it('holds no field of the run’s inputs in what it returns', async () => {
    await seed('run-no-inputs', 'wf', HOME_DIRECTORY);
    client.sqlite
      .prepare('UPDATE runs SET input_json = ? WHERE id = ?')
      .run(JSON.stringify({ token: 'INPUT-SECRET-VALUE' }), 'run-no-inputs');
    expect(JSON.stringify(read('run-no-inputs'))).not.toContain('INPUT-SECRET-VALUE');
  });
});
