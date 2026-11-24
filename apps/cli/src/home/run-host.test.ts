/**
 * The Home's leg manager ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md)
 * §1 to §3, §6, §7).
 *
 * Most cases run a REAL leg: the real run core, the real engine and the real run store, over one in-memory
 * `history.db` standing for the Home's own connection, so what is proved (one engine for a double submit, the Home's
 * connection still open after a leg, a refused blank secret, a pause that hands off) is the behaviour the Home will
 * see. The few that need a handle in a state a real run cannot be put on demand (a taken-over run whose last event
 * is a stale pause, a leg held open until cancelled, an ordered teardown) script the handle and keep everything
 * else real.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WorkflowEngine,
  createInMemoryHost,
  type RunDeparture,
  type RunHandle,
} from '@relavium/core';
import { createClient, loadRunSnapshot, runMigrations, type DbClient } from '@relavium/db';
import { startMcpClient as realStartMcpClient } from '@relavium/mcp';
import type { RunDurability, RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEngine, type BuildEngineOptions } from '../engine/build-engine.js';
import {
  appendGrant,
  fingerprint,
  resolveStdioSpawn,
  type ConsentGrant,
} from '../engine/mcp-consent.js';
import { mcpConsentPath } from '../engine/mcp-consent-gate.js';
import { approvalDecision, rejectionDecision } from '../gate/decision.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import { createRunViewFeed } from '../render/tui/run-view-feed.js';
import { createNativeConsentPrompter } from './consent-card.js';
import type { InvocationOwner } from '../process/invocation-registry.js';
import type { RunLifetime } from '../run-core/run-lifetime.js';
import { RunResources } from '../run-core/run-resources.js';
import type { CliIo } from '../process/io.js';
import { captureIo } from '../test-support.js';
import { WORKFLOW_SOURCE_CHANGED, workflowSourceDigest } from '../run-core/source-digest.js';
import {
  RunHost,
  type HostedLaunch,
  type HostedLegEnd,
  type HostedSecretPort,
  type RunHostOptions,
} from './run-host.js';

/** The one named bound of every `vi.waitFor` in this file: a wait that needs it is a defect, not a slow machine. */
const WAIT_MS = 5000;

let root: string;
/**
 * The home every config load in this file resolves to, and what each load saw.
 *
 * A start leg's config load is handed the host's `homeDir` (`PrepareRunDeps.home`), exactly as a resume's is, and
 * `run-host-home-seam.test.ts` proves that with no module mock. This mock stays as the second net for the rigs in this
 * file: a load that arrives with no home falls back to `fallbackHome`, the temporary home of the rig that was built
 * last WITHOUT an explicit `homeDir`, and nothing here replaces a home it was given. With neither, the load throws:
 * there is no path from this file to the operator's real `~/.relavium`.
 */
let fallbackHome: string | undefined;
const configLoads: {
  readonly requestedHome: string | undefined;
  readonly showBanner: boolean | undefined;
}[] = [];
vi.mock('../config/load.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/load.js')>();
  return {
    ...actual,
    loadResolvedConfig: (options: Parameters<typeof actual.loadResolvedConfig>[0]) => {
      const home = options.home ?? fallbackHome;
      if (home === undefined)
        throw new Error('a hosted leg loaded configuration with no test home');
      const loaded = actual.loadResolvedConfig({ ...options, home });
      configLoads.push({ requestedHome: options.home, showBanner: loaded.config.showBanner });
      return loaded;
    },
  };
});
// The second net: anything that asks the OS for the home directory instead of being handed one is a leak.
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

let client: DbClient;
const scratch: string[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-run-host-'));
  client = createClient(':memory:');
  runMigrations(client.db);
  fallbackHome = undefined;
  configLoads.length = 0;
});
afterEach(() => {
  if (client.sqlite.open) client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  fallbackHome = undefined;
  vi.restoreAllMocks();
});

const HAPPY = `schema_version: '1.0'
workflow:
  id: host-happy
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

const GATED = `schema_version: '1.0'
workflow:
  id: host-gated
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

/** A declared secret that the run needs; no provider is needed to complete. */
const SECRET_RUN = HAPPY.replace(
  '    - { name: n, type: number }',
  '    - { name: n, type: number }\n    - { name: token, type: secret, required: true }',
).replace('id: host-happy', 'id: host-secret');

/** A gated run carrying a secret: its durable record holds only the masked slot. */
const GATED_SECRET = GATED.replace(
  '    - { name: n, type: number }',
  '    - { name: n, type: number }\n    - { name: api_key, type: secret }',
).replace('id: host-gated', 'id: host-gated-secret');

/** One inline stdio MCP server, declared by an agent no node uses: only the consent gate cares about it. */
const MCP_GATED = GATED.replace('id: host-gated', 'id: host-mcp').replace(
  '  nodes:',
  `  agents:
    - id: worker
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: synthetic
      tools: []
      mcp_servers:
        - { id: local, transport: stdio, command: ${JSON.stringify(process.execPath)} }
  nodes:`,
);

/** A credential-shaped literal in authored metadata makes the run core write a warning to stderr. */
const AUTHORED_LITERAL = 'sk-runAuthoredSyntheticCredential123456789';
const WITH_LITERAL = HAPPY.replace(
  'id: host-happy',
  `id: host-happy\n  metadata: { private: ${AUTHORED_LITERAL} }`,
);

function writeWorkflow(name: string, yaml: string): string {
  const path = join(root, name);
  writeFileSync(path, yaml);
  return path;
}

interface Rig {
  readonly host: RunHost;
  readonly f: ReturnType<typeof invocationFixture>;
  /** Every owner the host's legs registered, in order. */
  readonly registered: InvocationOwner[];
  readonly homeIo: ReturnType<typeof captureIo>;
  /** How many engines were built. */
  readonly builds: ReturnType<typeof vi.fn>;
  /** The options every engine was built with. */
  readonly engineOptions: (BuildEngineOptions | undefined)[];
  readonly sweepMedia: ReturnType<typeof vi.fn>;
  /** The operator home this rig injected: a temporary directory of its own, removed after the test. */
  readonly home: string;
}

