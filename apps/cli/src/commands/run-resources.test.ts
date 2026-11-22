/**
 * The single-use contract of `RunResources` (MVP-8 step 2, round-1 fix F3).
 *
 * One owner holds one run's MCP runtime and database close. A host that reused it for a second run would
 * inherit the first run's MCP clients and close the first run's connection, so every operation that assigns
 * or releases is one-shot and a second call throws a typed internal error whose message names the misuse and
 * carries no stored text.
 */
import { describe, expect, it, vi } from 'vitest';

import { isCliError } from '../process/errors.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { RunResources } from '../run-core/run-resources.js';
import { captureIo } from '../test-support.js';
import { WorkflowLifetime } from './workflow-lifetime.js';

function owner(): RunResources {
  const f = invocationFixture();
  const { io } = captureIo();
  return new RunResources(new WorkflowLifetime(f.invocation, io, () => () => undefined), io);
}

/** The misuse is a host bug: a typed `internal` error with a fixed sentence naming the operation. */
function expectReuse(call: () => unknown, operation: string): void {
  let thrown: unknown;
  try {
    call();
  } catch (cause) {
    thrown = cause;
  }
  expect(isCliError(thrown)).toBe(true);
  if (!isCliError(thrown)) return;
  expect(thrown.code).toBe('internal');
  expect(thrown.message).toBe(
    `a RunResources was reused: its ${operation} ran twice; create one RunResources for each run`,
  );
}

async function expectReuseAsync(call: () => Promise<unknown>, operation: string): Promise<void> {
  const settled = call().then(
    () => undefined,
    (cause: unknown) => cause,
  );
  const thrown = await settled;
  expectReuse(() => {
    throw thrown;
  }, operation);
}

describe('RunResources is single-use', () => {
  it('a second MCP connection throws before its connector runs', async () => {
    const resources = owner();
    const first = vi.fn(() => Promise.resolve(undefined));
    const second = vi.fn(() => Promise.resolve(undefined));
    await resources.connectMcp(first);
    await expectReuseAsync(() => resources.connectMcp(second), 'MCP connection');
    expect(first).toHaveBeenCalledOnce();
    expect(
      second,
      'a misused owner must never spawn a child nothing will close',
    ).not.toHaveBeenCalled();
  });

  it('a second MCP connection throws even after the first connector rejected', async () => {
    const resources = owner();
    await expect(resources.connectMcp(() => Promise.reject(new Error('refused')))).rejects.toThrow(
      'refused',
    );
    const second = vi.fn(() => Promise.resolve(undefined));
    await expectReuseAsync(() => resources.connectMcp(second), 'MCP connection');
    expect(second).not.toHaveBeenCalled();
  });

  it('a second history close capture throws and keeps the first close', () => {
    const resources = owner();
    const first = vi.fn();
    const second = vi.fn();
    resources.captureHistoryClose(first);
    expectReuse(() => resources.captureHistoryClose(second), 'history close capture');
    resources.closeHistoryDb();
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it('a second MCP release throws', async () => {
    const resources = owner();
    expect(await resources.releaseMcp()).toBe(true);
    await expectReuseAsync(() => resources.releaseMcp(), 'MCP release');
  });

  it('a second history database close throws and closes once', () => {
    const resources = owner();
    const close = vi.fn();
    resources.captureHistoryClose(close);
    resources.closeHistoryDb();
    expectReuse(() => resources.closeHistoryDb(), 'history database close');
    expect(close).toHaveBeenCalledOnce();
  });

  it('a closed owner admits no new acquisition', async () => {
    const resources = owner();
    await resources.releaseMcp();
    resources.closeHistoryDb();
    await expectReuseAsync(
      () => resources.connectMcp(() => Promise.resolve(undefined)),
      'MCP connection',
    );
    expectReuse(() => resources.captureHistoryClose(() => undefined), 'history close capture');
  });

  it('the first use of every operation is not an error, with or without anything registered', async () => {
    const resources = owner();
    expect(await resources.releaseMcp()).toBe(true);
    expect(() => {
      resources.closeHistoryDb();
    }).not.toThrow();
  });

  it('the misuse message never carries a stored value', () => {
    const resources = owner();
    const sentinel = 'stored-close-SENTINEL-do-not-echo';
    const named = (): (() => void) =>
      Object.defineProperty(() => undefined, 'name', { value: sentinel });
    resources.captureHistoryClose(named());
    let message = '';
    try {
      resources.captureHistoryClose(named());
    } catch (cause) {
      message = isCliError(cause) ? cause.message : '';
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(sentinel);
  });
});
