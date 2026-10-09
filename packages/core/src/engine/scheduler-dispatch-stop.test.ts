import { expect, it } from 'vitest';
import type { DurableWriteContext, RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const width of [1, 3])
  for (const cancelled of [false, true])
    it(`refuses fresh dispatch deadlines after a held node-start append (width=${width}, cancel=${cancelled})`, async () => {
      const entered = deferred();
      const released = deferred();
      const appended = deferred();
      let held = false;
      class Store extends InMemoryRunStore {
        override async persistEvent(event: RunEvent, context?: DurableWriteContext): Promise<void> {
          if (!held && event.type === 'node:started') {
            held = true;
            entered.resolve();
            await released.promise;
            await super.persistEvent(event, context);
            appended.resolve();
            return;
          }
          await super.persistEvent(event, context);
        }
      }
      const base = createInMemoryHost({ store: new Store() });
      let nodeDeadlineArms = 0;
      const host: typeof base = {
        ...base,
        setTimer: (ms, fire, kind) => {
          if (ms === 5000 && kind === 'deadline') nodeDeadlineArms += 1;
          return base.setTimer(ms, fire, kind);
        },
      };
      let executions = 0;
      const handle = new WorkflowEngine({
        host,
        executor: {
          execute: () => {
            executions += 1;
            return Promise.resolve({ kind: 'completed', output: 'answer' });
          },
        },
      }).start({
        workflow: parseWorkflow(
          JSON.stringify({
            schema_version: '1.0',
            workflow: {
              id: 'scheduler-dispatch-stop',
              agents: [
                { id: 'worker', model: 'offline-model', provider: 'openai', system_prompt: 'go' },
              ],
              nodes: Array.from({ length: width }, (_, index) => ({
                id: `work-${index}`,
                type: 'agent',
                agent_ref: 'worker',
                prompt_template: 'go',
                timeout_ms: 5000,
              })),
              edges: [],
            },
          }),
        ),
      });
      const events: RunEvent[] = [];
      const drained = (async () => {
        for await (const event of handle.events) events.push(event);
      })();
      try {
        await entered.promise;
        expect(nodeDeadlineArms).toBe(0);
        expect(executions).toBe(0);
        if (cancelled) handle.cancel();
        released.resolve();
        await appended.promise;
        if (cancelled) {
          // Only controlled native Promise continuations remain; grace has not been fired.
          for (let turn = 0; turn < 300; turn += 1) await Promise.resolve();
          expect(nodeDeadlineArms).toBe(0);
          expect(executions).toBe(0);
          for (
            let turn = 0;
            turn < 1000 && !events.some((event) => event.type === 'run:cancelled');
            turn += 1
          )
            await Promise.resolve();
          expect(events.at(-1)?.type).toBe('run:cancelled');
          expect(events.filter((event) => event.type === 'node:failed')).toMatchObject([
            { nodeId: 'work-0', error: { code: 'cancelled' } },
          ]);
        }
        await drained;
        expect(events.at(-1)?.type).toBe(cancelled ? 'run:cancelled' : 'run:completed');
        expect(nodeDeadlineArms).toBe(cancelled ? 0 : width);
        expect(executions).toBe(cancelled ? 0 : width);
        await expect.poll(() => host.runLeases.read(handle.runId)).toBeUndefined();
        expect(host.armedCount()).toBe(0);
        expect(host.livenessCount()).toBe(0);
      } finally {
        released.resolve();
        handle.cancel();
        host.fireDeadlines();
        await drained;
      }
    });
