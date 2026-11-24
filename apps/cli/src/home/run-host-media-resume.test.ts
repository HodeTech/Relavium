/**
 * The media-only resume of the Home's run host
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, the 2026-11-23 amendment note): a run parked on
 * async media jobs and nothing else is continued with no gate and no decision, by the same core, the same single flight and the same lease
 * as a gate answer.
 *
 * The park is a REAL leg (the real run core, engine, lease table and run store over an in-memory `history.db`; the only stand-in is the
 * provider, whose `generateMedia` returns a job id and whose `pollMediaJob` answers from a script). The claims:
 *
 *   1. the parked job is RE-ATTACHED (polled by the id the log recorded) and never submitted again, and the leg ends `completed`;
 *   2. a run that also waits on a gate is refused with the fixed words BEFORE an engine, a key or a card, and stays answerable;
 *   3. a run that is not parked, or waits for no media job, is refused the same way;
 *   4. a run another process holds the lease of is refused exactly as a gate answer is refused (the same words, the same published
 *      facts), and this process writes nothing;
 *   5. the leg is the host's one single flight: a second request while it executes is turned away `busy`, and the leg's owner retires;
 *   6. the run's `secret` inputs are asked for by name, as for a gate answer (the engine will not continue without them);
 *   7. a run whose lease another process holds NOW is refused before a secret is asked for or a local server may start, and an expired
 *      lease is not a refusal (the engine's acquire stays the authority, and a race that loses it is refused the same way);
 *   8. a takeover in the middle of the leg ends it as a takeover, with nothing written after it; a leg that parks again on a second job
 *      hands the lease back like the first.
 *
 * Every operator home is a temporary directory handed in as `homeDir`; the module's two nets (a config load with no home, `os.homedir()`)
 * throw, so no path here reaches the real `~/.relavium`.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  createRunHistoryReader,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import type { LlmProvider, MediaJobStatus } from '@relavium/llm';
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
import type { ProviderResolver } from '../engine/providers.js';
import { approvalDecision } from '../gate/decision.js';
import { MEDIA_RESUME_REFUSALS } from '../run-core/resume-run.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { GENERATIVE_IMAGE_CAPABILITY_FLAGS, captureIo } from '../test-support.js';
import {
  RunHost,
  type HostedLaunch,
  type HostedLegEnd,
  type HostedSecretPort,
  type RunHostOptions,
} from './run-host.js';

/** The one named bound of every wait in this file: a wait that needs it is a defect, not a slow machine. */
const WAIT_MS = 5000;
/** A resumed job is first polled `pollInitialMs` (5 s) after it is re-attached, on the engine's own clock: the one real wait of this file. */
const RESUMED_LEG_MS = 20_000;

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
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-run-host-media-'));
  client = createClient(':memory:');
  runMigrations(client.db);
  fallbackHome = undefined;
  // The generative model the workflows name: routed to `generateMedia` by the catalog (ADR-0045 §1).
  const deps = { uuid: () => randomUUID(), now: () => Date.now() };
  const providerId = createProviderStore(client.db, deps).upsert({
    name: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
  }).id;
  createModelCatalogStore(client.db, deps).upsert({
    providerId,
    modelId: 'gen-model',
    displayName: 'Generative Image Model',
    contextWindowTokens: 4096,
    maxOutputTokens: 4096,
    mediaSurface: 'generative',
    capabilities: GENERATIVE_IMAGE_CAPABILITY_FLAGS,
  });
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

/** One generative node: the run parks on its async job and on nothing else. */
const MEDIA_ONLY = `schema_version: '1.0'
workflow:
  id: media-only-park
  agents:
    - { id: painter, model: gen-model, provider: openai, system_prompt: paint }
  nodes:
    - { id: start, type: input }
    - { id: paint, type: agent, agent_ref: painter, prompt_template: 'draw a cat', output_modalities: ['image'] }
    - { id: out, type: output }
  edges:
    - { from: start, to: paint }
    - { from: paint, to: out }
`;

/** A generative node and a human gate side by side: the run parks on the job AND on a person. */
const GATE_AND_MEDIA = `schema_version: '1.0'
workflow:
  id: gate-and-media-park
  agents:
    - { id: painter, model: gen-model, provider: openai, system_prompt: paint }
  nodes:
    - { id: start, type: input }
    - { id: paint, type: agent, agent_ref: painter, prompt_template: 'draw a cat', output_modalities: ['image'] }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: paint }
    - { from: start, to: g }
    - { from: paint, to: out }
    - { from: g, to: out }
`;

