/**
 * The Home's launch flow
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §2, §4, §7): the picker, the form, the
 * confirmation that defaults to No, the host's single-flight start, the masked fields, and the MCP consent card of a hosted leg.
 *
 * Most cases run for real: the real native prompt channel (keys go in through `ui.input`, as the host's `useInput` delivers them), the
 * real catalog over a temporary project, the real run host and run core over one in-memory `history.db`. The few that need a host in
 * a state a real run cannot be put in on demand script it. Every operator home is a temporary directory handed in as `homeDir`; the
 * module's two nets (a config load with no home, `os.homedir()`) throw, so no path here reaches the real `~/.relavium`.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, runMigrations, type DbClient } from '@relavium/db';
import { startMcpClient as realStartMcpClient } from '@relavium/mcp';
import type { Key } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEngine, type BuildEngineOptions } from '../engine/build-engine.js';
import { mcpConsentPath } from '../engine/mcp-consent-gate.js';
import { approvalDecision } from '../gate/decision.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { createHomeController } from '../render/tui/home-controller.js';
import {
  createNativePromptChannel,
  type NativePromptSnapshot,
} from '../render/tui/native-prompt-channel.js';
import { captureIo } from '../test-support.js';
import { createGateResumer } from '../render/tui/run-card-model.js';
import { createNativeConsentPrompter } from './consent-card.js';
import { RunHost, type HostedLaunch, type HostedStartRequest } from './run-host.js';
import {
  createProjectCatalog,
  createRunLaunch,
  fieldIssue,
  launchFields,
  LAUNCH_CANCELLED,
  LAUNCH_NO_WORKFLOWS,
  launchAmbiguous,
  launchChanged,
  launchMoved,
  launchNotOffered,
  reduceLaunch,
  type LaunchCatalog,
  type LaunchChoice,
  type LaunchState,
  type RunLaunch,
} from './run-launch.js';
import { parseWorkflow } from '@relavium/core';

let root: string;
/**
 * The home every config load in this file resolves to. `prepareRun` loads its own configuration and has no home seam, so a start
 * leg's load falls back to the home of the rig that was built last; with none, the load throws.
 */
let fallbackHome: string | undefined;
vi.mock('../config/load.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/load.js')>();
  return {
    ...actual,
    loadResolvedConfig: (options: Parameters<typeof actual.loadResolvedConfig>[0]) => {
      const home = options.home ?? fallbackHome;
      if (home === undefined)
        throw new Error('a hosted leg loaded configuration with no test home');
      return actual.loadResolvedConfig({ ...options, home });
    },
  };
});
// The second net: anything that asks the OS for the home directory instead of being handed one is a leak.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const guarded = {
    ...actual,
    homedir: (): string => {
      throw new Error('the launch flow reached the real operator home through os.homedir()');
    },
  };
  return { ...guarded, default: guarded };
});

