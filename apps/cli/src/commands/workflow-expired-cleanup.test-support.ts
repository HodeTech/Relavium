import { startMcpClient } from '@relavium/mcp';
import type { DbClient } from '@relavium/db';
import { expect, vi } from 'vitest';

import { invocationFixture } from '../process/invocation.test-support.js';
import type { RunCommandDeps } from './run.js';

/** Actual manager + actual SQLite witness, shared by the three original workflow entry points. */
export function workflowFinalizerControl(remaining: number, sqlite: DbClient['sqlite']) {
  const f = invocationFixture();
  const primary = new Error(
    'synthetic engine construction failure after MCP and database acquisition',
  );
  const removeSignals = vi.fn();
  let entered: () => void = () => undefined;
  const enteredBuild = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release: () => void = () => undefined;
  const nativeClosed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const closeMcp = vi.fn(() => nativeClosed);
  const closeDatabase = vi.fn(() => {
    if (sqlite.open) sqlite.close();
  });
  const start: NonNullable<RunCommandDeps['startMcpClient']> = (
    _configs,
    signal,
    work,
    lifecycle,
  ) =>
    startMcpClient(
      [
        {
          id: 'fs',
          open: () =>
            Promise.resolve({
              listTools: () =>
                Promise.resolve([
                  {
                    name: 'read',
                    description: 'Read fixture',
                    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                  },
                ]),
              callTool: () => Promise.resolve({ content: [], isError: false }),
              close: closeMcp,
            }),
        },
      ],
      signal,
      work,
      lifecycle,
    );
  const build: NonNullable<RunCommandDeps['buildEngine']> = () => {
    f.invocation.finiteExit.fail('cli_internal');
    f.advance(3000 - remaining);
    entered();
    return Promise.reject(primary);
  };
  return {
    invocation: f.invocation,
    subscribeSignals: () => removeSignals,
    startMcpClient: start,
    buildEngine: build,
    closeDatabase,
    async verify(action: Promise<number>): Promise<void> {
      let settled = false;
      const result = action.then(
        (value) => {
          settled = true;
          return value;
        },
        (cause: unknown) => {
          settled = true;
          return cause;
        },
      );
      try {
        await enteredBuild;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(
          closeMcp,
          'WORKFLOW_FINALIZER_NEVER_STARTS_MCP_CLOSE_AFTER_EXPIRY',
        ).toHaveBeenCalledTimes(remaining === 0 ? 0 : 1);
        expect(settled, 'WORKFLOW_FINALIZER_ACK_PRECEDES_DATABASE_RELEASE').toBe(false);
        expect(closeDatabase).not.toHaveBeenCalled();
        expect(sqlite.open).toBe(true);
        expect(removeSignals).not.toHaveBeenCalled();
        expect(f.registry.activeOwners).toBeGreaterThan(0);
        expect(f.registry.budget.deadline()).toBe(3000);
        if (remaining === 0) {
          expect(await f.invocation.finiteExit.exited).toBe(9);
          release(); // An unentered close cannot acknowledge anything.
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(settled).toBe(false);
          expect(sqlite.open).toBe(true);
          expect(removeSignals).not.toHaveBeenCalled();
          expect(f.registry.activeOwners).toBeGreaterThan(0);
        } else {
          expect(f.registry.budget.remainingMs()).toBe(1);
          release();
          expect(await result).toBe(primary);
          expect(closeDatabase).toHaveBeenCalledOnce();
          expect(sqlite.open).toBe(false);
          expect(removeSignals).toHaveBeenCalledOnce();
          expect(f.registry.activeOwners).toBe(0);
          expect(f.registry.observations.exitCode()).toBe(9);
        }
        expect(f.registry.budget.deadline()).toBe(3000);
      } finally {
        release();
      }
    },
  };
}
