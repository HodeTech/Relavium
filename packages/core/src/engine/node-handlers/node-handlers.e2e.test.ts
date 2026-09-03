import type { RunEvent } from '@relavium/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { createExpressionSandbox, type ExpressionSandbox } from '../../expression/sandbox.js';
import { parseWorkflow } from '../../parser.js';
import { createInMemoryHost } from '../execution-host.js';
import { WorkflowEngine } from '../engine.js';
import type { RunHandle } from '../run-handle.js';
import { createStandardNodeExecutor } from './dispatcher.js';

// A pure non-agent DAG that exercises every 1.P handler together through the run loop:
//   input -> parallel(double,triple) -> merge(object_merge) -> condition -> transform(hi|lo) -> output
const WORKFLOW = `schema_version: '1.0'
workflow:
  id: e2e-1p
  inputs:
    - name: n
      type: number
  nodes:
    - id: start
      type: input
    - id: fan
      type: parallel
      parallel_of: [double, triple]
    - id: double
      type: transform
      transform: '({ d: inputs.n * 2 })'
    - id: triple
      type: transform
      transform: '({ t: inputs.n * 3 })'
    - id: combine
      type: merge
      merge_strategy: object_merge
    - id: check
      type: condition
      expression: 'run.outputs["combine"].d >= 4'
      branches:
        - when: true
          target_node: hi
        - when: false
          target_node: lo
    - id: hi
      type: transform
      transform: '({ label: "high", sum: run.outputs["combine"].d + run.outputs["combine"].t })'
    - id: lo
      type: transform
      transform: '({ label: "low" })'
    - id: out
      type: output
  edges:
    - { from: start, to: fan }
    - { from: double, to: combine }
    - { from: triple, to: combine }
    - { from: combine, to: check }
    - { from: hi, to: out }
    - { from: lo, to: out }
`;

async function drain(handle: RunHandle): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

function assertGapFreeSeq(events: readonly RunEvent[]): void {
  const seqs = events.map((e) => e.sequenceNumber).sort((a, b) => a - b);
  seqs.forEach((seq, index) => expect(seq).toBe(index));
}

let sandbox: ExpressionSandbox;
beforeAll(async () => {
  sandbox = await createExpressionSandbox();
});

function run(inputs: Record<string, unknown>): Promise<RunEvent[]> {
  const engine = new WorkflowEngine({
    host: createInMemoryHost(),
    executor: createStandardNodeExecutor({ sandbox }),
  });
  return drain(engine.start({ workflow: parseWorkflow(WORKFLOW), inputs }));
}

describe('node-type handlers end-to-end through the WorkflowEngine (1.P)', () => {
  it('runs input -> fan-out -> transforms -> object_merge -> condition(true) -> transform -> output, gap-free', async () => {
    const events = await run({ n: 2 });
    expect(events.map((e) => e.type).at(-1)).toBe('run:completed');
    assertGapFreeSeq(events);

    // object_merge combined the two transform branches in parallel_of order [double, triple].
    const combine = events.find((e) => e.type === 'node:completed' && e.nodeId === 'combine');
    expect(combine?.type === 'node:completed' && combine.output).toEqual({ d: 4, t: 6 });

    // The condition (4 >= 4 -> true) routed to `hi`; `lo` was skipped (never completed).
    const completedIds = events.filter((e) => e.type === 'node:completed').map((e) => e.nodeId);
    expect(completedIds).toContain('hi');
    expect(completedIds).not.toContain('lo');
    // The dimmed branch emits a durable node:skipped (a complete, replayable log for 1.R + observability).
    const skipped = events.find((e) => e.type === 'node:skipped');
    expect(skipped?.type === 'node:skipped' && skipped.nodeId).toBe('lo');
    expect(skipped?.type === 'node:skipped' && skipped.reason).toBe('branch_not_taken');

    // The terminal output captured `hi`'s value (its single feeder).
    const completed = events.find((e) => e.type === 'run:completed');
    expect(completed?.type === 'run:completed' && completed.outputs).toEqual({
      out: { label: 'high', sum: 10 },
    });
  });

  it('routes the other branch when the condition is false (n=1 -> d=2 < 4 -> lo)', async () => {
    const events = await run({ n: 1 });
    expect(events.map((e) => e.type).at(-1)).toBe('run:completed');
    const completedIds = events.filter((e) => e.type === 'node:completed').map((e) => e.nodeId);
    expect(completedIds).toContain('lo');
    expect(completedIds).not.toContain('hi');
    const completed = events.find((e) => e.type === 'run:completed');
    expect(completed?.type === 'run:completed' && completed.outputs).toEqual({
      out: { label: 'low' },
    });
  });
});

// --- a `condition` routed into a merge is a CONTROL edge, not a branch (ADR-0091 amendment) ----

/**
 * The graph the amendment was written for. `cond` names `join` as a `branches[].target_node`, which is
 * the ONLY sanctioned way to author it (a plain edge out of a condition is refused), and `work` is the
 * merge's real branch. Both node orders are exercised because authoring order was the whole defect:
 * before the fix, `condFirst: true` returned `null` and `condFirst: false` returned `"WORK"` — the same
 * graph, two answers, both exit 0.
 */
const CONTROL_EDGE = (condFirst: boolean): string => {
  const cond = `    - id: cond
      type: condition
      expression: 'inputs.take'
      branches:
        - { when: true, target_node: join }
        - { when: false, target_node: fallback }`;
  const work = `    - id: work
      type: transform
      transform: '"WORK"'`;
  return `schema_version: '1.0'
workflow:
  id: control-edge
  inputs:
    - { name: take, type: boolean }
  nodes:
    - id: start
      type: input
${condFirst ? `${cond}\n${work}` : `${work}\n${cond}`}
    - id: fallback
      type: transform
      transform: '"FALLBACK"'
    - id: join
      type: merge
      merge_strategy: first
    - id: out
      type: output
  edges:
    - { from: start, to: cond }
    - { from: start, to: work }
    - { from: work, to: join }
    - { from: join, to: out }
`;
};

function runControlEdge(condFirst: boolean): Promise<RunEvent[]> {
  const engine = new WorkflowEngine({
    host: createInMemoryHost(),
    executor: createStandardNodeExecutor({ sandbox }),
  });
  return drain(
    engine.start({ workflow: parseWorkflow(CONTROL_EDGE(condFirst)), inputs: { take: true } }),
  );
}

describe('a `condition` targeting a merge gates the join without becoming a branch', () => {
  for (const condFirst of [true, false] as const) {
    it(`\`first\` returns the real branch regardless of authoring order (cond first: ${String(condFirst)})`, async () => {
      const events = await runControlEdge(condFirst);
      const completed = events.find((e) => e.type === 'run:completed');
      // Before the fix this was `null` for condFirst=true and `"WORK"` for condFirst=false: the
      // condition landed in the completed-output map with `undefined`, satisfied the fan-in's
      // `runOutputs.has(id)` guard, and became branch #0 whenever it was authored first.
      expect(completed?.type === 'run:completed' && completed.outputs).toEqual({ out: 'WORK' });
    });
  }

  it('the merge still WAITS for the condition — it is a dependency, only not a branch', async () => {
    const events = await runControlEdge(true);
    const order = events
      .filter((e) => e.type === 'node:completed')
      .map((e) => (e.type === 'node:completed' ? e.nodeId : ''));
    // Both settle, and the join is after the condition: dropping it from `branchNodeIds` must not
    // drop it from `dependencies`, or the join would fire early on a path that had not been decided.
    expect(order).toContain('cond');
    expect(order.indexOf('join')).toBeGreaterThan(order.indexOf('cond'));
  });
});
