import { describe, expect, it, vi } from 'vitest';

import { McpError } from './errors.js';
import type { McpConnection } from './connection.js';
import { startMcpClient, type McpServerConfig } from './manager.js';
import { McpWorkScope } from './work-scope.js';

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const reactions = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('successful close reporters observe faults before sibling joins', () => {
  it.each(['synchronous', 'rejected'])(
    'reports a %s close fault promptly and retains the reentrant shared join',
    async (mode) => {
      const fault = new Error('synthetic connection close failure');
      const held = gate();
      const manager = await startMcpClient([
        server('bad', () => {
          if (mode === 'synchronous') throw fault;
          return Promise.reject(fault);
        }),
        server('held', () => held.promise),
      ]);
      const reentries: Promise<void>[] = [];
      const report = vi.fn(() => {
        reentries.push(manager.close(report));
      });
      let settled = false;
      const closing = manager.close(report).then(() => {
        settled = true;
      });
      await reactions();
      expect(
        report,
        'MCP_SUCCESSFUL_CLOSE_REPORT_BEFORE_HELD_SIBLING',
      ).toHaveBeenCalledExactlyOnceWith('bad', fault);
      expect(settled, 'MCP_SUCCESSFUL_CLOSE_REPORT_IS_NOT_ACK').toBe(false);
      held.release();
      await Promise.all([closing, ...reentries]);
      expect(settled).toBe(true);
      expect(report).toHaveBeenCalledOnce();
    },
  );

  it('replays retained faults immediately to a reporter attaching while another close is held', async () => {
    const fault = new Error('synthetic earlier close failure');
    const held = gate();
    const manager = await startMcpClient([
      server('bad', () => Promise.reject(fault)),
      server('held', () => held.promise),
    ]);
    const first = manager.close();
    await reactions();
    const report = vi.fn();
    const late = manager.close(report);
    const repeated = manager.close(report);
    expect(
      report,
      'MCP_SUCCESSFUL_CLOSE_LATE_REPORT_BEFORE_HELD_SIBLING',
    ).toHaveBeenCalledExactlyOnceWith('bad', fault);
    held.release();
    await Promise.all([first, late, repeated]);
    await manager.close(report);
    expect(report).toHaveBeenCalledOnce();
  });

  it('joins every entered close despite a reporter exception and preserves that exception', async () => {
    const fault = new Error('synthetic connection close failure');
    const observerFault = new Error('synthetic observer failure');
    const held = gate();
    const otherClose = vi.fn(() => held.promise);
    const manager = await startMcpClient([
      server('bad', () => Promise.reject(fault)),
      server('held', otherClose),
    ]);
    const report = vi.fn(() => {
      throw observerFault;
    });
    let rejected = false;
    const closing = manager.close(report);
    void closing.catch(() => {
      rejected = true;
    });
    const healthy = vi.fn();
    const other = manager.close(healthy);
    await reactions();
    expect(report).toHaveBeenCalledExactlyOnceWith('bad', fault);
    expect(healthy).toHaveBeenCalledExactlyOnceWith('bad', fault);
    expect(otherClose).toHaveBeenCalledOnce();
    expect(rejected, 'MCP_REPORTER_FAILURE_DOES_NOT_SKIP_RAW_CLOSE_JOIN').toBe(false);
    held.release();
    await expect(closing).rejects.toBe(observerFault);
    await other;
    await expect(manager.close(report)).rejects.toBe(observerFault);
    expect(report).toHaveBeenCalledOnce();
    await expect(manager.close()).resolves.toBeUndefined();
  });
});

