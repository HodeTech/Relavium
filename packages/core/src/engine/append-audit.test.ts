import { isAppendConflictError, type RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { createAppendAudit, formatAppendAudit } from './append-audit.js';
import { InMemoryRunStore } from './execution-host.js';

const TS = '2026-01-01T00:00:00.000Z';

const started = (seq = 0, runId = 'r1'): RunEvent => ({
  type: 'run:started',
  runId,
  sequenceNumber: seq,
  timestamp: TS,
  workflowId: '00000000-0000-4000-8000-000000000001',
  inputs: {},
  executionMode: 'local',
});

const completedNode = (seq: number, nodeId = 'n', runId = 'r1'): RunEvent => ({
  type: 'node:completed',
  runId,
  sequenceNumber: seq,
  timestamp: TS,
  nodeId,
  output: {},
  tokensUsed: { input: 0, output: 0 },
  durationMs: 1,
});

/**
 * A DUAL event correlated to a session rather than a run — `runId` absent, `sessionId` present. These are the
 * only events that can reach `persistEvent` with no `runId` (`cost:updated` is one of the `dualBase` members),
 * and `InMemoryRunStore` drops them because session persistence is `session_messages`, not the run store.
 */
const sessionCost = (seq: number): RunEvent => ({
  type: 'cost:updated',
  sessionId: 's1',
  sequenceNumber: seq,
  timestamp: TS,
  nodeId: 'chat',
  model: 'claude-opus-4-8',
  inputTokens: 1,
  outputTokens: 1,
  costMicrocents: 1,
  cumulativeCostMicrocents: 1,
});

describe('createAppendAudit', () => {
  it('HOLDS for an in-order, fully committed log', async () => {
    const audit = createAppendAudit(new InMemoryRunStore());
    await audit.store.persistEvent(started(0));
    await audit.store.persistEvent(completedNode(1));
    await audit.store.persistEvent(completedNode(2));

    const verdict = audit.verdict('r1');
    expect(verdict.holds, formatAppendAudit(verdict)).toBe(true);
    expect(verdict.asked).toEqual([0, 1, 2]);
    expect(verdict.committed).toEqual([0, 1, 2]);
  });

  it('HOLDS when the TAIL is cut — a crash truncates, it does not hole', async () => {
    // The distinction the whole harness is for. asked=[0,1,2] committed=[0,1] is exactly what a process
    // killed mid-write leaves behind, and it is a legitimate prefix: every reader stops at 1 and nothing
    // downstream believes 2 happened.
    const audit = createAppendAudit(new InMemoryRunStore(), {
      fault: (event) => (event.sequenceNumber === 2 ? new Error('killed') : 'commit'),
    });
    await audit.store.persistEvent(started(0));
    await audit.store.persistEvent(completedNode(1));
    await expect(audit.store.persistEvent(completedNode(2))).rejects.toThrow('killed');

    const verdict = audit.verdict('r1');
    expect(verdict.holds, formatAppendAudit(verdict)).toBe(true);
    expect(verdict.committed).toEqual([0, 1]);
  });

  it('catches a HOLE — a later event committed while an earlier one did not', async () => {
    // THE defect CR-10 exists to remove. A reader of this log cannot distinguish the missing 1 from a
    // streamed event that was never meant to persist, so it seeds node `a` as pending and re-runs it.
    const audit = createAppendAudit(new InMemoryRunStore(), {
      fault: (event) => (event.sequenceNumber === 1 ? new Error('slow write lost') : 'commit'),
    });
    await audit.store.persistEvent(started(0));
    await expect(audit.store.persistEvent(completedNode(1, 'a'))).rejects.toThrow();
    await audit.store.persistEvent(completedNode(2, 'b'));

    const verdict = audit.verdict('r1');
    expect(verdict.holds).toBe(false);
    expect(verdict.holes).toEqual([2]);
    expect(verdict.problems[0]).toContain('not a PREFIX');
    expect(formatAppendAudit(verdict)).toContain('VIOLATED');
  });

  it('catches an out-of-order ASK even when every commit lands in order', async () => {
    // The half a synchronous store hides, and the reason ask order is a separate predicate: `better-sqlite3`
    // commits inside the same synchronous block, so an engine that STARTS its writes concurrently still
    // produces a perfectly ordered commit list. Pre-CR-10 that is the actual state of the engine.
    const audit = createAppendAudit(new InMemoryRunStore());
    await audit.store.persistEvent(started(0));
    await audit.store.persistEvent(completedNode(2, 'b'));
    await audit.store.persistEvent(completedNode(1, 'a'));

    const verdict = audit.verdict('r1');
    expect(verdict.holds).toBe(false);
    expect(verdict.askOrderViolations).toHaveLength(1);
    expect(verdict.problems.some((p) => p.includes('ISSUED appends out of sequence order'))).toBe(
      true,
    );
    // …and it is NOT reported as a hole: every asked event committed.
    expect(verdict.holes).toEqual([]);
  });

  it('catches an out-of-order COMMIT', async () => {
    // A genuinely async store: the asks go out in order, the writes resolve out of order.
    const inner = new InMemoryRunStore();
    let releaseFirst: (() => void) | undefined;
    const gated = {
      resolveWorkflowId: (slug: string) => inner.resolveWorkflowId(slug),
      listInterruptedRuns: () => inner.listInterruptedRuns(),
      persistEvent: async (event: RunEvent): Promise<void> => {
        if (event.sequenceNumber === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        await inner.persistEvent(event);
      },
    };
    const audit = createAppendAudit(gated);

    const first = audit.store.persistEvent(completedNode(1, 'a'));
    await Promise.resolve();
    await audit.store.persistEvent(completedNode(2, 'b'));
    releaseFirst?.();
    await first;

    const verdict = audit.verdict('r1');
    expect(verdict.holds).toBe(false);
    expect(verdict.commitOrderViolations).toHaveLength(1);
    expect(verdict.committed).toEqual([2, 1]);
  });

  it('scopes per RUN — one run`s hole is not another run`s problem', async () => {
    const audit = createAppendAudit(new InMemoryRunStore(), {
      fault: (event) =>
        event.runId === 'r2' && event.sequenceNumber === 1 ? new Error('x') : 'commit',
    });
    await audit.store.persistEvent(started(0, 'r1'));
    await audit.store.persistEvent(completedNode(1, 'a', 'r1'));
    await audit.store.persistEvent(started(0, 'r2'));
    await expect(audit.store.persistEvent(completedNode(1, 'a', 'r2'))).rejects.toThrow();
    await audit.store.persistEvent(completedNode(2, 'b', 'r2'));

    expect(audit.verdict('r1').holds).toBe(true);
    expect(audit.verdict('r2').holds).toBe(false);
    expect(audit.runIds()).toEqual(['r1', 'r2']);
  });

  it('ignores a DUAL event correlated to a session, not a run — it is out of the run store`s scope', async () => {
    // `InMemoryRunStore` drops these; recording them would put a session-only event into a run's ask list
    // and manufacture a hole out of an event the run store was never responsible for.
    const audit = createAppendAudit(new InMemoryRunStore());
    await audit.store.persistEvent(started(0));
    await audit.store.persistEvent(sessionCost(1));
    await audit.store.persistEvent(completedNode(2));

    const verdict = audit.verdict('r1');
    expect(verdict.holds, formatAppendAudit(verdict)).toBe(true);
    expect(verdict.asked).toEqual([0, 2]);
    // These two are what observe the GUARD; the two above observe the per-run filter and pass with the guard
    // deleted. Measured: without them this test survived removing the very branch its title names.
    expect(audit.records()).toHaveLength(2);
    expect(audit.runIds()).toEqual(['r1']);
  });

  it('is EMPTY-safe — a run with no asks holds vacuously and reports nothing', async () => {
    const audit = createAppendAudit(new InMemoryRunStore());
    await Promise.resolve();
    const verdict = audit.verdict('never-seen');
    expect(verdict.holds).toBe(true);
    expect(verdict.asked).toEqual([]);
    expect(verdict.problems).toEqual([]);
  });

  it('records the outcome of every ask, including the rejected one', async () => {
    const audit = createAppendAudit(new InMemoryRunStore(), {
      fault: (event) => (event.sequenceNumber === 1 ? new Error('nope') : 'commit'),
    });
    await audit.store.persistEvent(started(0));
    await expect(audit.store.persistEvent(completedNode(1))).rejects.toThrow();

    expect(audit.records().map((r) => r.outcome)).toEqual(['committed', 'rejected']);
    expect(audit.records().map((r) => r.commitIndex)).toEqual([0, undefined]);
  });

  it('surfaces an INNER store rejection as a rejected ask, not a silent commit', async () => {
    // The fault hook is the test's own injection point; a real store can also throw on its own. Both must
    // land in the same record, or the harness would report a hole the store caused as a clean prefix.
    const inner = new InMemoryRunStore();
    const failing = {
      resolveWorkflowId: (slug: string) => inner.resolveWorkflowId(slug),
      listInterruptedRuns: () => inner.listInterruptedRuns(),
      persistEvent: (event: RunEvent): Promise<void> =>
        event.sequenceNumber === 1
          ? Promise.reject(new Error('disk full'))
          : inner.persistEvent(event),
    };
    const audit = createAppendAudit(failing);
    await audit.store.persistEvent(started(0));
    await expect(audit.store.persistEvent(completedNode(1))).rejects.toThrow('disk full');
    await audit.store.persistEvent(completedNode(2));

    const verdict = audit.verdict('r1');
    expect(verdict.holds).toBe(false);
    expect(verdict.holes).toEqual([2]);
    // THE assertion the title promises, and the one that was missing: `holds`/`holes` above are computed from
    // the same `outcome === 'committed'` filter and read identically whether the inner rejection was recorded
    // as `rejected` or dropped on the floor. This is what distinguishes the two.
    expect(audit.records().map((r) => r.outcome)).toEqual(['committed', 'rejected', 'committed']);
  });

  // --- the OVERLAP predicate: the ordered append itself ---------------------------------------------

  it('catches OVERLAPPING asks — the pre-CR-10 concurrent start, which no other predicate sees', async () => {
    // The engine today assigns the sequence number and starts the persist with NO await between them, so its
    // asks go out in perfect sequence order and commit in order on a synchronous store. Measured: prefix,
    // ask-order and commit-order ALL verdict HOLDS against that shape. Without this predicate, CR-10's own
    // acceptance clause — "break-verify by restoring the concurrent start" — would go green.
    // A SYNCHRONOUS store — `InMemoryRunStore`, and `better-sqlite3` behaves the same way — so the commits
    // land in ask order and the commit-order predicate stays silent. That is the case that matters: ADR-0078
    // measured out-of-order commit as unreachable on the CLI's own store, so the ONLY thing left to catch the
    // concurrent start is the overlap. (Against an ASYNC store an overlap also perturbs commit order, which
    // is why this fixture is deliberately the harder one.)
    const audit = createAppendAudit(new InMemoryRunStore());

    // Both asks issued before either settles — exactly what `#emitDurable` does today.
    const first = audit.store.persistEvent(started(0));
    const second = audit.store.persistEvent(completedNode(1));
    await Promise.all([first, second]);

    const verdict = audit.verdict('r1');
    expect(verdict.holds).toBe(false);
    expect(verdict.overlapViolations).toHaveLength(1);
    expect(verdict.problems.some((p) => p.includes('did not WAIT'))).toBe(true);
    // …and every OTHER predicate is silent, which is the whole point.
    expect(verdict.holes).toEqual([]);
    expect(verdict.askOrderViolations).toEqual([]);
    expect(verdict.commitOrderViolations).toEqual([]);
    expect(verdict.committed).toEqual([0, 1]);
  });

  it('an ORDERED append holds — each ask issued only after the previous settled', async () => {
    // The post-CR-10 shape. Same store, same events; only the engine's waiting changes.
    const audit = createAppendAudit(new InMemoryRunStore());
    await audit.store.persistEvent(started(0));
    await audit.store.persistEvent(completedNode(1));

    const verdict = audit.verdict('r1');
    expect(verdict.holds, formatAppendAudit(verdict)).toBe(true);
    expect(verdict.overlapViolations).toEqual([]);
    expect(audit.records().map((r) => r.overlappedWith)).toEqual([[], []]);
  });

  it('a fault that THROWS instead of returning still settles the record — it must not orphan it', async () => {
    // `AppendFault` is typed to RETURN an Error, but a store double that throws is the obvious way to write
    // one and `better-sqlite3` throws synchronously for real. With the hook outside the try/catch the entry
    // was orphaned at `pending` forever, and every LATER ask on that run then read it as in-flight — so the
    // overlap predicate reported a false violation on a perfectly ordered engine. The instrument would have
    // failed the very implementation it exists to certify.
    const audit = createAppendAudit(new InMemoryRunStore(), {
      fault: (event) => {
        if (event.sequenceNumber === 0) throw new Error('sync boom');
        return 'commit';
      },
    });
    await expect(audit.store.persistEvent(started(0))).rejects.toThrow('sync boom');
    await audit.store.persistEvent(completedNode(1));

    expect(audit.records().map((r) => r.outcome)).toEqual(['rejected', 'committed']);
    // THE assertion: the second ask saw nothing in flight. Without the fix this is `[0]`.
    expect(audit.records()[1]?.overlappedWith).toEqual([]);
    expect(audit.verdict('r1').overlapViolations).toEqual([]);
  });

  it('FORWARDS the durable-write context — a decorator that drops it disables the guard it audits', async () => {
    // The defect this closes was live: the decorator re-spelled `persistEvent`'s signature by hand, so when
    // ADR-0078 §2 added `ctx` the harness silently kept compiling and forwarded only the event. Every store
    // driven through the instrument built to certify CR-10 ran with CR-10's guard OFF.
    const seen: (number | undefined)[] = [];
    const recording = {
      resolveWorkflowId: (slug: string) => Promise.resolve(slug),
      listInterruptedRuns: () => Promise.resolve([]),
      persistEvent: (_event: RunEvent, ctx?: { readonly expectedLastSequenceNumber: number }) => {
        seen.push(ctx?.expectedLastSequenceNumber);
        return Promise.resolve();
      },
    };
    const audit = createAppendAudit(recording);
    await audit.store.persistEvent(started(0), { expectedLastSequenceNumber: -1 });
    await audit.store.persistEvent(completedNode(1), { expectedLastSequenceNumber: 0 });

    expect(seen).toEqual([-1, 0]);
    // …and the belief is on the record too, so a WRONG one is visible from the ask side rather than only as
    // a store rejection.
    expect(audit.records().map((r) => r.expectedLastSequenceNumber)).toEqual([-1, 0]);
  });

  it('forwards the context on the REAL guard — a stale belief still reaches the store', async () => {
    // The decorator must not absorb a conflict either. Driven against the reference store, which enforces
    // the identical compare-and-append.
    const audit = createAppendAudit(new InMemoryRunStore());
    await audit.store.persistEvent(started(0), { expectedLastSequenceNumber: -1 });
    await expect(
      audit.store.persistEvent(completedNode(2), { expectedLastSequenceNumber: 1 }),
    ).rejects.toSatisfy(isAppendConflictError);
    expect(audit.records().map((r) => r.outcome)).toEqual(['committed', 'rejected']);
  });

  it('does not count ANOTHER run`s in-flight ask as an overlap', async () => {
    // Two runs writing concurrently is legitimate — the ordered append is per RUN. Scoping the overlap check
    // globally would have made every parallel run fail, which is the false-positive direction.
    const inner = new InMemoryRunStore();
    let release: (() => void) | undefined;
    const slow = {
      resolveWorkflowId: (slug: string) => inner.resolveWorkflowId(slug),
      listInterruptedRuns: () => inner.listInterruptedRuns(),
      persistEvent: async (event: RunEvent): Promise<void> => {
        if (event.runId === 'r1') {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        await inner.persistEvent(event);
      },
    };
    const audit = createAppendAudit(slow);

    const held = audit.store.persistEvent(started(0, 'r1'));
    await Promise.resolve();
    await audit.store.persistEvent(started(0, 'r2'));
    release?.();
    await held;

    expect(audit.verdict('r2').overlapViolations).toEqual([]);
    expect(audit.verdict('r2').holds).toBe(true);
  });
});