let client: DbClient;
const scratch: string[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-run-launch-'));
  mkdirSync(join(root, '.relavium', 'workflows'), { recursive: true });
  client = createClient(':memory:');
  runMigrations(client.db);
  fallbackHome = undefined;
});
afterEach(() => {
  if (client.sqlite.open) client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  fallbackHome = undefined;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------------
// Workflows.
// ---------------------------------------------------------------------------------------------------------------------

/** One declared number, no provider: a run completes on its own. */
const HAPPY = `schema_version: '1.0'
workflow:
  id: host-happy
  inputs:
    - { name: n, type: number, required: true }
  nodes:
    - { id: start, type: input }
    - { id: double, type: transform, transform: '({ d: inputs.n * 2 })' }
    - { id: out, type: output }
  edges:
    - { from: start, to: double }
    - { from: double, to: out }
`;

/** No inputs at all: the form has nothing to ask and goes straight to the confirmation. */
const NO_INPUTS = `schema_version: '1.0'
workflow:
  id: no-inputs
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;

/** A number and a required secret. */
const SECRET_RUN = HAPPY.replace(
  '    - { name: n, type: number, required: true }',
  '    - { name: n, type: number, required: true }\n    - { name: token, type: secret, required: true }',
).replace('id: host-happy', 'id: host-secret');

/** A number and an OPTIONAL secret (an empty answer omits it). */
const OPTIONAL_SECRET = HAPPY.replace(
  '    - { name: n, type: number, required: true }',
  '    - { name: n, type: number, required: true }\n    - { name: token, type: secret }',
).replace('id: host-happy', 'id: host-optional-secret');

/** Parked at a human gate, with one inline stdio MCP server that only the consent gate cares about. */
const MCP_GATED = `schema_version: '1.0'
workflow:
  id: host-mcp
  inputs:
    - { name: n, type: number, required: true }
  agents:
    - id: worker
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: synthetic
      tools: []
      mcp_servers:
        - { id: local, transport: stdio, command: ${JSON.stringify(process.execPath)} }
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: out }
`;

/** Not a workflow: the catalog flags it, the launch does not offer it. */
const BROKEN = `schema_version: '1.0'
workflow:
  id: broken-one
  nodes: []
`;

function writeWorkflow(name: string, yaml: string): void {
  writeFileSync(join(root, '.relavium', 'workflows', name), yaml);
}

// ---------------------------------------------------------------------------------------------------------------------
// Keys, as the host's `useInput` hands them to the channel.
// ---------------------------------------------------------------------------------------------------------------------

const none: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

interface Rig {
  readonly channel: ReturnType<typeof createNativePromptChannel>;
  readonly host: RunHost;
  readonly launch: RunLaunch;
  readonly states: LaunchState[];
  readonly startCalls: { readonly request: HostedStartRequest }[];
  readonly builds: ReturnType<typeof vi.fn>;
  readonly startMcpClient: ReturnType<typeof vi.fn>;
  readonly home: string;
  readonly homeIo: ReturnType<typeof captureIo>;
  readonly snapshots: string[];
  /** The registry's active owners: every leg's owner retires. */
  readonly registry: ReturnType<typeof invocationFixture>['registry'];
}

/** The real thing: a real channel, catalog, run host and run core, over the shared in-memory `history.db`. */
function rig(
  over: {
    readonly consent?: boolean;
    /** Wraps the project's real catalog: a test changes what the catalog says between the list and the read of the picked file. */
    readonly catalog?: (real: LaunchCatalog) => LaunchCatalog;
  } = {},
): Rig {
  const f = invocationFixture();
  const home = mkdtempSync(join(tmpdir(), 'relavium-run-launch-home-'));
  scratch.push(home);
  fallbackHome = home;
  const homeIo = captureIo();
  // Every layer of the chord guard off: the guard is proved in its own tests, and a card here is answered the moment it is up.
  const channel = createNativePromptChannel({
    guard: { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 },
  });
  channel.ui.bindVisibility((snapshot) => snapshot === channel.ui.getSnapshot());
  const snapshots: string[] = [];
  channel.ui.subscribe(() => snapshots.push(JSON.stringify(channel.ui.getSnapshot())));
  const builds = vi.fn();
  const startMcpClient = vi.fn(() => realStartMcpClient([]));
  const host = new RunHost({
    invocation: f.invocation,
    io: homeIo.io,
    global: { json: false, color: false, cwd: root, configPath: undefined, verbosity: 'normal' },
    db: client.db,
    homeDir: home,
    buildEngine: (options?: BuildEngineOptions) => {
      builds();
      return buildEngine(options);
    },
    sweepMedia: vi.fn(() => Promise.resolve(undefined)),
    startMcpClient,
    ...(over.consent === false ? {} : { consent: createNativeConsentPrompter(channel.flow) }),
  });
  const startCalls: Rig['startCalls'] = [];
  const realStart = host.start.bind(host);
  vi.spyOn(host, 'start').mockImplementation((request) => {
    startCalls.push({ request });
    return realStart(request);
  });
  const states: LaunchState[] = [];
  const realCatalog = createProjectCatalog({
    cwd: root,
    projectConfigDir: () => join(root, '.relavium'),
    homeDir: home,
  });
  const launch = createRunLaunch({
    flow: channel.flow,
    host,
    catalog: over.catalog === undefined ? realCatalog : over.catalog(realCatalog),
    observe: (state) => states.push(state),
  });
  return {
    channel,
    host,
    launch,
    states,
    startCalls,
    builds,
    startMcpClient,
    home,
    homeIo,
    snapshots,
    registry: f.registry,
  };
}

const keys = (r: Pick<Rig, 'channel'>) => ({
  type: (text: string): void => {
    for (const ch of text) r.channel.ui.input(ch, none);
  },
  enter: (): boolean => r.channel.ui.input('', { ...none, return: true }),
  up: (): boolean => r.channel.ui.input('', { ...none, upArrow: true }),
  backspace: (): boolean => r.channel.ui.input('', { ...none, backspace: true }),
  esc: (): boolean => r.channel.ui.input('', { ...none, escape: true }),
  ctrlC: (): boolean => r.channel.ui.input('c', { ...none, ctrl: true }),
  ctrlY: (): boolean => r.channel.ui.input('y', { ...none, ctrl: true }),
  ctrlN: (): boolean => r.channel.ui.input('n', { ...none, ctrl: true }),
});

/**
 * The most a wait may take, and how often a wait on a host that publishes no event looks. A wait on the prompt channel does not poll at
 * all: it listens to the channel, so what it waits for is the event itself and the bound is only the failure message's.
 */
const WAIT = { timeout: 5_000, interval: 5 } as const;

/**
 * Wait until the prompt channel shows a snapshot that satisfies `holds`, by listening to the channel, and FAIL with what it last showed
 * when it does not within the bound. Returns that snapshot.
 */
function untilPrompt(
  r: Pick<Rig, 'channel'>,
  holds: (snapshot: NativePromptSnapshot) => boolean,
  what: string,
): Promise<NativePromptSnapshot> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      const last = r.channel.ui.getSnapshot();
      reject(
        new Error(
          `${what} was not shown within ${String(WAIT.timeout)} ms; the prompt shows kind=${last.kind} message=${JSON.stringify(last.message)}`,
        ),
      );
    }, WAIT.timeout);
    const check = (): void => {
      const snapshot = r.channel.ui.getSnapshot();
      if (!holds(snapshot)) return;
      unsubscribe();
      clearTimeout(timer);
      resolve(snapshot);
    };
    unsubscribe = r.channel.ui.subscribe(check);
    check(); // it may already be there
  });
}

/** Wait until the open prompt is of `kind` and its message contains `text`; returns that snapshot. */
function shows(
  r: Pick<Rig, 'channel'>,
  kind: NativePromptSnapshot['kind'],
  text: string,
): Promise<NativePromptSnapshot> {
  return untilPrompt(
    r,
    (snapshot) => snapshot.kind === kind && snapshot.message.includes(text),
    `a ${kind} prompt saying ${JSON.stringify(text)}`,
  );
}

const idle = (r: Rig): Promise<void> =>
  vi.waitFor(() => {
    expect(r.host.snapshot()).toMatchObject({ launching: false, active: undefined });
  }, WAIT);

function runCount(): number {
  const row = client.sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get();
  return typeof row === 'object' && row !== null && 'n' in row && typeof row.n === 'number'
    ? row.n
    : -1;
}

function runStatuses(): unknown[] {
  return client.sqlite
    .prepare('SELECT status FROM runs')
    .all()
    .map((row) => (typeof row === 'object' && row !== null && 'status' in row ? row.status : row));
}

/** Pick the first workflow in the picker and answer the one number field, leaving the confirmation card up. */
async function toConfirmation(r: Rig, value = '3'): Promise<NativePromptSnapshot> {
  const k = keys(r);
  await shows(r, 'select', 'Run which workflow?');
  k.enter();
  await shows(r, 'text', 'Input 1 of 1: n');
  k.type(value);
  k.enter();
  return shows(r, 'select', 'Run ');
}

// ---------------------------------------------------------------------------------------------------------------------

describe('the picker offers only what can run', () => {
  it('lists the valid workflows and says in one line why the broken one is not offered', async () => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    writeWorkflow('not-a-workflow.relavium.yaml', BROKEN);
    const r = rig();
    const opened = r.launch.open();
    const picker = await shows(r, 'select', 'Run which workflow?');
    // Exactly the two valid files, by their ids, in the catalog's order; the broken one is not there.
    expect(picker.options.map((option) => option.label)).toEqual(['host-happy', 'no-inputs']);
    expect(picker.options.map((option) => option.label).join(' ')).not.toContain('not-a-workflow');
    // One line, naming the file (the catalog's id for a file that does not parse is its stem) and the catalog's reason for it.
    expect(picker.note).toContain('Not offered');
    expect(picker.note).toContain('not-a-workflow');
    expect(picker.note).toContain('a workflow must declare at least one node');
    expect(picker.note).not.toContain('\n');
    expect(picker.escape, 'there is nothing to step back to from the picker').toBe('cancel');
    keys(r).esc();
    expect(await opened).toBe(LAUNCH_CANCELLED);
    expect(r.startCalls).toHaveLength(0);
    expect(r.channel.ui.getSnapshot().active, 'the flow is closed').toBe(false);
  });

  it('with no valid workflow, offers nothing, opens no prompt, and gives the reason', async () => {
    writeWorkflow('not-a-workflow.relavium.yaml', BROKEN);
    const r = rig();
    const notice = await r.launch.open();
    expect(notice).toContain(LAUNCH_NO_WORKFLOWS);
    expect(notice).toContain('Not offered');
    expect(notice).toContain('not-a-workflow');
    expect(notice).toContain('a workflow must declare at least one node');
    expect(r.channel.ui.getSnapshot().active, 'no flow was ever opened').toBe(false);
    expect(r.snapshots).toEqual([]);
  });

  it('with no workflows at all, says so', async () => {
    const r = rig();
    expect(await r.launch.open()).toBe(LAUNCH_NO_WORKFLOWS);
    expect(r.startCalls).toHaveLength(0);
  });
});

describe('a double submit starts one run', () => {
  it('two Enters in one tick start exactly one run (one engine built)', async () => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open();
    const card = await toConfirmation(r);
    expect(card.options.map((option) => option.label)).toEqual(['Yes', 'No']);
    k.up(); // a deliberate move to Yes
    expect(r.channel.ui.getSnapshot().selected).toBe(0);

    const session = r.launch.session();
    expect(session?.state().kind, 'the confirmation is the current prompt').toBe('confirming');
    const turn = session?.state().turn ?? -1;
    // One tick, no yield between them: the Enter, a second Enter (a key held down), and two more deliveries of the same answer
    // straight to the machine, as any second path to the confirmation (a repeat, a different host) would make them.
    k.enter();
    k.enter();
    session?.dispatch({ kind: 'confirmed', turn, yes: true });
    session?.dispatch({ kind: 'confirmed', turn, yes: true });

    const notice = await opened;
    expect(notice).toMatch(/^Started host-happy as run /);
    expect(r.startCalls, 'the host was asked once').toHaveLength(1);
    expect(r.builds, 'one engine').toHaveBeenCalledTimes(1);
    expect(runCount(), 'one run').toBe(1);
    // The machine took the one start through its states in order, and never started twice.
    expect(r.states.map((state) => state.kind)).toEqual([
      'picking',
      'asking',
      'confirming',
      'starting',
      'closed',
    ]);
    await idle(r);
    expect(runStatuses()).toEqual(['completed']);
    expect(r.registry.activeOwners, 'the one leg`s owner retired').toBe(0);
  });

  it('the machine alone: a second confirmation in the same tick emits no second start', () => {
    const choice: LaunchChoice = { path: 'w.yaml', slug: 'w', label: 'w' };
    let state: LaunchState = { kind: 'idle', turn: 0 };
    const starts: number[] = [];
    const feed = (event: Parameters<typeof reduceLaunch>[1]): void => {
      const step = reduceLaunch(state, event);
      state = step.state;
      for (const effect of step.effects) if (effect.kind === 'start') starts.push(effect.turn);
    };
    feed({ kind: 'opened', choices: [choice] });
    feed({ kind: 'picked', turn: state.turn, choice, fields: [] });
    expect(state.kind).toBe('confirming');
    const turn = state.turn;
    feed({ kind: 'confirmed', turn, yes: true });
    feed({ kind: 'confirmed', turn, yes: true });
    feed({ kind: 'confirmed', turn: state.turn, yes: true }); // even one aimed at the turn it is now in
    expect(starts).toHaveLength(1);
    expect(state.kind).toBe('starting');
  });

  it('a second open while one is in flight joins it and builds no second prompt', async () => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    const r = rig();
    const first = r.launch.open();
    const second = r.launch.open();
    expect(await Promise.race([second, Promise.resolve('pending')])).toBe('pending');
    await shows(r, 'select', 'Run which workflow?');
    keys(r).esc();
    expect(await first).toBe(LAUNCH_CANCELLED);
    expect(await second).toBe(LAUNCH_CANCELLED);
  });
});