/**
 * A host over the shared in-memory `history.db`, for the project at `cwd`, with an operator home of its own.
 *
 * The home is a fresh temporary directory, handed to the host as `homeDir`. Unless a test names one, it is also the
 * home a start leg's own config load falls back to (see `fallbackHome`), so a start and a resume agree.
 */
function rig(over: Partial<RunHostOptions> = {}, cwd: string = root): Rig {
  const f = invocationFixture();
  const registered: InvocationOwner[] = [];
  const register = f.registry.register.bind(f.registry);
  vi.spyOn(f.registry, 'register').mockImplementation((owner) => {
    registered.push(owner);
    return register(owner);
  });
  const home = over.homeDir ?? mkdtempSync(join(tmpdir(), 'relavium-run-host-home-'));
  if (over.homeDir === undefined) {
    scratch.push(home);
    fallbackHome = home;
  }
  const homeIo = captureIo();
  const builds = vi.fn();
  const engineOptions: (BuildEngineOptions | undefined)[] = [];
  const sweepMedia = vi.fn(() => Promise.resolve(undefined));
  const host = new RunHost({
    invocation: f.invocation,
    io: homeIo.io,
    global: { json: false, color: false, cwd, configPath: undefined, verbosity: 'normal' },
    db: client.db,
    homeDir: home,
    buildEngine: (options?: BuildEngineOptions) => {
      builds();
      engineOptions.push(options);
      return buildEngine(options);
    },
    sweepMedia,
    ...over,
  });
  return { host, f, registered, homeIo, builds, engineOptions, sweepMedia, home };
}

async function started(launch: Promise<HostedLaunch> | HostedLaunch): Promise<HostedLegEnd> {
  const resolved = await launch;
  if (resolved.kind !== 'started')
    throw new Error(`expected a started leg, got ${JSON.stringify(resolved)}`);
  return resolved.ended;
}

function runStatus(runId: string): unknown {
  const row = client.sqlite.prepare('SELECT status FROM runs WHERE id = ?').get(runId);
  return typeof row === 'object' && row !== null && 'status' in row ? row.status : undefined;
}

function runCount(): number {
  const row = client.sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get();
  return typeof row === 'object' && row !== null && 'n' in row && typeof row.n === 'number'
    ? row.n
    : -1;
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------------------------------
// A handle in a state a real run cannot be put on demand.
// ---------------------------------------------------------------------------------------------------

const TS = '2026-11-23T00:00:00.000Z';
type Departure = Exclude<RunDeparture, { readonly kind: 'continue' }>;
const DETACHED: Departure = {
  kind: 'detached',
  moneyDurability: 'durable',
  effectNeedsAttention: false,
};

interface Script {
  readonly terminal: 'paused' | 'cancelled' | 'completed';
  readonly durability?: RunDurability;
  /** The stream stays open until the leg is cancelled, as a leg that is executing does. */
  readonly holdUntilCancel?: boolean;
  readonly record?: (step: string) => void;
}

function scriptedHandle(runId: string, script: Script) {
  let release: () => void = () => undefined;
  const cancelled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const record = script.record ?? (() => undefined);
  let departed = false;
  const cancel = vi.fn(() => {
    record('cancel');
    release();
  });
  const base = { runId, timestamp: TS, sequenceNumber: 1 };
  const events: Readonly<Record<Script['terminal'], RunEvent>> = {
    completed: {
      ...base,
      type: 'run:completed',
      outputs: {},
      totalTokensUsed: { input: 0, output: 0 },
      totalCostMicrocents: 0,
      durationMs: 1,
    },
    paused: { ...base, type: 'run:paused', pendingGateCount: 1, gateIds: ['gate-1'] },
    cancelled: { ...base, type: 'run:cancelled' },
  };
  const handle: RunHandle = {
    runId,
    events: (async function* (): AsyncGenerator<RunEvent> {
      try {
        if (script.holdUntilCancel === true) await cancelled;
        yield events[script.terminal];
      } finally {
        record('stream');
      }
    })(),
    subscribe: () => () => undefined,
    cancel,
    depart: () => {
      // The drive, the epilogue and the host's own read all ask; the departure is one fact, recorded once.
      if (!departed) {
        departed = true;
        record('depart');
      }
      return Promise.resolve(DETACHED);
    },
    whenConsumersReady: () => Promise.resolve(),
    highWaterMark: 256,
    bufferedCount: 0,
    durability: () => script.durability ?? 'durable',
    terminalError: () => undefined,
  };
  return { handle, cancel };
}

/** An engine builder whose engine hands back the scripted handle instead of running the workflow. */
function scriptedBuild(
  handle: RunHandle,
  builds: ReturnType<typeof vi.fn>,
): (options?: BuildEngineOptions) => Promise<WorkflowEngine> {
  return () => {
    builds();
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: { execute: () => Promise.resolve({ kind: 'completed', output: null }) },
    });
    vi.spyOn(engine, 'start').mockReturnValue(handle);
    return Promise.resolve(engine);
  };
}

/** A host whose one leg runs the scripted handle (the workflow file only has to resolve and parse). */
function scriptedRig(script: Script, over: Partial<RunHostOptions> = {}) {
  const probe = scriptedHandle('run-scripted', script);
  const builds = vi.fn();
  const r = rig({ buildEngine: scriptedBuild(probe.handle, builds), ...over });
  const path = writeWorkflow('scripted.relavium.yaml', HAPPY);
  return { ...r, handle: probe.handle, cancel: probe.cancel, scriptedBuilds: builds, path };
}

// ---------------------------------------------------------------------------------------------------

