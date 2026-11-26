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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, runMigrations, type DbClient } from '@relavium/db';
import { startMcpClient as realStartMcpClient } from '@relavium/mcp';
import type { Key } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEngine, type BuildEngineOptions } from '../engine/build-engine.js';
import { appendGrant, fingerprint, resolveStdioSpawn } from '../engine/mcp-consent.js';
import { mcpConsentPath } from '../engine/mcp-consent-gate.js';
import { approvalDecision } from '../gate/decision.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { createHomeController } from '../render/tui/home-controller.js';
import {
  createNativePromptChannel,
  type NativePromptSnapshot,
} from '../render/tui/native-prompt-channel.js';
import { nativePopupGeometry } from '../popups/popup-slot.js';
import { captureIo } from '../test-support.js';
import { createGateResumer } from '../render/tui/run-card-model.js';
import { FS_SCOPE_CHANGED } from '../run-core/prepare-run.js';
import { WORKFLOW_SOURCE_CHANGED, workflowSourceDigest } from '../run-core/source-digest.js';
import { createNativeConsentPrompter } from './consent-card.js';
import {
  HOSTED_RESUME_CANCELLED as RESUME_CANCELLED,
  RunHost,
  type HostedLaunch,
  type HostedStartRequest,
} from './run-host.js';
import {
  createProjectCatalog,
  createRunLaunch,
  fieldIssue,
  launchFields,
  LAUNCH_CANCELLED,
  LAUNCH_NO_WORKFLOWS,
  launchAmbiguous,
  launchAuthorityNote,
  launchBusy,
  launchChanged,
  launchMoved,
  launchNotOffered,
  reduceLaunch,
  type LaunchCatalog,
  type LaunchChoice,
  type LaunchState,
  type RunLaunch,
} from './run-launch.js';
import { parseWorkflow, type WorkflowDefinition } from '@relavium/core';

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

/**
 * A workflow whose own definition carries authority: an inline agent that can run two allowed commands and write files, and declares two
 * MCP servers (one inline, one a registration by name). Nothing runs it in these tests: the confirmation is what they read.
 */
const AUTHORITY = `schema_version: '1.0'
workflow:
  id: host-authority
  inputs:
    - { name: n, type: number, required: true }
  tools:
    allowedCommands: ['npm test', 'git status']
    allowedCommandGlobs: ['make *']
  agents:
    - id: worker
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: synthetic
      tools: [run_command, write_file, read_file]
      mcp_servers:
        - { id: local, transport: stdio, command: ${JSON.stringify(process.execPath)} }
        - { ref: shared-registry }
  nodes:
    - { id: start, type: input }
    - { id: work, type: agent, agent_ref: worker }
    - { id: out, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: out }
`;

/** An agent that only reads, no allowlist, no server: there is nothing to add to the question. */
const READ_ONLY = `schema_version: '1.0'
workflow:
  id: host-read-only
  inputs:
    - { name: n, type: number, required: true }
  agents:
    - id: reader
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: synthetic
      tools: [read_file]
  nodes:
    - { id: start, type: input }
    - { id: read, type: agent, agent_ref: reader }
    - { id: out, type: output }
  edges:
    - { from: start, to: read }
    - { from: read, to: out }
`;

/** Twelve optional text inputs, so the question cannot name them all in its row. */
const MANY_INPUTS = `schema_version: '1.0'
workflow:
  id: host-many
  inputs:
${Array.from({ length: 12 }, (_, index) => `    - { name: field${String(index + 1).padStart(2, '0')}, type: string }`).join('\n')}
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
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

/** The repository's own configuration: `[defaults]` of `.relavium/project.toml`. */
function writeProjectDefaults(defaults: string): void {
  writeFileSync(join(root, '.relavium', 'project.toml'), `[defaults]\n${defaults}\n`);
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
    /** Answers the host's `start` in place of the real host, so a test holds the run at the moment the host has it. */
    readonly start?: (request: HostedStartRequest) => Promise<HostedLaunch>;
    /** Holds the engine's build (the window the leg spends on `Starting the run…`) until it settles. */
    readonly holdBuild?: Promise<void>;
  } = {},
): Rig {
  const f = invocationFixture();
  const home = mkdtempSync(join(tmpdir(), 'relavium-run-launch-home-'));
  scratch.push(home);
  fallbackHome = home;
  const homeIo = captureIo();
  // Every layer of the chord guard off, and the popup's opening settle too: the guards are proved in their own tests (and the `/run` popup's
  // chord in `run-launch-popup.test.ts`), and a prompt here is answered the moment it is up. The clock moves on at every read, so a key always
  // arrives after the frame it answers was shown (the opening guard's rule that a key must come after the popup appeared still holds).
  let tick = 0;
  const channel = createNativePromptChannel({
    guard: { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 },
    settleMs: 0,
    now: () => (tick += 1),
  });
  channel.ui.bindVisibility((snapshot) => snapshot === channel.ui.getSnapshot());
  const snapshots: string[] = [];
  channel.ui.subscribe(() => {
    // The live host's acknowledgement: every frame published is measured and flushed at once.
    channel.ui.shown(channel.ui.getSnapshot());
    snapshots.push(JSON.stringify(channel.ui.getSnapshot()));
  });
  const builds = vi.fn();
  const startMcpClient = vi.fn(() => realStartMcpClient([]));
  const host = new RunHost({
    invocation: f.invocation,
    io: homeIo.io,
    global: { json: false, color: false, cwd: root, configPath: undefined, verbosity: 'normal' },
    db: client.db,
    homeDir: home,
    buildEngine: async (options?: BuildEngineOptions) => {
      builds();
      await over.holdBuild;
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
    return over.start === undefined ? realStart(request) : over.start(request);
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

/** Pick the first workflow in the picker and answer the one number field, leaving the confirmation (the `/run` popup's chord step) up. */
async function toConfirmation(r: Rig, value = '3'): Promise<NativePromptSnapshot> {
  const k = keys(r);
  await shows(r, 'select', 'Run which workflow?');
  k.enter();
  await shows(r, 'text', 'Input 1 of 1: n');
  k.type(value);
  k.enter();
  return shows(r, 'chord', 'Run ');
}

/**
 * The popup's last step when a start failed after it opened (or the project has nothing to run): wait for it, return its sentence, and close it
 * with `Enter`, as a person who read it does. The launch then resolves with `''`: the popup has said it.
 */
async function lastStep(r: Pick<Rig, 'channel'>): Promise<NativePromptSnapshot> {
  const step = await untilPrompt(
    r,
    (snapshot) => snapshot.kind === 'select' && snapshot.final !== undefined,
    'the popup`s last step',
  );
  expect(step.options.map((option) => option.label)).toEqual(['Close']);
  // A lone `Esc` closes it as a step back that aborts nothing (the empty state and a failed start alike: `FramedFlow.fail` with `back`).
  expect(step.escape).toBe('back');
  keys(r).enter();
  return step;
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

  it('offers 60 workflows as a window of the picker at 80x24, pages through it, and runs the one the cursor is on (LAUNCH-4)', async () => {
    for (let index = 0; index < 60; index += 1) {
      const id = `wf-${String(index).padStart(2, '0')}`;
      writeWorkflow(`${id}.relavium.yaml`, NO_INPUTS.replace('id: no-inputs', `id: ${id}`));
    }
    const r = rig();
    // What the live host's acknowledgement binds: how far a page moves the cursor in the window the `/run` popup draws at 80x24.
    const terminal = { cols: 80, rows: 24 };
    const popupLayout = (snapshot: NativePromptSnapshot) =>
      nativePopupGeometry(snapshot, 'overlay', terminal, true).layout;
    r.channel.ui.bindPageRows(() => popupLayout(r.channel.ui.getSnapshot())?.page);
    const opened = r.launch.open();
    const picker = await shows(r, 'select', 'Run which workflow?');
    expect(picker.options).toHaveLength(60);
    expect(picker.popup, 'the picker is the popup`s first step').toMatchObject({
      title: '/run',
      stepIndex: 0,
      stepNames: ['Workflow', 'Inputs', 'Confirm'],
    });
    // The popup cannot hold sixty rows: they are windowed, the first rows and a marker for the rest.
    const layout = popupLayout(picker);
    const window = layout?.lines.filter((line) => line.kind === 'selected' || line.kind === 'row');
    const shown = window?.length ?? 0;
    expect(shown, 'a window, not every row').toBeLessThan(60);
    expect(layout?.lines.at(-1)?.text.trim()).toBe(`▼ ${String(60 - shown)} more`);
    r.channel.ui.input('', { ...none, pageDown: true });
    const paged = r.channel.ui.getSnapshot();
    expect(paged.selected, 'a page moves to the window`s last row').toBe(shown - 1);
    // Enter answers the row the cursor is on: the launch goes on with that workflow, which names itself on the confirmation.
    keys(r).enter();
    const confirmation = await shows(r, 'chord', 'Run ');
    expect(confirmation.message).toContain(paged.options[shown - 1]?.label ?? 'unreachable');
    expect(confirmation.message).toContain(`wf-${String(shown - 1).padStart(2, '0')}`);
    // Esc at the confirmation steps back to the picker; Ctrl+C leaves the flow.
    keys(r).ctrlC();
    expect(await opened).toBe(LAUNCH_CANCELLED);
    expect(r.startCalls).toHaveLength(0);
  });

  it('with no valid workflow, offers nothing to pick and says why in the popup, whole (its empty state, ADR-0148 §5)', async () => {
    writeWorkflow('not-a-workflow.relavium.yaml', BROKEN);
    const r = rig();
    const opened = r.launch.open();
    const empty = await lastStep(r);
    expect(empty.message).toContain(LAUNCH_NO_WORKFLOWS);
    expect(empty.message).toContain('Not offered');
    expect(empty.message).toContain('not-a-workflow');
    expect(empty.message).toContain('a workflow must declare at least one node');
    expect(empty.final, 'an empty project is not a failure').toBe('ok');
    expect(empty.popup).toMatchObject({ title: '/run', stepIndex: 0 });
    expect(await opened, 'the popup said it: nothing more to say').toBe('');
    expect(r.channel.ui.getSnapshot().active, 'the flow is closed').toBe(false);
    expect(
      r.snapshots.some((snapshot) => snapshot.includes('Run which workflow?')),
      'nothing to pick',
    ).toBe(false);
    expect(r.states, 'the machine never left idle').toEqual([]);
  });

  it('with no workflows at all, says so in the popup', async () => {
    const r = rig();
    const opened = r.launch.open();
    expect((await lastStep(r)).message).toBe(LAUNCH_NO_WORKFLOWS);
    expect(await opened).toBe('');
    expect(r.startCalls).toHaveLength(0);
  });
});