describe('open(slug) starts the form for one workflow (the Defined tab’s r)', () => {
  it('skips the picker: the first prompt is the workflow’s own, and the confirmation still defaults to No', async () => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    const r = rig();
    const opened = r.launch.open('no-inputs');
    const card = await shows(r, 'select', 'Run no-inputs');
    expect(card.options.map((option) => option.label)).toEqual(['Yes', 'No']);
    expect(card.options[card.selected]?.label, 'the cursor is on No').toBe('No');
    keys(r).enter();
    expect(await opened).toBe(LAUNCH_CANCELLED);
    expect(r.startCalls).toHaveLength(0);
    // The picker was never drawn: no snapshot of the whole session asked "which workflow".
    expect(r.snapshots.some((snapshot) => snapshot.includes('Run which workflow?'))).toBe(false);
  });

  it('asks the workflow’s inputs with the workflow’s own validator, and starts exactly once on a deliberate Yes', async () => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open('host-happy');
    await shows(r, 'text', 'Input 1 of 1: n');
    k.type('abc');
    k.enter();
    await untilPrompt(
      r,
      (snapshot) => snapshot.error.includes('decimal number'),
      'the number field`s refusal',
    );
    for (let i = 0; i < 3; i += 1) k.backspace();
    k.type('4');
    k.enter();
    await shows(r, 'select', 'Run host-happy with n=4?');
    const turn = r.launch.session()?.state().turn ?? -1;
    k.up();
    k.enter();
    r.launch.session()?.dispatch({ kind: 'confirmed', turn, yes: true }); // the same answer again, in the same tick
    expect(await opened).toMatch(/^Started host-happy as run /);
    expect(r.startCalls, 'one start').toHaveLength(1);
    expect(r.startCalls[0]?.request.workflow).toBe('.relavium/workflows/happy.relavium.yaml');
    expect(runCount()).toBe(1);
    await idle(r);
  });

  it('Esc at the first field steps back to the picker, which opens on that workflow', async () => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    writeWorkflow('secret.relavium.yaml', SECRET_RUN);
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    const r = rig();
    const opened = r.launch.open('host-secret');
    await shows(r, 'text', 'Input 1 of 2: n');
    keys(r).esc();
    const picker = await shows(r, 'select', 'Run which workflow?');
    expect(picker.options.map((option) => option.label)).toEqual([
      'host-happy',
      'host-secret',
      'no-inputs',
    ]);
    expect(
      picker.options[picker.selected]?.label,
      'the cursor is on the workflow it came from',
    ).toBe('host-secret');
    keys(r).esc();
    expect(await opened).toBe(LAUNCH_CANCELLED);
    expect(r.startCalls).toHaveLength(0);
  });

  it.each([
    ['a slug no file carries', 'ghost'],
    ['a path', '../../x'],
    ['a file that is not a valid workflow', 'broken-one'],
  ])('%s (%s) opens nothing: no flow, no prompt, no load, no run', async (_what, slug) => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    writeWorkflow('not-a-workflow.relavium.yaml', BROKEN);
    // A valid workflow exactly where `workflows/../../x` would land if a slug were ever joined into a path.
    writeFileSync(join(root, 'x.relavium.yaml'), HAPPY.replace('id: host-happy', 'id: x'));
    const r = rig();
    const notice = await r.launch.open(slug);
    expect(notice).toBe(launchNotOffered(slug));
    expect(notice).toMatch(/^Not started\. .* is not a valid workflow of this project\.$/u);
    expect(r.snapshots, 'no prompt was ever published').toEqual([]);
    expect(r.channel.ui.getSnapshot().active, 'no flow was begun').toBe(false);
    expect(r.startCalls).toHaveLength(0);
    expect(r.builds).not.toHaveBeenCalled();
    expect(runCount()).toBe(0);
    expect(r.states, 'the machine never left idle').toEqual([]);
  });

  it('a slug is only compared: one with control characters is shown clean in the notice', async () => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    const r = rig();
    const notice = await r.launch.open('a\u001b[31mb\u202ec');
    expect(notice.includes(String.fromCharCode(0x1b)), 'no escape byte').toBe(false);
    expect(notice.includes(String.fromCharCode(0x202e)), 'no bidi override').toBe(false);
    expect(r.snapshots).toEqual([]);
  });
});

