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

const completed = (
  seq: number,
  outputs: Record<string, unknown> = { a: 1 },
  cost = 500,
): RunEvent => ({
  type: 'run:completed',
  ...base(seq),
  outputs,
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
    expect(verdict.disagreements.some((d) => d.includes('never one that landed'))).toBe(true);
    // And the terminal-changed check fires too, now that `terminalIn` reads the LAST terminal — with `find`
    // it read the first, so a reconcile that APPENDED a second was invisible to this check.
    expect(verdict.disagreements.some((d) => d.includes('a restart CHANGED the terminal'))).toBe(
      true,
    );
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

  it('catches a log belonging to ANOTHER run', async () => {
    // The store ignored its id argument, or the caller crossed two runs. `durableTerminalCount === 1` does
    // not catch it — the other run has a terminal too — so the oracle used to report agreement on the wrong
    // log entirely. CR-11's scenario is two owners over one store, which is exactly this shape.
    const other: RunEvent[] = [
      { ...started, runId: 'rOTHER' },
      { ...completed(1), runId: 'rOTHER' },
    ];
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: completed(1),
      eventsFor: () => other,
    });

    expect(verdict.agrees).toBe(false);
    expect(verdict.disagreements.some((d) => d.includes('belonging to another run'))).toBe(true);
    // …and every DOWNSTREAM number describes this run, not the foreign one. Naming the right cause while
    // counting the other run's terminal was the defect: `history` read `rOTHER`'s `run:completed` and this
    // came back as 1, so a reader who trusted the counts over the message saw a healthy log.
    expect(verdict.durableTerminalCount).toBe(0);
    expect(verdict.history).toBeUndefined();
  });

  it('catches a live terminal carrying a different runId', async () => {
    const { eventsFor } = log(completed(1));
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: { ...completed(1), runId: 'rOTHER' },
      eventsFor,
    });

    expect(verdict.agrees).toBe(false);
    expect(verdict.disagreements.some((d) => d.includes('not r1'))).toBe(true);
  });

  it('accepts a durable log whose seqs SKIP — streamed events take numbers and are never persisted', async () => {
    // A real completed run reads [0,1,2,3,5,10,11,12,13,14]. Asserting `0..n-1` here failed a healthy engine,
    // which is how this limitation was found: "no persisted event is missing from the middle" is not
    // expressible from the log alone, because a streamed event's absence looks identical to a lost one.
    const stored: RunEvent[] = [started, { ...completed(1), sequenceNumber: 7 }];
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: { ...completed(1), sequenceNumber: 7 },
      eventsFor: () => stored,
    });

    expect(verdict.agrees, formatDurableTruth(verdict)).toBe(true);
  });

  it('catches an OUT-OF-ORDER durable log — CR-10s checkable half', async () => {
    const stored: RunEvent[] = [
      { ...started, sequenceNumber: 0 },
      { ...failed(9) },
      { ...completed(1), sequenceNumber: 4 },
    ];
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: { ...completed(1), sequenceNumber: 4 },
      eventsFor: () => stored,
    });

    expect(verdict.agrees).toBe(false);
    expect(verdict.disagreements.some((d) => d.includes('is not ordered'))).toBe(true);
  });

  it('catches a durable log missing its head', async () => {
    const stored: RunEvent[] = [{ ...completed(1), sequenceNumber: 4 }];
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: { ...completed(1), sequenceNumber: 4 },
      eventsFor: () => stored,
    });

    expect(verdict.agrees).toBe(false);
    expect(verdict.disagreements.some((d) => d.includes('not 0'))).toBe(true);
  });

  it('catches an event persisted AFTER the terminal', async () => {
    const stored: RunEvent[] = [
      started,
      completed(1),
      { type: 'node:skipped', ...base(2), nodeId: 'x', reason: 'branch_not_taken' },
    ];
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: completed(1),
      eventsFor: () => stored,
    });

    expect(verdict.agrees).toBe(false);
    expect(verdict.disagreements.some((d) => d.includes('continues past its terminal'))).toBe(true);
  });

  it('does NOT blame this run for events reconcile() wrote for ANOTHER one', async () => {
    // `reconcile()` repairs every interrupted run in the store and returns all of their events. Attributing
    // the raw count here produced a factually wrong message and a false failure.
    const { eventsFor } = log(completed(1));
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: completed(1),
      eventsFor,
      reconcile: () => Promise.resolve([{ ...failed(9), runId: 'rOTHER' }]),
    });

    expect(verdict.agrees).toBe(true);
    expect(verdict.reconciledCount).toBe(0);
  });

  it('accepts a CORRECT crash repair under expect:"repaired" — the case this phase exists for', async () => {
    // Before the mode existed, a run that died without a terminal and was repaired on restart verdicted
    // `a restart CHANGED the terminal: before=none after=run:failed` — so no crash test could use the oracle
    // at all, which is most of what CR-91 is for.
    const stored: RunEvent[] = [started];
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: undefined,
      expect: 'repaired',
      eventsFor: () => stored,
      reconcile: () => {
        stored.push(failed(1));
        return Promise.resolve([failed(1)]);
      },
    });

    expect(verdict.agrees, formatDurableTruth(verdict)).toBe(true);
    expect(verdict.reconciledCount).toBe(1);
    expect(verdict.afterReconcile?.type).toBe('run:failed');
  });

  it('under expect:"repaired", a restart that repairs NOTHING is the failure', async () => {
    const stored: RunEvent[] = [started];
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: undefined,
      expect: 'repaired',
      eventsFor: () => stored,
      reconcile: () => Promise.resolve([]),
    });

    expect(verdict.agrees).toBe(false);
    expect(verdict.disagreements.some((d) => d.includes('NO durable terminal'))).toBe(true);
  });

  // The other two `expect:'repaired'` arms. Without them the mode was only ever exercised where it PASSES or
  // where the restart did nothing — so a caller that asked for `'repaired'` on a run that had, in fact,
  // settled would have been told it agreed, which is the mode's whole failure direction.
  it('under expect:"repaired", a log that ALREADY holds a terminal is the disagreement', async () => {
    const { eventsFor } = log(completed(1));
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: undefined,
      expect: 'repaired',
      eventsFor,
    });

    expect(verdict.agrees).toBe(false);
    expect(verdict.disagreements.some((d) => d.includes('already holds a terminal'))).toBe(true);
  });

  it('under expect:"repaired", a LIVE terminal means the run did not die — also a disagreement', async () => {
    const { eventsFor } = log();
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: completed(1),
      expect: 'repaired',
      eventsFor,
    });

    expect(verdict.agrees).toBe(false);
    expect(verdict.disagreements.some((d) => d.includes('the live stream produced'))).toBe(true);
  });

  /**
   * A `run:failed` differing from the baseline in exactly one error field. The override type is DERIVED from
   * the contract rather than asserted with `as never`, so a renamed field or an invalid `code` fails to
   * compile instead of silently building a fixture the oracle can never disagree about.
   */
  type FailureError = Extract<RunEvent, { type: 'run:failed' }>['error'];
  const failedWith = (error: Partial<FailureError>): RunEvent => ({
    type: 'run:failed',
    ...base(1),
    error: { code: 'tool_failed', message: 'boom', retryable: false, ...error },
    partialOutputs: {},
  });

  // One test per field, each flipping exactly ONE. A single fixture flipping two proved only "at least one
  // of them is compared" — dropping either from `sameView` left it green.
  it.each([
    ['retryable', failedWith({ nodeId: 'A', correlationId: 'c-1', retryable: true })],
    ['nodeId', failedWith({ nodeId: 'B', correlationId: 'c-1' })],
    ['correlationId', failedWith({ nodeId: 'A', correlationId: 'c-2' })],
  ])('catches a failure whose %s differs while the CODE matches', async (_field, durable) => {
    const liveEvent = failedWith({ nodeId: 'A', correlationId: 'c-1' });
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: liveEvent,
      eventsFor: () => [started, durable],
    });

    expect(verdict.agrees, formatDurableTruth(verdict)).toBe(false);
  });

  it('catches a completed run whose TOKEN totals differ', async () => {
    const durable: RunEvent = {
      type: 'run:completed',
      ...base(1),
      outputs: { a: 1 },
      totalTokensUsed: { input: 9, output: 9 },
      totalCostMicrocents: 500,
      durationMs: 10,
    };
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: completed(1),
      eventsFor: () => [started, durable],
    });

    expect(verdict.agrees).toBe(false);
  });

  it('RENDERS every compared field, so a DISAGREES verdict shows why', async () => {
    // The rendered diff used to print type/code/cost/outputs only — so a pair differing solely in
    // `retryable` or `correlationId` printed byte-identically on both sides and told the reader nothing.
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: failedWith({ retryable: false, nodeId: 'A', correlationId: 'c-1' }),
      eventsFor: () => [
        started,
        failedWith({ retryable: true, nodeId: 'B', correlationId: 'c-2' }),
      ],
    });

    const rendered = formatDurableTruth(verdict);
    expect(rendered).toContain('retryable=false');
    expect(rendered).toContain('retryable=true');
    expect(rendered).toContain('correlationId=c-1');
    expect(rendered).toContain('correlationId=c-2');
    expect(rendered).toContain('node=A');
    expect(rendered).toContain('node=B');
  });

  it('compares outputs key-order-insensitively, and never throws on an uncomparable payload', async () => {
    const reordered = await checkDurableTruth({
      runId: 'r1',
      live: completed(1, { a: 1, b: 2 }),
      eventsFor: () => [started, completed(1, { b: 2, a: 1 })],
    });
    expect(reordered.agrees, 'key order is not a disagreement').toBe(true);

    // A circular payload used to throw OUT of the oracle, so the instrument became the failure.
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: completed(1, circular),
      eventsFor: () => [started, completed(1, circular)],
    });
    expect(verdict.agrees).toBe(true);
  });

  it('treats a SHARED reference as shared, not circular — a repeated object is not a cycle', async () => {
    // The first cycle guard was a flat `WeakSet` that was never un-marked on the way back up, so it flagged
    // every REPEATED reference. `{ a: shared, b: shared }` serialized as `{"a":{…},"b":"[circular]"}` while a
    // structurally identical payload built from two separate objects serialized normally — two equal outputs
    // disagreeing, which is the exact false failure `canonical` exists to prevent. A `fan_in` echoing one
    // value into two keys is enough to hit it.
    const shared = { x: 1 };
    const verdict = await checkDurableTruth({
      runId: 'r1',
      live: completed(1, { a: shared, b: shared }),
      eventsFor: () => [started, completed(1, { a: { x: 1 }, b: { x: 1 } })],
    });

    expect(verdict.agrees, formatDurableTruth(verdict)).toBe(true);
  });

  it('reports WHERE the checkpoint status came from — a local fold is not the resume path', async () => {
    const terminal = completed(1);
    const { eventsFor } = log(terminal);

    const local = await checkDurableTruth({ runId: 'r1', live: terminal, eventsFor });
    expect(local.checkpointSource).toBe('local-fold');

    const viaPort = await checkDurableTruth({
      runId: 'r1',
      live: terminal,
      eventsFor,
      loadCheckpoint: () => Promise.resolve({ runStatus: 'completed' as const }),
    });
    expect(viaPort.checkpointSource).toBe('checkpointer');

    // And the port is what is BELIEVED when supplied: a checkpointer that refuses (undefined) disagrees with
    // a durable terminal, which a local fold would have read happily.
    const refusing = await checkDurableTruth({
      runId: 'r1',
      live: terminal,
      eventsFor,
      loadCheckpoint: () => Promise.resolve(undefined),
    });
    expect(refusing.agrees).toBe(false);
    expect(refusing.disagreements.some((d) => d.includes('checkpoint port'))).toBe(true);
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
