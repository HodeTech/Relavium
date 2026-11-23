/**
 * The resume path of the Home's run host
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §2, §4, §7): what answering a parked run
 * checks, and in what order, before a fresh leg runs.
 *
 * The order the run core fixes is the contract, and each test names its place in it:
 *
 *   1. a run recorded for another directory is refused before an owner, an engine, a secret or a card;
 *   2. a decision the gate's type does not accept is refused before any secret is read;
 *   3. each masked slot of the run is asked for, once, by name, through the secret port (the blank-value refusal is the wrapper's);
 *   4. a local MCP server this machine holds no grant for is asked about again, through the card (it is not skipped because the run
 *      was started with a flag, or because the leg is a resume).
 *
 * Most cases run for real: the real run core, engine and run store over `history.db` connections. The two-process case opens two
 * connections to one file, as two Homes would. Every operator home is a temporary directory handed in as `homeDir`; the module's two
 * nets (a config load with no home, `os.homedir()`) throw, so no path here reaches the real `~/.relavium`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunDeparture, RunHandle } from '@relavium/core';
import { createClient, createRunHistoryReader, runMigrations, type DbClient } from '@relavium/db';
import { startMcpClient as realStartMcpClient } from '@relavium/mcp';
import type { RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEngine, type BuildEngineOptions } from '../engine/build-engine.js';
import {
  appendGrant,
  fingerprint,
  resolveStdioSpawn,
  type ConsentGrant,
} from '../engine/mcp-consent.js';
import { mcpConsentPath, type ConsentPrompter } from '../engine/mcp-consent-gate.js';
import { approvalDecision, inputDecision, rejectionDecision } from '../gate/decision.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { InvocationOwner } from '../process/invocation-registry.js';
import type { RunRenderer } from '../render/renderer.js';
import { createGateResumer } from '../render/tui/run-card-model.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import { captureIo } from '../test-support.js';
import { readRunGates } from './run-gates.js';
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
const extraClients: DbClient[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-run-host-resume-'));
  client = createClient(':memory:');
  runMigrations(client.db);
  fallbackHome = undefined;
});
afterEach(() => {
  if (client.sqlite.open) client.sqlite.close();
  for (const extra of extraClients.splice(0)) if (extra.sqlite.open) extra.sqlite.close();
  rmSync(root, { recursive: true, force: true });
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  fallbackHome = undefined;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------------
// Workflows.
// ---------------------------------------------------------------------------------------------------------------------

const GATED = `schema_version: '1.0'
workflow:
  id: resume-gated
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

/** The same gate, carrying two secret inputs: its durable record holds only the two masked slots. */
const GATED_TWO_SECRETS = GATED.replace(
  '    - { name: n, type: number }',
  '    - { name: n, type: number }\n    - { name: api_key, type: secret }\n    - { name: token, type: secret }',
).replace('id: resume-gated', 'id: resume-secrets');

/** An `input` gate: it takes a typed value or a rejection, and an approval is not among its decisions. */
const INPUT_GATED_SECRET = GATED_TWO_SECRETS.replace(
  'gate_type: approval',
  'gate_type: input',
).replace('id: resume-secrets', 'id: resume-input');

