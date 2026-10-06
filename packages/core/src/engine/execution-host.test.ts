import { describe, expect, it, vi } from 'vitest';

import {
  isAppendConflictError,
  isCorruptRunEventError,
  RunEventSchema,
  type RunEvent,
} from '@relavium/shared';

import {
  createAbortController,
  createInMemoryHost,
  createManualTimerController,
  InMemoryRunStore,
} from './execution-host.js';

describe('createAbortController — platform-free abort', () => {
  it('reports aborted, fires listeners once, and is idempotent', () => {
    const controller = createAbortController();
    const listener = vi.fn();
    controller.signal.addEventListener('abort', listener);
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    controller.abort(); // idempotent — listeners fire only once
    expect(controller.signal.aborted).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not fire a removed listener', () => {
    const controller = createAbortController();
    const listener = vi.fn();
    controller.signal.addEventListener('abort', listener);
    controller.signal.removeEventListener('abort', listener);
    controller.abort();
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not fire a listener registered after abort (matches native AbortSignal; check .aborted)', () => {
    const controller = createAbortController();
    controller.abort();
    const lateListener = vi.fn();
    controller.signal.addEventListener('abort', lateListener);
    expect(lateListener).not.toHaveBeenCalled(); // a caller must check signal.aborted instead
    expect(controller.signal.aborted).toBe(true);
  });
});

