import { WorkflowEngine, createInMemoryHost, type RunHandle } from '@relavium/core';
import type { RunEvent } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';
import { captureIo } from '../test-support.js';
import { createInvocationFiniteExit } from '../process/invocation-finite-exit.js';
import { InvocationRegistry } from '../process/invocation-registry.js';
import { WorkflowLifetime } from './workflow-lifetime.js';
import { driveRun } from './drive.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('primary reader and already-available health behind held input', () => {
  it.each(['done', 'rejected'] as const)(
    '%s starts the one departure join independently of held prompt release',
    async (finish) => {
      let time = 0;
      const timers = new Set<{ at: number; fire: () => void }>();
      const clock = {
        now: () => time,
        schedule: (ms: number, fire: () => void) => {
          const timer = { at: time + ms, fire };
          timers.add(timer);
          return () => {
            timers.delete(timer);
          };
        },
      };
      const registry = new InvocationRegistry(clock);
      const physicalExit = vi.fn();
      const finiteExit = createInvocationFiniteExit(registry, clock, {
        exit: physicalExit,
        setExitCode: vi.fn(),
      });
      const invocation = { registry, finiteExit, seedFileCatalogOnce: () => Promise.resolve() };
      const captured = captureIo();
      const lifetime = new WorkflowLifetime(invocation, captured.io, () => () => undefined);
      const entered = deferred<void>();
      const decision = deferred<null>();
      const durability = vi.fn(() => 'durable' as const);
      const terminalError = vi.fn(() => undefined);
      const departed = vi.fn(() =>
        Promise.resolve({
          kind: 'closed' as const,
          moneyDurability: 'uncertain' as const,
          effectNeedsAttention: false,
        }),
      );
      const handle: RunHandle = {
        runId: 'reader-boundary',
        events: (async function* (): AsyncGenerator<RunEvent> {
          yield {
            type: 'human_gate:paused',
            runId: 'reader-boundary',
            timestamp: '2026-10-16T00:00:00Z',
            sequenceNumber: 1,
            nodeId: 'gate',
            gateId: 'held-gate',
            gateType: 'approval',
            message: 'offline',
          };
          await entered.promise;
          if (finish === 'rejected') throw new Error('PRIVATE_PRIMARY_FAILURE');
        })(),
        subscribe: () => () => undefined,
        cancel: vi.fn(),
        depart: departed,
        whenConsumersReady: () => Promise.resolve(),
        highWaterMark: 256,
        bufferedCount: 0,
        durability,
        terminalError,
      };
      const engine = new WorkflowEngine({
        host: createInMemoryHost(),
        executor: { execute: () => Promise.resolve({ kind: 'completed', output: null }) },
      });
      let finished = false;
      const pending = driveRun({
        lifetime,
        engine,
        handle,
        io: captured.io,
        makeRenderer: () => ({ onEvent: () => undefined }),
        gatePrompter: {
          prompt: () => {
            entered.resolve();
            return decision.promise;
          },
        },
      });
      void pending.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      await entered.promise;
      await turn();
      expect(departed, 'WORKFLOW_AVAILABLE_HEALTH').toHaveBeenCalledOnce();
      expect(registry.observations.exitCode()).toBe(8);
      expect(durability).toHaveBeenCalledTimes(finish === 'done' ? 1 : 0);
      expect(terminalError).toHaveBeenCalledTimes(finish === 'done' ? 1 : 0);
      expect(finished).toBe(false);
      finiteExit.signal(15);
      time = 3000;
      for (const timer of [...timers]) if (timer.at <= time && timers.delete(timer)) timer.fire();
      expect(await finiteExit.exited).toBe(8);
      expect(physicalExit).toHaveBeenCalledExactlyOnceWith(8);
      expect(registry.activeOwners).toBeGreaterThan(0);
      expect(finished).toBe(false);
      decision.resolve(null); // Late input cannot certify the rejected reader or restart terminal work.
      await turn();
      expect(departed).toHaveBeenCalledOnce();
    },
  );
});
