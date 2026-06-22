import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WorkflowEngine,
  createInMemoryHost,
  type NodeExecutor,
  type NodeOutcome,
} from '@relavium/core';
import { RunEventSchema } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildEngine } from '../engine/build-engine.js';
import { createProviderResolver } from '../engine/providers.js';
import { isCliError } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
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

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-run-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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
