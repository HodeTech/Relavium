/**
 * Every reader that asks "was this run started HERE?" holds to the one rule (MVP-11 unit 7, round 2, `project-root.ts`): the Home's
 * snapshot, the parked rows and their cards, a run's detail (`r`), the Active and History tabs, the Defined tab's last runs and the `save_to`
 * root of a resume. One real in-memory `history.db` holds a paused, a failed and a finished run under EVERY spelling a root was ever
 * recorded with (the canonical root; a trailing slash, a symlink, a case variant and an unnormalised spelling of it; `.`, a relative
 * directory, the empty text, none; another directory). Only the canonical root is "here"; a stored root that is not absolute is
 * unrecorded; and a reader handed a relative directory lists nothing, even the runs recorded with that very text.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import {
  createClient,
  createRunHistoryReader,
  createSessionStore,
  RunHistoryReadError,
  runMigrations,
  SessionDiscoveryBoundaryError,
  type DbClient,
  type RunHistoryReader,
} from '@relavium/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildHomeSnapshot, type HomeStoreDeps } from '../home/home-store.js';
import { readProjectRunGates, readRunGates } from '../home/run-gates.js';
import { resolveSaveToRoot } from '../run-core/resume-run.js';
import { seedRun } from '../test-support.js';
import { classifyActiveRuns, type ActiveRow } from './active-model.js';
import { readActiveParkCounts } from './active-source.js';
import { createHistorySource } from './history-source.js';
import { projectRootOf } from './project-root.js';
import { readRunDetail } from './run-detail-source.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');

let base: string;
/** The directory the Home is in, canonical. */
let here: string;
let other: string;
let link: string;

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-root-readers-')));
  here = join(base, 'app');
  other = join(base, 'other');
  mkdirSync(here);
  mkdirSync(other);
  link = join(base, 'app-link');
  symlinkSync(here, link, 'junction');
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

type Where = 'here' | 'elsewhere' | 'unrecorded';
/** Every spelling a run's root was recorded with, and what it is to a Home in `here`. */
const spellings = (): readonly (readonly [label: string, stored: string | null, is: Where])[] => [
  ['canonical', here, 'here'],
  ['slash', `${here}${sep}`, 'elsewhere'],
  ['symlink', link, 'elsewhere'],
  ['case', join(base, 'APP'), 'elsewhere'],
  ['unnormalised', `${here}${sep}x${sep}..`, 'elsewhere'],
  ['other', other, 'elsewhere'],
  ['dot', '.', 'unrecorded'],
  ['relative', 'app', 'unrecorded'],
  ['empty', '', 'unrecorded'],
  ['none', null, 'unrecorded'],
];
const STATES = ['paused', 'failed', 'completed'] as const;
const idOf = (label: string, state: (typeof STATES)[number]): string => `rid-${label}-${state}`;

let client: DbClient;
let reader: RunHistoryReader;

beforeEach(async () => {
  client = createClient(':memory:');
  runMigrations(client.db);
  reader = createRunHistoryReader(client.db);
  let at = NOW - 60_000;
  for (const [label, stored] of spellings())
    for (const state of STATES) {
      const runId = idOf(label, state);
      await seedRun(client.db, {
        slug: `wf-${label}`,
        runId,
        state,
        atMs: (at += 10),
        ...(state === 'paused' ? { gates: [{ gateId: 'g1', gateType: 'approval' as const }] } : {}),
      });
      client.sqlite.prepare('UPDATE runs SET project_root = ? WHERE id = ?').run(stored, runId);
    }
});
afterEach(() => {
  client.sqlite.close();
});

const storeDeps = (projectRoot: string, workingDir = projectRoot): HomeStoreDeps => ({
  sessions: createSessionStore(client.db),
  runs: reader,
  projectRoot,
  workingDir,
  now: () => NOW,
  limit: 100,
});

const shownIds = (text: string): string[] =>
  spellings()
    .flatMap(([label]) => STATES.map((state) => idOf(label, state)))
    .filter((id) => text.includes(id));

/** The Home's spellings of `here` a person can type: each canonicalised at the Home, as `driveHome` does (its policy's workspace). */
const homeSpellings = (): string[] => [
  here,
  `${here}${sep}`,
  link,
  relative(process.cwd(), here),
  ...(existsSync(join(base, 'APP')) ? [join(base, 'APP')] : []),
];

