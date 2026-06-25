import {
  EngineStateError,
  createInMemoryHost,
  parseWorkflow,
  type WorkflowEngine,
} from '@relavium/core';
import type { GateDecision, RunEvent, RunPausedEvent } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { buildEngine } from '../engine/build-engine.js';
import type { GatePrompter } from '../gate/prompter.js';
import type { RunRenderer } from '../render/renderer.js';
import { captureIo } from '../test-support.js';
import { driveRun, isTerminalOutcome, shouldBreakOnPause } from './drive.js';

// gate → out: a single approval gate, then completes. The in-memory host pauses at the fail-closed gate.
const GATED = `schema_version: '1.0'
workflow:
  id: drive-gated
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: out }
`;

async function startGatedRun(): Promise<{
  engine: WorkflowEngine;
  handle: ReturnType<WorkflowEngine['start']>;
}> {
  const engine = await buildEngine({ host: createInMemoryHost() });
  const def = parseWorkflow(GATED, { source: 'drive.test' });
  const handle = engine.start({ workflow: def, inputs: {} });
  return { engine, handle };
}

/** A renderer that records event types and spies on the suspend/resume/finalize lifecycle. */
function recordingRenderer(): { renderer: RunRenderer; events: RunEvent[] } {
  const events: RunEvent[] = [];
  return {
    events,
    renderer: {
      onEvent: (e) => {
        events.push(e);
      },
      suspend: vi.fn(),
      resume: vi.fn(),
      finalize: vi.fn(),
    },
  };
}

const prompterReturning = (value: GateDecision | null): GatePrompter => ({
  prompt: vi.fn(() => Promise.resolve(value)),
});

describe('driveRun — interactive gate', () => {
  it('resolves a gate inline (approve) — suspends the TUI, prompts, resumes the engine, drives to completion', async () => {
    const { engine, handle } = await startGatedRun();
    const { renderer, events } = recordingRenderer();
    const prompter = prompterReturning({ decision: 'approved', decidedBy: 'cli' });
    const { io } = captureIo();

    const outcome = await driveRun({
      engine,
      handle,
      makeRenderer: () => renderer,
      gatePrompter: prompter,
      io,
    });

    expect(outcome).toBe('completed');
    expect(prompter.prompt).toHaveBeenCalledTimes(1);
    expect(renderer.suspend).toHaveBeenCalledTimes(1); // released the terminal for the prompt...
    expect(renderer.resume).toHaveBeenCalledTimes(1); // ...then re-mounted
    const types = events.map((e) => e.type);
    expect(types).toContain('human_gate:resumed'); // the engine applied the decision
    expect(types.at(-1)).toBe('run:completed'); // and continued past the (ignored) run:paused to the terminal
  });

  it('passes the built decision through to the engine (the resumed event carries it)', async () => {
    const { engine, handle } = await startGatedRun();
    const { renderer, events } = recordingRenderer();
    const { io } = captureIo();

    await driveRun({
      engine,
      handle,
      makeRenderer: () => renderer,
      gatePrompter: prompterReturning({ decision: 'rejected', decidedBy: 'cli', comment: 'no' }),
      io,
    });

    const resumed = events.find((e) => e.type === 'human_gate:resumed');
    expect(resumed).toMatchObject({ decision: 'rejected', decidedBy: 'cli' });
  });

  it('a null decision (the user aborted the prompt) cooperatively cancels the run', async () => {
    const { engine, handle } = await startGatedRun();
    const { renderer, events } = recordingRenderer();
    const { io } = captureIo();

    const outcome = await driveRun({
      engine,
      handle,
      makeRenderer: () => renderer,
      gatePrompter: prompterReturning(null),
      io,
    });

    expect(outcome).toBe('cancelled');
    expect(events.at(-1)?.type).toBe('run:cancelled');
  });

  it('re-mounts the TUI even if the prompt throws (finally), cancels the live run, then the error unwinds', async () => {
    const { engine, handle } = await startGatedRun();
    const { renderer } = recordingRenderer();
    const prompter: GatePrompter = {
      prompt: () => Promise.reject(new Error('prompt boom')),
    };
    const { io } = captureIo();
    const cancelSpy = vi.spyOn(handle, 'cancel');

    await expect(
      driveRun({ engine, handle, makeRenderer: () => renderer, gatePrompter: prompter, io }),
    ).rejects.toThrow('prompt boom');
    expect(renderer.resume).toHaveBeenCalledTimes(1); // the suspend/prompt/resume finally restored the view
    expect(renderer.finalize).toHaveBeenCalledTimes(1); // driveRun's finally still finalized
    expect(cancelSpy).toHaveBeenCalledTimes(1); // ...and cancelled the still-live run (abnormal-unwind guard)
  });

  it('a renderer.resume() throw does NOT mask the prompt error (logs the resume failure to stderr)', async () => {
    const { engine, handle } = await startGatedRun();
    const renderer: RunRenderer = {
      onEvent: () => {},
      suspend: vi.fn(),
      resume: vi.fn(() => {
        throw new Error('resume boom');
      }),
      finalize: vi.fn(),
    };
    const prompter: GatePrompter = {
      prompt: () => Promise.reject(new Error('prompt boom')),
    };
    const { io, err } = captureIo();

    await expect(
      driveRun({ engine, handle, makeRenderer: () => renderer, gatePrompter: prompter, io }),
    ).rejects.toThrow('prompt boom'); // the PROMPT error survives — the resume throw did not replace it
    expect(err()).toContain('failed to restore the live view'); // the resume failure went to stderr instead
  });

  it('without a prompter, a gate pause stops the loop (→ paused, exit 3)', async () => {
    const { engine, handle } = await startGatedRun();
    const { renderer } = recordingRenderer();
    const { io } = captureIo();
    const outcome = await driveRun({ engine, handle, makeRenderer: () => renderer, io });
    expect(outcome).toBe('paused');
  });

  it('swallows a run_already_terminal from a cancel-during-prompt race, draining to cancelled (no opaque error)', async () => {
    const { engine, handle } = await startGatedRun();
    const { renderer } = recordingRenderer();
    const { io } = captureIo();
    // The SIGINT-during-prompt race: the prompt cooperatively cancels the run (→ run:cancelled), then returns
    // a decision the engine now refuses with run_already_terminal. driveRun must swallow that and drain to the
    // cancelled terminal — never surface it as a generic "unexpected internal error".
    const resumeSpy = vi
      .spyOn(engine, 'resume')
      .mockRejectedValue(
        new EngineStateError('run_already_terminal', 'the run has already terminated'),
      );
    const prompter: GatePrompter = {
      prompt: () => {
        handle.cancel(); // cooperative cancel → the run drains to run:cancelled
        return Promise.resolve({ decision: 'approved', decidedBy: 'cli' });
      },
    };

    const outcome = await driveRun({
      engine,
      handle,
      makeRenderer: () => renderer,
      gatePrompter: prompter,
      io,
    });

    expect(resumeSpy).toHaveBeenCalledTimes(1); // the race path WAS taken...
    expect(outcome).toBe('cancelled'); // ...and resolved cleanly to the cancelled terminal, no throw
  });
});

