import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { WorkflowEngine, createInMemoryHost, parseWorkflow } from '@relavium/core';
import { driveRun } from '../../commands/drive.js';
import { captureIo } from '../../test-support.js';
import { createInkRenderer } from './ink-renderer.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('actual Ink displays a terminal after native input ACK while the host receipt is still held', async () => {
  const workflow = parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'ink-post-input-terminal',
        nodes: [{ id: 'work', type: 'input' }],
        edges: [],
      },
    }),
  );
  const raw = deferred(),
    releasedInput = deferred(),
    terminal = deferred();
  const base = createInMemoryHost();
  let now = 0;
  const host: typeof base = {
    ...base,
    clock: { now: () => new Date(now).toISOString() },
    setTimer: (ms, fire, kind) => {
      const due = now + ms;
      return base.setTimer(
        ms,
        () => {
          expect(now).toBeGreaterThanOrEqual(due);
          fire();
        },
        kind,
      );
    },
  };
  const engine = new WorkflowEngine({
    host,
    executor: {
      execute: (ctx) => {
        if (ctx.continueReceipt === undefined) throw new Error('receipt transfer required');
        void ctx.continueReceipt(() => raw.promise);
        return Promise.resolve({
          kind: 'paused',
          gate: {
            gateType: 'approval',
            message: 'offline approval',
            timeoutMs: 1000,
            timeoutAction: 'reject',
          },
        });
      },
    },
  });
  const handle = engine.start({ workflow });
  const io = captureIo();
  const summaries: string[] = [];
  const listeners = new Set(process.rawListeners('beforeExit'));
  let settled = false;
  const driving = driveRun({
    engine,
    handle,
    io: io.io,
    makeRenderer: () => {
      // Use installed Ink and its actual native waitUntilExit/unmount, not an event-only renderer double.
      const renderer = createInkRenderer({
        color: false,
        writeTerminalNotice: (text) => io.io.writeErr(text),
        writeSummary: (text) => summaries.push(text),
      });
      return {
        ...renderer,
        releaseInput: async () => {
          await renderer.releaseInput?.();
          releasedInput.resolve();
        },
        onEvent: (event) => {
          renderer.onEvent(event);
          if (event.type === 'run:failed') terminal.resolve();
        },
      };
    },
  });
  void driving.then(() => {
    settled = true;
  });
  try {
    await releasedInput.promise;
    expect(process.rawListeners('beforeExit')).toEqual([...listeners]);
    now = 1000;
    host.fireTimers();
    await terminal.promise;
    await setImmediate();
    expect(io.err()).toBe('Run failed; run cleanup is pending.\n');
    expect(io.out()).toBe('');
    expect(summaries).toEqual([]);
    expect(settled).toBe(false);
    expect(await host.runLeases.read(handle.runId)).toBeDefined();
    raw.resolve();
    expect(await driving).toBe('failed');
    expect(handle.terminalError()).toBe('run_timeout');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain('run failed (run_timeout)');
    expect(io.err().match(/Run failed;/g)).toHaveLength(1);
    expect(await host.runLeases.read(handle.runId)).toBeUndefined();
    expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
  } finally {
    raw.resolve();
    await driving;
    for (const listener of process.rawListeners('beforeExit')) {
      if (!listeners.has(listener))
        Reflect.apply(process.removeListener.bind(process), process, ['beforeExit', listener]);
    }
  }
});