describe('the Home in a directory, opened by any spelling of it, lists that directory’s runs and only those', () => {
  it('snapshot, parked rows, Defined tab’s last runs: the canonical root only', () => {
    for (const spelling of homeSpellings()) {
      const home = projectRootOf(spelling);
      expect(home, spelling).toBe(here);
      const snapshot = buildHomeSnapshot(storeDeps(home));
      expect(shownIds(JSON.stringify(snapshot)), spelling).toEqual([
        idOf('canonical', 'failed'),
        idOf('canonical', 'completed'),
      ]);
      expect(snapshot.totals, spelling).toEqual({ attention: 2, sessions: 0, runs: 1 });
      expect(
        readProjectRunGates(reader, home).runs.map((run) => run.runId),
        spelling,
      ).toEqual([idOf('canonical', 'paused')]);
      expect(
        reader.loadLatestRunPerWorkflowInProject(home).map((summary) => summary.slug),
        spelling,
      ).toEqual(['wf-canonical']);
    }
  });

  it('a card opens only on this directory’s parked run, whatever spelling another run was recorded under', () => {
    for (const [label, , is] of spellings()) {
      const gates = readRunGates(reader, here, idOf(label, 'paused'));
      expect(gates === undefined, label).toBe(is !== 'here');
    }
  });
});

describe('a Home handed a relative directory reads nothing, not even the runs recorded with that very text', () => {
  it.each(['.', 'app', ''])('the snapshot refuses %j before any read', (relativeRoot) => {
    const asked: string[] = [];
    const counting = new Proxy(reader, {
      get(target, property): unknown {
        asked.push(String(property));
        const read: unknown = Reflect.get(target, property);
        return read;
      },
    });
    let caught: unknown;
    try {
      buildHomeSnapshot({ ...storeDeps(relativeRoot, here), runs: counting });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RunHistoryReadError);
    expect(caught instanceof RunHistoryReadError ? caught.code : undefined).toBe('invalid_filter');
    expect(() => buildHomeSnapshot({ ...storeDeps(here, relativeRoot), runs: counting })).toThrow(
      SessionDiscoveryBoundaryError,
    );
    expect(asked, 'no run was read for either refusal').toEqual([]);
  });

  it('the parked rows drop what the store hands back for `.`, and no card opens on it', () => {
    // The store's filter is exact text: it does hand the `.` run back. The reader is what refuses it.
    expect(
      reader
        .listRunSummaries({ projectRoot: '.', status: 'paused', limit: 10 })
        .map((run) => run.id),
    ).toEqual([idOf('dot', 'paused')]);
    expect(readProjectRunGates(reader, '.').runs).toEqual([]);
    expect(readRunGates(reader, '.', idOf('dot', 'paused'))).toBeUndefined();
    expect(readRunGates(reader, 'app', idOf('relative', 'paused'))).toBeUndefined();
  });
});

describe('a run’s detail says `here` for the canonical root only (what `r` needs)', () => {
  it('here, elsewhere or unrecorded for every stored spelling', () => {
    for (const [label, , is] of spellings()) {
      const load = readRunDetail({
        reader,
        runId: idOf(label, 'completed'),
        terminalHeld: false,
        projectRoot: here,
      });
      expect(load.kind === 'ready' ? load.detail.directory : load.kind, label).toBe(is);
    }
  });

  it('says nothing of where any run was started when the Home’s directory is relative, `.` included', () => {
    for (const [label] of spellings()) {
      const load = readRunDetail({
        reader,
        runId: idOf(label, 'completed'),
        terminalHeld: false,
        projectRoot: '.',
      });
      expect(load.kind === 'ready' ? load.detail.directory : load.kind, label).toBeUndefined();
    }
  });
});

