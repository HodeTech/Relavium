/**
 * The resume gate
 * ([ADR-0080](../../../../docs/decisions/0080-durable-effect-journal-and-the-tiered-effect-contract.md) §2b;
 * canonical contract in [effect-journal.md](../../../../docs/reference/shared-core/effect-journal.md) §4).
 *
 * **Why the gate exists at all, given `prepare` already refuses a collision.** `prepare` only fires if the
 * re-run happens to reach the same tool, at the same slot, with the same args. A model that answers
 * differently on the second attempt sails straight past it, and the run completes "successfully" with an
 * ambiguous real-world effect from its own prior attempt left unresolved. The gate is what makes that
 * impossible: it reads before anything is scheduled, and it does not depend on the re-run's shape.
 */

import type { RunEvent } from '@relavium/shared';
import { blocksResume, type EffectResumePort, type UnresolvedEffect } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { parseWorkflow, type WorkflowDefinition } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryEffectJournalStore, createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import type { NodeExecContext, NodeExecutor, NodeOutcome } from './node-executor.js';
import type { RunHandle } from './run-handle.js';

describe('blocksResume — §4’s table in one predicate', () => {
  it('a committed row WITH a retained result is the only thing that does not block', () => {
    expect(blocksResume({ state: 'committed', result: { ok: true } })).toBe(false);
  });

  it('a committed row WITHOUT a retained result blocks — a committed row is not a green light', () => {
    // The window an earlier draft of ADR-0080 left open: settle succeeds, the process dies before
    // `node:completed` persists, and a gate examining only UNRESOLVED rows waves the re-run through. If the
    // journal did not retain enough to re-deliver, it blocks exactly as an unresolved row does.
    expect(blocksResume({ state: 'committed' })).toBe(true);
  });

  it('every non-committed state blocks, whatever it carries', () => {
    for (const state of ['prepared', 'dispatched', 'ambiguous', 'needs_attention'] as const) {
      expect(blocksResume({ state })).toBe(true);
      // …including one that somehow carries a result: the state is the authority, not the payload.
      expect(blocksResume({ state, result: 'stale' })).toBe(true);
    }
  });
});

/** A resume port that answers from a fixed map, and records which correlations were asked about. */
function portOver(
  byNode: Readonly<Record<string, readonly UnresolvedEffect[]>>,
  asked: string[],
): EffectResumePort {
  return {
    unresolvedFor: (correlation) => {
      const nodeId = correlation.kind === 'run' ? correlation.nodeId : correlation.sessionId;
      asked.push(nodeId);
      return Promise.resolve(byNode[nodeId] ?? []);
    },
  };
}

describe('the gate’s read scope', () => {
  it('reads with the attempt DROPPED — the scope is the lookup key', async () => {
    // The node-retry attempt resets to 1 both on a crash-resume and on a budget approval, so an
    // attempt-scoped lookup would miss the very row it exists to find. `effectScope` drops it, which is why
    // the gate can pass any attempt at all.
    const { effectScope } = await import('@relavium/shared');
    expect(effectScope({ kind: 'run', runId: 'r1', nodeId: 'n1', attempt: 1 })).toBe(
      effectScope({ kind: 'run', runId: 'r1', nodeId: 'n1', attempt: 7 }),
    );
  });

  it('asks only about the nodes handed to it', async () => {
    const asked: string[] = [];
    const port = portOver({}, asked);
    await port.unresolvedFor({ kind: 'run', runId: 'r1', nodeId: 'n1', attempt: 1 });
    expect(asked).toEqual(['n1']);
  });
});

/**
 * The gate END TO END, through a real two-process resume — the half only the engine can answer.
 *
 * The workflow is the gated fixture from `engine.test.ts`: a run parks at a human gate, the process dies,
 * and a fresh engine resumes it. The journal is seeded with an unresolved effect on the node the resume is
 * about to run, which is exactly the crash-mid-effect shape.
 */