describe('open(slug, path) refuses a slug whose file is not the one the row was listed from', () => {
  /** The path the Defined row carried: the catalog's own, as it listed `none.relavium.yaml` before the file changed. */
  const listed = join('.relavium', 'workflows', 'none.relavium.yaml');

  it('starts the form when the fresh catalog holds the slug in the very file the row named', async () => {
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    const r = rig();
    const opened = r.launch.open('no-inputs', listed);
    await shows(r, 'select', 'Run no-inputs');
    keys(r).enter();
    expect(await opened).toBe(LAUNCH_CANCELLED);
  });

  it('a file that moved: the slug is in another file now, so it refuses with both file names and begins no flow', async () => {
    // The row was listed from `none.relavium.yaml`; by the time `r` is pressed that file is gone and the slug is declared elsewhere.
    const now = join('.relavium', 'workflows', 'none-moved.relavium.yaml');
    writeWorkflow('none-moved.relavium.yaml', NO_INPUTS);
    const r = rig();
    const notice = await r.launch.open('no-inputs', listed);
    expect(notice).toBe(launchMoved('no-inputs', listed, now));
    expect(notice).toMatch(
      /^Not started\. Open the list again: no-inputs is now in none-moved, not none\.$/u,
    );
    expect(r.snapshots, 'no prompt was ever published').toEqual([]);
    expect(r.channel.ui.getSnapshot().active, 'no flow was begun').toBe(false);
    expect(r.startCalls).toHaveLength(0);
    expect(r.builds).not.toHaveBeenCalled();
    expect(runCount()).toBe(0);
    expect(r.states, 'the machine never left idle').toEqual([]);
  });

  it('a file that changed its id: the slug now belongs to a second file, and the row’s file is not confirmed in its place', async () => {
    // `none.relavium.yaml` now declares another id, and a second file took `no-inputs`.
    writeWorkflow('none.relavium.yaml', NO_INPUTS.replace('id: no-inputs', 'id: renamed'));
    writeWorkflow('took-the-slug.relavium.yaml', NO_INPUTS);
    const r = rig();
    const notice = await r.launch.open('no-inputs', listed);
    expect(notice).toBe(
      launchMoved(
        'no-inputs',
        listed,
        join('.relavium', 'workflows', 'took-the-slug.relavium.yaml'),
      ),
    );
    expect(r.snapshots).toEqual([]);
    expect(r.startCalls).toHaveLength(0);
  });

  it('a path that never was a catalog path is only compared: it names no file and opens nothing', async () => {
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    writeFileSync(join(root, 'x.relavium.yaml'), NO_INPUTS.replace('id: no-inputs', 'id: x'));
    const r = rig();
    const notice = await r.launch.open('no-inputs', '../../x.relavium.yaml');
    expect(notice).toBe(launchMoved('no-inputs', '../../x.relavium.yaml', listed));
    expect(r.snapshots).toEqual([]);
    expect(r.startCalls).toHaveLength(0);
  });
});

