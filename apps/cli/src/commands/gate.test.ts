import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EngineStateError,
  parseWorkflow,
  type CheckpointState,
  type RunHandle,
  type WorkflowEngine,
} from '@relavium/core';
import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  createRunHistoryStore,
  runMigrations,
  type Db,
  type DbClient,
  type RunHistoryStore,
} from '@relavium/db';
import type { RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildEngine, type BuildEngineOptions } from '../engine/build-engine.js';
import { createCliHost } from '../engine/host.js';
import type { GatePrompter } from '../gate/prompter.js';
import { isCliError } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo, CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import { gateCommand, resolveSaveToRoot, selectGate, type GateCommandDeps } from './gate.js';

/** A WorkflowEngine stub exposing only resumeFromCheckpoint — for the closed-handle / EngineStateError paths
 *  that the real engine can't be driven into deterministically (they need a concurrent-settle race). */
function stubEngine(resumeFromCheckpoint: WorkflowEngine['resumeFromCheckpoint']): WorkflowEngine {
  return { resumeFromCheckpoint } as unknown as WorkflowEngine;
}

/** A closed RunHandle: its event stream completes immediately with zero events (what createClosedRunHandle yields). */
function emptyHandle(runId: string): RunHandle {
  return {
    runId,
    events: (async function* (): AsyncGenerator<RunEvent> {})(),
    subscribe: () => () => {},
    cancel: () => {},
    whenConsumersReady: () => Promise.resolve(),
  };
}

// gate → double (reads inputs.n, restored on resume) → out. The in-memory host pauses at the fail-closed gate.
const GATED = `schema_version: '1.0'
workflow:
  id: gate-resume
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

// Two gates on parallel branches → a multi-gate pause that requires --gate to disambiguate.
const TWO_GATES = `schema_version: '1.0'
workflow:
  id: gate-two
  nodes:
    - { id: start, type: input }
    - { id: g1, type: human_gate, gate_type: approval }
    - { id: g2, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g1 }
    - { from: start, to: g2 }
    - { from: g1, to: out }
    - { from: g2, to: out }
`;

// SEQUENTIAL gates (g1 → g2): only g1 pends initially; resolving it re-pauses the run at g2.
const SEQ_GATES = `schema_version: '1.0'
workflow:
  id: gate-seq
  nodes:
    - { id: start, type: input }
    - { id: g1, type: human_gate, gate_type: approval }
    - { id: g2, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g1 }
    - { from: g1, to: g2 }
    - { from: g2, to: out }
