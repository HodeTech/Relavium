import { expect, it } from 'vitest';
import type { DurableWriteContext, RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { buildRunPlan } from '../dag.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import type { NodeOutcome } from './node-executor.js';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
for (const ending of ['live', 'cancel', 'grace'] as const)
  it(`authored and ready batch orders differ, ending=${ending}`, async () => {
    const bEntered = deferred<void>(),
      bRelease = deferred<void>();
    const zReady = deferred<void>(),
      zRelease = deferred<void>();
    const rootsEntered = deferred<void>(),
      rootsAcked = deferred<void>();
    const rootsDone = deferred<NodeOutcome>();
    let rootEntries = 0,
      rootAcks = 0;
    class Store extends InMemoryRunStore {
      override async persistEvent(event: RunEvent, context?: DurableWriteContext): Promise<void> {
        if (event.type === 'node:started' && event.nodeId === 'b') {
          bEntered.resolve();
          await bRelease.promise;
        }
        await super.persistEvent(event, context);
        if (event.type === 'node:completed' && (event.nodeId === 'x' || event.nodeId === 'y')) {
          rootAcks += 1;
          if (rootAcks === 2) rootsAcked.resolve();
        }
      }
    }
    const host = createInMemoryHost({ store: new Store() });
    const workflow = parseWorkflow(
      JSON.stringify({
        schema_version: '1.0',
        workflow: {
          id: 'batch-order-grace',
          agents: [{ id: 'worker', provider: 'openai', model: 'offline', system_prompt: 'go' }],
          nodes: ['a', 'b', 'y', 'x', 'z'].map((id) => ({
            id,
            type: 'agent',
            agent_ref: 'worker',
            prompt_template: 'go',
          })),
          edges: [
            { from: 'x', to: 'a' },
            { from: 'y', to: 'b' },
          ],
        },
      }),
    );
    expect(buildRunPlan(workflow).order).toEqual(['y', 'b', 'x', 'a', 'z']);
    const executions: string[] = [];
    const engine = new WorkflowEngine({
      host,
      executor: {
        execute: ({ vertex }) => {
          executions.push(vertex.id);
          if (vertex.id === 'x' || vertex.id === 'y') {
            rootEntries += 1;
            if (rootEntries === 2) rootsEntered.resolve();
            return rootsDone.promise;
          }
          return Promise.resolve({ kind: 'completed', output: 'answer' });
        },
      },
    });
    const handle = engine.start({ workflow });
    let readinessCalls = 0;
    const originalReady = handle.whenConsumersReady;
    handle.whenConsumersReady = () => {
      readinessCalls += 1;
      if (readinessCalls === 3) {
        zReady.resolve();
        return zRelease.promise;
      }
      return originalReady();
    };
    const events: RunEvent[] = [];
    const drained = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    try {
      await zReady.promise;
      await rootsEntered.promise;
      rootsDone.resolve({ kind: 'completed', output: 'root' });
      await rootsAcked.promise;
      zRelease.resolve();
      await bEntered.promise;
      expect(executions).not.toContain('a');
      expect(executions).not.toContain('b');
      if (ending !== 'live') handle.cancel();
      if (ending === 'grace') {
        expect(host.deadlineCount()).toBe(1);
        host.fireDeadlines();
        for (let i = 0; i < 100; i++) await Promise.resolve();
      }
      bRelease.resolve();
      await drained;
      expect(
        events
          .filter((e) => e.type === 'node:started')
          .filter((e) => e.nodeId === 'a' || e.nodeId === 'b')
          .map((e) => e.nodeId),
      ).toEqual(ending === 'live' ? ['b', 'a'] : ['b']);
      expect(
        events
          .filter((e) => e.type === 'node:failed')
          .filter((e) => e.nodeId === 'a' || e.nodeId === 'b')
          .map((e) => e.nodeId),
      ).toEqual(ending === 'live' ? [] : ['b']);
      expect(executions.filter((id) => id === 'a' || id === 'b')).toEqual(
        ending === 'live' ? ['b', 'a'] : [],
      );
      expect(events.at(-1)?.type).toBe(ending === 'live' ? 'run:completed' : 'run:cancelled');
      await expect.poll(() => host.runLeases.read(handle.runId)).toBeUndefined();
      expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
    } finally {
      rootsDone.resolve({ kind: 'completed', output: 'root' });
      zRelease.resolve();
      bRelease.resolve();
      handle.cancel();
      host.fireDeadlines();
      await drained;
    }
  });