describe('a double submit starts one run', () => {
  it('(a) two start() calls in one tick return one promise and build ONE engine', async () => {
    const r = rig();
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    const request = { workflow: path, rawInputs: { n: '3' } };
    const first = r.host.start(request);
    const second = r.host.start(request);
    expect(second, 'the same promise, not an equal one').toBe(first);
    expect(r.host.snapshot().launching).toBe(true);
    const end = await started(first);
    expect(end.terminal.disposition).toBe('completed');
    expect(r.builds).toHaveBeenCalledTimes(1);
    expect(
      r.registered.map((owner) => owner.kind),
      'one leg, one owner',
    ).toEqual(['workflow']);
    expect(runCount()).toBe(1);
  });

  it('releases the latch once the engine started, and each later leg gets a fresh engine and a fresh owner', async () => {
    const r = rig();
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    const request = { workflow: path, rawInputs: { n: '3' } };
    await started(r.host.start(request));
    expect(r.host.snapshot().launching).toBe(false);
    const second = await started(r.host.start(request));
    expect(second.terminal.disposition).toBe('completed');
    expect(r.builds).toHaveBeenCalledTimes(2);
    expect(r.registered).toHaveLength(2);
    expect(r.registered[0]).not.toBe(r.registered[1]);
    expect(r.f.registry.activeOwners, 'every leg owner retired').toBe(0);
    expect(runCount()).toBe(2);
  });

  it('refuses a resume while a start is in flight, and names nothing it has not got yet', async () => {
    const r = rig();
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    const first = r.host.start({ workflow: path, rawInputs: { n: '3' } });
    const resume = await r.host.resume({
      runId: 'run-x',
      kind: 'human',
      decision: approvalDecision(),
    });
    expect(resume).toEqual({
      kind: 'refused',
      reason: 'busy',
      message: 'A run is already starting.',
    });
    await started(first);
  });
});

describe('one executing leg at a time', () => {
  it('refuses, and never queues, a start or a resume while a leg executes, naming the hosted run', async () => {
    const s = scriptedRig({ terminal: 'cancelled', holdUntilCancel: true });
    const launch = await s.host.start({ workflow: s.path, rawInputs: { n: '3' } });
    if (launch.kind !== 'started') throw new Error('the leg did not start');
    expect(s.host.snapshot().active).toEqual({
      leg: 'start',
      runId: 'run-scripted',
      cancelling: false,
    });
    expect(await s.host.start({ workflow: s.path, rawInputs: { n: '3' } })).toEqual({
      kind: 'refused',
      reason: 'busy',
      message: 'A run is already executing: run-scripted.',
    });
    expect(
      await s.host.resume({ runId: 'run-scripted', kind: 'human', decision: approvalDecision() }),
    ).toMatchObject({ kind: 'refused', reason: 'busy' });
    expect(s.scriptedBuilds, 'the refused requests built nothing').toHaveBeenCalledTimes(1);
    expect(s.host.cancel()).toBe(true);
    const end = await launch.ended;
    expect(end.terminal.disposition).toBe('cancelled');
    expect(s.cancel, 'cancelled once, however often it was asked').toHaveBeenCalledTimes(1);
    expect(s.host.cancel(), 'nothing left to cancel').toBe(false);
    expect(s.host.snapshot()).toMatchObject({ active: undefined, last: end });
  });
});

describe('a run belongs to the workspace it was started in', () => {
  it('(b) refuses a resume for another directory`s run before any work, and builds nothing', async () => {
    const other = mkdtempSync(join(tmpdir(), 'relavium-run-host-other-'));
    scratch.push(other);
    const there = rig({}, other);
    const path = writeWorkflow('gated.relavium.yaml', GATED);
    const parked = await started(there.host.start({ workflow: path, rawInputs: { n: '3' } }));
    expect(parked.handedOff).toBe(true);
    expect(loadRunSnapshot(client.db, parked.runId)?.projectRoot).toBe(other);

    const here = rig({}, root);
    const refused = await here.host.resume({
      runId: parked.runId,
      kind: 'human',
      decision: approvalDecision(),
    });
    expect(refused).toEqual({
      kind: 'refused',
      reason: 'other_project',
      message: 'This run belongs to another directory. Open Home there to answer it.',
    });
    expect(here.builds, 'no engine was built').not.toHaveBeenCalled();
    expect(here.registered, 'no owner was registered').toHaveLength(0);
    expect(here.f.registry.activeOwners).toBe(0);
    expect(here.host.snapshot()).toMatchObject({ launching: false, active: undefined });

    // The run is still parked and answerable from the directory it belongs to.
    const answered = await started(
      there.host.resume({ runId: parked.runId, kind: 'human', decision: approvalDecision() }),
    );
    expect(answered.terminal.disposition).toBe('completed');
  });

  it('leaves a run that does not exist to the resume core, which names it', async () => {
    const r = rig();
    const missing = await r.host.resume({
      runId: 'run-missing',
      kind: 'human',
      decision: approvalDecision(),
    });
    expect(missing).toMatchObject({ kind: 'refused', reason: 'rejected' });
    expect(missing.kind === 'refused' ? missing.message : '').toContain('run-missing');
    expect(r.f.registry.activeOwners).toBe(0);
  });
});

describe('the Home`s own connection', () => {
  it('(c) is still open, and holds the run, after a start leg and after a resume leg close', async () => {
    const r = rig();
    const path = writeWorkflow('gated.relavium.yaml', GATED);
    const parked = await started(r.host.start({ workflow: path, rawInputs: { n: '3' } }));
    expect(client.sqlite.open, 'after the start leg').toBe(true);
    expect(runStatus(parked.runId)).toBe('paused');
    const done = await started(
      r.host.resume({ runId: parked.runId, kind: 'human', decision: approvalDecision() }),
    );
    expect(done.terminal.disposition).toBe('completed');
    expect(client.sqlite.open, 'after the resume leg').toBe(true);
    expect(runStatus(parked.runId)).toBe('completed');
    await r.host.close();
    expect(client.sqlite.open, 'close() never closes the Home`s database').toBe(true);
    expect(client.sqlite.prepare('SELECT 1 AS ok').get()).toEqual({ ok: 1 });
  });

  it('a resume of a run that is already settled is a no-op on the same connection', async () => {
    const r = rig();
    const path = writeWorkflow('gated.relavium.yaml', GATED);
    const parked = await started(r.host.start({ workflow: path, rawInputs: { n: '3' } }));
    await started(
      r.host.resume({ runId: parked.runId, kind: 'human', decision: approvalDecision() }),
    );
    const again = await r.host.resume({
      runId: parked.runId,
      kind: 'human',
      decision: approvalDecision(),
    });
    expect(again).toEqual({ kind: 'settled', message: 'run completed; nothing to resume' });
    expect(client.sqlite.open).toBe(true);
    expect(r.f.registry.activeOwners, 'the idle resume`s owner retired too').toBe(0);
    expect(r.registered).toHaveLength(3);
    expect(r.host.snapshot()).toMatchObject({ active: undefined, launching: false });
  });
});