describe('successful manager cleanup keeps its original live budget at transport entry', () => {
  it.each([false, true])(
    'rechecks the deferred close boundary (queued expiry=%s)',
    async (expire) => {
      let remaining = 1;
      const closed = gate();
      const close = vi.fn(() => closed.promise);
      const manager = await startMcpClient([server('one', close)], undefined, undefined, {
        budget: { remainingMs: () => remaining },
      });
      if (expire)
        queueMicrotask(() => {
          remaining = 0;
        });
      let settled = false;
      const closing = manager.close().then(() => {
        settled = true;
      });
      await reactions();
      expect(close, 'MCP_SUCCESSFUL_MANAGER_RECHECKS_DEFERRED_CLOSE_BUDGET').toHaveBeenCalledTimes(
        expire ? 0 : 1,
      );
      expect(settled).toBe(false);
      closed.release();
      if (expire) {
        await reactions();
        expect(settled, 'MCP_SUCCESSFUL_MANAGER_EXPIRY_IS_NOT_ACK').toBe(false);
      } else {
        await closing;
        expect(settled).toBe(true);
      }
    },
  );

  it('rechecks every successful connection when an earlier close consumes the last budget', async () => {
    let remaining = 1;
    const first = vi.fn(() => {
      remaining = 0;
      return Promise.resolve();
    });
    const second = vi.fn(() => Promise.resolve());
    const manager = await startMcpClient(
      [server('one', first), server('two', second)],
      undefined,
      undefined,
      {
        budget: { remainingMs: () => remaining },
      },
    );
    let settled = false;
    void manager.close().then(() => {
      settled = true;
    });
    await reactions();
    expect(first).toHaveBeenCalledOnce();
    expect(second, 'MCP_SUCCESSFUL_MANAGER_RECHECKS_EACH_TRANSPORT_CLOSE').not.toHaveBeenCalled();
    expect(settled).toBe(false);
  });

  it('keeps successful-client reporters distinct from failed-start lifecycle observers', async () => {
    const failure = new Error('synthetic transport close failure');
    const report = vi.fn();
    const manager = await startMcpClient(
      [server('one', () => Promise.reject(failure))],
      undefined,
      undefined,
      {
        onCloseError: report,
        budget: { remainingMs: () => 1 },
      },
    );
    await manager.close(report);
    expect(
      report,
      'MCP_SUCCESSFUL_CLOSE_REPORTER_IS_NOT_DELIVERED_TWICE',
    ).toHaveBeenCalledExactlyOnceWith('one', failure);
    await manager.close(report);
    expect(report).toHaveBeenCalledOnce();
    const late = vi.fn();
    await manager.close(late);
    expect(late).toHaveBeenCalledExactlyOnceWith('one', failure);
  });
});

function server(
  id: string,
  close: McpConnection['close'],
  discoveryFailure?: McpError,
): McpServerConfig {
  return {
    id,
    open: () =>
      Promise.resolve({
        listTools: () =>
          discoveryFailure === undefined ? Promise.resolve([]) : Promise.reject(discoveryFailure),
        callTool: () => Promise.resolve({ content: [], isError: false }),
        close,
      }),
  };
}