describe('InMemoryRunStore', () => {
  it('historical budget input rejects its node without aborting another interrupted run discovery', async () => {
    const store = new InMemoryRunStore();
    const base = { runId: 'legacy', timestamp: '2026-10-03T00:00:00.000Z' };
    const rows = [
      {
        type: 'run:started',
        sequenceNumber: 0,
        workflowId: '00000000-0000-4000-8000-000000000001',
        inputs: {},
        executionMode: 'local',
      },
      {
        type: 'budget:paused',
        sequenceNumber: 1,
        nodeId: 'agent',
        gateId: 'old-budget',
        spentMicrocents: 2,
        limitMicrocents: 1,
      },
      {
        type: 'human_gate:resumed',
        sequenceNumber: 2,
        nodeId: 'agent',
        decision: 'input_provided',
        decidedBy: 'historical-user',
        payload: { historical: 'answer' },
      },
    ].map((fields) => RunEventSchema.parse({ ...base, ...fields }));
    for (const row of rows) await store.persistEvent(row);
    await store.persistEvent(
      RunEventSchema.parse({
        ...base,
        runId: 'ordinary',
        type: 'run:started',
        sequenceNumber: 0,
        workflowId: '00000000-0000-4000-8000-000000000002',
        inputs: {},
        executionMode: 'local',
      }),
    );
    await store.persistEvent(
      RunEventSchema.parse({
        ...base,
        runId: 'ordinary',
        type: 'human_gate:paused',
        sequenceNumber: 1,
        nodeId: 'human',
        gateId: 'ordinary-gate',
        gateType: 'input',
        message: 'ordinary input',
      }),
    );
    const interrupted = new Map((await store.listInterruptedRuns()).map((run) => [run.runId, run]));
    expect(interrupted.size).toBe(2);
    expect(interrupted.get('legacy')?.resumable).toBe(false);
    expect(interrupted.get('ordinary')?.resumable).toBe(true);
    expect(store.eventsFor('legacy')).toEqual(rows);
  });
  it('refuses aggregate discovery with typed row context and preserves healthy and corrupt evidence', async () => {
    const store = new InMemoryRunStore();
    const event = (
      runId: string,
      sequenceNumber: number,
      fields: Record<string, unknown>,
    ): RunEvent =>
      RunEventSchema.parse({
        runId,
        sequenceNumber,
        timestamp: '2026-10-04T00:00:00.000Z',
        ...fields,
      });
    for (const runId of ['healthy', 'damaged']) {
      await store.persistEvent(
        event(runId, 0, {
          type: 'run:started',
          workflowId: '00000000-0000-4000-8000-000000000001',
          inputs: {},
          executionMode: 'local',
        }),
      );
      await store.persistEvent(
        event(runId, 1, {
          type: 'human_gate:paused',
          nodeId: 'human',
          gateId: 'gate',
          gateType: 'approval',
          message: 'approve',
        }),
      );
    }
    await store.persistEvent(
      event('damaged', 2, {
        type: 'human_gate:paused',
        nodeId: 'conflicting',
        gateId: 'gate',
        gateType: 'approval',
        message: 'approve',
      }),
    );
    const healthy = [...store.eventsFor('healthy')];
    const damaged = [...store.eventsFor('damaged')];
    let error: unknown;
    try {
      await store.listInterruptedRuns();
    } catch (cause) {
      error = cause;
    }
    expect(isCorruptRunEventError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'corrupt_run_event',
      runId: 'damaged',
      sequenceNumber: 2,
      eventType: 'human_gate:paused',
    });
    expect(store.eventsFor('healthy')).toEqual(healthy);
    expect(store.eventsFor('damaged')).toEqual(damaged);
  });

  it('mints a stable UUID per slug and reuses it', async () => {
    const store = new InMemoryRunStore();
    const first = await store.resolveWorkflowId('my-flow');
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.resolveWorkflowId('my-flow')).toBe(first);
    expect(await store.resolveWorkflowId('other-flow')).not.toBe(first);
  });

  it('ignores a session-correlated event (no runId) and records run events per run', async () => {
    const store = new InMemoryRunStore();
    const sessionEvent = {
      type: 'agent:token',
      sessionId: 's1',
      timestamp: '2026-06-13T00:00:00.000Z',
      sequenceNumber: 0,
      nodeId: 'n',
      token: 'x',
      model: 'm',
    } as RunEvent;
    await store.persistEvent(sessionEvent);
    expect(store.eventsFor('s1')).toHaveLength(0); // out of the run store's scope

    const runEvent = {
      type: 'run:started',
      runId: 'r1',
      timestamp: '2026-06-13T00:00:00.000Z',
      sequenceNumber: 0,
      workflowId: '00000000-0000-4000-8000-000000000001',
      inputs: {},
      executionMode: 'local',
    } as RunEvent;
    await store.persistEvent(runEvent);
    expect(store.eventsFor('r1')).toHaveLength(1);
  });

  it('excludes a completed run from the interrupted set', async () => {
    const store = new InMemoryRunStore();
    const base = { runId: 'r1', timestamp: '2026-06-13T00:00:00.000Z' };
    await store.persistEvent({
      ...base,
      type: 'run:started',
      sequenceNumber: 0,
      workflowId: '00000000-0000-4000-8000-000000000001',
      inputs: {},
      executionMode: 'local',
    });
    await store.persistEvent({
      ...base,
      type: 'run:completed',
      sequenceNumber: 1,
      outputs: {},
      totalTokensUsed: { input: 0, output: 0 },
      totalCostMicrocents: 0,
      durationMs: 1,
    });
    expect(await store.listInterruptedRuns()).toHaveLength(0);
  });

  it('reports a started-but-unfinished run as interrupted (resumable: false)', async () => {
    const store = new InMemoryRunStore();
    await store.persistEvent({
      type: 'run:started',
      runId: 'r1',
      timestamp: '2026-06-13T00:00:00.000Z',
      sequenceNumber: 0,
      workflowId: '00000000-0000-4000-8000-000000000001',
      inputs: {},
      executionMode: 'local',
    });
    const interrupted = await store.listInterruptedRuns();
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.runId).toBe('r1');
    expect(interrupted[0]?.resumable).toBe(false); // mid-execution crash, not parked at a gate
  });

  it('reports a run parked at a suspension event as interrupted (resumable: true)', async () => {
    // An aggregate pause follows an individual gate record; it cannot create a gate identity itself.
    const at = '2026-06-13T00:00:00.000Z';
    const lastEvents: RunEvent[] = [
      {
        type: 'human_gate:paused',
        runId: 'r1',
        timestamp: at,
        sequenceNumber: 1,
        nodeId: 'g',
        gateId: 'gid',
        gateType: 'approval',
        message: 'approve?',
      },
      {
        type: 'run:paused',
        runId: 'r1',
        timestamp: at,
        sequenceNumber: 1,
        pendingGateCount: 1,
        gateIds: ['gid'],
      },
      {
        type: 'budget:paused',
        runId: 'r1',
        timestamp: at,
        sequenceNumber: 1,
        nodeId: 'n1',
        gateId: 'bgid',
        spentMicrocents: 100,
        limitMicrocents: 50,
      },
      {
        // An async media-job park whose `run:paused` never persisted (crash in the submit→pause window) is
        // STILL resumable — the run re-attaches the parked job via the derived pendingMediaJobs slot (1.AG,
        // ADR-0045 §2-3); reconciling it to run:failed would orphan a paid provider LRO.
        type: 'media_job:submitted',
        runId: 'r1',
        timestamp: at,
        sequenceNumber: 1,
        nodeId: 'gen',
        jobId: 'vendor-op-1',
        provider: 'openai',
        model: 'sora-2',
        modality: 'video',
        startedAt: at,
        deadlineAt: '2026-06-13T00:30:00.000Z',
      },
    ];
    for (const last of lastEvents) {
      const store = new InMemoryRunStore();
      await store.persistEvent({
        type: 'run:started',
        runId: 'r1',
        timestamp: at,
        sequenceNumber: 0,
        workflowId: '00000000-0000-4000-8000-000000000001',
        inputs: {},
        executionMode: 'local',
      });
      if (last.type === 'run:paused') {
        const individual = lastEvents[0];
        if (individual === undefined) throw new Error('missing individual gate fixture');
        await store.persistEvent(individual);
      }
      await store.persistEvent({ ...last, sequenceNumber: last.type === 'run:paused' ? 2 : 1 });
      const interrupted = await store.listInterruptedRuns();
      expect(interrupted, last.type).toHaveLength(1);
      expect(interrupted[0]?.resumable, last.type).toBe(true);
      expect(interrupted[0]?.lastSequenceNumber, last.type).toBe(
        last.type === 'run:paused' ? 2 : 1,
      );
    }
  });
});