describe('the file that is read for the pick must still declare the id it was listed under', () => {
  /** A catalog that lists the workflow as `no-inputs`, and has its file declare another id by the time the file is read. */
  const changesIdBeforeRead = (real: LaunchCatalog): LaunchCatalog => ({
    list: () => real.list(),
    load: (path) => {
      writeWorkflow('none.relavium.yaml', NO_INPUTS.replace('id: no-inputs', 'id: renamed'));
      return real.load(path);
    },
  });

  it('refuses a slug that was asked for (the Defined tab’s `r`), names the id the file declares now, and shows no form or confirmation', async () => {
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    const r = rig({ catalog: changesIdBeforeRead });
    const notice = await r.launch.open('no-inputs');
    expect(notice).toBe(launchChanged('no-inputs', 'renamed'));
    expect(notice).toMatch(/^Not started\. Open the list again: .* declares renamed now\.$/u);
    // The flow was begun (the channel says it is busy while the file is read), but no question or card was ever put up for the changed file.
    const shown = r.snapshots.map((snapshot) => (JSON.parse(snapshot) as { kind: string }).kind);
    expect(shown.filter((kind) => kind !== 'busy' && kind !== 'idle')).toEqual([]);
    expect(r.states.map((state) => state.kind)).not.toContain('confirming');
    expect(r.states.map((state) => state.kind)).not.toContain('asking');
    expect(r.startCalls).toHaveLength(0);
    expect(r.builds).not.toHaveBeenCalled();
    expect(runCount()).toBe(0);
  });

  it('refuses a workflow picked from the list the same way', async () => {
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    const r = rig({ catalog: changesIdBeforeRead });
    const opened = r.launch.open();
    await shows(r, 'select', 'Run which workflow?');
    keys(r).enter();
    expect(await opened).toBe(launchChanged('no-inputs', 'renamed'));
    expect(r.states.map((state) => state.kind)).not.toContain('confirming');
    expect(r.startCalls).toHaveLength(0);
    expect(runCount()).toBe(0);
  });

  it('starts the form for a file that still declares the id it was listed under', async () => {
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    const r = rig({ catalog: (real) => ({ list: () => real.list(), load: (p) => real.load(p) }) });
    const opened = r.launch.open('no-inputs');
    await shows(r, 'select', 'Run no-inputs');
    keys(r).enter();
    expect(await opened).toBe(LAUNCH_CANCELLED);
  });
});

describe('two files that declare one workflow id', () => {
  it('two files that differ only by suffix keep their suffixes in the refusal, so the two names differ', async () => {
    writeWorkflow('happy.yaml', HAPPY);
    writeWorkflow('happy.relavium.yaml', HAPPY);
    const r = rig();
    const notice = await r.launch.open('host-happy');
    expect([
      'Not started. Rename one of happy.yaml or happy.relavium.yaml: both declare host-happy.',
      'Not started. Rename one of happy.relavium.yaml or happy.yaml: both declare host-happy.',
    ]).toContain(notice);
    expect(r.startCalls).toHaveLength(0);
  });

  it('a file that moved to a name with the same stem is named with its suffix, both ways round', () => {
    const listed = join('.relavium', 'workflows', 'deploy.yaml');
    const now = join('.relavium', 'workflows', 'deploy.relavium.yaml');
    expect(launchMoved('nightly', listed, now)).toBe(
      'Not started. Open the list again: nightly is now in deploy.relavium.yaml, not deploy.yaml.',
    );
    expect(launchMoved('nightly', now, listed)).toBe(
      'Not started. Open the list again: nightly is now in deploy.yaml, not deploy.relavium.yaml.',
    );
  });

  it('make `r` on that id refuse with both file names named, in 78 columns, and begin no flow; another id still starts', async () => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    writeWorkflow('happy-copy.relavium.yaml', HAPPY);
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    const r = rig();
    const notice = await r.launch.open('host-happy');
    // The two paths come in the order the directory listed them, which is the file system's: the sentence is compared in either order.
    const first = join('.relavium', 'workflows', 'happy-copy.relavium.yaml');
    const second = join('.relavium', 'workflows', 'happy.relavium.yaml');
    expect([
      launchAmbiguous('host-happy', first, second),
      launchAmbiguous('host-happy', second, first),
    ]).toContain(notice);
    expect([
      'Not started. Rename one of happy-copy or happy: both declare host-happy.',
      'Not started. Rename one of happy or happy-copy: both declare host-happy.',
    ]).toContain(notice);
    expect(notice.length, 'the row shows all of it').toBeLessThanOrEqual(78);
    expect(r.snapshots, 'no prompt was drawn for either file').toEqual([]);
    expect(r.startCalls).toHaveLength(0);
    // An id only one file declares is not ambiguous.
    const opened = r.launch.open('no-inputs');
    await shows(r, 'select', 'Run no-inputs');
    keys(r).enter();
    expect(await opened).toBe(LAUNCH_CANCELLED);
  });
});

