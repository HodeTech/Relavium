import { expect, it } from 'vitest';
import type { RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';

for (const width of [1, 3])
  for (const fault of [false, true])
    it(`owns first-start publication failure without entering work (width=${width}, fault=${fault})`, async () => {
      const base = createInMemoryHost();
      let armed = false;
      let faults = 0;
      const host: typeof base = {
        ...base,
        clock: {
          now: () => {
            if (armed && fault && faults === 0) {
              faults += 1;
              throw new Error('PRIVATE-FIRST-START-CLOCK');
            }
            return base.clock.now();
          },
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
              id: 'scheduler-start-publication',
              nodes: Array.from({ length: width }, (_, index) => ({
                id: `work-${index}`,
                type: 'input',
              })),
              edges: [],
            },
          }),
        ),
      });
      const readiness = handle.whenConsumersReady.bind(handle);
      handle.whenConsumersReady = async () => {
        await readiness();
        armed = true;
      };
      const events: RunEvent[] = [];
      const drained = (async () => {
        for await (const event of handle.events) events.push(event);
      })();
      try {
        for (
          let turn = 0;
          turn < 1000 && !events.some((e) => e.type === 'run:failed' || e.type === 'run:completed');
          turn += 1
        )
          await Promise.resolve();
        // No deadline or grace is fired to manufacture the terminal under test.
        expect(faults).toBe(fault ? 1 : 0);
        expect(events.at(-1)?.type).toBe(fault ? 'run:failed' : 'run:completed');
        await drained;
        expect(executions).toBe(fault ? 0 : width);
        expect(events.filter((e) => e.type === 'node:started')).toHaveLength(fault ? 0 : width);
        const failures = events.filter((e) => e.type === 'node:failed');
        expect(failures).toHaveLength(fault ? 1 : 0);
        if (fault)
          expect(failures[0]).toMatchObject({
            nodeId: 'work-0',
            error: { code: 'internal', message: 'the node start could not be published' },
          });
        expect(
          events.filter((e) => e.type === 'run:failed' || e.type === 'run:completed'),
        ).toHaveLength(1);
        expect(JSON.stringify(events)).not.toContain('PRIVATE');
        await expect.poll(() => host.runLeases.read(handle.runId)).toBeUndefined();
        expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
      } finally {
        handle.cancel();
        host.fireDeadlines();
        await drained;
      }
    });
