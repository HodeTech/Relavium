import { expect, it } from 'vitest';
import type { RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';

for (const kind of ['error', 'conversion-getter'] as const)
  it(`contains an unexpected dispatch ${kind} without inspecting its private cause`, async () => {
    const base = createInMemoryHost();
    let conversions = 0;
    let faults = 0;
    const cause =
      kind === 'error'
        ? new Error('PRIVATE-DISPATCH-CAUSE')
        : {
            get toString(): () => string {
              conversions += 1;
              throw new Error('PRIVATE-CONVERSION-CAUSE');
            },
          };
    const host: typeof base = {
      ...base,
      setTimer: (ms, fire, timerKind) => {
        if (ms === 5000 && timerKind === 'deadline' && faults === 0) {
          faults += 1;
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately hostile non-Error host fault
          throw cause;
        }
        return base.setTimer(ms, fire, timerKind);
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
            id: 'detached-dispatch-failure',
            agents: [
              { id: 'worker', model: 'offline-model', provider: 'openai', system_prompt: 'go' },
            ],
            nodes: [
              {
                id: 'work',
                type: 'agent',
                agent_ref: 'worker',
                prompt_template: 'go',
                timeout_ms: 5000,
              },
            ],
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
      for (
        let turn = 0;
        turn < 1000 && !events.some((event) => event.type === 'run:failed');
        turn += 1
      )
        await Promise.resolve();
      expect(faults).toBe(1);
      expect(events.at(-1)).toMatchObject({
        type: 'run:failed',
        error: { code: 'internal', message: 'node dispatch failed unexpectedly' },
      });
      await drained;
      expect(events.filter((event) => event.type === 'node:failed')).toHaveLength(1);
      expect(executions).toBe(0);
      expect(conversions).toBe(0);
      expect(JSON.stringify(events)).not.toContain('PRIVATE');
      await expect.poll(() => host.runLeases.read(handle.runId)).toBeUndefined();
      expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
    } finally {
      handle.cancel();
      host.fireDeadlines();
      await drained;
    }
  });