describe('the injected operator home', () => {
  it('is the home the host`s own config load reads, and the one a resumed leg is built under', async () => {
    // A run parked under one home (the stand-in for the process home: it carries no marker).
    const first = rig();
    const path = writeWorkflow('gated.relavium.yaml', GATED);
    const parked = await started(first.host.start({ workflow: path, rawInputs: { n: '3' } }));
    expect(parked.handedOff).toBe(true);

    // A different home, with a marker in its global config that nothing else in this test can supply.
    const marked = mkdtempSync(join(tmpdir(), 'relavium-run-host-marked-'));
    scratch.push(marked);
    mkdirSync(join(marked, '.relavium'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(marked, '.relavium', 'config.toml'),
      '[preferences]\nshow_banner = false\n',
      {
        mode: 0o600,
      },
    );
    expect(fallbackHome, 'the fallback is still the first rig`s home, not the marked one').toBe(
      first.home,
    );
    const second = rig({ homeDir: marked });
    expect(fallbackHome, 'a named home does not move the fallback').toBe(first.home);
    configLoads.length = 0;

    const done = await started(
      second.host.resume({ runId: parked.runId, kind: 'human', decision: approvalDecision() }),
    );
    expect(done.terminal.disposition).toBe('completed');
    // The host forwarded the home it was given, and the config it loaded is the marked home's.
    expect(configLoads).toEqual([{ requestedHome: marked, showBanner: false }]);
    // The leg was built under that same home, not the process home or the operator's.
    expect(second.engineOptions[0]?.toolEnv?.operatorHomeDir).toBe(marked);
    // Control: the first rig's home has no marker, so it could not have supplied the value.
    expect(first.home).not.toBe(marked);
  });
});

describe('a pause hands off', () => {
  it('ends the leg at the pause, records the handoff, and keeps the run answerable', async () => {
    const r = rig();
    const path = writeWorkflow('gated.relavium.yaml', GATED);
    const end = await started(r.host.start({ workflow: path, rawInputs: { n: '3' } }));
    expect(end).toMatchObject({
      leg: 'start',
      handedOff: true,
      retirement: 'retired',
      fault: undefined,
    });
    expect(end.terminal).toMatchObject({ disposition: 'paused', safety: undefined });
    expect(runStatus(end.runId)).toBe('paused');
    expect(r.f.registry.activeOwners).toBe(0);
    expect(r.f.registry.observations.exitCode(), 'a pause is view state, not an exit').toBe(0);
    expect(r.sweepMedia, 'a pause keeps the run`s media').not.toHaveBeenCalled();
    expect(r.host.snapshot()).toMatchObject({ active: undefined, launching: false, last: end });

    // A rejection continues the run: the author routes on it, so this resumes too.
    const next = await started(
      r.host.resume({ runId: end.runId, kind: 'human', decision: rejectionDecision() }),
    );
    expect(next).toMatchObject({ leg: 'resume', handedOff: false });
    expect(next.terminal.disposition).toBe('completed');
    expect(r.sweepMedia, 'the terminal leg swept').toHaveBeenCalledTimes(1);
  });
});

describe('a secret input', () => {
  const VALUE = 'opaque-host-secret-value';

  it.each(['', '   ', '\t\n'])(
    '(d) is refused by the wrapper when its value is blank (%j), before the run core or an engine sees it',
    async (blank) => {
      const r = rig();
      const path = writeWorkflow('secret.relavium.yaml', SECRET_RUN);
      const port = vi.fn<HostedSecretPort>(() => Promise.resolve({ token: blank }));
      const launch = await r.host.start({
        workflow: path,
        rawInputs: { n: '3' },
        secrets: port,
      });
      expect(launch).toEqual({
        kind: 'refused',
        reason: 'rejected',
        message: 'A secret input cannot be blank.',
      });
      expect(port).toHaveBeenCalledOnce();
      expect(port.mock.calls[0]?.[0], 'asked by declared name').toEqual(['token']);
      expect(r.builds).not.toHaveBeenCalled();
      expect(runCount(), 'no run was created').toBe(0);
      expect(r.f.registry.activeOwners).toBe(0);
    },
  );

  it('passes a value that is not blank and never lets it reach a notice or the end', async () => {
    const r = rig();
    const path = writeWorkflow('secret.relavium.yaml', SECRET_RUN);
    const end = await started(
      r.host.start({
        workflow: path,
        rawInputs: { n: '3' },
        secrets: () => Promise.resolve({ token: VALUE }),
      }),
    );
    expect(end.terminal.disposition).toBe('completed');
    expect(JSON.stringify([end, r.host.notices.snapshot(), r.homeIo.err()])).not.toContain(VALUE);
  });

  it('is not asked for at all when the workflow declares none', async () => {
    const r = rig();
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    const port = vi.fn<HostedSecretPort>(() => Promise.resolve({}));
    await started(r.host.start({ workflow: path, rawInputs: { n: '3' }, secrets: port }));
    expect(port).not.toHaveBeenCalled();
  });

  it('is refused when blank on a resume too, and the gate stays pending for a good answer', async () => {
    const r = rig();
    const path = writeWorkflow('gated-secret.relavium.yaml', GATED_SECRET);
    const parked = await started(
      r.host.start({
        workflow: path,
        rawInputs: { n: '3' },
        secrets: () => Promise.resolve({ api_key: VALUE }),
      }),
    );
    expect(parked.handedOff).toBe(true);
    const buildsBefore = r.builds.mock.calls.length;
    const port = vi.fn<HostedSecretPort>(() => Promise.resolve({ api_key: '  ' }));
    const refused = await r.host.resume({
      runId: parked.runId,
      kind: 'human',
      decision: approvalDecision(),
      secrets: port,
    });
    expect(refused).toEqual({
      kind: 'refused',
      reason: 'rejected',
      message: 'A secret input cannot be blank.',
    });
    expect(port.mock.calls[0]?.[0], 'asked by the masked slot names').toEqual(['api_key']);
    expect(r.builds.mock.calls.length, 'no engine for the refused answer').toBe(buildsBefore);
    expect(runStatus(parked.runId), 'the gate is still pending').toBe('paused');

    const done = await started(
      r.host.resume({
        runId: parked.runId,
        kind: 'human',
        decision: approvalDecision(),
        secrets: () => Promise.resolve({ api_key: VALUE }),
      }),
    );
    expect(done.terminal.disposition).toBe('completed');
    expect(JSON.stringify([done, r.host.notices.snapshot()])).not.toContain(VALUE);
  });
});

describe('the disposition is read from the handle', () => {
  it('(e) a stale pause after a takeover reads as taken over, not as a pause', async () => {
    const s = scriptedRig({ terminal: 'paused', durability: 'uncertain' });
    const end = await started(s.host.start({ workflow: s.path, rawInputs: { n: '3' } }));
    expect(end.terminal).toMatchObject({ disposition: 'taken_over', safety: 6 });
    expect(end.handedOff, 'a fenced run was not handed off by this host').toBe(false);
    expect(
      s.f.registry.observations.exitCode(),
      'the safety fact is published through the owner',
    ).toBe(6);
    expect(s.f.registry.activeOwners).toBe(0);
  });

  it('a pause on a durable handle is a handoff: the last event alone does not decide it', async () => {
    const s = scriptedRig({ terminal: 'paused', durability: 'durable' });
    const end = await started(s.host.start({ workflow: s.path, rawInputs: { n: '3' } }));
    expect(end.terminal.disposition).toBe('paused');
    expect(end.handedOff).toBe(true);
  });

  it('a delivered terminal whose record did not land is held (5), whatever the stream said', async () => {
    const s = scriptedRig({ terminal: 'completed', durability: 'uncertain' });
    const end = await started(s.host.start({ workflow: s.path, rawInputs: { n: '3' } }));
    expect(end.terminal).toMatchObject({ disposition: 'uncertain', safety: 5 });
    expect(end.handedOff).toBe(false);
    expect(s.f.registry.observations.exitCode()).toBe(5);
  });
});

describe('close()', () => {
  it('(f) tears down in the ADR order: cancel, join the stream, depart, close MCP, retire the owner', async () => {
    const steps: string[] = [];
    const record = (step: string): void => {
      steps.push(step);
    };
    class RecordingResources extends RunResources {
      constructor(lifetime: RunLifetime, io: CliIo) {
        super(lifetime, io);
      }
      override async releaseMcp(): Promise<boolean> {
        record('mcp');
        return await super.releaseMcp();
      }
    }
    const s = scriptedRig(
      { terminal: 'cancelled', holdUntilCancel: true, record },
      { createResources: (lifetime, io) => new RecordingResources(lifetime, io) },
    );
    const launch = await s.host.start({ workflow: s.path, rawInputs: { n: '3' } });
    if (launch.kind !== 'started') throw new Error('the leg did not start');
    const owner = s.registered[0];
    if (owner === undefined) throw new Error('no owner was registered');
    void owner.retired.then(() => {
      record('retire');
    });

    await s.host.close();
    await turn();

    expect(steps).toEqual(['cancel', 'stream', 'depart', 'mcp', 'retire']);
    expect((await launch.ended).terminal.disposition).toBe('cancelled');
    expect(s.f.registry.activeOwners).toBe(0);
    expect(client.sqlite.open, 'the Home closes its own database, after close()').toBe(true);
  });

  it('is idempotent, refuses everything afterwards, and touches nothing when idle', async () => {
    const r = rig();
    const first = r.host.close();
    expect(r.host.close()).toBe(first);
    await first;
    expect(r.registered).toHaveLength(0);
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    expect(await r.host.start({ workflow: path, rawInputs: { n: '3' } })).toEqual({
      kind: 'refused',
      reason: 'closing',
      message: 'The Home is closing.',
    });
    expect(
      await r.host.resume({ runId: 'run-x', kind: 'human', decision: approvalDecision() }),
    ).toMatchObject({ kind: 'refused', reason: 'closing' });
    expect(r.builds).not.toHaveBeenCalled();
    expect(client.sqlite.open).toBe(true);
  });

  it('stops a leg that is still preparing, and leaves nothing half-built', async () => {
    let entered: () => void = () => undefined;
    const building = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = rig({
      buildEngine: async (options) => {
        entered();
        await gate;
        return buildEngine(options);
      },
    });
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    const launching = r.host.start({ workflow: path, rawInputs: { n: '3' } });
    await building;
    expect(r.host.snapshot().active).toMatchObject({ leg: 'start', runId: undefined });
    const closing = r.host.close();
    expect(r.host.snapshot().active).toMatchObject({ cancelling: true });
    release();
    expect(await launching).toMatchObject({ kind: 'refused', reason: 'stopped' });
    await closing;
    expect(r.f.registry.activeOwners).toBe(0);
    expect(r.host.snapshot()).toMatchObject({ active: undefined, launching: false });
    expect(runCount(), 'a stopped preparation never started a run').toBe(0);
    expect(client.sqlite.open).toBe(true);
  });
});

describe('a start that cannot start', () => {
  it('is refused with the core`s own words, leaves no owner behind, and frees the host', async () => {
    const r = rig();
    const missing = await r.host.start({
      workflow: join(root, 'missing.relavium.yaml'),
      rawInputs: {},
    });
    expect(missing.kind).toBe('refused');
    if (missing.kind !== 'refused') return;
    expect(missing.reason).toBe('rejected');
    expect(missing.message).not.toBe('');
    expect(r.f.registry.activeOwners).toBe(0);
    expect(r.f.registry.observations.exitCode(), 'an invalid invocation is view state').toBe(0);
    expect(r.host.snapshot()).toMatchObject({
      active: undefined,
      launching: false,
      last: undefined,
    });
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    expect(
      (await started(r.host.start({ workflow: path, rawInputs: { n: '3' } }))).runId,
    ).toBeTruthy();
  });

  it('is unavailable when the Home has no invocation to register a leg with', async () => {
    const r = rig({ invocation: undefined });
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    expect(await r.host.start({ workflow: path, rawInputs: { n: '3' } })).toMatchObject({
      kind: 'refused',
      reason: 'unavailable',
    });
    expect(r.builds).not.toHaveBeenCalled();
  });

  it('is refused, with no owner, once the invocation is terminating', async () => {
    const r = rig();
    void r.f.registry.terminate({ kind: 'normal' });
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    expect(await r.host.start({ workflow: path, rawInputs: { n: '3' } })).toMatchObject({
      kind: 'refused',
      reason: 'closing',
    });
    expect(r.builds).not.toHaveBeenCalled();
    expect(r.f.registry.activeOwners, 'the refused owner left nothing behind').toBe(0);
  });
});

describe('nothing reaches the Home`s terminal', () => {
  it('writes a leg`s stderr lines to the notice ring, and clears them when the next leg starts', async () => {
    const r = rig();
    const path = writeWorkflow('literal.relavium.yaml', WITH_LITERAL);
    await started(r.host.start({ workflow: path, rawInputs: { n: '3' } }));
    const notices = r.host.notices.snapshot();
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.join('\n')).toMatch(/warning/i);
    expect(r.homeIo.err(), 'the Home`s own stderr is untouched').toBe('');
    expect(r.homeIo.out()).toBe('');
    const clean = writeWorkflow('happy.relavium.yaml', HAPPY);
    await started(r.host.start({ workflow: clean, rawInputs: { n: '3' } }));
    expect(r.host.notices.snapshot(), 'a new leg starts with an empty ring').toEqual([]);
  });

  it('writes a taken-over leg`s explanation to the ring, not to a stream', async () => {
    const s = scriptedRig({ terminal: 'paused', durability: 'uncertain' });
    await started(s.host.start({ workflow: s.path, rawInputs: { n: '3' } }));
    expect(s.host.notices.snapshot().join('\n')).toContain('was taken over by another process');
    expect(s.homeIo.err()).toBe('');
  });
});

