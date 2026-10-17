import { WorkflowEngine, createInMemoryHost, parseWorkflow } from '@relavium/core';
import { describe, expect, it, vi } from 'vitest';

import { CliError } from '../process/cli-error.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { driveRun } from './drive.js';
import { WorkflowLifetime } from './workflow-lifetime.js';

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('original driver owner observes cleanup diagnostic sink failures', () => {
  it.each(
    (['cleanup_pending', 'cleanup_failed'] as const).flatMap((diagnostic) =>
      (['known', 'opaque'] as const).map((fault) => ({ diagnostic, fault })),
    ),
  )(
    '$diagnostic with a $fault sink refusal retains actual cleanup',
    async ({ diagnostic, fault }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const f = invocationFixture();
      const captured = captureIo();
      const entered = deferred();
      const released = deferred();
      const cause =
        fault === 'known'
          ? new CliError('invalid_invocation', 'PRIVATE_DIAGNOSTIC_REFUSAL')
          : new Error('PRIVATE_DIAGNOSTIC_REFUSAL');
      const io = {
        ...captured.io,
        writeErr: () => {
          throw cause;
        },
      };
      const lifetime = new WorkflowLifetime(f.invocation, io, () => () => undefined);
      const engine = new WorkflowEngine({
        host: createInMemoryHost(),
        executor: { execute: () => Promise.resolve({ kind: 'completed', output: 'answer' }) },
      });
      const handle = engine.start({
        workflow: parseWorkflow(
          JSON.stringify({
            schema_version: '1.0',
            workflow: { id: 'diagnostic-owner', nodes: [{ id: 'work', type: 'input' }], edges: [] },
          }),
        ),
      });
      let attempts = 0;
      let settled = false;
      const driving = driveRun({
        lifetime,
        engine,
        handle,
        io,
        json: true,
        makeRenderer: () => ({
          onEvent: () => undefined,
          releaseInput: () => {
            attempts++;
            if (diagnostic === 'cleanup_failed' && attempts === 1)
              return Promise.reject(new CliError('internal', 'PRIVATE_INPUT_RELEASE_REFUSAL'));
            entered.resolve();
            return released.promise;
          },
        }),
      }).then(
        (outcome) => {
          settled = true;
          return outcome;
        },
        (failure: unknown) => {
          settled = true;
          return failure;
        },
      );
      try {
        await entered.promise;
        if (diagnostic === 'cleanup_pending') await vi.advanceTimersByTimeAsync(250);
        expect(
          f.registry.observations.infrastructureCode(),
          'DIAGNOSTIC_SINK_FAILURE_OWNS_OUTPUT_REFUSAL',
        ).toBe('output_unavailable');
        expect(f.registry.observations.exitCode()).toBe(9);
        expect(f.registry.budget.deadline()).toBe(3000);
        expect(settled, 'DIAGNOSTIC_SINK_FAILURE_IS_NOT_INPUT_CLOSE_ACK').toBe(false);
        expect(f.registry.activeOwners).toBe(2);
        expect(captured.out() + captured.err()).not.toContain('PRIVATE_');
        released.resolve();
        const result = await driving;
        if (diagnostic === 'cleanup_failed') expect(result).toMatchObject({ code: 'internal' });
        else expect(result).toBe('completed');
        await lifetime.finish();
        expect(f.registry.activeOwners).toBe(0);
        expect(f.registry.observations.exitCode()).toBe(9);
      } finally {
        released.resolve();
        await driving;
        await lifetime.finish();
        vi.useRealTimers();
      }
    },
  );
});