describe('the confirmation defaults to No', () => {
  it('opens on No, and an Enter typed ahead answers No: nothing is started', async () => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    const r = rig();
    const opened = r.launch.open();
    const card = await toConfirmation(r);
    expect(card.options.map((option) => option.label)).toEqual(['Yes', 'No']);
    expect(card.options[card.selected]?.label, 'the cursor is on No').toBe('No');
    expect(card.message).toContain('Run host-happy with n=3?');
    keys(r).enter(); // the Enter that was typed ahead
    expect(await opened).toBe(LAUNCH_CANCELLED);
    expect(r.startCalls).toHaveLength(0);
    expect(r.builds).not.toHaveBeenCalled();
    expect(runCount()).toBe(0);
  });

  it('is No for a workflow with no inputs too: the Enter that picked it, repeated a tick later, lands on No', async () => {
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open();
    await shows(r, 'select', 'Run which workflow?');
    k.enter(); // picks it
    const card = await shows(r, 'select', 'Run no-inputs');
    expect(card.options[card.selected]?.label).toBe('No');
    k.enter(); // the repeat
    expect(await opened).toBe(LAUNCH_CANCELLED);
    expect(r.startCalls).toHaveLength(0);
    expect(runCount()).toBe(0);
  });

  it('answers Yes only to a deliberate move to Yes', async () => {
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open();
    await shows(r, 'select', 'Run which workflow?');
    k.enter();
    await shows(r, 'select', 'Run no-inputs');
    k.up();
    k.enter();
    expect(await opened).toMatch(/^Started no-inputs as run /);
    expect(r.startCalls).toHaveLength(1);
    await idle(r);
  });
});

describe('the form validates with the workflow`s own validator', () => {
  it('refuses a value of the wrong type in the field, and takes the right one', async () => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open();
    await shows(r, 'select', 'Run which workflow?');
    k.enter();
    await shows(r, 'text', 'Input 1 of 1: n (number, required)');
    k.type('abc');
    k.enter();
    await untilPrompt(
      r,
      (snapshot) => snapshot.error.includes('decimal number'),
      'the number field`s refusal',
    );
    expect(r.channel.ui.getSnapshot().kind, 'still at the field').toBe('text');
    for (let i = 0; i < 3; i += 1) k.backspace();
    k.type('7');
    k.enter();
    const card = await shows(r, 'select', 'Run host-happy with n=7?');
    expect(card.options[card.selected]?.label).toBe('No');
    k.enter();
    expect(await opened).toBe(LAUNCH_CANCELLED);
  });

  it('a required input cannot be left empty; an optional one can, and is omitted', () => {
    const def = parseWorkflow(HAPPY);
    const [field] = launchFields(def);
    expect(field).toMatchObject({ name: 'n', required: true, secret: false });
    if (field === undefined) throw new Error('no field');
    expect(fieldIssue(def, field, '')).toBe('A value is required.');
    expect(fieldIssue(def, field, '3')).toBeUndefined();
    expect(fieldIssue(def, field, 'x')).toContain('decimal number');
    expect(fieldIssue(def, { ...field, required: false }, '')).toBeUndefined();
  });

  it('shows what the author wrote through the sanitize floor, and never a secret`s default', () => {
    const def = parseWorkflow(
      HAPPY.replace(
        '    - { name: n, type: number, required: true }',
        '    - { name: n, type: string, description: "hello \\e[31mred\\e[0m \\u202eevil" }\n    - { name: k, type: secret, description: \'API key\' }',
      ),
    );
    const [first, second] = launchFields(def);
    expect(first?.label).not.toContain('\u001b');
    expect(first?.label).not.toContain('\u202e');
    expect(second).toMatchObject({ secret: true, required: false });
    expect(second?.label).toContain('secret');
  });
});

