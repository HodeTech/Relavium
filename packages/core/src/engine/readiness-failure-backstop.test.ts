import { expect, it } from 'vitest';
import type { RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 1000; turn += 1) {
    if (await check()) return;
    await Promise.resolve();
  }
  expect.fail('readiness failure did not settle without grace');
}

for (const port of ['id', 'clock'] as const)
  it(`settles a readiness failure when its node failure ${port} throws once`, async () => {
    const base = createInMemoryHost();
    let armed = false;
    let faults = 0;
    const failOnce = (): void => {
      if (!armed) return;
      armed = false;
      faults += 1;
      throw new Error('private-readiness-host-fault');
    };
    const host = {
      ...base,
      ids: {
        newId: () => {
          if (port === 'id') failOnce();
          return base.ids.newId();
        },
      },
      clock: {
        now: () => {
          if (port === 'clock') failOnce();
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
          return Promise.resolve({ kind: 'completed', output: '' });
        },
      },
    }).start({
      workflow: parseWorkflow(
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'readiness-failure-backstop',
            nodes: [{ id: 'work', type: 'input' }],
            edges: [],
          },
        }),
      ),
    });
    handle.whenConsumersReady = () => {
      armed = true;
      return Promise.reject(new Error('private-readiness-rejection'));
    };
    const events: RunEvent[] = [];
    const drained = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    try {
      await until(() => faults === 1);
      await until(() => events.some((event) => event.type === 'run:failed'));
      await drained;
      expect(events.at(-1)).toMatchObject({
        type: 'run:failed',
        error: { code: 'internal', message: 'the event consumer readiness check failed' },
      });
      expect(executions).toBe(0);
      expect(events.filter((event) => event.type === 'node:started')).toEqual([]);
      expect(JSON.stringify(events)).not.toContain('private-readiness');
      await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
      expect(host.armedCount()).toBe(0);
      expect(host.livenessCount()).toBe(0);
    } finally {
      handle.cancel();
      host.fireDeadlines();
      await drained;
    }
  });