describe('failed-start cleanup has independent actual lifetime and prompt failure observation', () => {
  it.each([true, false])(
    'preserves the typed startup refusal and reports actual close failure only when present (failed=%s)',
    async (failed) => {
      const primary = new McpError('synthetic discovery refusal');
      const cleanup = new Error('PRIVATE_CLOSE_FAILURE');
      const close = vi.fn(() => (failed ? Promise.reject(cleanup) : Promise.resolve()));
      const report = vi.fn();
      const work = new McpWorkScope();
      await expect(
        startMcpClient([server('one', close, primary)], undefined, work, { onCloseError: report }),
      ).rejects.toBe(primary);
      work.seal();
      await work.done;
      expect(close).toHaveBeenCalledOnce();
      if (failed)
        expect(
          report,
          'MCP_FAILED_START_CLOSE_FAILURE_IS_OBSERVED',
        ).toHaveBeenCalledExactlyOnceWith('one', cleanup);
      else expect(report).not.toHaveBeenCalled();
    },
  );

  it('reports one failed close before a different connection actually finishes cleanup', async () => {
    const primary = new McpError('synthetic discovery refusal');
    const failedClose = new Error('PRIVATE_CLOSE_FAILURE');
    const other = gate();
    const report = vi.fn();
    const work = new McpWorkScope();
    let settled = false;
    const opening = startMcpClient(
      [
        server('one', () => Promise.reject(failedClose), primary),
        server('two', () => other.promise),
      ],
      undefined,
      work,
      { onCloseError: report },
    );
    const result = opening.catch((cause: unknown) => {
      settled = true;
      return cause;
    });
    work.seal();
    await reactions();
    expect(report, 'MCP_FAILED_START_REPORT_BEFORE_HELD_SIBLING').toHaveBeenCalledExactlyOnceWith(
      'one',
      failedClose,
    );
    expect(settled).toBe(false);
    expect(work.isComplete).toBe(false);
    other.release();
    expect(await result).toBe(primary);
    await work.done;
  });

  it('surfaces a throwing observer promptly and still retains every exact entered sibling close', async () => {
    const primary = new McpError('synthetic discovery refusal');
    const callbackFault = new Error('PRIVATE_REPORTER_FAILURE');
    const other = gate();
    const closedOther = vi.fn(() => other.promise);
    const work = new McpWorkScope();
    const opening = startMcpClient(
      [
        server('one', () => Promise.reject(new Error('PRIVATE_CLOSE_FAILURE')), primary),
        server('two', closedOther),
      ],
      undefined,
      work,
      {
        onCloseError: () => {
          throw callbackFault;
        },
      },
    );
    work.seal();
    const failure: unknown = await opening.catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      message: 'MCP startup cleanup observation failed.',
      cause: { primary, observer: callbackFault },
    });
    expect(failure).not.toBeInstanceOf(McpError);
    expect(closedOther).toHaveBeenCalledOnce();
    expect(work.isComplete, 'MCP_REPORTER_FAILURE_RETAINS_RAW_CLEANUP').toBe(false);
    other.release();
    await work.done;
  });

  it('never enters a new async close at zero common budget or acknowledges expiry as cleanup', async () => {
    const close = vi.fn(() => Promise.resolve());
    const work = new McpWorkScope();
    let settled = false;
    void startMcpClient(
      [server('one', close, new McpError('synthetic discovery refusal'))],
      undefined,
      work,
      { budget: { remainingMs: () => 0 } },
    ).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    work.seal();
    await reactions();
    expect(close, 'MCP_FAILED_START_NO_NEW_CLOSE_AFTER_EXPIRY').not.toHaveBeenCalled();
    expect(settled).toBe(false);
    expect(work.isComplete).toBe(false);
  });

  it('rechecks expiry for each close when an earlier synchronous close fault exhausts the budget', async () => {
    let remaining = 1;
    const first = vi.fn(() => {
      throw new Error('PRIVATE_SYNCHRONOUS_CLOSE_FAILURE');
    });
    const second = vi.fn(() => Promise.resolve());
    const work = new McpWorkScope();
    const report = vi.fn(() => {
      remaining = 0;
    });
    void startMcpClient(
      [server('one', first, new McpError('synthetic discovery refusal')), server('two', second)],
      undefined,
      work,
      { onCloseError: report, budget: { remainingMs: () => remaining } },
    ).catch(() => undefined);
    work.seal();
    await reactions();
    expect(first).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    expect(second, 'MCP_FAILED_START_RECHECKS_EACH_CLOSE_BUDGET').not.toHaveBeenCalled();
    expect(work.isComplete).toBe(false);
  });

  it('a faulty budget port is infrastructure failure and leaves all unknown cleanup owed', async () => {
    const primary = new McpError('synthetic discovery refusal');
    const close = vi.fn(() => Promise.resolve());
    const budgetFailure = new Error('PRIVATE_BUDGET_FAILURE');
    const work = new McpWorkScope();
    const opening = startMcpClient([server('one', close, primary)], undefined, work, {
      budget: {
        remainingMs: () => {
          throw budgetFailure;
        },
      },
    });
    work.seal();
    await expect(opening).rejects.toMatchObject({
      message: 'MCP startup cleanup observation failed.',
      cause: { primary, observer: budgetFailure },
    });
    expect(close).not.toHaveBeenCalled();
    expect(work.isComplete).toBe(false);
  });
});
