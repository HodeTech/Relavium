/**
 * The file-system tier a hosted leg's tools run under when nothing chose one
 * ([ADR-0055](../../../../docs/decisions/0055-cli-host-capability-seam-tool-environment-factory.md): `[defaults].fs_scope`, default `sandboxed`).
 *
 * `prepareRun` and `resumeRun` each default the tier with `config.fsScope ?? 'sandboxed'`. A default that quietly widens (`project`, `full`)
 * would hand every workflow that never named a tier a wider jail, and nothing else fails when it does: a run with a tier still runs. So the
 * default is pinned where it is CONSUMED: the options the host hands the engine builder (`BuildEngineOptions.toolEnv`), which is what the
 * shared tool-host factory reads, on a leg that starts a run and on a leg that resumes one.
 *
 * Both legs run the real run core over an in-memory `history.db` with an operator home that is a temporary directory. The control cases
 * name a tier in the project's own config and read it back from the same place, so the default cannot be what an unreachable config
 * layer happened to yield.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEngine, type BuildEngineOptions } from '../engine/build-engine.js';
import { approvalDecision } from '../gate/decision.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import {
  RunHost,
  type HostedLaunch,
  type HostedLegEnd,
  type HostedResumeRequest,
} from './run-host.js';

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

/** One approval gate, so the first leg parks and a second leg can resume it. */
const GATED = `schema_version: '1.0'
workflow:
  id: host-fs-scope
  inputs:
    - { name: n, type: number }
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: double, type: transform, transform: '({ d: inputs.n * 2 })' }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: double }
    - { from: double, to: out }
`;

let root: string;
let home: string;
let project: string;
let client: DbClient;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-run-host-fs-scope-'));
  home = join(root, 'operator-home');
  project = join(root, 'project');
  mkdirSync(join(home, '.relavium'), { recursive: true });
  mkdirSync(join(project, '.relavium'), { recursive: true });
  writeFileSync(join(home, '.relavium', 'config.toml'), '');
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
  if (client.sqlite.open) client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A host for the project, recording the options of every engine it builds. */
function rig() {
  const f = invocationFixture();
  const engineOptions: (BuildEngineOptions | undefined)[] = [];
  const host = new RunHost({
    invocation: f.invocation,
    io: captureIo().io,
    global: {
      json: false,
      color: false,
      cwd: project,
      configPath: undefined,
      verbosity: 'normal',
    },
    db: client.db,
    homeDir: home,
    buildEngine: (options) => {
      engineOptions.push(options);
      return buildEngine(options);
    },
    sweepMedia: () => Promise.resolve(undefined),
  });
  const path = join(project, 'fs-scope.relavium.yaml');
  writeFileSync(path, GATED);
  return { host, engineOptions, path };
}

async function ended(launch: Promise<HostedLaunch>): Promise<HostedLegEnd> {
  const resolved = await launch;
  if (resolved.kind !== 'started')
    throw new Error(`expected a started leg, got ${JSON.stringify(resolved)}`);
  return resolved.ended;
}

/** Park a run at its gate, then answer it: the start leg's options first, the resume leg's second. */
async function startThenResume(r: ReturnType<typeof rig>): Promise<void> {
  const parked = await ended(r.host.start({ workflow: r.path, rawInputs: { n: '3' } }));
  expect(parked.terminal.disposition, 'the first leg parked at its gate').toBe('paused');
  const request: HostedResumeRequest = {
    runId: parked.runId,
    kind: 'human',
    decision: approvalDecision(),
  };
  const done = await ended(r.host.resume(request));
  expect(done.terminal.disposition, 'the second leg ran the far side of the gate').toBe(
    'completed',
  );
}

describe('a leg with no chosen file-system tier runs sandboxed', () => {
  it('a run that is prepared hands the engine the sandboxed tier, jailed to the project it was started in', async () => {
    const r = rig();
    await startThenResume(r);
    expect(r.engineOptions, 'one engine per leg').toHaveLength(2);
    expect(r.engineOptions[0]?.toolEnv).toMatchObject({
      fsScopeTier: 'sandboxed',
      workspaceDir: project,
    });
  });

  it('a run that is resumed hands the engine the sandboxed tier, jailed to the project the run was recorded in', async () => {
    const r = rig();
    await startThenResume(r);
    expect(r.engineOptions, 'one engine per leg').toHaveLength(2);
    expect(r.engineOptions[1]?.toolEnv).toMatchObject({
      fsScopeTier: 'sandboxed',
      workspaceDir: project,
    });
  });
});

describe('control: a tier the project chose is the tier both legs get', () => {
  it('names `project` in the project config, and both the prepared and the resumed leg read it from there', async () => {
    writeFileSync(join(project, '.relavium', 'project.toml'), '[defaults]\nfs_scope = "project"\n');
    const r = rig();
    await startThenResume(r);
    expect(r.engineOptions).toHaveLength(2);
    expect(r.engineOptions[0]?.toolEnv?.fsScopeTier, 'the prepared leg').toBe('project');
    expect(r.engineOptions[1]?.toolEnv?.fsScopeTier, 'the resumed leg').toBe('project');
  });
});