describe('interruption discovery from ordered gate history', () => {
  const envelope = { runId: 'r-history', timestamp: '2026-10-03T00:00:00.000Z' };
  const event = (sequenceNumber: number, fields: Record<string, unknown>): RunEvent =>
    RunEventSchema.parse({ ...envelope, sequenceNumber, ...fields });
  const start = event(0, {
    type: 'run:started',
    workflowId: '00000000-0000-4000-8000-000000000001',
    inputs: {},
    executionMode: 'local',
  });
  const pause = event(1, {
    type: 'budget:authorization',
    nodeId: 'agent',
    gateId: 'bg',
    authorization: {
      state: 'paused',
      allowance: { kind: 'legacy_no_allowance' },
      spentMicrocents: 2,
      limitMicrocents: 1,
    },
  });
  const human = event(2, {
    type: 'human_gate:paused',
    nodeId: 'human',
    gateId: 'hg',
    gateType: 'approval',
    message: 'offline',
  });
  const decision = event(3, {
    type: 'budget:authorization',
    nodeId: 'agent',
    gateId: 'bg',
    authorization: {
      state: 'decided',
      allowance: { kind: 'legacy_no_allowance' },
      decision: 'approved',
      decidedBy: 'offline',
    },
  });
  const companion = event(4, {
    type: 'human_gate:resumed',
    nodeId: 'agent',
    gateId: 'bg',
    decision: 'approved',
    decidedBy: 'offline',
  });
  for (const [name, history, expected] of [
    ['authority pause without companions', [start, pause], true],
    ['authority decision without companions', [start, pause, decision], false],
    ['ordinary sibling after authority decision', [start, pause, human, decision], true],
    ['ordinary sibling after decision companion', [start, pause, human, decision, companion], true],
  ] as const)
    it(name, async () => {
      const store = new InMemoryRunStore();
      for (const row of history) await store.persistEvent(row);
      const interrupted = await store.listInterruptedRuns();
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]?.resumable).toBe(expected);
      expect(interrupted[0]?.lastSequenceNumber).toBe(history.at(-1)?.sequenceNumber);
    });
});

describe('createInMemoryHost', () => {
  it('produces a deterministic ISO clock and unique ids', () => {
    const host = createInMemoryHost();
    const t1 = host.clock.now();
    const t2 = host.clock.now();
    expect(t1).not.toBe(t2); // advances per read
    expect(Date.parse(t2)).toBeGreaterThan(Date.parse(t1));
    expect(host.ids.newId()).not.toBe(host.ids.newId());
  });
});

