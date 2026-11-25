/**
 * How a report popup starts its work ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2, §5): entered on the work owner when there is one (so the session's database stays open until the read has settled), a fault going to the
 * owner and to the popup, never an unhandled rejection, and the popups' reads going through it.
 */
import { describe, expect, it, vi } from 'vitest';

import { COST_STEP } from './cost-popup.js';
import type { ReportWorkOwner } from './report-port.js';
import { faultCode, startPopupWork } from './popup-work.js';
import { CliError } from '../process/errors.js';
import {
  catalogEntry,
  fakeCost,
  fakeWorkflows,
  reportRig,
  settleWork,
} from './report.test-support.js';

/** An owner that runs what it is given and records every operation it was given. */
function countingOwner() {
  const entered: (() => Promise<unknown>)[] = [];
  const failure = vi.fn<(cause: unknown) => void>();
  const owner: ReportWorkOwner = {
    enter: <T>(operation: () => Promise<T>): Promise<T> => {
      entered.push(operation);
      return operation();
    },
    failure,
  };
  return { owner, entered, failure };
}

describe('startPopupWork', () => {
  it('enters the operation on the owner, once, and does not run it any other way', async () => {
    const { owner, entered } = countingOwner();
    let ran = 0;
    startPopupWork(
      owner,
      () => {
        ran += 1;
        return Promise.resolve();
      },
      () => undefined,
    );
    await settleWork();
    expect(entered).toHaveLength(1);
    expect(ran).toBe(1);
  });

  it('runs an operation that has no owner directly', async () => {
    let ran = 0;
    startPopupWork(
      undefined,
      () => {
        ran += 1;
        return Promise.resolve();
      },
      () => undefined,
    );
    await settleWork();
    expect(ran).toBe(1);
  });

  it('goes through an owner that does not run it: the owner decides whether and when', async () => {
    let ran = 0;
    let entries = 0;
    startPopupWork(
      {
        enter: <T>(): Promise<T> => {
          entries += 1;
          return new Promise<T>(() => undefined);
        },
        failure: vi.fn(),
      },
      () => {
        ran += 1;
        return Promise.resolve();
      },
      () => undefined,
    );
    await settleWork();
    expect(entries).toBe(1);
    expect(ran).toBe(0);
  });

  it('a fault of the operation goes to the owner and to the popup', async () => {
    const { owner, failure } = countingOwner();
    const failed = vi.fn();
    const cause = new Error('boom');
    startPopupWork(owner, () => Promise.reject(cause), failed);
    await settleWork();
    expect(failure).toHaveBeenCalledExactlyOnceWith(cause);
    expect(failed).toHaveBeenCalledExactlyOnceWith(cause);
  });

  it('an owner that no longer admits work (it throws on entry) is a fault of the same kind, never a throw to the caller', () => {
    const cause = new Error('the host is closing');
    const failure = vi.fn();
    const failed = vi.fn();
    const enter = vi.fn((): never => {
      throw cause;
    });
    expect(() => {
      startPopupWork({ enter, failure }, () => Promise.resolve(), failed);
    }).not.toThrow();
    expect(failure).toHaveBeenCalledExactlyOnceWith(cause);
    expect(failed).toHaveBeenCalledExactlyOnceWith(cause);
  });

  it('a popup handler that throws again goes to the owner too, and is not an unhandled rejection', async () => {
    const { owner, failure } = countingOwner();
    const first = new Error('read failed');
    const second = new Error('the handler threw');
    startPopupWork(
      owner,
      () => Promise.reject(first),
      () => {
        throw second;
      },
    );
    await settleWork();
    expect(failure.mock.calls).toEqual([[first], [second]]);
  });

  it('says a fault by its code, and a fault that is not ours by a fixed word', () => {
    expect(faultCode(new CliError('invalid_invocation', 'PRIVATE /tmp/x'))).toBe(
      'invalid_invocation',
    );
    expect(faultCode(new TypeError('PRIVATE /tmp/x'))).toBe('unexpected error');
    expect(faultCode('a string')).toBe('unexpected error');
  });
});

describe('the report popups read in work entered on the owner', () => {
  it('/cost: the first read, and the read that follows a release, are each entered once', async () => {
    const r = reportRig();
    const { owner, entered } = countingOwner();
    r.open(
      { cost: fakeCost({ held: 450 }).port, workOwner: owner },
      { kind: 'cost', release: false },
    );
    r.show();
    await settleWork();
    expect(entered).toHaveLength(1);
    expect(r.step()).toBe(COST_STEP.cost);
    // The answer: a release, then the total read again, entered the same way.
    r.clock.advance(600);
    r.press('r');
    r.show();
    r.clock.advance(900);
    r.press('y', { ctrl: true });
    await settleWork();
    expect(r.step()).toBe(COST_STEP.done);
    expect(entered).toHaveLength(2);
  });

  it('/workflows: the scan is entered once', async () => {
    const r = reportRig();
    const { owner, entered } = countingOwner();
    const flows = fakeWorkflows(() => ({
      kind: 'catalog',
      workflows: [catalogEntry('deploy')],
      agents: [],
    }));
    r.open({ workflows: flows.port, workOwner: owner }, { kind: 'workflows' });
    r.show();
    await settleWork();
    expect(entered).toHaveLength(1);
    expect(flows.read).toHaveBeenCalledTimes(1);
    expect(r.words()).toContain('Workflows (1):');
  });
});