describe('a double submit starts one run', () => {
  it('two Ctrl+Y in one tick start exactly one run (one engine built)', async () => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open();
    const card = await toConfirmation(r);
    expect(card.options.map((option) => option.label)).toEqual(['Start it', 'Cancel']);

    const session = r.launch.session();
    expect(session?.state().kind, 'the confirmation is the current prompt').toBe('confirming');
    const turn = session?.state().turn ?? -1;
    // One tick, no yield between them: the Ctrl+Y, a second Ctrl+Y (a key held down), and two more deliveries of the same answer
    // straight to the machine, as any second path to the confirmation (a repeat, a different host) would make them.
    k.ctrlY();
    k.ctrlY();
    session?.dispatch({ kind: 'confirmed', turn, yes: true });
    session?.dispatch({ kind: 'confirmed', turn, yes: true });

    const notice = await opened;
    expect(notice).toMatch(/^Started host-happy · run /);
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
    feed({ kind: 'picked', turn: state.turn, choice, fields: [], sourceDigest: 'd'.repeat(64) });
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

describe('the confirmation is bound to the file it was built from (LAUNCH-5)', () => {
  /** The digest of a file's text, computed here without the module under test. */
  const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
  /** The same id and shape, a different graph: what a writer who edited the file after the confirmation card left behind. */
  const EDITED = HAPPY.replace('inputs.n * 2', 'inputs.n * 3');

  it('refuses a file edited after the confirmation with the sentence, starts nothing, and the list opened again runs the file as it is', async () => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open();
    await toConfirmation(r);
    writeWorkflow('happy.relavium.yaml', EDITED); // the writer, after the card is up
    k.ctrlY(); // a deliberate Ctrl+Y

    // The refusal is said in the popup, whole, on the step it failed at (it is longer than a notification); the launch has nothing more to say.
    const failed = await lastStep(r);
    expect(failed.message).toBe(
      'The workflow file changed after you confirmed. Open the list again.',
    );
    expect(failed.message).toBe(WORKFLOW_SOURCE_CHANGED);
    expect(failed.final).toBe('failed');
    expect(failed.popup?.stepIndex, 'on the Confirm step').toBe(2);
    expect(await opened).toBe('');
    // The host was asked, with the digest of the text the confirmation was built from, and turned the start away.
    expect(r.startCalls).toHaveLength(1);
    expect(r.startCalls[0]?.request.expectedSourceDigest).toBe(sha256(HAPPY));
    expect(r.builds, 'no engine was built').not.toHaveBeenCalled();
    expect(r.startMcpClient, 'no MCP connect').not.toHaveBeenCalled();
    expect(runCount(), 'no run was recorded').toBe(0);
    expect(r.channel.ui.getSnapshot().active, 'the flow is closed').toBe(false);
    expect(r.states.map((state) => state.kind)).toEqual([
      'picking',
      'asking',
      'confirming',
      'starting',
      'closed',
    ]);
    // The flags are clear and the owner retired: nothing of this start is left holding the host.
    await idle(r);
    expect(r.registry.activeOwners).toBe(0);

    // The remedy the sentence names works: the list opened again reads the file as it is now, and that is what is confirmed and run.
    const again = r.launch.open();
    await toConfirmation(r);
    k.ctrlY();
    expect(await again).toMatch(/^Started host-happy · run /);
    expect(r.startCalls[1]?.request.expectedSourceDigest).toBe(sha256(EDITED));
    expect(runCount()).toBe(1);
    await idle(r);
    expect(runStatuses()).toEqual(['completed']);
  });

  it('refuses a change that only adds a character', async () => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open();
    await toConfirmation(r);
    writeWorkflow('happy.relavium.yaml', `${HAPPY}\n`);
    k.ctrlY();
    expect((await lastStep(r)).message).toBe(WORKFLOW_SOURCE_CHANGED);
    expect(await opened).toBe('');
    expect(r.builds).not.toHaveBeenCalled();
    expect(runCount()).toBe(0);
    await idle(r);
  });

  it('starts a file that did not change exactly as before, and the start carries the digest of its exact text (CRLF, a BOM, a decomposed letter)', async () => {
    const BOM = String.fromCharCode(0xfeff);
    const ACUTE = String.fromCharCode(0x0301); // a decomposed é: NFC would change the text
    const text = `${BOM}${HAPPY.replaceAll('\n', '\r\n')}# cafe${ACUTE}  \r\n\r\n`;
    writeWorkflow('happy.relavium.yaml', text);
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open();
    await toConfirmation(r);
    k.ctrlY();
    expect(await opened).toMatch(/^Started host-happy · run /);
    expect(r.startCalls).toHaveLength(1);
    expect(r.startCalls[0]?.request.expectedSourceDigest).toBe(sha256(text));
    expect(r.builds).toHaveBeenCalledTimes(1);
    expect(runCount()).toBe(1);
    await idle(r);
    expect(runStatuses()).toEqual(['completed']);
  });

  it('names the workflow the confirmation binds: a name that changed between the list and the pick is the new name, in the question and in the notice', async () => {
    const named = (name: string): string =>
      HAPPY.replace('id: host-happy', `id: host-happy\n  name: ${name}`);
    writeWorkflow('happy.relavium.yaml', named('Old name'));
    const r = rig({
      catalog: (real) => ({
        list: () => real.list(),
        load: (path) => {
          // The writer, after the list was read and before the pick: the id is kept, the name and the graph are not.
          writeWorkflow(
            'happy.relavium.yaml',
            named('New name').replace('inputs.n * 2', 'inputs.n * 3'),
          );
          return real.load(path);
        },
      }),
    });
    const k = keys(r);
    const opened = r.launch.open();
    const picker = await shows(r, 'select', 'Run which workflow?');
    expect(
      picker.options.map((option) => option.label),
      'the list read says the old name',
    ).toEqual(['Old name']);
    k.enter();
    await shows(r, 'text', 'Input 1 of 1: n');
    k.type('3');
    k.enter();
    const card = await shows(r, 'chord', 'Run ');
    expect(card.message).toBe('Run New name with n=3?');
    expect(card.message).not.toContain('Old name');
    k.ctrlY();
    expect(await opened).toMatch(/^Started New name · run /);
    expect(r.startCalls[0]?.request.expectedSourceDigest).toBe(
      sha256(named('New name').replace('inputs.n * 2', 'inputs.n * 3')),
    );
    await idle(r);
  });

  it('the catalog digests the string it parsed, which is the string the host reads', () => {
    const text = `${HAPPY}# ünïcode\n`;
    writeWorkflow('happy.relavium.yaml', text);
    const home = mkdtempSync(join(tmpdir(), 'relavium-run-launch-home-'));
    scratch.push(home);
    const catalog = createProjectCatalog({
      cwd: root,
      projectConfigDir: () => join(root, '.relavium'),
      homeDir: home,
    });
    const loaded = catalog.load(join('.relavium', 'workflows', 'happy.relavium.yaml'));
    expect(loaded.sourceDigest).toBe(sha256(text));
    expect(loaded.sourceDigest).toBe(workflowSourceDigest(text));
    expect(loaded.definition.workflow.id).toBe('host-happy');
  });

  it('the machine alone: the start effect carries the digest the form was picked with, and no other', () => {
    const choice: LaunchChoice = { path: 'w.yaml', slug: 'w', label: 'w' };
    let state: LaunchState = { kind: 'idle', turn: 0 };
    const digests: string[] = [];
    const feed = (event: Parameters<typeof reduceLaunch>[1]): void => {
      const step = reduceLaunch(state, event);
      state = step.state;
      for (const effect of step.effects)
        if (effect.kind === 'start') digests.push(effect.form.sourceDigest);
    };
    feed({ kind: 'opened', choices: [choice] });
    feed({ kind: 'picked', turn: state.turn, choice, fields: [], sourceDigest: '1'.repeat(64) });
    feed({ kind: 'confirmed', turn: state.turn, yes: true });
    expect(digests).toEqual(['1'.repeat(64)]);
    expect(state.kind).toBe('starting');
  });

  it('a second Ctrl+Y in one tick still starts one run, and it is bound by the one digest', async () => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open();
    await toConfirmation(r);
    k.ctrlY();
    k.ctrlY();
    expect(await opened).toMatch(/^Started host-happy · run /);
    expect(r.startCalls).toHaveLength(1);
    expect(r.startCalls[0]?.request.expectedSourceDigest).toBe(sha256(HAPPY));
    expect(runCount()).toBe(1);
    await idle(r);
  });
});