describe('createManualTimerController — deterministic one-shot timer', () => {
  it('fires an armed timer exactly once on fireTimers, then drops it', () => {
    const timers = createManualTimerController();
    const fired = vi.fn();
    timers.setTimer(1000, fired);
    expect(timers.armedCount()).toBe(1);
    timers.fireTimers();
    expect(fired).toHaveBeenCalledTimes(1);
    expect(timers.armedCount()).toBe(0); // dropped after firing
  });

  it('does not fire a disarmed timer', () => {
    const timers = createManualTimerController();
    const fired = vi.fn();
    const disarm = timers.setTimer(1000, fired);
    disarm();
    expect(timers.armedCount()).toBe(0);
    timers.fireTimers();
    expect(fired).not.toHaveBeenCalled();
  });

  it('is idempotent across consecutive fireTimers calls (no double-fire)', () => {
    const timers = createManualTimerController();
    const fired = vi.fn();
    timers.setTimer(1000, fired);
    timers.fireTimers();
    timers.fireTimers(); // a second sweep has nothing armed
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('a callback that disarms a sibling timer mid-sweep is honored (snapshot is re-checked)', () => {
    const timers = createManualTimerController();
    const second = vi.fn();
    let disarmSecond = (): void => undefined;
    timers.setTimer(1000, () => {
      disarmSecond(); // the first timer disarms the second before the sweep reaches it
    });
    disarmSecond = timers.setTimer(1000, second);
    timers.fireTimers();
    expect(second).not.toHaveBeenCalled(); // the armed re-check inside the sweep skipped it
  });

  it('disarm is safe to call after the timer already fired (idempotent)', () => {
    const timers = createManualTimerController();
    const disarm = timers.setTimer(1000, () => undefined);
    timers.fireTimers();
    expect(() => disarm()).not.toThrow();
    expect(timers.armedCount()).toBe(0);
  });
});

describe('InMemoryRunStore — the compare-and-append guard (CR-10, ADR-0078 §2)', () => {
  const TS = '2026-01-01T00:00:00.000Z';
  const started = (seq: number): RunEvent => ({
    type: 'run:started',
    runId: 'r1',
    sequenceNumber: seq,
    timestamp: TS,
    workflowId: '00000000-0000-4000-8000-000000000001',
    inputs: {},
    executionMode: 'local',
  });
  const skipped = (seq: number): RunEvent => ({
    type: 'node:skipped',
    runId: 'r1',
    sequenceNumber: seq,
    timestamp: TS,
    nodeId: 'n',
    reason: 'branch_not_taken',
  });

  it('applies the SAME guard as the SQLite store — a reference that does not proves nothing', async () => {
    // The whole reason this is here: every `packages/core` test runs against this store. If it accepted what
    // `run-history-store` rejects, the divergence would surface only in `apps/cli`, which is the one place
    // these tests exist to keep it out of.
    const store = new InMemoryRunStore();
    await store.persistEvent(started(0), { expectedLastSequenceNumber: -1 });
    await expect(
      store.persistEvent(skipped(2), { expectedLastSequenceNumber: 1 }),
    ).rejects.toSatisfy(isAppendConflictError);
    expect(store.eventsFor('r1').map((e) => e.sequenceNumber)).toEqual([0]);
  });

  it('mirrors the not-AHEAD guard too — equality alone does not order the log', async () => {
    // The SQLite half reproduced a stale terminal appending behind durable work while its belief matched
    // exactly. Sequence gaps are legitimate, so the incoming number is both unique and lower; only an
    // explicit "> max" says the log is a prefix. A reference that accepted this would hide it from every
    // `packages/core` test.
    const store = new InMemoryRunStore();
    await store.persistEvent(started(0), { expectedLastSequenceNumber: -1 });
    await store.persistEvent(skipped(5), { expectedLastSequenceNumber: 0 });

    await expect(
      store.persistEvent(skipped(3), { expectedLastSequenceNumber: 5 }), // behind
    ).rejects.toSatisfy(isAppendConflictError);
    await expect(
      store.persistEvent(skipped(5), { expectedLastSequenceNumber: 5 }), // replayed
    ).rejects.toSatisfy(isAppendConflictError);
    await expect(
      store.persistEvent(skipped(9), { expectedLastSequenceNumber: 5 }), // a legitimate gap still lands
    ).resolves.toBeUndefined();
    expect(store.eventsFor('r1').map((e) => e.sequenceNumber)).toEqual([0, 5, 9]);
  });

  it('accepts the FIRST append of a run only against `-1`', async () => {
    const store = new InMemoryRunStore();
    await expect(
      store.persistEvent(started(0), { expectedLastSequenceNumber: 0 }),
    ).rejects.toSatisfy(isAppendConflictError);
    await expect(
      store.persistEvent(started(0), { expectedLastSequenceNumber: -1 }),
    ).resolves.toBeUndefined();
  });

  it('accepts a NON-CONTIGUOUS sequence — streamed events legitimately consume numbers', async () => {
    // The guard compares the log's MAXIMUM to the caller's belief; it must not require `seq === max + 1`.
    // A healthy run reads [0,1,2,3,5,10,…] because `agent:token` and friends take numbers and never persist,
    // so a contiguity check here would refuse every real run.
    const store = new InMemoryRunStore();
    await store.persistEvent(started(0), { expectedLastSequenceNumber: -1 });
    await expect(
      store.persistEvent(skipped(9), { expectedLastSequenceNumber: 0 }),
    ).resolves.toBeUndefined();
    expect(store.eventsFor('r1').map((e) => e.sequenceNumber)).toEqual([0, 9]);
  });

  it('leaves an UNGUARDED append alone — no ctx, no belief to check', async () => {
    const store = new InMemoryRunStore();
    await store.persistEvent(started(0));
    await store.persistEvent(skipped(7));
    expect(store.eventsFor('r1').map((e) => e.sequenceNumber)).toEqual([0, 7]);
  });

  it('scopes the guard PER RUN — another run`s appends do not move this one`s maximum', async () => {
    const store = new InMemoryRunStore();
    await store.persistEvent(started(0), { expectedLastSequenceNumber: -1 });
    await store.persistEvent({ ...started(5), runId: 'r2' }, { expectedLastSequenceNumber: -1 });
    await expect(
      store.persistEvent(skipped(1), { expectedLastSequenceNumber: 0 }),
    ).resolves.toBeUndefined();
  });
});
