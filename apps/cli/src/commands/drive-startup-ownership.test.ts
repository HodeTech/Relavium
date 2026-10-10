import { WorkflowEngine, createInMemoryHost, parseWorkflow } from '@relavium/core';
import { expect, it } from 'vitest';
import { captureIo } from '../test-support.js';
import { driveRun } from './drive.js';

for (const fails of [false, true])
  it(`owns input-adapter construction after engine admission (fails=${fails})`, async () => {
    const host = createInMemoryHost();
    const engine = new WorkflowEngine({
      host,
      executor: { execute: () => Promise.resolve({ kind: 'completed', output: 'answer' }) },
    });
    const handle = engine.start({
      workflow: parseWorkflow(
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'drive-startup-ownership',
            nodes: [{ id: 'work', type: 'input' }],
            edges: [],
          },
        }),
      ),
    });
    const { io } = captureIo();
    let constructions = 0;
    let mounts = 0;
    const signals = process.listenerCount('SIGINT');
    const driving = driveRun({
      engine,
      handle,
      io,
      makeGatePrompter: () => {
        constructions += 1;
        if (fails) throw new Error('input adapter construction failed');
        return undefined;
      },
      makeRenderer: () => {
        mounts += 1;
        return { onEvent: () => undefined };
      },
    });
    if (fails) await expect(driving).rejects.toThrow('input adapter construction failed');
    else await expect(driving).resolves.toBe('completed');
    expect(constructions).toBe(1);
    expect(mounts).toBe(fails ? 0 : 1);
    await expect(handle.depart()).resolves.toMatchObject({
      kind: 'closed',
      moneyDurability: 'durable',
      effectNeedsAttention: false,
    });
    expect(await host.runLeases.read(handle.runId)).toBeUndefined();
    expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(signals);
  });
