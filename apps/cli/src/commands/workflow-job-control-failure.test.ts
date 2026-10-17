import { WorkflowEngine, createInMemoryHost, parseWorkflow } from '@relavium/core';
import { describe, expect, it, vi } from 'vitest';

import { CliError } from '../process/cli-error.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { defaultJobControlLifecycle } from '../render/suspend.js';
import { captureIo } from '../test-support.js';
import { driveRun, outcomeToExitCode } from './drive.js';
import { WorkflowLifetime } from './workflow-lifetime.js';

describe('original workflow owner observes caught native self-stop faults', () => {
  it.each(['healthy', 'known', 'unexpected'] as const)('%s self-stop', async (mode) => {
    const f = invocationFixture();
    const captured = captureIo();
    const io = { ...captured.io, stdoutIsTty: true, stdinIsTty: true };
    const lifetime = new WorkflowLifetime(f.invocation, io, () => () => undefined);
    const observed = vi.spyOn(lifetime, 'failure');
    const cause =
      mode === 'known'
        ? new CliError('invalid_invocation', '')
        : new TypeError('PRIVATE_WORKFLOW_SELF_STOP_FAULT');
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: {
        execute: () => Promise.resolve({ kind: 'completed', output: 'answer' }),
      },
    });
    const handle = engine.start({
      workflow: parseWorkflow(
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'job-control-owner',
            nodes: [{ id: 'work', type: 'input' }],
            edges: [],
          },
        }),
      ),
    });
    let suspend = (): void => {
      throw new Error('The driver must register job control before constructing its renderer.');
    };
    let registrations = 0;
    let suspendRemovals = 0;
    let continueRemovals = 0;
    let paints = 0;
    const supported = Object.getOwnPropertyDescriptor(defaultJobControlLifecycle, 'supported');
    if (supported === undefined) throw new Error('Missing native lifecycle descriptor.');
    // Exercise the same POSIX lifecycle on every test platform without installing real signals.
    Object.defineProperty(defaultJobControlLifecycle, 'supported', { ...supported, value: true });
    const onSuspend = vi
      .spyOn(defaultJobControlLifecycle, 'onSuspend')
      .mockImplementation((callback) => {
        registrations += 1;
        suspend = callback;
        return () => {
          suspendRemovals += 1;
        };
      });
    const onContinue = vi
      .spyOn(defaultJobControlLifecycle, 'onContinue')
      .mockImplementation(() => () => {
        continueRemovals += 1;
      });
    const selfStop = vi.spyOn(defaultJobControlLifecycle, 'suspendSelf').mockImplementation(() => {
      if (mode !== 'healthy') throw cause;
    });
    try {
      const result = await lifetime.execute(async () =>
        outcomeToExitCode(
          await driveRun({
            engine,
            handle,
            lifetime,
            io,
            makeRenderer: () => {
              suspend();
              return {
                onEvent: () => {
                  paints += 1;
                },
                releaseInput: () => Promise.resolve(),
              };
            },
          }),
        ),
      );
      expect(result, 'WORKFLOW_CAUGHT_SELF_STOP_ORIGINAL_OWNER').toBe(
        mode === 'unexpected' ? 9 : 0,
      );
      expect(f.registry.observations.exitCode()).toBe(mode === 'unexpected' ? 9 : 0);
      expect(f.registry.termination !== undefined).toBe(mode === 'unexpected');
      if (mode === 'unexpected') {
        expect(observed).toHaveBeenCalledExactlyOnceWith(cause);
        expect(paints, 'No business rendering after original-owner failure').toBe(0);
        expect(registrations, 'Stopped recovery cannot reattach a new listener').toBe(1);
      } else {
        expect(observed).not.toHaveBeenCalled();
        expect(paints).toBeGreaterThan(0);
        expect(registrations).toBe(mode === 'known' ? 2 : 1);
      }
      expect(selfStop).toHaveBeenCalledTimes(1);
      expect(suspendRemovals).toBe(registrations);
      expect(continueRemovals).toBe(1);
      expect(f.registry.activeOwners, 'Only actual native and primary ACKs retire owners').toBe(0);
      expect(captured.out() + captured.err()).not.toContain('PRIVATE_WORKFLOW_SELF_STOP_FAULT');
    } finally {
      onSuspend.mockRestore();
      onContinue.mockRestore();
      selfStop.mockRestore();
      observed.mockRestore();
      Object.defineProperty(defaultJobControlLifecycle, 'supported', supported);
    }
  });
});
