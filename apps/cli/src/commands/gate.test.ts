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
  isCorruptRunEventError,
  isUnreadableRunEventLogError,
  loadRunSnapshot,
  runEvents,
  runMigrations,
  type Db,
  type DbClient,
  type RunHistoryStore,
} from '@relavium/db';
import type { RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildEngine, type BuildEngineOptions } from '../engine/build-engine.js';
import { createRunLeasePort } from '@relavium/db';

import { createCliHost } from '../engine/host.js';
import type { GatePrompter } from '../gate/prompter.js';
import { isCliError, toUserFacing } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo, CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import {
  gateCommand,
  legacyMediaJobHoldNotice,
  resolveSaveToRoot,
  selectGate,
  type GateCommandDeps,
} from './gate.js';

/**
 * A WorkflowEngine stub for the closed-handle / EngineStateError paths that the real engine can't be driven
 * into deterministically (they need a concurrent-settle race).
 *
 * `drainTerminalOutbox` is stubbed too because `gateCommand` calls it at start (ADR-0078 §4/§5). A stub that
 * omits it throws a `TypeError` the command's own error mapping then reports as an invocation fault — which
 * is how these two tests found the wiring rather than the wiring finding them.
 */
function stubEngine(resumeFromCheckpoint: WorkflowEngine['resumeFromCheckpoint']): WorkflowEngine {
  return {
    resumeFromCheckpoint,
    drainTerminalOutbox: () => Promise.resolve([]),
  } as unknown as WorkflowEngine;
}