describe('shouldBreakOnPause', () => {
  const pause = (over: Partial<RunPausedEvent> = {}): RunPausedEvent => ({
    type: 'run:paused',
    runId: 'r',
    timestamp: '2026-06-24T10:00:00.000Z',
    sequenceNumber: 5,
    pendingGateCount: 1,
    gateIds: ['g1'],
    ...over,
  });

  it('always breaks with no prompter (CI / --json / no-TTY → exit 3)', () => {
    expect(shouldBreakOnPause(pause(), false, new Set())).toBe(true);
  });

  it('ignores a pause whose every gate was handled inline (no media park)', () => {
    expect(shouldBreakOnPause(pause({ gateIds: ['g1'] }), true, new Set(['g1']))).toBe(false);
  });

  it('breaks on a gate it never handled (cannot resolve inline)', () => {
    expect(shouldBreakOnPause(pause({ gateIds: ['g1', 'g2'] }), true, new Set(['g1']))).toBe(true);
  });

  it('breaks on a media-job park even when every gate was handled', () => {
    const event = pause({ pendingGateCount: 0, gateIds: [], pendingMediaJobNodeIds: ['m'] });
    expect(shouldBreakOnPause(event, true, new Set())).toBe(true);
  });
});

describe('isTerminalOutcome', () => {
  it('is true for every terminal outcome, false for paused / undefined (the GC gate, 2.S/D-GC)', () => {
    expect(isTerminalOutcome('completed')).toBe(true);
    expect(isTerminalOutcome('failed')).toBe(true);
    expect(isTerminalOutcome('cancelled')).toBe(true);
    expect(isTerminalOutcome('paused')).toBe(false); // resumable — its media must survive
    expect(isTerminalOutcome(undefined)).toBe(false); // an abnormal no-terminal unwind
  });
});