`;

// A gate_type=input gate, for the --input resume path.
const INPUT_GATED = `schema_version: '1.0'
workflow:
  id: gate-input
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: out }
`;

// A run with a SECRET-typed input — masked at persist time, so a cross-process resume cannot restore it.
const SECRET_GATED = `schema_version: '1.0'
workflow:
  id: gate-secret
  inputs:
    - { name: token, type: secret }
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: out }
`;

// `os.homedir()` reads `HOME` on POSIX but `USERPROFILE` on Windows — override BOTH so the hermetic home holds
// cross-platform. The resume path builds the media wiring (the global CAS root resolves under the home), and the
// `save_to` scope root is the resumer's `cwd` — both must be tmpdirs, never the real home / repo cwd.
const HOME_ENV_VARS = ['HOME', 'USERPROFILE'] as const;
let root: string;
let home: string;
const savedHome = new Map<string, string | undefined>();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-gate-'));
  home = mkdtempSync(join(tmpdir(), 'relavium-gate-home-'));
  for (const v of HOME_ENV_VARS) {
    savedHome.set(v, process.env[v]);
    process.env[v] = home;
  }
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const v of HOME_ENV_VARS) {
    const prior = savedHome.get(v);
    if (prior === undefined) {
      delete process.env[v];
    } else {
      process.env[v] = prior;
    }
  }
  rmSync(home, { recursive: true, force: true });
});

function globalOptions(): GlobalOptions {
  return {
    json: false,
    color: false,
    cwd: root,
    configPath: undefined,
    verbosity: 'normal',
  };
}

describe('gateCommand', () => {
  let client: DbClient;
  let db: Db;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    db = client.db;
  });
  afterEach(() => {
    client.sqlite.close();
  });

  /** The injected deps for a resume over the SHARED in-memory db (no-op close — the db spans the whole test). */
  function deps(io: ReturnType<typeof captureIo>['io']): GateCommandDeps {
    return { io, global: globalOptions(), openDb: () => ({ db, close: () => {} }) };
  }

  /** A read-only history store over the shared db (for asserting persisted events post-resume). */
  function reader(): RunHistoryStore {
    return createRunHistoryStore(db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: { slug: 'x', name: 'x', definitionJson: '{}' },
    });
  }

  /** Drive a gated workflow to its pause against the db store (persisting run:started → run:paused). */
  async function setupPausedRun(
    yaml = GATED,
    inputs: Record<string, unknown> = { n: 7 },
    projectRoot?: string,
  ): Promise<{ runId: string; gateIds: string[] }> {
    const def = parseWorkflow(yaml, { source: 'gate.test' });
    const store = createRunHistoryStore(db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      ...(projectRoot === undefined ? {} : { projectRoot }), // persist runs.project_root for the resume re-jail test
      workflow: {
        slug: def.workflow.id,
        name: def.workflow.name ?? def.workflow.id,
        definitionJson: JSON.stringify(def),
      },
    });
    const engine = await buildEngine({ host: createCliHost(store) });
    const handle = engine.start({ workflow: def, inputs });
    let runId = '';
    const gateIds: string[] = [];
    for await (const event of handle.events) {
      if (event.type === 'run:started') runId = event.runId;
      if (event.type === 'human_gate:paused') gateIds.push(event.gateId);
      if (event.type === 'run:paused') break;
    }
    return { runId, gateIds };
  }

  it('wires the same media host + catalog resolveMediaSurface on a gate-resumed run (2.S)', async () => {
    // Seed a generative model into the SHARED db so the gate-path catalog (over opened.db) resolves it.
    const dbDeps = { uuid: () => randomUUID(), now: () => Date.now() };
    const providerId = createProviderStore(db, dbDeps).upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    }).id;
    createModelCatalogStore(db, dbDeps).upsert({
      providerId,
      modelId: 'gpt-image-1',
      displayName: 'GPT Image 1',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative',
    });
    const { runId } = await setupPausedRun();
    const { io } = captureIo();
    let captured: BuildEngineOptions | undefined;
    let sweptArgs:
      | { db: unknown; casRoot: string; currentRunId: string; graceMs?: number }
      | undefined;
    const code = await gateCommand(
      { runId, approve: true },
      {
        ...deps(io),
        // Capture what gate.ts assembled, then delegate to the real builder (same opts) so the text-only GATED
        // resume completes — the media ports stay un-exercised (no media node), so no fs writes occur.
        buildEngine: (opts) => {
          captured = opts;
          return buildEngine(opts);
        },
        sweepMedia: (args) => {
          sweptArgs = args;
          return Promise.resolve(undefined);
        },
      },
    );
    expect(code).toBe(EXIT_CODES.success);
    // A gate-resumed run gets the same three media ports + the catalog routing as a fresh `run` — never
    // silently text-only.
    expect(captured?.host?.mediaStore).toBeDefined();
    expect(captured?.host?.mediaReferences).toBeDefined();
    expect(captured?.host?.mediaWrite).toBeDefined();
    expect(captured?.resolveMediaSurface?.('gpt-image-1')).toBe('generative');
    expect(captured?.resolveMediaSurface?.('unknown')).toBeUndefined();
    // ...and the gate-resume terminal runs the host media GC too (2.S/D-GC), over the same db, for this run.
    expect(sweptArgs?.db).toBe(db);
    expect(sweptArgs?.currentRunId).toBe(runId);
    expect(sweptArgs?.casRoot.endsWith(join('.relavium', 'media'))).toBe(true);
    expect(sweptArgs?.graceMs).toBeUndefined(); // no [defaults].media_gc_grace_days ⇒ the GC default window
  });

  it('re-jails save_to under the ORIGINAL run project root on resume (persisted runs.project_root)', async () => {
    // Seed the paused run WITH project_root = a real dir A (distinct from the resumer cwd `root`), then resume.
    const originalRoot = mkdtempSync(join(tmpdir(), 'relavium-orig-root-'));
    try {
      const { runId } = await setupPausedRun(GATED, { n: 7 }, originalRoot);
      const { io } = captureIo();
      let captured: BuildEngineOptions | undefined;
      const code = await gateCommand(
        { runId, approve: true },
        {
          ...deps(io),
          buildEngine: (opts) => {
            captured = opts;
            return buildEngine(opts);
          },
          sweepMedia: () => Promise.resolve(undefined),
        },
      );
      expect(code).toBe(EXIT_CODES.success);
      const mediaWrite = captured?.host?.mediaWrite;
      if (mediaWrite === undefined) {
        throw new Error('expected the gate-resume host to wire mediaWrite');
      }
      // The save_to port was jailed under the ORIGINAL run root (A), not the resumer cwd — invoking it lands the
      // deliverable under <A>/.relavium/runs/, proving the persisted project_root drove the wiring (rank-2 chain:
      // loadRunSnapshot.projectRoot → resolveSaveToRoot → buildMediaEngineWiring → the save_to jail root).
      await mediaWrite('out.bin', new Uint8Array([1, 2, 3]));
      const delivered = join(originalRoot, '.relavium', 'runs', 'out.bin');
      expect(existsSync(delivered)).toBe(true);
      expect(Array.from(readFileSync(delivered))).toEqual([1, 2, 3]);
      // ...and NEVER under the resumer cwd.
      expect(existsSync(join(root, '.relavium', 'runs', 'out.bin'))).toBe(false);
    } finally {
      rmSync(originalRoot, { recursive: true, force: true });
    }
  });

  it('re-runs the D15 catalog load-check on resume: a node incapable in the current catalog rejects (exit 2)', async () => {
    // A workflow whose downstream agent (model `chat-text`) authored output_modalities [text, image] the model
    // can't produce. The gate is BEFORE the agent, so the paused snapshot never ran it; on resume the gate path
    // runs the SAME catalog check `run` does — and rejects (exit 2), consistently with a fresh run.
    const incapableGated = `schema_version: '1.0'