describe('a masked value stays out of everything', () => {
  const SECRET = 'tok-9f3a-LAUNCH-SECRET-77c1';

  /** Every column of every table, as one string: whatever the Home wrote to `history.db`. */
  function wholeDatabase(): string {
    const names: string[] = [];
    for (const row of client.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()) {
      if (typeof row === 'object' && row !== null && 'name' in row && typeof row.name === 'string')
        names.push(row.name);
    }
    const chunks: string[] = [];
    for (const name of names) {
      for (const row of client.sqlite.prepare(`SELECT * FROM "${name}"`).all()) {
        chunks.push(
          JSON.stringify(row, (_key, value: unknown) => {
            if (typeof value === 'bigint') return value.toString();
            if (
              typeof value === 'object' &&
              value !== null &&
              'type' in value &&
              value.type === 'Buffer' &&
              'data' in value &&
              Array.isArray(value.data)
            )
              return Buffer.from(value.data as number[]).toString('latin1');
            return value;
          }),
        );
      }
    }
    return chunks.join('\n');
  }

  it('is in no machine state, controller state, notice, history row or log line, and the run still gets it', async () => {
    writeWorkflow('secret.relavium.yaml', SECRET_RUN);
    const r = rig();
    const k = keys(r);
    const logged: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      });
    }
    // The Home's own controller carries the typed `/run`, as the product does.
    const controllerStates: string[] = [];
    const controller = createHomeController({
      doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
      startChat: () => {
        throw new Error('unexpected chat');
      },
      homeStore: {
        read: () => ({
          attention: { gates: [], failedRuns: [] },
          recentSessions: [],
          recentRuns: [],
          recentAgents: [],
          unreadableRunIds: [],
          isEmpty: true,
        }),
      },
      onExit: vi.fn(),
      onError: vi.fn(),
      launchRun: () => r.launch.open(),
    });
    controller.subscribe(() => controllerStates.push(JSON.stringify(controller.getSnapshot())));
    controller.handlePaste('/run');
    controller.handleKey('', { return: true });
    expect(controller.getSnapshot().nativeActionBusy).toBe(true);

    await shows(r, 'select', 'Run which workflow?');
    k.enter();
    await shows(r, 'text', 'Input 1 of 2: n');
    k.type('3');
    k.enter();
    const field = await shows(r, 'password', 'Input 2 of 2: token (secret, required)');
    expect(field.escape, 'a field steps back on Esc').toBe('back');
    k.type(SECRET);
    // Only dots are on the card, never the value.
    expect(r.channel.ui.getSnapshot().display).toMatch(/^•+$/);
    k.enter();
    const card = await shows(r, 'select', 'Run host-secret with n=3, token=••••?');
    k.up();
    expect(card.options[card.selected]?.label).toBe('No');
    k.enter();

    await vi.waitFor(() => expect(controller.getSnapshot().nativeActionBusy).toBe(false), WAIT);
    expect(controller.getSnapshot().notice).toMatch(/^Started host-secret as run /);
    await idle(r);
    // The run got the secret: it completed. (Blank or missing, the run core would have refused it.)
    expect(runStatuses()).toEqual(['completed']);

    const sinks: Record<string, string> = {
      'the launch machine`s states': JSON.stringify(r.states),
      'every controller state': controllerStates.join('\n'),
      'the controller`s final state': JSON.stringify(controller.getSnapshot()),
      'every prompt snapshot': r.snapshots.join('\n'),
      'the host`s notices': JSON.stringify(r.host.notices.snapshot()),
      'the Home`s stdout and stderr': r.homeIo.out() + r.homeIo.err(),
      'the console': logged.join('\n'),
      'every row of history.db': wholeDatabase(),
    };
    // The Home writes nothing to stdout, stderr or the console while it owns the screen; every other sink must have captured something,
    // or its assertion would hold for the wrong reason.
    const silent = new Set(['the Home`s stdout and stderr', 'the console']);
    for (const [name, text] of Object.entries(sinks)) {
      if (!silent.has(name)) expect(text.length, `${name} was captured`).toBeGreaterThan(0);
      expect(text, name).not.toContain(SECRET);
    }
    // And the secret went through the port exactly once: a second take finds nothing left.
    const request = r.startCalls[0]?.request;
    expect(await request?.secrets?.(['token'])).toEqual({});
  });

  it('Esc at the confirmation steps back to the secret and drops what was typed; the next value is the one the run gets', async () => {
    writeWorkflow('secret.relavium.yaml', OPTIONAL_SECRET);
    // A scripted host: the real one would empty the hold on its own take, and this case reads what the port hands over.
    const taken: Readonly<Record<string, string>>[] = [];
    const host = {
      start: vi.fn(async (request: HostedStartRequest): Promise<HostedLaunch> => {
        taken.push((await request.secrets?.(['token'])) ?? {});
        return { kind: 'refused', reason: 'busy', message: 'A run is already executing: run-1.' };
      }),
    };
    const base = rig();
    const launch = createRunLaunch({
      flow: base.channel.flow,
      host,
      catalog: createProjectCatalog({
        cwd: root,
        projectConfigDir: () => join(root, '.relavium'),
        homeDir: base.home,
      }),
    });
    const k = keys(base);
    const opened = launch.open();
    await shows(base, 'select', 'Run which workflow?');
    k.enter();
    await shows(base, 'text', 'Input 1 of 2: n');
    k.type('5');
    k.enter();
    await shows(base, 'password', 'Input 2 of 2: token');
    k.type('first-secret');
    k.enter();
    await shows(base, 'select', 'Run host-optional-secret with n=5, token=••••?');
    k.esc(); // back to the secret field
    const again = await shows(base, 'password', 'Input 2 of 2: token');
    expect(again.display, 'the field is asked again from nothing').toBe('');
    k.enter(); // empty: an optional secret is omitted
    await shows(base, 'select', 'Run host-optional-secret with n=5, token=(none)?');
    k.up();
    k.enter();
    expect(await opened).toBe('A run is already executing: run-1.');
    // The first secret is gone: stepping back dropped it, so the port had nothing for the host to take.
    expect(taken).toEqual([{}]);
    expect(host.start).toHaveBeenCalledTimes(1);
    expect(host.start.mock.calls[0]?.[0].rawInputs).toEqual({ n: '5' });
  });

  it('Ctrl+C leaves from a field, starts nothing and wipes the value', async () => {
    writeWorkflow('secret.relavium.yaml', SECRET_RUN);
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open();
    await shows(r, 'select', 'Run which workflow?');
    k.enter();
    await shows(r, 'text', 'Input 1 of 2: n');
    k.type('3');
    k.enter();
    await shows(r, 'password', 'Input 2 of 2: token');
    k.type(SECRET);
    // The channel's masked buffer holds the value: one bullet per character is what shows of it.
    expect(r.channel.ui.getSnapshot().display).toBe('•'.repeat(SECRET.length));
    k.ctrlC();
    expect(await opened).toBe(LAUNCH_CANCELLED);
    expect(r.startCalls).toHaveLength(0);
    expect(r.builds).not.toHaveBeenCalled();
    expect(JSON.stringify(r.states) + r.snapshots.join('')).not.toContain(SECRET);
    // Not only free of the value: the buffer that held it is empty, and nothing is left to take it.
    const after = r.channel.ui.getSnapshot();
    expect(after.display, 'the masked buffer is empty').toBe('');
    expect(after.kind).not.toBe('password');
    expect(after.active).toBe(false);
    expect(r.channel.ui.input('', { ...none, return: true }), 'nothing is open to submit it').toBe(
      false,
    );
    expect(r.startCalls, 'and nothing started').toHaveLength(0);
  });
});

describe('what the host says is what the person reads', () => {
  it('shows a refusal as the notice, with the flow closed', async () => {
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    const r = rig();
    const host = {
      start: vi.fn(
        (): Promise<HostedLaunch> =>
          Promise.resolve({
            kind: 'refused',
            reason: 'busy',
            message: 'A run is already executing: run-9.',
          }),
      ),
    };
    const launch = createRunLaunch({
      flow: r.channel.flow,
      host,
      catalog: createProjectCatalog({
        cwd: root,
        projectConfigDir: () => join(root, '.relavium'),
        homeDir: r.home,
      }),
    });
    const k = keys(r);
    const opened = launch.open();
    await shows(r, 'select', 'Run which workflow?');
    k.enter();
    await shows(r, 'select', 'Run no-inputs');
    k.up();
    k.enter();
    expect(await opened).toBe('A run is already executing: run-9.');
    expect(r.channel.ui.getSnapshot().active).toBe(false);
  });
});