/** A human gate and nothing else. */
const GATE_ONLY = `schema_version: '1.0'
workflow:
  id: gate-only-park
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: out }
`;

/** The media-only park with one `secret` input: its durable record holds only the masked slot. */
const MEDIA_ONLY_SECRET = MEDIA_ONLY.replace(
  '  agents:',
  '  inputs:\n    - { name: api_key, type: secret }\n  agents:',
).replace('id: media-only-park', 'id: media-only-secret');

/** One more generative node after the first: the continued run parks AGAIN on a second job. */
const TWO_JOBS = `schema_version: '1.0'
workflow:
  id: two-jobs-park
  agents:
    - { id: painter, model: gen-model, provider: openai, system_prompt: paint }
  nodes:
    - { id: start, type: input }
    - { id: paint, type: agent, agent_ref: painter, prompt_template: 'draw a cat', output_modalities: ['image'] }
    - { id: again, type: agent, agent_ref: painter, prompt_template: 'draw a dog', output_modalities: ['image'] }
    - { id: out, type: output }
  edges:
    - { from: start, to: paint }
    - { from: paint, to: again }
    - { from: again, to: out }
`;

/**
 * The media-only park with a masked slot AND a local MCP server (declared by an agent no node uses: only the consent gate cares): what a
 * continue would ask the person for (a secret, a card) before the engine ever looks at the lease.
 */
const MEDIA_ONLY_GUARDED = MEDIA_ONLY_SECRET.replace(
  'id: media-only-secret',
  'id: media-only-guarded',
).replace(
  '    - { id: painter, model: gen-model, provider: openai, system_prompt: paint }\n',
  `    - { id: painter, model: gen-model, provider: openai, system_prompt: paint }
    - id: worker
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: synthetic
      tools: []
      mcp_servers:
        - { id: local, transport: stdio, command: ${JSON.stringify(process.execPath)} }
`,
);

function writeWorkflow(name: string, yaml: string): string {
  const path = join(root, name);
  writeFileSync(path, yaml);
  return path;
}

// Complete independent 1x1 RGB PNG: IHDR, zlib-compressed red pixel IDAT, IEND and CRCs.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// ---------------------------------------------------------------------------------------------------------------------
// The provider: an async media job whose polls answer from a script.
// ---------------------------------------------------------------------------------------------------------------------

interface JobProvider {
  readonly providers: ProviderResolver;
  readonly generated: () => number;
  readonly polled: () => readonly string[];
}

/**
 * `generateMedia` accepts a job (`job-1`, then `job-2`, …); `pollMediaJob` answers `script`, in order, repeating the last, or, with
 * `answer`, what it says for the job id asked about.
 */
function jobProvider(
  script: readonly MediaJobStatus[],
  answer?: (jobId: string) => MediaJobStatus,
): JobProvider {
  let generated = 0;
  const polled: string[] = [];
  const provider: LlmProvider = {
    id: 'openai',
    supports: GENERATIVE_IMAGE_CAPABILITY_FLAGS,
    generate: () => Promise.reject(new Error('generate must not run for a generative node')),
    stream: (): AsyncIterable<never> => {
      throw new Error('stream must not run for a generative node');
    },
    generateMedia: () => {
      generated += 1;
      return Promise.resolve({ jobId: `job-${String(generated)}`, raw: {} });
    },
    pollMediaJob: (jobId) => {
      polled.push(jobId);
      return Promise.resolve(
        answer?.(jobId) ??
          script[Math.min(polled.length - 1, script.length - 1)] ?? { state: 'pending' },
      );
    },
  };
  return {
    providers: { resolveProvider: () => provider, keyFor: () => 'sk-test' },
    generated: () => generated,
    polled: () => polled,
  };
}

const DONE: MediaJobStatus = {
  state: 'done',
  media: { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: PNG_BASE64 } },
};

// ---------------------------------------------------------------------------------------------------------------------
// The rig.
// ---------------------------------------------------------------------------------------------------------------------

interface Rig {
  readonly host: RunHost;
  readonly builds: ReturnType<typeof vi.fn>;
  readonly registry: ReturnType<typeof invocationFixture>['registry'];
}

