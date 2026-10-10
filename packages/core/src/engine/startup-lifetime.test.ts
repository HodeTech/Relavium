import { expect, it, vi } from 'vitest';
import type { RunEvent, RunFence } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import { HostWorkRegistry } from './host-work-registry.js';

function latch<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 1000; turn += 1) {
    if (await check()) return;
    await Promise.resolve();
  }
  expect.fail('startup transition did not complete');
}

function workflow(context = false, timeoutMs?: number) {
  return parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'startup-lifetime',
        ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
        ...(context
          ? {
              inputs: [{ name: 'path', type: 'string' }],
              context: [{ key: 'file', value: '{{inputs.path | read_file | read_file}}' }],
            }
          : {}),
        nodes: [{ id: 'work', type: 'input' }],
        edges: [],
      },
    }),
  );
}

for (const cancelAt of ['initial-clock', 'elapsed-clock', 'timer'] as const)
  it(`refuses fresh startup after reentrant cancellation from ${cancelAt}`, async () => {
    const base = createInMemoryHost();
    let latestId = '';
    let clockReads = 0;
    let cancelled = false;
    let lookups = 0;
    let executions = 0;
    let workTimerEntries = 0;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      engine.cancel(latestId);
    };
    const host: typeof base = {
      ...base,
      ids: { newId: () => (latestId = base.ids.newId()) },
      clock: {
        now: () => {
          clockReads += 1;
          if (
            (cancelAt === 'initial-clock' && clockReads === 1) ||
            (cancelAt === 'elapsed-clock' && clockReads === 2)
          )
            cancel();
          return base.clock.now();
        },
      },
      setTimer: (...args) => {
        if (args[2] === 'work') workTimerEntries += 1;
        const disarm = base.setTimer(...args);
        if (cancelAt === 'timer' && args[2] === 'work') cancel();
        return disarm;
      },
      store: {
        ...base.store,
        resolveWorkflowId: (name) => {
          lookups += 1;
          return base.store.resolveWorkflowId(name);
        },
        persistEvent: (...args) => base.store.persistEvent(...args),
        listInterruptedRuns: () => base.store.listInterruptedRuns(),
        readWorkflowSnapshot: (runId) => base.store.readWorkflowSnapshot(runId),
      },
    };
    const engine = new WorkflowEngine({
      host,
      executor: {
        execute: () => {
          executions += 1;
          return Promise.resolve({ kind: 'completed', output: '' });
        },
      },
    });
    const handle = engine.start({ workflow: workflow(false, 50) });
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    expect(cancelled).toBe(true);
    expect(events).toMatchObject([{ type: 'run:cancelled' }]);
    expect({
      lookups,
      executions,
      workTimers: host.armedCount(),
      deadlineTimers: host.deadlineCount(),
      livenessTimers: host.livenessCount(),
      workTimerEntries,
    }).toEqual({
      lookups: 0,
      executions: 0,
      workTimers: 0,
      deadlineTimers: 0,
      livenessTimers: 0,
      workTimerEntries: cancelAt === 'timer' ? 1 : 0,
    });
    expect(await host.runLeases.read(handle.runId)).toBeUndefined();
  });

for (const fault of ['clock', 'timer'] as const)
  it(`routes a synchronous initial ${fault} failure through the startup terminal boundary`, async () => {
    const base = createInMemoryHost();
    let failed = false;
    const host: typeof base = {
      ...base,
      clock: {
        now: () => {
          if (fault === 'clock' && !failed) {
            failed = true;
            throw new Error('private-initial-clock');
          }
          return base.clock.now();
        },
      },
      setTimer: (...args) => {
        if (fault === 'timer' && !failed) {
          failed = true;
          throw new Error('private-initial-timer');
        }
        return base.setTimer(...args);
      },
    };
    let executions = 0;
    const handle = new WorkflowEngine({
      host,
      executor: {
        execute: () => {
          executions += 1;
          return Promise.resolve({ kind: 'completed', output: '' });
        },
      },
    }).start({ workflow: workflow(false, 5) });
    const events: RunEvent[] = [];
    const iterator = handle.events[Symbol.asyncIterator]();
    const drained = (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        events.push(next.value);
      }
    })();
    try {
      await until(() => events.some((event) => event.type === 'run:failed'));
      await drained;
      expect(events).toMatchObject([{ type: 'run:failed', error: { code: 'internal' } }]);
      expect(JSON.stringify(events)).not.toContain('private-initial');
      expect(executions).toBe(0);
      await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
      expect(host.livenessCount()).toBe(0);
      expect(host.armedCount()).toBe(0);
      expect(host.deadlineCount()).toBe(0);
    } finally {
      await iterator.return?.();
      await drained;
    }
  });

