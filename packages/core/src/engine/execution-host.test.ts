import { describe, expect, it, vi } from 'vitest';

import type { RunEvent } from '@relavium/shared';

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
    // Pin every RESUMABLE_LAST_TYPES member directly against the store — incl. run:paused / budget:paused
    // that the engine path does not seed in these tests.
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
      await store.persistEvent(last);
      const interrupted = await store.listInterruptedRuns();
      expect(interrupted, last.type).toHaveLength(1);
      expect(interrupted[0]?.resumable, last.type).toBe(true);
      expect(interrupted[0]?.lastSequenceNumber, last.type).toBe(1);
    }
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