function rig(provider: JobProvider, over: Partial<RunHostOptions> = {}): Rig {
  const f = invocationFixture();
  const operatorHome = mkdtempSync(join(tmpdir(), 'relavium-run-host-media-home-'));
  scratch.push(operatorHome);
  fallbackHome = operatorHome;
  const builds = vi.fn();
  const host = new RunHost({
    invocation: f.invocation,
    io: captureIo().io,
    global: { json: false, color: false, cwd: root, configPath: undefined, verbosity: 'normal' },
    db: client.db,
    homeDir: operatorHome,
    providers: provider.providers,
    buildEngine: (options?: BuildEngineOptions) => {
      builds();
      return buildEngine(options);
    },
    sweepMedia: vi.fn(() => Promise.resolve(undefined)),
    ...over,
  });
  return { host, builds, registry: f.registry };
}

async function started(launch: Promise<HostedLaunch> | HostedLaunch): Promise<HostedLegEnd> {
  const resolved = await launch;
  if (resolved.kind !== 'started')
    throw new Error(`expected a started leg, got ${JSON.stringify(resolved)}`);
  return resolved.ended;
}

/** Park a workflow with the host and return the run's id. */
async function park(
  r: Rig,
  yaml: string,
  name: string,
  secrets?: HostedSecretPort,
): Promise<string> {
  const end = await started(
    r.host.start({
      workflow: writeWorkflow(name, yaml),
      rawInputs: {},
      ...(secrets === undefined ? {} : { secrets }),
    }),
  );
  expect(end.terminal.disposition, 'the leg parked').toBe('paused');
  return end.runId;
}

function eventsOf(runId: string): RunEvent[] {
  return createRunHistoryReader(client.db).loadRunEvents(runId);
}

function runStatus(runId: string): unknown {
  const row = client.sqlite.prepare('SELECT status FROM runs WHERE id = ?').get(runId);
  return typeof row === 'object' && row !== null && 'status' in row ? row.status : undefined;
}

function storeOf(runId: string) {
  const row = client.sqlite
    .prepare('SELECT workflow_definition_snapshot FROM runs WHERE id = ?')
    .get(runId);
  const snapshot =
    typeof row === 'object' && row !== null && 'workflow_definition_snapshot' in row
      ? String(row.workflow_definition_snapshot)
      : '{}';
  return createRunHistoryStore(client.db, {
    uuid: () => randomUUID(),
    now: () => Date.now(),
    workflow: { slug: 'media-only-park', name: 'media-only-park', definitionJson: snapshot },
  });
}

/** What the park left: a pause that names a media job, no gate, and the lease handed back. */
function expectMediaOnlyPark(runId: string): void {
  const paused = eventsOf(runId).filter((event) => event.type === 'run:paused');
  expect(paused).toHaveLength(1);
  const [pause] = paused;
  expect(pause?.type === 'run:paused' ? pause.pendingMediaJobNodeIds : undefined).toEqual([
    'paint',
  ]);
  expect(pause?.type === 'run:paused' ? pause.gateIds : undefined).toEqual([]);
  expect(createRunHistoryReader(client.db).loadRunLeases([runId]).size, 'no lease is held').toBe(0);
}