describe('the Active tab answers only this directory’s parked runs, and names an unrecorded root in words', () => {
  const classify = (currentProjectRoot: string): readonly ActiveRow[] => {
    const paused = reader.listRunSummaries({ status: 'paused', limit: 100 });
    const counts = readActiveParkCounts(reader, currentProjectRoot, paused);
    return classifyActiveRuns({
      runs: paused,
      leases: new Map(),
      currentProjectRoot,
      outboxHeldRunIds: new Set(),
      nowMs: NOW,
      leaseTtlMs: 60_000,
      ...(counts === undefined
        ? {}
        : { pendingGateCounts: counts.gates, pendingMediaJobCounts: counts.media }),
    });
  };

  it('opens a card on the canonical root’s run only; elsewhere is another project, unrecorded is “not recorded” with no place', () => {
    const rows = new Map(classify(here).map((row) => [row.runId, row]));
    for (const [label, , is] of spellings()) {
      const row = rows.get(idOf(label, 'paused'));
      expect(row?.actionable, label).toBe(is === 'here');
      if (is === 'here') expect(row?.enter, label).toBe('open-gate-card');
      if (is === 'elsewhere') expect(row?.reason, label).toBe('another project');
      if (is === 'unrecorded') {
        expect(row?.reason, label).toBe('project not recorded');
        expect(row?.projectRoot, label).toBeUndefined();
      }
    }
  });

  it('a relative current directory makes no run actionable and reads no gate counts, `.` included', () => {
    const paused = reader.listRunSummaries({ status: 'paused', limit: 100 });
    expect(readActiveParkCounts(reader, '.', paused)).toBeUndefined();
    const dot = classify('.').find((row) => row.runId === idOf('dot', 'paused'));
    expect(dot).toMatchObject({ actionable: false, reason: 'project not recorded' });
    expect(classify('.').some((row) => row.actionable)).toBe(false);
  });
});

describe('the History tab’s `this project` scope', () => {
  const source = (projectRoot: string) =>
    createHistorySource({
      reader,
      listRunPins: () =>
        spellings().map(([label], index) => ({
          ref: idOf(label, 'completed'),
          rowid: index + 1,
          oversized: false,
        })),
      projectRoot,
      now: () => NOW,
    });
  const ids = (entries: readonly { kind: string; row?: { id: string } }[]): string[] =>
    entries.flatMap((entry) =>
      entry.kind === 'run' && entry.row !== undefined ? [entry.row.id] : [],
    );

  it('lists the canonical root’s finished runs and pins only', () => {
    const read = source(here).read({ scope: 'project', status: undefined, page: 0 });
    expect(new Set(ids(read.rows))).toEqual(
      new Set([idOf('canonical', 'failed'), idOf('canonical', 'completed')]),
    );
    expect(ids(read.pinned)).toEqual([idOf('canonical', 'completed')]);
  });

  it('is empty for a relative directory, `.` included, while `all` still lists every run as stored', () => {
    const dot = source('.');
    const project = dot.read({ scope: 'project', status: undefined, page: 0 });
    expect(project.rows).toEqual([]);
    expect(ids(project.pinned)).toEqual([]);
    const all = dot.read({ scope: 'all', status: undefined, page: 0 });
    expect(ids(all.rows)).toContain(idOf('dot', 'completed'));
    expect(ids(all.pinned)).toContain(idOf('dot', 'completed'));
  });

  it('names no place for a run whose stored root is not absolute (`.` would read as this project in every Home)', () => {
    const all = source(here).read({ scope: 'all', status: undefined, page: 0 });
    const placeOf = new Map(
      all.rows.flatMap((entry) =>
        entry.kind === 'run' ? [[entry.row.id, entry.row.projectRoot] as const] : [],
      ),
    );
    for (const [label, , is] of spellings())
      expect(placeOf.get(idOf(label, 'completed')) === undefined, label).toBe(is === 'unrecorded');
  });
});

describe('the `save_to` root of a resume', () => {
  it('is the resumer’s directory for a stored root that is not absolute, never that text read against this process', () => {
    for (const stored of ['.', 'app', '', null])
      expect(resolveSaveToRoot(stored, other), String(stored)).toBe(other);
    expect(resolveSaveToRoot(here, other)).toBe(here);
  });

  it('is the resumer’s own spelling when it stands in the recorded directory (the floor keeps the spelling it was admitted with)', () => {
    expect(resolveSaveToRoot(here, link)).toBe(link);
    expect(resolveSaveToRoot(here, `${here}${sep}`)).toBe(`${here}${sep}`);
    expect(resolveSaveToRoot(here, here)).toBe(here);
    // Another directory's resumer: the recorded root, canonical, as it is recorded.
    expect(resolveSaveToRoot(here, other)).toBe(here);
  });
});