describe('MCP consent in a hosted leg', () => {
  async function digest(): Promise<{ readonly digest: string; readonly grant: ConsentGrant }> {
    const spawn = await resolveStdioSpawn(
      { serverId: 'local', command: process.execPath, provenance: { kind: 'inline' } },
      root,
    );
    const value = fingerprint(spawn);
    return {
      digest: value,
      grant: {
        v: 1,
        digest: value,
        command: spawn.resolvedCommand,
        args: [...spawn.args],
        envNames: Object.keys(spawn.env),
        cwd: spawn.cwd,
        grantedAt: '2026-11-23T00:00:00.000Z',
      },
    };
  }

  it('refuses a server nothing approved: no prompt, no flag, nothing spawned, the digest in the notices', async () => {
    const startMcpClient = vi.fn(() => realStartMcpClient([]));
    const r = rig({ startMcpClient });
    const path = writeWorkflow('mcp.relavium.yaml', MCP_GATED);
    const launch = await r.host.start({ workflow: path, rawInputs: { n: '3' } });
    expect(launch).toMatchObject({ kind: 'refused', reason: 'rejected' });
    expect(launch.kind === 'refused' ? launch.message : '').toContain(
      'not approved on this machine',
    );
    expect(startMcpClient).not.toHaveBeenCalled();
    expect((await digest()).digest).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(r.host.notices.snapshot().join('\n')).toContain((await digest()).digest);
    expect(runCount()).toBe(0);
    expect(r.f.registry.activeOwners).toBe(0);
  });

  it('keeps the per-machine grant: a server this machine approved starts, and the leg hands off at its gate', async () => {
    const startMcpClient = vi.fn(() => realStartMcpClient([]));
    const r = rig({ startMcpClient });
    const { grant } = await digest();
    appendGrant(mcpConsentPath(r.home), grant);
    const path = writeWorkflow('mcp.relavium.yaml', MCP_GATED);
    const end = await started(r.host.start({ workflow: path, rawInputs: { n: '3' } }));
    expect(startMcpClient).toHaveBeenCalledOnce();
    expect(end.handedOff).toBe(true);
    expect(r.f.registry.activeOwners).toBe(0);
  });
});