/** A closed RunHandle: its event stream completes immediately with zero events (what createClosedRunHandle yields). */
function emptyHandle(runId: string): RunHandle {
  return {
    runId,
    events: (async function* (): AsyncGenerator<RunEvent> {})(),
    subscribe: () => () => {},
    cancel: () => {},
    whenConsumersReady: () => Promise.resolve(),
    // A closed stream buffers nothing and throttles nobody (mirrors `createClosedRunHandle`).
    highWaterMark: 256,
    bufferedCount: 0,
    durability: () => 'durable' as const,
    terminalError: () => undefined,
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

// A gated run carrying a `secret` input — the durable record holds only its masked slot, so resuming it
// needs ADR-0083 §6's stdin re-supply. `double` reads `n`, not the secret: the parser forbids interpolating
// a `secret` into agent/tool text (ADR-0029), and a transform reading it would put it in a node output.
const GATED_SECRET = `schema_version: '1.0'
workflow:
  id: gate-secret
  inputs:
    - { name: n, type: number }
    - { name: api_key, type: secret }
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
    const engine = await buildEngine({
      host: createCliHost(store, { runLeases: createRunLeasePort(store) }),
    });
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

  describe('secret re-supply (ADR-0083 §6)', () => {
    const SECRET = 'sk-live-not-in-the-log';
    const seedSecretRun = (): Promise<{ runId: string; gateIds: string[] }> =>
      setupPausedRun(GATED_SECRET, { n: 7, api_key: SECRET });

    it('refuses without --secret-stdin, and NAMES the remedy', async () => {
      // The old message said "re-run the workflow instead of resuming", which threw away the run's
      // completed work for a credential the user still had. There is a way to resume now, so it says so.
      const { runId } = await seedSecretRun();
      const { io } = captureIo();
      await expect(gateCommand({ runId, approve: true }, deps(io))).rejects.toMatchObject({
        code: 'invalid_invocation',
      });
      await expect(gateCommand({ runId, approve: true }, deps(io))).rejects.toThrow(/api_key/);
      await expect(gateCommand({ runId, approve: true }, deps(io))).rejects.toThrow(
        /--secret-stdin/,
      );
    });

    it('resumes with the value from stdin, and the value never reaches the log', async () => {
      const { runId } = await seedSecretRun();
      const { io } = captureIo();
      const code = await gateCommand(
        { runId, approve: true, secretStdin: true },
        { ...deps(io), readSecretInput: () => Promise.resolve(`api_key=${SECRET}\n`) },
      );
      expect(code).toBe(EXIT_CODES.success);
      // The run continued past the gate — `double` ran on the RECORDED `n`, not on anything re-supplied.
      const events = reader().loadRunEvents(runId);
      expect(events.some((event) => event.type === 'run:completed')).toBe(true);
      // …and the credential is in none of it. The engine never re-emits `run:started` on resume, so the
      // only masked record stays the original one.
      const serialised = JSON.stringify(events);
      expect(serialised).not.toContain(SECRET);
      expect(serialised).toContain('inputs.api_key');
    });

    it('refuses a stdin payload that misses a slot, names one the run does not have, or is malformed', async () => {
      const { runId } = await seedSecretRun();
      const cases: readonly (readonly [string, RegExp])[] = [
        ['n=7\n', /did not supply/], // the slot the run needs is absent
        [`api_key=${SECRET}\nother=x\n`, /no .?secret.? slot/], // a name the run has no slot for
        ['api_key=\n', /non-empty value/], // an empty value is refused explicitly, not accepted as ''
        ['api_key\n', /non-empty value/], // not a pair at all
        [`api_key=${SECRET}\napi_key=${SECRET}\n`, /twice/], // the same name supplied twice
      ];
      for (const [payload, expected] of cases) {
        const { io } = captureIo();
        await expect(
          gateCommand(
            { runId, approve: true, secretStdin: true },
            { ...deps(io), readSecretInput: () => Promise.resolve(payload) },
          ),
        ).rejects.toThrow(expected);
      }
    });

    it('refuses --secret-stdin on a run with no secrets, rather than reading a pipe for nothing', async () => {
      const { runId } = await setupPausedRun();
      const { io } = captureIo();
      let read = 0;
      await expect(
        gateCommand(
          { runId, approve: true, secretStdin: true },
          {
            ...deps(io),
            readSecretInput: () => {
              read += 1;
              return Promise.resolve('');
            },
          },
        ),
      ).rejects.toThrow(/no .?secret.? inputs to re-supply/);
      expect(read).toBe(0); // never blocked on a pipe nobody attached
    });

    it('reads from the REAL stdin reader when no reader is injected, and names THIS command', async () => {
      // Every other test here injects `readSecretInput`, so the production wiring was replaceable with a
      // stub while the suite stayed green — and what a `gate` user actually saw when they forgot the pipe
      // was an example for `relavium provider set-key`, an unrelated command.
      //
      // Driven through the TTY guard rather than through the stream: flipping `isTTY` makes the reader
      // refuse immediately, which exercises the real function and its message without touching stdin.
      const { runId } = await seedSecretRun();
      const { io } = captureIo();
      const original = process.stdin.isTTY;
      try {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        await expect(
          gateCommand({ runId, approve: true, secretStdin: true }, deps(io)),
        ).rejects.toThrow(new RegExp(`relavium gate ${runId} --approve --secret-stdin`));
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
      }
    });

    it('carries an input named `__proto__` through the merge (ADR-0083 §9.7, the CLI path)', async () => {
      // §9.7 requires `__proto__` / `constructor` / `toString` to round-trip as ordinary inputs "on the CLI
      // path AND the engine path". The engine half is pinned in `resume-identity.test.ts`; this half was not,
      // and both of this command's accumulators could be changed to `{}` with the suite green — which would
      // put the name through the prototype setter and drop the input from the resumed run.
      const yaml = GATED_SECRET.replace(
        '- { name: api_key, type: secret }',
        '- { name: __proto__, type: secret }',
      );
      const { runId } = await setupPausedRun(yaml, { n: 7, ['__proto__']: SECRET });
      const { io } = captureIo();
      const code = await gateCommand(
        { runId, approve: true, secretStdin: true },
        { ...deps(io), readSecretInput: () => Promise.resolve(`__proto__=${SECRET}\n`) },
      );
      expect(code).toBe(EXIT_CODES.success);
      expect(({} as Record<string, unknown>)[SECRET]).toBeUndefined();
      const serialised = JSON.stringify(reader().loadRunEvents(runId));
      expect(serialised).not.toContain(SECRET);
    });

    it('a run with no secrets and no flag is untouched by any of this', async () => {
      const { runId } = await setupPausedRun();
      const { io } = captureIo();
      expect(await gateCommand({ runId, approve: true }, deps(io))).toBe(EXIT_CODES.success);
    });
  });

  it('hands the engine a store that can READ the frozen definition (ADR-0083 §5)', async () => {
    // `readWorkflowSnapshot` is the only production implementation of §5's content verification, and a review
    // measured it replaceable with `() => Promise.resolve(undefined)` while the whole monorepo stayed green:
    // the engine then takes the documented "this store holds no snapshot" branch and skips content
    // verification on every resume, silently and forever. The check cannot be pinned by its OUTCOME on this
    // path — `gate.ts` builds the workflow from the same column the engine reads, so the two agree by
    // construction — so what is pinned is the wiring: the store this command builds answers with the column.
    const { runId } = await setupPausedRun();
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
      },
    );
    expect(code).toBe(EXIT_CODES.success);
    const frozen = await captured?.host?.store.readWorkflowSnapshot(runId);
    expect(frozen).toBe(loadRunSnapshot(db, runId)?.workflowDefinitionSnapshot);
    expect(JSON.parse(frozen ?? '{}')).toMatchObject({ workflow: { id: 'gate-resume' } });
  });

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

  it('wires the user-pricing overlay on a gate-resumed run so the post-gate segment stays capped (2.5.G S10)', async () => {
    // Seed a `source='user'` price for a model the static registry does NOT know, into the SHARED db the gate
    // path reads. Without the S10 wiring the resumed run would silently uncap this model past the gate.
    const dbDeps = { uuid: () => randomUUID(), now: () => Date.now() };
    const providerId = createProviderStore(db, dbDeps).upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    }).id;
    createModelCatalogStore(db, dbDeps).upsert({
      providerId,
      modelId: 'acme-custom-1',
      source: 'user',
      inputCostPerMtokMicrocents: 300_000_000,
      outputCostPerMtokMicrocents: 900_000_000,
    });
    const { runId } = await setupPausedRun();
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
    // The overlay reached buildEngine (which threads it into BOTH the pre-egress governor and the realized
    // CostTracker), and it prices the otherwise-unknown model.
    expect(captured?.resolvePrice?.get('acme-custom-1')?.inputPerMtokMicrocents).toBe(300_000_000);
    expect(captured?.resolvePrice?.get('acme-custom-1')?.outputPerMtokMicrocents).toBe(900_000_000);
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

  // Every DAMAGED-store shape resumes to the SAME clean exit-2 (`invalid_invocation`) — never a silent
  // empty-inputs resume nor a raw escaping error. One case per corruption; only the corrupting statement differs.
  it.each([
    {
      label: 'a corrupt stored inputs blob (non-JSON)',
      corrupt: (runId: string) =>
        client.sqlite
          .prepare('UPDATE runs SET input_json = ? WHERE id = ?')
          .run('{not json', runId),
    },
    {
      label: 'a valid-JSON-but-non-object inputs blob (array)',
      corrupt: (runId: string) =>
        client.sqlite.prepare('UPDATE runs SET input_json = ? WHERE id = ?').run('[]', runId),
    },
    {
      label: 'a corrupt workflow snapshot (bad JSON)',
      corrupt: (runId: string) =>
        client.sqlite
          .prepare('UPDATE runs SET workflow_definition_snapshot = ? WHERE id = ?')
          .run('{not json', runId),
    },
    {
      label: 'a schema-invalid workflow snapshot',
      corrupt: (runId: string) =>
        client.sqlite
          .prepare('UPDATE runs SET workflow_definition_snapshot = ? WHERE id = ?')
          .run('{"workflow":{}}', runId),
    },
    {
      label: 'a snapshot but no event log (no resumable state)',
      corrupt: (runId: string) =>
        client.sqlite.prepare('DELETE FROM run_events WHERE run_id = ?').run(runId),
    },
  ])('surfaces $label as a clean exit-2 fault', async ({ corrupt }) => {
    const { runId } = await setupPausedRun();
    corrupt(runId);
    const { io } = captureIo();
    await expect(gateCommand({ runId, approve: true }, deps(io))).rejects.toMatchObject({
      code: 'invalid_invocation',
    });
  });

  it('surfaces a DAMAGED event row as its typed error, at exit 1 like every other surface', async () => {
    // Moved out of the exit-2 table above, deliberately. `relavium logs` on this identical log exits 1 (its
    // typed error reaches `toUserFacing`); `gate` exited 2 only because its catch re-wrapped the error as
    // `invalid_invocation`. The invocation was valid in both, and `toUserFacing`'s corrupt branch already
    // composes the better sentence — the run, the `seq`, the `event_type`, and what is still listable.
    const { runId } = await setupPausedRun();
    client.sqlite
      .prepare('UPDATE run_events SET payload_json = ? WHERE run_id = ? AND seq = 0')
      .run('{not json', runId);
    const { io } = captureIo();

    let thrown: unknown;
    try {
      await gateCommand({ runId, approve: true }, deps(io));
    } catch (err) {
      thrown = err;
    }

    expect(isCorruptRunEventError(thrown)).toBe(true);
    const projected = toUserFacing(thrown);
    expect(projected.exitCode).toBe(EXIT_CODES.workflowFailed); // 1, not 2 — matches `logs` on the same log
    expect(projected.message).toContain(runId);
    expect(projected.message).toContain('seq 0');
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
    nodeDispatches: 0,
    admittedInputs: {},
    executionMode: 'local',
    nodeStates: new Map(),
    completedNodeIds: [],
    pendingGates: [],
    pendingMediaJobs: [],
    resolvedGateIds: [],
    lastSequenceNumber: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cumulativeCostMicrocents: 0,
    conservativeCostMicrocents: 0,
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

/**
 * ADR-0074 §3's hold notice. The engine sink that feeds it was DEAD — `WorkflowEngine` never read
 * `onLegacyMediaJobHold` — so this sentence had never rendered in production and nothing pinned it. It is
 * what stops a resumed run that is correctly holding from looking like an unexplained stall.
 */
/**
 * ADR-0075's refusal, at the surface a user actually meets. The typed error was introduced with a mapper in
 * `toUserFacing` and this catch — which pre-dates it — folded it into a generic `invalid_invocation`, so the
 * count, the `seq` values, the upgrade remedy and the exit code were all discarded one frame above the mapper
 * written for them. Nothing pinned the rendered outcome, which is why that was possible.
 */
describe('gateCommand — a run written by a NEWER binary (ADR-0075)', () => {
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

  // NOT COVERED, and named precisely rather than implied: this case calls `gateCommand` directly and calls
  // `toUserFacing` itself, so it pins the layer where the blocker actually was — `gate.ts`'s own catch — and
  // NOT the layers above it. Adding a `try/catch` that re-wraps in `dispatch.ts`'s `executeGate` or
  // `specs.ts`'s `gate.action` reproduces a variant of that same blocker (wrong exit code, generic message,
  // lost `seq`/upgrade text) and leaves this test AND `errors.test.ts`'s sibling green. Closing it needs a
  // `run(argv, io)` drive with a redirected HOME and a seeded on-disk `history.db`; no such harness exists in
  // this file today, and a partial one would read as coverage it is not.
  it('refuses with the upgrade remedy and exit 1, not a generic invalid invocation', async () => {
    const def = parseWorkflow(GATED, { source: 'gate.test' });
    const store = createRunHistoryStore(db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: {
        slug: def.workflow.id,
        name: def.workflow.name ?? def.workflow.id,
        definitionJson: JSON.stringify(def),
      },
    });
    const engine = await buildEngine({
      host: createCliHost(store, { runLeases: createRunLeasePort(store) }),
    });
    const handle = engine.start({ workflow: def, inputs: { n: 7 } });
    let runId = '';
    let lastSeq = 0;
    for await (const event of handle.events) {
      if (event.type === 'run:started') runId = event.runId;
      lastSeq = Math.max(lastSeq, event.sequenceNumber);
      if (event.type === 'run:paused') break;
    }
    // A row only a NEWER binary could have written — `persistEvent` validates on the way in.
    db.insert(runEvents)
      .values({
        id: randomUUID(),
        runId,
        seq: lastSeq + 1,
        eventType: 'test:never_a_real_event',
        payloadJson: JSON.stringify({ type: 'test:never_a_real_event' }),
        ts: Date.now(),
      })
      .run();

    const { io, err } = captureIo();
    let thrown: unknown;
    try {
      await gateCommand(
        { runId, approve: true },
        { io, global: globalOptions(), openDb: () => ({ db, close: () => {} }) },
      );
    } catch (e) {
      thrown = e;
    }

    // The TYPED error survives the catch that used to re-wrap it — that is what makes the mapper reachable.
    expect(isUnreadableRunEventLogError(thrown)).toBe(true);
    const projected = toUserFacing(thrown);
    expect(projected.exitCode).toBe(EXIT_CODES.workflowFailed); // 1, not 2: the invocation was valid
    expect(projected.message).toContain('newer version of Relavium');
    expect(projected.message).toContain('Upgrade');
    expect(projected.message).toContain('still readable');
    expect(err()).not.toContain('could not be read'); // never the generic corrupt-log sentence
  });
});

describe('legacyMediaJobHoldNotice (ADR-0074 §3)', () => {
  it('agrees in number for one held job', () => {
    const line = legacyMediaJobHoldNotice(['gen']);
    expect(line).toContain('until a media job submitted by an older version of Relavium settles');
    expect(line).toContain('(node gen)');
  });

  it('agrees in number for several', () => {
    const line = legacyMediaJobHoldNotice(['gen', 'clip']);
    expect(line).toContain('until 2 media jobs submitted by an older version of Relavium settle ');
    expect(line).toContain('(nodes gen, clip)');
  });

  it('SANITIZES a node id — a workflow YAML can arrive from anywhere', () => {
    // The same treatment `renderer.ts` gives a nodeId. An embedded newline would forge a whole extra stderr
    // row; an ANSI escape would reach the terminal intact.
    const line = legacyMediaJobHoldNotice([`ge\u001b[31mn\nspoofed`]);
    expect(line).not.toContain('\u001b');
    expect(line.trimEnd()).not.toContain('\n'); // one row, and only the trailing newline this line owns
  });

  it('BOUNDS the id list — the count is the signal, the ids are the lead', () => {
    const many = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const line = legacyMediaJobHoldNotice(many);
    expect(line).toContain('12 media jobs');
    expect(line).toContain('n0, n1, n2, n3, n4, n5, n6, n7, …');
    expect(line).not.toContain('n8'); // elided, not printed
  });

  it('ends with exactly one newline, so stderr rows do not run together', () => {
    expect(legacyMediaJobHoldNotice(['gen']).endsWith('\n')).toBe(true);
    expect(legacyMediaJobHoldNotice(['gen']).trimEnd()).not.toContain('\n');
  });
});
