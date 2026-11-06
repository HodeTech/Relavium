import { WorkflowLifetime } from './workflow-lifetime.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import {
  EngineStateError,
  createInMemoryHost,
  parseWorkflow,
  type WorkflowEngine,
} from '@relavium/core';
import type { GateDecision, RunEvent, RunPausedEvent } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { EXIT_CODES } from '../process/exit-codes.js';

import { buildEngine } from '../engine/build-engine.js';
import type { GatePrompter } from '../gate/prompter.js';
import type { RunRenderer } from '../render/renderer.js';
import { captureIo } from '../test-support.js';
import { driveRun, isTerminalOutcome, outcomeToExitCode, shouldBreakOnPause } from './drive.js';

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

// g has an approve deadline and g2 none: the deadline decides g, and g2 waits for its own decision.
const GATED_DEADLINE = `schema_version: '1.0'
workflow:
  id: drive-gated-deadline
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval, timeout_ms: 1000, timeout_action: approve }
    - { id: g2, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: g2 }
    - { from: g2, to: out }
`;

// Two gates in parallel: a with no deadline, b with an approve deadline.
const PARALLEL_DEADLINE = `schema_version: '1.0'
workflow:
  id: drive-parallel-deadline
  nodes:
    - { id: start, type: input }
    - { id: a, type: human_gate, gate_type: approval }
    - { id: b, type: human_gate, gate_type: approval, timeout_ms: 1000, timeout_action: approve }
    - { id: out, type: output }
  edges:
    - { from: start, to: a }
    - { from: start, to: b }
    - { from: a, to: out }
    - { from: b, to: out }
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
    const lifetime = new WorkflowLifetime(
      invocationFixture().invocation,
      io,
      () => () => undefined,
    );

    const outcome = await driveRun({
      lifetime,
      engine,
      handle,
      makeRenderer: () => renderer,
      gatePrompter: prompter,
      io,
    });
    await lifetime.finish();

    expect(outcome).toBe('completed');
    expect(prompter.prompt).toHaveBeenCalledTimes(1);
    expect(renderer.suspend).toHaveBeenCalledTimes(1); // released the terminal for the prompt...
    expect(renderer.resume).toHaveBeenCalledTimes(1); // ...then re-mounted
    const types = events.map((e) => e.type);
    expect(types).toContain('human_gate:resumed'); // the engine applied the decision
    expect(types.at(-1)).toBe('run:completed'); // and continued past the (ignored) run:paused to the terminal
  });

  it('closes an open card when its deadline decides the gate, says so, and prompts no later gate here', async () => {
    // Before, the card stayed open: the user's later Reject reached `engine.resume`, which ignores a gate already
    // decided, and the run went on approved with nothing said. The next card is not opened either: keys the user
    // was still typing for the closed card would answer it (Clack's `y` approves), so the run parks on g2.
    const host = createInMemoryHost();
    const engine = await buildEngine({ host });
    const handle = engine.start({
      workflow: parseWorkflow(GATED_DEADLINE, { source: 'drive.test' }),
      inputs: {},
    });
    const { renderer, events } = recordingRenderer();
    const captured = captureIo();
    const { err } = captured;
    // Order the notice against the live view's re-mount: it belongs under the card, before the view returns.
    const order: string[] = [];
    vi.mocked(renderer.resume)?.mockImplementation(() => {
      order.push('resume');
    });
    const io = {
      ...captured.io,
      writeErr: (text: string) => {
        order.push('err');
        captured.io.writeErr(text);
      },
    };
    const signals: AbortSignal[] = [];
    const prompter: GatePrompter = {
      prompt: vi.fn(
        (event: { readonly nodeId: string }, _budget: unknown, signal?: AbortSignal) => {
          if (event.nodeId !== 'g')
            return Promise.resolve<GateDecision>({ decision: 'approved', decidedBy: 'cli' });
          if (signal !== undefined) signals.push(signal);
          return new Promise<GateDecision | null>((resolve) => {
            signal?.addEventListener('abort', () => resolve(null));
            // The deadline fires while the card is open; the user's Reject comes a moment later.
            setTimeout(() => {
              host.fireTimers();
              setTimeout(() => resolve({ decision: 'rejected', decidedBy: 'cli' }), 20);
            }, 0);
          });
        },
      ),
    };
    const lifetime = new WorkflowLifetime(
      invocationFixture().invocation,
      io,
      () => () => undefined,
    );

    const outcome = await driveRun({
      lifetime,
      engine,
      handle,
      makeRenderer: () => renderer,
      gatePrompter: prompter,
      io,
    });
    await lifetime.finish();

    expect(outcome).toBe('paused');
    expect(signals[0]?.aborted).toBe(true);
    expect(err()).toMatch(
      /Gate \S+ was already decided \(approved by its deadline\); no answer from this terminal was recorded\. Later gates in this run are not prompted here\./u,
    );
    expect(err().match(/was already decided/gu)).toHaveLength(1);
    expect(order.slice(0, 2)).toEqual(['err', 'resume']);
    // Only g's card was drawn; g2 waits for an out-of-band decision.
    expect(prompter.prompt).toHaveBeenCalledTimes(1);
    const decided = events.filter((e) => e.type === 'human_gate:resumed');
    expect(decided).toEqual([
      expect.objectContaining({ nodeId: 'g', decision: 'approved', decidedBy: 'timeout' }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'human_gate:paused', nodeId: 'g2' }),
    );
  });

  it('closes the card when another terminal decides its gate as `cli`, before the card answered', async () => {
    // `cli` is every terminal's `decidedBy`, so it cannot tell this card's decision from another's; what this card
    // returned can.
    const { engine, handle } = await startGatedRun();
    const { renderer, events } = recordingRenderer();
    const { io, err } = captureIo();
    const signals: AbortSignal[] = [];
    const prompter: GatePrompter = {
      prompt: vi.fn(
        (
          event: { readonly runId: string; readonly gateId: string },
          _budget: unknown,
          signal?: AbortSignal,
        ) => {
          if (signal !== undefined) signals.push(signal);
          return new Promise<GateDecision | null>((resolve) => {
            signal?.addEventListener('abort', () => resolve(null));
            setTimeout(() => {
              void engine.resume(event.runId, event.gateId, {
                decision: 'approved',
                decidedBy: 'cli',
              });
              setTimeout(() => resolve({ decision: 'rejected', decidedBy: 'cli' }), 20);
            }, 0);
          });
        },
      ),
    };
    const lifetime = new WorkflowLifetime(
      invocationFixture().invocation,
      io,
      () => () => undefined,
    );

    const outcome = await driveRun({
      lifetime,
      engine,
      handle,
      makeRenderer: () => renderer,
      gatePrompter: prompter,
      io,
    });
    await lifetime.finish();

    expect(signals[0]?.aborted).toBe(true);
    expect(err()).toContain('was already decided (approved by cli)');
    expect(outcome).toBe('completed');
    const decided = events.filter((e) => e.type === 'human_gate:resumed');
    expect(decided).toEqual([expect.objectContaining({ decision: 'approved', decidedBy: 'cli' })]);
  });

  it('says so when another terminal decides the gate otherwise after the card answered, before its resume', async () => {
    // Both are `cli`; only the decision tells the other terminal's approval from this card's own rejection.
    const { engine, handle } = await startGatedRun();
    const resume = engine.resume.bind(engine);
    vi.spyOn(engine, 'resume').mockImplementation(async (runId, gateId, decision) => {
      if (decision.decision === 'rejected')
        await resume(runId, gateId, { decision: 'approved', decidedBy: 'cli' });
      return resume(runId, gateId, decision);
    });
    const { renderer, events } = recordingRenderer();
    const { io, err } = captureIo();
    const lifetime = new WorkflowLifetime(
      invocationFixture().invocation,
      io,
      () => () => undefined,
    );

    const outcome = await driveRun({
      lifetime,
      engine,
      handle,
      makeRenderer: () => renderer,
      gatePrompter: prompterReturning({ decision: 'rejected', decidedBy: 'cli' }),
      io,
    });
    await lifetime.finish();

    expect(outcome).toBe('completed');
    expect(err()).toContain('was already decided (approved by cli)');
    const decided = events.filter((e) => e.type === 'human_gate:resumed');
    expect(decided).toEqual([expect.objectContaining({ decision: 'approved', decidedBy: 'cli' })]);
  });

  it('leaves the open card alone when a deadline decides another gate, and says nothing', async () => {
    const host = createInMemoryHost();
    const engine = await buildEngine({ host });
    const handle = engine.start({
      workflow: parseWorkflow(PARALLEL_DEADLINE, { source: 'drive.test' }),
      inputs: {},
    });
    const { renderer, events } = recordingRenderer();
    const { io, err } = captureIo();
    const signals: AbortSignal[] = [];
    const prompted: string[] = [];
    const prompter: GatePrompter = {
      prompt: vi.fn(
        (event: { readonly nodeId: string }, _budget: unknown, signal?: AbortSignal) => {
          prompted.push(event.nodeId);
          if (signal !== undefined) signals.push(signal);
          return new Promise<GateDecision | null>((resolve) => {
            signal?.addEventListener('abort', () => resolve(null));
            // b's deadline fires while a's card is open; the user then approves a.
            setTimeout(() => {
              host.fireTimers();
              setTimeout(() => resolve({ decision: 'approved', decidedBy: 'cli' }), 20);
            }, 0);
          });
        },
      ),
    };
    const lifetime = new WorkflowLifetime(
      invocationFixture().invocation,
      io,
      () => () => undefined,
    );

    const outcome = await driveRun({
      lifetime,
      engine,
      handle,
      makeRenderer: () => renderer,
      gatePrompter: prompter,
      io,
    });
    await lifetime.finish();

    expect(prompted).toEqual(['a']);
    expect(signals[0]?.aborted).toBe(false);
    expect(err()).not.toContain('was already decided');
    expect(outcome).toBe('completed');
    const decided = events
      .filter((e) => e.type === 'human_gate:resumed')
      .map((e) =>
        e.type === 'human_gate:resumed' ? `${e.nodeId}:${e.decision}:${e.decidedBy}` : '',
      );
    expect(decided.sort()).toEqual(['a:approved:cli', 'b:approved:timeout']);
  });

  it('passes the built decision through to the engine (the resumed event carries it)', async () => {
    const { engine, handle } = await startGatedRun();
    const { renderer, events } = recordingRenderer();
    const { io } = captureIo();
    const lifetime = new WorkflowLifetime(
      invocationFixture().invocation,
      io,
      () => () => undefined,
    );

    await driveRun({
      lifetime,
      engine,
      handle,
      makeRenderer: () => renderer,
      gatePrompter: prompterReturning({ decision: 'rejected', decidedBy: 'cli', comment: 'no' }),
      io,
    });
    await lifetime.finish();

    const resumed = events.find((e) => e.type === 'human_gate:resumed');
    expect(resumed).toMatchObject({ decision: 'rejected', decidedBy: 'cli' });
  });

  it('a null decision (the user aborted the prompt) cooperatively cancels the run', async () => {
    const { engine, handle } = await startGatedRun();
    const { renderer, events } = recordingRenderer();
    const { io } = captureIo();
    const lifetime = new WorkflowLifetime(
      invocationFixture().invocation,
      io,
      () => () => undefined,
    );

    const outcome = await driveRun({
      lifetime,
      engine,
      handle,
      makeRenderer: () => renderer,
      gatePrompter: prompterReturning(null),
      io,
    });
    await lifetime.finish();

    expect(outcome).toBe('cancelled');
    expect(events.at(-1)?.type).toBe('run:cancelled');
  });

  it('seals remount and summary on an unknown prompt failure, cancels the run, and preserves its cause', async () => {
    const { engine, handle } = await startGatedRun();
    const { renderer } = recordingRenderer();
    const prompter: GatePrompter = {
      prompt: () => Promise.reject(new Error('prompt boom')),
    };
    const { io } = captureIo();
    const cancelSpy = vi.spyOn(handle, 'cancel');

    const lifetime = new WorkflowLifetime(
      invocationFixture().invocation,
      io,
      () => () => undefined,
    );
    await expect(
      driveRun({
        lifetime,
        engine,
        handle,
        makeRenderer: () => renderer,
        gatePrompter: prompter,
        io,
      }),
    ).rejects.toThrow('prompt boom');
    expect(renderer.resume).not.toHaveBeenCalled(); // The infrastructure fault seals future native entry.
    expect(renderer.finalize).not.toHaveBeenCalled(); // Actual release is joined independently of summary.
    expect(cancelSpy).toHaveBeenCalledTimes(1); // ...and cancelled the still-live run (abnormal-unwind guard)
    let retired = false;
    void lifetime.finish().then(() => {
      retired = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(retired).toBe(false); // A rejected prompt never proves terminal release.
    expect(lifetime.invocation.registry.activeOwners).toBe(1);
  });

  it('never enters a faulty remount after a prompt infrastructure failure or echoes either private cause', async () => {
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

    const lifetime = new WorkflowLifetime(
      invocationFixture().invocation,
      io,
      () => () => undefined,
    );
    await expect(
      driveRun({
        lifetime,
        engine,
        handle,
        makeRenderer: () => renderer,
        gatePrompter: prompter,
        io,
      }),
    ).rejects.toThrow('prompt boom'); // the PROMPT error survives — the resume throw did not replace it
    expect(renderer.resume).not.toHaveBeenCalled();
    expect(err()).not.toContain('prompt boom');
    expect(err()).not.toContain('resume boom');
    let retired = false;
    void lifetime.finish().then(() => {
      retired = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(retired).toBe(false); // A rejected prompt never proves terminal release.
    expect(lifetime.invocation.registry.activeOwners).toBe(1);
  });

  it('without a prompter, a gate pause stops the loop (→ paused, exit 3)', async () => {
    const { engine, handle } = await startGatedRun();
    const { renderer } = recordingRenderer();
    const { io } = captureIo();
    const lifetime = new WorkflowLifetime(
      invocationFixture().invocation,
      io,
      () => () => undefined,
    );
    const outcome = await driveRun({ lifetime, engine, handle, makeRenderer: () => renderer, io });
    await lifetime.finish();
    expect(outcome).toBe('paused');
  });

  it('swallows a run_already_terminal from a cancel-during-prompt race, draining to cancelled (no opaque error)', async () => {
    const { engine, handle } = await startGatedRun();
    const { renderer } = recordingRenderer();
    const { io } = captureIo();
    const lifetime = new WorkflowLifetime(
      invocationFixture().invocation,
      io,
      () => () => undefined,
    );
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
      lifetime,
      engine,
      handle,
      makeRenderer: () => renderer,
      gatePrompter: prompter,
      io,
    });
    await lifetime.finish();

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

describe('outcomeToExitCode — the durability disposition (CR-92, ADR-0078 §5)', () => {
  it('UNCERTAIN outranks a completed outcome — a delivered terminal that is not recorded is not success', () => {
    // THE contract CR-92 exists for. Before this, `relavium run` exited 0 while the durable log had no
    // terminal at all, so a script was told the run was recorded when it was not.
    expect(outcomeToExitCode('completed', 'uncertain')).toBe(EXIT_CODES.durabilityUncertain);
  });

  it('UNCERTAIN outranks failed and cancelled too — it is about the RECORD, not the outcome', () => {
    // Deliberately neither 0 nor 1: the run may have completed and only its record be missing, so reporting
    // failure would be as wrong as reporting success.
    expect(outcomeToExitCode('failed', 'uncertain')).toBe(EXIT_CODES.durabilityUncertain);
    expect(outcomeToExitCode('cancelled', 'uncertain')).toBe(EXIT_CODES.durabilityUncertain);
  });

  it('NO terminal + uncertain is a FENCED run — exit 6, not 5 (ADR-0079 §5)', () => {
    // The two dispositions share a value and need opposite advice. Exit 5 promises the terminal is in the
    // outbox and will be retried on the next start; a fenced loser deliberately writes NOTHING there,
    // because the run belongs to another process and is being recorded by it right now. A script following
    // exit 5's documented remedy would wait for a drain that never comes.
    expect(outcomeToExitCode(undefined, 'uncertain')).toBe(EXIT_CODES.runOwnedElsewhere);
    // …and the discriminator is the delivered terminal, not the disposition: an outbox-uncertain run has one.
    expect(outcomeToExitCode('completed', 'uncertain')).toBe(EXIT_CODES.durabilityUncertain);
  });

  it('a stale buffered run:paused does NOT downgrade a fenced run to exit 5', () => {
    // The bug this closes was mine and it reopened the one the line above fixes. The discriminator was
    // `outcome === undefined`, but `run:paused` sets `outcome` too — and the engine BUFFERS that event
    // before it discovers the fence, so an inline gate prompt delivers a stale pause after the loss. The
    // flagship two-terminal race therefore reported 5 (with exit 5's false "retried from the outbox"
    // remedy) instead of 6. A pause is not a terminal; `isTerminalOutcome` already says so.
    expect(outcomeToExitCode('paused', 'uncertain')).toBe(EXIT_CODES.runOwnedElsewhere);
    // A legitimate pause is untouched — it never carries `uncertain`, so it still exits 3.
    expect(outcomeToExitCode('paused', 'pending')).toBe(EXIT_CODES.gatePaused);
  });

  it('a DURABLE terminal keeps its ordinary code — the negative control', () => {
    // Without this the assertions above pass for an implementation that returns 5 unconditionally.
    expect(outcomeToExitCode('completed', 'durable')).toBe(EXIT_CODES.success);
    expect(outcomeToExitCode('failed', 'durable')).toBe(EXIT_CODES.workflowFailed);
    expect(outcomeToExitCode('paused', 'durable')).toBe(EXIT_CODES.gatePaused);
  });

  it('an ABSENT disposition is treated as durable — what a caller with no handle can honestly say', () => {
    expect(outcomeToExitCode('completed')).toBe(EXIT_CODES.success);
    expect(outcomeToExitCode('failed')).toBe(EXIT_CODES.workflowFailed);
  });

  it('a PENDING disposition is not uncertain — a run with no terminal yet is an abnormal unwind, not a lost write', () => {
    expect(outcomeToExitCode('completed', 'pending')).toBe(EXIT_CODES.success);
    expect(outcomeToExitCode(undefined, 'pending')).toBe(EXIT_CODES.workflowFailed);
  });
});

describe('outcomeToExitCode — an unresolved external effect (ADR-0080 §2b, effect-journal.md §8)', () => {
  it('a failed run carrying `effect_needs_attention` exits 7, not 1', () => {
    // The remedy is unlike every other failure's: do NOT retry — a ticket may already be filed. Exit 1 would
    // put it in the same bucket as "a node errored and exhausted retries", which an automation loop re-runs.
    expect(outcomeToExitCode('failed', 'durable', 'effect_needs_attention')).toBe(
      EXIT_CODES.effectNeedsAttention,
    );
  });

  it('effect attention outranks terminal uncertainty after ADR-0103', () => {
    // An unresolved external effect forbids automatic retry even when the terminal record is uncertain.
    expect(outcomeToExitCode('failed', 'uncertain', 'effect_needs_attention')).toBe(
      EXIT_CODES.effectNeedsAttention,
    );
    expect(outcomeToExitCode(undefined, 'uncertain', 'effect_needs_attention')).toBe(
      EXIT_CODES.effectNeedsAttention,
    );
  });

  it('any OTHER terminal error code keeps its ordinary classification — the negative control', () => {
    // Without this the assertions above pass for an implementation that routed every failure to 7, which
    // would tell users never to retry an ordinary transient failure.
    expect(outcomeToExitCode('failed', 'durable', 'tool_failed')).toBe(EXIT_CODES.workflowFailed);
    expect(outcomeToExitCode('failed', 'durable', undefined)).toBe(EXIT_CODES.workflowFailed);
    expect(outcomeToExitCode('completed', 'durable', undefined)).toBe(EXIT_CODES.success);
  });
});