for (const completion of ['fulfilled', 'rejected'] as const)
  it(`retains an entered context read after cancellation until its raw promise is ${completion}`, async () => {
    const raw = latch<string>();
    const entered = latch<void>();
    const host = createInMemoryHost();
    const paths: string[] = [];
    let executions = 0;
    const engine = new WorkflowEngine({
      host,
      resolverCapabilities: {
        readFile: (path) => {
          paths.push(path);
          entered.resolve();
          return raw.promise;
        },
      },
      executor: {
        execute: () => {
          executions += 1;
          return Promise.resolve({ kind: 'completed', output: '' });
        },
      },
    });
    const handle = engine.start({ workflow: workflow(true), inputs: { path: 'first.txt' } });
    const events: RunEvent[] = [];
    const drained = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    try {
      await entered.promise;
      const fence = await host.runLeases.read(handle.runId);
      expect(fence).toBeDefined();
      handle.cancel();
      await drained;
      expect(events.at(-1)?.type).toBe('run:cancelled');
      expect(handle.durability()).toBe('durable');
      expect(await host.runLeases.read(handle.runId)).toEqual(fence);
      expect(host.livenessCount()).toBe(1);
      // The live heartbeat retains the SAME owner/generation while only host cleanup is owed.
      host.fireLiveness();
      await until(() => host.livenessCount() === 1);
      const renewed = await host.runLeases.read(handle.runId);
      expect(renewed?.ownerId).toBe(fence?.ownerId);
      expect(renewed?.generation).toBe(fence?.generation);
      if (completion === 'fulfilled') raw.resolve('second.txt');
      else raw.reject(new Error('private-reader-failure'));
      await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
      expect(host.livenessCount()).toBe(0);
      expect(paths).toEqual(['first.txt']);
      expect(executions).toBe(0);
      expect(events.filter((event) => event.type.startsWith('run:'))).toMatchObject([
        { type: 'run:started' },
        { type: 'run:cancelled' },
      ]);
      expect(JSON.stringify(events)).not.toContain('private-reader-failure');
    } finally {
      raw.resolve('second.txt');
      await drained;
      await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
    }
  });

it('retains a workflow-id lookup across terminal publication and admits no late fresh work', async () => {
  // Observe the actual retirement join, without changing its behavior or inventing a public depart ACK.
  const retirementJoins = vi.spyOn(HostWorkRegistry.prototype, 'join');
  const raw = latch<string>();
  const entered = latch<void>();
  const store = new InMemoryRunStore();
  const workflowId = await store.resolveWorkflowId('startup-lifetime');
  const base = createInMemoryHost({ store });
  let acquisitions = 0;
  let executions = 0;
  let releases = 0;
  const host: typeof base = {
    ...base,
    store: {
      ...base.store,
      resolveWorkflowId: () => {
        entered.resolve();
        return raw.promise;
      },
      persistEvent: (...args) => base.store.persistEvent(...args),
      listInterruptedRuns: () => base.store.listInterruptedRuns(),
      readWorkflowSnapshot: (runId) => base.store.readWorkflowSnapshot(runId),
    },
    runLeases: {
      ...base.runLeases,
      acquire: (...args) => {
        acquisitions += 1;
        return base.runLeases.acquire(...args);
      },
      release: (...args) => {
        releases += 1;
        return base.runLeases.release(...args);
      },
    },
  };
  const engine = new WorkflowEngine({
    host,
    executor: {
      execute: () => {
        executions += 1;
        return Promise.resolve({ kind: 'completed', output: '' });
      },
    },
  });
  const handle = engine.start({ workflow: workflow() });
  const events: RunEvent[] = [];
  const drained = (async () => {
    for await (const event of handle.events) events.push(event);
  })();
  try {
    await entered.promise;
    handle.cancel();
    await drained;
    expect(events.at(-1)?.type).toBe('run:cancelled');
    // A finished run remains addressable in the engine's bounded terminal-history cache.
    await expect(
      engine.resume(handle.runId, 'unused', { decision: 'approved', decidedBy: 'h' }),
    ).rejects.toMatchObject({ code: 'run_already_terminal' });
    const joinResult = retirementJoins.mock.results[0];
    if (joinResult?.type !== 'return') throw new Error('missing actual retirement join');
    let joined = false;
    const observedJoin = joinResult.value.then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    raw.resolve(workflowId);
    await observedJoin;
    expect(acquisitions).toBe(0);
    expect(releases).toBe(0);
    expect(executions).toBe(0);
    expect(store.eventsFor(handle.runId)).toHaveLength(1);
    expect(events).toHaveLength(1);
  } finally {
    raw.resolve(workflowId);
    await drained;
    retirementJoins.mockRestore();
  }
});

it('joins an already entered fresh acquisition and releases its exact fence after cancellation', async () => {
  const retirementJoins = vi.spyOn(HostWorkRegistry.prototype, 'join');
  const raw = latch<RunFence | undefined>();
  const entered = latch<void>();
  const base = createInMemoryHost();
  let acquired: RunFence | undefined;
  const releases: RunFence[] = [];
  let executions = 0;
  const host: typeof base = {
    ...base,
    runLeases: {
      ...base.runLeases,
      acquire: async (...args) => {
        acquired = await base.runLeases.acquire(...args);
        entered.resolve();
        return raw.promise;
      },
      release: (runId, fence) => {
        releases.push(fence);
        return base.runLeases.release(runId, fence);
      },
    },
  };
  const handle = new WorkflowEngine({
    host,
    executor: {
      execute: () => {
        executions += 1;
        return Promise.resolve({ kind: 'completed', output: '' });
      },
    },
  }).start({ workflow: workflow() });
  const events: RunEvent[] = [];
  const drained = (async () => {
    for await (const event of handle.events) events.push(event);
  })();
  try {
    await entered.promise;
    expect(acquired).toBeDefined();
    handle.cancel();
    await drained;
    expect(events.at(-1)?.type).toBe('run:cancelled');
    if (acquired === undefined) throw new Error('missing entered acquisition');
    expect(await host.runLeases.read(handle.runId)).toMatchObject(acquired);
    expect(releases).toEqual([]);
    const joinResult = retirementJoins.mock.results[0];
    if (joinResult?.type !== 'return') throw new Error('missing actual retirement join');
    let joined = false;
    const observedJoin = joinResult.value.then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    raw.resolve(acquired);
    await observedJoin;
    await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
    expect(releases).toEqual([acquired]);
    expect(host.livenessCount()).toBe(0);
    expect(executions).toBe(0);
    expect(events.filter((event) => event.type === 'node:started')).toEqual([]);
  } finally {
    raw.resolve(acquired);
    await drained;
    retirementJoins.mockRestore();
  }
});