workflow:
  id: gate-incapable
  agents:
    - { id: painter, model: gpt-4o, provider: openai, system_prompt: paint }
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: a, type: agent, agent_ref: painter, model: chat-text, output_modalities: ['text', 'image'] }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: a }
    - { from: a, to: out }
`;
    const dbDeps = { uuid: () => randomUUID(), now: () => Date.now() };
    const providerId = createProviderStore(db, dbDeps).upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    }).id;
    createModelCatalogStore(db, dbDeps).upsert({
      providerId,
      modelId: 'chat-text',
      displayName: 'Chat Text',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'chat',
      capabilities: CHAT_TEXT_CAPABILITY_FLAGS,
    });
    const { runId } = await setupPausedRun(incapableGated, {});
    const { io } = captureIo();
    let caught: unknown;
    try {
      await gateCommand({ runId, approve: true }, deps(io));
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain('chat-text'); // the catalog check rejected it, not a generic fault
    }
  });

  it('resumes a paused run on --approve, drives it to completion (exit 0), and persists the decision', async () => {
    const { runId } = await setupPausedRun();
    const { io } = captureIo();

    const code = await gateCommand({ runId, approve: true }, deps(io));

    expect(code).toBe(EXIT_CODES.success);
    const store = createRunHistoryStore(db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: { slug: 'gate-resume', name: 'gate-resume', definitionJson: '{}' },
    });
    expect(store.loadRun(runId)?.status).toBe('completed'); // the cross-process resume reached the terminal
    const events = store.loadRunEvents(runId);
    expect(events.find((e) => e.type === 'human_gate:resumed')).toMatchObject({
      decision: 'approved',
      decidedBy: 'cli',
    });
    // Inputs were RESTORED across the process boundary: the post-gate `double` node read inputs.n (=7) and
    // produced d=14. A lost-inputs regression would compute `undefined * 2` = NaN instead.
    const doubled = events.find((e) => e.type === 'node:completed' && e.nodeId === 'double');
    expect(doubled).toMatchObject({ output: { d: 14 } });
  });

  it('swallows a throwing media GC on resume — a GC fault never fails the resume (2.S/D-GC, best-effort)', async () => {
    const { runId } = await setupPausedRun();
    const { io } = captureIo();
    const code = await gateCommand(
      { runId, approve: true },
      { ...deps(io), sweepMedia: () => Promise.reject(new Error('gc boom')) },
    );
    expect(code).toBe(EXIT_CODES.success); // the resume completed; the GC rejection was swallowed at the call site
  });

  it('surfaces a corrupt stored inputs blob as a clean exit-2 fault (no silent empty-inputs resume)', async () => {
    const { runId } = await setupPausedRun();
    // Corrupt the persisted input_json to a non-JSON blob (simulating a damaged store row).
    client.sqlite.prepare('UPDATE runs SET input_json = ? WHERE id = ?').run('{not json', runId);
    const { io } = captureIo();
    await expect(gateCommand({ runId, approve: true }, deps(io))).rejects.toMatchObject({
      code: 'invalid_invocation',
    });
  });

  it('surfaces a corrupt persisted event log as a clean exit-2 fault (no raw escaping error)', async () => {
    const { runId } = await setupPausedRun();
    // Corrupt a run_events payload so the checkpoint reconstruction (loadRunEvents → JSON.parse) throws.
    client.sqlite
      .prepare('UPDATE run_events SET payload_json = ? WHERE run_id = ? AND seq = 0')
      .run('{not json', runId);
    const { io } = captureIo();
    await expect(gateCommand({ runId, approve: true }, deps(io))).rejects.toMatchObject({
      code: 'invalid_invocation',
    });
  });

  it('surfaces a valid-JSON-but-non-object inputs blob (array) as exit-2', async () => {
    const { runId } = await setupPausedRun();
    client.sqlite.prepare('UPDATE runs SET input_json = ? WHERE id = ?').run('[]', runId);
    const { io } = captureIo();
    await expect(gateCommand({ runId, approve: true }, deps(io))).rejects.toMatchObject({
      code: 'invalid_invocation',
    });
  });

  it('surfaces a corrupt workflow snapshot (bad JSON) as exit-2', async () => {
    const { runId } = await setupPausedRun();
    client.sqlite
      .prepare('UPDATE runs SET workflow_definition_snapshot = ? WHERE id = ?')
      .run('{not json', runId);
    const { io } = captureIo();
    await expect(gateCommand({ runId, approve: true }, deps(io))).rejects.toMatchObject({
      code: 'invalid_invocation',
    });
  });

  it('surfaces a schema-invalid workflow snapshot as exit-2', async () => {
    const { runId } = await setupPausedRun();
    client.sqlite
      .prepare('UPDATE runs SET workflow_definition_snapshot = ? WHERE id = ?')
      .run('{"workflow":{}}', runId);
    const { io } = captureIo();
    await expect(gateCommand({ runId, approve: true }, deps(io))).rejects.toMatchObject({
      code: 'invalid_invocation',
    });
  });

  it('surfaces a run with a snapshot but no event log as exit-2 (no resumable state)', async () => {
    const { runId } = await setupPausedRun();
    client.sqlite.prepare('DELETE FROM run_events WHERE run_id = ?').run(runId);
    const { io } = captureIo();
    await expect(gateCommand({ runId, approve: true }, deps(io))).rejects.toMatchObject({
      code: 'invalid_invocation',
    });
  });

  it('fails closed (exit-2) on a run with a SECRET input — a masked value can never be restored on resume', async () => {
    const { runId } = await setupPausedRun(SECRET_GATED, { token: ['s', 'k', '-secret'].join('') });
    const { io } = captureIo();
    await expect(gateCommand({ runId, approve: true }, deps(io))).rejects.toMatchObject({
      code: 'invalid_invocation',
    });
    // And the masked placeholder is what was persisted — never the plaintext (defence-in-depth check).
    const started = reader()
      .loadRunEvents(runId)
      .find((e) => e.type === 'run:started');
    expect(JSON.stringify(started)).not.toContain('sk-secret');
  });

  it('resolves an input gate via --input end-to-end, persisting the input_provided payload', async () => {
    const { runId } = await setupPausedRun(INPUT_GATED, {});
    const { io } = captureIo();
    const code = await gateCommand({ runId, input: 'us-east-1' }, deps(io));
    expect(code).toBe(EXIT_CODES.success);
    expect(
      reader()
        .loadRunEvents(runId)
        .find((e) => e.type === 'human_gate:resumed'),
    ).toMatchObject({
      decision: 'input_provided',
      payload: 'us-east-1',
    });
  });

  it('maps a closed-handle resume (a concurrent-settle race) to an idempotent exit 0', async () => {
    const { runId } = await setupPausedRun();
    const { io, out } = captureIo();
    const code = await gateCommand(
      { runId, approve: true },
      {
        ...deps(io),
        buildEngine: () => Promise.resolve(stubEngine(() => Promise.resolve(emptyHandle(runId)))),
      },
    );
    expect(code).toBe(EXIT_CODES.success); // a closed handle (already terminal) is an idempotent no-op, not a failure
    expect(out()).toContain('already settled');
  });

  it('maps a workflow_mismatch EngineStateError from resumeFromCheckpoint to exit-2', async () => {
    const { runId } = await setupPausedRun();
    const { io } = captureIo();
    await expect(
      gateCommand(
        { runId, approve: true },
        {
          ...deps(io),
          buildEngine: () =>
            Promise.resolve(
              stubEngine(() =>
                Promise.reject(new EngineStateError('workflow_mismatch', 'mismatch')),
              ),
            ),
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_invocation' });
  });

  it('a sequential multi-gate: blind --approve resolves g1 (re-pause → exit 3), a second resolves g2 (exit 0)', async () => {
    // The documented per-gate idempotency footgun: without --gate, a repeat auto-fills the NOW-pending next gate.
    const { runId, gateIds } = await setupPausedRun(SEQ_GATES, {});
    expect(gateIds).toHaveLength(1); // only g1 pends initially (sequential, not parallel)
    const { io } = captureIo();
    // The GC is gated on a TERMINAL outcome (2.S/D-GC): a re-pause must NOT sweep (the still-paused run keeps its
    // media); the second resolve completes → terminal → the GC runs. Pin BOTH directions.
    let sweptOnRepause = false;
    let sweptOnComplete = false;
    expect(
      await gateCommand(
        { runId, approve: true },
        { ...deps(io), sweepMedia: () => ((sweptOnRepause = true), Promise.resolve(undefined)) },
      ),
    ).toBe(EXIT_CODES.gatePaused); // g1 → re-pause at g2
    expect(sweptOnRepause).toBe(false); // the re-pause (non-terminal) skipped the GC
    expect(
      await gateCommand(
        { runId, approve: true },
        { ...deps(io), sweepMedia: () => ((sweptOnComplete = true), Promise.resolve(undefined)) },
      ),
    ).toBe(EXIT_CODES.success); // blind repeat resolves g2 → completes
    expect(sweptOnComplete).toBe(true); // the terminal resume DID run the GC
  });

  it('wires selectGatePrompter through to driveRun: a re-pause at a later gate is resolved inline (exit 0)', async () => {
    const { runId } = await setupPausedRun(SEQ_GATES, {});
    const { io } = captureIo();
    const prompter: GatePrompter = {
      prompt: () => Promise.resolve({ decision: 'approved', decidedBy: 'cli' }),
    };
    // Resume g1 via the flag; the run re-pauses at g2, which the INJECTED prompter resolves inline → completes.
    const code = await gateCommand(
      { runId, approve: true },
      { ...deps(io), selectGatePrompter: () => prompter },
    );
    expect(code).toBe(EXIT_CODES.success);
  });

  it('resumes on --reject, persisting the rejection + comment', async () => {
    const { runId } = await setupPausedRun();
    const { io } = captureIo();
    const code = await gateCommand({ runId, reject: true, comment: 'not now' }, deps(io));
    expect(code).toBe(EXIT_CODES.success);
    const store = createRunHistoryStore(db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: { slug: 'gate-resume', name: 'gate-resume', definitionJson: '{}' },
    });
    expect(store.loadRunEvents(runId).find((e) => e.type === 'human_gate:resumed')).toMatchObject({
      decision: 'rejected',
    });
  });

  it('is idempotent: a doubled decision on an already-completed run is a clean exit-0 no-op (no double-advance)', async () => {
    const { runId } = await setupPausedRun();
    const { io, out } = captureIo();
    const reader = createRunHistoryStore(db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: { slug: 'gate-resume', name: 'gate-resume', definitionJson: '{}' },
    });
    await gateCommand({ runId, approve: true }, deps(io)); // first resume → completes
    const eventsAfterFirst = reader.loadRunEvents(runId).length;

    const code = await gateCommand({ runId, approve: true }, deps(io)); // second decision
    expect(code).toBe(EXIT_CODES.success);
    expect(out()).toContain('nothing to resume'); // idempotent message, not a re-run
    expect(reader.loadRunEvents(runId)).toHaveLength(eventsAfterFirst); // NO new events — not advanced twice
  });

  it('rejects an unknown runId (exit 2)', async () => {
    const { io } = captureIo();
    let caught: unknown;
    try {
      await gateCommand({ runId: 'no-such-run', approve: true }, deps(io));
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) expect(caught.code).toBe('invalid_invocation');
  });

  it('rejects an invalid flag combination before touching the db (exit 2)', async () => {
    const { io } = captureIo();
    await expect(gateCommand({ runId: 'any' }, deps(io))).rejects.toMatchObject({
      code: 'invalid_invocation',
    });
    await expect(
      gateCommand({ runId: 'any', approve: true, reject: true }, deps(io)),
    ).rejects.toMatchObject({ code: 'invalid_invocation' });
  });

  it('requires --gate when more than one gate is pending, then resolves the named one', async () => {
    const { runId, gateIds } = await setupPausedRun(TWO_GATES, {});
    expect(gateIds.length).toBeGreaterThan(1);
    const firstGate = gateIds[0];
    if (firstGate === undefined) throw new Error('expected a pending gate');
    const { io } = captureIo();

    // No --gate → ambiguous → exit 2 listing the pending ids.
    let caught: unknown;
    try {
      await gateCommand({ runId, approve: true }, deps(io));
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain(firstGate);
    }

    // Naming the first gate resolves it; the run pauses again at the second → exit 3 (resume that one next).
    const code = await gateCommand({ runId, approve: true, gate: firstGate }, deps(io));
    expect(code).toBe(EXIT_CODES.gatePaused);
  });

  it('treats a re-approval of an already-resolved gate as an idempotent no-op (exit 0)', async () => {
    const { runId, gateIds } = await setupPausedRun(TWO_GATES, {});
    const firstGate = gateIds[0];
    if (firstGate === undefined) throw new Error('expected a pending gate');
    const { io, out } = captureIo();
    await gateCommand({ runId, approve: true, gate: firstGate }, deps(io)); // resolve g1 (run pauses at g2)
    const code = await gateCommand({ runId, approve: true, gate: firstGate }, deps(io)); // re-approve g1
    expect(code).toBe(EXIT_CODES.success);
    expect(out()).toContain('already resolved');
  });
});

describe('selectGate', () => {
  const checkpoint = (over: Partial<CheckpointState> = {}): CheckpointState => ({
    schemaVersion: 1,
    runStatus: 'paused',
    workflowId: 'wf',
    startedAtMs: 0,
    nodeStates: new Map(),
    completedNodeIds: [],
    pendingGates: [],
    pendingMediaJobs: [],
    resolvedGateIds: [],
    lastSequenceNumber: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cumulativeCostMicrocents: 0,
    ...over,
  });
  const gate = (gateId: string, isBudgetGate = false) => ({ gateId, nodeId: gateId, isBudgetGate });

  it('auto-fills the single pending human gate', () => {
    expect(selectGate(checkpoint({ pendingGates: [gate('g1')] }), 'paused', undefined)).toEqual({
      kind: 'resume',
      gateId: 'g1',
    });
  });

  it('excludes a budget gate — that is the `relavium budget resume` surface, not a human gate', () => {
    // A pending budget gate alone reads as "no human gate", not as something `relavium gate` resolves.
    expect(
      selectGate(checkpoint({ pendingGates: [gate('b1', true)] }), 'paused', undefined),
    ).toEqual({
      kind: 'invalid',
      message: 'the run is not paused at a human gate',
    });
  });

  it('treats a terminal run (completed / failed / cancelled) as an idempotent no-op', () => {
    expect(selectGate(checkpoint(), 'completed', undefined).kind).toBe('idempotent');
    expect(selectGate(checkpoint(), 'failed', undefined).kind).toBe('idempotent');
    expect(selectGate(checkpoint(), 'cancelled', undefined).kind).toBe('idempotent');
  });

  it('requires --gate for more than one pending gate, listing the ids', () => {
    const sel = selectGate(
      checkpoint({ pendingGates: [gate('g1'), gate('g2')] }),
      'paused',
      undefined,
    );
    expect(sel.kind).toBe('invalid');
    if (sel.kind === 'invalid') {
      expect(sel.message).toContain('g1');
      expect(sel.message).toContain('g2');
    }
  });

  it('--gate naming an already-resolved id is idempotent; an unknown id is invalid', () => {
    expect(selectGate(checkpoint({ resolvedGateIds: ['g1'] }), 'paused', 'g1').kind).toBe(
      'idempotent',
    );
    expect(selectGate(checkpoint({ pendingGates: [gate('g1')] }), 'paused', 'gX').kind).toBe(
      'invalid',
    );
  });

  it('reports "not paused at a human gate" when nothing is pending and nothing was resolved', () => {
    expect(selectGate(checkpoint(), 'running', undefined)).toEqual({
      kind: 'invalid',
      message: 'the run is not paused at a human gate',
    });
  });
});

describe('resolveSaveToRoot (save_to scope root on resume)', () => {
  it('uses the original run project root when it still exists on this machine', () => {
    const original = mkdtempSync(join(tmpdir(), 'relavium-orig-'));
    try {
      expect(resolveSaveToRoot(original, '/resumer/cwd')).toBe(original);
    } finally {
      rmSync(original, { recursive: true, force: true });
    }
  });

  it('falls back to the resumer cwd when the persisted project root no longer exists (deleted / other machine)', () => {
    // A collision-free absent path: a fresh tmpdir, removed, so the inner path is guaranteed not to exist.
    const parent = mkdtempSync(join(tmpdir(), 'relavium-gone-'));
    const gone = join(parent, 'inner-nonexistent');
    rmSync(parent, { recursive: true, force: true });
    expect(existsSync(gone)).toBe(false); // precondition: the path does not exist
    expect(resolveSaveToRoot(gone, '/resumer/cwd')).toBe('/resumer/cwd');
  });

  it('falls back to the resumer cwd when the persisted project root is a FILE, not a directory', () => {
    // A path that EXISTS but is a regular file must not be used as the jail scope root (existsSync would have
    // wrongly accepted it; the directory check rejects it). Using it would only fail the downstream mkdir/write.
    const parent = mkdtempSync(join(tmpdir(), 'relavium-file-'));
    const filePath = join(parent, 'not-a-dir');
    writeFileSync(filePath, 'x');
    try {
      expect(existsSync(filePath)).toBe(true); // precondition: the path exists...
      expect(resolveSaveToRoot(filePath, '/resumer/cwd')).toBe('/resumer/cwd'); // ...but is a file ⇒ fall back
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('falls back to the resumer cwd when no project root was persisted (null — pre-column run)', () => {
    expect(resolveSaveToRoot(null, '/resumer/cwd')).toBe('/resumer/cwd');
  });
});
