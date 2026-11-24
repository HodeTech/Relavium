/**
 * A start leg reads the operator home it was handed
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §1, §2).
 *
 * `run-host.test.ts` keeps a start leg off the real `~/.relavium` with a module mock of the config loader, because `prepareRun` once had no
 * home seam: its own config load asked the OS. It has one now (`PrepareRunDeps.home`), which the host forwards exactly as it does for a
 * resume. This file proves the seam itself with NO module mock: the home is a temporary directory whose global config is the marker, and
 * the OS home is refused outright, so a start leg that does not read the marker through the seam cannot pass.
 *
 * The marker is a global config that does not parse. Config load is the first thing `prepareRun` does, and a malformed layer is a
 * refusal that names the file, so the refusal carries the path of the temporary home's config and of no other.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { createClient, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEngine } from '../engine/build-engine.js';
import { approvalDecision } from '../gate/decision.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { RunHost, type HostedLaunch, type RunHostOptions } from './run-host.js';

// The net under the seam: anything that asks the OS for the home directory instead of being handed one is a leak.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const guarded = {
    ...actual,
    homedir: (): string => {
      throw new Error('a hosted leg reached the real operator home through os.homedir()');
    },
  };
  return { ...guarded, default: guarded };
});

const WORKFLOW = `schema_version: '1.0'
workflow:
  id: host-home-seam
  inputs:
    - { name: n, type: number }
  nodes:
    - { id: start, type: input }
    - { id: double, type: transform, transform: '({ d: inputs.n * 2 })' }
    - { id: out, type: output }
  edges:
    - { from: start, to: double }
    - { from: double, to: out }
`;

let root: string;
let home: string;
let client: DbClient;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-run-host-seam-'));
  home = join(root, 'operator-home');
  mkdirSync(join(home, '.relavium'), { recursive: true });
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
  if (client.sqlite.open) client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function hostFor(homeDir: string, cwd: string = root) {
  const f = invocationFixture();
  const builds = vi.fn();
  const host = new RunHost({
    invocation: f.invocation,
    io: captureIo().io,
    global: { json: false, color: false, cwd, configPath: undefined, verbosity: 'normal' },
    db: client.db,
    homeDir,
    buildEngine: (options) => {
      builds();
      return buildEngine(options);
    },
    sweepMedia: () => Promise.resolve(undefined),
  });
  const path = join(root, 'seam.relavium.yaml');
  writeFileSync(path, WORKFLOW);
  return { host, f, builds, path };
}

const messageOf = (launch: HostedLaunch): string =>
  launch.kind === 'refused' ? launch.message : `(${launch.kind})`;

describe('a start leg loads its configuration from the home the host was handed', () => {
  it('reads the marker config of that home: a global config that does not parse refuses the start, naming that file without its absolute path (P1-13)', async () => {
    const marker = join(home, '.relavium', 'config.toml');
    writeFileSync(marker, 'this is = not [valid toml');
    // The project is the directory the operator home sits in, so the marker is named from the project, as a transcript names it.
    const r = hostFor(home);
    const launch = await r.host.start({ workflow: r.path, rawInputs: { n: '3' } });
    expect(launch.kind).toBe('refused');
    expect(launch).toMatchObject({ reason: 'rejected' });
    expect(messageOf(launch), 'the refusal names the temporary home`s own config').toContain(
      join('operator-home', '.relavium', 'config.toml'),
    );
    expect(messageOf(launch), 'and never by its absolute path').not.toContain(marker);
    expect(messageOf(launch)).not.toContain(root);
    expect(messageOf(launch)).not.toContain('real operator home');
    expect(r.builds, 'nothing past the config load ran').not.toHaveBeenCalled();
    expect(r.f.registry.activeOwners).toBe(0);
  });

  it('names a config file of the operator home from `~` when the project is elsewhere, on a start and on a resume (P1-13)', async () => {
    const marker = join(home, '.relavium', 'config.toml');
    writeFileSync(marker, 'this is = not [valid toml');
    const project = join(root, 'project');
    mkdirSync(project);
    const r = hostFor(home, project);
    const started = await r.host.start({ workflow: r.path, rawInputs: { n: '3' } });
    expect(messageOf(started)).toContain(`~${sep}.relavium${sep}config.toml`);
    expect(messageOf(started)).not.toContain(marker);
    expect(messageOf(started)).not.toContain(root);
    // The resume leg loads the same configuration before it looks at the run: its refusal is as path-free.
    const resumed = await r.host.resume({
      runId: 'a-run',
      kind: 'human',
      decision: approvalDecision(),
    });
    expect(resumed).toMatchObject({ kind: 'refused', reason: 'rejected' });
    expect(messageOf(resumed)).toContain(`~${sep}.relavium${sep}config.toml`);
    expect(messageOf(resumed)).not.toContain(marker);
    expect(messageOf(resumed)).not.toContain(root);
    expect(r.f.registry.activeOwners).toBe(0);
  });

  it('with a home that holds a valid config, the same start runs to its end, and never touches the OS home', async () => {
    writeFileSync(join(home, '.relavium', 'config.toml'), '');
    const r = hostFor(home);
    const launch = await r.host.start({ workflow: r.path, rawInputs: { n: '3' } });
    if (launch.kind !== 'started') throw new Error(`expected a started leg: ${messageOf(launch)}`);
    expect((await launch.ended).terminal.disposition).toBe('completed');
    expect(r.builds).toHaveBeenCalledOnce();
  });

  it('a host with no home does not compile: `homeDir` is required, so no leg can fall back to the OS home (H1)', () => {
    // The guard is the type. `Omit<..., 'homeDir'>` is assignable to the options only while `homeDir` is optional, in which case this
    // is `false` and the assignment below is a compile error (the project's typecheck covers test files).
    type HomeDirIsRequired = Omit<RunHostOptions, 'homeDir'> extends RunHostOptions ? false : true;
    const required: HomeDirIsRequired = true;
    expect(required).toBe(true);
  });
});