describe('the consent card closes with the leg that asked', () => {
  it('stop() while the card is open closes it: the launch ends as stopped, and nothing is spawned', async () => {
    const channel = createNativePromptChannel();
    channel.flow.begin(); // the card opens only while a flow is open
    const startMcpClient = vi.fn(() => realStartMcpClient([]));
    const r = rig({ startMcpClient, consent: createNativeConsentPrompter(channel.flow) });
    const path = writeWorkflow('mcp.relavium.yaml', MCP_GATED);
    const launching = r.host.start({ workflow: path, rawInputs: { n: '3' } });
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('chord'), {
      timeout: WAIT_MS,
    });

    expect(r.host.cancel(), 'a leg is preparing: the stop reaches it').toBe(true);

    // Without the signal the card stays open and the launch waits for the flow's own cancel for ever: the wait is on the launch ending,
    // and it fails, bounded and by name, when it never does.
    let outcome: HostedLaunch | undefined;
    void launching.then((value) => {
      outcome = value;
    });
    await vi.waitFor(
      () => expect(outcome, 'the launch ended once the card was closed').toBeDefined(),
      {
        timeout: WAIT_MS,
      },
    );
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'stopped' });
    expect(channel.ui.getSnapshot().kind, 'the card is gone').not.toBe('chord');
    expect(startMcpClient, 'nothing was spawned').not.toHaveBeenCalled();
    expect(r.f.registry.activeOwners).toBe(0);
    await channel.flow.end();
  });
});

