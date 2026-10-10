import { expect, it, vi } from 'vitest';
import type { RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';
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
  expect.fail('scheduler transition did not complete');
}

function workflow(width = 1) {
  return parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'scheduler-lifetime',
        max_parallel: 64,
        nodes: Array.from({ length: width }, (_, slot) => ({ id: `work-${slot}`, type: 'input' })),
        edges: [],
      },
    }),
  );
}

for (const completion of ['fulfilled', 'rejected'] as const)
  it(`retains the scheduler's suspended readiness until ${completion} after terminal`, async () => {
    const joins = vi.spyOn(HostWorkRegistry.prototype, 'join');
    const ready = latch<void>();
    const entered = latch<void>();
    const host = createInMemoryHost();
    let executions = 0;
    const handle = new WorkflowEngine({
      host,
      executor: {
        execute: () => {
          executions += 1;
          return Promise.resolve({ kind: 'completed', output: '' });
        },
      },
    }).start({ workflow: workflow() });
    // A controlled public port at the real scheduler boundary, not a replacement scheduler.
    // Actual bounded-stream backpressure is independently covered by run-handle tests.
    handle.whenConsumersReady = () => {
      entered.resolve();
      return ready.promise;
    };
    const events: RunEvent[] = [];
    const drained = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    try {
      await entered.promise;
      const fence = await host.runLeases.read(handle.runId);
      expect(fence).toBeDefined();
      handle.cancel();
      host.fireDeadlines();
      await until(() => events.some((event) => event.type === 'run:cancelled'));
      await drained;
      expect(events.at(-1)?.type).toBe('run:cancelled');
      const result = joins.mock.results[0];
      if (result?.type !== 'return') throw new Error('missing actual retirement join');
      let joined = false;
      const joinedPromise = result.value.then(() => {
        joined = true;
      });
      await Promise.resolve();
      expect(joined).toBe(false);
      expect(await host.runLeases.read(handle.runId)).toEqual(fence);
      expect(host.livenessCount()).toBe(1);
      if (completion === 'fulfilled') ready.resolve();
      else ready.reject(new Error('private-readiness-failure'));
      await joinedPromise;
      await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
      expect(host.livenessCount()).toBe(0);
      expect(executions).toBe(0);
      expect(events.filter((event) => event.type === 'node:started')).toEqual([]);
      expect(JSON.stringify(events)).not.toContain('private-readiness-failure');
    } finally {
      ready.resolve();
      await drained;
      joins.mockRestore();
    }
  });

for (const access of ['direct', 'getter'] as const)
  it(`dispatches a live scheduler after ${access} readiness acknowledges with its receiver`, async () => {
    const ready = latch<void>();
    const entered = latch<void>();
    const host = createInMemoryHost();
    let executions = 0;
    const handle = new WorkflowEngine({
      host,
      executor: {
        execute: () => {
          executions += 1;
          return Promise.resolve({ kind: 'completed', output: '' });
        },
      },
    }).start({ workflow: workflow() });
    const readiness = function (this: typeof handle) {
      entered.resolve();
      expect(this).toBe(handle);
      return ready.promise;
    };
    if (access === 'direct') handle.whenConsumersReady = readiness;
    else Object.defineProperty(handle, 'whenConsumersReady', { get: () => readiness });
    const events: RunEvent[] = [];
    const drained = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    try {
      await entered.promise;
      expect(executions).toBe(0);
      ready.resolve();
      await drained;
      expect(events.at(-1)?.type).toBe('run:completed');
      expect(executions).toBe(1);
      await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
    } finally {
      ready.resolve();
      await drained;
    }
  });

for (const fault of ['throw', 'reject'] as const)
  it(`normalizes a live readiness ${fault} without entering an executor`, async () => {
    const host = createInMemoryHost();
    let executions = 0;
    const handle = new WorkflowEngine({
      host,
      executor: {
        execute: () => {
          executions += 1;
          return Promise.resolve({ kind: 'completed', output: '' });
        },
      },
    }).start({ workflow: workflow(3) });
    handle.whenConsumersReady = () => {
      const cause = new Error('private-consumer-readiness');
      if (fault === 'throw') throw cause;
      return Promise.reject(cause);
    };
    const events: RunEvent[] = [];
    const drained = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    try {
      await until(() => events.some((event) => event.type === 'run:failed'));
      await drained;
      expect(events.at(-1)).toMatchObject({
        type: 'run:failed',
        error: { code: 'internal', message: 'the event consumer readiness check failed' },
      });
      expect(JSON.stringify(events)).not.toContain('private-consumer-readiness');
      expect(events.filter((event) => event.type === 'node:started')).toEqual([]);
      expect(executions).toBe(0);
      await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
      expect(host.livenessCount()).toBe(0);
      expect(host.deadlineCount()).toBe(0);
    } finally {
      handle.cancel();
      host.fireDeadlines();
      await drained;
    }
  });

for (const width of [1, 3, 64])
  it(`unwinds ${width} unstarted claims after cancellation inside readiness`, async () => {
    const host = createInMemoryHost();
    let executions = 0;
    const handle = new WorkflowEngine({
      host,
      executor: {
        execute: () => {
          executions += 1;
          return Promise.resolve({ kind: 'completed', output: '' });
        },
      },
    }).start({ workflow: workflow(width) });
    let entries = 0;
    handle.whenConsumersReady = () => {
      entries += 1;
      handle.cancel();
      return Promise.resolve();
    };
    const events: RunEvent[] = [];
    const drained = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    try {
      // No grace firing is needed for claims that never entered node:started or an executor.
      await until(() => events.some((event) => event.type === 'run:cancelled'));
      await drained;
      expect(events.filter((event) => event.type.startsWith('node:'))).toEqual([]);
      expect(executions).toBe(0);
      expect(entries).toBe(1);
      await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
      expect(host.livenessCount()).toBe(0);
      expect(host.deadlineCount()).toBe(0);
    } finally {
      handle.cancel();
      host.fireDeadlines();
      await drained;
    }
  });

it('does not invoke readiness acquired from a getter that cancelled the execution', async () => {
  const host = createInMemoryHost();
  let executions = 0;
  const handle = new WorkflowEngine({
    host,
    executor: {
      execute: () => {
        executions += 1;
        return Promise.resolve({ kind: 'completed', output: '' });
      },
    },
  }).start({ workflow: workflow() });
  let acquisitions = 0;
  let entries = 0;
  Object.defineProperty(handle, 'whenConsumersReady', {
    get: () => {
      acquisitions += 1;
      handle.cancel();
      return () => {
        entries += 1;
        return Promise.resolve();
      };
    },
  });
  const events: RunEvent[] = [];
  const drained = (async () => {
    for await (const event of handle.events) events.push(event);
  })();
  try {
    await until(() => events.some((event) => event.type === 'run:cancelled'));
    await drained;
    expect(acquisitions).toBe(1);
    expect(entries).toBe(0);
    expect(executions).toBe(0);
    expect(events.filter((event) => event.type.startsWith('node:'))).toEqual([]);
    await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
  } finally {
    handle.cancel();
    host.fireDeadlines();
    await drained;
  }
});
