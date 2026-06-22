import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInMemoryHost } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildEngine } from '../engine/build-engine.js';
import { isCliError } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
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

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-run-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function captureIo(): { io: CliIo; out: () => string } {
  const chunks: string[] = [];
  const io: CliIo = {
    writeOut: (text) => {
      chunks.push(text);
    },
    writeErr: () => {
      /* unused */
    },
    env: {},
    stdoutIsTty: false,
  };
  return { io, out: () => chunks.join('') };
}

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

  it('renders NDJSON ending in run:completed under --json', async () => {
    const path = writeWorkflow('happy.relavium.yaml', HAPPY);
    const { io, out } = captureIo();
    const global = globalOptions({ json: true });
    const code = await runCommand({ workflow: path, input: ['n=3'] }, deps(io, global));
    expect(code).toBe(EXIT_CODES.success);
    const lines = out().trimEnd().split('\n');
    const types = lines.map((line) => {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === 'object' && parsed !== null && 'type' in parsed
        ? parsed.type
        : undefined;
    });
    expect(types[0]).toBe('run:started');
    expect(types.at(-1)).toBe('run:completed');
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
});