describe('the MCP consent card of a hosted leg', () => {
  /** Walk the launch of the MCP workflow to its start, leaving the leg preparing and the consent card up. */
  async function toConsentCard(r: Rig): Promise<{
    readonly opened: Promise<string>;
    readonly card: NativePromptSnapshot;
  }> {
    const k = keys(r);
    const opened = r.launch.open();
    await toConfirmation(r);
    k.up();
    k.enter();
    const card = await shows(r, 'chord', "Allow MCP server 'local'");
    return { opened, card };
  }

  it('opens for a hosted leg that needs consent, and nothing is spawned until it is answered', async () => {
    writeWorkflow('mcp.relavium.yaml', MCP_GATED);
    const r = rig();
    const { opened, card } = await toConsentCard(r);
    expect(card.message).toContain('on this machine');
    expect(card.details.join('\n')).toContain('server');
    expect(r.startMcpClient, 'nothing is started while the card is up').not.toHaveBeenCalled();
    expect(existsSync(mcpConsentPath(r.home)), 'and nothing is recorded').toBe(false);
    keys(r).ctrlY();
    expect(await opened).toMatch(/^Started host-mcp as run /);
    expect(r.startMcpClient).toHaveBeenCalledTimes(1);
    expect(existsSync(mcpConsentPath(r.home)), 'the grant is the per-machine one').toBe(true);
    await idle(r);
    expect(runStatuses()).toEqual(['paused']);
    expect(r.registry.activeOwners).toBe(0);
  });

  it.each([
    ['Ctrl+N', (k: ReturnType<typeof keys>) => k.ctrlN()],
    ['Esc', (k: ReturnType<typeof keys>) => k.esc()],
    ['Ctrl+C', (k: ReturnType<typeof keys>) => k.ctrlC()],
  ])('a refusal (%s) spawns nothing, records nothing and starts no run', async (_name, refuse) => {
    writeWorkflow('mcp.relavium.yaml', MCP_GATED);
    const r = rig();
    const { opened } = await toConsentCard(r);
    refuse(keys(r));
    const notice = await opened;
    expect(notice).toContain('was not approved');
    expect(r.startMcpClient, 'the server was never started').not.toHaveBeenCalled();
    expect(existsSync(mcpConsentPath(r.home)), 'no grant was written').toBe(false);
    expect(runCount(), 'no run was created').toBe(0);
    expect(r.registry.activeOwners).toBe(0);
    expect(r.host.snapshot()).toMatchObject({ launching: false, active: undefined });
    expect(r.channel.ui.getSnapshot().active).toBe(false);
  });

  it('is asked at a resume too: a grant the machine no longer holds is asked about again, through the same card', async () => {
    writeWorkflow('mcp.relavium.yaml', MCP_GATED);
    const r = rig();
    const { opened } = await toConsentCard(r);
    keys(r).ctrlY();
    expect(await opened).toMatch(/^Started host-mcp as run /);
    await idle(r);
    const parked = r.host.snapshot().last;
    expect(parked?.handedOff, 'the leg is parked at its gate').toBe(true);
    // The grant is withdrawn (another terminal, a hand edit): the resumed leg must ask the machine, and it asks through the card.
    rmSync(mcpConsentPath(r.home));
    const answer = createGateResumer({ host: r.host, flow: r.channel.flow })({
      runId: parked?.runId ?? '',
      kind: 'human',
      decision: approvalDecision(),
    });
    await shows(r, 'chord', "Allow MCP server 'local'");
    expect(r.startMcpClient, 'nothing is started while the card is up').toHaveBeenCalledTimes(1);
    keys(r).ctrlY();
    expect(await answer).toMatchObject({ kind: 'started', leg: 'resume' });
    expect(
      r.startMcpClient,
      'the server was started again, once it was approved',
    ).toHaveBeenCalledTimes(2);
    expect(existsSync(mcpConsentPath(r.home)), 'the approval is the per-machine grant again').toBe(
      true,
    );
    expect(r.snapshots.filter((json) => json.includes('"kind":"chord"')).length).toBeGreaterThan(1);
    await idle(r);
    expect(runStatuses()).toEqual(['completed']);
  });

  it('a refusal at a resume starts nothing and leaves the gate pending for another answer', async () => {
    writeWorkflow('mcp.relavium.yaml', MCP_GATED);
    const r = rig();
    const { opened } = await toConsentCard(r);
    keys(r).ctrlY();
    await opened;
    await idle(r);
    const parked = r.host.snapshot().last;
    rmSync(mcpConsentPath(r.home));
    const answer = createGateResumer({ host: r.host, flow: r.channel.flow })({
      runId: parked?.runId ?? '',
      kind: 'human',
      decision: approvalDecision(),
    });
    await shows(r, 'chord', "Allow MCP server 'local'");
    keys(r).ctrlN();
    const refused = await answer;
    expect(refused).toMatchObject({ kind: 'refused', reason: 'rejected' });
    expect(refused.kind === 'refused' ? refused.message : '').toContain('was not approved');
    expect(r.startMcpClient, 'the server was started once, by the start leg').toHaveBeenCalledTimes(
      1,
    );
    expect(existsSync(mcpConsentPath(r.home)), 'a refusal records no grant').toBe(false);
    expect(runStatuses(), 'the gate is still pending').toEqual(['paused']);
    expect(r.registry.activeOwners).toBe(0);
  });

  it('is the only prompt: a host with no card wired opens none and refuses with the digest', async () => {
    writeWorkflow('mcp.relavium.yaml', MCP_GATED);
    const r = rig({ consent: false });
    const k = keys(r);
    const opened = r.launch.open();
    await toConfirmation(r);
    k.up();
    k.enter();
    const notice = await opened;
    expect(notice).toContain('not approved on this machine');
    expect(
      r.snapshots.some((json) => json.includes('"kind":"chord"')),
      'no card ever opened',
    ).toBe(false);
    expect(r.startMcpClient).not.toHaveBeenCalled();
    expect(runCount()).toBe(0);
    expect(r.host.notices.snapshot().join('\n')).toMatch(/v1:[0-9a-f]{64}/);
  });
});
