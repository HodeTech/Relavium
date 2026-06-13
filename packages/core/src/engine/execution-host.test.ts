import { describe, expect, it, vi } from 'vitest';

import type { RunEvent } from '@relavium/shared';

import { createAbortController, createInMemoryHost, InMemoryRunStore } from './execution-host.js';

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
