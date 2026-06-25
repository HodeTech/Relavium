import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WorkflowEngine,
  createInMemoryHost,
  type NodeExecutor,
  type NodeOutcome,
} from '@relavium/core';
import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  createRunHistoryStore,
  runMigrations,
  type Db,
} from '@relavium/db';
import { RunEventSchema } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEngine, type BuildEngineOptions } from '../engine/build-engine.js';
import { createProviderResolver } from '../engine/providers.js';
import type { GatePrompter } from '../gate/prompter.js';
import { isCliError } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import type { RunRenderer } from '../render/renderer.js';
import {
  CHAT_TEXT_CAPABILITY_FLAGS,
  GENERATIVE_IMAGE_CAPABILITY_FLAGS,
  captureIo,
} from '../test-support.js';
import { runCommand, type RunCommandDeps } from './run.js';

// A minimal real workflow: input → transform → output. Runs end-to-end through the standard node
// executor + the expression sandbox with NO provider (no agent node), so the run reaches run:completed.
const HAPPY = `schema_version: '1.0'
workflow:
  id: cli-run-happy
  inputs:
    - name: n
      type: number
  nodes:
    - { id: start, type: input }
    - { id: double, type: transform, transform: '({ d: inputs.n * 2 })' }
    - { id: out, type: output }
  edges:
    - { from: start, to: double }
    - { from: double, to: out }
`;

// The transform throws at runtime (member access on null) → sandbox_error → node:failed → run:failed.
const FAILING = `schema_version: '1.0'
workflow:
  id: cli-run-fail
  nodes:
    - { id: start, type: input }
    - { id: boom, type: transform, transform: 'null.boom' }
    - { id: out, type: output }
  edges:
    - { from: start, to: boom }
    - { from: boom, to: out }
`;

// A human_gate node pauses under the fail-closed `humanGate: {}` wiring → run:paused → exit 3.
const GATED = `schema_version: '1.0'
workflow:
  id: cli-run-gated
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: out }
`;

// A node that stalls until the run's AbortSignal fires — lets the SIGINT test cancel mid-run.
const STALL = `schema_version: '1.0'
workflow:
  id: cli-run-stall
  nodes:
    - { id: start, type: input }
    - { id: slow, type: transform, transform: 's' }
    - { id: done, type: output }
  edges:
    - { from: start, to: slow }
    - { from: slow, to: done }
`;

// An agent node referencing an inline agent whose provider (anthropic) needs a key → drives the
// missing-key pre-flight. Parses fine; the pre-flight throws before the engine is ever built.
const AGENT_WF = `schema_version: '1.0'
workflow:
  id: cli-run-agent
  agents:
    - { id: scanner, model: claude-opus-4-8, provider: anthropic, system_prompt: inspect }
  nodes:
    - { id: start, type: input }
    - { id: a, type: agent, agent_ref: scanner, prompt_template: 'go' }
    - { id: out, type: output }
  edges:
    - { from: start, to: a }
    - { from: a, to: out }
`;

// Same shape with a non-anthropic primary — exercises the env-var derivation for a second provider id.
const AGENT_WF_GEMINI = AGENT_WF.replace('id: cli-run-agent', 'id: cli-run-agent-gemini').replace(
  'model: claude-opus-4-8, provider: anthropic',
  'model: gemini-2.5-flash, provider: gemini',
);

// An agent node whose authored output_modalities ([text, image]) exceed what the catalog model `chat-text`
// supports (text only) — parses fine, but the D15 catalog load-check (2.S Step 7) must reject it at LOAD via the
// chat inline-membership branch. The inline `model: chat-text` is the node-level override validate-catalog reads
// (node.model), distinct from the agent's base model.
const INCAPABLE_WF = `schema_version: '1.0'
workflow:
  id: cli-run-incapable
  agents:
    - { id: writer, model: gpt-4o, provider: openai, system_prompt: write }
  nodes:
    - { id: start, type: input }
    - { id: a, type: agent, agent_ref: writer, model: chat-text, prompt_template: 'go', output_modalities: ['text', 'image'] }
    - { id: out, type: output }
  edges:
    - { from: start, to: a }
    - { from: a, to: out }
`;

// A node whose model `gen-image` is a media_surface 'generative' catalog row, with output_modalities that the
// generative branch rejects (it requires EXACTLY one media modality, no text) — exercises validate-catalog's
// generative branch through the real projection (which reads media.surface from the capabilities blob).
const GENERATIVE_REJECT_WF = `schema_version: '1.0'
workflow:
  id: cli-run-gen-reject
  agents:
    - { id: painter, model: gpt-4o, provider: openai, system_prompt: paint }
  nodes:
    - { id: start, type: input }
    - { id: a, type: agent, agent_ref: painter, model: gen-image, prompt_template: 'go', output_modalities: ['text', 'image'] }
    - { id: out, type: output }
  edges:
    - { from: start, to: a }
    - { from: a, to: out }
`;