describe('a resumed run with an unresolved effect refuses to continue', () => {
  const GATED: WorkflowDefinition = parseWorkflow(
    `schema_version: '1.0'
workflow:
  id: effect-gate-fixture
  nodes:
    - { id: a, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: a, to: g }
    - { from: g, to: out }
`,
  );

  class Stub implements NodeExecutor {
    execute(ctx: NodeExecContext): Promise<NodeOutcome> {
      // The gateId is the ENGINE's to mint — supplying one here made the outcome unrecognised and the
      // gate silently completed, which is how this fixture first ran green against no gate at all.
      return Promise.resolve(
        ctx.vertex.id === 'g'
          ? { kind: 'paused', gate: { gateType: 'approval', message: 'approve?' } }
          : { kind: 'completed', output: ctx.vertex.id },
      );
    }
  }

  async function runToGate(store: InMemoryRunStore): Promise<{ runId: string; gateId: string }> {
    const engine = new WorkflowEngine({ host: createInMemoryHost({ store }), executor: new Stub() });
    const handle = engine.start({ workflow: GATED });
    let gateId = '';
    for await (const event of handle.events) {
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        break; // the process dies here, parked at the gate
      }
    }
    return { runId: handle.runId, gateId };
  }

  async function drain(handle: RunHandle): Promise<RunEvent[]> {
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    return events;
  }

  it('fails with `effect_needs_attention` instead of re-running the node', async () => {
    const store = new InMemoryRunStore();
    const { runId, gateId } = await runToGate(store);

    // The crash shape: `out` prepared an effect and never settled it. It is `pending` in the checkpoint —
    // absent from `nodeStates`, since it emitted no terminal — so without the gate it simply re-runs.
    const journal = createInMemoryEffectJournalStore();
    await journal
      .for({ kind: 'run', runId, nodeId: 'out', attempt: 1 })
      .prepare(0, 'http_request', 3, { url: 'https://api.example/x' });

    const engineB = new WorkflowEngine({
      host: createInMemoryHost({ store }),
      executor: new Stub(),
      effectJournal: (correlation) => journal.for(correlation),
      effectResume: journal.resume,
    });
    const events = await drain(
      await engineB.resumeFromCheckpoint({
        runId,
        workflow: GATED,
        gateId,
        decision: { decision: 'approved', decidedBy: 'tester' },
      }),
    );

    const failure = events.find((e) => e.type === 'run:failed');
    expect(failure?.type === 'run:failed' && failure.error.code).toBe('effect_needs_attention');
    expect(failure?.type === 'run:failed' && failure.error.retryable).toBe(false);
    // …and it names what to look at, because a human has to go check the target.
    expect(failure?.type === 'run:failed' && failure.error.message).toContain('out/http_request');
    // The node never ran: the whole point is that the possibly-landed effect is not repeated.
    expect(events.some((e) => e.type === 'node:started' && e.nodeId === 'out')).toBe(false);
  });

  it('a SETTLED effect does not block — the gate is not a blanket refusal', async () => {
    // Without this the assertion above passes for a gate that refused every resume with a journal wired,
    // which would make crash-recovery impossible rather than safe.
    const store = new InMemoryRunStore();
    const { runId, gateId } = await runToGate(store);

    const journal = createInMemoryEffectJournalStore();
    const port = journal.for({ kind: 'run', runId, nodeId: 'out', attempt: 1 });
    await port.prepare(0, 'http_request', 3, { url: 'https://api.example/x' });
    await port.settle(0, 'http_request', 'committed', { status: 200 });

    const engineB = new WorkflowEngine({
      host: createInMemoryHost({ store }),
      executor: new Stub(),
      effectJournal: (correlation) => journal.for(correlation),
      effectResume: journal.resume,
    });
    const events = await drain(
      await engineB.resumeFromCheckpoint({
        runId,
        workflow: GATED,
        gateId,
        decision: { decision: 'approved', decidedBy: 'tester' },
      }),
    );

    expect(events.some((e) => e.type === 'run:completed')).toBe(true);
  });

  it('an UNREADABLE journal refuses too — a failed read is not “nothing is blocking”', async () => {
    // ADR-0075's answer for an unreadable event log, applied here: resuming a run whose external effects are
    // unknown is the one thing this contract exists to prevent.
    const store = new InMemoryRunStore();
    const { runId, gateId } = await runToGate(store);

    const engineB = new WorkflowEngine({
      host: createInMemoryHost({ store }),
      executor: new Stub(),
      effectResume: { unresolvedFor: () => Promise.reject(new Error('history.db is corrupt')) },
    });
    const events = await drain(
      await engineB.resumeFromCheckpoint({
        runId,
        workflow: GATED,
        gateId,
        decision: { decision: 'approved', decidedBy: 'tester' },
      }),
    );

    const failure = events.find((e) => e.type === 'run:failed');
    expect(failure?.type === 'run:failed' && failure.error.code).toBe('effect_needs_attention');
    expect(failure?.type === 'run:failed' && failure.error.message).toContain('corrupt');
  });
});

