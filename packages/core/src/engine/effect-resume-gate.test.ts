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
import { blocksResume, effectScope, nodeIdFromRunScope } from '@relavium/shared';
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

describe('the gate’s read scope', () => {
  it('reads with the attempt DROPPED — the scope is the lookup key', () => {
    // The node-retry attempt resets to 1 both on a crash-resume and on a budget approval, so an
    // attempt-scoped lookup would miss the very row it exists to find. `effectScope` drops it.
    expect(effectScope({ kind: 'run', runId: 'r1', nodeId: 'n1', attempt: 1 })).toBe(
      effectScope({ kind: 'run', runId: 'r1', nodeId: 'n1', attempt: 7 }),
    );
  });

  it('the node id round-trips through the scope, encoding and all', () => {
    // The refusal message names the node, and it derives that from the scope rather than carrying it — so
    // an encoding without a matching inverse would put the WRONG node in front of an operator.
    for (const nodeId of ['out', 'a:b', 'node with spaces', '100%']) {
      const scope = effectScope({ kind: 'run', runId: 'r1', nodeId, attempt: 1 });
      expect(nodeIdFromRunScope(scope)).toBe(nodeId);
    }
    expect(nodeIdFromRunScope('session:s1:0')).toBeUndefined();
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

  it('a PAUSED node’s rows block too — not only a pending one’s', async () => {
    // The `paused` arm of the gate's node filter was untested: the fixture's blocking row sat on `out`,
    // which the checkpoint leaves `pending`. A review mutated the filter to `pending` only and all 1,228
    // core tests stayed green. The arm is load-bearing — a node parked on a budget gate or a media job is
    // `paused` and has ALREADY dispatched tools, which is precisely when a row exists.
    const store = new InMemoryRunStore();
    const { runId, gateId } = await runToGate(store);

    const journal = createInMemoryEffectJournalStore();
    await journal
      .for({ kind: 'run', runId, nodeId: 'g', attempt: 1 }) // `g` is the PAUSED gate node
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
    expect(failure?.type === 'run:failed' && failure.error.message).toContain('g/http_request');
  });

  it('an UNREADABLE journal refuses too — a failed read is not “nothing is blocking”', async () => {
    // ADR-0075's answer for an unreadable event log, applied here: resuming a run whose external effects are
    // unknown is the one thing this contract exists to prevent.
    const store = new InMemoryRunStore();
    const { runId, gateId } = await runToGate(store);

    const engineB = new WorkflowEngine({
      host: createInMemoryHost({ store }),
      executor: new Stub(),
      effectResume: { unresolvedForRun: () => Promise.reject(new Error('history.db is corrupt')) },
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

/**
 * The THIRD resume entry point — the in-process `WorkflowEngine.resume(runId, gateId, decision)`, reached
 * from the CLI's inline gate prompt and from every budget approval. It never goes through a checkpoint, so
 * the two tests above cannot reach it: a review deleted its gate check outright and all 1,242 core tests
 * stayed green.
 */
describe('the IN-PROCESS gate resume', () => {
  const GATED2: WorkflowDefinition = parseWorkflow(
    `schema_version: '1.0'
workflow:
  id: in-process-gate-fixture
  nodes:
    - { id: a, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: a, to: g }
    - { from: g, to: out }
`,
  );

  class GateStub implements NodeExecutor {
    execute(ctx: NodeExecContext): Promise<NodeOutcome> {
      return Promise.resolve(
        ctx.vertex.id === 'g'
          ? { kind: 'paused', gate: { gateType: 'approval', message: 'approve?' } }
          : { kind: 'completed', output: ctx.vertex.id },
      );
    }
  }

  /**
   * Start a run and resolve its gate IN PROCESS from inside the event loop — the shape `drive.ts`'s inline
   * gate prompt uses, and the one `engine.test.ts`'s own multi-gate test uses.
   *
   * Never `break`s out of `handle.events`: a break calls the iterator's `return()`, which closes the stream
   * AND drops the bus subscription the handle captures its terminal code on. The run has to stay live for
   * this to be the in-process path at all.
   */
  async function resumeInProcess(
    journal: ReturnType<typeof createInMemoryEffectJournalStore> | undefined,
    seedBlockingRow: (runId: string) => Promise<void>,
    onPaused?: (engine: WorkflowEngine, runId: string, gateId: string) => Promise<unknown>,
  ): Promise<{ handle: RunHandle; seen: readonly RunEvent[] }> {
    const engine = new WorkflowEngine({
      host: createInMemoryHost({ store: new InMemoryRunStore() }),
      executor: new GateStub(),
      ...(journal === undefined
        ? {}
        : { effectJournal: (c) => journal.for(c), effectResume: journal.resume }),
    });
    const handle = engine.start({ workflow: GATED2 });
    const seen: RunEvent[] = [];
    for await (const event of handle.events) {
      seen.push(event);
      if (event.type !== 'human_gate:paused') continue;
      await seedBlockingRow(handle.runId);
      const decision = { decision: 'approved' as const, decidedBy: 'tester' };
      if (onPaused === undefined) {
        await engine.resume(handle.runId, event.gateId, decision);
      } else {
        await onPaused(engine, handle.runId, event.gateId);
      }
    }
    return { handle, seen };
  }

  it('refuses when a prior attempt left an effect unresolved', async () => {
    const journal = createInMemoryEffectJournalStore();
    const { handle } = await resumeInProcess(journal, (runId) =>
      journal
        .for({ kind: 'run', runId, nodeId: 'out', attempt: 1 })
        .prepare(0, 'http_request', 3, { url: 'https://api.example/x' })
        .then(() => undefined),
    );

    expect(handle.terminalError()).toBe('effect_needs_attention');
  });

  it('completes normally when nothing is unresolved — the negative control', async () => {
    const journal = createInMemoryEffectJournalStore();
    const { handle } = await resumeInProcess(journal, () => Promise.resolve());

    expect(handle.terminalError()).toBeUndefined();
  });

  it('a duplicate resume for the same gate stays the documented no-op', async () => {
    // The gate check is `async`, so placing it BEFORE the gate claim opened a microtask window: two
    // concurrent resumes both passed the `#resolvedGates.has` idempotency check, one won, and the loser got
    // an uncaught `EngineStateError('run_not_paused')` instead of returning silently. A review reproduced it
    // with NO journal wired at all — the mere fact that the check awaits was enough. The claim is therefore
    // taken synchronously, before any await, exactly as it was before the gate existed.
    let outcomes: readonly PromiseSettledResult<unknown>[] = [];
    const { seen } = await resumeInProcess(
      undefined,
      () => Promise.resolve(),
      async (engine, runId, gateId) => {
        const decision = { decision: 'approved' as const, decidedBy: 'tester' };
        outcomes = await Promise.allSettled([
          engine.resume(runId, gateId, decision),
          engine.resume(runId, gateId, decision),
        ]);
      },
    );

    // Neither call throws — the documented idempotent no-op…
    expect(outcomes.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    // …and the gate advanced EXACTLY ONCE. This is the assertion that has teeth: an await placed before the
    // claim lets both callers past `#resolvedGates.has` AND past `#assertGatePending` (the pending entry is
    // still there), so the run is advanced twice with neither call rejecting. "Both fulfilled" alone would
    // call that a success.
    expect(seen.filter((e) => e.type === 'human_gate:resumed')).toHaveLength(1);
  });

});