// Same shape but the node model is ABSENT from the catalog — the load-check must DEFER (not reject), so the run
// proceeds to build the engine. (output_modalities present so the check would evaluate the node if it resolved.)
const ABSENT_MODEL_WF = GENERATIVE_REJECT_WF.replace(
  'id: cli-run-gen-reject',
  'id: cli-run-absent',
).replace('model: gen-image', 'model: not-in-catalog');

// `os.homedir()` reads `HOME` on POSIX but `USERPROFILE` on Windows — override BOTH so the hermetic home holds
// cross-platform (the global CAS root resolves under it). Mirrors the generative e2e harness.
const HOME_ENV_VARS = ['HOME', 'USERPROFILE'] as const;

let root: string;
let home: string;
const savedHome = new Map<string, string | undefined>();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-run-'));
  // Point the home at a tmpdir so `os.homedir()` (→ `~/.relavium/media`, the CAS root) never resolves to the real
  // developer home. The in-memory host path bypasses `put()` today, but keep the discipline so a future change
  // exercising the CAS through the captured opts can't write to the real `~/.relavium`.
  home = mkdtempSync(join(tmpdir(), 'relavium-run-home-'));
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

function globalOptions(over: Partial<GlobalOptions> = {}): GlobalOptions {
  return {
    json: false,
    color: false,
    cwd: root,
    configPath: undefined,
    verbosity: 'normal',
    ...over,
  };
}

/** A deps bundle whose engine uses the deterministic in-memory host (no real timers / wall clock). */
function deps(
  io: CliIo,
  global: GlobalOptions,
  over: Partial<RunCommandDeps> = {},
): RunCommandDeps {
  return { io, global, buildEngine: () => buildEngine({ host: createInMemoryHost() }), ...over };
}

function writeWorkflow(name: string, yaml: string): string {
  const path = join(root, name);
  writeFileSync(path, yaml);
  return path;
}

/** An `openRunStore` backed by the given in-memory db — the durable-history stub the 2.S wiring tests share. */
function historyOpenRunStore(db: Db): NonNullable<RunCommandDeps['openRunStore']> {
  return (workflow) => ({
    store: createRunHistoryStore(db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: {
        slug: workflow.workflow.id,
        name: workflow.workflow.id,
        definitionJson: JSON.stringify(workflow),
      },
    }),
    db,
    close: () => {},
  });
}

/**
 * A `buildEngine` whose `slow` node hangs until the run's AbortSignal fires (the engine's own
 * cancellation pattern). `reachedSlow` resolves the moment `slow` starts executing — by then run.ts
 * has synchronously registered its SIGINT handler — so a test can fire that handler race-free.
 */
function makeStallingCancelEngine(): {
  buildEngine: () => Promise<WorkflowEngine>;
  reachedSlow: Promise<void>;
} {
  let signalReached: (() => void) | undefined;
  const reachedSlow = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  const stalling: NodeExecutor = {
    execute: (ctx) => {
      if (ctx.vertex.id === 'slow') {
        signalReached?.();
        return new Promise<NodeOutcome>((resolve) => {
          const onAbort = (): void => {
            ctx.signal.removeEventListener('abort', onAbort); // symmetry — no listener left on the signal
            resolve({ kind: 'completed', output: null });
          };
          if (ctx.signal.aborted) {
            onAbort();
          } else {
            ctx.signal.addEventListener('abort', onAbort);
          }
        });
      }
      return Promise.resolve({ kind: 'completed', output: ctx.vertex.id });
    },
  };
  return {
    buildEngine: () =>
      Promise.resolve(new WorkflowEngine({ host: createInMemoryHost(), executor: stalling })),
    reachedSlow,
  };
}

