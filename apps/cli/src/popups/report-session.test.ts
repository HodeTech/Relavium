/**
 * The four report popups' opener ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1,
 * §6, §10): a report opens only where the port holds its own member, each line opens its own popup, a refused open is the host's answer
 * passed on whole (and starts no work), a view that cannot be made opens as a state and not as a throw, and the work waits for the event loop
 * unless a test says otherwise.
 */
import { describe, expect, it, vi } from 'vitest';

import { boundAgentView } from '../chat/bound-agent-view.js';
import { openReportPopup } from './report-session.js';
import type { ReportKind, ReportsPort } from './report-port.js';
import {
  catalogEntry,
  fakeCost,
  fakeWorkflows,
  reportRig,
  settleWork,
} from './report.test-support.js';

const KINDS = ['agent', 'cost', 'workflows', 'help'] as const satisfies readonly ReportKind[];

/** Every member a chat host can wire, each one its own and counted where it reads. */
function members() {
  const cost = fakeCost({ held: 450 });
  const workflows = fakeWorkflows(() => ({
    kind: 'catalog',
    workflows: [catalogEntry('deploy')],
    agents: [],
  }));
  const agent = vi.fn(() =>
    boundAgentView(
      {
        id: 'reviewer',
        name: 'Code reviewer',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        system_prompt: 'You review code.',
        tools: ['read_file'],
      },
      'high',
    ),
  );
  const all: Pick<ReportsPort, ReportKind> = {
    agent,
    cost: cost.port,
    workflows: workflows.port,
    help: { keys: [] },
  };
  return { all, cost, workflows, agent };
}

const lineOf = (kind: ReportKind) => (kind === 'cost' ? { kind, release: false } : { kind });

describe('a report opens only where the port holds its own member', () => {
  it.each(KINDS)(
    '%s: a port that holds every other member opens nothing, and the open says closed',
    (kind) => {
      const r = reportRig();
      const { all } = members();
      // Every member but this report's own.
      const others = Object.fromEntries(Object.entries(all).filter(([name]) => name !== kind));
      const result = r.open(others, lineOf(kind));
      expect(result).toEqual({ opened: false, reason: 'closed' });
      expect(r.host.getSnapshot().open).toBe(false);
      // A wiring mistake, never reachable from a typed line: the host says nothing about it either.
      expect(r.notifications.getSnapshot().current).toBeUndefined();
    },
  );

  it.each(KINDS)(
    '%s: a port that holds only its own member opens the popup of that name',
    (kind) => {
      const r = reportRig();
      const { all } = members();
      const result = r.open({ [kind]: all[kind] }, lineOf(kind));
      expect(result.opened).toBe(true);
      expect(r.host.getSnapshot().frame?.spec.id).toBe(kind);
    },
  );
});

describe('a refused open is the host’s answer, passed on as it is, and starts nothing', () => {
  it.each(KINDS)('%s: a gate that says a turn is running', async (kind) => {
    const r = reportRig();
    r.host.bindOpenGate(() => 'turn-running');
    const { all, cost, workflows } = members();
    const entered = vi.fn();
    const failure = vi.fn();
    const result = r.open(
      {
        ...all,
        workOwner: {
          enter: <T>(operation: () => Promise<T>): Promise<T> => {
            entered();
            return operation();
          },
          failure,
        },
      },
      lineOf(kind),
    );
    expect(result).toEqual({ opened: false, reason: 'turn-running' });
    expect(r.host.getSnapshot().open).toBe(false);
    // The host said so, once.
    expect(r.notifications.getSnapshot().current?.text).toContain('/' + kind);
    expect(r.notifications.getSnapshot().queued).toBe(0);
    // No work was entered or read for a popup that did not open, and nothing failed for it.
    await settleWork();
    expect(entered).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(cost.read).not.toHaveBeenCalled();
    expect(workflows.read).not.toHaveBeenCalled();
  });

  it.each(KINDS)('%s: another popup that is already open', (kind) => {
    const r = reportRig();
    const { all } = members();
    expect(r.open(all, lineOf('help')).opened).toBe(true);
    expect(r.open(all, lineOf(kind))).toEqual({ opened: false, reason: 'popup-open' });
    expect(r.host.getSnapshot().frame?.spec.id).toBe('help');
  });
});

describe('/agent: a view that cannot be made', () => {
  it('opens the popup saying so, tells the owner, and does not throw', () => {
    const r = reportRig();
    const cause = new TypeError('the view cannot be made');
    const failure = vi.fn();
    const result = r.open(
      {
        agent: () => {
          throw cause;
        },
        workOwner: { enter: <T>(operation: () => Promise<T>) => operation(), failure },
      },
      { kind: 'agent' },
    );
    expect(result.opened).toBe(true);
    expect(r.content().kind).toBe('error');
    expect(r.words()).toContain('The agent could not be shown.');
    expect(failure).toHaveBeenCalledExactlyOnceWith(cause);
  });
});

describe('the work waits for the event loop unless it is told how', () => {
  /** One turn of the event loop: what a `setImmediate` started earlier has run by the time this resolves. */
  const turnOfTheLoop = (): Promise<void> =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

  it('/workflows and /cost read after a macrotask by default, never in the same turn that opened them', async () => {
    const r = reportRig();
    const { all, cost, workflows } = members();
    for (const kind of ['workflows', 'cost'] as const) {
      const result = openReportPopup({
        host: r.host,
        port: { surface: 'standalone-chat', ...all },
        line: lineOf(kind),
        origin: 'chat',
        turnInFlight: () => false,
      });
      expect(result.opened).toBe(true);
      // Microtasks alone do not reach the read: it waits for the loop to give the frame back.
      for (let hop = 0; hop < 50; hop += 1) await Promise.resolve();
      const read = kind === 'cost' ? cost.read : workflows.read;
      expect(read, kind).not.toHaveBeenCalled();
      await turnOfTheLoop();
      await settleWork();
      expect(read, kind).toHaveBeenCalledOnce();
      r.host.closeAll('command');
    }
  });
});