describe('a start is cancelled by the flow that asked for it while it prepares (P1-4)', () => {
  /** The MCP workflow with a secret input, so the leg waits on the secret port BEFORE it reaches the consent gate. */
  const MCP_SECRET = MCP_GATED.replace(
    '    - { name: n, type: number }',
    '    - { name: n, type: number }\n    - { name: token, type: secret }',
  ).replace('id: host-mcp', 'id: host-mcp-secret');

  it('a cancel while the leg waits for a secret ends it as stopped: the consent card never opens, nothing is spawned, no run exists, and the refusal is not "not approved"', async () => {
    const consent = vi.fn(() => Promise.resolve(true));
    const startMcpClient = vi.fn(() => realStartMcpClient([]));
    const r = rig({ startMcpClient, consent });
    const path = writeWorkflow('mcp-secret.relavium.yaml', MCP_SECRET);
    const controller = new AbortController();
    let supply: () => void = () => undefined;
    const supplied = new Promise<void>((resolve) => {
      supply = resolve;
    });
    let asked = false;
    const secrets: HostedSecretPort = async () => {
      asked = true;
      await supplied;
      return { token: 'a-synthetic-secret' };
    };
    const launching = r.host.start({
      workflow: path,
      rawInputs: { n: '3' },
      secrets,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(asked, 'the leg is waiting for the secret').toBe(true), {
      timeout: WAIT_MS,
    });

    controller.abort();
    expect(r.host.snapshot().active?.cancelling, 'the abort stopped the leg').toBe(true);
    supply();

    expect(await launching).toEqual({
      kind: 'refused',
      reason: 'stopped',
      message: 'The run was stopped before it started.',
    });
    expect(
      consent,
      'no card was asked, so no decision the person never saw',
    ).not.toHaveBeenCalled();
    expect(startMcpClient, 'nothing was spawned').not.toHaveBeenCalled();
    expect(existsSync(mcpConsentPath(r.home)), 'no grant was recorded').toBe(false);
    expect(r.builds, 'no engine was built').not.toHaveBeenCalled();
    expect(runCount(), 'no run was created').toBe(0);
    expect(r.f.registry.activeOwners, 'the leg`s owner retired').toBe(0);
    expect(r.host.snapshot()).toMatchObject({ launching: false, active: undefined });
  });

  it('a cancel while the engine is being built ends it as stopped, and the build that finishes afterwards starts nothing', async () => {
    let finishBuild: () => void = () => undefined;
    const building = new Promise<void>((resolve) => {
      finishBuild = resolve;
    });
    const r = rig({
      buildEngine: async (options?: BuildEngineOptions) => {
        await building;
        return buildEngine(options);
      },
    });
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    const controller = new AbortController();
    const launching = r.host.start({
      workflow: path,
      rawInputs: { n: '3' },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(r.host.snapshot().active, 'the leg is preparing').toBeDefined(), {
      timeout: WAIT_MS,
    });
    await turn(); // past the synchronous part: the leg is inside the held build

    controller.abort();
    finishBuild();

    expect(await launching).toMatchObject({ kind: 'refused', reason: 'stopped' });
    expect(runCount(), 'the engine that was built after the cancel never started a run').toBe(0);
    expect(r.f.registry.activeOwners).toBe(0);
    expect(r.host.snapshot()).toMatchObject({
      launching: false,
      active: undefined,
      last: undefined,
    });
  });

  it('a signal that has already aborted stops the leg before it does anything', async () => {
    const r = rig();
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    const controller = new AbortController();
    controller.abort();
    const launch = await r.host.start({
      workflow: path,
      rawInputs: { n: '3' },
      signal: controller.signal,
    });
    expect(launch).toMatchObject({ kind: 'refused', reason: 'stopped' });
    expect(r.builds).not.toHaveBeenCalled();
    expect(runCount()).toBe(0);
    expect(r.f.registry.activeOwners).toBe(0);
  });

  it('once the start has answered, the signal governs nothing: aborting it later does not cancel the started run', async () => {
    const s = scriptedRig({ terminal: 'cancelled', holdUntilCancel: true });
    const controller = new AbortController();
    const launch = await s.host.start({
      workflow: s.path,
      rawInputs: { n: '3' },
      signal: controller.signal,
    });
    if (launch.kind !== 'started') throw new Error('the leg did not start');

    controller.abort();
    await turn();

    expect(s.cancel, 'a started run is the run view`s to cancel').not.toHaveBeenCalled();
    expect(s.host.snapshot().active).toMatchObject({ runId: 'run-scripted', cancelling: false });
    s.host.cancel();
    expect((await launch.ended).terminal.disposition).toBe('cancelled');
  });

  it('a resume answer is stopped by its signal in the same way', async () => {
    const r = rig();
    const path = writeWorkflow('gated.relavium.yaml', GATED);
    const parked = await started(r.host.start({ workflow: path, rawInputs: { n: '3' } }));
    expect(parked.handedOff).toBe(true);
    const buildsBefore = r.builds.mock.calls.length;
    const controller = new AbortController();
    controller.abort();
    const answer = await r.host.resume({
      runId: parked.runId,
      kind: 'human',
      decision: approvalDecision(),
      signal: controller.signal,
    });
    expect(answer).toMatchObject({ kind: 'refused', reason: 'stopped' });
    expect(r.builds.mock.calls.length, 'no engine for a stopped answer').toBe(buildsBefore);
    expect(runStatus(parked.runId), 'the gate is still pending').toBe('paused');
    expect(r.f.registry.activeOwners).toBe(0);
  });
});

describe('the live view holds no frame loop once its leg is over', () => {
  /** The feed's frame timer, counted: how many intervals were started and not stopped. */
  function countedFeed() {
    const state = { running: 0, started: 0 };
    const feed = createRunViewFeed({
      color: () => false,
      everyFrame: () => {
        state.running += 1;
        state.started += 1;
        let live = true;
        return () => {
          if (!live) return;
          live = false;
          state.running -= 1;
        };
      },
    });
    return { feed, state };
  }

  it('a leg that ends while the Home closes never reaches the renderer`s own finalize, and still leaves no interval behind', async () => {
    const { feed, state } = countedFeed();
    const s = scriptedRig(
      { terminal: 'cancelled', holdUntilCancel: true },
      { renderer: feed.renderer },
    );
    const end = started(s.host.start({ workflow: s.path, rawInputs: { n: '3' } }));
    await vi.waitFor(() => expect(state.started).toBe(1), { timeout: WAIT_MS });
    expect(state.running, 'the leg runs: its frame loop does').toBe(1);
    await s.host.close();
    expect((await end).terminal.disposition).toBe('cancelled');
    expect(state.running, 'the leg is over: so is its loop').toBe(0);
  });

  it('a leg that ends in a fault leaves no interval behind either', async () => {
    const { feed, state } = countedFeed();
    const s = scriptedRig(
      { terminal: 'completed' },
      {
        renderer: (leg) => {
          const inner = feed.renderer(leg);
          return {
            ...inner,
            onEvent: () => {
              throw new Error('PRIVATE_RENDER_FAULT');
            },
          };
        },
      },
    );
    const end = await started(s.host.start({ workflow: s.path, rawInputs: { n: '3' } }));
    expect(end.fault).toBeDefined();
    expect(state.started).toBe(1);
    expect(state.running).toBe(0);
  });
});

describe('a fault that ends a leg', () => {
  it('is recorded on the end, not thrown; the owner retires and the fault is the Home`s infrastructure fact', async () => {
    const s = scriptedRig(
      { terminal: 'completed' },
      {
        renderer: () => ({
          onEvent: () => {
            throw new Error('PRIVATE_RENDER_FAULT');
          },
        }),
      },
    );
    const end = await started(s.host.start({ workflow: s.path, rawInputs: { n: '3' } }));
    expect(end.terminal.disposition).toBe('failed');
    expect(typeof end.fault).toBe('string');
    expect(JSON.stringify(end)).not.toContain('PRIVATE_RENDER_FAULT');
    expect(s.f.registry.observations.hasInfrastructureFailure()).toBe(true);
    expect(s.f.registry.activeOwners).toBe(0);
    expect(s.host.snapshot()).toMatchObject({ active: undefined, last: end });
  });
});

describe('the cleanup tail of a leg (P02a-2) and its departure (M-Ho1)', () => {
  it('a renderer whose seal throws still ends the leg: the host is idle, the owner retired, a later leg may start, and the terminal card is the run`s', async () => {
    const s = scriptedRig(
      { terminal: 'completed' },
      {
        renderer: () => ({
          onEvent: () => undefined,
          seal: () => {
            throw new Error('PRIVATE_SEAL_FAULT');
          },
        }),
      },
    );
    const end = await started(s.host.start({ workflow: s.path, rawInputs: { n: '3' } }));

    expect(end.terminal.disposition, 'the run completed: the card says so').toBe('completed');
    expect(end.fault, 'the seal fault is the leg`s own fault').toBeDefined();
    expect(JSON.stringify([end, s.host.notices.snapshot()])).not.toContain('PRIVATE_SEAL_FAULT');
    expect(s.host.snapshot(), 'the leg is over').toMatchObject({
      launching: false,
      active: undefined,
      last: end,
    });
    expect(end.retirement).toBe('retired');
    expect(s.f.registry.activeOwners, 'the owner finished').toBe(0);
    expect(
      s.f.registry.observations.hasInfrastructureFailure(),
      'the fault is the Home`s fact',
    ).toBe(true);
    // A later leg is not refused `busy` for a leg that is over.
    const next = await s.host.start({ workflow: s.path, rawInputs: { n: '3' } });
    expect(next).not.toMatchObject({ kind: 'refused', reason: 'busy' });
  });

  it('every step of the tail runs even when an earlier one throws: the MCP release throwing does not skip the seal or the owner', async () => {
    const sealed = vi.fn();
    const s = scriptedRig(
      { terminal: 'completed' },
      {
        renderer: () => ({ onEvent: () => undefined, seal: sealed }),
        createResources: (lifetime, io) => {
          const resources = new RunResources(lifetime, io);
          vi.spyOn(resources, 'releaseMcp').mockRejectedValue(new Error('PRIVATE_RELEASE_FAULT'));
          return resources;
        },
      },
    );
    const end = await started(s.host.start({ workflow: s.path, rawInputs: { n: '3' } }));
    expect(end.fault).toBeDefined();
    expect(sealed, 'the renderer was still sealed').toHaveBeenCalled();
    expect(s.host.snapshot()).toMatchObject({ active: undefined, last: end });
    expect(s.f.registry.activeOwners).toBe(0);
  });

  it('a departure that fails for a leg that was not taken over is a fault, not a disposition', async () => {
    const s = scriptedRig({ terminal: 'completed' });
    let calls = 0;
    const depart = s.handle.depart.bind(s.handle);
    // The drive and `finishLeg` are answered; the host's own read after them is not.
    vi.spyOn(s.handle, 'depart').mockImplementation(() => {
      calls += 1;
      return calls <= 2 ? depart() : Promise.reject(new Error('PRIVATE_LATE_DEPARTURE_FAULT'));
    });
    const end = await started(s.host.start({ workflow: s.path, rawInputs: { n: '3' } }));
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(end.terminal.disposition).toBe('failed');
    expect(end.fault).toBeDefined();
    expect(JSON.stringify(end)).not.toContain('PRIVATE_LATE_DEPARTURE_FAULT');
    expect(s.f.registry.activeOwners).toBe(0);
    expect(s.host.snapshot()).toMatchObject({ launching: false, active: undefined });
  });
});

describe('a start bound to the digest of a confirmed file (LAUNCH-5)', () => {
  it('turns away a file that is not the confirmed one before anything is asked, built or connected', async () => {
    const startMcpClient = vi.fn(() => realStartMcpClient([]));
    const r = rig({ startMcpClient });
    const path = writeWorkflow('mcp.relavium.yaml', MCP_GATED);
    // A server nothing approved would be refused with its digest; the confirmed file is another one, and that is said first.
    const launch = await r.host.start({
      workflow: path,
      rawInputs: { n: '3' },
      expectedSourceDigest: workflowSourceDigest(HAPPY),
    });
    expect(launch).toEqual({
      kind: 'refused',
      reason: 'rejected',
      message: 'The workflow file changed after you confirmed. Open the list again.',
    });
    expect(launch.kind === 'refused' ? launch.message : '').toBe(WORKFLOW_SOURCE_CHANGED);
    expect(startMcpClient).not.toHaveBeenCalled();
    expect(r.builds, 'no engine was built').not.toHaveBeenCalled();
    expect(r.host.notices.snapshot(), 'no consent digest was noticed').toEqual([]);
    expect(runCount()).toBe(0);
    expect(r.f.registry.activeOwners, 'the leg`s owner retired').toBe(0);
    expect(r.host.snapshot()).toMatchObject({ launching: false, active: undefined });
  });

  it('starts the confirmed file, and a start with no digest is unchanged', async () => {
    const r = rig();
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    const bound = await started(
      r.host.start({
        workflow: path,
        rawInputs: { n: '3' },
        expectedSourceDigest: workflowSourceDigest(HAPPY),
      }),
    );
    expect(bound.terminal.disposition).toBe('completed');
    const unbound = await started(r.host.start({ workflow: path, rawInputs: { n: '3' } }));
    expect(unbound.terminal.disposition).toBe('completed');
    expect(runCount()).toBe(2);
    expect(r.builds).toHaveBeenCalledTimes(2);
  });
});
