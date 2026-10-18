import type { RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import type { GlobalOptions } from '../process/options.js';
import { detectOutputMode } from '../process/output-mode.js';
import { captureIo, OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { processIo } from '../process/io.js';
import { InvocationRegistry } from '../process/invocation-registry.js';
import { WorkflowTerminal } from '../commands/workflow-terminal.js';
import { selectRenderer } from './select.js';

const TS = '2026-06-23T12:00:00.000Z';

function globalOptions(over: Partial<GlobalOptions>): GlobalOptions {
  return {
    json: false,
    color: true,
    cwd: '/',
    configPath: undefined,
    verbosity: 'normal',
    ...over,
  };
}

const COMPLETED: RunEvent = {
  type: 'run:completed',
  runId: 'r',
  timestamp: TS,
  sequenceNumber: 1,
  outputs: {},
  totalTokensUsed: { input: 1, output: 2 },
  totalCostMicrocents: 0,
  durationMs: 5,
};

describe('selectRenderer', () => {
  it('routes --json to the NDJSON renderer (one verbatim event per line, no finalize)', () => {
    const io = captureIo(); // stdoutIsTty: false
    const renderer = selectRenderer(io.io, globalOptions({ json: true }));
    renderer.onEvent(COMPLETED);
    expect(io.out()).toBe(`${JSON.stringify(COMPLETED)}\n`);
    expect(renderer.finalize).toBeUndefined(); // the NDJSON renderer needs no teardown
  });

  it('routes a non-TTY, non-json run to the plain line renderer', () => {
    const io = captureIo();
    const renderer = selectRenderer(io.io, globalOptions({ json: false }));
    renderer.onEvent(COMPLETED);
    expect(io.out()).toContain('done: run completed');
    expect(renderer.finalize).toBeUndefined();
  });

  it('detectOutputMode picks the TUI only for an interactive, non-CI, non-json TTY', () => {
    expect(detectOutputMode({ stdoutIsTty: true, json: false, ci: false })).toBe('tui');
    expect(detectOutputMode({ stdoutIsTty: true, json: true, ci: false })).toBe('plain'); // --json wins
    expect(detectOutputMode({ stdoutIsTty: true, json: false, ci: true })).toBe('plain'); // CI wins
    expect(detectOutputMode({ stdoutIsTty: false, json: false, ci: false })).toBe('plain'); // no TTY
  });

  it('refuses a miswired TUI before acquisition and releases its declared native-free owner', async () => {
    const captured = captureIo();
    const io = { ...captured.io, stdoutIsTty: true };
    const registry = new InvocationRegistry({ now: () => 0, schedule: () => () => undefined });
    const terminal = new WorkflowTerminal(
      registry,
      io,
      () => undefined,
      () => undefined,
    );
    let refused: unknown;
    try {
      terminal.createRenderer((creation) => selectRenderer(io, globalOptions({}), creation));
    } catch (cause) {
      refused = cause;
    }
    expect(refused).toMatchObject({ code: 'cli_internal', exitCode: 9 });
    await terminal.finish();
    expect(registry.activeOwners).toBe(0);
    expect(captured.out()).toBe('');
  });

  it('mounts installed Ink on the invocation streams even after process globals change', async () => {
    const aInput = new OwnedTtyInput();
    const aOutput = new OwnedTtyOutput();
    const bInput = new OwnedTtyInput();
    const bOutput = new OwnedTtyOutput();
    const inputDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    const outputDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout');
    if (inputDescriptor === undefined || outputDescriptor === undefined)
      throw new Error('Expected process stream descriptors.');
    const registry = new InvocationRegistry({ now: () => 0, schedule: () => () => undefined });
    let terminal: WorkflowTerminal | undefined;
    try {
      try {
        Object.defineProperty(process, 'stdin', { configurable: true, get: () => aInput });
        Object.defineProperty(process, 'stdout', { configurable: true, get: () => aOutput });
        const capture = captureIo();
        const io = {
          ...processIo(),
          env: {},
          writeErr: (text: string) => capture.io.writeErr(text),
          writeErrAcknowledged: (text: string) => capture.io.writeErrAcknowledged(text),
        };
        expect(io.nativeStdout).toBe(aOutput);
        expect(io.nativeStdin).toBe(aInput);
        Object.defineProperty(process, 'stdin', { configurable: true, get: () => bInput });
        Object.defineProperty(process, 'stdout', { configurable: true, get: () => bOutput });
        terminal = new WorkflowTerminal(
          registry,
          io,
          () => undefined,
          () => undefined,
        );
        const renderer = terminal.createRenderer((creation) =>
          selectRenderer(io, globalOptions({}), creation),
        );
        renderer.onEvent(COMPLETED);
      } finally {
        // Both alternatives are handle-free owned streams; no regression can acquire the operator's TTY.
        Object.defineProperty(process, 'stdin', inputDescriptor);
        Object.defineProperty(process, 'stdout', outputDescriptor);
      }
      await terminal?.finish();
      expect(aOutput.frames.join('')).toContain('cost $0.0000 known; usage unverified');
      expect(aOutput.frames.join('')).toContain('\u001b[?25l');
      expect(bOutput.frames).toEqual([]);
      expect(bInput.isRaw).toBe(false);
      expect(bInput.listeners('keypress')).toEqual([]);
      expect(registry.activeOwners).toBe(0);
    } finally {
      await terminal?.finish();
      aInput.destroy();
      aOutput.destroy();
      bInput.destroy();
      bOutput.destroy();
    }
  });
});
