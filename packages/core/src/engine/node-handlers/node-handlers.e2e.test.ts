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