describe('runCommand', () => {
  it('runs a workflow to completion and exits 0, rendering the lifecycle (plain)', async () => {
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    const { io, out } = captureIo();
    const global = globalOptions();
    const code = await runCommand({ workflow: path, input: ['n=3'] }, deps(io, global));
    expect(code).toBe(EXIT_CODES.success);
    expect(out()).toContain('started');
    expect(out()).toContain('run completed');
  });

  it('wires the media host + catalog resolveMediaSurface + the media ports when durable history is open (2.S)', async () => {
    const client = createClient(':memory:');
    runMigrations(client.db);
    const dbDeps = { uuid: () => randomUUID(), now: () => Date.now() };
    const providerId = createProviderStore(client.db, dbDeps).upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    }).id;
    createModelCatalogStore(client.db, dbDeps).upsert({
      providerId,
      modelId: 'gpt-image-1',
      displayName: 'GPT Image 1',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative',
    });
    let captured: BuildEngineOptions | undefined;
    const { io } = captureIo();
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    try {
      const code = await runCommand(
        { workflow: path, input: ['n=3'] },
        deps(io, globalOptions(), {
          // Durable history open ⇒ run.ts wires the media host + the catalog reader over this same db.
          openRunStore: historyOpenRunStore(client.db),
          // Capture what run.ts assembled, then run a real in-memory engine so the HAPPY workflow completes.
          buildEngine: (opts) => {
            captured = opts;
            return buildEngine({ host: createInMemoryHost() });
          },
        }),
      );
      expect(code).toBe(EXIT_CODES.success);
      // The media host carries all three ports (CAS + retention + save_to), backed by the run-path roots + db.
      expect(captured?.host?.mediaStore).toBeDefined();
      expect(captured?.host?.mediaReferences).toBeDefined();
      expect(captured?.host?.mediaWrite).toBeDefined();
      // resolveMediaSurface is the catalog projection over the SAME db: the seeded generative model routes;
      // an unknown one is undefined (the host then defaults to the safe inline 'chat').
      expect(captured?.resolveMediaSurface?.('gpt-image-1')).toBe('generative');
      expect(captured?.resolveMediaSurface?.('unknown-model')).toBeUndefined();
      // With no project config, the call-site OMITS mediaCostEstimate (the exactOptionalPropertyTypes spread
      // arm — never `{ mediaCostEstimate: undefined }`).
      expect('mediaCostEstimate' in (captured ?? {})).toBe(false);
      // The save_to scope root is the run's cwd: run.ts forwards `deps.global.cwd` into the helper, so a write
      // through the wired port lands under <cwd>/.relavium/runs (proves the cwd plumbing + the root value, not
      // just that the port is defined).
      const mediaWrite = captured?.host?.mediaWrite;
      if (mediaWrite === undefined) {
        throw new Error('expected run.ts to wire mediaWrite when durable history is open');
      }
      await mediaWrite('out.bin', new Uint8Array([7]));
      expect(existsSync(join(root, '.relavium', 'runs', 'out.bin'))).toBe(true);
    } finally {
      client.sqlite.close();
    }
  });

  it('threads [defaults].media_cost_estimate from config into the engine options (the populated arm)', async () => {
    // A project config under the run cwd sets the per-modality estimate; run.ts must forward it to the builder.
    mkdirSync(join(root, '.relavium'), { recursive: true });
    writeFileSync(
      join(root, '.relavium', 'project.toml'),
      '[defaults.media_cost_estimate]\nimage = 5\naudio = 9\n',
    );
    const client = createClient(':memory:');
    runMigrations(client.db);
    let captured: BuildEngineOptions | undefined;
    const { io } = captureIo();
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    try {
      const code = await runCommand(
        { workflow: path, input: ['n=3'] },
        deps(io, globalOptions(), {
          openRunStore: historyOpenRunStore(client.db),
          buildEngine: (opts) => {
            captured = opts;
            return buildEngine({ host: createInMemoryHost() });
          },
        }),
      );
      expect(code).toBe(EXIT_CODES.success);
      expect(captured?.mediaCostEstimate).toEqual({ image: 5, audio: 9 });
    } finally {
      client.sqlite.close();
    }
  });

  it('runs the host media GC at run-end with the durable db + CAS root + run id (2.S/D-GC)', async () => {
    const client = createClient(':memory:');
    runMigrations(client.db);
    const { io } = captureIo();
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    let swept: { db: unknown; casRoot: string; currentRunId: string } | undefined;
    try {
      const code = await runCommand(
        { workflow: path, input: ['n=3'] },
        deps(io, globalOptions(), {
          openRunStore: historyOpenRunStore(client.db),
          sweepMedia: (args) => {
            swept = args;
            return Promise.resolve(undefined);
          },
        }),
      );
      expect(code).toBe(EXIT_CODES.success);
      // The GC ran once at the terminal, over the SAME durable connection + the global CAS root, for this run.
      expect(swept?.db).toBe(client.db);
      expect(swept?.casRoot.endsWith(join('.relavium', 'media'))).toBe(true);
      expect(typeof swept?.currentRunId).toBe('string');
      expect(swept?.currentRunId).not.toBe('');
    } finally {
      client.sqlite.close();
    }
  });

  it('skips the host media GC when durable history is closed (no references db to GC over)', async () => {
    const { io } = captureIo();
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    let swept = false;
    const code = await runCommand(
      { workflow: path, input: ['n=3'] },
      deps(io, globalOptions(), {
        sweepMedia: () => {
          swept = true;
          return Promise.resolve(undefined);
        },
      }),
    );
    expect(code).toBe(EXIT_CODES.success);
    expect(swept).toBe(false); // no openRunStore ⇒ no media wiring ⇒ the GC never runs
  });

  it('skips the host media GC on a non-terminal (paused) outcome — a resumable run keeps its media (2.S/D-GC)', async () => {
    const client = createClient(':memory:');
    runMigrations(client.db);
    const { io } = captureIo();
    const path = writeWorkflow('gated.relavium.yaml', GATED);
    let swept = false;
    try {
      const code = await runCommand(
        { workflow: path, input: [] },
        deps(io, globalOptions(), {
          openRunStore: historyOpenRunStore(client.db),
          sweepMedia: () => {
            swept = true;
            return Promise.resolve(undefined);
          },
        }),
      );
      expect(code).toBe(EXIT_CODES.gatePaused); // exit 3 — the run paused at the human gate
    } finally {
      client.sqlite.close();
    }
    expect(swept).toBe(false); // the GC must NOT run while the run is merely paused (its media survives the resume)
  });

  it('swallows a throwing media GC at run-end — a GC fault never fails the run (2.S/D-GC, best-effort)', async () => {
    const client = createClient(':memory:');
    runMigrations(client.db);
    const { io } = captureIo();
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    try {
      const code = await runCommand(
        { workflow: path, input: ['n=3'] },
        deps(io, globalOptions(), {
          openRunStore: historyOpenRunStore(client.db),
          sweepMedia: () => Promise.reject(new Error('gc boom')),
        }),
      );
      expect(code).toBe(EXIT_CODES.success); // the run completed; the GC rejection was swallowed at the call site
    } finally {
      client.sqlite.close();
    }
  });

  it('rejects an agent node whose output_modalities exceed the catalog model at LOAD — exit 2, engine never built (D15)', async () => {
    const client = createClient(':memory:');
    runMigrations(client.db);
    const dbDeps = { uuid: () => randomUUID(), now: () => Date.now() };
    const providerId = createProviderStore(client.db, dbDeps).upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    }).id;
    createModelCatalogStore(client.db, dbDeps).upsert({
      providerId,
      modelId: 'chat-text',
      displayName: 'Chat Text',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'chat',
      capabilities: CHAT_TEXT_CAPABILITY_FLAGS,
    });
    const { io } = captureIo();
    const path = writeWorkflow('incapable.relavium.yaml', INCAPABLE_WF);
    let caught: unknown;
    try {
      await runCommand(
        { workflow: path, input: [] },
        deps(io, globalOptions(), {
          // Key present ⇒ the pre-flight passes; the D15 load-check is what must reject the run.
          providers: createProviderResolver({ RELAVIUM_OPENAI_API_KEY: 'sk-test' }),
          openRunStore: historyOpenRunStore(client.db),
          // The load-check runs BEFORE the engine builds — a regression that skipped it would trip this.
          buildEngine: () => {
            throw new Error('the engine must not build — the D15 load-check rejects first');
          },
        }),
      );
    } catch (err) {
      caught = err;
    } finally {
      client.sqlite.close();
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain('chat-text'); // the message names the offending model, secret-free
    }
  });

  it('rejects a generative-surface model with a malformed output_modalities at LOAD — exit 2 (D15 generative branch)', async () => {
    const client = createClient(':memory:');
    runMigrations(client.db);
    const dbDeps = { uuid: () => randomUUID(), now: () => Date.now() };
    const providerId = createProviderStore(client.db, dbDeps).upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    }).id;
    // A generative catalog row: the projection reads media.surface='generative' from THIS capabilities blob, so
    // the load-check takes the generative branch (exactly one media modality, no text) and rejects [text, image].
    createModelCatalogStore(client.db, dbDeps).upsert({
      providerId,
      modelId: 'gen-image',
      displayName: 'Gen Image',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative',
      capabilities: GENERATIVE_IMAGE_CAPABILITY_FLAGS,
    });
    const { io } = captureIo();
    const path = writeWorkflow('gen-reject.relavium.yaml', GENERATIVE_REJECT_WF);
    let caught: unknown;
    try {
      await runCommand(
        { workflow: path, input: [] },
        deps(io, globalOptions(), {
          providers: createProviderResolver({ RELAVIUM_OPENAI_API_KEY: 'sk-test' }),
          openRunStore: historyOpenRunStore(client.db),
          buildEngine: () => {
            throw new Error('the engine must not build — the generative load-check rejects first');
          },
        }),
      );
    } catch (err) {
      caught = err;
    } finally {
      client.sqlite.close();
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain('generative'); // distinguishes the generative branch from chat-membership
      // ...and pins the field-named, modality-listing contract (validate-catalog's WorkflowValidationError), not
      // just the branch keyword — a message that dropped the node field/modality detail would fail here.
      expect(caught.message).toContain('output_modalities');
      expect(caught.message).toContain('image');
    }
  });

  it('DEFERS (does not reject) a node whose model is absent from the catalog — the engine still builds (D15)', async () => {
    const client = createClient(':memory:');
    runMigrations(client.db);
    const { io } = captureIo();
    const path = writeWorkflow('absent.relavium.yaml', ABSENT_MODEL_WF);
    let built = false;
    let caught: unknown;
    try {
      await runCommand(
        { workflow: path, input: [] },
        deps(io, globalOptions(), {
          providers: createProviderResolver({ RELAVIUM_OPENAI_API_KEY: 'sk-test' }),
          openRunStore: historyOpenRunStore(client.db), // catalog open, but `not-in-catalog` is unseeded
          // Halt right after the load-check so we observe the defer without running the agent over the network.
          buildEngine: () => {
            built = true;
            throw new Error('halt after the load-check deferred');
          },
        }),
      );
    } catch (err) {
      caught = err;
    } finally {
      client.sqlite.close();
    }
    expect(built).toBe(true); // the load-check reached buildEngine — it DEFERRED the unresolvable model
    expect(isCliError(caught)).toBe(false); // ...and did NOT reject with an invocation fault
  });

  it('skips the load-check entirely when durable history is closed (no catalog to check against)', async () => {
    // No `openRunStore` ⇒ `opened` is undefined ⇒ the whole media-wiring + load-check block is skipped. Even the
    // would-be-incapable INCAPABLE_WF then builds the engine (there is no catalog), pinning the guard boundary.
    const { io } = captureIo();
    const path = writeWorkflow('incapable.relavium.yaml', INCAPABLE_WF);
    let built = false;
    let caught: unknown;
    try {
      await runCommand(
        { workflow: path, input: [] },
        deps(io, globalOptions(), {
          providers: createProviderResolver({ RELAVIUM_OPENAI_API_KEY: 'sk-test' }),
          buildEngine: () => {
            built = true;
            throw new Error('halt after the skipped load-check');
          },
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(built).toBe(true); // no durable history ⇒ no catalog ⇒ the load-check never runs, never over-rejects
    expect(isCliError(caught)).toBe(false);
  });

  it('awaits the renderer finalize() once after the run loop (the TUI teardown wire)', async () => {
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    const { io } = captureIo();
    let finalizeCalls = 0;
    const renderer: RunRenderer = {
      onEvent: () => {},
      finalize: () => {
        finalizeCalls += 1;
      },
    };
    const code = await runCommand(
      { workflow: path, input: ['n=3'] },
      deps(io, globalOptions(), { selectRenderer: () => renderer }),
    );
    expect(code).toBe(EXIT_CODES.success);
    expect(finalizeCalls).toBe(1);
  });

  it('does not let a renderer finalize() error mask the run outcome (logs to stderr instead)', async () => {
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    const { io, err } = captureIo();
    const renderer: RunRenderer = {
      onEvent: () => {},
      finalize: () => Promise.reject(new Error('unmount blew up')),
    };
    const code = await runCommand(
      { workflow: path, input: ['n=3'] },
      deps(io, globalOptions(), { selectRenderer: () => renderer }),
    );
    expect(code).toBe(EXIT_CODES.success); // the run outcome is preserved
    expect(err()).toContain('renderer teardown failed');
    expect(err()).toContain('unmount blew up');
  });

  it('renders --json stdout as a schema-valid RunEvent NDJSON stream in sequenceNumber order, ending in run:completed', async () => {
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    const { io, out } = captureIo();
    const global = globalOptions({ json: true });
    const code = await runCommand({ workflow: path, input: ['n=3'] }, deps(io, global));
    expect(code).toBe(EXIT_CODES.success);

    // Every stdout line is EXACTLY one RunEvent (the 2.F/ADR-0049 acceptance bar). Round-trip
    // equality (parse === raw) — not just parse-success — proves no non-JSON bytes AND no extra
    // fields, since RunEventSchema is non-strict and would otherwise silently strip a stray key.
    const events = out()
      .trimEnd()
      .split('\n')
      .map((line) => {
        const raw: unknown = JSON.parse(line);
        const event = RunEventSchema.parse(raw);
        expect(event).toEqual(raw); // round-trip equality: each line is EXACTLY a RunEvent (no stray field)
        return event;
      });
    expect(events[0]?.type).toBe('run:started');
    expect(events.at(-1)?.type).toBe('run:completed'); // the terminal run:completed is the result line
    // sequenceNumber is monotonically non-decreasing across the stream.
    const seqs = events.map((e) => e.sequenceNumber);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('keeps stdout a pure NDJSON stream ending in run:failed (the failure stays a RunEvent, not a stderr fault)', async () => {
    const path = writeWorkflow('fail.relavium.yaml', FAILING);
    const { io, out, err } = captureIo();
    const code = await runCommand(
      { workflow: path, input: [] },
      deps(io, globalOptions({ json: true })),
    );
    expect(code).toBe(EXIT_CODES.workflowFailed);
    const events = out()
      .trimEnd()
      .split('\n')
      .map((line) => {
        const raw: unknown = JSON.parse(line);
        const event = RunEventSchema.parse(raw);
        expect(event).toEqual(raw); // round-trip equality: each line is EXACTLY a RunEvent (no stray field)
        return event;
      });
    expect(events.at(-1)?.type).toBe('run:failed'); // a run failure is a RunEvent on stdout...
    expect(err()).toBe(''); // ...NOT a {type:error} fault envelope on stderr (that's for CLI faults only)
  });

  it('maps a failed run to exit 1', async () => {
    const path = writeWorkflow('fail.relavium.yaml', FAILING);
    const { io, out } = captureIo();
    const global = globalOptions();
    const code = await runCommand({ workflow: path, input: [] }, deps(io, global));
    expect(code).toBe(EXIT_CODES.workflowFailed);
    expect(out()).toContain('run failed');
  });

  it('rejects an unknown input before building the engine (exit 2, engine never built)', async () => {
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    const { io } = captureIo();
    const global = globalOptions();
    let engineBuilt = false;
    let caught: unknown;
    try {
      await runCommand(
        { workflow: path, input: ['bogus=1'] },
        deps(io, global, {
          buildEngine: () => {
            engineBuilt = true;
            return buildEngine({ host: createInMemoryHost() });
          },
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) expect(caught.code).toBe('invalid_invocation');
    expect(engineBuilt).toBe(false);
  });

  it('throws a clean exit-2 error when the workflow is not found', async () => {
    const { io } = captureIo();
    const global = globalOptions();
    let caught: unknown;
    try {
      await runCommand(
        { workflow: join(root, 'missing.relavium.yaml'), input: [] },
        deps(io, global),
      );
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) expect(caught.code).toBe('invalid_invocation');
  });

  it('throws a clean exit-2 error on malformed workflow YAML', async () => {
    const path = writeWorkflow('bad.relavium.yaml', 'schema_version: "1.0"\nworkflow: : :\n');
    const { io } = captureIo();
    const global = globalOptions();
    let caught: unknown;
    try {
      await runCommand({ workflow: path, input: [] }, deps(io, global));
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) expect(caught.code).toBe('invalid_invocation');
  });

  it('pauses at a human_gate node and exits 3 (gate-paused)', async () => {
    const path = writeWorkflow('gated.relavium.yaml', GATED);
    const { io, out } = captureIo();
    const code = await runCommand({ workflow: path, input: [] }, deps(io, globalOptions()));
    expect(code).toBe(EXIT_CODES.gatePaused);
    // The rendered gateId is the engine-generated id (not the node id); assert the gate type instead.
    expect(out()).toContain('paused at gate');
    expect(out()).toContain('(approval)');
  });

  it('threads an interactive gate prompter through to driveRun: an approved inline gate completes (exit 0)', async () => {
    // When a prompter is present (the interactive TTY path), `run` resolves the gate INLINE rather than
    // exiting 3 — proving run.ts wires selectGatePrompter into the shared driveRun core (2.G).
    const path = writeWorkflow('gated.relavium.yaml', GATED);
    const { io } = captureIo();
    const prompter: GatePrompter = {
      prompt: () => Promise.resolve({ decision: 'approved', decidedBy: 'cli' }),
    };
    const code = await runCommand(
      { workflow: path, input: [] },
      deps(io, globalOptions(), { selectGatePrompter: () => prompter }),
    );
    expect(code).toBe(EXIT_CODES.success); // the inline prompt resolved the gate; the run continued to completion
  });

  it('forwards SIGINT as a cooperative cancel → run:cancelled → exit 1, leaking no SIGINT listener', async () => {
    const path = writeWorkflow('stall.relavium.yaml', STALL);
    const { io, out } = captureIo();
    const before = process.listeners('SIGINT');
    const { buildEngine: buildStalling, reachedSlow } = makeStallingCancelEngine();

    const pending = runCommand(
      { workflow: path, input: [] },
      deps(io, globalOptions(), { buildEngine: buildStalling }),
    );

    await reachedSlow; // the run is parked at `slow`; run.ts's SIGINT handler is registered
    // Identify run.ts's handler by set-delta (not `.at(-1)`), so the test is robust to any other
    // SIGINT listener the runner/host might register before or after it.
    const added = process.listeners('SIGINT').filter((listener) => !before.includes(listener));
    expect(added).toHaveLength(1);
    const onSigint = added[0];
    if (typeof onSigint !== 'function') {
      throw new TypeError('expected run.ts to register a SIGINT handler');
    }
    onSigint('SIGINT'); // === handle.cancel(); the loop is parked at `slow`, so this lands pre-terminal

    const code = await pending;
    expect(code).toBe(EXIT_CODES.workflowFailed); // run:cancelled → default branch → 1
    expect(out()).toContain('cancelled');
    // Direct invocation does not auto-remove a `once` listener (only emit() does), so the finally's
    // removeListener is what returns the count to baseline.
    expect(process.listeners('SIGINT')).toHaveLength(before.length);
  }, 15_000); // generous ceiling: the coordination is deterministic, but a cold/starved CI worker is slow

  it('forces a clean exit-1 on a SECOND SIGINT while the cancel drains (never the bare-signal 130)', async () => {
    // Stub process.exit to THROW (like a real exit halting the handler), so onSigint cannot fall through to a
    // second handle.cancel() — mirroring production where process.exit never returns.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number): never => {
      throw new Error(`process.exit:${String(code)}`);
    }) as typeof process.exit);
    try {
      const path = writeWorkflow('stall.relavium.yaml', STALL);
      const { io } = captureIo();
      const before = process.listeners('SIGINT');
      const { buildEngine: buildStalling, reachedSlow } = makeStallingCancelEngine();
      const pending = runCommand(
        { workflow: path, input: [] },
        deps(io, globalOptions(), { buildEngine: buildStalling }),
      );
      await reachedSlow;
      const onSigint = process.listeners('SIGINT').filter((l) => !before.includes(l))[0];
      if (typeof onSigint !== 'function') {
        throw new TypeError('expected run.ts to register a SIGINT handler');
      }
      onSigint('SIGINT'); // first press → cooperative cancel (cancelRequested = true)
      expect(() => onSigint('SIGINT')).toThrow('process.exit:1'); // second press → forced exit
      expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.workflowFailed);
      const code = await pending; // the run still drains to run:cancelled from the first press
      expect(code).toBe(EXIT_CODES.workflowFailed);
    } finally {
      exitSpy.mockRestore();
    }
  }, 15_000);

  it('cancels the still-live engine and propagates when renderer construction throws (abnormal unwind)', async () => {
    const path = writeWorkflow('stall.relavium.yaml', STALL);
    const { io } = captureIo();
    const before = process.listeners('SIGINT');
    const { buildEngine: buildStalling } = makeStallingCancelEngine();
    // selectRenderer throws AFTER engine.start(): the finally must cancel the still-live engine (outcome
    // undefined → handle.cancel()) and remove the SIGINT listener, then the error propagates.
    await expect(
      runCommand(
        { workflow: path, input: [] },
        deps(io, globalOptions(), {
          buildEngine: buildStalling,
          selectRenderer: () => {
            throw new Error('render boom');
          },
        }),
      ),
    ).rejects.toThrow('render boom');
    expect(process.listeners('SIGINT')).toHaveLength(before.length); // listener removed in the finally
  }, 15_000);

  it('keeps stdout a pure NDJSON stream ending in run:cancelled under --json', async () => {
    const path = writeWorkflow('stall.relavium.yaml', STALL);
    const { io, out, err } = captureIo();
    const before = process.listeners('SIGINT');
    const { buildEngine: buildStalling, reachedSlow } = makeStallingCancelEngine();

    const pending = runCommand(
      { workflow: path, input: [] },
      deps(io, globalOptions({ json: true }), { buildEngine: buildStalling }),
    );

    await reachedSlow;
    const onSigint = process
      .listeners('SIGINT')
      .filter((listener) => !before.includes(listener))[0];
    if (typeof onSigint !== 'function') {
      throw new TypeError('expected run.ts to register a SIGINT handler');
    }
    onSigint('SIGINT');

    const code = await pending;
    expect(code).toBe(EXIT_CODES.workflowFailed); // run:cancelled → exit 1
    const events = out()
      .trimEnd()
      .split('\n')
      .map((line) => {
        const raw: unknown = JSON.parse(line);
        const event = RunEventSchema.parse(raw);
        expect(event).toEqual(raw); // round-trip equality: each line is EXACTLY a RunEvent (no stray field)
        return event;
      });
    expect(events.at(-1)?.type).toBe('run:cancelled'); // the cancelled terminal stays a RunEvent on stdout
    expect(err()).toBe(''); // ...not a {type:error} fault envelope on stderr
  }, 15_000);

  it('does not leak SIGINT listeners across many sequential runs (2.K harness hygiene)', async () => {
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    const baseline = process.listeners('SIGINT').length;
    for (let i = 0; i < 25; i += 1) {
      const { io } = captureIo();
      await runCommand({ workflow: path, input: ['n=1'] }, deps(io, globalOptions()));
    }
    expect(process.listeners('SIGINT')).toHaveLength(baseline);
  });

  it('rejects a missing provider key for an inline agent before building the engine (exit 2)', async () => {
    const path = writeWorkflow('agent.relavium.yaml', AGENT_WF);
    const { io } = captureIo(); // io.env = {} → no RELAVIUM_ANTHROPIC_API_KEY
    let engineBuilt = false;
    let caught: unknown;
    try {
      await runCommand(
        { workflow: path, input: [] },
        {
          io,
          global: globalOptions(),
          // The resolver reads io.env ({}), so anthropic's key is absent; the engine must never build.
          providers: createProviderResolver(io.env),
          buildEngine: () => {
            engineBuilt = true;
            return buildEngine({ host: createInMemoryHost() });
          },
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain('RELAVIUM_ANTHROPIC_API_KEY');
    }
    expect(engineBuilt).toBe(false);
  });

  it('names the matching env var for a non-anthropic primary provider (gemini)', async () => {
    const path = writeWorkflow('agent-gemini.relavium.yaml', AGENT_WF_GEMINI);
    const { io } = captureIo(); // io.env = {} → no RELAVIUM_GEMINI_API_KEY
    let caught: unknown;
    try {
      await runCommand(
        { workflow: path, input: [] },
        { io, global: globalOptions(), providers: createProviderResolver(io.env) },
      );
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) expect(caught.message).toContain('RELAVIUM_GEMINI_API_KEY');
  });

  it('passes the pre-flight and builds the engine when the inline agent key IS present', async () => {
    const path = writeWorkflow('agent.relavium.yaml', AGENT_WF);
    const { io } = captureIo();
    let engineBuilt = false;
    // A stub executor completes every node (incl. the agent) so the run finishes without a real call;
    // the point is that a PRESENT key lets the pre-flight pass and the engine gets built (no false-fail).
    const completeAll: NodeExecutor = {
      execute: (ctx) => Promise.resolve({ kind: 'completed', output: ctx.vertex.id }),
    };
    const code = await runCommand(
      { workflow: path, input: [] },
      {
        io,
        global: globalOptions(),
        // A non-empty value is all the pre-flight checks for (presence); kept deliberately un-key-like.
        providers: createProviderResolver({ RELAVIUM_ANTHROPIC_API_KEY: 'present' }),
        buildEngine: () => {
          engineBuilt = true;
          return Promise.resolve(
            new WorkflowEngine({ host: createInMemoryHost(), executor: completeAll }),
          );
        },
      },
    );
    expect(engineBuilt).toBe(true); // the present key did NOT false-fail the pre-flight
    expect(code).toBe(EXIT_CODES.success);
  });

  it('renders the gate terminal as run:paused on the last NDJSON line under --json', async () => {
    const path = writeWorkflow('gated.relavium.yaml', GATED);
    const { io, out } = captureIo();
    const code = await runCommand(
      { workflow: path, input: [] },
      deps(io, globalOptions({ json: true })),
    );
    expect(code).toBe(EXIT_CODES.gatePaused);
    const lines = out().trimEnd().split('\n');
    const last: unknown = JSON.parse(lines.at(-1) ?? '');
    const lastType =
      typeof last === 'object' && last !== null && 'type' in last ? last.type : undefined;
    expect(lastType).toBe('run:paused');
  });
});
