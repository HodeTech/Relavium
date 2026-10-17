import { parseWorkflow } from '@relavium/core';
import { startMcpClient } from '@relavium/mcp';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowLifetime } from '../commands/workflow-lifetime.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { EgressWorkScope } from './egress-work.js';
import { connectWorkflowMcp } from './mcp-servers.js';

const reactions = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const def = parseWorkflow(`schema_version: '1.0'
workflow:
  id: late-workflow-client
  agents:
    - id: worker
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: synthetic
      mcp_servers:
        - { id: owned, transport: stdio, command: synthetic-never-spawned }
  nodes:
    - { id: start, type: input }
    - { id: end, type: output }
  edges:
    - { from: start, to: end }
`);

describe('workflow publication keeps the original MCP close budget', () => {
  it.each([0, 1])(
    'late successful manager with %s ms remaining never renews cleanup',
    async (remaining) => {
      const f = invocationFixture();
      const removeSignals = vi.fn();
      const lifetime = new WorkflowLifetime(f.invocation, captureIo().io, () => removeSignals);
      const work = new EgressWorkScope();
      const constructed = gate();
      const closed = gate();
      const close = vi.fn(() => closed.promise);
      let settled = false;
      const action = lifetime.execute(async () => {
        try {
          await connectWorkflowMcp(def, {
            cwd: '/tmp',
            consentGate: () => Promise.resolve(new Map()),
            assertAdmitting: () => lifetime.checkpoint(),
            onFailure: (cause) => lifetime.failure(cause),
            onCloseError: (_id, cause) => lifetime.cleanupFailed(cause),
            connectSignal: lifetime.signal,
            budget: f.registry.budget,
            work,
            startMcpClient: async (_configs, signal, scope, lifecycle) => {
              const client = await startMcpClient(
                [
                  {
                    id: 'owned',
                    open: () =>
                      Promise.resolve({
                        listTools: () => Promise.resolve([]),
                        callTool: () => Promise.resolve({ content: [], isError: false }),
                        close,
                      }),
                  },
                ],
                signal,
                scope,
                lifecycle,
              );
              f.invocation.finiteExit.fail('cli_internal');
              f.advance(3000 - remaining);
              constructed.release();
              return client;
            },
          });
          throw new Error('Stopped manager must never publish.');
        } finally {
          work.seal();
          await work.done;
        }
      });
      void action.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await constructed.promise;
      await reactions();
      expect(close, 'WORKFLOW_LATE_CLIENT_CANNOT_START_CLOSE_AFTER_EXPIRY').toHaveBeenCalledTimes(
        remaining === 0 ? 0 : 1,
      );
      expect(settled, 'WORKFLOW_LATE_CLIENT_CLOSE_IS_ACTUAL_ACK').toBe(false);
      expect(f.registry.activeOwners).toBeGreaterThan(0);
      expect(removeSignals).not.toHaveBeenCalled();
      expect(f.registry.budget.deadline()).toBe(3000);
      if (remaining === 0) {
        expect(await f.invocation.finiteExit.exited).toBe(9);
        closed.release(); // No close was entered; this cannot acknowledge the product obligation.
        await reactions();
        expect(settled).toBe(false);
        expect(f.registry.activeOwners).toBeGreaterThan(0);
      } else {
        expect(f.registry.budget.remainingMs()).toBe(1);
        closed.release();
        expect(await action).toBe(9);
        expect(f.registry.activeOwners).toBe(0);
        expect(removeSignals).toHaveBeenCalledOnce();
        expect(f.registry.budget.deadline()).toBe(3000);
      }
    },
  );
});