/** One inline stdio MCP server, declared by an agent no node uses: only the consent gate cares about it. */
const MCP_GATED = GATED.replace('id: resume-gated', 'id: resume-mcp').replace(
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

/**
 * How far in the future `g2`'s deadline is when the run parks. It is far enough that no real park can reach it, and the tests that need it
 * overdue move the clock past it (`parkedPastDeadline`) instead of sleeping.
 */
const GATE_DEADLINE_MS = 60_000;

/** Two gates side by side: `g1` waits for a person, `g2` has a deadline that approves it. Both must be decided to finish. */
const TWO_GATES = `schema_version: '1.0'
workflow:
  id: resume-two-gates
  inputs:
    - { name: n, type: number }
  nodes:
    - { id: start, type: input }
    - { id: g1, type: human_gate, gate_type: approval }
    - { id: g2, type: human_gate, gate_type: approval, timeout_ms: ${String(GATE_DEADLINE_MS)}, timeout_action: approve }
    - { id: out, type: output }
  edges:
    - { from: start, to: g1 }
    - { from: start, to: g2 }
    - { from: g1, to: out }
    - { from: g2, to: out }
`;

/** The same two gates with no deadline at all, for the two-process case. */
const TWO_GATES_NO_DEADLINE = TWO_GATES.replace(
  `, timeout_ms: ${String(GATE_DEADLINE_MS)}, timeout_action: approve`,
  '',
).replace('id: resume-two-gates', 'id: resume-two-gates-open');

function writeWorkflow(name: string, yaml: string): string {
  const path = join(root, name);
  writeFileSync(path, yaml);
  return path;
}

// ---------------------------------------------------------------------------------------------------------------------
// The rig.
// ---------------------------------------------------------------------------------------------------------------------

interface Rig {
  readonly host: RunHost;
  readonly registered: InvocationOwner[];
  readonly builds: ReturnType<typeof vi.fn>;
  readonly home: string;
  readonly db: DbClient;
  readonly registry: ReturnType<typeof invocationFixture>['registry'];
}

/** A host over `db` (the shared in-memory one by default), for the project at `cwd`, with an operator home of its own. */
function rig(
  over: Partial<RunHostOptions> = {},
  cwd: string = root,
  db: DbClient = client,
  home?: string,
): Rig {
  const f = invocationFixture();
  const registered: InvocationOwner[] = [];
  const register = f.registry.register.bind(f.registry);
  vi.spyOn(f.registry, 'register').mockImplementation((owner) => {
    registered.push(owner);
    return register(owner);
  });
  const operatorHome = home ?? mkdtempSync(join(tmpdir(), 'relavium-run-host-resume-home-'));
  if (home === undefined) scratch.push(operatorHome);
  fallbackHome = operatorHome;
  const builds = vi.fn();
  const host = new RunHost({
    invocation: f.invocation,
    io: captureIo().io,
    global: { json: false, color: false, cwd, configPath: undefined, verbosity: 'normal' },
    db: db.db,
    homeDir: operatorHome,
    buildEngine: (options?: BuildEngineOptions) => {
      builds();
      return buildEngine(options);
    },
    sweepMedia: vi.fn(() => Promise.resolve(undefined)),
    ...over,
  });
  return { host, registered, builds, home: operatorHome, db, registry: f.registry };
}

async function started(launch: Promise<HostedLaunch> | HostedLaunch): Promise<HostedLegEnd> {
  const resolved = await launch;
  if (resolved.kind !== 'started')
    throw new Error(`expected a started leg, got ${JSON.stringify(resolved)}`);
  return resolved.ended;
}

/** Park a workflow at its gate(s) and return the run's id. */
async function park(
  r: Rig,
  yaml: string,
  name: string,
  secrets?: HostedSecretPort,
): Promise<string> {
  const path = writeWorkflow(name, yaml);
  const end = await started(
    r.host.start({
      workflow: path,
      rawInputs: { n: '3' },
      ...(secrets === undefined ? {} : { secrets }),
    }),
  );
  expect(end.terminal.disposition, 'the leg parked at its gate').toBe('paused');
  return end.runId;
}

const SECRETS: HostedSecretPort = () =>
  Promise.resolve({ api_key: 'first-secret-value', token: 'second-secret-value' });

function events(db: DbClient, runId: string): RunEvent[] {
  return createRunHistoryReader(db.db).loadRunEvents(runId);
}

/** Every decision the log holds, by the gate node it settled (a persisted decision names its node, not its gate id). */
function decisionsOf(
  db: DbClient,
  runId: string,
): { nodeId: string; decidedBy: string; decision: string }[] {
  return events(db, runId).flatMap((event) =>
    event.type === 'human_gate:resumed'
      ? [{ nodeId: event.nodeId, decidedBy: event.decidedBy, decision: event.decision }]
      : [],
  );
}

function runStatus(db: DbClient, runId: string): unknown {
  const row = db.sqlite.prepare('SELECT status FROM runs WHERE id = ?').get(runId);
  return typeof row === 'object' && row !== null && 'status' in row ? row.status : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Another directory's run.
// ---------------------------------------------------------------------------------------------------------------------

describe('(a) a run belongs to the directory it was started in', () => {
  it('is refused before an owner, an engine, a secret or a card, and the run stays answerable where it belongs', async () => {
    const other = mkdtempSync(join(tmpdir(), 'relavium-run-host-resume-other-'));
    scratch.push(other);
    const there = rig({}, other);
    const runId = await park(there, GATED_TWO_SECRETS, 'a.relavium.yaml', SECRETS);

    const consent = vi.fn<ConsentPrompter>(() => Promise.resolve(true));
    const port = vi.fn<HostedSecretPort>(() => Promise.resolve({}));
    const here = rig({ consent }, root);
    const refused = await here.host.resume({
      runId,
      kind: 'human',
      decision: approvalDecision(),
      secrets: port,
    });
    expect(refused).toEqual({
      kind: 'refused',
      reason: 'other_project',
      message: 'This run belongs to another directory. Open Home there to answer it.',
    });
    expect(here.builds, 'no engine was built').not.toHaveBeenCalled();
    expect(here.registered, 'no owner was registered').toHaveLength(0);
    expect(port, 'no secret was asked for').not.toHaveBeenCalled();
    expect(consent, 'no card was opened').not.toHaveBeenCalled();
    expect(runStatus(client, runId), 'the gate is still pending').toBe('paused');

    const answered = await started(
      there.host.resume({ runId, kind: 'human', decision: approvalDecision(), secrets: SECRETS }),
    );
    expect(answered.terminal.disposition).toBe('completed');
  });

  it('a run recorded with no project root is refused in words that say so, not as another directory`s', async () => {
    const r = rig();
    const runId = await park(r, GATED_TWO_SECRETS, 'none.relavium.yaml', SECRETS);
    client.sqlite.prepare('UPDATE runs SET project_root = NULL WHERE id = ?').run(runId);
    const buildsBefore = r.builds.mock.calls.length;
    const ownersBefore = r.registered.length;
    const port = vi.fn<HostedSecretPort>(() => Promise.resolve({}));
    const refused = await r.host.resume({
      runId,
      kind: 'human',
      decision: approvalDecision(),
      secrets: port,
    });
    expect(refused).toMatchObject({ kind: 'refused', reason: 'other_project' });
    const message = refused.kind === 'refused' ? refused.message : '';
    expect(message).toContain('recorded without a project root');
    expect(message, 'there is no other directory to open the Home in').not.toContain(
      'another directory',
    );
    expect(message).toContain('relavium status');
    expect(r.builds.mock.calls.length, 'no engine for the refusal').toBe(buildsBefore);
    expect(r.registered, 'no owner for the refusal').toHaveLength(ownersBefore);
    expect(port, 'no secret was asked for').not.toHaveBeenCalled();
    expect(runStatus(client, runId), 'the gate is still pending').toBe('paused');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. A decision the gate does not accept.
// ---------------------------------------------------------------------------------------------------------------------

describe('(d) a decision that does not fit the gate type reads no secret', () => {
  it('refuses an input on an approval gate and an approval on an input gate before the port is asked', async () => {
    const approval = rig();
    const approvalRun = await park(approval, GATED_TWO_SECRETS, 'approval.relavium.yaml', SECRETS);
    const port = vi.fn<HostedSecretPort>(() => Promise.resolve({ api_key: 'v1', token: 'v2' }));

    const wrongForApproval = await approval.host.resume({
      runId: approvalRun,
      kind: 'human',
      decision: inputDecision('a typed value'),
      secrets: port,
    });
    expect(wrongForApproval).toMatchObject({ kind: 'refused', reason: 'rejected' });
    expect(port, 'no secret was read for a decision the gate cannot take').not.toHaveBeenCalled();
    expect(runStatus(client, approvalRun)).toBe('paused');

    const input = rig();
    const inputRun = await park(input, INPUT_GATED_SECRET, 'input.relavium.yaml', SECRETS);
    const wrongForInput = await input.host.resume({
      runId: inputRun,
      kind: 'human',
      decision: approvalDecision(),
      secrets: port,
    });
    expect(wrongForInput).toMatchObject({ kind: 'refused', reason: 'rejected' });
    expect(port).not.toHaveBeenCalled();
    expect(runStatus(client, inputRun)).toBe('paused');

    // Control: the decisions the gates DO accept read the secrets, so the port is live and the refusals above were the decision's.
    const fitting = await started(
      input.host.resume({
        runId: inputRun,
        kind: 'human',
        decision: inputDecision('a typed value'),
        secrets: port,
      }),
    );
    expect(fitting.terminal.disposition).toBe('completed');
    expect(port).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. The masked slots.
// ---------------------------------------------------------------------------------------------------------------------

describe('(c) a masked slot is asked for once, by name', () => {
  it('asks the port once with every masked slot of the run, and passes the values to the run and nowhere else', async () => {
    const r = rig();
    const runId = await park(r, GATED_TWO_SECRETS, 'slots.relavium.yaml', SECRETS);
    const port = vi.fn<HostedSecretPort>(() =>
      Promise.resolve({ api_key: 'resume-key-value', token: 'resume-token-value' }),
    );
    const end = await started(
      r.host.resume({ runId, kind: 'human', decision: approvalDecision(), secrets: port }),
    );
    expect(end.terminal.disposition).toBe('completed');
    expect(port).toHaveBeenCalledOnce();
    expect([...(port.mock.calls[0]?.[0] ?? [])].sort()).toEqual(['api_key', 'token']);
    expect(JSON.stringify([end, r.host.notices.snapshot()])).not.toContain('resume-key-value');
    expect(JSON.stringify(events(client, runId))).not.toContain('resume-token-value');
  });

  it('refuses a blank value at the port, and leaves the gate pending for another answer', async () => {
    const r = rig();
    const runId = await park(r, GATED_TWO_SECRETS, 'blank.relavium.yaml', SECRETS);
    const buildsBefore = r.builds.mock.calls.length;
    const refused = await r.host.resume({
      runId,
      kind: 'human',
      decision: approvalDecision(),
      secrets: () => Promise.resolve({ api_key: 'a value', token: '   ' }),
    });
    expect(refused).toEqual({
      kind: 'refused',
      reason: 'rejected',
      message: 'A secret input cannot be blank.',
    });
    expect(r.builds.mock.calls.length, 'no engine for the refused answer').toBe(buildsBefore);
    expect(runStatus(client, runId)).toBe('paused');
  });

  it('asks nothing of a run that carries no masked slot, even when a port is offered for every answer', async () => {
    const r = rig();
    const runId = await park(r, GATED, 'no-slots.relavium.yaml');
    const port = vi.fn<HostedSecretPort>(() => Promise.resolve({}));
    const end = await started(
      r.host.resume({ runId, kind: 'human', decision: approvalDecision(), secrets: port }),
    );
    expect(end.terminal.disposition, 'a port the run did not need is not an error').toBe(
      'completed',
    );
    expect(port).not.toHaveBeenCalled();
  });

  it('is one native masked field per slot, in the order the run core names them, and a left field leaves the whole answer', async () => {
    const r = rig();
    const runId = await park(r, GATED_TWO_SECRETS, 'native.relavium.yaml', SECRETS);
    const channel = createNativePromptChannel({
      guard: { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 },
    });
    channel.ui.bindVisibility((snapshot) => snapshot === channel.ui.getSnapshot());
    const shown: string[] = [];
    channel.ui.subscribe(() => shown.push(JSON.stringify(channel.ui.getSnapshot())));
    const key = { ctrl: false, meta: false, return: false, escape: false } as const;
    const type = (text: string): void => {
      for (const ch of text) channel.ui.input(ch, key as never);
    };
    const enter = (): void => void channel.ui.input('', { ...key, return: true } as never);
    const resume = createGateResumer({ host: r.host, flow: channel.flow });
    const waitFor = async (text: string): Promise<void> => {
      await vi.waitFor(
        () => {
          const snapshot = channel.ui.getSnapshot();
          expect(snapshot.kind).toBe('password');
          expect(snapshot.message).toContain(text);
        },
        { timeout: WAIT_MS },
      );
    };

    // Leave the second field: nothing is answered, no engine is built, the gate stays pending.
    const buildsBefore = r.builds.mock.calls.length;
    const left = resume({ runId, kind: 'human', decision: approvalDecision() });
    await waitFor('Secret input 1 of 2');
    type('first-native-secret');
    enter();
    await waitFor('Secret input 2 of 2');
    channel.ui.input('', { ...key, escape: true } as never);
    expect(await left).toEqual({
      kind: 'refused',
      reason: 'rejected',
      message: 'The answer was cancelled. The gate is still pending.',
    });
    expect(r.builds.mock.calls.length).toBe(buildsBefore);
    expect(runStatus(client, runId)).toBe('paused');

    // Answer both: each slot has its own field, and the run completes.
    const answered = resume({ runId, kind: 'human', decision: approvalDecision() });
    await waitFor('Secret input 1 of 2');
    type('first-native-secret');
    enter();
    await waitFor('Secret input 2 of 2');
    type('second-native-secret');
    enter();
    const launch = await answered;
    expect(launch.kind).toBe('started');
    if (launch.kind === 'started')
      expect((await launch.ended).terminal.disposition).toBe('completed');
    const everything = JSON.stringify([shown, events(client, runId), r.host.notices.snapshot()]);
    expect(everything).not.toContain('first-native-secret');
    expect(everything).not.toContain('second-native-secret');
    expect(channel.ui.getSnapshot().active, 'the flow closed with the answer').toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. The consent check.
// ---------------------------------------------------------------------------------------------------------------------

describe('(b) a resumed leg runs the consent check again', () => {
  async function digest(): Promise<ConsentGrant> {
    const spawn = await resolveStdioSpawn(
      { serverId: 'local', command: process.execPath, provenance: { kind: 'inline' } },
      root,
    );
    return {
      v: 1,
      digest: fingerprint(spawn),
      command: spawn.resolvedCommand,
      args: [...spawn.args],
      envNames: Object.keys(spawn.env),
      cwd: spawn.cwd,
      grantedAt: '2026-11-23T00:00:00.000Z',
    };
  }

  /** A run parked with the server approved on this machine, and a host with a card wired. */
  async function parkedWithGrant(consent: ConsentPrompter | undefined) {
    const startMcpClient = vi.fn(() => realStartMcpClient([]));
    const r = rig({ startMcpClient, ...(consent === undefined ? {} : { consent }) });
    appendGrant(mcpConsentPath(r.home), await digest());
    const runId = await park(r, MCP_GATED, 'mcp.relavium.yaml');
    return { r, runId, startMcpClient };
  }

  it('asks through the card for a server this machine holds no grant for, and starts it once it is approved', async () => {
    const consent = vi.fn<ConsentPrompter>(() => Promise.resolve(true));
    const { r, runId, startMcpClient } = await parkedWithGrant(consent);
    expect(consent, 'the start leg found the grant and asked nothing').not.toHaveBeenCalled();
    rmSync(mcpConsentPath(r.home));

    const end = await started(
      r.host.resume({ runId, kind: 'human', decision: approvalDecision() }),
    );
    expect(consent, 'the resumed leg asked, through the card').toHaveBeenCalledOnce();
    expect(consent.mock.calls[0]?.[0]).toMatchObject({ serverId: 'local', total: 1, index: 1 });
    expect(startMcpClient).toHaveBeenCalledTimes(2);
    expect(end.terminal.disposition).toBe('completed');
  });

  it('asks nothing for a server the machine approved, and still runs the check', async () => {
    const consent = vi.fn<ConsentPrompter>(() => Promise.resolve(true));
    const { r, runId, startMcpClient } = await parkedWithGrant(consent);
    const end = await started(
      r.host.resume({ runId, kind: 'human', decision: approvalDecision() }),
    );
    expect(consent).not.toHaveBeenCalled();
    expect(
      startMcpClient,
      'the approved server started on the resume as well',
    ).toHaveBeenCalledTimes(2);
    expect(end.terminal.disposition).toBe('completed');
  });

  it('refuses when the card says no: nothing is started, nothing is recorded and the gate stays pending', async () => {
    const consent = vi.fn<ConsentPrompter>(() => Promise.resolve(false));
    const { r, runId, startMcpClient } = await parkedWithGrant(consent);
    rmSync(mcpConsentPath(r.home));
    const refused = await r.host.resume({ runId, kind: 'human', decision: approvalDecision() });
    expect(consent).toHaveBeenCalledOnce();
    expect(refused).toMatchObject({ kind: 'refused', reason: 'rejected' });
    expect(refused.kind === 'refused' ? refused.message : '').toContain('was not approved');
    expect(startMcpClient, 'only the start leg started it').toHaveBeenCalledOnce();
    expect(runStatus(client, runId)).toBe('paused');
    expect(r.registry.activeOwners).toBe(0);
  });

  it('with no card wired refuses with the digest, as a script does', async () => {
    const { r, runId, startMcpClient } = await parkedWithGrant(undefined);
    rmSync(mcpConsentPath(r.home));
    const refused = await r.host.resume({ runId, kind: 'human', decision: approvalDecision() });
    expect(refused).toMatchObject({ kind: 'refused', reason: 'rejected' });
    expect(refused.kind === 'refused' ? refused.message : '').toContain(
      'not approved on this machine',
    );
    expect(r.host.notices.snapshot().join('\n')).toMatch(/v1:[0-9a-f]{64}/);
    expect(startMcpClient).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// An overdue gate, in both orders.
// ---------------------------------------------------------------------------------------------------------------------

describe('an overdue gate is answered in both orders, and never runs twice', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Park `TWO_GATES` and let `g2`'s deadline pass: a parked run holds no timer, so the deadline is only a fact in the log.
   *
   * The deadline passes by moving the clock, not by waiting for it: only `Date` is replaced (the engine and the log read it for
   * deadlines, and every real timer still runs), it stands still while the run parks, and then it is set past `g2`'s deadline. The
   * run cannot park late enough to meet a deadline a minute away, so no machine, however loaded, changes what this proves.
   */
  async function parkedPastDeadline() {
    vi.useFakeTimers({ toFake: ['Date'] });
    const r = rig();
    const runId = await park(r, TWO_GATES, 'two.relavium.yaml');
    vi.setSystemTime(Date.now() + 2 * GATE_DEADLINE_MS);
    const reader = createRunHistoryReader(client.db);
    const read = readRunGates(reader, root, runId);
    const gate = (nodeId: string): { gateId: string } => {
      const found = read?.gates.find((entry) => entry.nodeId === nodeId);
      if (found === undefined) throw new Error(`no open gate at ${nodeId}`);
      return found;
    };
    expect(read?.gates.map((entry) => entry.nodeId).sort()).toEqual(['g1', 'g2']);
    expect(
      Date.parse(read?.gates.find((entry) => entry.nodeId === 'g2')?.expiresAt ?? ''),
      'g2 is overdue',
    ).toBeLessThan(Date.now());
    return { r, runId, g1: gate('g1').gateId, g2: gate('g2').gateId };
  }

  it('answer, then deadline: the person`s answer is the decision, and a second action on the gate is refused with its durable state', async () => {
    const { r, runId, g1, g2 } = await parkedPastDeadline();
    const first = await started(
      r.host.resume({ runId, gate: g2, kind: 'human', decision: approvalDecision() }),
    );
    // The overdue gate was the target, so its answer applied; the run is still parked at g1.
    expect(first.terminal.disposition).toBe('paused');
    expect(decisionsOf(client, runId)).toEqual([
      { nodeId: 'g2', decidedBy: 'cli', decision: 'approved' },
    ]);
    const buildsAfterFirst = r.builds.mock.calls.length;

    // The deadline's action, or a second Home, reaches the same gate: refused with what the log holds, and nothing runs.
    const second = await r.host.resume({
      runId,
      gate: g2,
      kind: 'human',
      decision: rejectionDecision(),
    });
    expect(second).toEqual({ kind: 'settled', message: `gate ${g2} already resolved` });
    expect(r.builds.mock.calls.length, 'no engine for the second action').toBe(buildsAfterFirst);
    expect(decisionsOf(client, runId), 'one decision, the person`s').toEqual([
      { nodeId: 'g2', decidedBy: 'cli', decision: 'approved' },
    ]);
    expect(runStatus(client, runId)).toBe('paused');
    expect(
      readRunGates(createRunHistoryReader(client.db), root, runId)?.gates.map(
        (gate) => gate.gateId,
      ),
    ).toEqual([g1]);
  });

  it('deadline, then answer: the deadline decided it, and the answer that arrives later is refused with the run`s durable state', async () => {
    const { r, runId, g1, g2 } = await parkedPastDeadline();
    // Answering g1 resumes the run; g2's deadline has passed, so it settles by its own policy in that leg.
    const first = await started(
      r.host.resume({ runId, gate: g1, kind: 'human', decision: approvalDecision() }),
    );
    expect(first.terminal.disposition).toBe('completed');
    expect(
      decisionsOf(client, runId).map(({ nodeId, decidedBy }) => [nodeId, decidedBy]),
      'g1 by the person, g2 by its own deadline, once each',
    ).toEqual(
      expect.arrayContaining([
        ['g1', 'cli'],
        ['g2', 'timeout'],
      ]),
    );
    expect(decisionsOf(client, runId)).toHaveLength(2);
    const buildsAfterFirst = r.builds.mock.calls.length;

    // The card that still shows g2 as open answers it now: refused with the run's state, and nothing runs a second time.
    const late = await r.host.resume({
      runId,
      gate: g2,
      kind: 'human',
      decision: rejectionDecision(),
    });
    expect(late).toEqual({ kind: 'settled', message: 'run completed; nothing to resume' });
    expect(r.builds.mock.calls.length, 'no engine for the late answer').toBe(buildsAfterFirst);
    expect(decisionsOf(client, runId), 'still the two decisions, once each').toHaveLength(2);
    expect(runStatus(client, runId)).toBe('completed');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Two processes.
// ---------------------------------------------------------------------------------------------------------------------

describe('a gate answered from the Home that another process already decided', () => {
  /** Two connections to one file, as two Homes (or a Home and `relavium gate`) have. */
  async function twoHomes(yaml: string) {
    const file = join(root, 'shared', 'history.db');
    const first = createClient(file);
    runMigrations(first.db);
    const second = createClient(file);
    extraClients.push(first, second);
    const home = mkdtempSync(join(tmpdir(), 'relavium-run-host-resume-shared-'));
    scratch.push(home);
    const mine = rig({}, root, first, home);
    const theirs = rig({}, root, second, home);
    const runId = await park(mine, yaml, 'shared.relavium.yaml');
    const reader = createRunHistoryReader(first.db);
    const gates = readRunGates(reader, root, runId)?.gates ?? [];
    return { mine, theirs, runId, first, second, gates };
  }

  it('is refused with the run`s state when the other process finished the run, and does not run twice', async () => {
    const { mine, theirs, runId, first, gates } = await twoHomes(GATED);
    const gate = gates[0]?.gateId;
    expect(gates).toHaveLength(1);
    // The other process answers first (this Home's card still shows the gate open).
    const done = await started(
      theirs.host.resume({ runId, kind: 'human', decision: approvalDecision() }),
    );
    expect(done.terminal.disposition).toBe('completed');
    const buildsBefore = mine.builds.mock.calls.length;

    const stale = await mine.host.resume({
      runId,
      kind: 'human',
      decision: approvalDecision(),
      ...(gate === undefined ? {} : { gate }),
    });
    expect(stale).toEqual({ kind: 'settled', message: 'run completed; nothing to resume' });
    expect(mine.builds.mock.calls.length, 'this Home built no engine for it').toBe(buildsBefore);
    expect(decisionsOf(first, runId), 'the gate was decided once').toHaveLength(1);
    expect(mine.registry.activeOwners).toBe(0);
  });

  it('is refused with the gate`s state when the other process decided only that gate, and the run stays parked at the other', async () => {
    const { mine, theirs, runId, first, gates } = await twoHomes(TWO_GATES_NO_DEADLINE);
    const g1 = gates.find((gate) => gate.nodeId === 'g1')?.gateId ?? '';
    const g2 = gates.find((gate) => gate.nodeId === 'g2')?.gateId ?? '';
    const other = await started(
      theirs.host.resume({ runId, gate: g1, kind: 'human', decision: approvalDecision() }),
    );
    expect(other.terminal.disposition).toBe('paused');
    const buildsBefore = mine.builds.mock.calls.length;

    const stale = await mine.host.resume({
      runId,
      gate: g1,
      kind: 'human',
      decision: rejectionDecision(),
    });
    expect(stale).toEqual({ kind: 'settled', message: `gate ${g1} already resolved` });
    expect(mine.builds.mock.calls.length).toBe(buildsBefore);
    expect(decisionsOf(first, runId).map((entry) => entry.nodeId)).toEqual(['g1']);
    expect(runStatus(first, runId)).toBe('paused');

    // The other gate is still this Home's to answer.
    const rest = await started(
      mine.host.resume({ runId, gate: g2, kind: 'human', decision: approvalDecision() }),
    );
    expect(rest.terminal.disposition).toBe('completed');
    expect(
      decisionsOf(first, runId)
        .map((entry) => entry.nodeId)
        .sort(),
    ).toEqual(['g1', 'g2']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A resumed leg that another process took over while it answered.
// ---------------------------------------------------------------------------------------------------------------------

describe('a resumed leg that finds the run taken over by another process', () => {
  type Departure = Exclude<RunDeparture, { readonly kind: 'continue' }>;
  const DETACHED: Departure = {
    kind: 'detached',
    moneyDurability: 'durable',
    effectNeedsAttention: false,
  };

  /**
   * The handle a leg holds after another process took its run (ADR-0079 §5): the stream ends with no terminal (or with the stale pause the
   * engine had buffered before it found the fence), the disposition is `uncertain`, and nothing durable was written by this process. A real
   * run cannot be put there on demand, so the handle is scripted and the run core, the host and the run store around it are real.
   */
  function fencedHandle(runId: string, stream: readonly RunEvent[]): RunHandle {
    return {
      runId,
      events: (async function* (): AsyncGenerator<RunEvent> {
        await Promise.resolve();
        yield* stream;
      })(),
      subscribe: () => () => undefined,
      cancel: () => undefined,
      depart: () => Promise.resolve(DETACHED),
      whenConsumersReady: () => Promise.resolve(),
      highWaterMark: 256,
      bufferedCount: 0,
      durability: () => 'uncertain',
      terminalError: () => undefined,
    };
  }

  const stalePause = (runId: string): RunEvent => ({
    runId,
    timestamp: '2026-11-23T00:00:00.000Z',
    sequenceNumber: 1,
    type: 'run:paused',
    pendingGateCount: 1,
    gateIds: ['gate-1'],
  });

  /** A parked run, and a host whose NEXT engine answers `resumeFromCheckpoint` with the fenced handle (the park itself is a real leg). */
  async function parkedThenFenced(stream: (runId: string) => readonly RunEvent[]) {
    let fenced = false;
    const seen: RunEvent[] = [];
    const sealed = vi.fn();
    const renderer = (): RunRenderer => ({
      onEvent: (event) => {
        seen.push(event);
      },
      seal: sealed,
    });
    const r = rig({
      renderer,
      buildEngine: async (options?: BuildEngineOptions) => {
        const engine = await buildEngine(options);
        if (fenced)
          vi.spyOn(engine, 'resumeFromCheckpoint').mockImplementation((params) =>
            Promise.resolve(fencedHandle(params.runId, stream(params.runId))),
          );
        return engine;
      },
    });
    const runId = await park(r, GATED, 'fenced.relavium.yaml');
    seen.length = 0;
    fenced = true;
    return { r, runId, seen, sealed };
  }

  it.each([
    { name: 'a stream that closes with no terminal', stream: () => [] },
    {
      name: 'a stale pause the engine buffered before it found the fence',
      stream: (runId: string) => [stalePause(runId)],
    },
  ])(
    '$name is a takeover the Home reports as such: exit class 6, nothing handed off, nothing claimed',
    async ({ stream }) => {
      const { r, runId, seen, sealed } = await parkedThenFenced(stream);
      const end = await started(
        r.host.resume({ runId, kind: 'human', decision: approvalDecision() }),
      );

      expect(end.leg).toBe('resume');
      expect(end.runId).toBe(runId);
      expect(
        end.terminal,
        'the disposition is the typed takeover, not a failure and not a pause',
      ).toMatchObject({
        disposition: 'taken_over',
        safety: 6,
      });
      expect(end.terminal.headline).toContain('taken over by another process');
      expect(end.terminal.remedy).toContain(`relavium logs ${runId}`);
      expect(end.fault, 'a takeover is a disposition, not a fault of this leg').toBeUndefined();
      expect(end.handedOff, 'this host did not hand the run off').toBe(false);
      expect(
        seen.some((event) => event.type === 'run:completed'),
        'the run view was never told the run completed',
      ).toBe(false);
      expect(sealed, 'the leg`s renderer was sealed with the leg').toHaveBeenCalled();

      // The Home's exit class and the line it owes the person.
      expect(r.registry.observations.exitCode(), 'the safety fact is published as exit 6').toBe(6);
      const facts = r.host.exitFacts();
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({ kind: 'safety', runId });
      expect(facts[0]?.line).toContain('taken over by another process');

      // The leg's owner (the Home's side of the lease) is retired, and the host is free for the next leg.
      expect(end.retirement).toBe('retired');
      expect(r.registry.activeOwners).toBe(0);
      expect(r.host.snapshot()).toMatchObject({ launching: false, active: undefined });
      expect(r.host.snapshot().last).toBe(end);
      // This process wrote nothing about the run: it is still parked, as the other process left it.
      expect(runStatus(client, runId)).toBe('paused');
    },
  );
});
