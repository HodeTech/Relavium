import type { RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { checkDurableTruth, formatDurableTruth } from './durable-truth.js';

const TS = '2026-01-01T00:00:00.000Z';
const base = (sequenceNumber: number) => ({ runId: 'r1', sequenceNumber, timestamp: TS });

const started: RunEvent = {
  type: 'run:started',
  ...base(0),
  workflowId: '00000000-0000-4000-8000-000000000001',
  inputs: {},
  executionMode: 'local',
};

const completed = (seq: number, outputs: unknown = { a: 1 }, cost = 500): RunEvent => ({
  type: 'run:completed',
  ...base(seq),
  outputs: outputs as Record<string, unknown>,
  totalTokensUsed: { input: 1, output: 1 },
  totalCostMicrocents: cost,
  durationMs: 10,
});

const failed = (seq: number, code: 'internal' | 'tool_failed' = 'internal'): RunEvent => ({
  type: 'run:failed',
  ...base(seq),
  error: { code, message: 'boom', retryable: false },
  partialOutputs: {},
});

const log = (...events: RunEvent[]) => {
  const stored = [started, ...events];
  return { eventsFor: () => stored, stored };
};

describe('checkDurableTruth', () => {
  it('AGREES when live, history, reconcile and the checkpoint all say the same thing', async () => {
    const terminal = completed(1);
    const { eventsFor } = log(terminal);
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: terminal,
      eventsFor,
      reconcile: () => Promise.resolve([]),
    });

    expect(verdict.agrees).toBe(true);
    expect(verdict.disagreements).toEqual([]);
    expect(verdict.durableTerminalCount).toBe(1);
    expect(verdict.checkpointStatus).toBe('completed');
  });

  it('catches the headline defect: a caller told `completed` while history says `failed`', async () => {
    // CR-92's exact shape. The live stream is the only thing an e2e assertion used to read, so this shipped
    // invisible: the API returns success and outputs, and the durable record disagrees.
    const { eventsFor } = log(failed(1));
    const verdict = await checkDurableTruth({ runId: 'r1', live: completed(1), eventsFor });

    expect(verdict.agrees).toBe(false);
    expect(verdict.disagreements[0]).toContain('live and durable history disagree');
    expect(formatDurableTruth(verdict)).toContain('run:completed');
    expect(formatDurableTruth(verdict)).toContain('run:failed');
  });

  it('catches a SAME-TYPE terminal whose payload differs', async () => {
    // Type-only comparison would pass this. Two runs both `completed`, different outputs and different money
    // — which is the reconciliation-rewrote-the-answer case, not a crash.
    const { eventsFor } = log(completed(1, { a: 1 }, 500));
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: completed(1, { a: 2 }, 900),
      eventsFor,
    });

    expect(verdict.agrees).toBe(false);
    expect(verdict.disagreements[0]).toContain('live and durable history disagree');
  });

  it('IGNORES envelope drift — a restart moves the clock, and that is not a disagreement', async () => {
    const stored: RunEvent[] = [
      started,
      { ...completed(1), timestamp: '2026-02-02T00:00:00.000Z' },
    ];
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: completed(7), // a different sequenceNumber too
      eventsFor: () => stored,
    });

    expect(verdict.agrees).toBe(true);
  });

  it('catches a restart that CHANGES the terminal', async () => {
    const stored: RunEvent[] = [started, completed(1)];
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: completed(1),
      eventsFor: () => stored,
      reconcile: () => {
        // A reconcile that rewrites an already-settled run — the "may later produce a different terminal"
        // half of CR-92.
        stored.splice(1, 1, failed(2));
        return Promise.resolve([failed(2)]);
      },
    });

    expect(verdict.agrees).toBe(false);
    expect(verdict.disagreements.some((d) => d.includes('a restart CHANGED the terminal'))).toBe(
      true,
    );
  });

  it('catches a reconcile that adds a SECOND terminal to an already-closed run', async () => {
    const stored: RunEvent[] = [started, completed(1)];
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: completed(1),
      eventsFor: () => stored,
      reconcile: () => {
        stored.push(failed(2));
        return Promise.resolve([failed(2)]);
      },
    });

    expect(verdict.agrees).toBe(false);
    expect(verdict.durableTerminalCount).toBe(2);
    expect(verdict.disagreements.some((d) => d.includes('exactly one closes a run'))).toBe(true);
    expect(verdict.disagreements.some((d) => d.includes('must not add a second'))).toBe(true);
  });

  it('catches a checkpoint fold that disagrees with the durable terminal', async () => {
    // The fold is what a resume seeds itself from, so a disagreement here means a resumed run does the wrong
    // work even though every event on disk is intact. Constructed by omitting `run:started`, which makes the
    // fold return `undefined` while the terminal is plainly there.
    const stored: RunEvent[] = [completed(1)];
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: completed(1),
      eventsFor: () => stored,
    });

    expect(verdict.agrees).toBe(false);
    expect(verdict.checkpointStatus).toBeUndefined();
    expect(verdict.disagreements.some((d) => d.includes('checkpoint fold'))).toBe(true);
  });

  it('catches a run that streamed a terminal and persisted NONE — the crash window', async () => {
    const { eventsFor } = log();
    const verdict = await checkDurableTruth({ runId: 'r1', live: completed(1), eventsFor });

    expect(verdict.agrees).toBe(false);
    expect(verdict.durableTerminalCount).toBe(0);
    expect(verdict.history).toBeUndefined();
  });

  it('accepts an async eventsFor — the real store returns a promise', async () => {
    const terminal = completed(1);
    const stored = [started, terminal];
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: terminal,
      eventsFor: () => Promise.resolve(stored),
    });

    expect(verdict.agrees).toBe(true);
  });

  it('skips view 3 when no reconcile is supplied, and says so in the counts', async () => {
    const terminal = failed(1, 'tool_failed');
    const { eventsFor } = log(terminal);
    const verdict = await checkDurableTruth({ runId: 'r1', live: terminal, eventsFor });

    expect(verdict.agrees).toBe(true);
    expect(verdict.reconciledCount).toBe(0);
    expect(verdict.afterReconcile).toEqual(verdict.history);
  });
});
