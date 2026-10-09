import { expect, it } from 'vitest';
import type { RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';
import type { RunHandle } from './run-handle.js';

function workflowFor(bound: 'run' | 'node' | 'gate') {
  return parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: `departure-clock-${bound}`,
        ...(bound === 'run' ? { timeout_ms: 5000 } : {}),
        agents: [{ id: 'worker', model: 'offline-model', provider: 'openai', system_prompt: 'go' }],
        nodes: [
          {
            id: 'work',
            type: 'agent',
            agent_ref: 'worker',
            prompt_template: 'go',
            ...(bound === 'node' ? { timeout_ms: 5000 } : {}),
          },
        ],
        edges: [],
      },
    }),
  );
}
async function readPause(handle: RunHandle) {
  const iterator = handle.events[Symbol.asyncIterator]();
  const events: RunEvent[] = [];
  for (;;) {
    const item = await iterator.next();
    if (item.done) throw new Error('pause expected');
    events.push(item.value);
    if (item.value.type === 'run:paused') return { iterator, events };
  }
}
for (const bound of ['run', 'node', 'gate'] as const) {
  it(`a due ${bound} clock wins departure without a timer callback and leaves no timer behind`, async () => {
    let now = 0;
    const base = createInMemoryHost();
    const host: typeof base = { ...base, clock: { now: () => new Date(now).toISOString() } };
    const handle = new WorkflowEngine({
      host,
      executor: {
        execute: () =>
          Promise.resolve({
            kind: 'paused',
            gate: {
              gateType: 'approval',
              message: 'approve?',
              ...(bound === 'gate' ? { timeoutMs: 5000, timeoutAction: 'reject' as const } : {}),
            },
          }),
      },
    }).start({ workflow: workflowFor(bound) });
    const read = await readPause(handle);
    expect(host.armedCount() + host.deadlineCount()).toBe(1);
    const drained = (async () => {
      for (;;) {
        const item = await read.iterator.next();
        if (item.done) return;
        read.events.push(item.value);
      }
    })();
    now = 5000;
    const first = await handle.depart();
    expect(first.kind).not.toBe('detached');
    await drained;
    expect(read.events.at(-1)).toMatchObject({
      type: 'run:failed',
      error: { code: 'run_timeout' },
    });
    expect(read.events.filter((event) => event.type === 'run:failed')).toHaveLength(1);
    expect((await handle.depart()).kind).toBe('closed');
    expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
    expect(await host.runLeases.read(handle.runId)).toBeUndefined();
  });
}