describe('a stop that reaches a run that is starting ends the flow (LAUNCH-2)', () => {
  /** How long a flow that should have settled may stay pending before the test calls it hung. */
  const HUNG_MS = 1_000;
  const hung = Symbol('the flow never settled');
  const settledWithin = (flow: Promise<string>): Promise<string | symbol> =>
    Promise.race([
      flow,
      new Promise<symbol>((resolve) => setTimeout(() => resolve(hung), HUNG_MS)),
    ]);

  it('the machine alone: a stop while starting closes the flow, wipes the held values and starts nothing more', () => {
    const choice: LaunchChoice = { path: 'w.yaml', slug: 'w', label: 'w' };
    let state: LaunchState = { kind: 'idle', turn: 0 };
    const effects: string[] = [];
    const feed = (event: Parameters<typeof reduceLaunch>[1]): void => {
      const step = reduceLaunch(state, event);
      state = step.state;
      for (const effect of step.effects) effects.push(effect.kind);
    };
    feed({ kind: 'opened', choices: [choice] });
    feed({ kind: 'picked', turn: state.turn, choice, fields: [], sourceDigest: 'd'.repeat(64) });
    feed({ kind: 'confirmed', turn: state.turn, yes: true });
    expect(state.kind).toBe('starting');
    effects.length = 0;

    feed({ kind: 'stop', notice: 'Left it.' });
    expect(state).toMatchObject({ kind: 'closed', notice: 'Left it.' });
    expect(effects, 'the values are wiped, then the flow closes; no second start').toEqual([
      'forget',
      'close',
    ]);
    // The host's answer arrives after the stop: the flow is closed, and it changes nothing.
    effects.length = 0;
    const closed = state;
    feed({ kind: 'launched', turn: closed.turn - 1, notice: 'Started w as run r-1.' });
    feed({ kind: 'stop' });
    expect(state).toBe(closed);
    expect(effects).toEqual([]);
  });

  it('a stop while the host has the start ends the flow with the notice, and the host`s late answer changes nothing', async () => {
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    let release: (launch: HostedLaunch) => void = () => undefined;
    const held = new Promise<HostedLaunch>((resolve) => {
      release = resolve;
    });
    const r = rig({ start: () => held });
    const k = keys(r);
    const opened = r.launch.open();
    await shows(r, 'select', 'Run which workflow?');
    k.enter();
    await shows(r, 'chord', 'Run ');
    k.ctrlY(); // a deliberate Ctrl+Y
    // The answer reaches the machine a microtask later; the host is asked once and then holds the start.
    await vi.waitFor(() => {
      expect(r.startCalls, 'the host was asked once and holds the start').toHaveLength(1);
    }, WAIT);
    const session = r.launch.session();
    expect(session?.state().kind).toBe('starting');

    session?.dispatch({ kind: 'stop' });
    expect(await settledWithin(opened)).toBe(LAUNCH_CANCELLED);
    expect(r.states.map((state) => state.kind)).toEqual([
      'picking',
      'confirming',
      'starting',
      'closed',
    ]);

    release({ kind: 'refused', reason: 'busy', message: 'A run is already starting.' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      r.states.map((state) => state.kind),
      'the late answer is ignored',
    ).toEqual(['picking', 'confirming', 'starting', 'closed']);
    expect(r.startCalls, 'and nothing started twice').toHaveLength(1);
  });

  it('Esc or Ctrl+C on `Starting the run…` closes the flow at once, stops the leg, and the run never starts (P1-4)', async () => {
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = rig({ holdBuild: held });
    const k = keys(r);
    const opened = r.launch.open();
    await shows(r, 'select', 'Run which workflow?');
    k.enter();
    await shows(r, 'chord', 'Run ');
    k.ctrlY(); // a deliberate Ctrl+Y
    // The leg is preparing: the engine is being built and the screen says so.
    await vi.waitFor(() => {
      expect(r.builds, 'the engine build is the held window').toHaveBeenCalledTimes(1);
    }, WAIT);
    expect(r.channel.ui.getSnapshot()).toMatchObject({
      kind: 'busy',
      message: 'Starting the run…',
      escape: 'cancel',
    });
    // The start is the run's, not a step of the popup: the frame is taken away while the host has it (a consent card it raises is a card).
    expect(r.channel.ui.getSnapshot().popup).toBeUndefined();
    expect(r.host.snapshot().launching).toBe(true);

    k.ctrlC();

    expect(await settledWithin(opened), 'the keyboard is the Home`s again').toBe(LAUNCH_CANCELLED);
    expect(r.host.snapshot().active?.cancelling, 'the host leg was told to stop').toBe(true);
    // The build that was in flight finishes AFTER the stop: nothing may start from it.
    release();
    await idle(r);
    expect(runCount(), 'no run was created').toBe(0);
    expect(r.registry.activeOwners, 'the leg`s owner retired').toBe(0);
    expect(r.host.snapshot().last, 'a stopped start is no leg').toBeUndefined();
  });

  it.each([
    ['Esc', (k: ReturnType<typeof keys>) => k.esc()],
    ['Ctrl+C', (k: ReturnType<typeof keys>) => k.ctrlC()],
  ])(
    '%s while an approved MCP server connects stops the connect, and no grant is asked for or recorded (P1-4)',
    async (_name, cancel) => {
      writeWorkflow('mcp.relavium.yaml', MCP_GATED);
      const r = rig();
      // The grant this machine already holds, so no card opens: the leg goes straight to the connect, which hangs until it is aborted.
      const spawn = await resolveStdioSpawn(
        {
          serverId: 'local',
          provenance: { kind: 'inline' },
          command: process.execPath,
        },
        root,
      );
      appendGrant(mcpConsentPath(r.home), {
        v: 1,
        digest: fingerprint(spawn),
        command: spawn.resolvedCommand,
        args: [...spawn.args],
        envNames: [],
        cwd: spawn.cwd,
        grantedAt: '2026-11-24T00:00:00.000Z',
      });
      let connectSignal: AbortSignal | undefined;
      r.startMcpClient.mockImplementation(
        (_configs: unknown, signal?: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            connectSignal = signal;
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      );
      const k = keys(r);
      const opened = r.launch.open();
      await toConfirmation(r);
      k.ctrlY();
      await vi.waitFor(() => {
        expect(r.startMcpClient, 'the leg is connecting').toHaveBeenCalledTimes(1);
      }, WAIT);

      cancel(k);

      expect(await settledWithin(opened)).toBe(LAUNCH_CANCELLED);
      expect(connectSignal?.aborted, 'the connect was told to stop').toBe(true);
      await idle(r);
      expect(runCount(), 'no run was created').toBe(0);
      expect(r.registry.activeOwners).toBe(0);
    },
  );

  it('a Ctrl+Y and a Ctrl+C in one read: the flow is cancelled, the host is never asked, and /run does not hang', async () => {
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open();
    await shows(r, 'select', 'Run which workflow?');
    k.enter();
    await shows(r, 'chord', 'Run ');
    // One read, no yield between them: the Ctrl+Y answers the card, and the Ctrl+C aborts the flow BEFORE the machine has seen the answer.
    k.ctrlY();
    k.ctrlC();

    expect(await settledWithin(opened)).toBe(LAUNCH_CANCELLED);
    expect(
      r.startCalls,
      'the stop arrived before the host`s start: no run is started',
    ).toHaveLength(0);
    expect(r.builds).not.toHaveBeenCalled();
    expect(runCount()).toBe(0);
    expect(r.states.map((state) => state.kind)).toEqual([
      'picking',
      'confirming',
      'starting',
      'closed',
    ]);
    // A second /run is not joined to a dead promise: the flow is over and a new one opens.
    const again = r.launch.open();
    await shows(r, 'select', 'Run which workflow?');
    k.esc();
    expect(await settledWithin(again)).toBe(LAUNCH_CANCELLED);
  });
});

describe('open(slug) starts the form for one workflow (the Defined tab’s r)', () => {
  it('skips the picker: the first prompt is the workflow’s own, and the confirmation is still answered by Ctrl+Y alone', async () => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    const r = rig();
    const opened = r.launch.open('no-inputs');
    const card = await shows(r, 'chord', 'Run no-inputs');
    expect(card.options.map((option) => option.label)).toEqual(['Start it', 'Cancel']);
    keys(r).enter();
    expect(r.channel.ui.getSnapshot().kind, 'an Enter answers nothing').toBe('chord');
    keys(r).ctrlN();
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
    await shows(r, 'chord', 'Run host-happy with n=4?');
    const turn = r.launch.session()?.state().turn ?? -1;
    k.ctrlY();
    r.launch.session()?.dispatch({ kind: 'confirmed', turn, yes: true }); // the same answer again, in the same tick
    expect(await opened).toMatch(/^Started host-happy · run /);
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
    await shows(r, 'chord', 'Run no-inputs');
    keys(r).ctrlN();
    expect(await opened).toBe(LAUNCH_CANCELLED);
  });

  it('a file that moved: the slug is in another file now, so it refuses with both file names and begins no flow', async () => {
    // The row was listed from `none.relavium.yaml`; by the time `r` is pressed that file is gone and the slug is declared elsewhere.
    const now = join('.relavium', 'workflows', 'none-moved.relavium.yaml');
    writeWorkflow('none-moved.relavium.yaml', NO_INPUTS);
    const r = rig();
    const notice = await r.launch.open('no-inputs', listed);
    expect(notice).toBe(launchMoved('no-inputs', now));
    expect(notice).toMatch(
      /^Not started\. Open the list again: no-inputs is now in none-moved\.relavium\.yaml\.$/u,
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
      launchMoved('no-inputs', join('.relavium', 'workflows', 'took-the-slug.relavium.yaml')),
    );
    expect(r.snapshots).toEqual([]);
    expect(r.startCalls).toHaveLength(0);
  });

  it('a path that never was a catalog path is only compared: it names no file and opens nothing', async () => {
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    writeFileSync(join(root, 'x.relavium.yaml'), NO_INPUTS.replace('id: no-inputs', 'id: x'));
    const r = rig();
    const notice = await r.launch.open('no-inputs', '../../x.relavium.yaml');
    expect(notice).toBe(launchMoved('no-inputs', listed));
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
    const opened = r.launch.open('no-inputs');
    // The popup was open (the file is read inside it): the refusal is its last step, on the Workflow step, whole.
    const failed = await lastStep(r);
    expect(failed.message).toBe(launchChanged('no-inputs', 'renamed'));
    expect(failed.message).toMatch(
      /^Not started\. Open the list again: .* declares renamed now\.$/u,
    );
    expect(failed.popup?.stepIndex).toBe(0);
    expect(await opened).toBe('');
    // No question or card was ever put up for the changed file: only the waits and the step that says it was refused.
    const shown = r.snapshots
      .map((snapshot) => JSON.parse(snapshot) as { kind: string; final?: string })
      .filter((snapshot) => snapshot.final === undefined)
      .map((snapshot) => snapshot.kind);
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
    expect((await lastStep(r)).message).toBe(launchChanged('no-inputs', 'renamed'));
    expect(await opened).toBe('');
    expect(r.states.map((state) => state.kind)).not.toContain('confirming');
    expect(r.startCalls).toHaveLength(0);
    expect(runCount()).toBe(0);
  });

  it('starts the form for a file that still declares the id it was listed under', async () => {
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    const r = rig({ catalog: (real) => ({ list: () => real.list(), load: (p) => real.load(p) }) });
    const opened = r.launch.open('no-inputs');
    await shows(r, 'chord', 'Run no-inputs');
    keys(r).ctrlN();
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

  it('a file that moved to a name with the same stem is named with its suffix, so the sentence says which file', () => {
    const listed = join('.relavium', 'workflows', 'deploy.yaml');
    const now = join('.relavium', 'workflows', 'deploy.relavium.yaml');
    expect(launchMoved('nightly', now)).toBe(
      'Not started. Open the list again: nightly is now in deploy.relavium.yaml.',
    );
    expect(launchMoved('nightly', listed)).toBe(
      'Not started. Open the list again: nightly is now in deploy.yaml.',
    );
    expect(launchMoved('nightly', now).length, 'the row shows all of it').toBeLessThanOrEqual(78);
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
    await shows(r, 'chord', 'Run no-inputs');
    keys(r).ctrlN();
    expect(await opened).toBe(LAUNCH_CANCELLED);
  });
});

describe('the confirmation is answered by Ctrl+Y alone (ADR-0148 §3)', () => {
  it('is the popup`s chord step: an Enter typed ahead answers nothing, Ctrl+N cancels, and nothing is started', async () => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    const r = rig();
    const opened = r.launch.open();
    const card = await toConfirmation(r);
    expect(card.kind).toBe('chord');
    expect(card.options.map((option) => option.label)).toEqual(['Start it', 'Cancel']);
    expect(card.popup, 'on the Confirm step').toMatchObject({ title: '/run', stepIndex: 2 });
    expect(card.escape, '`Esc` steps back to the inputs').toBe('back');
    expect(card.message).toContain('Run host-happy with n=3?');
    keys(r).enter(); // the Enter that was typed ahead
    expect(r.channel.ui.getSnapshot().kind, 'an Enter answers nothing').toBe('chord');
    keys(r).ctrlN();
    expect(await opened).toBe(LAUNCH_CANCELLED);
    expect(r.startCalls).toHaveLength(0);
    expect(r.builds).not.toHaveBeenCalled();
    expect(runCount()).toBe(0);
  });

  it('for a workflow with no inputs too: the Enter that picked it, repeated a tick later, answers nothing', async () => {
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open();
    await shows(r, 'select', 'Run which workflow?');
    k.enter(); // picks it
    await shows(r, 'chord', 'Run no-inputs');
    k.enter(); // the repeat
    expect(r.channel.ui.getSnapshot().kind).toBe('chord');
    expect(r.launch.session()?.state().kind).toBe('confirming');
    k.ctrlC();
    expect(await opened).toBe(LAUNCH_CANCELLED);
    expect(r.startCalls).toHaveLength(0);
    expect(runCount()).toBe(0);
  });

  it('starts only on a deliberate Ctrl+Y', async () => {
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open();
    await shows(r, 'select', 'Run which workflow?');
    k.enter();
    await shows(r, 'chord', 'Run no-inputs');
    k.ctrlY();
    expect(await opened).toMatch(/^Started no-inputs · run /);
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
    await shows(r, 'chord', 'Run host-happy with n=7?');
    k.ctrlN();
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
    // The Home's own controller carries the typed `/run`, as the product does, and its one notification channel.
    const controllerStates: string[] = [];
    const notified: string[] = [];
    const controller = createHomeController({
      startChat: () => {
        throw new Error('unexpected chat');
      },
      homeStore: {
        read: () => ({
          attention: { failedRuns: [] },
          recentSessions: [],
          recentRuns: [],
          recentAgents: [],
          unreadableRuns: [],
          totals: { attention: 0, sessions: 0, runs: 0 },
          isEmpty: true,
        }),
      },
      onExit: vi.fn(),
      onError: vi.fn(),
      launchRun: () => r.launch.open(),
      announce: (text) => notified.push(text),
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
    await shows(r, 'chord', 'Run host-secret with n=3, token=••••?');
    k.ctrlY();

    await vi.waitFor(() => expect(controller.getSnapshot().nativeActionBusy).toBe(false), WAIT);
    // The start is one notification on the Home's channel, and the Home's notice is left as it was (ADR-0148 §6).
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatch(/^Started host-secret · run /);
    expect(controller.getSnapshot().notice).toBeUndefined();
    await idle(r);
    // The run got the secret: it completed. (Blank or missing, the run core would have refused it.)
    expect(runStatuses()).toEqual(['completed']);

    const sinks: Record<string, string> = {
      'the launch machine`s states': JSON.stringify(r.states),
      'every controller state': controllerStates.join('\n'),
      'the controller`s final state': JSON.stringify(controller.getSnapshot()),
      'every prompt snapshot': r.snapshots.join('\n'),
      'every notification': notified.join('\n'),
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
    await shows(base, 'chord', 'Run host-optional-secret with n=5, token=••••?');
    k.esc(); // back to the secret field
    const again = await shows(base, 'password', 'Input 2 of 2: token');
    expect(again.display, 'the field is asked again from nothing').toBe('');
    k.enter(); // empty: an optional secret is omitted
    await shows(base, 'chord', 'Run host-optional-secret with n=5, token=(none)?');
    k.ctrlY();
    // The host's refusal came after the popup opened: it is the popup's last step.
    expect((await lastStep(base)).message).toBe('A run is already executing: run-1.');
    expect(await opened).toBe('');
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
  it('shows a refusal in the popup, whole, then the flow is closed', async () => {
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
    await shows(r, 'chord', 'Run no-inputs');
    k.ctrlY();
    // The host's own sentence, whole, as the popup's last step (it came after the popup opened); then the flow is closed.
    const failed = await lastStep(r);
    expect(failed.message).toBe('A run is already executing: run-9.');
    expect(failed.final).toBe('failed');
    expect(await opened).toBe('');
    expect(r.channel.ui.getSnapshot().active).toBe(false);
  });
});

describe('the confirmation says what the run can do (P1-7)', () => {
  /** Pick the one workflow and answer its number field; the confirmation card is up. */
  async function confirmationOf(r: Rig): Promise<NativePromptSnapshot> {
    return toConfirmation(r);
  }
  /** The host's passage: the chord card's facts (it was a note above a Yes/No question before the confirmation became the popup's chord). */
  const facts = (snapshot: NativePromptSnapshot): string => snapshot.details.join(' ');
  const rows = (text: string): number => Math.ceil(text.length / 80);

  it("names the file scope first when the repository sets it, then what the definition grants, in the host's own passage under the question", async () => {
    writeWorkflow('authority.relavium.yaml', AUTHORITY);
    writeProjectDefaults('fs_scope = "full"');
    const r = rig();
    const opened = r.launch.open();
    const card = await confirmationOf(r);
    expect(facts(card)).toBe(
      'File scope: full, set by this repository. This run can run commands, which the file scope does not limit ("npm test", "git status", and 1 more); write files; use MCP servers "local", "shared-registry".',
    );
    expect(card.message, 'the question is its own row, with nothing of the host in it').toBe(
      'Run host-authority with n=3?',
    );
    expect(
      rows(facts(card)) + rows(card.message),
      'the whole card stays far inside 24 rows at 80 columns',
    ).toBeLessThanOrEqual(8);
    expect(card.details, 'one passage, the host`s, never joined to the question').toHaveLength(1);
    keys(r).ctrlN();
    expect(await opened).toBe(LAUNCH_CANCELLED);
    expect(r.startCalls).toHaveLength(0);
    expect(runCount()).toBe(0);
    expect(r.channel.ui.getSnapshot().note, 'the host row does not outlive its card').toBe('');
  });

  it('names only the scope when the definition grants nothing, and only the grants when the scope is the default', async () => {
    writeWorkflow('read.relavium.yaml', READ_ONLY);
    writeProjectDefaults('fs_scope = "project"');
    const scoped = rig();
    const first = scoped.launch.open();
    const card = await confirmationOf(scoped);
    expect(facts(card)).toBe('File scope: project, set by this repository.');
    expect(card.message).toBe('Run host-read-only with n=3?');
    keys(scoped).ctrlN();
    await first;

    rmSync(join(root, '.relavium', 'project.toml'));
    rmSync(join(root, '.relavium', 'workflows', 'read.relavium.yaml'));
    writeWorkflow('authority.relavium.yaml', AUTHORITY);
    const plain = rig();
    const second = plain.launch.open();
    const grants = await confirmationOf(plain);
    expect(facts(grants)).toBe(
      'This run can run commands, which the file scope does not limit ("npm test", "git status", and 1 more); write files; use MCP servers "local", "shared-registry".',
    );
    expect(grants.message).toBe('Run host-authority with n=3?');
    keys(plain).ctrlN();
    await second;
  });

  it('adds nothing for a workflow that only reads inside its workspace, and nothing for a scope the repository set to the default', async () => {
    writeWorkflow('read.relavium.yaml', READ_ONLY);
    writeProjectDefaults('fs_scope = "sandboxed"');
    const r = rig();
    const opened = r.launch.open();
    const card = await confirmationOf(r);
    expect(card.details, 'no host passage at all').toEqual([]);
    expect(card.message, 'the question is exactly what it always was').toBe(
      'Run host-read-only with n=3?',
    );
    keys(r).ctrlN();
    await opened;
  });

  it('does not say a grant that cannot run: run_command with no allowlist is disabled, so it is not named', async () => {
    writeWorkflow(
      'authority.relavium.yaml',
      AUTHORITY.replace(
        "  tools:\n    allowedCommands: ['npm test', 'git status']\n    allowedCommandGlobs: ['make *']\n",
        '  tools: {}\n',
      ),
    );
    const r = rig();
    const opened = r.launch.open();
    const card = await confirmationOf(r);
    expect(facts(card)).not.toContain('run commands');
    expect(facts(card)).toContain('write files');
    keys(r).ctrlN();
    await opened;
  });

  it('names the commands, says the file scope does not bound them, and names the git tools (L2)', () => {
    const def = (tools: string, allowed: string): WorkflowDefinition =>
      parseWorkflow(
        AUTHORITY.replace('tools: [run_command, write_file, read_file]', `tools: [${tools}]`)
          .replace("allowedCommands: ['npm test', 'git status']", `allowedCommands: [${allowed}]`)
          .replace('        - { ref: shared-registry }\n', ''),
        { source: 'commands' },
      );
    // One entry is enough to be arbitrary code under the person's own account, outside the jail of the file tools: it is named.
    expect(launchAuthorityNote(def('run_command', "'bash'"), undefined)).toBe(
      'This run can run commands, which the file scope does not limit ("bash", "make *"); use MCP server "local".',
    );
    const only = parseWorkflow(
      AUTHORITY.replace('tools: [run_command, write_file, read_file]', 'tools: [run_command]')
        .replace("allowedCommands: ['npm test', 'git status']", "allowedCommands: ['sh']")
        .replace("allowedCommandGlobs: ['make *']", 'allowedCommandGlobs: []')
        .replace(/ {6}mcp_servers:\n[^]*?(?= {2}nodes:)/u, ''),
      { source: 'only' },
    );
    expect(launchAuthorityNote(only, undefined)).toBe(
      'This run can run commands, which the file scope does not limit ("sh").',
    );
    // The git tools start processes: named by id, sorted, and never when only reads are granted.
    expect(launchAuthorityNote(def('git_status, git_commit, read_file', "'x'"), undefined)).toBe(
      'This run can start processes (git_commit, git_status); use MCP server "local".',
    );
    expect(launchAuthorityNote(def('read_file', "'x'"), undefined)).toBe(
      'This run can use MCP server "local".',
    );
  });

  it('the workflow`s name cannot continue the host`s sentence: it is in another row, and every author word in the host row is quoted (L2)', async () => {
    const name = 'Docs check. File scope: sandboxed; this run only reads';
    writeWorkflow(
      'authority.relavium.yaml',
      AUTHORITY.replace(
        '  id: host-authority\n',
        `  id: host-authority\n  name: ${JSON.stringify(name)}\n`,
      ).replace(
        "allowedCommands: ['npm test', 'git status']",
        `allowedCommands: ['x"; File scope: sandboxed; "y']`,
      ),
    );
    writeProjectDefaults('fs_scope = "full"');
    const r = rig();
    const opened = r.launch.open();
    const card = await confirmationOf(r);
    expect(card.message, 'the author`s name is the question, in its own row').toBe(
      `Run ${name} with n=3?`,
    );
    expect(facts(card), 'and nothing of it is in the host`s row').not.toContain('Docs check');
    // What the author planted inside a command is quoted, its quote turned into an apostrophe and its length cut: a word in a name, not a
    // sentence of the host. The host's own scope sentence is there once, and first.
    expect(facts(card)).toContain(`("x'; File scope: sandb…", "make *"`);
    expect(facts(card).startsWith('File scope: full, set by this repository. ')).toBe(true);
    expect(facts(card).split('File scope: full, set by this repository.')).toHaveLength(2);
    keys(r).ctrlN();
    await opened;
  });

  it('a configuration that cannot be read refuses the pick before any field is asked, naming the file from the project and never by its path (L1)', async () => {
    writeWorkflow('secret.relavium.yaml', SECRET_RUN);
    writeFileSync(join(root, '.relavium', 'project.toml'), 'this is = not [valid toml');
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open();
    await shows(r, 'select', 'Run which workflow?');
    k.enter();
    // The configuration is read inside the popup: the refusal is its last step, on the Workflow step.
    const notice = (await lastStep(r)).message;
    expect(await opened).toBe('');
    expect(notice).toMatch(/^Not started\. /u);
    expect(notice).toContain(join('.relavium', 'project.toml'));
    expect(notice).not.toContain(root);
    expect(
      r.snapshots.some((json) => json.includes('Input 1 of')),
      'no field, masked or not, was ever asked',
    ).toBe(false);
    expect(r.startCalls).toHaveLength(0);
    expect(runCount()).toBe(0);
    expect(r.registry.activeOwners).toBe(0);
    // The flow is closed and the next one opens: nothing is stuck.
    rmSync(join(root, '.relavium', 'project.toml'));
    const again = r.launch.open();
    await shows(r, 'select', 'Run which workflow?');
    k.esc();
    expect(await again).toBe(LAUNCH_CANCELLED);
  });

  it('a catalog that reports no scope leaves the confirmation silent about it, and the start is bound to sandboxed: what the silence implied (L1)', async () => {
    writeWorkflow('read.relavium.yaml', READ_ONLY);
    const r = rig({
      catalog: (real) => ({
        list: real.list,
        load: (path) => ({ ...real.load(path), fsScope: undefined }),
      }),
    });
    const k = keys(r);
    // The repository widens its scope after the person was shown a confirmation that named none.
    const opened = r.launch.open();
    const card = await confirmationOf(r);
    expect(facts(card)).toBe('');
    expect(card.message).toBe('Run host-read-only with n=3?');
    writeProjectDefaults('fs_scope = "full"');
    k.ctrlY();
    expect((await lastStep(r)).message).toBe(FS_SCOPE_CHANGED);
    expect(await opened).toBe('');
    expect(r.startCalls[0]?.request.expectedFsScope).toBe('sandboxed');
    expect(r.builds).not.toHaveBeenCalled();
    expect(runCount()).toBe(0);
  });

  it('the picker`s note about files it did not offer is put back when the chord card that cleared it is left', async () => {
    writeWorkflow('read.relavium.yaml', READ_ONLY);
    writeWorkflow('not-a-workflow.relavium.yaml', BROKEN);
    writeProjectDefaults('fs_scope = "project"');
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open();
    const picker = await shows(r, 'select', 'Run which workflow?');
    expect(picker.note).toContain('Not offered');
    k.enter();
    await shows(r, 'text', 'Input 1 of 1: n');
    k.type('3');
    k.enter();
    const card = await shows(r, 'chord', 'Run ');
    expect(card.note, 'a chord card has no note above it').toBe('');
    expect(facts(card), 'the host`s passage is the card`s facts').toBe(
      'File scope: project, set by this repository.',
    );
    k.esc(); // back to the field
    const field = await shows(r, 'text', 'Input 1 of 1: n');
    expect(field.note, 'the picker`s note is back, and the host row is not left behind').toContain(
      'Not offered',
    );
    expect(field.note).not.toContain('File scope');
    k.ctrlC();
    await opened;
  });

  it('is bounded: the host`s row never passes 280 characters, however much the definition grants', () => {
    const commands = Array.from({ length: 120 }, (_, index) => `'cmd-${String(index)}'`).join(', ');
    const globs = Array.from({ length: 120 }, (_, index) => `'glob-${String(index)} *'`).join(', ');
    const servers = ['one', 'two', 'three', 'four']
      .map((name) => `        - { ref: ${name}-${'n'.repeat(40)} }`)
      .join('\n');
    const local = `        - { id: local, transport: stdio, command: ${JSON.stringify(process.execPath)} }\n`;
    const def = parseWorkflow(
      AUTHORITY.replace(
        "allowedCommands: ['npm test', 'git status']",
        `allowedCommands: [${commands}]`,
      )
        .replace("allowedCommandGlobs: ['make *']", `allowedCommandGlobs: [${globs}]`)
        .replace(
          'tools: [run_command, write_file, read_file]',
          'tools: [run_command, git_status, git_commit, write_file]',
        )
        .replace(`${local}        - { ref: shared-registry }`, servers),
      { source: 'bounded' },
    );
    const note = launchAuthorityNote(def, { tier: 'full', fromRepository: true });
    expect(note?.length).toBe(280);
    expect(note).toMatch(
      /^File scope: full, set by this repository\. This run can run commands, which the file scope does not limit \("cmd-0", "cmd-1", and 238 more\); start processes \(git_commit, git_status\); write files; /u,
    );
    expect(note?.endsWith('…'), 'the cut is marked').toBe(true);
  });

  it('puts hostile server names through the sanitize floor: no control, no escape, bounded, quoted', async () => {
    const hostile = `${'x'.repeat(40)}\u001b[31m\u202e\n[Ctrl+Y]`;
    writeWorkflow(
      'authority.relavium.yaml',
      AUTHORITY.replace('{ ref: shared-registry }', `{ ref: ${JSON.stringify(hostile)} }`),
    );
    const r = rig();
    const opened = r.launch.open();
    const card = await confirmationOf(r);
    expect(
      [...facts(card)].filter((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 || (code >= 0x202a && code <= 0x202e);
      }),
      'no control, escape or bidi character',
    ).toEqual([]);
    expect(facts(card)).not.toContain('x'.repeat(30));
    expect(facts(card)).toContain(`"${'x'.repeat(21)}…"`);
    expect(facts(card).length).toBeLessThanOrEqual(280);
    // A server's name that spells the answer chord is no key token on the card (the full scrub, before the channel).
    expect(facts(card)).not.toContain('Ctrl+Y');
    keys(r).ctrlN();
    await opened;
  });

  it('is bound to the scope it named: a project file changed after the confirmation refuses the start, and nothing starts', async () => {
    writeWorkflow('read.relavium.yaml', READ_ONLY);
    writeProjectDefaults('fs_scope = "project"');
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open();
    const card = await confirmationOf(r);
    expect(facts(card)).toContain('File scope: project, set by this repository.');
    // The repository's configuration is widened while the card is up.
    writeProjectDefaults('fs_scope = "full"');
    k.ctrlY();
    expect((await lastStep(r)).message).toBe(FS_SCOPE_CHANGED);
    expect(await opened).toBe('');
    expect(r.builds, 'no engine was built').not.toHaveBeenCalled();
    expect(runCount()).toBe(0);
    expect(r.registry.activeOwners).toBe(0);
  });
});

describe('the confirmation counts the inputs it has no room for (M-3)', () => {
  it('shows as many whole entries as fit and says how many more, never a half entry', async () => {
    writeWorkflow('many.relavium.yaml', MANY_INPUTS);
    const r = rig();
    const k = keys(r);
    const opened = r.launch.open();
    await shows(r, 'select', 'Run which workflow?');
    k.enter();
    for (let index = 1; index <= 12; index += 1) {
      await shows(
        r,
        'text',
        `Input ${String(index)} of 12: field${String(index).padStart(2, '0')}`,
      );
      k.type(`value-${String(index).padStart(2, '0')}-padding`);
      k.enter();
    }
    const card = await shows(r, 'chord', 'Run host-many');
    expect(card.message.length).toBeLessThanOrEqual(200);
    const shown = card.message.match(/field\d\d=/g) ?? [];
    expect(shown.length, 'some are shown').toBeGreaterThan(0);
    expect(shown.length, 'and not all').toBeLessThan(12);
    expect(card.message).toMatch(new RegExp(` and ${String(12 - shown.length)} more\\?$`));
    // Every entry that is shown is whole: the value ends where it ended.
    for (const entry of card.message.match(/field\d\d=[^,?]*/g) ?? [])
      expect(entry).toMatch(/^field\d\d=value-\d\d-padding/u);
    k.ctrlN();
    await opened;
  });

  it('keeps the question exactly as it was while every input fits', async () => {
    writeWorkflow('happy.relavium.yaml', HAPPY);
    const r = rig();
    const opened = r.launch.open();
    const card = await toConfirmation(r, '4');
    expect(card.message).toBe('Run host-happy with n=4?');
    keys(r).ctrlN();
    await opened;
  });
});

describe('a request while the host already hosts a leg is answered before the form opens (M-2)', () => {
  const executing = {
    launching: false,
    active: { leg: 'start', runId: '0123456789abcdef-synthetic', cancelling: false },
    last: undefined,
  } as const;

  function stubbed(snapshot: () => ReturnType<RunHost['snapshot']>) {
    const r = rig();
    const list = vi.fn(() => []);
    const begin = vi.spyOn(r.channel.flow, 'begin');
    const start = vi.fn(
      (): Promise<HostedLaunch> =>
        Promise.resolve({ kind: 'refused', reason: 'busy', message: 'x' }),
    );
    const launch = createRunLaunch({
      flow: r.channel.flow,
      host: { start, snapshot },
      catalog: {
        list,
        load: () => {
          throw new Error('never read');
        },
      },
    });
    return { r, launch, list, begin, start };
  }

  it('names the hosted run by its first characters and where it is, opens no prompt and reads no catalog', async () => {
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    const { r, launch, list, begin, start } = stubbed(() => executing);
    const notice = await launch.open();
    // The typed `/run` says it in one notification: its first sentence, which names the run (the remedy is the strip's own row).
    expect(notice).toBe('A run is already executing (01234567).');
    expect(notice.length, 'a notification`s 54 columns').toBeLessThanOrEqual(54);
    expect(begin, 'no flow was begun').not.toHaveBeenCalled();
    expect(r.channel.ui.getSnapshot().active).toBe(false);
    expect(list, 'the catalog was not read').not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    // The same for `r` on a workflow of the Defined tab (the slug is not even looked at), said whole on the tab's own row.
    const whole = await launch.open('no-inputs', '.relavium/workflows/none.relavium.yaml');
    expect(whole).toBe(
      'A run is already executing (01234567). Enter on its row in the strip opens it.',
    );
    expect(whole.length, 'one row of the tab').toBeLessThanOrEqual(78);
  });

  it('a leg that is still starting is named as starting, and a host with nothing hosted opens the form as before', async () => {
    const starting = stubbed(() => ({ launching: true, active: undefined, last: undefined }));
    expect(await starting.launch.open()).toBe('A run is already starting.');
    expect(starting.begin).not.toHaveBeenCalled();

    const idle = stubbed(() => ({ launching: false, active: undefined, last: undefined }));
    const opened = idle.launch.open();
    // The (empty) catalog was read: the flow went on, to the popup's empty state.
    expect((await lastStep(idle.r)).message).toBe(LAUNCH_NO_WORKFLOWS);
    expect(await opened).toBe('');
    expect(idle.list).toHaveBeenCalledTimes(1);
  });

  it('a forged run id is cut and put through the one-line floor', () => {
    const forged = launchBusy({
      launching: false,
      active: { leg: 'start', runId: '\u001b[2Jrun\nrow', cancelling: false },
      last: undefined,
    });
    expect([...(forged ?? '')].some((character) => character.charCodeAt(0) < 32)).toBe(false);
    expect(forged).toContain('A run is already executing');
  });

  it('with the real host: a leg that is starting turns /run away at once, and the form opens again when it is over', async () => {
    writeWorkflow('none.relavium.yaml', NO_INPUTS);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = rig({ holdBuild: held });
    const first = r.host.start({
      workflow: '.relavium/workflows/none.relavium.yaml',
      rawInputs: {},
    });
    await vi.waitFor(() => {
      expect(r.builds, 'the leg is inside its build').toHaveBeenCalledTimes(1);
    }, WAIT);
    expect(await r.launch.open()).toBe('A run is already starting.');
    expect(r.snapshots, 'no prompt ever opened').toEqual([]);
    release();
    expect((await first).kind).toBe('started');
    await idle(r);
    const opened = r.launch.open();
    await shows(r, 'select', 'Run which workflow?');
    keys(r).esc();
    expect(await opened).toBe(LAUNCH_CANCELLED);
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
    k.ctrlY();
    const card = await shows(r, 'chord', "Allow MCP server 'local'");
    return { opened, card };
  }

  it('opens for a hosted leg that needs consent, and nothing is spawned until it is answered', async () => {
    writeWorkflow('mcp.relavium.yaml', MCP_GATED);
    const r = rig();
    const { opened, card } = await toConsentCard(r);
    // It arrives while the `/run` popup is open, during the start: it is the card it always was, not a step of the popup (ADR-0139 §4).
    expect(card.popup, 'no popup frame around the consent card').toBeUndefined();
    expect(card.message).toContain('on this machine');
    expect(card.details.join('\n')).toContain('server');
    expect(r.startMcpClient, 'nothing is started while the card is up').not.toHaveBeenCalled();
    expect(existsSync(mcpConsentPath(r.home)), 'and nothing is recorded').toBe(false);
    keys(r).ctrlY();
    expect(await opened).toMatch(/^Started host-mcp · run /);
    expect(r.startMcpClient).toHaveBeenCalledTimes(1);
    expect(existsSync(mcpConsentPath(r.home)), 'the grant is the per-machine one').toBe(true);
    await idle(r);
    expect(runStatuses()).toEqual(['paused']);
    expect(r.registry.activeOwners).toBe(0);
  });

  it.each([
    // `Ctrl+N` answers the card: the gate words the refusal. `Esc` and `Ctrl+C` leave the whole flow (the legend says `Esc cancel`), which
    // since P1-4 is one cancel of the launch that also stops the leg: the notice is the launch's, and the effect is the same refusal.
    ['Ctrl+N', (k: ReturnType<typeof keys>) => k.ctrlN(), 'was not approved'],
    ['Esc', (k: ReturnType<typeof keys>) => k.esc(), LAUNCH_CANCELLED],
    ['Ctrl+C', (k: ReturnType<typeof keys>) => k.ctrlC(), LAUNCH_CANCELLED],
  ])(
    'a refusal (%s) spawns nothing, records nothing and starts no run',
    async (_name, refuse, words) => {
      writeWorkflow('mcp.relavium.yaml', MCP_GATED);
      const r = rig();
      const { opened } = await toConsentCard(r);
      refuse(keys(r));
      // A refusal of the card is the start's failure, said in the popup (whole); leaving the card leaves the launch (one notification).
      const said = words === LAUNCH_CANCELLED ? await opened : (await lastStep(r)).message;
      expect(said).toContain(words);
      if (words !== LAUNCH_CANCELLED) expect(await opened).toBe('');
      expect(r.startMcpClient, 'the server was never started').not.toHaveBeenCalled();
      expect(existsSync(mcpConsentPath(r.home)), 'no grant was written').toBe(false);
      expect(runCount(), 'no run was created').toBe(0);
      expect(r.registry.activeOwners).toBe(0);
      expect(r.host.snapshot()).toMatchObject({ launching: false, active: undefined });
      expect(r.channel.ui.getSnapshot().active).toBe(false);
    },
  );

  it('is asked at a resume too: a grant the machine no longer holds is asked about again, through the same card', async () => {
    writeWorkflow('mcp.relavium.yaml', MCP_GATED);
    const r = rig();
    const { opened } = await toConsentCard(r);
    keys(r).ctrlY();
    expect(await opened).toMatch(/^Started host-mcp · run /);
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

  it.each([
    ['Esc', (k: ReturnType<typeof keys>) => k.esc()],
    ['Ctrl+C', (k: ReturnType<typeof keys>) => k.ctrlC()],
  ])(
    'Esc or Ctrl+C on the card of a resume (%s) reads as a cancel, not as a refusal nobody made, and the gate stays pending (L3)',
    async (_name, leave) => {
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
      leave(keys(r));
      const refused = await answer;
      expect(refused).toMatchObject({ kind: 'refused', reason: 'stopped' });
      const message = refused.kind === 'refused' ? refused.message : '';
      expect(message).toBe(RESUME_CANCELLED);
      expect(message).not.toContain('not approved');
      expect(
        r.startMcpClient,
        'the server was started once, by the start leg',
      ).toHaveBeenCalledTimes(1);
      expect(existsSync(mcpConsentPath(r.home)), 'a cancel records no grant').toBe(false);
      expect(runStatuses(), 'the gate is still pending, and the run is not cancelled').toEqual([
        'paused',
      ]);
      expect(r.registry.activeOwners).toBe(0);
    },
  );

  it('is the only prompt: a host with no card wired opens none and refuses with the digest', async () => {
    writeWorkflow('mcp.relavium.yaml', MCP_GATED);
    const r = rig({ consent: false });
    const k = keys(r);
    const opened = r.launch.open();
    await toConfirmation(r);
    k.ctrlY();
    const notice = (await lastStep(r)).message;
    expect(await opened).toBe('');
    expect(notice).toContain('not approved on this machine');
    expect(
      r.snapshots.some((json) => json.includes('Allow MCP server')),
      'no consent card ever opened (the one chord card was the confirmation)',
    ).toBe(false);
    expect(r.startMcpClient).not.toHaveBeenCalled();
    expect(runCount()).toBe(0);
    expect(r.host.notices.snapshot().join('\n')).toMatch(/v1:[0-9a-f]{64}/);
  });
});