/** Another process takes the run's lease row, as a second Home or `relavium gate` would. */
async function holdLeaseElsewhere(runId: string, ownerId: string): Promise<void> {
  const store = createRunHistoryStore(client.db, {
    uuid: () => randomUUID(),
    now: () => Date.now(),
    workflow: { slug: 'x', name: 'x', definitionJson: '{}' },
  });
  const fence = await createRunLeasePort(store).acquire(runId, ownerId, 60_000);
  expect(fence, 'the other process took the lease').toBeDefined();
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. The parked job is re-attached.
// ---------------------------------------------------------------------------------------------------------------------

describe('a run parked on a media job alone is continued with no decision', () => {
  it(
    're-attaches the parked job by its recorded id, never submits it again, and ends completed under an owner that retires',
    async () => {
      const provider = jobProvider([DONE]);
      const r = rig(provider);
      const runId = await park(r, MEDIA_ONLY, 'media-only.relavium.yaml');
      expectMediaOnlyPark(runId);
      expect(provider.generated(), 'the park submitted the job once').toBe(1);
      expect(provider.polled(), 'the park left before it polled').toEqual([]);
      const submitted = eventsOf(runId).filter((event) => event.type === 'media_job:submitted');
      expect(submitted).toHaveLength(1);

      const end = await started(r.host.resume({ kind: 'media', runId }));

      expect(end.leg).toBe('resume');
      expect(end.runId).toBe(runId);
      expect(end.terminal.disposition).toBe('completed');
      expect(end.fault).toBeUndefined();
      expect(provider.generated(), 're-attached, never re-submitted').toBe(1);
      expect(provider.polled(), 'polled by the id the log recorded').toEqual(['job-1']);
      const log = eventsOf(runId);
      expect(log.filter((event) => event.type === 'media_job:submitted')).toHaveLength(1);
      expect(log.filter((event) => event.type === 'run:completed')).toHaveLength(1);
      expect(runStatus(runId)).toBe('completed');
      // The leg's own owner is retired, no lease is left behind, and the host is free for the next leg.
      expect(end.retirement).toBe('retired');
      expect(r.registry.activeOwners).toBe(0);
      expect(createRunHistoryReader(client.db).loadRunLeases([runId]).size).toBe(0);
      expect(r.host.snapshot()).toMatchObject({ launching: false, active: undefined });
      expect(r.host.snapshot().last).toBe(end);

      // A second continue of the run that ended is the same clean no-op a doubled decision is: nothing is built, nothing is polled.
      const buildsBefore = r.builds.mock.calls.length;
      const again = await r.host.resume({ kind: 'media', runId });
      expect(again).toEqual({ kind: 'settled', message: 'run completed; nothing to resume' });
      expect(r.builds.mock.calls).toHaveLength(buildsBefore);
      expect(provider.generated()).toBe(1);
    },
    RESUMED_LEG_MS,
  );

  it(
    'is one single flight: a request while the leg executes is turned away busy, and a cancel ends the leg with its owner retired',
    async () => {
      const provider = jobProvider([{ state: 'pending' }]);
      const r = rig(provider);
      const runId = await park(r, MEDIA_ONLY, 'busy.relavium.yaml');
      const launch = await r.host.resume({ kind: 'media', runId });
      if (launch.kind !== 'started') throw new Error('the leg did not start');

      const second = await r.host.resume({ kind: 'media', runId });
      expect(second).toMatchObject({ kind: 'refused', reason: 'busy' });
      expect(second.kind === 'refused' ? second.message : '').toContain(runId);

      expect(r.host.cancel()).toBe(true);
      const end = await launch.ended;
      expect(end.terminal.disposition).toBe('cancelled');
      expect(end.retirement).toBe('retired');
      expect(r.registry.activeOwners).toBe(0);
      expect(provider.generated(), 'a cancelled continue submits nothing').toBe(1);
    },
    WAIT_MS * 2,
  );

  it('asks the secret port, by name, for the masked slot of the run, and passes the value to the run and nowhere else', async () => {
    const provider = jobProvider([{ state: 'pending' }]);
    const r = rig(provider);
    const seen: (readonly string[])[] = [];
    const secrets: HostedSecretPort = (names) => {
      seen.push(names);
      return Promise.resolve({ api_key: 'a-secret-value' });
    };
    const runId = await park(r, MEDIA_ONLY_SECRET, 'secret.relavium.yaml', secrets);
    seen.length = 0;

    const launch = await r.host.resume({ kind: 'media', runId, secrets });
    if (launch.kind !== 'started') throw new Error('the leg did not start');
    expect(seen, 'asked once, by name').toEqual([['api_key']]);
    r.host.cancel();
    const end = await launch.ended;
    expect(JSON.stringify(eventsOf(runId))).not.toContain('a-secret-value');
    expect(end.retirement).toBe('retired');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. What a continue refuses, before it costs anything.
// ---------------------------------------------------------------------------------------------------------------------

describe('a cancel that lands while the engine prepares a continue never cancels the run (H1)', () => {
  it.each(['before', 'inside'] as const)(
    'an Esc that lands %s resumeFromCheckpoint leaves the parked jobs to be fetched: the run completes, it is not cancelled',
    async (when) => {
      const provider = jobProvider([DONE]);
      const controller = new AbortController();
      let armed = false;
      const r = rig(provider, {
        buildEngine: async (options?: BuildEngineOptions) => {
          const engine = await buildEngine(options);
          const original = engine.resumeFromCheckpoint.bind(engine);
          engine.resumeFromCheckpoint = (input) => {
            if (armed && when === 'before') controller.abort();
            const pending = original(input);
            if (armed && when === 'inside') controller.abort();
            return pending;
          };
          return engine;
        },
      });
      const runId = await park(r, MEDIA_ONLY, 'cancel-window.relavium.yaml');
      armed = true;

      const end = await started(r.host.resume({ kind: 'media', runId, signal: controller.signal }));

      expect(controller.signal.aborted, 'the cancel did land').toBe(true);
      expect(end.terminal.disposition).toBe('completed');
      expect(runStatus(runId), 'the paid job was fetched, and the run was never cancelled').toBe(
        'completed',
      );
      expect(provider.polled()).toEqual(['job-1']);
      expect(eventsOf(runId).some((event) => event.type === 'run:cancelled')).toBe(false);
    },
    RESUMED_LEG_MS,
  );
});

describe('a continue is refused before an engine, a key or a card', () => {
  it('for a run that also waits on a human gate: it needs a decision, and the gate stays answerable', async () => {
    const provider = jobProvider([DONE]);
    const r = rig(provider);
    const runId = await park(r, GATE_AND_MEDIA, 'both.relavium.yaml');
    const buildsBefore = r.builds.mock.calls.length;

    const refused = await r.host.resume({ kind: 'media', runId });

    expect(refused).toEqual({
      kind: 'refused',
      reason: 'rejected',
      message: MEDIA_RESUME_REFUSALS.pendingGate,
    });
    expect(r.builds.mock.calls.length, 'no engine was built').toBe(buildsBefore);
    expect(provider.polled(), 'the job was not touched').toEqual([]);
    expect(runStatus(runId)).toBe('paused');
    expect(r.registry.activeOwners).toBe(0);
  });

  it('for a run that waits on a gate only: not a media park', async () => {
    const provider = jobProvider([DONE]);
    const r = rig(provider);
    const runId = await park(r, GATE_ONLY, 'gate.relavium.yaml');
    const buildsBefore = r.builds.mock.calls.length;

    const refused = await r.host.resume({ kind: 'media', runId });

    expect(refused).toEqual({
      kind: 'refused',
      reason: 'rejected',
      message: MEDIA_RESUME_REFUSALS.pendingGate,
    });
    expect(r.builds.mock.calls).toHaveLength(buildsBefore);
    // Nothing of the gate was touched: a decision still answers it.
    const end = await started(
      r.host.resume({ runId, kind: 'human', decision: approvalDecision() }),
    );
    expect(end.terminal.disposition).toBe('completed');
  });

  it('for a run whose job is no longer in flight: it waits for no media job', async () => {
    const provider = jobProvider([DONE]);
    const r = rig(provider);
    const runId = await park(r, MEDIA_ONLY, 'gone.relavium.yaml');
    // The job finished (its node settled) in a process that died before it wrote the next pause: the log still says `paused`.
    const last = eventsOf(runId).at(-1)?.sequenceNumber ?? 0;
    await storeOf(runId).persistEvent({
      type: 'node:completed',
      runId,
      timestamp: new Date().toISOString(),
      sequenceNumber: last + 1,
      nodeId: 'paint',
      output: {},
      tokensUsed: { input: 0, output: 0 },
      durationMs: 1,
      cumulativeCostMicrocents: 0,
    });
    const buildsBefore = r.builds.mock.calls.length;

    const refused = await r.host.resume({ kind: 'media', runId });

    expect(refused).toEqual({
      kind: 'refused',
      reason: 'rejected',
      message: MEDIA_RESUME_REFUSALS.noMediaJobs,
    });
    expect(r.builds.mock.calls.length, 'no engine was built').toBe(buildsBefore);
  });

  it('for a run whose log never announced a pause: it is not parked, whatever job it holds', async () => {
    const provider = jobProvider([DONE]);
    const r = rig(provider);
    const runId = await park(r, MEDIA_ONLY, 'unparked.relavium.yaml');
    // The crash-in-window shape: the job was recorded and the process died before `run:paused`. Another process may be running it.
    client.sqlite
      .prepare("DELETE FROM run_events WHERE run_id = ? AND event_type = 'run:paused'")
      .run(runId);
    const buildsBefore = r.builds.mock.calls.length;

    const refused = await r.host.resume({ kind: 'media', runId });

    expect(refused).toEqual({
      kind: 'refused',
      reason: 'rejected',
      message: MEDIA_RESUME_REFUSALS.notParked,
    });
    expect(r.builds.mock.calls.length, 'no engine was built').toBe(buildsBefore);
    expect(provider.polled()).toEqual([]);
  });

  it('for a run recorded for another directory, as a gate answer is', async () => {
    const provider = jobProvider([DONE]);
    const r = rig(provider);
    const runId = await park(r, MEDIA_ONLY, 'elsewhere.relavium.yaml');
    client.sqlite.prepare('UPDATE runs SET project_root = ? WHERE id = ?').run('/elsewhere', runId);
    const buildsBefore = r.builds.mock.calls.length;

    const refused = await r.host.resume({ kind: 'media', runId });

    expect(refused).toMatchObject({ kind: 'refused', reason: 'other_project' });
    expect(r.builds.mock.calls).toHaveLength(buildsBefore);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. The lease.
// ---------------------------------------------------------------------------------------------------------------------

describe('a continue takes the run`s lease as a gate answer does, and fails closed when another process holds it', () => {
  it.each([
    {
      name: 'a gate park, held before the answer',
      yaml: GATE_ONLY,
      file: 'lease-gate.relavium.yaml',
    },
    {
      name: 'a media park, taken in the gap between the early check and the engine`s acquire',
      yaml: MEDIA_ONLY,
      file: 'lease-media.relavium.yaml',
    },
  ])(
    '$name: refused by the engine with the holder named, nothing written, no fact published, and the other process keeps the lease',
    async ({ yaml, file }) => {
      const provider = jobProvider([DONE]);
      // The engine is built AFTER the early lease check, so a lease taken as it is built is the race the check cannot close: the
      // engine's acquire (the authority) is what refuses it.
      let raceFor: string | undefined;
      const r = rig(provider, {
        buildEngine: async (options?: BuildEngineOptions) => {
          if (raceFor !== undefined) await holdLeaseElsewhere(raceFor, 'someone-else');
          return buildEngine(options);
        },
      });
      const runId = await park(r, yaml, file);
      const before = eventsOf(runId).length;
      if (yaml === MEDIA_ONLY) raceFor = runId;
      else await holdLeaseElsewhere(runId, 'someone-else');

      const refused = await r.host.resume(
        yaml === MEDIA_ONLY
          ? { kind: 'media', runId }
          : { runId, kind: 'human', decision: approvalDecision() },
      );

      expect(refused).toMatchObject({ kind: 'refused', reason: 'rejected' });
      const message = refused.kind === 'refused' ? refused.message : '';
      expect(message).toContain('another process owns this run');
      expect(message).toContain('someone-else');
      // A refusal before a leg starts is that leg's own: it is shown, and no safety fact or exit class outlives it (the same for both).
      expect(r.registry.observations.exitCode()).toBe(0);
      expect(r.host.exitFacts()).toEqual([]);
      expect(eventsOf(runId), 'this process wrote nothing').toHaveLength(before);
      expect(provider.polled(), 'the job was not polled').toEqual([]);
      expect(
        createRunHistoryReader(client.db).loadRunLeases([runId]).get(runId)?.ownerId,
        'the other owner still holds it',
      ).toBe('someone-else');
      expect(runStatus(runId)).toBe('paused');
      expect(r.registry.activeOwners).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. The early check of a live lease.
// ---------------------------------------------------------------------------------------------------------------------

describe('a run another process is working now is refused before a secret is asked for or a server may start', () => {
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

  const SECRETS: HostedSecretPort = () => Promise.resolve({ api_key: 'a-secret-value' });

  /** A media park with a masked slot and a local server; the machine's grant is withdrawn, so a resumed leg would ask. */
  async function parkedGuarded(consentAnswer: boolean) {
    const provider = jobProvider([DONE]);
    const consent = vi.fn<ConsentPrompter>(() => Promise.resolve(consentAnswer));
    const startMcpClient = vi.fn(() => realStartMcpClient([]));
    const r = rig(provider, { consent, startMcpClient });
    const home = scratch.at(-1) ?? '';
    appendGrant(mcpConsentPath(home), await digest());
    const runId = await park(r, MEDIA_ONLY_GUARDED, 'guarded.relavium.yaml', SECRETS);
    expect(consent, 'the start leg found the grant and asked nothing').not.toHaveBeenCalled();
    rmSync(mcpConsentPath(home));
    return { r, runId, provider, consent, startMcpClient };
  }

  it('refuses a live lease at once: no secret is asked, no card is opened, no server starts, no engine is built, nothing is written', async () => {
    const { r, runId, provider, consent, startMcpClient } = await parkedGuarded(true);
    await holdLeaseElsewhere(runId, 'someone-else');
    const secrets = vi.fn<HostedSecretPort>(SECRETS);
    const before = eventsOf(runId).length;
    const buildsBefore = r.builds.mock.calls.length;
    const startsBefore = startMcpClient.mock.calls.length;

    const refused = await r.host.resume({ kind: 'media', runId, secrets });

    expect(refused).toEqual({
      kind: 'refused',
      reason: 'rejected',
      message: MEDIA_RESUME_REFUSALS.liveLease,
    });
    expect(MEDIA_RESUME_REFUSALS.liveLease).toBe('That run is being continued by another process.');
    expect(secrets, 'no secret was asked for').not.toHaveBeenCalled();
    expect(consent, 'no card was opened').not.toHaveBeenCalled();
    expect(startMcpClient.mock.calls.length, 'no server was started').toBe(startsBefore);
    expect(r.builds.mock.calls.length, 'no engine was built').toBe(buildsBefore);
    expect(eventsOf(runId)).toHaveLength(before);
    expect(provider.polled()).toEqual([]);
    expect(
      createRunHistoryReader(client.db).loadRunLeases([runId]).get(runId)?.ownerId,
      'the other owner still holds it',
    ).toBe('someone-else');
    expect(r.registry.activeOwners).toBe(0);
  });

  it('does not refuse an EXPIRED lease: the owner is gone, so the secrets are asked for and the card opens (the engine takes the lease over)', async () => {
    const { r, runId, consent } = await parkedGuarded(false);
    await holdLeaseElsewhere(runId, 'gone-owner');
    client.sqlite
      .prepare('UPDATE run_leases SET expires_at = ? WHERE run_id = ?')
      .run(Date.now() - 1_000, runId);
    const secrets = vi.fn<HostedSecretPort>(SECRETS);

    const refused = await r.host.resume({ kind: 'media', runId, secrets });

    // The card said no, so the leg stops there: past the early check, past the secrets, at the consent gate.
    expect(secrets).toHaveBeenCalledTimes(1);
    expect(consent).toHaveBeenCalledTimes(1);
    expect(refused).toMatchObject({ kind: 'refused', reason: 'rejected' });
    expect(refused.kind === 'refused' ? refused.message : '').toContain('was not approved');
    expect(refused.kind === 'refused' ? refused.message : '').not.toBe(
      MEDIA_RESUME_REFUSALS.liveLease,
    );
  });

  it('does not refuse a run nobody holds: the check is about a live lease and nothing else', async () => {
    const { r, runId, consent } = await parkedGuarded(false);
    const refused = await r.host.resume({ kind: 'media', runId, secrets: SECRETS });
    expect(consent, 'no lease: the leg went on to the card').toHaveBeenCalledTimes(1);
    expect(refused.kind === 'refused' ? refused.message : '').toContain('was not approved');
  });
});

describe('a continue without the secrets the run needs says so without naming a gate', () => {
  it('refuses with what is missing and stops, with no shell command to copy', async () => {
    const provider = jobProvider([DONE]);
    const r = rig(provider);
    const secrets: HostedSecretPort = () => Promise.resolve({ api_key: 'a-secret-value' });
    const runId = await park(r, MEDIA_ONLY_SECRET, 'nosecrets.relavium.yaml', secrets);
    const buildsBefore = r.builds.mock.calls.length;

    const refused = await r.host.resume({ kind: 'media', runId });

    const message = refused.kind === 'refused' ? refused.message : '';
    expect(refused).toMatchObject({ kind: 'refused', reason: 'rejected' });
    expect(message).toContain('needs its `secret` input(s) [api_key] re-supplied to continue');
    expect(message).toContain('they are never persisted.');
    expect(message).not.toMatch(/gate|--secret-stdin|relavium gate/u);
    expect(r.builds.mock.calls).toHaveLength(buildsBefore);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. A takeover in the middle of the leg, and a leg that parks again.
// ---------------------------------------------------------------------------------------------------------------------

describe('a continued leg whose run another process takes while it polls', () => {
  it(
    'ends as a takeover (exit class 6), writes nothing after it, leaves the other owner its lease, and retires its owner',
    async () => {
      const provider = jobProvider([DONE]);
      const r = rig(provider);
      const runId = await park(r, MEDIA_ONLY, 'takeover.relavium.yaml');
      const launch = await r.host.resume({ kind: 'media', runId });
      if (launch.kind !== 'started') throw new Error('the leg did not start');
      expect(provider.polled(), 'the leg is waiting for its first poll').toEqual([]);

      // Another process takes the run (a new generation under another owner) while this leg waits to poll.
      client.sqlite
        .prepare('UPDATE run_leases SET owner_id = ?, generation = generation + 1 WHERE run_id = ?')
        .run('taker', runId);
      const before = eventsOf(runId).length;

      const end = await launch.ended;

      expect(end.leg).toBe('resume');
      expect(end.runId).toBe(runId);
      expect(end.terminal, 'the typed takeover, not a failure and not a pause').toMatchObject({
        disposition: 'taken_over',
        safety: 6,
      });
      expect(end.terminal.headline).toContain('taken over by another process');
      expect(end.terminal.remedy).toContain(`relavium logs ${runId}`);
      expect(end.fault, 'a takeover is a disposition, not a fault of this leg').toBeUndefined();
      expect(end.handedOff).toBe(false);
      expect(eventsOf(runId), 'this process wrote nothing after the takeover').toHaveLength(before);
      expect(eventsOf(runId).some((event) => event.type === 'run:completed')).toBe(false);
      expect(runStatus(runId)).toBe('paused');
      expect(
        createRunHistoryReader(client.db).loadRunLeases([runId]).get(runId)?.ownerId,
        'the taker keeps its lease',
      ).toBe('taker');
      // The Home's exit class and the line it owes the person.
      expect(r.registry.observations.exitCode()).toBe(6);
      const facts = r.host.exitFacts();
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({ kind: 'safety', runId });
      expect(facts[0]?.line).toContain('taken over by another process');
      // The leg's owner is retired and the host is free for the next leg.
      expect(end.retirement).toBe('retired');
      expect(r.registry.activeOwners).toBe(0);
      expect(r.host.snapshot()).toMatchObject({ launching: false, active: undefined });
    },
    RESUMED_LEG_MS,
  );
});

describe('a continued leg that parks again on a second job', () => {
  it(
    'hands the lease back at the second park, as the first leg did, ends paused, and leaves the run continuable',
    async () => {
      // `job-1` is done at its first poll; `job-2` (the second node's) is never polled, because the leg departs at the second pause.
      const provider = jobProvider([], (jobId) =>
        jobId === 'job-1' ? DONE : { state: 'pending' },
      );
      const r = rig(provider);
      const runId = await park(r, TWO_JOBS, 'twice.relavium.yaml');
      expect(provider.generated(), 'the first leg submitted the first job').toBe(1);

      const end = await started(r.host.resume({ kind: 'media', runId }));

      expect(end.terminal.disposition, 'parked again, not completed').toBe('paused');
      expect(end.fault).toBeUndefined();
      expect(
        provider.generated(),
        'the second node submitted its own job; the first was not submitted again',
      ).toBe(2);
      expect(provider.polled(), 'the first job was re-attached by its recorded id').toEqual([
        'job-1',
      ]);
      const pauses = eventsOf(runId).filter((event) => event.type === 'run:paused');
      expect(pauses).toHaveLength(2);
      expect(
        pauses.at(-1)?.type === 'run:paused' ? pauses.at(-1)?.pendingMediaJobNodeIds : undefined,
      ).toEqual(['again']);
      expect(runStatus(runId)).toBe('paused');
      // No lease row is left once the leg has departed at the second park, and the owner retired: another Home may continue it now.
      expect(
        createRunHistoryReader(client.db).loadRunLeases([runId]).size,
        'the second park gave the lease back',
      ).toBe(0);
      expect(end.retirement).toBe('retired');
      expect(r.registry.activeOwners).toBe(0);
      expect(r.host.snapshot()).toMatchObject({ launching: false, active: undefined });
    },
    RESUMED_LEG_MS,
  );
});
